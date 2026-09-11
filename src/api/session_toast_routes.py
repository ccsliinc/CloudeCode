"""The per-session toast list, the synthetic create, and the ack.

Three endpoints: backfill an attaching client, record a toast by hand
(kept for client and manual testing), and acknowledge one. The WS fanout
targets only the sockets bound to the named session, so a toast for
session A never leaks into a tab attached to session B.

The HOOK-DRIVEN toast path is next door in ``hook_event_routes.py``.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from src.api.auth import require_auth
from src.api.websocket import connection_manager
from src.core import toast_auto_ack
from src.models import (
    CreateToastRequest,
    SuccessResponse,
    Toast,
    ToastAckMessage,
    ToastNewMessage,
)
from typing import List

logger = structlog.get_logger()
router = APIRouter()


# ---------------------------------------------------------------------------
# Toast notifications (v0.7.0 Part 2)
# ---------------------------------------------------------------------------
# Three endpoints:
#   GET  /sessions/{session_id}/toasts?unacked=true  → list (backfill on attach)
#   POST /sessions/{session_id}/toasts               → record + broadcast
#       (SYNTHETIC - Part 3 will add a hook-driven endpoint; this one is
#        intentionally kept for client/manual testing)
#   POST /toasts/{toast_id}/ack?session_id=<id>      → mark acked + broadcast
#
# Storage + theme-accent resolution lives in SessionManager. The WS fanout
# uses ``connection_manager.broadcast_to_session`` which targets only the
# sockets bound to the named session, so toasts for session A never leak
# into a tab attached to session B.


@router.get(
    "/sessions/{session_id}/toasts",
    response_model=List[Toast],
    dependencies=[Depends(require_auth)],
)
async def list_session_toasts(
    request: Request, session_id: str, unacked: bool = False
):
    """List toasts for a session, optionally filtered to unacked-only.

    Used by the client on (re)attach to backfill any toast that fired
    while the browser was disconnected. Newest-first. Returns an empty
    list (NOT 404) when the session has no toasts - the launchpad polls
    speculatively and an empty array is the right success shape.
    """
    # THE ``hasattr`` GUARD THAT USED TO BE HERE IS GONE, DELIBERATELY.
    # It answered ``[]`` for a manager without the attribute, which is
    # indistinguishable from a session with no toasts - so deleting the
    # forwarder it guarded would have emptied this endpoint on every
    # session while raising nowhere and failing no test. A missing inbox
    # is now a 500, which is a bug report rather than a silent lie.
    return request.app.state.services.toasts.get(session_id, unacked)


@router.post(
    "/sessions/{session_id}/toasts",
    response_model=Toast,
    status_code=201,
    dependencies=[Depends(require_auth)],
)
async def create_session_toast(
    request: Request, session_id: str, body: CreateToastRequest
):
    """Synthetic toast creation - record + broadcast to the session.

    INTENTIONALLY TEMPORARY for v0.7.0 Part 2: lets the client and storage
    layer be exercised end-to-end without a real Claude Code hook. Part 3
    will add a hook-driven endpoint with different auth semantics; THIS
    surface remains useful for manual testing and is the canonical entry
    point for synthetic-load tests.

    NOT GATED BY THE PER-SESSION NOTIFICATION MUTE, and that is a decision
    rather than an oversight. The mute suppresses the alerts an AGENT
    raises about itself; this route is the app's own channel, and the
    plan it comes from preserves action errors explicitly. Muting a
    session must not stop the app telling its user that something the
    user just did failed. The EXTERNAL push is still covered: the event
    ``record_toast`` emits is stamped with the session's policy, so the
    dispatcher drops it for a muted session either way.

    Returns 404 when the session id is unknown.
    """
    session_manager = request.app.state.session_manager
    try:
        toast = session_manager.record_toast(
            session_id=session_id,
            kind=body.kind,
            title=body.title,
            body=body.body,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    # Fan out the toast to every browser bound to this session. Includes
    # the originating tab so the creator's UI updates without a separate
    # round-trip (the synthetic POST endpoint isn't typically the same
    # process as the displaying browser, but treating it uniformly keeps
    # the future hook path symmetric).
    try:
        await connection_manager.broadcast_to_session(
            session_id,
            ToastNewMessage(toast=toast).model_dump_json(),
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("toast_broadcast_failed", session_id=session_id, error=str(exc))

    return toast


@router.post(
    "/toasts/{toast_id}/ack",
    response_model=SuccessResponse,
    dependencies=[Depends(require_auth)],
)
async def ack_toast(request: Request, toast_id: str, session_id: str):
    """Mark a toast acknowledged and broadcast the ack to the session.

    ``session_id`` is a required query parameter (not body) so this is a
    cleanly bookmarkable / curlable URL. The broadcast lets OTHER browsers
    attached to the same session dismiss the toast in lockstep - no
    localStorage cross-tab sync needed.

    Idempotent at the storage layer: a double-click won't re-broadcast.

    ALWAYS 200, and the message is what carries the outcome. This
    docstring used to claim a 404 for a toast id unknown to this session;
    it never did that - the branch below returns ``success=true`` with
    "No-op" for BOTH "not in this session's bucket" and "already acked",
    because the storage layer treats them as the same non-change.
    Corrected 2026-09-08 while writing tests/test_toast_cross_session.py,
    which asserts the resulting STATE rather than the status code.

    THE SCOPING IS STILL REAL, and it is what keeps a dismissal per
    session now that raising is global (see src/api/toast_routes.py):
    ``ack_toast`` walks ONLY ``session_id``'s bucket, so acking session
    B's toast id under session A leaves B's record untouched. The
    isolation lives in the storage walk, not in the status code.
    """
    session_manager = request.app.state.session_manager
    # EXPLICIT, THOUGH IT IS THE DEFAULT. This is the HUMAN path - a
    # click on the x, or a sweep control the human operated - and naming
    # the reason here is what makes the history able to tell it apart
    # from the hook-driven ``answered`` path in toast_auto_ack.py. A
    # reason inferred at read time would be a guess on a page whose whole
    # job is to be trusted about what happened.
    changed = request.app.state.services.toasts.ack(
        session_id, toast_id, toast_auto_ack.ACK_REASON_DISMISSED
    )
    if not changed:
        # Either not found OR already acked. We can't distinguish without
        # an extra get_toasts walk; the storage layer treats both as
        # "no state change". Tests use get_toasts to assert post-state;
        # the client doesn't care which it was.
        return SuccessResponse(success=True, message="No-op")

    try:
        await connection_manager.broadcast_to_session(
            session_id,
            ToastAckMessage(toast_id=toast_id).model_dump_json(),
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "toast_ack_broadcast_failed",
            session_id=session_id,
            toast_id=toast_id,
            error=str(exc),
        )

    return SuccessResponse(success=True, message="Toast acknowledged")
