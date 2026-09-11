"""Restart a stored session onto its own conversation.

``POST /sessions/{session_uuid}/restart`` is addressed by the durable
``session_uuid``, never by the tmux name: a name is reusable and this app
re-mints them, so "the newest row with this name" is a recency guess and
a wrong answer rebinds a DIFFERENT session's row. The rungs, the
transcript guard and the three conversation words all live in
``src/core/session_respawn.py`` and its neighbours; this module is the
HTTP seam over them.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from src.api.auth import require_auth
from src.config import settings
from src.core.session_label import sanitize_tmux_name
from src.models import RestartSessionResponse

logger = structlog.get_logger()
router = APIRouter()


@router.post(
    "/sessions/{session_uuid}/restart",
    response_model=RestartSessionResponse,
    status_code=201,
    dependencies=[Depends(require_auth)],
)
async def restart_session(request: Request, session_uuid: str):
    """Bring a STOPPED session back on a new tmux instance, same record.

    Description: the launchpad's RESTART control. It spawns a NEW tmux
      session - it cannot do anything else, because the old pane is gone
      and the new one necessarily gets a new ``#{session_created}`` - but
      it does NOT create a new session record. The existing row is moved
      onto the new tmux instance in place, so the session keeps its
      ``sessions.id`` and ``session_uuid`` and, with them, its TITLE, its
      working directory, its agent and model, its Claude CONVERSATION
      (continued with a bare ``--resume <uuid>``), its group membership
      and everything that references it. See
      src/core/session_restart.py: rebind_instance for why that is safe,
      and resume_arguments for why the fork flag is gone.

      ONE SESSION, ONE ROW, ONE LIST ENTRY. Inserting a second row was
      what left an abandoned twin holding the user's title and
      conversation while the live session wore a copy of the name, which
      is what doubled the session list on every restart.

      KEYED ON ``session_uuid``, NOT ON THE TMUX NAME. A tmux name is
      reusable and this app re-mints them; resolving a stopped session by
      name could match a LIVE session that took the name afterwards.

      FOUR OUTCOMES, and the two middle ones are why this is not a bare
      create:
        404  no row with this ``session_uuid`` - could not evaluate.
        409  the row NAMES a conversation and that conversation is not in
             the transcript corpus. Nothing is spawned. Resuming it would
             produce a pane that exits immediately while the row read
             ``running``, which is how the owner lost a session on
             2026-09-07.
        201, ``conversation='resumed'`` - the old conversation continues.
        201, ``conversation='none_recorded'`` - the row never learned a
             Claude session uuid. The session still comes back, carrying
             the name/dir/agent, and the response SAYS it is a new
             conversation. Never presented as a resume.

      ``row_reused`` is reported separately and is read back from the row
      itself rather than taken from the create path's own report.
    Inputs: session_uuid (str) - the stopped row's durable identity.
    Output: RestartSessionResponse.
    """
    from contextlib import closing

    from src.core import session_restart
    from src.core.db import DatastoreUnreadableError, connect, db_path_for

    session_manager = request.app.state.session_manager
    db_path = db_path_for(settings.get_state_dir())

    if not db_path.exists():
        raise HTTPException(
            status_code=404,
            detail="no datastore yet, so there is no session to restart",
        )

    def _resolve():
        """Read the replaced row on one pooled thread."""
        with closing(connect(db_path, create=False)) as conn:
            return session_restart.resolve_restart_source(
                conn, session_uuid=session_uuid
            )

    try:
        source = await run_in_threadpool(_resolve)
    except DatastoreUnreadableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    if source.outcome == session_restart.RESTART_UNRESOLVED:
        raise HTTPException(
            status_code=404, detail=source.detail or "session not found"
        )

    if source.outcome == session_restart.RESTART_CONVERSATION_MISSING:
        # REFUSE, LOUDLY, AND SPAWN NOTHING. The row names a conversation
        # whose transcript is gone, so `claude --resume` would exit on its
        # first tick and hand tmux a corpse - which this route used to
        # answer 201 conversation='resumed' over, and rebind_instance had
        # already stamped `lifecycle='running'` on the row. The owner then
        # had a session that read running, showed nothing, and could not
        # be found anywhere (2026-09-07).
        #
        # 409, not 500: nothing failed. The server looked, and the thing
        # being asked for is not there. Starting a BLANK session under the
        # name of the conversation the user believes is being continued is
        # the one outcome that must never happen here - it is silent data
        # loss wearing a familiar title.
        logger.warning(
            "restart_refused_conversation_missing",
            replaced_session_uuid=session_uuid,
            replaced_session_id=source.parent_id,
            conversation_row_id=source.conversation_row_id,
            claude_session_uuid=source.claude_session_uuid,
        )
        raise HTTPException(
            status_code=409,
            detail=(
                source.detail
                or "the conversation this session names is not on disk"
            ),
        )

    resumable = source.outcome == session_restart.RESTART_RESUMABLE
    label = (source.title or "").strip() or None
    # THE LABEL AND THE TMUX NAME ARE NOT THE SAME STRING - see the same
    # comment on the fork route. The label is what a human reads; the tmux
    # name is also the URL segment and the client router rejects anything
    # outside /^[A-Za-z0-9_\- ]+$/. A title with a bracket in it would
    # create fine and then be unreachable.
    tmux_safe_name = (sanitize_tmux_name(label) or None) if label else None

    logger.info(
        "api_restart_session_request",
        replaced_session_uuid=session_uuid,
        replaced_session_id=source.parent_id,
        conversation="resumed" if resumable else "none_recorded",
        conversation_row_id=source.conversation_row_id,
        label=label,
    )

    import uuid as _uuid

    try:
        child = await session_manager.create_session(
            session_id=f"ses_{_uuid.uuid4().hex[:8]}",
            working_dir=source.working_dir,
            project_name=tmux_safe_name,
            agent_type=source.agent_type,
            model=source.model,
            # RESUME ONLY WHEN THERE IS SOMETHING TO RESUME. An empty list
            # here is the whole difference between the two success
            # outcomes, and it is derived from a measured column rather
            # than from a client's claim.
            agent_extra_args=(
                session_restart.resume_arguments(source.claude_session_uuid)
                if resumable else None
            ),
            label=label,
            # ONE SESSION, ONE ROW. The restarted session keeps the row it
            # already had - see session_restart.rebind_instance. This is
            # what stops a restart from leaving an abandoned twin behind
            # and doubling the session list.
            reuse_session_id=source.parent_id,
        )
    except Exception as exc:
        logger.warning(
            "restart_create_failed",
            replaced_session_uuid=session_uuid,
            label=label,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=500,
            detail=f"could not create the replacement session: {exc}",
        )

    child_tmux = getattr(child, "tmux_session", None)

    def _verify_reuse():
        """Did the row actually come back on the new tmux instance?

        Read back INDEPENDENTLY rather than trusting the create path's
        own report: this asks the row whether it now carries the new
        tmux name and is running, which is the thing the user cares
        about, not whether a function said it wrote it.
        """
        with closing(connect(db_path, create=False)) as conn:
            row = conn.execute(
                "SELECT tmux_name, lifecycle FROM sessions WHERE id = ? "
                "LIMIT 1",
                (source.parent_id,),
            ).fetchone()
            if row is None:
                return False
            return (
                row["tmux_name"] == child_tmux
                and row["lifecycle"] == "running"
            )

    reused = False
    detail = source.detail if not resumable else None
    try:
        reused = bool(await run_in_threadpool(_verify_reuse))
    except DatastoreUnreadableError as exc:
        # THE SESSION EXISTS AND WORKS. Say so, and say we could not
        # confirm the row was reused - never report this as a failed
        # restart, and never as a clean success either.
        note = (
            f"the session was restarted, but whether it kept its "
            f"original record could not be confirmed: {exc}"
        )
        detail = f"{detail} {note}" if detail else note
    else:
        if not reused:
            note = (
                "the session was restarted, but it could not keep its "
                "original record and now has a separate one; it works, "
                "and it may appear as a second entry"
            )
            detail = f"{detail} {note}" if detail else note

    return RestartSessionResponse(
        success=True,
        session=child.model_dump() if hasattr(child, "model_dump") else {},
        conversation="resumed" if resumable else "none_recorded",
        replaced_session_id=source.parent_id,
        row_reused=reused,
        title_carried=label,
        detail=detail,
    )
