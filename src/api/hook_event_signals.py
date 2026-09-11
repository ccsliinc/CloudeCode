"""The three signals the toast gate is judged on, read before the event lands.

WHY THIS IS ITS OWN MODULE. ``hook_event_routes`` is a route module and
this project holds those to 500 lines
(``tests/test_api_route_modules.py``). The reads below are not routing:
they are three defensive lookups with one shared rule, and the rule is
the interesting part.

**EVERY ONE OF THEM IS READ BEFORE ``record_hook_event``.** A gate that
read its evidence afterwards would be judging the event by state the
event itself had just written - ``Stop`` resets ``subagent_depth`` to 0,
so a depth read after the fact answers 0 every time and the sub-agent
gate could never fire. The idle-notification read would answer
identically either side of that call today, and is taken before anyway,
so this stays true when that event grows.

**EVERY ONE OF THEM FAILS TOWARD NOTIFYING.** An unknown session, a
dropped ``SubagentStart`` (hooks are unordered, duplicated and
droppable - CLAUDE.md), or a read that threw all leave the signal at its
raising value. A missed "your turn" is a worse failure than a spurious
one, so silence is only ever bought with positive evidence.
"""

from __future__ import annotations

from typing import Any, Tuple

import structlog

logger = structlog.get_logger()


def read_suppression_signals(
    session_manager: Any, session_id: str, event_kind: str
) -> Tuple[int, bool, bool]:
    """Read the sub-agent depth, the wait latch and the idle-nudge signal.

    Inputs: session_manager (Any) - the live manager; session_id (str) -
      the id the hook presented; event_kind (str) - for the log lines
      only, so an unreadable signal names the event it was refused for.
    Output: tuple[int, bool, bool] - ``(subagent_depth, subagent_wait,
      idle_notification_suppressed)``. The raising values are ``(0,
      False, False)`` and every failure path returns them.
    Example:
        read_suppression_signals(mgr, "ses_1", "Stop")  # (0, False, False)
    """
    # FAIL TOWARD NOTIFYING. Anything that is not a POSITIVE count of live
    # sub-agents leaves this at 0 and the toast is raised exactly as
    # before: an unknown session, a dropped ``SubagentStart`` (hooks are
    # droppable - CLAUDE.md), or a read that threw. A missed "your turn"
    # is a worse failure than a spurious one, so silence is only ever
    # bought with evidence.
    #
    # THE LATCH IS THE OTHER HALF OF THE SAME EVIDENCE, and it is read
    # here for the same reason: ``Stop`` resets the depth to 0, so the
    # depth alone covers only the FIRST event of a background wait. The
    # trailing idle ``Notification`` claude fires about 60s later, and any
    # second ``Stop`` behind it, find a depth of 0 and would be raised.
    # ``subagent_wait_active`` answers for a bounded window after a
    # ``Stop`` that was itself suppressed at a positive depth. It is read
    # BEFORE ``record_hook_event`` so this event cannot stamp the latch it
    # is then judged by.
    try:
        subagent_depth_at_event = session_manager.subagent_depth(session_id)
        subagent_wait_at_event = session_manager.subagent_wait_active(session_id)
    except Exception as exc:  # pragma: no cover - defensive, see above
        logger.warning(
            "hook_subagent_depth_unreadable",
            session_id=session_id,
            event_kind=event_kind,
            error=str(exc),
        )
        subagent_depth_at_event = 0
        subagent_wait_at_event = False

    # THE IDLE NUDGE, A SEPARATE SIGNAL FROM THE SUB-AGENT ONE ABOVE, read
    # BEFORE ``record_hook_event`` for the same reason as the depth. Even
    # though a ``Notification`` does not itself mutate what this read
    # inspects today, reading first keeps the event free to change that
    # later without this gate silently starting to judge its own effect.
    # See ``session_activity.idle_notification_should_suppress``.
    #
    # FAIL TOWARD NOTIFYING. An unreadable session, one that never saw a
    # Stop, or a read that threw all leave this False and the toast is
    # raised exactly as before.
    try:
        idle_notification_suppressed_at_event = (
            session_manager.should_suppress_idle_notification(session_id)
        )
    except Exception as exc:  # pragma: no cover - defensive, see above
        logger.warning(
            "hook_idle_notification_signal_unreadable",
            session_id=session_id,
            event_kind=event_kind,
            error=str(exc),
        )
        idle_notification_suppressed_at_event = False

    return (
        subagent_depth_at_event,
        subagent_wait_at_event,
        idle_notification_suppressed_at_event,
    )
