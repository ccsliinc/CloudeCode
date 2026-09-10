"""Preview and perform a RECREATE for a session whose tmux is gone.

``GET /sessions/restart/preview`` and ``POST /sessions/respawn`` both
read a PANE. A session whose tmux session was killed outright, or whose
tmux server was restarted, has no pane to read, so the respawn ladder
answers ``cannot_determine`` and the picker correctly offers nothing.
That is honest and it is also a dead end: the only path left was to build
a fresh session by hand, which loses the row, and with it the project
binding, the title, the pinned theme, the unread key and the group
filing.

These two endpoints are the path that CAN reach it. They are their own
routes rather than a mode on the existing pair because every gate
differs: the pane path asks "what would respawning this pane do", gated
on ``#{pane_dead}`` and ``#{pane_start_command}``; this asks "is this
session's tmux still there at all, and if not, what would recreating it
run", gated on a socket LISTING and on whether the transcript is still on
disk. Folding them together would put four inapplicable gates in front of
a path that has none of them and a caller could not tell which set it was
subject to.

THE RESPONSE SHAPE IS THE SAME ON PURPOSE. The preview returns
``RestartPreviewResponse``, the model the picker already renders, so a
client needs a second URL and not a second renderer.

ADDRESSED BY ``session_uuid``, NOT BY TMUX NAME, and that is not a
preference. A tmux name is reusable and this app re-mints them, so
"the newest row carrying this name" is a recency GUESS rather than an
identity - the exact class ``tests/test_no_name_keyed_session_identity.py``
exists to keep out of new code. It caught the first draft of this module
doing it. A wrong answer here would rebind a DIFFERENT session's row onto
a tmux session it has nothing to do with, so this path takes the durable
key, the same one ``src/api/imported_restart_routes.py`` takes, and the
tmux NAME it acts on is read off the row rather than supplied by the
caller.

MOUNTED THROUGH ``src/api/restart_routes.py`` rather than from
``src/main.py``: the two are one feature surface, and the router include
list in main.py is already the longest thing in that file.

NOTHING HERE DECIDES ANYTHING. Every rule lives in
``src/core/session_recreate.py`` and ``src/core/session_recreate_presence.py``;
this module reads the socket and the row, calls the validators, and
translates outcomes into HTTP.
"""

from __future__ import annotations

from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from src.api.auth import require_auth
from src.core.db import DatastoreUnreadableError, connect, db_path_for
from src.core.session_agent_choice import (
    resolve_wrapper_offers,
    validate_agent_choice,
)
from src.core.session_imported_restart import (
    imported_extra_args,
    resume_directory,
)
from src.core.session_recreate import RECREATE, plan_recreate
from src.core.session_recreate_presence import (
    TMUX_UNKNOWN,
    TmuxPresence,
    pane_state_for,
    tmux_presence,
)
from src.models import (
    RestartPlanPreview,
    RestartPreviewOption,
    RestartPreviewResponse,
)

logger = structlog.get_logger()

router = APIRouter(tags=["sessions"])


class RecreateRequest(BaseModel):
    """Recreate one dead session under a chosen wrapper.

    ``agent_type`` is REQUIRED and there is no unpicked path. A pane at
    least has a recorded ``#{pane_start_command}`` to fall back on; a
    session whose tmux is gone has nothing, so an unpicked recreate could
    only ever hand back a bare login shell - the exact outcome the pane
    path's whole warning apparatus exists to stop a user walking into.
    Rather than warn about it, this refuses to offer it.
    """

    session_uuid: str = Field(..., description="sessions.session_uuid")
    agent_type: str = Field(..., description="wrapper id from the preview")


class RecreateResponse(BaseModel):
    """What the recreate did, or why it did nothing."""

    status: str = Field(
        ...,
        description=(
            "'started' when a new tmux session was created on this "
            "session's existing row, 'refused' when a gate declined. A "
            "refusal is a 200 with this field, never a silent success"
        ),
    )
    session_uuid: str = Field(..., description="the row that was acted on")
    session_name: Optional[str] = Field(
        None,
        description=(
            "the tmux name the row carries, read from the record rather "
            "than supplied by the caller"
        ),
    )
    session_id: Optional[str] = Field(
        None, description="the live session id, on 'started' only"
    )
    tmux_session: Optional[str] = Field(
        None,
        description=(
            "the tmux name actually taken. The SAME name is asked for so "
            "name-scoped per-device state survives, but the create path "
            "uniquifies on collision, so this is reported rather than "
            "assumed"
        ),
    )
    presence: str = Field(
        ...,
        description=(
            "'gone' | 'present' | 'unknown' - the socket measurement the "
            "decision was gated on. Only 'gone' can act"
        ),
    )
    conversation: str = Field(
        ...,
        description=(
            "'resumed' | 'none_recorded' | 'unknown', derived from the "
            "argv actually run so the claim cannot outrun the command"
        ),
    )
    command: Optional[str] = Field(None, description="what was run")
    working_dir: Optional[str] = Field(
        None, description="the spelling the session was created in"
    )
    detail: str = Field("", description="one sentence, fit to show verbatim")


