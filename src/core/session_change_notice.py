"""Build the compact change notices that travel on `/ws/events`.

WHY ITS OWN FILE. The two places that know a session changed are
`src/api/routes.py` and `src/core/session_manager.py`, and both are far
past this project's line budget and must not grow. More to the point, the
RULE for what a notice may claim does not belong in either of them: it
belongs somewhere a reader can find it in one piece.

A NOTICE CARRIES FACTS THAT WERE MEASURED, AND NOTHING ELSE. `build_status_notice`
is PURE - it takes values already in hand and shapes them. It does not
resolve a status, read a pane, open a database or invent a default. A
field the caller could not measure is simply absent from the frame, and
the client leaves what it holds alone: absent is not a default, and a
fabricated `ready` or a fabricated `idle` is exactly the false-green
failure this project keeps paying for.

THE STATUS NOTICE IS NOT AN ALERT, SO THE MUTE DOES NOT GATE IT. That
looks like a hole and is not. Muting a session suppresses the
INTERRUPTION - the toast, the push - and changes nothing about what the
session's row is allowed to say; a muted session's light updates on the
five second poll today and would be visibly stale if this channel refused
to say so. The TOAST notice is gated, and it is gated by construction
rather than by a second copy of the rule: it is published from the one
place in `claude_event_hook` that a suppressed toast never reaches, past
both the notification-policy gate and the sub-agent gate, beside the
existing per-session broadcast.

A NOTICE IS AN OPTIMISATION AND MAY BE LOST. Hook events are unordered,
duplicated and droppable, so notices derived from them are too. Every
frame here is therefore a statement of current fact rather than a delta,
which is what makes the same notice twice a no-op on the client and a
dropped one recoverable by the next notice or the next poll.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import structlog

from src.core.event_hub import EventHub, get_hub
from src.models import WSMessageType

logger = structlog.get_logger()


def build_status_notice(
    *,
    session_id: str,
    tmux_session: Optional[str] = None,
    epoch: Optional[int] = None,
    activity_status: Optional[str] = None,
    unread: Optional[bool] = None,
    startup_gate: Optional[str] = None,
) -> Dict[str, Any]:
    """Shape one compact session status notice. Pure.

    Description: names the session INSTANCE (id, plus the tmux name and
      epoch when they were measured) and carries only the fields a list
      row paints. Any field passed as None is OMITTED rather than sent as
      null, so a client can tell "this did not change / was not measured"
      from "this is now false", which a null cannot say.
    Inputs: session_id (str) - the id the rest of the app routes on;
      tmux_session (str|None) and epoch (int|None) - the instance, when
      measured; activity_status (str|None) - a value from
      `session_status.ALL_ACTIVITY_STATUSES`; unread (bool|None);
      startup_gate (str|None) - a value from
      `session_startup_gate.ALL_STARTUP_GATES`.
    Output: dict - a JSON-encodable frame.
    Example: build_status_notice(session_id="ses_1", activity_status="question")
    """
    frame: Dict[str, Any] = {
        "type": WSMessageType.SESSION_STATUS_CHANGED,
        "session_id": session_id,
    }
    if tmux_session:
        frame["tmux_session"] = tmux_session
    if epoch is not None:
        frame["epoch"] = epoch
    if activity_status is not None:
        frame["activity_status"] = activity_status
    if unread is not None:
        frame["unread"] = unread
    if startup_gate is not None:
        frame["startup_gate"] = startup_gate
    return frame


def build_structural_notice(reason: str) -> Dict[str, Any]:
    """Shape the "the list changed, re-read it" notice. Pure.

    Description: carries a reason for logs and for a client that wants to
      debounce, and NO data. That is the whole design: a notice with a
      payload becomes a second source of truth for the session list and
      drifts from `/sessions/list`; a notice that says re-read cannot.
    Inputs: reason (str) - a short token, e.g. "created", "destroyed".
    Output: dict - a JSON-encodable frame.
    Example: build_structural_notice("created")
    """
    return {"type": WSMessageType.SESSIONS_CHANGED, "reason": reason}


def publish(app_state: Any, frame: Dict[str, Any]) -> int:
    """Put one frame on the hub, tolerating an app that has none.

    Description: FAIL-SOFT at every publish site. An app built without
      the channel behaves exactly as it did before this existed, and a
      publish that could not happen costs the client only its five second
      poll. It never awaits, so a publish cannot delay the hook route it
      is called from.
    Inputs: app_state (Any) - typically `request.app.state`; frame (dict).
    Output: int - clients the frame was accepted by; 0 when there is no
      hub or nobody is connected.
    Example: publish(request.app.state, build_structural_notice("created"))
    """
    hub: Optional[EventHub] = get_hub(app_state)
    if hub is None:
        return 0
    return hub.publish(frame)


def publish_hook_status(app_state: Any, session_manager: Any, session_id: str) -> int:
    """Publish this session's status right after a hook was recorded.

    Description: reads the state the hook just produced, entirely from
      memory - `SessionActivityTracker.resolve` and the unread store - and
      publishes it. THE TMUX ARGUMENT IS `unknown` ON PURPOSE: resolving
      against a real pane status would cost a subprocess on every single
      tool call, and it is not needed here, because a hook arriving is
      itself proof the pane is alive and the dead-check is the only thing
      that argument decides. The consequence is stated rather than hidden:
      a hook-derived state comes back exact, and a session whose heartbeat
      has expired comes back `unknown`, which is a real answer and never
      `idle`.

      FAIL-SOFT AND NEVER RAISES. This runs inside the hook route, which
      must answer claude whatever happens here, so a manager that cannot
      answer publishes nothing and logs at debug.
    Inputs: app_state (Any); session_manager (Any) - the live
      SessionManager; session_id (str).
    Output: int - clients the notice was accepted by.
    Example: publish_hook_status(request.app.state, sm, "ses_1")
    """
    hub = get_hub(app_state)
    if hub is None or hub.client_count == 0:
        return 0

    activity_status: Optional[str] = None
    unread: Optional[bool] = None
    tmux_session: Optional[str] = None
    epoch: Optional[int] = None

    tracker = getattr(session_manager, "_activity_tracker", None)
    backend = None
    getter = getattr(session_manager, "get_backend", None)
    if callable(getter):
        backend = getter(session_id)
    tmux_session = getattr(backend, "tmux_session", None)
    if tmux_session is None:
        tmux_session = getattr(session_manager, "_hook_tmux_names", {}).get(session_id)
    epoch = getattr(session_manager, "_instance_epochs", {}).get(session_id)

    if tmux_session:
        reader = getattr(session_manager, "_is_unread", None)
        if callable(reader):
            try:
                unread = bool(reader(tmux_session, epoch))
            except OSError as exc:
                # The unread store is a file on disk. A read that failed
                # is a read that did not answer, so the field is omitted
                # rather than sent as False, which would clear a green
                # ring the user has not looked at.
                logger.debug("event_notice_unread_unreadable",
                             session_id=session_id, error=str(exc))

    if tracker is not None:
        from src.core.session_status import STATUS_UNKNOWN

        try:
            activity_status = tracker.resolve(
                session_id, STATUS_UNKNOWN, unread=bool(unread)
            )
        except (AttributeError, KeyError, TypeError) as exc:
            logger.debug("event_notice_status_unresolved",
                         session_id=session_id, error=str(exc))

    return hub.publish(
        build_status_notice(
            session_id=session_id,
            tmux_session=tmux_session,
            epoch=epoch,
            activity_status=activity_status,
            unread=unread,
        )
    )
