"""Recent log lines, and the local servers detected in one session.

Two read-only endpoints over state the session already holds. Neither
shells out and neither touches tmux.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from src.api.auth import require_auth
from src.models import LocalServerInfo, LogEntry
from typing import List

router = APIRouter()


@router.get("/sessions/logs", response_model=List[LogEntry], dependencies=[Depends(require_auth)])
async def get_logs(request: Request, limit: int = 100):
    """
    Get recent log entries.

    Args:
        limit: Maximum number of entries to return (default 100)

    Returns:
        List of log entries

    Raises:
        HTTPException: If no session exists
    """
    session_manager = request.app.state.session_manager

    if not session_manager.has_active_session():
        raise HTTPException(status_code=404, detail="No active session")

    logs = session_manager.get_recent_logs(limit=limit)
    return logs


@router.get(
    "/sessions/{session_name}/local-servers",
    response_model=List[LocalServerInfo],
    dependencies=[Depends(require_auth)],
)
async def get_local_servers(request: Request, session_name: str):
    """List dev servers detected for ``session_name``.

    Replaces the old ``GET /api/v1/tunnels`` surface. Pure read - never
    triggers detection / probes; the LocalServersTracker maintains the
    list as a side effect of pattern matches plus a 30s janitor sweep.

    Returns an empty list when the session has no tracked servers (or
    when the session name is unknown to the tracker - we don't 404 on
    "no servers yet" because the UI polls speculatively before any have
    been detected).
    """
    local_servers = request.app.state.local_servers
    return local_servers.list_for_session(session_name)
