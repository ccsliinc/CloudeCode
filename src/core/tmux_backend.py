"""Tmux-backed session backend.

Uses a DEDICATED tmux server socket (``tmux -L cloude``) so we never touch
the user's default tmux server. Sessions are named ``cloude_<slug>``.

Key design points:

- **Binary-safe writes**: any chunk containing control bytes (notably
  ``0x03`` SIGINT / ``0x1b`` ESC-prefixed sequences) or longer than
  ``PASTE_THRESHOLD_BYTES`` (256) is written via ``load-buffer -`` + then
  ``paste-buffer -d -p``. Short plain text goes through ``send-keys -l``.
  ``send-keys -H`` is BANNED — it requires hex-pair input, not raw bytes.

- **Output streaming**: ``tmux pipe-pane -o 'cat >> <fifo>'`` streams every
  pane byte to a file. We tail that file asynchronously and call
  `on_output(bytes)` for every chunk. The file is rotated when it exceeds
  ``MAX_LOG_BYTES`` or is older than ``ROTATE_AGE_HOURS``.

- **Single-active invariant**: the backend itself does NOT enforce
  one-at-a-time; `SessionManager` does. This backend DOES refuse to start
  if a session with the same name already exists — callers must call
  ``discover_existing()`` first to re-attach.

- **Restart survival**: `discover_existing()` lists ``cloude_*`` sessions on
  the dedicated server. `SessionManager.lifespan_startup` uses it to
  re-register the slug stored in ``session_metadata.json``.
"""

from __future__ import annotations

import asyncio
import os
import shlex
import shutil
import stat
import time
from pathlib import Path
from typing import Any, Callable, List, Optional

import structlog

from src.core.session_backend import SessionBackend

logger = structlog.get_logger()

# ---- Tunables ---------------------------------------------------------------
# Module-scope constants (not in config.json) so they're easy to find in code.
# If we ever want to expose these, wire through `AuthConfig.session` — for now
# the values below are battle-tested defaults.

#: Rotate the pipe-pane log once it passes 10 MiB.
MAX_LOG_BYTES: int = 10 * 1024 * 1024

#: Rotate regardless of size after this many hours. 24h matches a normal
#: coding-session cadence.
ROTATE_AGE_HOURS: int = 24

#: Default starting window geometry for new tmux sessions. We never attach a
#: client (output is streamed via pipe-pane), so tmux has no client dims to
#: key off of. Without `-x/-y` + `window-size manual`, tmux clamps the
#: window to its 80x24 birth size forever — making TUI apps like Claude CLI
#: render at 80x24 while xterm.js draws at the browser's actual size.
#: These are reasonable defaults; the WS client's first `resize` request
#: replaces them within milliseconds of connect.
INITIAL_COLS: int = 132
INITIAL_ROWS: int = 40

#: Bytes threshold above which we switch from ``send-keys -l`` to
#: ``load-buffer``/``paste-buffer``. Below this AND no control chars → fast
#: path. Above OR control chars → paste-buffer path.
PASTE_THRESHOLD_BYTES: int = 256

#: Default socket name, overridable via ``AuthConfig.session.tmux_socket_name``.
DEFAULT_SOCKET_NAME: str = "cloude"

#: Session name prefix — ``cloude_<slug>``.
SESSION_PREFIX: str = "cloude_"

#: FIFO + rotated log live under the log directory. File name is
#: ``tmux_<slug>.pipe``.
PIPE_SUFFIX: str = ".pipe"


# ---- Helpers ---------------------------------------------------------------


def _slugify(raw: str) -> str:
    """Sanitize an arbitrary session id into a tmux-legal slug.

    tmux forbids ``.`` and ``:`` in session names and interprets ``.`` as a
    window/pane separator. We replace ``.``, ``:``, whitespace, and ``/`` with
    ``_``, then strip to a conservative charset.
    """
    out = []
    for ch in raw:
        if ch.isalnum() or ch in ("-", "_"):
            out.append(ch)
        else:
            out.append("_")
    slug = "".join(out).strip("_")
    # tmux also dislikes empty names.
    return slug or "default"


def _has_control_chars(data: bytes) -> bool:
    """True if `data` contains any control byte that paste-buffer must handle.

    We flag ALL bytes < 0x20 except ``\\t`` (0x09), ``\\n`` (0x0a), and
    ``\\r`` (0x0d), plus ``0x7f`` (DEL). In practice this catches ``0x03``
    (^C), ``0x04`` (^D), ``0x1b`` (ESC), etc.
    """
    safe = {0x09, 0x0a, 0x0d}
    return any((b < 0x20 and b not in safe) or b == 0x7f for b in data)


