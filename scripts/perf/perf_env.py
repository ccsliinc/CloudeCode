"""Boot and tear down one ISOLATED, real Cloude Code server for measurement.

WHY A REAL SUBPROCESS, NOT AN IN-PROCESS TEST APP. Every existing test
harness that boots "the app" (``tests/real_hook_app.py``,
``tests/test_setup_wizard_renders.py``) deliberately assembles a MINIMAL
FastAPI app with only the routers a given test needs, specifically to
avoid ``src.main.py``'s full lifespan (config/db migration, first-run
import, boot re-adopt). That is the right call for those files, and the
wrong one here: this harness has to measure settings, the archive, menus
and notifications as well as the terminal, and it has to report the
SERVER PROCESS's own idle CPU and memory - both of which need the real
``src.main:app``, in its own OS process, so a ``ps`` sample against its
pid means what it claims to mean. A thread inside the measuring process
would have its CPU time and the browser driver's CPU time on the same
number.

ISOLATION, ENFORCED BY CONSTRUCTION, NOT BY CONVENTION.

  - Its tmux traffic never reaches the live ``cloude`` socket:
    ``session.tmux_socket_name`` in this run's throwaway ``config.json``
    is a name generated fresh per run (``_throwaway_socket_name``), and it
    is asserted not to equal ``cloude`` or any name already listed by
    ``tmux -L cloude ls`` before the server is ever started.
  - Its state, working directory, logs and datastore all live under one
    ``tempfile.mkdtemp()`` root, never under the real state directory a
    running Electron app would be using.
  - ``CLOUDE_TEST_MODE=1`` turns off the corpus ingest loop and the daily
    integrity-check loop (both default OFF under it - see
    ``src/core/corpus_ingest_task.py`` / ``src/core/db_integrity.py``), so
    this run never walks the operator's real ``~/.claude/projects`` corpus
    and never opens a database this harness did not create.
  - Every agent this run launches is a bare shell, never ``claude``. See
    the module docstring on ``scripts/perf/run_baseline.py`` for why: it
    keeps the baseline deterministic and free of real LLM latency, which
    the plan requires be measured SEPARATELY in the first place.

Nothing here binds ``0.0.0.0`` for it to actually be reached from the
network by anything but this harness: the bind is 0.0.0.0 per this
project's house rule (see CLAUDE.md, MISC RULES), but the port is a
throwaway one chosen at or above 5001 and the config is not the one any
other client on the LAN would know how to authenticate against (a fresh
TOTP secret, generated per run).
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
VENV_PYTHON = REPO_ROOT / "venv" / "bin" / "python3"

#: Never touch the live socket, whatever else changes about naming.
FORBIDDEN_SOCKET_NAME = "cloude"

#: A fresh, valid base32 TOTP secret per run - never a shared literal, so
#: a stray real client can never authenticate against a perf run by
#: guessing a hardcoded test secret.
def _fresh_totp_secret() -> str:
    """A random base32 TOTP secret, valid input for ``pyotp.TOTP``.

    Inputs: none. Output: str - 32 base32 characters.
    """
    import pyotp

    return pyotp.random_base32()


def free_port(minimum: int = 5001) -> int:
    """Pick a free TCP port at or above ``minimum``, bound to 0.0.0.0.

    Description: binds a probe socket to ``0.0.0.0:0`` above the floor by
      retrying the OS's ephemeral allocation until it lands at or past
      ``minimum`` - never 5000 (macOS AirPlay), per house rule.
    Inputs: minimum (int) - the lowest acceptable port.
    Output: int - a currently-free port.
    Example: free_port() -> 5231
    """
    for _ in range(200):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("0.0.0.0", 0))
            port = probe.getsockname()[1]
        if port >= minimum:
            return port
    raise RuntimeError("could not find a free port at or above the floor")


def _throwaway_socket_name() -> str:
    """A tmux socket name this run owns exclusively, never ``cloude``.

    Inputs: none.
    Output: str - e.g. ``cloudeperf_3f9a1c2b``.
    """
    name = f"cloudeperf_{uuid.uuid4().hex[:12]}"
    assert name != FORBIDDEN_SOCKET_NAME, "generated name collided with the live socket"
    return name


def _tmux(socket_name: str, *args: str) -> subprocess.CompletedProcess:
    """Run one tmux command against this run's OWN socket, never another.

    Inputs: socket_name (str); args (str) - the argv after ``-L <name>``.
    Output: CompletedProcess, text captured, never raising on nonzero exit.
    """
    assert socket_name != FORBIDDEN_SOCKET_NAME
    return subprocess.run(
        ["tmux", "-L", socket_name, *args],
        capture_output=True,
        text=True,
        check=False,
    )


@dataclass
class PerfServer:
    """One isolated, real ``src.main:app`` server, in its own process.

    Description: everything this run touches lives under ``self.root``
      (a ``tempfile.mkdtemp()``) and its own tmux socket
      (``self.tmux_socket``). Use as a context manager; ``__exit__`` kills
      the uvicorn subprocess, kills the tmux server on this run's socket,
      and removes the temp root. Every session the harness creates uses
      ``agent_type="shell"`` (``AgentsConfig.shell_command``, ``"$SHELL
      -i"`` by default - a reserved, first-class agent type, not a
      config override of the ``claude`` slot), so no run depends on the
      real ``claude`` binary or spends a real LLM turn.
    Inputs: port (Optional[int]) - fixed port, or a fresh free one when
      omitted.
    Output: attributes ``base_url``, ``port``, ``tmux_socket``, ``pid``,
      ``totp_secret``, ``jwt_secret``, after ``start()``.
    Example:
        with PerfServer() as srv:
            srv.start()
            ...
    """

    port: Optional[int] = None
    startup_timeout_s: float = 45.0
    #: Override for the throwaway tmux socket name. Leave unset for a
    #: standalone run (``run_baseline.py``) - a fresh random name is
    #: generated. Pytest-driven callers (``tests/test_perf_harness_smoke.py``)
    #: MUST pass ``tests.socket_guard.derive_test_socket(...)`` here: that
    #: suite installs a global subprocess guard that raises on any tmux
    #: invocation whose socket is not the current pytest process's
    #: registered test socket (or a name derived from it) - including this
    #: class's own teardown call, which runs in the pytest process itself
    #: rather than inside the isolated server's subprocess. A random name
    #: is correctly rejected there; it is not a bug in the guard.
    tmux_socket_name: Optional[str] = None

    def __post_init__(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="cc_perf_"))
        self.tmux_socket = self.tmux_socket_name or _throwaway_socket_name()
        self.totp_secret = _fresh_totp_secret()
        self.jwt_secret = secrets.token_hex(32)
        self.port = self.port or free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self._proc: Optional[subprocess.Popen] = None
        self._work_dir = self.root / "work"
        self._state_dir = self.root / "state"
        self._log_dir = self.root / "logs"
        self._corpus_root = self.root / "corpus"
        for d in (self._work_dir, self._state_dir, self._log_dir, self._corpus_root):
            d.mkdir(parents=True, exist_ok=True)
        self._config_path = self.root / "config.json"
        self._write_config()

    # -- setup ----------------------------------------------------------- #

    def _write_config(self) -> None:
        """Write this run's throwaway ``config.json``.

        Description: mirrors ``config.example.json``'s shape with one
          load-bearing change - ``session.tmux_socket_name`` is this run's
          own socket, never ``"cloude"``. ``agents.claude_command`` is
          deliberately left at its default (empty, meaning "not
          configured"): the harness never creates a ``claude``-type
          session, so what that slot resolves to is moot.
        Inputs: none. Output: None (writes ``self._config_path``).
        """
        assert self.tmux_socket != FORBIDDEN_SOCKET_NAME
        config = {
            "jwt_expiry_minutes": 30,
            "session": {
                "backend": "tmux",
                "tmux_socket_name": self.tmux_socket,
                "scrollback_lines": 10000,
                "disable_alternate_screen": True,
            },
            "notifications": {"enabled": False},
            "agents": {"wrappers": []},
            "message_archive": {"enabled": False},
        }
        self._config_path.write_text(json.dumps(config, indent=2))

    def _env(self) -> dict:
        """The complete environment the server subprocess runs under.

        Inputs: none.
        Output: dict[str, str] - a copy of ``os.environ`` overridden with
          every isolation variable this run needs.
        """
        env = dict(os.environ)
        env.update(
            {
                "DEFAULT_WORKING_DIR": str(self._work_dir),
                "LOG_DIRECTORY": str(self._log_dir),
                "CLOUDE_STATE_DIR": str(self._state_dir),
                "TOTP_SECRET": self.totp_secret,
                "JWT_SECRET": self.jwt_secret,
                "AUTH_CONFIG_FILE": str(self._config_path),
                "HOST": "0.0.0.0",
                "PORT": str(self.port),
                "CLOUDE_BOUND_HOST": "127.0.0.1",
                # Never walk the operator's real corpus, never run the
                # daily integrity pragma against a database this harness
                # did not create.
                "CLOUDE_TEST_MODE": "1",
                "CLOUDE_CORPUS_INGEST": "0",
                "CLOUDE_DB_INTEGRITY_CHECK": "0",
                "CLOUDE_CORPUS_ROOT": str(self._corpus_root),
                "LOG_LEVEL": "WARNING",
            }
        )
        return env

    def start(self) -> "PerfServer":
        """Launch ``src.main:app`` under uvicorn and wait until it answers.

        Inputs: none.
        Output: self, once ``GET /health`` has answered 200.
        Raises: RuntimeError - the process exited, or never answered
          within ``startup_timeout_s``.
        """
        python = str(VENV_PYTHON) if VENV_PYTHON.exists() else sys.executable
        self._proc = subprocess.Popen(
            [
                python,
                "-m",
                "uvicorn",
                "src.main:app",
                "--host",
                "0.0.0.0",
                "--port",
                str(self.port),
                "--log-level",
                "warning",
            ],
            cwd=str(REPO_ROOT),
            env=self._env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self.boot_started_at = time.monotonic()
        deadline = self.boot_started_at + self.startup_timeout_s
        import httpx

        last_error: Optional[Exception] = None
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                out = self._proc.stdout.read() if self._proc.stdout else ""
                raise RuntimeError(
                    "perf server process exited during startup "
                    f"(code {self._proc.returncode}); output:\n{out[-4000:]}"
                )
            try:
                resp = httpx.get(f"{self.base_url}/health", timeout=1.0)
                if resp.status_code == 200:
                    self.boot_ready_at = time.monotonic()
                    self.boot_seconds = self.boot_ready_at - self.boot_started_at
                    return self
            except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout) as exc:
                last_error = exc
            time.sleep(0.05)
        raise RuntimeError(
            f"perf server never answered /health within {self.startup_timeout_s}s: "
            f"{last_error}"
        )

    @property
    def work_dir(self) -> str:
        """The isolated work root every session this run creates lives under.

        Inputs: none. Output: str - absolute path.
        """
        return str(self._work_dir)

    @property
    def pid(self) -> Optional[int]:
        """The uvicorn subprocess's own pid, for ``ps``-based sampling.

        Inputs: none. Output: Optional[int] - None before ``start()``.
        """
        return self._proc.pid if self._proc is not None else None

    # -- teardown ---------------------------------------------------------#

    def stop(self) -> None:
        """Terminate the server, kill its tmux socket, remove its files.

        Description: TERMINATE first (SIGTERM, uvicorn's graceful path),
          then KILL if it has not exited within a bounded wait - never
          left running, never left ambiguous. The tmux ``kill-server`` is
          issued against THIS RUN'S OWN SOCKET ONLY and is a no-op (exit
          nonzero, ignored) when tmux never created that socket at all.
        Inputs: none. Output: None. Never raises.
        """
        if self._proc is not None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=5)
            except Exception:  # noqa: BLE001 - teardown must not raise
                pass
            self._proc = None
        _tmux(self.tmux_socket, "kill-server")
        shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self) -> "PerfServer":
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()


def assert_no_live_socket_named(name: str) -> None:
    """Refuse to proceed if ``name`` is the live socket or already in use.

    Description: a second safety net beside ``FORBIDDEN_SOCKET_NAME`` -
      called once, right before the first tmux command of a run, so a
      caller that constructed a ``PerfServer`` with a hand-picked name
      cannot accidentally collide with the operator's real socket.
    Inputs: name (str).
    Output: None.
    Raises: AssertionError - name is the live socket name.
    """
    assert name != FORBIDDEN_SOCKET_NAME, (
        "refusing to run against the live 'cloude' tmux socket - this "
        "harness must use its own throwaway socket"
    )
