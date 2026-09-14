"""Fork a session onto a new Claude conversation.

``POST /sessions/{session_name}/fork`` starts a second session from an
existing one's conversation. Distinct from a RESTART, which comes back
on the SAME conversation: a fork mints a new conversation uuid, which is
exactly the mechanism that produces the PHANTOM uuid rows CLAUDE.md's
gotcha 5 warns about, so nothing here may assume a recorded uuid has a
transcript behind it.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from src.api.auth import require_auth
from src.config import settings
from src.core import debug_trace
from src.core.session_label import sanitize_tmux_name, set_label_for_instance
from src.models import ForkSessionResponse

logger = structlog.get_logger()
router = APIRouter()


@router.post(
    "/sessions/{session_name}/fork",
    response_model=ForkSessionResponse,
    status_code=201,
    dependencies=[Depends(require_auth)],
)
async def fork_session(request: Request, session_name: str):
    """Fork a running session into a NEW tmux session that branches it.

    Description: spawns a new tmux session running the agent with
      ``--resume <uuid> --fork-session`` against the parent's Claude
      conversation, labels it with ``(fork)`` appended, and records
      ``parent_session_id`` on the CHILD row.

      THE PARENT IS NOT TOUCHED. Not archived, not stopped, not marked. It
      is still running, still listed, still resumable and still forkable
      again. There is no "was forked from" state because the process was
      never touched; the relationship is answered by a reverse lookup on
      ``parent_session_id``. See src/core/session_fork.py.

      THREE OUTCOMES, and the middle one is the point:
        404  no row for this tmux session - could not evaluate.
        409  the session has no recorded Claude conversation, so there is
             nothing to resume. REFUSED rather than forked, because
             forking anyway would start a brand new conversation wearing
             a "(fork)" label and the user would believe they had
             branched their work.
        201  forked. ``lineage_recorded`` says whether the parent link
             actually landed; the tmux session exists either way.
    Inputs: session_name (str) - the PARENT's tmux session name.
    Output: ForkSessionResponse.
    """
    from contextlib import closing

    from src.core import session_fork
    from src.core.db import DatastoreUnreadableError, connect, db_path_for, transaction

    session_manager = request.app.state.session_manager
    # Ask the session manager, never a constant. The socket is overridable
    # (AuthConfig.session.tmux_socket_name) and rows are keyed on it, so a
    # hardcoded "cloude" would look up the wrong session entirely on an
    # install that overrides it - see the same warning at src/main.py:336.
    socket = session_manager.tmux_socket_name()
    db_path = db_path_for(settings.get_state_dir())

    if not db_path.exists():
        raise HTTPException(
            status_code=404,
            detail="no datastore yet, so there is no session to fork from",
        )

    def _resolve():
        """Read the parent row on one pooled thread."""
        with closing(connect(db_path, create=False)) as conn:
            return session_fork.resolve_fork_source(
                conn, socket=socket, tmux_name=session_name
            )

    try:
        source = await run_in_threadpool(_resolve)
    except DatastoreUnreadableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    if source.outcome == session_fork.FORK_UNRESOLVED:
        raise HTTPException(status_code=404, detail=source.detail or "session not found")
    if source.outcome == session_fork.FORK_NO_CONVERSATION:
        raise HTTPException(status_code=409, detail=source.detail or "nothing to resume")

    label = session_fork.fork_label(source.label)
    # THE LABEL AND THE TMUX NAME ARE NOT THE SAME STRING.
    #
    # The label is what a human reads and takes any characters - the
    # owner's stated model: "it's a label, if it needs to rename a session
    # run it through a filter". The TMUX NAME is also the URL segment, and
    # the client router validates it against /^[A-Za-z0-9_\- ]+$/ - no
    # parentheses.
    #
    # Passing the label straight through produced "ScratchLab-4(fork)",
    # which CREATED correctly - row, lineage, tmux session, Claude with its
    # own uuid - and was then UNREACHABLE: the deep link answered "Invalid
    # project name in URL" and clicking the row never attached. A fork you
    # cannot open is not a fork.
    #
    # session_label.sanitize_tmux_name is exactly that filter and already
    # existed with no caller. It yields "ScratchLab-4_fork".
    tmux_safe_name = sanitize_tmux_name(label) or label
    logger.info(
        "api_fork_session_request",
        parent=session_name,
        parent_id=source.parent_id,
        label=label,
    )

    import uuid as _uuid

    debug_trace.trace(
        "fork.creating",
        parent=session_name,
        parent_id=source.parent_id,
        label=label,
        working_dir=source.working_dir,
        agent_type=source.agent_type,
        model=source.model,
    )
    try:
        child = await session_manager.create_session(
            session_id=f"ses_{_uuid.uuid4().hex[:8]}",
            working_dir=source.working_dir,
            project_name=tmux_safe_name,
            agent_type=source.agent_type,
            model=source.model,
            agent_extra_args=session_fork.fork_arguments(source.claude_session_uuid),
            # The fork is born already knowing its own name, so Claude's
            # prompt bar and /resume picker agree with our label from the
            # first frame. The alternative - renaming after the fact -
            # has to type into a live pane and is therefore gated on that
            # pane being idle, which a session that has just launched
            # generally is not.
            label=label,
        )
    except Exception as exc:
        # A BARE 500 IS UNHELPABLE, and this endpoint produced one. The
        # spawn can fail for reasons that are entirely actionable - a name
        # collision, an unwritable working directory, a wrapper that will
        # not resolve - and every one of them arrived at the user as three
        # digits with no body. Say what happened.
        logger.warning(
            "fork_create_failed",
            parent=session_name,
            label=label,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        debug_trace.trace(
            "fork.create_failed",
            parent=session_name,
            label=label,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=500,
            detail=f"could not create the forked session: {exc}",
        )

    child_tmux = getattr(child, "tmux_session", None)

    def _stamp():
        """Record lineage on the child row, in its own transaction."""
        with closing(connect(db_path, create=False)) as conn:
            child_uuid = session_fork.newest_anchor_uuid(
                conn, socket=socket, tmux_name=child_tmux or ""
            )
            if not child_uuid:
                return False
            row = conn.execute(
                "SELECT tmux_created_epoch FROM sessions WHERE session_uuid = ?",
                (child_uuid,),
            ).fetchone()
            child_epoch = row["tmux_created_epoch"] if row else None
            with transaction(conn):
                marked = session_fork.mark_as_fork(
                    conn,
                    child_session_uuid=child_uuid,
                    parent_id=source.parent_id,
                )
                # The human-facing label, carrying "(fork)". The tmux name
                # is the filtered form; this is what the UI shows, so the
                # marker survives without breaking the URL.
                set_label_for_instance(
                    conn,
                    socket=socket,
                    name=child_tmux or "",
                    epoch=child_epoch,
                    label=label,
                )
                return marked

    recorded = False
    detail = None
    try:
        recorded = bool(await run_in_threadpool(_stamp))
    except DatastoreUnreadableError as exc:
        # The tmux session EXISTS. Say so, and say the link did not land -
        # never report this as a failed fork, and never as a clean success.
        detail = f"fork created, but its parent link could not be recorded: {exc}"
        logger.warning("fork_lineage_not_recorded", parent=session_name, error=str(exc))
    if not recorded and detail is None:
        detail = (
            "fork created, but its parent link could not be recorded; the "
            "session works and is simply not linked in the tree"
        )

    return ForkSessionResponse(
        success=True,
        session=child.model_dump() if hasattr(child, "model_dump") else {},
        parent_session_id=source.parent_id,
        lineage_recorded=recorded,
        detail=None if recorded else detail,
    )