# ---- Backend --------------------------------------------------------------


class TmuxBackend(SessionBackend):
    """Session backend that runs the child under tmux on a dedicated socket."""

    def __init__(
        self,
        session_id: str,
        working_dir: Path,
        on_output: Optional[Callable[[bytes], Any]] = None,
        socket_name: str = DEFAULT_SOCKET_NAME,
        scrollback_lines: int = 3000,
    ) -> None:
        super().__init__(session_id, working_dir, on_output)

        self.socket_name = socket_name
        self.scrollback_lines = scrollback_lines
        self.slug = _slugify(session_id)
        self.tmux_session = f"{SESSION_PREFIX}{self.slug}"

        # Per-session pipe-pane output file lives under the log directory.
        # We resolve lazily to avoid importing settings at module import time.
        self._pipe_path: Optional[Path] = None

        self._reader_task: Optional[asyncio.Task] = None
        self._running = False
        self._last_rotate_check = time.monotonic()
        self._rotation_started_at = time.monotonic()

    # ---- internal helpers ------------------------------------------------

    def _tmux_base(self) -> List[str]:
        """Common tmux argv prefix — always uses our dedicated socket."""
        return ["tmux", "-L", self.socket_name]

    def _resolve_pipe_path(self) -> Path:
        if self._pipe_path is not None:
            return self._pipe_path
        # Lazy import: src.config pulls env vars and may not be available in
        # some test contexts.
        try:
            from src.config import settings
            log_dir = settings.get_log_dir()
        except Exception:
            log_dir = Path("/tmp")
        self._pipe_path = log_dir / f"tmux_{self.slug}{PIPE_SUFFIX}"
        return self._pipe_path

    async def _run_tmux(
        self,
        *args: str,
        stdin_bytes: Optional[bytes] = None,
        check: bool = True,
    ) -> tuple[int, bytes, bytes]:
        """Run a one-shot tmux command, optionally piping stdin bytes."""
        argv = self._tmux_base() + list(args)
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE if stdin_bytes is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate(input=stdin_bytes)
        if check and proc.returncode != 0:
            logger.error(
                "tmux_command_failed",
                argv=argv,
                returncode=proc.returncode,
                stderr=stderr.decode("utf-8", errors="replace"),
            )
        return proc.returncode or 0, stdout, stderr

    def _run_tmux_sync(
        self,
        *args: str,
        stdin_bytes: Optional[bytes] = None,
        check: bool = True,
    ) -> tuple[int, bytes, bytes]:
        """Sync variant for use in `is_alive`, `discover_existing`, etc."""
        import subprocess

        argv = self._tmux_base() + list(args)
        proc = subprocess.run(
            argv,
            input=stdin_bytes,
            capture_output=True,
            check=False,
        )
        if check and proc.returncode != 0:
            logger.debug(
                "tmux_command_nonzero",
                argv=argv,
                returncode=proc.returncode,
                stderr=proc.stderr.decode("utf-8", errors="replace")[:200],
            )
        return proc.returncode, proc.stdout, proc.stderr

    # ---- SessionBackend API ---------------------------------------------

    async def start(
        self,
        command: Optional[str] = None,
        env: Optional[dict] = None,
        initial_cols: Optional[int] = None,
        initial_rows: Optional[int] = None,
    ) -> None:
        """Create the tmux session + start pipe-pane streaming.

        ``initial_cols`` / ``initial_rows`` override the module-level
        INITIAL_COLS / INITIAL_ROWS when BOTH are supplied. One without the
        other is treated as "not supplied" — we don't mix a client dim with
        a default, because that would create an asymmetric starting pane
        (e.g. client gives cols=100, we'd pair with default rows=40 which
        is almost certainly wrong for that viewport).
        """
        if self._running:
            raise RuntimeError("TmuxBackend already running")

        if not shutil.which("tmux"):
            raise RuntimeError("tmux not found on PATH")

        self.working_dir.mkdir(parents=True, exist_ok=True)

        # Prepare pipe file BEFORE starting tmux so we don't miss bytes.
        pipe_path = self._resolve_pipe_path()
        pipe_path.parent.mkdir(parents=True, exist_ok=True)
        # Truncate any stale file from a previous session with the same slug.
        pipe_path.write_bytes(b"")

        # Resolve birth geometry: client-supplied dims win when BOTH are
        # provided, otherwise fall back to module defaults. The WS resize
        # handshake reshapes the pane after connect regardless, so this
        # only matters for the brief window before the first resize frame.
        use_cols = initial_cols if (initial_cols and initial_rows) else INITIAL_COLS
        use_rows = initial_rows if (initial_cols and initial_rows) else INITIAL_ROWS

        # Build the session. ``new-session -d -s <name> -c <cwd> [command]``.
        # If a command is supplied, tmux runs that as pane 0's process; the
        # shell exits when the command ends unless ``remain-on-exit`` is set.
        # For our case (Claude CLI) we want the pane to stick around even if
        # Claude exits, so we enable remain-on-exit after creation.
        #
        # ``-x`` / ``-y`` fix the window's birth geometry. Without them tmux
        # uses 80x24 and — combined with default ``window-size latest`` and
        # zero attached clients — stays there forever. We pair these with
        # ``window-size manual`` below so `resize-window` is the ONLY thing
        # that can change the size (no client-sizing surprises).
        args = [
            "new-session",
            "-d",
            "-s",
            self.tmux_session,
            "-c",
            str(self.working_dir),
            "-x",
            str(use_cols),
            "-y",
            str(use_rows),
        ]
        if command:
            args.append(command)

        # Merge env overlay into this tmux invocation's environment so the
        # new session inherits it. tmux captures the environment of the
        # `new-session` call.
        tmux_env = os.environ.copy()
        tmux_env.setdefault("TERM", "xterm-256color")
        tmux_env.setdefault("COLORTERM", "truecolor")
        if env:
            tmux_env.update(env)

        argv = self._tmux_base() + args
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=tmux_env,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            msg = stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"tmux new-session failed: {msg.strip()}")

        # Keep the pane alive even after child exits so scrollback persists.
        await self._run_tmux(
            "set-option", "-t", self.tmux_session, "remain-on-exit", "on", check=False
        )

        # Critical for headless (no-client) operation: lock the window size to
        # manual so only `resize-window` changes it. Default is ``latest``
        # which sizes to the most recent attached client; with zero clients
        # tmux never leaves the 80x24 birth size.
        await self._run_tmux(
            "set-option", "-t", self.tmux_session, "window-size", "manual", check=False
        )
        # Prevent size clamping based on other windows in the session.
        # (We only ever have window 0, but be defensive — future code that
        # adds a second window shouldn't silently shrink pane 0.)
        await self._run_tmux(
            "set-option", "-t", self.tmux_session, "aggressive-resize", "off", check=False
        )

        # Start pipe-pane — this streams pane output to our file.
        # Using shell redirection so tmux appends (not truncates) on rotation.
        pipe_cmd = f"cat >> {shlex.quote(str(pipe_path))}"
        rc, _, err = await self._run_tmux(
            "pipe-pane",
            "-t",
            f"{self.tmux_session}:0.0",
            "-o",
            pipe_cmd,
        )
        if rc != 0:
            logger.error(
                "tmux_pipe_pane_failed",
                stderr=err.decode("utf-8", errors="replace"),
            )

        self._running = True
        self._rotation_started_at = time.monotonic()

        # Kick off the output reader loop.
        await self.read_async()

        logger.info(
            "tmux_backend_started",
            session=self.tmux_session,
            socket=self.socket_name,
            cwd=str(self.working_dir),
            pipe=str(pipe_path),
        )

    async def stop(self) -> None:
        """Kill the tmux session and tear down the read loop."""
        if not self._running and self._reader_task is None:
            return

        logger.info("tmux_backend_stopping", session=self.tmux_session)
        self._running = False

        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logger.debug("tmux_reader_teardown_error", error=str(exc))
            self._reader_task = None

        # Stop pipe-pane (no-op if session is already gone).
        await self._run_tmux(
            "pipe-pane",
            "-t",
            f"{self.tmux_session}:0.0",
            check=False,
        )

        # Kill the session on our socket only.
        await self._run_tmux(
            "kill-session",
            "-t",
            self.tmux_session,
            check=False,
        )

        logger.info("tmux_backend_stopped", session=self.tmux_session)

    async def write(self, data: bytes) -> None:
        """Binary-safe write to pane 0.

        Path selection:
        - Short (<=PASTE_THRESHOLD_BYTES) AND no control bytes  → send-keys -l
        - Everything else                                        → load-buffer + paste-buffer -d -p

        ``send-keys -l`` treats the payload literally (no key-name lookup) but
        tmux still parses the argv — which means we can't safely pass NUL,
        newline-only carriage returns, or raw escape bytes. Paste-buffer
        bypasses the key translator entirely by writing the buffer to the
        pane's stdin. ``-d`` deletes the buffer after paste; ``-p`` uses
        bracketed-paste mode so apps that care can distinguish paste from
        typed input.
        """
        if not self._running:
            raise RuntimeError("TmuxBackend is not running")

        if not data:
            return

        use_paste = len(data) > PASTE_THRESHOLD_BYTES or _has_control_chars(data)

        if use_paste:
            # Load bytes into a named buffer then paste. Buffer name is
            # derived from the slug so concurrent backends (shouldn't happen
            # under single-session, but be safe) don't collide.
            buf_name = f"cloude_{self.slug}"
            rc, _, err = await self._run_tmux(
                "load-buffer",
                "-b",
                buf_name,
                "-",
                stdin_bytes=data,
            )
            if rc != 0:
                raise RuntimeError(
                    f"tmux load-buffer failed: {err.decode('utf-8', errors='replace').strip()}"
                )
            rc, _, err = await self._run_tmux(
                "paste-buffer",
                "-d",
                "-p",
                "-b",
                buf_name,
                "-t",
                f"{self.tmux_session}:0.0",
            )
            if rc != 0:
                raise RuntimeError(
                    f"tmux paste-buffer failed: {err.decode('utf-8', errors='replace').strip()}"
                )
        else:
            text = data.decode("utf-8", errors="replace")
            rc, _, err = await self._run_tmux(
                "send-keys",
                "-l",
                "-t",
                f"{self.tmux_session}:0.0",
                text,
            )
            if rc != 0:
                raise RuntimeError(
                    f"tmux send-keys failed: {err.decode('utf-8', errors='replace').strip()}"
                )

    def resize(self, cols: int, rows: int) -> None:
        """Resize the tmux window to match the xterm.js client geometry.

        We use ``resize-window -x -y`` because:

        - ``refresh-client -C`` only works when a client IS attached. We
          never attach one (output is streamed via `pipe-pane`), so
          `refresh-client` is a silent no-op.
        - ``resize-window`` operates server-side. With ``window-size manual``
          (set in `start()`), tmux honors the request regardless of client
          state and emits SIGWINCH to the pane's foreground process so TUI
          apps (Claude CLI, vim, less, etc.) re-render at the new geometry.

        Fire-and-forget so the WS receive loop doesn't block on tmux IPC.
        """
        try:
            self._run_tmux_sync(
                "resize-window",
                "-t",
                self.tmux_session,
                "-x",
                str(cols),
                "-y",
                str(rows),
                check=False,
            )
            # Defensive: older tmux versions may not auto-propagate SIGWINCH
            # after a server-side resize. `refresh-client -S` is a no-op when
            # no client is attached (our case) but documents intent and
            # costs nothing.
            self._run_tmux_sync(
                "refresh-client",
                "-S",
                check=False,
            )
        except Exception as exc:
            logger.debug("tmux_resize_error", error=str(exc))

    def is_alive(self) -> bool:
        """True iff the tmux session exists on our socket."""
        rc, _, _ = self._run_tmux_sync(
            "has-session",
            "-t",
            self.tmux_session,
            check=False,
        )
        return rc == 0

    def discover_existing(self) -> List[str]:
        """List all ``cloude_*`` sessions on our dedicated socket."""
        if not shutil.which("tmux"):
            return []
        rc, out, _ = self._run_tmux_sync(
            "list-sessions",
            "-F",
            "#{session_name}",
            check=False,
        )
        if rc != 0:
            # Exit code 1 with "no server running" is expected when no
            # sessions exist yet.
            return []
        names = out.decode("utf-8", errors="replace").splitlines()
        return [n.strip() for n in names if n.strip().startswith(SESSION_PREFIX)]

    def capture_scrollback(self, lines: int = 3000) -> bytes:
        """Capture the pane's recent scrollback as raw bytes (UTF-8).

        ``capture-pane -p`` writes to stdout. ``-S -<N>`` sets start line N
        lines above the cursor. ``-J`` joins wrapped lines (matches what
        users see in the terminal). ``-e`` preserves ANSI escape sequences
        so xterm.js can replay colors/positioning faithfully.
        """
        if lines <= 0:
            lines = self.scrollback_lines

        self.replay_in_progress = True
        try:
            rc, out, _ = self._run_tmux_sync(
                "capture-pane",
                "-p",
                "-e",
                "-J",
                "-S",
                f"-{lines}",
                "-t",
                f"{self.tmux_session}:0.0",
                check=False,
            )
            if rc != 0:
                return b""
            return out
        finally:
            # Note: Item 7 will move this flag flip closer to the WS send
            # site (after bytes are written to the socket). For now we
            # clear it immediately — the callback-suppression is still a
            # future-Item-7 concern.
            self.replay_in_progress = False

    async def read_async(self) -> None:
        """Start the background output-tail loop (idempotent)."""
        if self._reader_task and not self._reader_task.done():
            return
        self._reader_task = asyncio.create_task(self._tail_loop())

    # ---- internal read loop ---------------------------------------------

    async def _tail_loop(self) -> None:
        """Tail the pipe-pane file and fan out bytes via `on_output`."""
        pipe_path = self._resolve_pipe_path()

        # Wait briefly for the file to exist (pipe-pane creates on first write).
        deadline = time.monotonic() + 5.0
        while not pipe_path.exists() and time.monotonic() < deadline:
            await asyncio.sleep(0.05)

        # Open once, then seek to end-of-file so a restart doesn't re-emit
        # everything. For replay, callers use `capture_scrollback()` instead.
        try:
            # Use a raw fd so we can set O_NONBLOCK.
            fd = os.open(str(pipe_path), os.O_RDONLY | os.O_NONBLOCK)
        except FileNotFoundError:
            logger.warning("tmux_pipe_file_missing", path=str(pipe_path))
            return

        try:
            # Seek to end — we only want bytes produced after we started reading.
            try:
                os.lseek(fd, 0, os.SEEK_END)
            except OSError:
                pass

            while self._running:
                # Rotation check — once a second is plenty.
                now = time.monotonic()
                if now - self._last_rotate_check > 1.0:
                    self._last_rotate_check = now
                    await self._maybe_rotate(pipe_path, fd)

                try:
                    chunk = os.read(fd, 8192)
                except BlockingIOError:
                    chunk = b""
                except OSError as exc:
                    logger.warning("tmux_pipe_read_error", error=str(exc))
                    await asyncio.sleep(0.1)
                    continue

                if not chunk:
                    await asyncio.sleep(0.02)
                    continue

                if self.on_output is not None:
                    try:
                        result = self.on_output(chunk)
                        if asyncio.iscoroutine(result):
                            await result
                    except Exception as exc:
                        logger.error("tmux_on_output_error", error=str(exc))

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("tmux_tail_loop_crashed", error=str(exc))
        finally:
            try:
                os.close(fd)
            except OSError:
                pass

    async def _maybe_rotate(self, pipe_path: Path, current_fd: int) -> None:
        """Rotate the pipe file if it's too big or too old.

        We rename the current file to ``<name>.1``, then truncate the pipe
        back to zero. tmux's ``cat >> file`` keeps appending after our
        rename because the shell re-opens the path each time the pipe-pane
        hook fires — no tmux restart needed. We re-point our read fd at the
        freshly-truncated file.
        """
        try:
            st = os.stat(str(pipe_path))
        except FileNotFoundError:
            return

        age_hours = (time.monotonic() - self._rotation_started_at) / 3600.0
        too_big = st.st_size > MAX_LOG_BYTES
        too_old = age_hours > ROTATE_AGE_HOURS

        if not (too_big or too_old):
            return

        logger.info(
            "tmux_pipe_rotating",
            size=st.st_size,
            age_hours=round(age_hours, 2),
            reason="size" if too_big else "age",
        )

        rotated = pipe_path.with_suffix(pipe_path.suffix + ".1")
        try:
            if rotated.exists():
                rotated.unlink()
            os.rename(str(pipe_path), str(rotated))
            # Truncate by creating a new empty file at the original path.
            pipe_path.touch()
            # Permissive perms so tmux (same uid) can keep writing.
            os.chmod(str(pipe_path), stat.S_IRUSR | stat.S_IWUSR)
        except OSError as exc:
            logger.warning("tmux_pipe_rotate_failed", error=str(exc))
            return

        self._rotation_started_at = time.monotonic()
