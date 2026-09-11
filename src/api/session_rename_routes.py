"""Rename a session, which writes a LABEL and never the tmux name.

A SESSION NAME IS A LABEL, AND A LABEL IS NOT THE TMUX NAME. This
endpoint used to call ``tmux rename-session``, which moves the
``tmux_name`` that the ``(socket, name, epoch)`` identity is keyed on;
the stored row then matched no live listing row, was reaped as
``tmux_missing``, and the same live session came back through the adopt
path as a stranger with a SECOND row. One session, two rows, one of them
a corpse. It now writes ``sessions.title`` and stops.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from src.api.auth import require_auth
from src.api.websocket import connection_manager
from src.models import RenameSessionRequest, SessionRenamedMessage

logger = structlog.get_logger()
router = APIRouter()


# ---------------------------------------------------------------------------
# Session rename
# ---------------------------------------------------------------------------
# v0.7.1 - PATCH /sessions/{session_id}/name renames a live tmux session
# on the ``-L cloude`` socket via ``tmux rename-session`` and broadcasts a
# ``session.renamed`` WS event so every browser bound to that session id
# updates its displayed name + ``document.title``. See SessionManager's
# ``rename_session`` for the re-keying semantics (owned set, pinned-themes
# map, session metadata).
#
# A SESSION NAME IS A LABEL, AND A LABEL IS NOT THE TMUX NAME.
# This endpoint used to call ``tmux rename-session``, which moves
# ``tmux_name`` - the field ``(socket, name, epoch)`` identity is keyed
# on. The stored row then matched no live listing row, was reaped as
# ``tmux_missing``, and the same live session came back through the
# adopt path as a stranger and got a SECOND row. One session, two rows,
# one of them a corpse.
#
# It now writes ``sessions.title`` and stops. The tmux name a session is
# created with is the tmux name it keeps, so no user-facing path can
# move identity. The old ``^[A-Za-z0-9_-]{1,64}$`` charset is gone with
# it: that regex existed to keep the value safe inside a tmux target and
# a FIFO filename, and a label is never handed to either. Labels take
# spaces, punctuation and mixed case; ``session_label.validate_label``
# refuses only what cannot be rendered (empty, or a control character).
#
# ``SessionManager.rename_session`` is deliberately NOT deleted. An
# external ``tmux rename-session`` is still possible, and the lifecycle
# reconciler still heals it - see src/core/session_lifecycle.py's rename
# pass. What changed is that no user action reaches that path.


@router.patch(
    "/sessions/{session_id}/name",
    # NO response_model, DELIBERATELY, and this cost a 500 to learn.
    #
    # This route now has TWO legitimate success shapes: a full SessionInfo
    # when the manager holds the session open, and a small
    # {renamed, session, label} when it does not - which is normal since
    # the rename gate was lifted and a tmux name is accepted for a session
    # that was never adopted.
    #
    # A response_model is not a hint, it is enforcement: FastAPI validated
    # the second shape against SessionInfo and turned a rename that had
    # ALREADY been written durably into an HTTP 500. That is the worst
    # failure available here, because the user retries an operation that
    # already succeeded. (Same family as the earlier ThemeManifest bug in
    # this file, where a response_model silently DELETED a field that
    # existed all the way up to serialization - filter there, reject
    # here.)
    dependencies=[Depends(require_auth)],
)
async def rename_session_endpoint(
    request: Request, session_id: str, body: RenameSessionRequest
):
    """Set a live session's user-facing LABEL. The tmux name never moves.

    STALE DOC CORRECTED. This docstring described the endpoint's behaviour
    before the label split and outlived it: it named a
    ``^[A-Za-z0-9_-]{1,64}$`` validator, a 409 and a 500 that the body
    below had already stopped being able to produce. The comment block
    above this function explained the new design correctly the whole time,
    which is exactly how a stale docstring survives - the accurate prose
    sat next to it and nobody re-read the paragraph underneath.

    Validates ``new_name`` with ``session_label.validate_label``: at most
    ``LABEL_MAX_CHARS`` (200) characters, non-empty after stripping, no
    control characters. Spaces, punctuation and non-ASCII are all ACCEPTED
    - the label is never handed to tmux, so tmux's constraints do not
    apply to it. Returns:

      * 400 - empty, too long, or carrying a control character
      * 404 - no tmux session this app has a record of
      * 200 - success; body is the updated ``SessionInfo``

    There is no 409: two sessions may carry the same label, because a
    label identifies nothing. There is no 500 for a failed tmux rename,
    because no tmux rename happens.

    On success the server broadcasts ``session.renamed`` to every WS bound
    to ``session_id`` so all attached tabs update their displayed name +
    ``document.title``. The broadcast is best-effort - broadcast failures
    log a warning but do not roll back the rename (the in-memory state is
    already authoritative).
    """
    session_manager = request.app.state.session_manager

    from src.core.session_label import InvalidLabel, validate_label

    try:
        new_name = validate_label(body.new_name)
    except InvalidLabel as exc:
        logger.info(
            "api_rename_session_rejected_invalid_label",
            session_id=session_id,
            reason=str(exc),
        )
        raise HTTPException(status_code=400, detail=str(exc))

    logger.info(
        "api_rename_session_request",
        session_id=session_id,
        new_name=new_name,
    )

    if not session_manager.set_session_label(session_id, new_name):
        # A DEFINITE NEGATIVE, and the only one this surface has left.
        # There is no 409 any more: two sessions may carry the same
        # label, because a label identifies nothing. There is no 500 for
        # a failed tmux rename, because no tmux rename happens.
        raise HTTPException(
            status_code=404,
            detail=(
                "That session could not be labelled - it is not a tmux "
                "session this app has a record of."
            ),
        )
    # THE LABEL IS ALREADY WRITTEN AND DURABLE AT THIS POINT. What
    # follows is response-shaping and a courtesy broadcast, and neither
    # may turn a completed rename into an error.
    #
    # `get_session_info` needs a LIVE session, and since the rename gate
    # was lifted this route legitimately accepts a tmux name for a
    # session the manager does not hold - which made it raise and return
    # 500 on a rename that had in fact succeeded. Measured: the row read
    # title='Gate Lift Proof' while the caller was told the request
    # failed. A 500 after a durable write is the worst of both, because
    # the user retries an operation that already happened.
    info = None
    try:
        info = await session_manager.get_session_info(session_id)
    except Exception as exc:  # noqa: BLE001 - see comment above
        logger.info(
            "rename_session_info_unavailable",
            session_id=session_id,
            error=str(exc),
            note="the label write succeeded; only the response shape is degraded",
        )

    # Broadcast to every WS bound to this session so attached tabs update
    # their header text + document.title without a round-trip. Failures on
    # individual sockets are absorbed inside ``broadcast_to_session``; an
    # outer-level exception (shouldn't happen) is logged and swallowed so
    # the HTTP response still surfaces the successful rename.
    try:
        await connection_manager.broadcast_to_session(
            session_id,
            SessionRenamedMessage(
                session_id=session_id, new_name=new_name
            ).model_dump_json(),
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "rename_session_broadcast_failed",
            session_id=session_id,
            error=str(exc),
        )

    if info is not None:
        return info
    # No live session to describe, so answer with the fact that IS known:
    # the rename happened. Reported under its own shape rather than an
    # empty SessionInfo, which would look like a session with nothing in
    # it instead of a session this route never held.
    return {
        "renamed": True,
        "session": session_id,
        "label": new_name,
        "detail": "renamed; no live session attached to describe",
    }
