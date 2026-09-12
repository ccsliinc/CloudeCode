"""Whether one hook event may interrupt the user, as a pure ladder.

Lifted out of ``src/api/routes.py``'s hook endpoint by decomposition
slice S6. The endpoint still does the I/O - it reads the notification
policy off the session manager and writes the log line - and this module
decides. Splitting them makes the decision testable without an HTTP
request, a live pane or a policy store, which is what it needed: every
rule below used to be reachable only through a POST.

TWO GATES, ASKED IN THIS ORDER, and the order is the design.

**Mute is checked first** because it is an explicit instruction from the
user rather than an inference about the session. Both gates end in the
same silence, so when both are true the more informative reason is the
one the user themselves gave, and the log line says which fired.

**Mute covers every toast kind, including ``PermissionRequest``.** The
sub-agent gate deliberately exempts permission prompts because a blocked
session genuinely does want the user; a mute is the user answering that
in advance, for this session, and exempting a kind from it would mean the
control does not do what its label says.

**An UNREADABLE policy suppresses**, which is the opposite posture from
the sub-agent gate, on purpose. Here the user has already asked for
silence and guessing "they did not mean it" sends a push to a phone that
cannot be recalled. The sub-agent gate fails the other way: anything that
is not a POSITIVE count of live sub-agents raises the toast, because a
missed "your turn" is worse than a spurious one, so silence there is only
ever bought with evidence.

**SUPPRESSING IS NOT ACKNOWLEDGING, and that is the load-bearing half.**
``record_hook_event`` has already run by the time this is consulted, so a
suppressed ``PermissionRequest`` still sets ``permission_open`` and the
session still resolves to ``question``; a suppressed ``Stop`` still flips
unread. What is skipped is the interruption, never the record. A mute
that quietly marked a pending permission answered would strand claude
mid-turn behind a yes/no nobody was told about.

**WHILE SUB-AGENTS ARE RUNNING THE SESSION IS NOT WAITING ON THE USER, IT
IS WAITING ON ITSELF.** claude fires ``Stop`` when the main turn ends even
though its own background agents are still going, and fires
``Notification`` asking to be looked at in the same state - the pane in
that state literally reads "Waiting for 2 background agents to finish".
Both toasts summon the user to a session that wants nothing from them,
which is the false-urgency failure this project already paid for when
``question`` and ``notice`` were one state. ``PermissionRequest`` is
never suppressed at any depth: it is a HARD BLOCK, claude has stopped
mid-turn and cannot continue until a human answers, so it is the one ask
that stays true no matter how much else is still running.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from src.core.session_activity import (
    EVENT_NOTIFICATION,
    EVENT_STOP,
    IDLE_NOTIFICATION_SUPPRESSION_REASON,
)

#: The ``toast_suppressed`` value returned when the user muted the session.
SUPPRESSED_NOTIFICATIONS_MUTED = "notifications_muted"

#: The ``toast_suppressed`` value returned when the session is waiting on
#: its own sub-agents rather than on the user.
SUPPRESSED_SUBAGENTS_RUNNING = "subagents_running"

#: The log event names, kept here beside the rules that emit them so the
#: string a grep looks for cannot drift from the branch that produces it.
LOG_MUTED = "hook_toast_suppressed_notifications_muted"
LOG_SUBAGENTS = "hook_toast_suppressed_subagents_running"
LOG_TURN_CLOSED = "hook_toast_suppressed_turn_closed"

#: The kinds the sub-agent gate may silence. ``PermissionRequest`` is
#: absent deliberately; see the module docstring.
SUBAGENT_GATE_KINDS = (EVENT_STOP, EVENT_NOTIFICATION)


@dataclass(frozen=True)
class ToastGateVerdict:
    """What the endpoint should do with one toast-worthy hook event.

    Attributes:
        suppressed_by: None to raise the toast, otherwise the
            ``toast_suppressed`` value to return to the hook subprocess.
        log_event: the structlog event name to emit, None when nothing
            is suppressed.
        log_fields: the extra structlog keyword arguments for that line,
            already resolved, so the caller adds only session_id and
            event_kind.
    """

    suppressed_by: Optional[str] = None
    log_event: Optional[str] = None
    log_fields: dict[str, Any] = field(default_factory=dict)

    @property
    def raises_toast(self) -> bool:
        """True when the event may interrupt the user.

        Inputs: none. Output: bool.
        """
        return self.suppressed_by is None


def resolve_toast_gate(
    event_kind: str,
    *,
    policy_store_attached: bool,
    policy: Optional[Any],
    subagent_depth: int,
    subagent_wait_active: bool = False,
    idle_notification_suppressed: bool = False,
) -> ToastGateVerdict:
    """Decide whether a toast-worthy hook event may interrupt the user.

    Inputs:
        event_kind: the hook event kind, already known to be a toast kind.
        policy_store_attached: whether a notification policy store is
            wired onto the session manager at all. False on a build
            without the feature, where the mute gate is skipped entirely
            and behaviour is exactly what it was before mute shipped.
        policy: the resolved policy object, or None. None means either
            "no policy could be read" or "the read threw"; both suppress,
            because an unanswered mute may not be read as "not muted".
        subagent_depth: the number of live sub-agents AS AT THIS EVENT,
            read before the event was applied. Anything that is not a
            positive count must arrive here as 0, which raises the toast.

    Output: a ``ToastGateVerdict``.

    Example::

        resolve_toast_gate(
            "Stop",
            policy_store_attached=False,
            policy=None,
            subagent_depth=2,
        ).suppressed_by
        # -> 'subagents_running'
    """
    if policy_store_attached and (policy is None or policy.suppresses):
        return ToastGateVerdict(
            suppressed_by=SUPPRESSED_NOTIFICATIONS_MUTED,
            log_event=LOG_MUTED,
            log_fields={
                "policy": getattr(policy, "verdict", "unreadable"),
                "policy_generation": getattr(policy, "generation", None),
            },
        )

    # TWO SOURCES OF ONE FACT, and the session is waiting on itself if
    # EITHER says so: the live depth covers the FIRST event of a
    # background wait, and the bounded latch covers the ones trailing it.
    # ``Stop`` resets the depth to 0, so the trailing idle
    # ``Notification`` about 60s later, and any second ``Stop`` behind
    # it, would find a depth of 0 and be raised. Both fail toward
    # notifying.
    if event_kind in SUBAGENT_GATE_KINDS and (
        subagent_depth > 0 or subagent_wait_active
    ):
        return ToastGateVerdict(
            suppressed_by=SUPPRESSED_SUBAGENTS_RUNNING,
            log_event=LOG_SUBAGENTS,
            log_fields={
                "subagent_depth": subagent_depth,
                "subagent_wait_latched": subagent_wait_active,
            },
        )

    # A CLEAN, UNANSWERED-FOR NUDGE, not a sub-agent wait. claude fires an
    # idle ``Notification`` about 60s after a turn that already ended
    # cleanly, with no sub-agent involved at all - measured live
    # 2026-09-10 on ses_63beb976, twelve consecutive Stop-then-
    # Notification pairs at plus 60.1s, every one rendered as a toast
    # summoning the user to a session that had nothing to ask. Same
    # false-urgency shape as the sub-agent gate, one layer broader.
    # ``PermissionRequest`` is deliberately absent from this branch too,
    # at any depth, for the same hard-block reason the module docstring
    # gives. The activity state machine is untouched: the session still
    # recorded the Notification and still resolves to ``notice``; only
    # the interruption is skipped.
    if event_kind == EVENT_NOTIFICATION and idle_notification_suppressed:
        return ToastGateVerdict(
            suppressed_by=IDLE_NOTIFICATION_SUPPRESSION_REASON,
            log_event=LOG_TURN_CLOSED,
            log_fields={},
        )

    return ToastGateVerdict()
