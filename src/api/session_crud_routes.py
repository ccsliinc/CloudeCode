"""Create, read, list, destroy and detach a session.

The five verbs every other session route is built on. ``GET
/sessions/list`` is the endpoint whose ``SessionInfo`` shape puts fields
on TWO LEVELS - ``activity_status`` and friends on the wrapper, ``id``
and ``working_dir`` on the nested ``.session`` - which is the single most
repeated bug in this project. Read CLAUDE.md's "/sessions/list shape"
section before debugging a field that reads as missing here.

DESTROY IS NOT DETACH. Destroy kills the tmux session and marks the row
closed; detach drops this server's hold on a pane that keeps running.
"""

import base64
import os
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from src.api.auth import require_auth
from src.config import settings
from src.core import session_change_notice
from src.core import single_flight
from src.models import (
    CreateSessionRequest,
    Session,
    SessionInfo,
    SuccessResponse,
)
from typing import List, Optional

logger = structlog.get_logger()
router = APIRouter()


@router.post("/sessions", response_model=Session, status_code=201, dependencies=[Depends(require_auth)])
async def create_session(request: Request, body: CreateSessionRequest):
    """
    Create a new Claude Code session.

    Args:
        body: Session creation parameters

    Returns:
        Created session object

    Raises:
        HTTPException: If session creation fails
    """
    session_manager = request.app.state.session_manager

    try:
        # Generate session ID
        import uuid
        session_id = f"ses_{uuid.uuid4().hex[:8]}"

        # Expand ~ / ~user in client-supplied working_dir (e.g. "New console"
        # FAB sends "~"). tmux's -c <dir> doesn't expand tildes, and
        # SessionManager/Path.expanduser is the canonical resolution point.
        if body.working_dir:
            body.working_dir = os.path.expanduser(body.working_dir)

        # A NEW project with a chosen parent folder. This is the only path
        # that composes a directory from a name, and it exists because the
        # "start empty" flow had no folder step: it posted a name and
        # nothing else, so session_manager fell through to
        # ``settings.get_working_dir() / session_id`` and the project
        # landed at ``.../ses_5a756046`` - a random session id, recorded
        # in the SHORT symlink spelling. resolve_project_directory returns
        # the realpath'd (long) parent joined to the name, or refuses with
        # a sentence the modal shows inline; a refusal is a 400 and
        # creates nothing.
        if body.project_parent_dir:
            from src.core.project_directory import (
                ensure_project_directory,
                resolve_project_directory,
            )

            verdict = ensure_project_directory(
                resolve_project_directory(
                    body.project_parent_dir,
                    body.project_name or "",
                    settings=settings,
                )
            )
            if not verdict.ok:
                logger.warning(
                    "project_directory_refused",
                    parent_dir=body.project_parent_dir,
                    code=verdict.code,
                )
                raise HTTPException(status_code=400, detail=verdict.message)
            body.working_dir = verdict.path

        logger.info(
            "api_create_session_request",
            session_id=session_id,
            working_dir=body.working_dir,
            copy_templates=body.copy_templates,
            cols=body.cols,
            rows=body.rows,
            agent_type=body.agent_type,
            model=body.model,
        )

        session = await session_manager.create_session(
            session_id=session_id,
            working_dir=body.working_dir,
            auto_start_claude=body.auto_start_claude,
            copy_templates=body.copy_templates,
            initial_cols=body.cols,
            initial_rows=body.rows,
            project_name=body.project_name,
            agent_type=body.agent_type,
            model=body.model,
            terminal_command_id=body.terminal_command_id,
            # ONE NAME, SET AT BIRTH. This endpoint was the only creator
            # that passed no label, so a launchpad session's row title and
            # the name claude called itself were unrelated strings. An
            # absent or blank label changes nothing about the launch.
            label=(body.label or "").strip() or None,
        )

        # Mark this project most-recently-used so it sorts to the top of
        # the launcher. feat/db-is-authoritative: this writes
        # projects.last_opened_at in the AUTHORITATIVE table and then
        # refreshes the config.json rollback snapshot, replacing the old
        # config-array reorder. Best-effort, exactly as before - a
        # session must never fail to start because the launcher's
        # ordering could not be updated - but a datastore that could not
        # be reached is now logged as its own case rather than being
        # swallowed with a genuine "no project at this path" miss.
        if session.working_dir:
            from src.api import projects_service

            projects_service.touch_project_best_effort(
                settings, session.working_dir
            )

        # THE SHAPE OF THE LIST CHANGED, so say re-read. The structural
        # notice carries NO data on purpose - a notice with a payload
        # becomes a second source of truth for the session list and
        # drifts from /sessions/list, while one that says re-read cannot.
        # It never awaits and never raises, and it is an OPTIMISATION
        # over the five second reconciliation poll, which is untouched:
        # a session someone starts by hand on the cloude socket produces
        # no notice at all and is still picked up on the next pass.
        session_change_notice.publish(
            request.app.state,
            session_change_notice.build_structural_notice("created"),
        )

        return session

    except HTTPException:
        # An HTTPException we raised ourselves (the project-directory
        # refusal above) is already the answer. Without this clause the
        # blanket handler below would catch it - HTTPException IS an
        # Exception - and re-wrap a deliberate 400 with a clear message as
        # a generic 500, hiding the reason from the user entirely.
        raise
    except ValueError as e:
        logger.error("session_creation_failed_validation", error=str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        # SessionManager.create_session re-raises RuntimeError verbatim for
        # backend infrastructure failures - tmux missing, new-session exec
        # error, or (most importantly) the dead-on-arrival agent probe in
        # TmuxBackend.start() catching a child that exited before writing
        # a byte. 502 Bad Gateway is the right semantic: our upstream (the
        # agent CLI / tmux subsystem) failed, this isn't a client mistake
        # (400) nor a generic server bug (500). The original message
        # ("agent failed to launch: ...") is forwarded as the detail so
        # the launchpad's catch can surface it directly to the user.
        logger.error("session_creation_failed_backend", error=str(e))
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.error("session_creation_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to create session: {str(e)}")


@router.get("/sessions", response_model=SessionInfo, dependencies=[Depends(require_auth)])
async def get_session(
    request: Request,
    session_id: Optional[str] = None,
    include_scrollback: bool = False,
    cols: Optional[int] = None,
    rows: Optional[int] = None,
):
    """
    Get information about a session.

    ``session_id`` (query, optional) selects a specific session; omitted
    returns the current (most-recently-created) one. Back-compat: existing
    clients call ``GET /sessions`` with no params and get "the" session.

    ``include_scrollback`` (query, optional, default False) - when True
    and the resolved session has a live tmux backend, the response's
    ``initial_scrollback_b64`` field is populated with base64-encoded
    pane-capture bytes. Used by the launchpad's "return to running
    session" path so the client can paint pre-existing history into
    xterm before the WS opens, mirroring the adopt path. Off by default
    so existing callers see no change.

    ``cols`` / ``rows`` (query, optional) - when ``include_scrollback`` is
    True AND both are positive ints, the pane is pre-resized to the
    client's xterm geometry BEFORE the capture call. ``tmux capture-pane``
    snapshots at the pane's CURRENT width, which is whatever the most-
    recent attached client set it to. Without this pre-resize, a mobile
    client (~80 cols) rejoining a session whose pane was last sized by a
    desktop client (~144 cols) gets desktop-width scrollback bytes that
    xterm paints at mobile width - the upper/older history reflows into
    garbled rows. Forcing tmux to re-render at the client's true width
    eliminates that mismatch. The subsequent WS-handshake resize becomes
    a no-op (same dims) on this client; other attached clients see a
    window-event and negotiate to their own width on their own handshake.

    Raises:
        HTTPException: 404 if the requested (or current) session doesn't exist
    """
    session_manager = request.app.state.session_manager

    session_info = await session_manager.get_session_info(session_id=session_id)

    if not session_info:
        raise HTTPException(status_code=404, detail="No active session")

    if include_scrollback:
        # Resolve the id we actually loaded info for - when session_id was
        # omitted, get_session_info returned the "current" session; we need
        # the same canonical id for the capture call so we don't reach for
        # a different backend.
        resolved_sid = session_info.session.id

        # Pre-resize the pane to the client's current xterm geometry so the
        # captured bytes are emitted at the same width xterm will render
        # them at. Without this, scrollback for a desktop-width session
        # rejoined from a mobile-width client (or any width mismatch)
        # paints with reflow artifacts. resize_terminal is sync + no-ops
        # when the session/backend isn't live, so it's safe to call
        # unconditionally whenever cols/rows look sane.
        if cols and rows and cols > 0 and rows > 0:
            try:
                session_manager.resize_terminal(
                    cols=cols, rows=rows, session_id=resolved_sid
                )
            except Exception as exc:
                logger.warning(
                    "rejoin_pre_resize_failed",
                    session_id=resolved_sid,
                    cols=cols,
                    rows=rows,
                    error=str(exc),
                )

        try:
            # Mirror the depth used elsewhere (see SessionManager.adopt
            # path) so rejoin and adopt paint the same amount of history.
            lines = settings.load_auth_config().session.scrollback_lines
            raw = session_manager.capture_scrollback(
                lines=lines,
                session_id=resolved_sid,
            )
            if raw:
                session_info.initial_scrollback_b64 = base64.b64encode(raw).decode("ascii")
        except Exception as exc:
            # Non-fatal. Leave the field as default None so the client
            # falls through to a clean-screen rejoin (still functional;
            # just no pre-paint of history).
            logger.warning(
                "rejoin_scrollback_capture_failed",
                session_id=resolved_sid,
                error=str(exc),
            )

    return session_info


@router.get(
    "/sessions/list",
    response_model=List[SessionInfo],
    dependencies=[Depends(require_auth)],
)
async def list_sessions(request: Request):
    """List ALL live sessions (oldest first).

    Multi-session: two browser tabs can each be attached to a different
    session. The launchpad's "Running Sessions" list uses this to surface
    every owned-and-live session (in addition to ``/sessions/attachable``
    for external/detached ones).
    """
    session_manager = request.app.state.session_manager
    if hasattr(session_manager, "list_session_infos"):
        # COALESCED, because fifteen pollers were each paying for a full
        # synchronous pass to receive an identical answer and the passes
        # overlapped almost continuously. A caller arriving while a pass
        # is in flight awaits THAT pass; a caller arriving after one
        # finishes gets a fresh one, because a cached list would paint a
        # dead session alive. See src/core/single_flight.py.
        flight = single_flight.flight_on(
            session_manager,
            single_flight.SESSION_LIST_FLIGHT_ATTR,
            single_flight.SESSION_LIST_FLIGHT_NAME,
        )
        return await flight.run(session_manager.list_session_infos)
    # Defensive: a single-session manager shim.
    one = await session_manager.get_session_info()
    return [one] if one else []


async def _mark_closed_in_datastore(
    socket: Optional[str], name: Optional[str]
) -> int:
    """Write the just-closed tmux instance's row to ``stopped``.

    Description: the datastore half of ``DELETE /sessions``. Runs on one
      pooled thread (connections are thread-affine) and swallows only the
      two datastore conditions that are not this request's business - an
      install with no database yet, and one whose database cannot be read
      - because the session is already destroyed by the time this runs
      and a bookkeeping failure must not be reported as a failed
      teardown. Both are logged; neither is silent.
    Inputs: socket (str | None) - the tmux socket that was torn down.
      name (str | None) - the tmux session name that was killed. Either
      being None means the backend could not name what it closed, and
      nothing is written.
    Output: int - rows moved to ``stopped``; 0 when nothing was written.
    Example: await _mark_closed_in_datastore('cloude', 'cloude_api')
    """
    from contextlib import closing

    from src.core import session_close_lifecycle
    from src.core.db import DatastoreUnreadableError, connect, db_path_for

    if not socket or not name:
        return 0
    db_path = db_path_for(settings.get_state_dir())
    if not db_path.exists():
        return 0

    def _write() -> int:
        with closing(connect(db_path, create=False)) as conn:
            moved = session_close_lifecycle.mark_closed(
                conn, socket=socket, name=name
            )
            conn.commit()
            return moved

    try:
        return await run_in_threadpool(_write)
    except DatastoreUnreadableError as exc:
        logger.warning(
            "close_lifecycle_not_recorded",
            tmux_socket=socket,
            tmux_name=name,
            error=str(exc),
            note=(
                "the session WAS destroyed; only the row's lifecycle "
                "write did not land, and the reconciler still covers it"
            ),
        )
        return 0


@router.delete("/sessions", response_model=SuccessResponse, dependencies=[Depends(require_auth)])
async def destroy_session(request: Request, session_id: Optional[str] = None):
    """
    Destroy a session (kill its backend / tmux).

    ``session_id`` (query, optional) selects which session; omitted destroys
    the current one. Other live sessions are untouched.

    Raises:
        HTTPException: 404 if the session doesn't exist, 500 on teardown error
    """
    session_manager = request.app.state.session_manager
    local_servers = request.app.state.local_servers

    try:
        logger.info("api_destroy_session_request", session_id=session_id)

        # Drop any local-server detections owned by THIS session before
        # tearing it down. Best-effort: look up the backend's tmux name
        # (the key local_servers tracks entries under) and clear it.
        registry = request.app.state.services.registry
        backend = (
            registry.get_backend(session_id)
            if session_id
            else registry.current_backend()
        )
        active_name = (
            getattr(backend, "tmux_session", None) if backend else None
        )
        active_socket = (
            getattr(backend, "socket_name", None) if backend else None
        )
        if active_name:
            await local_servers.clear_session(active_name)

        # Destroy session
        await session_manager.destroy_session(session_id=session_id)

        # RECORD THE CLOSE ON THE ROW, NOW. destroy_session writes nothing
        # to sessions.lifecycle - only the background reconciler ever moved
        # a row to 'stopped' - so a closed session read 'running' for up to
        # a whole poll interval and appeared in NO group the user could
        # see: gone from running (its tmux is dead) and not yet in RECENT
        # (which is lifecycle='stopped' AND archived_at IS NULL). That gap
        # is "I closed it and it did not go to Recents", measured on the
        # owner's box 2026-09-07.
        #
        # Best-effort and non-fatal: the session IS destroyed by this
        # point, and failing the request over a bookkeeping write would
        # tell the user a teardown failed that did not. The reconciler
        # still covers the row on its own schedule.
        await _mark_closed_in_datastore(active_socket, active_name)

        # Same structural notice as the create path, same reasoning: the
        # list lost a row, so every screen holding one re-reads now
        # rather than on its next poll boundary.
        session_change_notice.publish(
            request.app.state,
            session_change_notice.build_structural_notice("destroyed"),
        )

        return SuccessResponse(message="Session destroyed successfully")

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("session_destruction_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to destroy session: {str(e)}")


@router.post(
    "/sessions/detach",
    response_model=SuccessResponse,
    dependencies=[Depends(require_auth)],
)
async def detach_session(request: Request, session_id: Optional[str] = None):
    """Detach from a session WITHOUT killing tmux.

    Soft counterpart to ``DELETE /sessions`` - tears down the server-side
    backend refs (reader task, idle watcher, our pipe-pane) for THAT session
    while leaving the tmux session alive. ``session_id`` (query, optional)
    selects which session; omitted detaches the current one. Other live
    sessions are untouched.

    Returns 404 when the session isn't active. Other failures propagate as 500.
    """
    session_manager = request.app.state.session_manager

    logger.info("api_detach_session_request", session_id=session_id)

    detached = await session_manager.detach_current_session(session_id=session_id)
    if not detached:
        raise HTTPException(status_code=404, detail="No active session to detach")

    return SuccessResponse(message="Session detached")
