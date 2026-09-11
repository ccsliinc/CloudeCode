"""The per-session theme, the pinned theme and the unread flag.

UNREAD IS KEYED ON THE INSTANCE, ``<tmux_name>@<#{session_created}>``,
because a name is reused and a flag from a killed session reappeared on
its successor. Both writers - the user's control and the automatic one -
move ONE flag, and the epoch behind the key has exactly one source,
``src/core/unread_identity.py``. Two derivations for one key are two keys
the moment they disagree.
"""

import structlog
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from src.api.auth import require_auth
from src.core.agent_family_display import resolve_family_for_display
from src.core.session_manager import _configured_wrappers
from src.core.tmux_listing import coerce_listing
from src.models import (
    Session,
    SessionInfo,
    SessionStats,
    SessionStatus,
    SetUnreadRequest,
    SuccessResponse,
    UpdatePinnedThemeRequest,
    UpdateThemeRequest,
)
from typing import Optional

logger = structlog.get_logger()
router = APIRouter()


# v0.7.0 - one-shot deprecation log guard for the legacy
# ``PATCH /sessions/{name}/pinned-theme`` alias. Flipped True on the first
# hit per server process so we don't spam logs every PATCH while still
# emitting a single audit line per uptime window. Removed when the alias
# itself is dropped in v0.8.x.
_PINNED_THEME_ALIAS_WARNED: bool = False


async def _apply_session_theme(
    session_manager,
    themes,
    owned_tmux,
    registry,
    session_name: str,
    theme_id: Optional[str],
) -> SessionInfo:
    """Shared implementation for both ``/theme`` and the deprecated
    ``/pinned-theme`` alias.

    THIS PINS A THEME TO ONE SESSION, AND IT WRITES ONE STORE.

      * Validates the tmux name against the known-sessions set (owned
        union active union the attachable probe), so this cannot become
        an arbitrary key-value endpoint. ``owned_tmux`` is the
        ``OwnedTmuxLedger``, which knows which tmux names this app
        created, and ``registry`` is the ``SessionRegistry``, which
        knows which sessions are live; both arrive as arguments because
        the manager no longer forwards to them.
      * Writes the per-session pin through
        ``session_manager.set_pinned_theme``, which persists
        ``pinned_themes.json`` and mirrors onto the live
        ``Session.pinned_theme`` so a follow-up ``get_session_info``
        reflects the change without re-reading.
      * Empty/None ``theme_id`` clears the pin, dropping this session
        back to its project's ``.cc.theme`` default.

    IT DELIBERATELY NO LONGER WRITES ``<working_dir>/.cc.theme``. That
    file is keyed on the DIRECTORY, so writing it from a per-session pin
    rethemed every sibling session in the same folder, and this app
    routinely runs several out of one repo. Doing it while
    ``resolve_project_theme`` reads the pin first (issue #65, taken at
    the 1.4.0 integration) would be worse than the original bug: the
    folder's default would silently follow whichever session was themed
    last, changing what every never-pinned session in it paints. Setting
    a project default is a separate, deliberate act and goes through
    ``ThemeStore.set_project_theme``. The ``themes`` argument is kept
    because the validation path still reads it.

    Raises HTTPException for the route layer to surface verbatim.
    """
    # Defense in depth: strip the "adopted:" prefix if a stale frontend
    # ever sends it (Session.id is "adopted:<name>" for adopted rows).
    if session_name.startswith("adopted:"):
        session_name = session_name[len("adopted:"):]

    # Build the set of tmux names we recognize: live attachable rows
    # (caught by tmux probe) ∪ owned_tmux_sessions ∪ every live backend.
    known_names: set[str] = set(owned_tmux.names)
    known_names |= session_manager.active_tmux_names()
    # A failed probe only SHRINKS ``known_names`` here, and the union
    # already contains the owned set and every live backend, so the worst
    # case is a 404 on a name we could not confirm - a refusal, never a
    # silent wrong write. Logged so the degraded input is visible.
    try:
        theme_listing = coerce_listing(session_manager.list_attachable_sessions())
        if not theme_listing.ok:
            logger.warning(
                "session_theme_attachable_probe_unavailable",
                reason=theme_listing.reason,
            )
        known_names |= set(theme_listing.names)
    except (OSError, RuntimeError, ValueError) as exc:
        logger.warning("session_theme_attachable_probe_failed", error=str(exc))

    if session_name not in known_names:
        logger.info(
            "session_theme_set_404",
            session_name=session_name,
            known_names=sorted(known_names),
        )
        raise HTTPException(
            status_code=404,
            detail=f"Unknown session {session_name!r}",
        )

    # Resolve the working_dir for this tmux name. Live backend's session
    # record wins; otherwise we don't have a path to write to.
    matched_sid: Optional[str] = None
    matched_working_dir: Optional[str] = None
    for sid, b in registry.backends.items():
        if getattr(b, "tmux_session", None) == session_name:
            matched_sid = sid
            sess_obj = registry.get_session(sid)
            if sess_obj is not None:
                matched_working_dir = sess_obj.working_dir
            break

    # ONE STORE, THE SESSION'S OWN. ``set_pinned_theme`` handles both the
    # durable map write and the live-backend mirror, so there is no
    # second lookup to duplicate here and no folder-wide file to write.
    # ``matched_working_dir`` is still resolved above because the echo
    # below reports it.
    session_manager.set_pinned_theme(session_name, theme_id)

    logger.info(
        "api_set_session_theme",
        session_name=session_name,
        theme_id=theme_id,
        working_dir=matched_working_dir,
    )

    if matched_sid is not None:
        info = await session_manager.get_session_info(session_id=matched_sid)
        if info is not None:
            return info

    # Non-active pin update - synthesize a minimal SessionInfo-shaped
    # echo that carries the pin so the pydantic contract still holds.
    placeholder_session = Session(
        id=f"pinned:{session_name}",
        pty_pid=None,
        working_dir=matched_working_dir or "",
        status=SessionStatus.STOPPED,
        created_at=datetime.utcnow(),
        last_activity=datetime.utcnow(),
        pinned_theme=theme_id,
    )
    # feat/agent-family-pills - this placeholder carries no real
    # agent_type, so it resolves to (None, "unknown") same as any other
    # unresolvable input. Run through the real resolver rather than
    # hardcoding the strings, so a future change to the resolver's
    # "no value at all" outcome does not have to be remembered here too.
    placeholder_family, placeholder_family_source = resolve_family_for_display(
        None, _configured_wrappers()
    )
    return SessionInfo(
        session=placeholder_session,
        recent_logs=[],
        local_servers=[],
        stats=SessionStats(
            total_commands=0, uptime_seconds=0, log_lines=0, local_servers=0
        ),
        session_backend="none",
        tmux_session=session_name,
        agent_type=None,
        agent_family=placeholder_family.name if placeholder_family else None,
        agent_family_source=placeholder_family_source,
        pinned_theme=theme_id,
    )


