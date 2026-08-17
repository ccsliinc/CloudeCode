"""``GET /api/v1/server/status`` - the read-only snapshot the home bar shows.

ITS OWN MODULE ON PURPOSE. ``src/api/routes.py`` is already ~1970 lines and
``src/config.py`` ~1650; neither gets to grow for a feature with no reason
to live inside them. This router is mounted alongside them in
``src/main.py`` under the same ``/api/v1`` prefix.

AUTH IS NOT OPTIONAL HERE. The app is reachable from every device on the
LAN with the host firewall off, and its TOTP auth is the only gate, so an
endpoint leaking memory figures, disk paths, working directories and
session names would be a real disclosure. The route declares
``Depends(require_auth)`` exactly like every other ``/api/v1`` route, and
``tests/test_server_status_api.py`` asserts an unauthenticated GET returns
401 rather than assuming it.

NOTHING HERE DESTROYS ANYTHING. The panel's kill control reuses the two
destruction endpoints that already exist in ``routes.py``: ``DELETE
/sessions`` for a session bound to a live backend, and ``DELETE
/sessions/external/{name}`` for one that is not. A third way to kill a
tmux session is how the first two drift apart.

OWNERSHIP COMES FROM THE SESSION MANAGER, NOT FROM AN ID PREFIX. See the
docblock on :mod:`src.core.server_status`. After a server restart the app
re-attaches to its own still-running sessions through the adopt path, so
an app-created session carries an ``adopted:`` id while still sitting in
the persisted ``owned_tmux_sessions`` set. This route reads
``created_by_cloude`` off ``SessionManager.list_attachable_sessions()``,
the one place that answer is computed, and merges it by NAME.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request

from src.api.auth import require_auth
from src.config import settings
from src.core import server_status
from src.core.tmux_backend import DEFAULT_SOCKET_NAME

logger = structlog.get_logger()

router = APIRouter(tags=["server-status"])


def resolve_socket_name() -> str:
    """The tmux socket this server uses, with the documented fallback.

    Returns:
        The configured ``session.tmux_socket_name``, or the module
        default when the auth config cannot be loaded.
    """
    try:
        return settings.load_auth_config().session.tmux_socket_name
    except (OSError, ValueError, AttributeError) as exc:
        logger.debug("server_status_socket_name_fallback", error=str(exc))
        return DEFAULT_SOCKET_NAME


def open_ids_by_name(session_manager: Any) -> Dict[str, str]:
    """Map each live backend's tmux session name to its session id.

    A row with an entry here is open in THIS server process right now,
    which is exactly the difference between the two destruction
    endpoints: ``DELETE /sessions/external/{name}`` refuses these by
    design, because killing tmux out from under a live backend orphans
    its reader task and idle watcher.

    Args:
        session_manager: the app's SessionManager.

    Returns:
        tmux name -> session id. Empty when nothing is open.
    """
    backends = getattr(session_manager, "backends", None)
    if not isinstance(backends, dict):
        return {}
    mapping: Dict[str, str] = {}
    for session_id, backend in backends.items():
        name = getattr(backend, "tmux_session", None)
        if name:
            mapping[name] = session_id
    return mapping


def ownership_by_name(session_manager: Any) -> Dict[str, bool]:
    """Map each tmux session name to the server's ``created_by_cloude``.

    Sourced from ``SessionManager.list_attachable_sessions()``, which
    computes it from the persisted ``owned_tmux_sessions`` set. Never
    re-derived here and never hardcoded: both mistakes have shipped, and
    both made an app-created session badge as external.

    Args:
        session_manager: the app's SessionManager.

    Returns:
        tmux name -> bool. A name absent from the mapping is reported to
        the client as unknown, never as False.
    """
    lister = getattr(session_manager, "list_attachable_sessions", None)
    if not callable(lister):
        return {}
    try:
        rows: List[Dict[str, Any]] = lister()
    except (OSError, ValueError, RuntimeError) as exc:
        logger.warning("server_status_ownership_unavailable", error=str(exc))
        return {}
    out: Dict[str, bool] = {}
    for row in rows or []:
        name = row.get("name")
        if name and "created_by_cloude" in row:
            out[name] = bool(row["created_by_cloude"])
    return out


@router.get(
    "/server/status",
    response_model=None,
    dependencies=[Depends(require_auth)],
)
async def get_server_status(request: Request) -> Dict[str, Any]:
    """Collect a read-only snapshot of the host, this process and tmux.

    Args:
        request: the incoming request, for ``app.state.session_manager``.

    Returns:
        The snapshot produced by :func:`src.core.server_status.collect`.
        Every section carries its own ``available``/``error`` pair so a
        probe that could not run renders as "cannot determine" rather
        than as a healthy zero.

    Raises:
        HTTPException: 503 when the session manager is not mounted, which
            is the only way the tmux rows could silently claim that no
            session belongs to this app.
    """
    session_manager: Optional[Any] = getattr(
        request.app.state, "session_manager", None
    )
    if session_manager is None:
        raise HTTPException(
            status_code=503, detail="session manager not available"
        )

    snapshot = server_status.collect(
        host=settings.host,
        port=settings.port,
        socket_name=resolve_socket_name(),
        ownership_by_name=ownership_by_name(session_manager),
        open_ids_by_name=open_ids_by_name(session_manager),
    )
    logger.info(
        "server_status_collected",
        tmux_running=snapshot["tmux"]["server_running"],
        session_count=len(snapshot["tmux"]["sessions"]),
    )
    return snapshot
