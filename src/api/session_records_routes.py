"""The stored sessions table: list, delete, mute and unarchive a row.

These read the STORED rows, not live process state. A stored row exists
whether or not anything is attached to it, which is the only way a
stopped session can appear anywhere at all.

MUTING ACKNOWLEDGES NOTHING. The notification policy written here
suppresses the INTERRUPTION and never the record: a muted session still
records its hook events, still sets ``permission_open`` and still flips
unread. See ``src/core/hook_toast_gate.py``.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from src.api.auth import require_auth
from src.config import settings
from src.models import (
    MuteNotificationsRequest,
    NotificationPolicyResponse,
    SessionRecord,
    SuccessResponse,
)
from typing import List

from src.api.session_record_payload import _session_record_payload

# MODULE SCOPE, DELIBERATELY. run_in_threadpool was imported inside
# individual handlers, so any NEW handler in the same module that used
# it raised ``NameError: name 'run_in_threadpool' is not defined`` -
# which FastAPI turns into a bare 500 with no body. Two routes shipped
# that way and both failed with three digits and nothing to act on.
# tests/test_route_names_resolve.py fails the build if a module uses
# this name without binding it here.
from fastapi.concurrency import run_in_threadpool

logger = structlog.get_logger()
router = APIRouter()


@router.get(
    "/sessions/records",
    response_model=List[SessionRecord],
    dependencies=[Depends(require_auth)],
)
async def list_session_records(
    request: Request,
    include_automated: bool = Query(
        False,
        description=(
            "Include rows classified kind='automated' - a scheduler run "
            "or a headless `claude -p` probe. DEFAULTS FALSE, because "
            "the owner's rule is 'lists should always just be mine. the "
            "rest can be found in the archive explorer.' There is no UI "
            "for this flag; it exists so a caller that wants the "
            "complete set can ask for it. Rows with kind NULL or "
            "'unknown' are returned EITHER WAY - not having looked is "
            "not evidence of automation. Nothing here affects /archive, "
            "which reads the transcript archive and never this table."
        ),
    ),
):
    """Every stored session row, newest first, archived rows included.

    Description: archived rows are INCLUDED and the caller filters,
      because design section 4.8 makes it a schema-level guarantee that
      archiving never hides a running session - a route that filtered
      here could quietly break that guarantee for the RUNNING group.
    Inputs: request (Request) - unused beyond auth.
    Output: list[SessionRecord] - empty when the datastore is absent or
      has not reached schema v2. That emptiness is reported honestly by
      GET /sessions/import-status, which is where a caller asks whether
      the absence of rows is an answer or a failure.
    Raises: HTTPException 503 - the datastore exists but is unreadable.
    """
    from contextlib import closing


    from src.core import session_store
    from src.core.db import DatastoreUnreadableError, connect, db_path_for

    db_path = db_path_for(settings.get_state_dir())
    if not db_path.exists():
        return []

    def _read() -> list:
        """Open, read and close on ONE pooled thread (connections are
        thread-affine).

        Inputs: none (closes over db_path).
        Output: list[dict] - raw session rows, minus the automated ones
          unless the caller asked for them.
        """
        with closing(connect(db_path, create=False)) as conn:
            return session_store.list_sessions(
                conn, include_automated=include_automated
            )

    try:
        rows = await run_in_threadpool(_read)
    except DatastoreUnreadableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return [_session_record_payload(row) for row in rows]


@router.delete(
    "/sessions/records/{session_uuid}",
    response_model=SuccessResponse,
    dependencies=[Depends(require_auth)],
)
async def delete_session_record(request: Request, session_uuid: str):
    """DELETE one stored session from every listing. KEEP the row.

    Description: a SOFT delete - it stamps ``sessions.archived_at`` and
      nothing else. The row is retained deliberately, because session
      history and transcripts are built on it; "delete" here means "take
      it off my screen", never "remove it from the database".

      THIS IS NOT THE KILL PATH AND THE TWO MUST NOT BE CONFLATED.
      ``DELETE /sessions`` (and ``DELETE /sessions/external/{name}``)
      stop a running process, and the first of them also rmtrees the
      session's ``.cloude_uploads`` bucket - real user content. This
      route does none of that. Deleting a row for a session that is
      still running is allowed and merely unlists it; the lifecycle
      reconciler keeps updating it underneath, unseen.

      ADDRESSED BY ``session_uuid``, NOT BY TMUX NAME, because tmux
      reuses names and two rows can differ only by creation epoch. See
      ``session_store.archive_session``.
    Inputs: request (Request) - unused beyond auth. session_uuid (str,
      path) - the row to delete.
    Output: SuccessResponse - ``message`` says whether this call
      performed the delete or found it already deleted. Those are
      different facts and the route reports which one happened rather
      than flattening both into "ok".
    Raises: HTTPException 404 - no row carries that uuid, so nothing was
      deleted. HTTPException 503 - the datastore is absent or unreadable.
    """
    from contextlib import closing


    from src.core import session_store
    from src.core.db import DatastoreUnreadableError, connect, db_path_for

    db_path = db_path_for(settings.get_state_dir())
    if not db_path.exists():
        raise HTTPException(
            status_code=503,
            detail="no datastore: sessions cannot be archived on this install",
        )

    def _write() -> bool:
        """Open, archive and close on ONE pooled thread.

        Inputs: none (closes over db_path and session_uuid).
        Output: bool - True when this call performed the delete.
        Raises: session_store.SessionNotFoundError, DatastoreUnreadableError.
        """
        with closing(connect(db_path, create=False)) as conn:
            return session_store.archive_session(conn, session_uuid)

    try:
        performed = await run_in_threadpool(_write)
    except session_store.SessionNotFoundError:
        raise HTTPException(
            status_code=404, detail=f"no session record {session_uuid}"
        )
    except DatastoreUnreadableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return SuccessResponse(
        message=(
            "Session deleted from your lists (the record is kept)"
            if performed
            else "Session was already deleted"
        )
    )


@router.patch(
    "/sessions/records/{session_uuid}/notifications",
    response_model=NotificationPolicyResponse,
    dependencies=[Depends(require_auth)],
)
async def set_session_notification_policy(
    request: Request, session_uuid: str, body: MuteNotificationsRequest
):
    """Mute or unmute one session's notifications. Durably.

    Description: writes ``sessions.notifications_muted`` and steps
      ``sessions.notification_policy_generation``, then updates the
      in-memory policy projection the notification producers read so the
      change takes effect immediately rather than at the next boot.

      IT IS A STATE, NOT A TOGGLE. Sending ``{"muted": true}`` twice
      commits once and reports the same answer both times. A toggle would
      make a retry, a double click, or a second open tab flip the setting
      to whatever the race decided.

      THE GENERATION IS WHY THIS RETURNS MORE THAN "ok". Every queued
      notification carries the generation it was raised under, and the
      dispatcher refuses anything that is not current. So this response's
      ``policy_generation`` is what makes "an old alert cannot escape a
      mute/unmute cycle" checkable from outside the server.

      MUTING ACKNOWLEDGES NOTHING. It records a delivery preference and
      touches no toast, no unread flag and no activity state. In
      particular a pending PERMISSION request stays open and the session
      keeps reporting ``question``: claude is still blocked mid-turn
      waiting on a human, and a mute that quietly marked that answered
      would strand it behind a yes/no nobody was ever told about.

      IT DOES NOT REPLAY A BACKLOG EITHER. Unmuting resumes FUTURE alerts
      only. What was suppressed was never queued for later; what was
      already queued is invalidated by the generation step.

      ADDRESSED BY ``session_uuid``, and optionally checked against an
      expected tmux instance - see ``MuteNotificationsRequest`` for why a
      row action fired from a painted list needs that second key.
    Inputs: request (Request) - unused beyond auth. session_uuid (str,
      path) - the row. body (MuteNotificationsRequest).
    Output: NotificationPolicyResponse - the COMMITTED state and
      generation, read back rather than echoed.
    Raises: HTTPException 404 - no row carries that uuid, or the database
      predates schema v26 so there is nowhere to record this.
      HTTPException 409 - the row is not the tmux instance the caller
      named, so the list it was clicked from was stale.
      HTTPException 503 - the datastore is absent or unreadable.
    """
    from contextlib import closing


    from src.core import session_store
    from src.core.db import DatastoreUnreadableError, connect, db_path_for

    db_path = db_path_for(settings.get_state_dir())
    if not db_path.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                "no datastore: notification settings cannot be saved on "
                "this install"
            ),
        )

    def _write() -> dict:
        """Open, write and close on ONE pooled thread.

        Inputs: none (closes over db_path, session_uuid and body).
        Output: dict with ``muted``, ``generation`` and ``changed``.
        Raises: session_store.SessionNotFoundError,
          session_store.SessionInstanceMismatchError,
          DatastoreUnreadableError.
        """
        with closing(connect(db_path, create=False)) as conn:
            return session_store.set_notification_mute(
                conn,
                session_uuid,
                muted=body.muted,
                expected_tmux_name=body.expected_tmux_name,
                expected_tmux_created_epoch=body.expected_tmux_created_epoch,
            )

    try:
        committed = await run_in_threadpool(_write)
    except session_store.SessionInstanceMismatchError:
        # 409, NOT 404. The row is there; it is simply not the session the
        # caller was looking at when they clicked. Answering 404 would
        # send a client hunting for a missing record instead of
        # refreshing a stale list.
        raise HTTPException(
            status_code=409,
            detail=(
                "that session record is a different tmux instance now - "
                "refresh and try again"
            ),
        )
    except session_store.SessionNotFoundError:
        raise HTTPException(
            status_code=404, detail=f"no session record {session_uuid}"
        )
    except DatastoreUnreadableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    # KEEP THE IN-MEMORY PROJECTION IN STEP WITH THE ROW. Without this the
    # setting would be durable but inert until the next restart, because
    # every gate reads the projection rather than the database - which is
    # the whole reason the projection exists.
    #
    # It takes the COMMITTED values rather than the requested ones, so a
    # no-op cannot invent a generation the row does not have.
    session_manager = request.app.state.session_manager
    store = getattr(session_manager, "_notification_policy_store", None)
    if store is not None:
        try:
            store.apply(
                session_uuid,
                muted=committed["muted"],
                generation=committed["generation"],
            )
            # AND TEACH IT THE INSTANCE, which is not the same write.
            # ``apply`` records what the policy IS; this records how a
            # LIVE session finds it. A row created since the last
            # hydration is in neither index, so without this a mute set
            # on a session started five minutes ago would be durable and
            # inert - the hook gate looks the policy up by tmux instance
            # and would not find the uuid the mute was stored under until
            # the next boot.
            store.bind_instance(
                session_uuid,
                tmux_name=committed.get("tmux_name"),
                tmux_created_epoch=committed.get("tmux_created_epoch"),
            )
        except (KeyError, TypeError, ValueError) as exc:
            # The row IS written; only the live projection is behind, and
            # it self-corrects on the next hydration. Logged rather than
            # swallowed, and never turned into a failure the user would
            # read as "your setting was not saved" when it was.
            logger.warning(
                "notification_policy_projection_update_failed",
                session_uuid=session_uuid,
                error=str(exc),
            )

    logger.info(
        "session_notification_policy_set",
        session_uuid=session_uuid,
        muted=committed["muted"],
        policy_generation=committed["generation"],
        changed=committed["changed"],
    )
    return NotificationPolicyResponse(
        muted=bool(committed["muted"]),
        policy_generation=int(committed["generation"]),
    )


@router.post(
    "/sessions/records/{session_uuid}/unarchive",
    response_model=SuccessResponse,
    dependencies=[Depends(require_auth)],
)
async def unarchive_session_record(request: Request, session_uuid: str):
    """Bring an archived session record back onto the user's screens.

    Description: the reverse of ``DELETE /sessions/records/{uuid}``, and
      it exists for the same reason ``POST /projects/{name}/unarchive``
      does - an archive with no way back is a delete wearing a friendlier
      label. Restarting an archived row already clears ``archived_at`` as
      a side effect (``session_restart.rebind_instance``), which is why
      the launchpad UI has relied on restart rather than a dedicated
      control; this route gives the same restore WITHOUT requiring a live
      tmux to restart into.

      IDEMPOTENT. Unarchiving a row that is not archived is a 200, not a
      404 or a 409 - the caller asked for a state (visible again) and
      that state already holds. The message says which of the two
      happened rather than flattening both into "ok".
    Inputs: request (Request) - unused beyond auth. session_uuid (str,
      path) - the row to restore.
    Output: SuccessResponse - ``message`` says whether this call
      performed the restore or found the row already live.
    Raises: HTTPException 404 - no row carries that uuid, so nothing was
      restored. HTTPException 503 - the datastore is absent or unreadable.
    """
    from contextlib import closing


    from src.core import session_store
    from src.core.db import DatastoreUnreadableError, connect, db_path_for

    db_path = db_path_for(settings.get_state_dir())
    if not db_path.exists():
        raise HTTPException(
            status_code=503,
            detail="no datastore: sessions cannot be restored on this install",
        )

    def _write() -> bool:
        """Open, unarchive and close on ONE pooled thread.

        Inputs: none (closes over db_path and session_uuid).
        Output: bool - True when this call performed the restore.
        Raises: session_store.SessionNotFoundError, DatastoreUnreadableError.
        """
        with closing(connect(db_path, create=False)) as conn:
            return session_store.unarchive_session(conn, session_uuid)

    try:
        performed = await run_in_threadpool(_write)
    except session_store.SessionNotFoundError:
        raise HTTPException(
            status_code=404, detail=f"no session record {session_uuid}"
        )
    except DatastoreUnreadableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    return SuccessResponse(
        message=(
            "Session restored to your lists"
            if performed
            else "Session was already visible"
        )
    )