def _db_path() -> Path:
    """Where this install's datastore lives.

    Inputs: none. Output: pathlib.Path.
    """
    from src.config import settings

    return db_path_for(settings.get_state_dir())


def _socket_name() -> str:
    """The tmux socket this install's sessions live on.

    Description: the same read ``SessionManager.restart_preview`` does,
      with the same fallback. A wrong socket here would list somebody
      else's tmux server and measure absence against it.
    Inputs: none. Output: str.
    """
    from src.config import settings
    from src.core.tmux_backend import DEFAULT_SOCKET_NAME

    try:
        return settings.load_auth_config().session.tmux_socket_name
    except (OSError, ValueError, AttributeError):
        return DEFAULT_SOCKET_NAME


def _measure_presence(name: str, socket_name: str) -> TmuxPresence:
    """Is this tmux session still on our socket? One listing, three answers.

    Description: builds a throwaway external handle purely to issue
      ``discover_existing()`` - a READ - and classifies its answer
      through the pure gate. Nothing is spawned, adopted or written.

      NEVER RAISES. A handle that could not be built at all is
      :data:`TMUX_UNKNOWN`, because this runs on a request path and an
      exception here would take the picker down over a socket it could
      not reach - and unknown already refuses.
    Inputs: name (str) - literal tmux session name. socket_name (str).
    Output: TmuxPresence.
    Example: _measure_presence('cloude_api', 'cloude').outcome  # 'gone'
    """
    from src.config import settings
    from src.core.tmux_backend import SESSION_PREFIX, TmuxBackend

    try:
        probe = TmuxBackend.for_external(
            session_name=name,
            working_dir=Path(settings.default_working_dir).expanduser(),
            on_output=None,
            socket_name=socket_name,
        )
        listing = probe.discover_existing()
    except (OSError, ValueError, AttributeError) as exc:
        logger.warning("recreate_presence_unmeasured", name=name, error=str(exc))
        return TmuxPresence(
            outcome=TMUX_UNKNOWN,
            detail=(
                "the tmux socket could not be listed, so whether this "
                "session is still running was not evaluated"
            ),
        )
    return tmux_presence(
        name,
        listing_ok=bool(listing.ok),
        listing_complete=bool(listing.complete),
        names=list(listing.sessions or []),
        namespace_prefix=SESSION_PREFIX,
    )


def _read_row(session_uuid: str) -> Dict[str, Any]:
    """Read one ``sessions`` row by its durable key, on a worker thread.

    Description: returns ``row`` and ``row_read_ok`` rather than a bare
      row, because "the datastore answered and holds no such row" and
      "the datastore could not be read" are different facts and every
      consumer here has to tell them apart.

      KEYED ON ``session_uuid``, NEVER ON THE TMUX NAME. A name is
      reusable and this app re-mints them, so resolving by name plus
      recency would let a recreate rebind the wrong session's row. The
      name this path acts on is read OFF the row it resolves.
    Inputs: session_uuid (str).
    Output: dict - ``{'row': dict|None, 'row_read_ok': bool}``.
    """
    try:
        with closing(connect(_db_path(), create=False)) as conn:
            found = conn.execute(
                "SELECT * FROM sessions WHERE session_uuid = ?", (session_uuid,)
            ).fetchone()
    except (DatastoreUnreadableError, OSError) as exc:
        logger.warning(
            "recreate_row_unreadable", session_uuid=session_uuid, error=str(exc)
        )
        return {"row": None, "row_read_ok": False}
    return {"row": dict(found) if found is not None else None, "row_read_ok": True}


def _resolved(state: Dict[str, Any], session_uuid: str) -> Dict[str, Any]:
    """The row, or the right HTTP error.

    Description: a row with NO tmux identity is a 409 and not a 404 - it
      exists, and the caller used the wrong endpoint for it. Saying "not
      found" would send them looking for a row that is right there.
    Inputs: state (dict) - from :func:`_read_row`. session_uuid (str).
    Output: dict - the row.
    Raises: HTTPException 404, 409, 503.
    """
    from src.core.session_recreate import has_tmux_identity

    if not state["row_read_ok"]:
        raise HTTPException(
            status_code=503,
            detail=(
                "the datastore could not be read, so this session's "
                "recreate could not be evaluated"
            ),
        )
    row = state["row"]
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"no session carries the uuid {session_uuid!r}"
        )
    if not has_tmux_identity(row):
        raise HTTPException(
            status_code=409,
            detail=(
                f"session {session_uuid!r} has never had a tmux session, so "
                "it restarts through GET /sessions/imported/restart/preview "
                "and POST /sessions/imported/restart"
            ),
        )
    return row


