"""Tmux utility functions for session management."""

import subprocess
from typing import Optional, List
from pathlib import Path
import structlog

logger = structlog.get_logger()


class TmuxError(Exception):
    """Exception raised for tmux-related errors."""
    pass


class TmuxUtils:
    """Utility class for tmux operations."""

    def __init__(self, socket_name: str = "claude-controller"):
        """
        Initialize TmuxUtils.

        Args:
            socket_name: Name of the tmux socket to use
        """
        self.socket_name = socket_name

    def _run_command(self, cmd: List[str], check: bool = True) -> subprocess.CompletedProcess:
        """
        Run a tmux command.

        Args:
            cmd: Command to run as list of strings
            check: Whether to raise exception on non-zero exit

        Returns:
            CompletedProcess instance

        Raises:
            TmuxError: If command fails and check=True
        """
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=check
            )
            return result
        except subprocess.CalledProcessError as e:
            logger.error(
                "tmux_command_failed",
                command=" ".join(cmd),
                stderr=e.stderr,
                returncode=e.returncode
            )
            raise TmuxError(f"Tmux command failed: {e.stderr}") from e

    def create_session(
        self,
        session_name: str,
        working_dir: Optional[Path] = None,
        detached: bool = True
    ) -> bool:
        """
        Create a new tmux session.

        Args:
            session_name: Name of the tmux session
            working_dir: Working directory for the session
            detached: Whether to create session in detached mode

        Returns:
            True if session created successfully

        Raises:
            TmuxError: If session creation fails
        """
        cmd = ["tmux"]

        if self.socket_name:
            cmd.extend(["-L", self.socket_name])

        cmd.extend(["new-session"])

        if detached:
            cmd.append("-d")

        cmd.extend(["-s", session_name])

        if working_dir:
            cmd.extend(["-c", str(working_dir)])

        logger.info(
            "creating_tmux_session",
            session=session_name,
            working_dir=str(working_dir) if working_dir else None
        )

        self._run_command(cmd)
        return True

    def session_exists(self, session_name: str) -> bool:
        """
        Check if a tmux session exists.

        Args:
            session_name: Name of the tmux session

        Returns:
            True if session exists, False otherwise
        """
        cmd = ["tmux"]

        if self.socket_name:
            cmd.extend(["-L", self.socket_name])

        cmd.extend(["has-session", "-t", session_name])

        result = self._run_command(cmd, check=False)
        return result.returncode == 0

    def send_keys(self, session_name: str, keys: str, enter: bool = True) -> bool:
        """
        Send keys to a tmux session.

        Args:
            session_name: Name of the tmux session
            keys: Keys to send
            enter: Whether to send Enter key after keys

        Returns:
            True if keys sent successfully

        Raises:
            TmuxError: If sending keys fails
        """
        cmd = ["tmux"]

        if self.socket_name:
            cmd.extend(["-L", self.socket_name])

        cmd.extend(["send-keys", "-t", session_name, keys])

        if enter:
            cmd.append("C-m")

        logger.debug(
            "sending_keys_to_tmux",
            session=session_name,
            keys=keys[:50] + "..." if len(keys) > 50 else keys
        )

        self._run_command(cmd)
        return True

    def capture_pane(
        self,
        session_name: str,
        start_line: Optional[int] = None,
        end_line: Optional[int] = None
    ) -> str:
        """
        Capture the content of a tmux pane.

        Args:
            session_name: Name of the tmux session
            start_line: Starting line number (negative for history)
            end_line: Ending line number

        Returns:
            Captured pane content as string

        Raises:
            TmuxError: If capture fails
        """
        cmd = ["tmux"]

        if self.socket_name:
            cmd.extend(["-L", self.socket_name])

        cmd.extend(["capture-pane", "-t", session_name, "-p"])

        if start_line is not None:
            cmd.extend(["-S", str(start_line)])

        if end_line is not None:
            cmd.extend(["-E", str(end_line)])

        result = self._run_command(cmd)
        return result.stdout

    def kill_session(self, session_name: str) -> bool:
        """
        Kill a tmux session.

        Args:
            session_name: Name of the tmux session

        Returns:
            True if session killed successfully

        Raises:
            TmuxError: If killing session fails
        """
        cmd = ["tmux"]

        if self.socket_name:
            cmd.extend(["-L", self.socket_name])

        cmd.extend(["kill-session", "-t", session_name])

        logger.info("killing_tmux_session", session=session_name)

        self._run_command(cmd)
        return True

    def list_sessions(self) -> List[str]:
        """
        List all tmux sessions.

        Returns:
            List of session names
        """
        cmd = ["tmux"]

        if self.socket_name:
            cmd.extend(["-L", self.socket_name])

        cmd.extend(["list-sessions", "-F", "#{session_name}"])

        result = self._run_command(cmd, check=False)

        if result.returncode != 0:
            return []

        return [line.strip() for line in result.stdout.split("\n") if line.strip()]

    def get_pane_size(self, session_name: str) -> tuple[int, int]:
        """
        Get the size of a tmux pane.

        Args:
            session_name: Name of the tmux session

        Returns:
            Tuple of (width, height)

        Raises:
            TmuxError: If getting pane size fails
        """
        cmd = ["tmux"]

        if self.socket_name:
            cmd.extend(["-L", self.socket_name])

        cmd.extend(["display-message", "-t", session_name, "-p", "#{pane_width},#{pane_height}"])

        result = self._run_command(cmd)
        width, height = result.stdout.strip().split(",")
        return int(width), int(height)
