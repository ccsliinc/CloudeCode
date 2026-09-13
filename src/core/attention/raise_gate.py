"""Whether one attention transition may interrupt the user.

THE MUTE BRANCH OF ``hook_toast_gate.py``, AND NOTHING ELSE. The other
two branches of that module, the sub-agent depth gate and the idle-nudge
latch, are DELETED rather than moved: both were guesses about whether a
session was really waiting on the user, made from an in-memory counter
fed by a pane-wide session id that every background agent also posted
under. That counter was wrong nine times in ten (410 of 459 attributable
toasts over a measured 50.8 hours) and no ordering fix could move the
number, because its INPUT was mislabeled at the source. The question
those branches tried to answer is now answered by
:func:`src.core.attention.resolve.resolve_attention` from what the
harness writes to disk, one tier at a time, before a toast is ever
considered. By the time this module is consulted the session has already
been measured as needing the user; the only question left is whether the
user asked not to be told.

So there is ONE gate here, and the rules it carries are the originals.

**Mute covers every toast kind, including ``PermissionRequest``.** The
old sub-agent gate exempted permission prompts because a blocked session
genuinely does want the user. A mute is the user answering that in
advance, for this session, and exempting a kind from it would mean the
control does not do what its label says. A permission-class toast is
therefore never suppressed by ANYTHING except this explicit per-session
mute.

**An UNREADABLE policy SUPPRESSES.** The user has already asked for
silence and guessing "they did not mean it" sends a push to a phone that
cannot be recalled. This is the opposite posture from every refusal in
the resolver, which fails toward telling the user, and the difference is
the point: silence there is only ever bought with evidence, silence here
was bought in advance by an instruction.

**SUPPRESSING IS NOT ACKNOWLEDGING, and that is the load-bearing half.**
The ledger has already recorded the transition by the time this is
consulted, so a suppressed transition still moves the session's state,
still paints the light, and still flips unread on a ``done_idle``. What
is skipped is the interruption, never the record. A mute that quietly
marked a pending permission answered would strand claude mid-turn behind
a yes/no nobody was told about.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from src.core.session_activity import (
    EVENT_NOTIFICATION,
    EVENT_PERMISSION_REQUEST,
    EVENT_STOP,
)

#: The ``toast_suppressed`` value returned when the user muted the
#: session. The same string the hook route returned, so a client or a
#: log grep that already knows it keeps working.
SUPPRESSED_NOTIFICATIONS_MUTED: str = "notifications_muted"

#: The structlog event name emitted when the mute fires, kept here beside
#: the branch that emits it so the string a grep looks for cannot drift
#: from the rule that produces it.
LOG_MUTED: str = "attention_toast_suppressed_notifications_muted"

#: The three toast kinds this gate can be asked about. Imported rather
#: than spelled so the vocabulary stays in one place.
TOAST_KINDS: frozenset = frozenset(
    {EVENT_STOP, EVENT_NOTIFICATION, EVENT_PERMISSION_REQUEST}
)


@dataclass(frozen=True)
class RaiseVerdict:
    """What the watcher should do with one toast-worthy transition.

    Description: carries the decision AND the log line that explains it,
      already resolved, so the caller adds only the session id and the
      kind. Frozen because it reports a decision, not a plan.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    #: None to raise the toast, otherwise the ``toast_suppressed`` value
    #: naming which rule silenced it. Exactly one rule exists today.
    suppressed_by: Optional[str] = None

    #: The structlog event name to emit, None when nothing is suppressed.
    log_event: Optional[str] = None

    #: The extra structlog keyword arguments for that line.
    log_fields: Dict[str, Any] = field(default_factory=dict)

    @property
    def raises_toast(self) -> bool:
        """True when this transition may interrupt the user.

        Description: the one-line test every call site reads, so no
          caller has to remember that None means raise.
        Inputs: none beyond ``self``.
        Output: bool.
        Example: RaiseVerdict().raises_toast -> True
        """
        return self.suppressed_by is None


def resolve_raise(
    kind: str, *, policy_store_attached: bool, policy: Any
) -> RaiseVerdict:
    """Decide whether a toast-worthy transition may interrupt the user.

    Description: PURE and TOTAL. Reads no clock, opens no file and
      touches no session, so the rule is testable without a policy store,
      a live pane or a running watcher, which is what it needed: it used
      to be reachable only through an HTTP POST.

      The ``kind`` is accepted and DELIBERATELY not branched on. It is
      here because the caller logs it and because the signature has to
      make it obvious that no kind is exempt: the mute is explicit and
      per-session, so it silences ``PermissionRequest`` exactly as it
      silences ``Stop``.
    Inputs:
      kind: the toast kind about to be raised, one of
        :data:`TOAST_KINDS`. Recorded, never tested.
      policy_store_attached: whether a notification policy store is wired
        onto the session manager at all. False on a build without the
        feature, where this gate is skipped entirely and behaviour is
        exactly what it was before mute shipped.
      policy: the resolved policy object, or None. None means either "no
        policy could be read" or "the read threw", and BOTH SUPPRESS: an
        unanswered mute may not be read as "not muted".
    Output:
      RaiseVerdict - ``suppressed_by`` None to raise.
    Example:
      resolve_raise("Stop", policy_store_attached=False,
                    policy=None).raises_toast
      # -> True
    """
    if policy_store_attached and (policy is None or policy.suppresses):
        return RaiseVerdict(
            suppressed_by=SUPPRESSED_NOTIFICATIONS_MUTED,
            log_event=LOG_MUTED,
            log_fields={
                # An unreadable policy has no verdict to name, and
                # saying so is better than reporting a blank: the log
                # line is how a support question about a missing toast
                # is answered.
                "policy": getattr(policy, "verdict", "unreadable"),
                "policy_generation": getattr(policy, "generation", None),
                "toast_kind": kind,
            },
        )
    return RaiseVerdict()