def _gather(session_uuid: str) -> Dict[str, Any]:
    """Every measurement both endpoints need, taken once. On worker threads.

    Description: the row, then presence, then the ``--resume`` fragment
      and the directory spelling. Taken in ONE place so the preview and
      the action answer questions about the same observed state - a
      preview measured differently from the action is how a badge and a
      button drift apart.

      THE TMUX NAME COMES OFF THE ROW. The caller supplies a durable
      uuid and nothing else, so there is no way for a request to point
      the socket measurement at a name the record does not carry.
    Inputs: session_uuid (str).
    Output: dict with ``row``, ``name``, ``presence``, ``extra_args``,
      ``directory``, ``socket``.
    Raises: HTTPException 400, 404, 409, 503.
    """
    row = _resolved(_read_row(session_uuid), session_uuid)
    socket_name = str(row.get("tmux_socket") or _socket_name())
    name = _safe(str(row.get("tmux_name") or ""))
    presence = _measure_presence(name, socket_name)
    extra_args = imported_extra_args(row, row_read_ok=True)
    directory = resume_directory(
        row.get("working_dir"), row.get("claude_session_uuid")
    )
    return {
        "row": row,
        "name": name,
        "presence": presence,
        "extra_args": extra_args,
        "directory": directory,
        "socket": socket_name,
    }


