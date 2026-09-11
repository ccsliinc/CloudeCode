"""The health endpoint.

``GET /health`` answers what this process is and whether its stores are
readable. It is polled by the Electron tray every 20 seconds, which is
why nothing expensive may be put on it: a ``PRAGMA integrity_check`` used
to run here and blocked the event loop for roughly 14 of every 20 seconds
on a 4.5 GB database. The verdict is read from a cached artifact instead;
see ``src/core/db_integrity_status.py``.
"""

from fastapi import APIRouter, Request
from src.core.version import startup_version
from src.models import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health_endpoint(request: Request):
    """
    Health check endpoint for menu bar app.
    Returns server status, uptime, session info, and detected-server count.

    Note: This endpoint does NOT require authentication to allow menu bar app
    to poll before user logs in via web UI.

    Returns:
        Health status with stats
    """
    import os

    session_manager = request.app.state.session_manager
    local_servers = getattr(request.app.state, "local_servers", None)

    # Get session info
    session_name = None
    if session_manager and session_manager.has_active_session():
        session_info = await session_manager.get_session_info()
        if session_info and session_info.session:
            # Use basename of working directory as session name
            session_name = os.path.basename(session_info.session.working_dir)

    # Count detected local dev servers across every tracked session.
    # Replaces the old ``tunnel_count``; the menu-bar tray reads this.
    local_server_count = 0
    if local_servers is not None:
        try:
            local_server_count = sum(
                len(v) for v in local_servers.snapshot().values()
            )
        except Exception:  # pragma: no cover - defensive
            local_server_count = 0

    # Calculate uptime (we don't track server start time, so use session uptime as proxy)
    uptime_seconds = 0
    if session_manager and session_manager.has_active_session():
        session_info = await session_manager.get_session_info()
        if session_info and session_info.stats:
            uptime_seconds = session_info.stats.uptime_seconds

    return HealthResponse(
        status="running",
        uptime=uptime_seconds,
        session_name=session_name,
        local_server_count=local_server_count,
        # WHOSE CODE IS ON THIS PORT.
        #
        # The menu-bar app adopts an already-healthy server rather than
        # double-spawning, which is right after an Electron crash and wrong
        # across an upgrade. On 2026-08-25 a v1.0.2 server was orphaned on
        # quit, reparented to launchd, and adopted by a v1.0.3 bundle, which
        # then ran the old code for four hours. The app needs to compare
        # versions BEFORE adopting, and it has not authenticated at that
        # point - which is why this rides on the unauthenticated health poll
        # rather than on GET /api/v1/version, which requires auth.
        #
        # startup_version() is frozen at process start, NOT re-resolved here.
        # bootstrap.js rewrites the on-disk VERSION file on every packaged
        # launch, so a fresh resolve would have this old process report the
        # NEW bundle's number and turn an upgrade into a false match.
        version=startup_version(),
    )
