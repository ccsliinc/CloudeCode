"""Session manager for Claude Code instances.

Single-active-session design: holds at most ONE `SessionBackend` at a time.
Backend type (tmux vs PTY) is selected at construction via
`build_backend(settings)` which reads `AuthConfig.session.backend`.
"""

import asyncio
import json
import base64
from pathlib import Path
from typing import Optional
from datetime import datetime
import structlog

from src.config import settings
from src.models import Session, SessionStatus, SessionInfo, SessionStats, LogEntry
from src.core.session_backend import SessionBackend, build_backend
from src.core.notifications.idle_watcher import IdleWatcher
from src.utils.pty_session import PTYSessionError
from src.utils.template_manager import copy_templates as copy_template_files

logger = structlog.get_logger()


class SessionManager:
    """Manages Claude Code sessions via a pluggable SessionBackend."""

    def __init__(self):
        """Initialize the session manager."""
        self.session: Optional[Session] = None
        self.backend: Optional[SessionBackend] = None
        self.log_buffer: list[LogEntry] = []
        self.command_count: int = 0
        self._output_subscribers: list[asyncio.Queue] = []
        # Item 7: per-session idle watcher. Constructed lazily at
        # ``create_session`` so we can inject the live router from
        # ``app.state``; cleared by ``destroy_session``. Exposed directly
        # (not via a getter) so the WS chunk handler can bypass the
        # property-lookup cost in its hot path.
        self.idle_watcher: Optional[IdleWatcher] = None
        # Notification router reference — set by ``attach_notification_router``
        # during FastAPI lifespan startup (after both the SessionManager and
        # the router are constructed). When None, IdleWatcher instantiation
        # is skipped and no notification events fire.
        self._notification_router = None

        # Load persisted session if it exists
        self._load_session_metadata()

    # ---- notification wiring --------------------------------------------

    def attach_notification_router(self, router) -> None:
        """Inject the NotificationRouter after lifespan has built it.

        Called from ``src/main.py`` once during FastAPI startup. Kept as an
        explicit setter rather than a constructor arg so SessionManager can
        still be built before the router exists (matches the current
        lifespan ordering where the SessionManager is constructed first and
        must be usable for pre-router operations like ``lifespan_startup``).
        """
        self._notification_router = router

    # ---- backend type introspection --------------------------------------

    @property
    def backend_name(self) -> str:
        """Human-readable backend name for API responses ('tmux' / 'pty' / 'none')."""
        if self.backend is None:
            return "none"
        cls = self.backend.__class__.__name__
        # "TmuxBackend" → "tmux", "PTYBackend" → "pty"
        return cls.replace("Backend", "").lower()

    # ---- lifespan startup: discover + re-register -----------------------

    async def lifespan_startup(self) -> None:
        """Called once on server startup to re-adopt a surviving tmux session.

        This is separate from `__init__` because it needs to be awaitable and
        is driven by the FastAPI lifespan context manager. `main.py` calls
        this after `SessionManager()` is constructed.

        Behavior:
        - Build a probe backend using the metadata slug (if any).
        - Ask it to `discover_existing()`.
        - If the metadata's slug is present in the discovered list, re-register
          the session as active and start the backend's read loop.
        - Log other discovered sessions and leave them alone (orphan cleanup
          is out of scope — a v2 `cloude-cleanup` script will handle that).
        """
        if self.session is None:
            # No metadata on disk → nothing to re-adopt.
            # Still probe with a temp backend so we log any orphans.
            probe = build_backend(
                settings,
                session_id="__probe__",
                working_dir=Path.home(),
                on_output=None,
            )
            existing = probe.discover_existing()
            if existing:
                logger.info(
                    "session_backend_discovered_orphans",
                    count=len(existing),
                    names=existing,
                    hint="no metadata on disk — leaving orphans alone",
                )
            return

        # Build a backend matching the metadata's session id.
        work_path = Path(self.session.working_dir)
        backend = build_backend(
            settings,
            session_id=self.session.id,
            working_dir=work_path,
            on_output=self._handle_backend_output,
        )

        existing = backend.discover_existing()
        if not existing:
            # No tmux sessions at all — treat metadata as stale.
            logger.info(
                "session_metadata_has_no_backend_match",
                session_id=self.session.id,
            )
            self._clear_stale_metadata()
            return

        # For TmuxBackend, the registered name is `cloude_<slug>`. Match against it.
        # For PTYBackend, `discover_existing()` is always empty so we never reach here.
        target_name = getattr(backend, "tmux_session", None)
        if target_name and target_name in existing:
            self.backend = backend
            self.session.status = SessionStatus.RUNNING
            await self.backend.read_async()
            logger.info(
                "session_re_registered_from_backend",
                session_id=self.session.id,
                backend_session=target_name,
            )
            # Log strangers so the operator knows they're there.
            orphans = [n for n in existing if n != target_name]
            if orphans:
                logger.info("session_backend_orphans_ignored", names=orphans)
        else:
            logger.warning(
                "session_metadata_slug_not_in_backend",
                session_id=self.session.id,
                target=target_name,
                discovered=existing,
            )
            self._clear_stale_metadata()

    def _clear_stale_metadata(self) -> None:
        """Delete on-disk metadata for a session that can't be re-adopted."""
        metadata_path = settings.get_session_metadata_path()
        try:
            if metadata_path.exists():
                metadata_path.unlink()
                logger.info("stale_session_metadata_deleted")
        except Exception as exc:
            logger.error("failed_to_delete_stale_metadata", error=str(exc))
        self.session = None

    # ---- metadata persistence -------------------------------------------

    def _load_session_metadata(self):
        """Load session metadata from disk if it exists.

        Unlike the pre-refactor code, we do NOT probe the process here — at
        `__init__` time we don't yet know which backend to build. The probe
        happens in `lifespan_startup()`.
        """
        metadata_path = settings.get_session_metadata_path()

        if not metadata_path.exists():
            logger.info("no_existing_session_metadata")
            return

        try:
            with open(metadata_path, "r") as f:
                data = json.load(f)
                self.session = Session(**data)
            logger.info(
                "session_metadata_loaded",
                session_id=self.session.id,
                note="probe deferred to lifespan_startup",
            )
        except Exception as e:
            logger.error("failed_to_load_session_metadata", error=str(e))

    def _save_session_metadata(self):
        """Save session metadata to disk."""
        if not self.session:
            return

        metadata_path = settings.get_session_metadata_path()

        try:
            with open(metadata_path, "w") as f:
                json.dump(self.session.model_dump(), f, indent=2, default=str)

            logger.debug("session_metadata_saved", session_id=self.session.id)

        except Exception as e:
            logger.error("failed_to_save_session_metadata", error=str(e))

    # ---- output fan-out -------------------------------------------------

    async def _handle_backend_output(self, data: bytes):
        """Handle output from the backend. Broadcasts to WS subscribers."""
        encoded_data = base64.b64encode(data).decode('utf-8')

        for queue in self._output_subscribers.copy():
            try:
                await queue.put(encoded_data)
            except Exception as e:
                logger.error("failed_to_send_to_subscriber", error=str(e))
                self._output_subscribers.remove(queue)

    def subscribe_output(self) -> asyncio.Queue:
        """Subscribe to backend output stream."""
        queue = asyncio.Queue()
        self._output_subscribers.append(queue)
        return queue

    def unsubscribe_output(self, queue: asyncio.Queue):
        """Unsubscribe from backend output stream."""
        if queue in self._output_subscribers:
            self._output_subscribers.remove(queue)

    # ---- session lifecycle ----------------------------------------------

    async def create_session(
        self,
        session_id: str,
        working_dir: Optional[str] = None,
        auto_start_claude: bool = True,
        copy_templates: bool = False
    ) -> Session:
        """Create a new Claude Code session.

        Preserves the single-active invariant: if a session is already live,
        this raises. If there's stale metadata without a live backend, clean
        it up first.
        """
        if self.has_active_session():
            raise ValueError("A session is already running. Stop it before creating a new one.")

        # Clean up zombie session metadata if exists
        if self.session and not self.has_active_session():
            logger.info("cleaning_up_zombie_session", session_id=self.session.id)
            self._clear_stale_metadata()

        # Determine working directory
        if working_dir:
            work_path = Path(working_dir).expanduser()
        else:
            work_path = settings.get_working_dir() / session_id

        work_path.mkdir(parents=True, exist_ok=True)

        logger.info(
            "creating_session",
            session_id=session_id,
            working_dir=str(work_path),
            copy_templates=copy_templates
        )

        # Copy template files if requested
        if copy_templates:
            try:
                auth_config = settings.load_auth_config()
                if auth_config.template_path:
                    success, error = copy_template_files(
                        auth_config.template_path,
                        str(work_path)
                    )
                    if success:
                        logger.info("templates_copied_to_session", path=str(work_path))
                    else:
                        logger.warning("template_copy_failed", error=error)
                else:
                    logger.warning("no_template_path_configured")
            except Exception as e:
                logger.error("template_copy_error", error=str(e))

        try:
            # Build a fresh backend for the new session.
            self.backend = build_backend(
                settings,
                session_id=session_id,
                working_dir=work_path,
                on_output=self._handle_backend_output,
            )

            if auto_start_claude:
                claude_cli = settings.get_claude_cli_path()
                command = f"{claude_cli} --dangerously-skip-permissions"
                await self.backend.start(command=command)
            else:
                await self.backend.start()

            # Best-effort PID for metadata: TmuxBackend doesn't track a single
            # pid, PTYBackend exposes one via `.pid`.
            pid = getattr(self.backend, "pid", None)

            self.session = Session(
                id=session_id,
                pty_pid=pid,
                working_dir=str(work_path),
                status=SessionStatus.RUNNING,
                created_at=datetime.utcnow(),
                last_activity=datetime.utcnow()
            )

            self._save_session_metadata()

            # Item 7: spin up the per-session IdleWatcher. Skipped silently
            # when the router hasn't been attached (e.g. in tests that
            # exercise SessionManager without a full app lifespan) so the
            # session lifecycle doesn't break.
            if self._notification_router is not None:
                try:
                    auth_config = settings.load_auth_config()
                    threshold = getattr(
                        auth_config.notifications,
                        "idle_threshold_seconds",
                        30.0,
                    )
                except Exception:
                    threshold = 30.0
                self.idle_watcher = IdleWatcher(
                    session_slug=session_id,
                    router=self._notification_router,
                    threshold_s=threshold,
                )
                await self.idle_watcher.start()

            logger.info(
                "session_created",
                session_id=session_id,
                pid=pid,
                backend=self.backend_name,
            )

            return self.session

        except PTYSessionError as e:
            logger.error("session_creation_failed", error=str(e))
            if self.session:
                self.session.status = SessionStatus.ERROR
            raise ValueError(f"Failed to create session: {e}") from e
        except Exception as e:
            logger.error("session_creation_failed", error=str(e))
            if self.session:
                self.session.status = SessionStatus.ERROR
            # Also clean up a half-built backend + watcher.
            if self.backend is not None:
                try:
                    await self.backend.stop()
                except Exception:
                    pass
                self.backend = None
            if self.idle_watcher is not None:
                try:
                    await self.idle_watcher.stop()
                except Exception:
                    pass
                self.idle_watcher = None
            raise ValueError(f"Failed to create session: {e}") from e

    async def destroy_session(self) -> bool:
        """Destroy the current session."""
        if not self.session:
            raise ValueError("No session to destroy")

        logger.info("destroying_session", session_id=self.session.id)

        try:
            # Item 7: tear down the watcher FIRST. Stopping it before the
            # backend guarantees no poll iteration races with the pending
            # backend shutdown (the backend's final bytes could otherwise
            # fire a last-gasp TASK_COMPLETE after the session is gone).
            if self.idle_watcher is not None:
                try:
                    await self.idle_watcher.stop()
                except Exception as exc:
                    logger.warning(
                        "idle_watcher_stop_error",
                        error=str(exc),
                    )
                self.idle_watcher = None

            if self.backend is not None:
                await self.backend.stop()
                self.backend = None

            self.session.status = SessionStatus.STOPPED

            metadata_path = settings.get_session_metadata_path()
            if metadata_path.exists():
                metadata_path.unlink()

            self.session = None
            self.log_buffer.clear()
            self.command_count = 0
            self._output_subscribers.clear()

            logger.info("session_destroyed")
            return True

        except Exception as e:
            logger.error("session_destruction_failed", error=str(e))
            raise

    # ---- I/O -------------------------------------------------------------

    async def send_command(self, command: str) -> bool:
        """Send a command (with trailing newline) to the backend."""
        if not self.session:
            raise ValueError("No active session")

        if self.session.status != SessionStatus.RUNNING:
            raise ValueError(f"Session is not running (status: {self.session.status})")

        if not self.backend:
            raise ValueError("Backend not initialized")

        logger.info(
            "sending_command",
            session_id=self.session.id,
            command=command[:50] + "..." if len(command) > 50 else command
        )

        try:
            await self.backend.write(command.encode("utf-8") + b"\n")
            self.session.last_activity = datetime.utcnow()
            self.command_count += 1
            self._save_session_metadata()
            return True

        except Exception as e:
            logger.error("send_command_failed", error=str(e))
            raise ValueError(f"Failed to send command: {e}") from e

    async def send_input(self, data: str) -> bool:
        """Send raw input to the backend."""
        if not self.session or not self.backend:
            raise ValueError("No active session")

        if self.session.status != SessionStatus.RUNNING:
            raise ValueError(f"Session is not running (status: {self.session.status})")

        try:
            await self.backend.write(data.encode("utf-8"))
            self.session.last_activity = datetime.utcnow()
            return True

        except Exception as e:
            logger.error("send_input_failed", error=str(e))
            raise ValueError(f"Failed to send input: {e}") from e

    def resize_terminal(self, cols: int, rows: int):
        """Resize the backend's terminal."""
        if not self.backend:
            return

        try:
            self.backend.resize(cols, rows)
            logger.debug("terminal_resized", cols=cols, rows=rows)
        except Exception as e:
            logger.error("terminal_resize_failed", error=str(e))

    def capture_scrollback(self, lines: int = 3000) -> bytes:
        """Capture backend scrollback for WS replay on reconnect.

        Returns b"" when no backend is active, for PTYBackend, or when the
        backend can't produce scrollback. The WS handler treats b"" as
        "nothing to replay" and enters the live stream directly.
        """
        if not self.backend:
            return b""
        try:
            return self.backend.capture_scrollback(lines=lines)
        except Exception as exc:
            logger.error("capture_scrollback_failed", error=str(exc))
            return b""

    # ---- log buffer (unchanged) -----------------------------------------

    def get_recent_logs(self, limit: int = 100) -> list[LogEntry]:
        """Get recent log entries."""
        return self.log_buffer[-limit:]

    def add_log_entry(self, content: str, log_type: str = "stdout"):
        """Add a log entry to the buffer."""
        if not self.session:
            return

        entry = LogEntry(
            timestamp=datetime.utcnow(),
            session_id=self.session.id,
            content=content,
            log_type=log_type
        )

        self.log_buffer.append(entry)

        if len(self.log_buffer) > settings.log_buffer_size:
            self.log_buffer = self.log_buffer[-settings.log_buffer_size:]

    async def get_session_info(self) -> Optional[SessionInfo]:
        """Get complete session information."""
        if not self.has_active_session():
            return None

        uptime = int((datetime.utcnow() - self.session.created_at).total_seconds())

        stats = SessionStats(
            total_commands=self.command_count,
            uptime_seconds=uptime,
            log_lines=len(self.log_buffer),
            active_tunnels=len(self.session.tunnels)
        )

        return SessionInfo(
            session=self.session,
            recent_logs=self.get_recent_logs(),
            active_tunnels=self.session.tunnels,
            stats=stats,
            session_backend=self.backend_name,
        )

    def has_active_session(self) -> bool:
        """True iff a session is running AND its backend is alive."""
        return (
            self.session is not None
            and self.session.status == SessionStatus.RUNNING
            and self.backend is not None
            and self.backend.is_alive()
        )