def _safe(name: str) -> str:
    """Refuse a name tmux would read as a window/pane target.

    Description: the SAME ``_safe_target`` rule the action and the
      existing preview apply, so a name refused there is refused here.
    Inputs: name (str). Output: str - the name.
    Raises: HTTPException 400.
    """
    from src.core.tmux_backend import _safe_target

    try:
        return _safe_target(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get(
    "/sessions/recreate/preview",
    response_model=RestartPreviewResponse,
    dependencies=[Depends(require_auth)],
)
async def recreate_preview(
    session_uuid: str = Query(..., description="sessions.session_uuid"),
) -> RestartPreviewResponse:
    """What recreating this session would do, changing nothing.

    Description: one socket listing, one row read, one directory
      measurement, one config read, and the SAME ``plan_recreate`` the
      action runs - once with nothing picked and once per configured
      wrapper. Every offer is resolved with the SAME ``--resume``
      fragment the action will pass, so the command shown and the command
      run are one string by construction.

      ``pane_state`` reports the socket measurement in the model's own
      three words, so a session measured PRESENT paints ``alive`` and
      every option arrives ``actionable_now=False``. A recreate is never
      offered over a running agent, and the refusal is a sentence rather
      than a missing button.
    Raises: HTTPException 400 (the row carries a name tmux would misread
      as a target), 404 (no such record), 409 (the row never had a tmux
      session), 503 (datastore unreadable).
    """
    from src.config import settings

    facts = await run_in_threadpool(_gather, session_uuid)
    row = facts["row"]
    name = facts["name"]
    presence: TmuxPresence = facts["presence"]

    offers = resolve_wrapper_offers(
        settings, model=row.get("model"), extra_args=facts["extra_args"]
    )

    unchanged = plan_recreate(
        row,
        row_read_ok=True,
        presence=presence,
        choice_verdict=None,
        choice_command=None,
        choice_detail=(
            "a session whose tmux is gone has no recorded start command "
            "left to fall back on, so there is nothing to run until a "
            "wrapper is picked"
        ),
        directory=facts["directory"],
    )

    options: List[RestartPreviewOption] = []
    for offer in offers or []:
        choice = validate_agent_choice(
            settings,
            offer.agent_type,
            model=row.get("model"),
            extra_args=facts["extra_args"],
        )
        plan = plan_recreate(
            row,
            row_read_ok=True,
            presence=presence,
            choice_verdict=choice.verdict,
            choice_command=choice.command,
            choice_detail=choice.detail,
            agent_type=offer.agent_type,
            directory=facts["directory"],
        )
        options.append(
            RestartPreviewOption(
                agent_type=offer.agent_type,
                label=offer.label,
                is_current=offer.agent_type == row.get("agent_type"),
                resolvable=bool(offer.command),
                actionable_now=plan.actionable,
                kind=plan.kind,
                detail=plan.detail,
                # A PREDICTION IS NEVER A PERMISSION, and here the two
                # genuinely coincide: this path has no liveness gate to
                # look past, because presence IS its gate. Reporting the
                # same rung twice is the honest answer, not a shortcut -
                # there is no second, rosier outcome being withheld.
                projected_kind=plan.kind,
                projected_detail=plan.detail,
                command=plan.command,
                conversation=plan.conversation,
            )
        )

    preview_plan = RestartPlanPreview(
        kind=unchanged.kind,
        detail=unchanged.detail,
        command=None,
        actionable=False,
        conversation=unchanged.conversation,
    )
    logger.info(
        "recreate_preview",
        name=name,
        presence=presence.outcome,
        listed=presence.listed,
        offers=len(offers) if offers is not None else None,
        conversation=unchanged.conversation,
    )
    return RestartPreviewResponse(
        name=str(row.get("title") or name),
        current_agent_type=row.get("agent_type"),
        pane_state=pane_state_for(presence),
        unchanged=preview_plan,
        projected=preview_plan,
        options=options,
        wrappers_status="unavailable" if offers is None else "ok",
    )


@router.post(
    "/sessions/recreate",
    response_model=RecreateResponse,
    dependencies=[Depends(require_auth)],
)
async def recreate_session(
    request: Request, body: RecreateRequest
) -> RecreateResponse:
    """Create a new tmux session for a dead one, on the row it already has.

    Description: A RESTART MEANS A RESUME. There is no pane to respawn
      into, so this creates a session - in the spelling of the working
      directory that actually holds the transcript, under the wrapper the
      caller picked, with ``--resume <uuid>`` - and ``reuse_session_id``
      records the new tmux instance ONTO the existing row through
      ``session_restart.rebind_instance``. The row keeps its
      ``sessions.id`` and ``session_uuid``, so the project binding, the
      title, the conversation link, the pinned theme, the unread key and
      the v24 group membership all ride along untouched.

      THE SAME TMUX NAME IS ASKED FOR so name-scoped per-device browser
      state survives, and it is free by construction: the gate only
      passes when that name was measured ABSENT from the socket. The
      create path's own uniquify-on-collision rule still applies against
      records this app holds, so the name actually taken is REPORTED
      rather than assumed.

      A REFUSAL IS A 200 WITH ``status='refused'``, matching both other
      restart paths: the SERVER worked and a GATE declined, and a 500
      would blame the server for a state it correctly detected.
    Raises: HTTPException 400, 404, 409, 503, and 500 only on a genuine
      fault.
    """
    from src.config import settings

    facts = await run_in_threadpool(_gather, body.session_uuid)
    row = facts["row"]
    name = facts["name"]
    presence: TmuxPresence = facts["presence"]
    session_uuid = str(row.get("session_uuid"))

    choice = validate_agent_choice(
        settings,
        body.agent_type,
        model=row.get("model"),
        extra_args=facts["extra_args"],
    )
    plan = plan_recreate(
        row,
        row_read_ok=True,
        presence=presence,
        choice_verdict=choice.verdict,
        choice_command=choice.command,
        choice_detail=choice.detail,
        agent_type=body.agent_type,
        directory=facts["directory"],
    )
    if plan.kind != RECREATE or not plan.actionable:
        logger.info(
            "recreate_refused",
            name=name,
            session_uuid=session_uuid,
            presence=presence.outcome,
            kind=plan.kind,
        )
        return RecreateResponse(
            status="refused",
            session_uuid=session_uuid,
            session_name=name,
            presence=plan.presence,
            conversation=plan.conversation,
            command=plan.command,
            working_dir=plan.working_dir,
            detail=plan.detail,
        )

    manager = request.app.state.session_manager
    import uuid as _uuid

    try:
        session = await manager.create_session(
            session_id=f"ses_{_uuid.uuid4().hex[:8]}",
            working_dir=plan.working_dir,
            auto_start_claude=True,
            # ASK FOR THE SAME TMUX NAME BACK. create_session strips its
            # own prefix before re-applying it, so handing it the full
            # stored name is idempotent rather than doubled.
            project_name=plan.tmux_name,
            agent_type=body.agent_type,
            model=row.get("model"),
            agent_extra_args=facts["extra_args"],
            label=plan.label,
            reuse_session_id=plan.reuse_session_id,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        logger.error(
            "recreate_failed",
            name=name,
            session_uuid=session_uuid,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=500,
            detail=f"failed to recreate a session for {name!r}: {exc}",
        )

    logger.info(
        "recreate_started",
        name=name,
        session_uuid=session_uuid,
        tmux_session=getattr(session, "tmux_session", None),
        agent_type=body.agent_type,
        conversation=plan.conversation,
    )
    return RecreateResponse(
        status="started",
        session_uuid=session_uuid,
        session_name=name,
        session_id=getattr(session, "id", None),
        tmux_session=getattr(session, "tmux_session", None),
        presence=plan.presence,
        conversation=plan.conversation,
        command=plan.command,
        working_dir=plan.working_dir,
        detail=plan.detail,
    )