@router.patch(
    "/sessions/{session_name}/theme",
    response_model=SessionInfo,
    dependencies=[Depends(require_auth)],
)
async def set_session_theme(
    request: Request, session_name: str, body: UpdateThemeRequest
):
    """Set (or clear) the project-scoped theme for a session.

    Supersedes ``PATCH /sessions/{name}/pinned-theme``. The theme id is
    recorded against this session's tmux name, so two sessions running
    out of one folder can hold two different themes and each keeps its
    own across a server restart. Clearing drops the session back to its
    project's ``.cc.theme`` default.

    Body shape: ``{"theme_id": "<id>"}`` or ``{"theme_id": null}`` (or
    empty string) to clear. The session is validated against the same
    known-tmux-names set used by the legacy route - owned ∪ active ∪
    attachable probe - so this endpoint can't become an arbitrary KV
    store while still accepting pins for detached-but-alive sessions.

    The response is the live ``SessionInfo`` when the named session is
    active; otherwise a minimal echo whose ``pinned_theme`` field
    carries the new value.
    """
    session_manager = request.app.state.session_manager
    return await _apply_session_theme(
        session_manager,
        request.app.state.services.themes,
        request.app.state.services.owned_tmux,
        request.app.state.services.registry,
        session_name,
        body.theme_id,
    )


@router.patch(
    "/sessions/{session_name}/unread",
    response_model=SuccessResponse,
    dependencies=[Depends(require_auth)],
)
async def set_session_unread(
    request: Request, session_name: str, body: SetUnreadRequest
):
    """Manually mark (or clear) a session unread for followup.

    feat/hook-driven-status - ``session_name`` is the literal tmux session
    name (same convention as ``/sessions/{session_name}/theme``), so this
    works whether the session is currently attached to or only attachable.
    Persisted server-side (not localStorage) so the flag follows the user
    across browsers/devices - see ``SessionManager.set_manual_unread``.

    ONE FLAG. This writes the same instance-keyed unread a ``Stop`` hook
    writes and ``/sessions/list`` reports, so every surface agrees. False
    marks the session read outright, and so does opening its tab.
    """
    session_manager = request.app.state.session_manager
    session_manager.set_manual_unread(session_name, body.unread)
    return SuccessResponse(
        success=True,
        message=f"Session {'marked' if body.unread else 'cleared'} unread",
    )


@router.patch(
    "/sessions/{session_name}/pinned-theme",
    response_model=SessionInfo,
    dependencies=[Depends(require_auth)],
    deprecated=True,
)
async def set_pinned_theme(
    request: Request, session_name: str, body: UpdatePinnedThemeRequest
):
    """DEPRECATED v0.7.0 - use ``PATCH /sessions/{session_name}/theme``.

    Kept as a routing alias for ONE release so v0.6.x clients keep
    working through an upgrade window. Internally forwards to the same
    code path as the new endpoint - the theme id is recorded as this
    session's own pin regardless of which route the client hits. The
    response shape is unchanged.

    Will be REMOVED in v0.8.x. New clients MUST use ``/theme``.
    """
    global _PINNED_THEME_ALIAS_WARNED
    if not _PINNED_THEME_ALIAS_WARNED:
        # One-shot per-process warning so logs aren't spammed by chatty
        # clients while still surfacing a single audit line per uptime
        # window. Reset on server restart by design.
        _PINNED_THEME_ALIAS_WARNED = True
        logger.warning(
            "route_deprecated_pinned_theme",
            session_name=session_name,
            replacement="PATCH /sessions/{session_name}/theme",
            removal_version="v0.8.x",
        )
    session_manager = request.app.state.session_manager
    return await _apply_session_theme(
        session_manager,
        request.app.state.services.themes,
        request.app.state.services.owned_tmux,
        request.app.state.services.registry,
        session_name,
        body.pinned_theme,
    )
