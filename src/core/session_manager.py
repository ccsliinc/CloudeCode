"""Session manager for Claude Code instances."""

import asyncio
import json
from pathlib import Path
from typing import Optional
from datetime import datetime
import structlog

from src.config import settings
from src.models import Session, SessionStatus, SessionInfo, SessionStats, LogEntry
from src.utils.tmux import TmuxUtils, TmuxError

logger = structlog.get_logger()


class SessionManager:
    """Manages Claude Code sessions running in tmux."""

    def __init__(self):
        """Initialize the session manager."""
        self.tmux = TmuxUtils(socket_name=settings.tmux_socket_name)
        self.session: Optional[Session] = None
        self.log_buffer: list[LogEntry] = []
        self.command_count: int = 0
        self._last_output: str = ""

        # Load persisted session if it exists
        self._load_session_metadata()

    def _load_session_metadata(self):
        """Load session metadata from disk if it exists."""
        metadata_path = settings.get_session_metadata_path()

        if not metadata_path.exists():
            logger.info("no_existing_session_metadata")
            return

        try:
            with open(metadata_path, "r") as f:
                data = json.load(f)
                self.session = Session(**data)

            # Check if the tmux session still exists
            if self.tmux.session_exists(self.session.tmux_session):
                self.session.status = SessionStatus.RUNNING
                logger.info(
                    "session_restored_from_metadata",
                    session_id=self.session.id,
                    tmux_session=self.session.tmux_session
                )
            else:
                logger.warning(
                    "tmux_session_not_found",
                    session_id=self.session.id,
                    tmux_session=self.session.tmux_session
                )
                self.session.status = SessionStatus.STOPPED

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

    async def create_session(
        self,
        session_id: str,
        working_dir: Optional[str] = None,
        auto_start_claude: bool = True
    ) -> Session:
        """
        Create a new Claude Code session.

        Args:
            session_id: Unique identifier for the session
            working_dir: Working directory for the session (defaults to config)
            auto_start_claude: Whether to automatically start claude-code

        Returns:
            Created Session object

        Raises:
            ValueError: If a session already exists
            TmuxError: If tmux session creation fails
        """
        if self.session and self.session.status == SessionStatus.RUNNING:
            raise ValueError("A session is already running. Stop it before creating a new one.")

        # Determine working directory
        if working_dir:
            work_path = Path(working_dir).expanduser()
        else:
            # Create a session-specific subdirectory
            work_path = settings.get_working_dir() / session_id

        work_path.mkdir(parents=True, exist_ok=True)

        logger.info(
            "creating_session",
            session_id=session_id,
            working_dir=str(work_path)
        )

        # Create tmux session
        tmux_session_name = settings.tmux_session_name

        try:
            self.tmux.create_session(
                session_name=tmux_session_name,
                working_dir=work_path,
                detached=True
            )

            self.session = Session(
                id=session_id,
                tmux_session=tmux_session_name,
                working_dir=str(work_path),
                status=SessionStatus.RUNNING,
                created_at=datetime.utcnow(),
                last_activity=datetime.utcnow()
            )

            # Start Claude Code if requested
            if auto_start_claude:
                await asyncio.sleep(0.5)  # Give tmux a moment to stabilize
                self.tmux.send_keys(tmux_session_name, "claude-code")
                logger.info("claude_code_started", session_id=session_id)

            self._save_session_metadata()

            logger.info(
                "session_created",
                session_id=session_id,
                tmux_session=tmux_session_name
            )

            return self.session

        except TmuxError as e:
            logger.error("session_creation_failed", error=str(e))
            if self.session:
                self.session.status = SessionStatus.ERROR
            raise

    async def destroy_session(self) -> bool:
        """
        Destroy the current session.

        Returns:
            True if session destroyed successfully

        Raises:
            ValueError: If no session exists
            TmuxError: If tmux session destruction fails
        """
        if not self.session:
            raise ValueError("No session to destroy")

        logger.info("destroying_session", session_id=self.session.id)

        try:
            self.tmux.kill_session(self.session.tmux_session)
            self.session.status = SessionStatus.STOPPED

            # Clean up metadata
            metadata_path = settings.get_session_metadata_path()
            if metadata_path.exists():
                metadata_path.unlink()

            self.session = None
            self.log_buffer.clear()
            self.command_count = 0

            logger.info("session_destroyed")
            return True

        except TmuxError as e:
            logger.error("session_destruction_failed", error=str(e))
            raise

    async def send_command(self, command: str) -> bool:
        """
        Send a command to the session.

        Args:
            command: Command to send

        Returns:
            True if command sent successfully

        Raises:
            ValueError: If no session exists
            TmuxError: If sending command fails
        """
        if not self.session:
            raise ValueError("No active session")

        if self.session.status != SessionStatus.RUNNING:
            raise ValueError(f"Session is not running (status: {self.session.status})")

        logger.info(
            "sending_command",
            session_id=self.session.id,
            command=command[:50] + "..." if len(command) > 50 else command
        )

        try:
            self.tmux.send_keys(self.session.tmux_session, command)
            self.session.last_activity = datetime.utcnow()
            self.command_count += 1
            self._save_session_metadata()
            return True

        except TmuxError as e:
            logger.error("send_command_failed", error=str(e))
            raise

    async def capture_output(self, lines: int = 1000) -> str:
        """
        Capture output from the session.

        Args:
            lines: Number of lines to capture (from scrollback)

        Returns:
            Captured output as string

        Raises:
            ValueError: If no session exists
            TmuxError: If capture fails
        """
        if not self.session:
            raise ValueError("No active session")

        try:
            output = self.tmux.capture_pane(
                session_name=self.session.tmux_session,
                start_line=-lines
            )
            return output

        except TmuxError as e:
            logger.error("capture_output_failed", error=str(e))
            raise

    def get_recent_logs(self, limit: int = 100) -> list[LogEntry]:
        """
        Get recent log entries.

        Args:
            limit: Maximum number of entries to return

        Returns:
            List of recent log entries
        """
        return self.log_buffer[-limit:]

    def add_log_entry(self, content: str, log_type: str = "stdout"):
        """
        Add a log entry to the buffer.

        Args:
            content: Log content
            log_type: Type of log ("stdout", "stderr", "system")
        """
        if not self.session:
            return

        entry = LogEntry(
            timestamp=datetime.utcnow(),
            session_id=self.session.id,
            content=content,
            log_type=log_type
        )

        self.log_buffer.append(entry)

        # Maintain buffer size
        if len(self.log_buffer) > settings.log_buffer_size:
            self.log_buffer = self.log_buffer[-settings.log_buffer_size:]

    async def get_session_info(self) -> Optional[SessionInfo]:
        """
        Get complete session information.

        Returns:
            SessionInfo object or None if no session exists
        """
        if not self.session:
            return None

        # Calculate uptime
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
            stats=stats
        )

    def has_active_session(self) -> bool:
        """
        Check if there's an active session.

        Returns:
            True if session exists and is running
        """
        return self.session is not None and self.session.status == SessionStatus.RUNNING
