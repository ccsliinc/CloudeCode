"""Which of a session's open toasts a hook event has just ANSWERED.

PURE. Nothing here imports FastAPI, opens a database, touches a session
or reads a clock. It is handed a session's toast records, the kind of
hook event that just arrived, and the instant that event arrived, and it
answers one question: which record ids should now be acknowledged. Every
rule below is therefore testable without a server, a socket or a tmux
pane, which matters because the rules are about ORDERING and ordering
bugs are the ones a live test cannot reliably reproduce.

WHY THIS EXISTS. The owner's request, verbatim: "on the toasts, if its
waiting on me and i type into this browser or a remote control session,
the toasts should be removed, we can tell because i think when a new
prompt is sent it should trip a hook." He is right about the hook.
``UserPromptSubmit`` fires whenever a prompt is submitted to the agent,
whoever typed it and wherever they typed it - the browser terminal, a
remote control session, or the keyboard attached to the Mac. So the
event is a fact about the USER SHOWING UP, and a notification asking the
user to show up is answered the moment they do. Until now a toast could
only be cleared by clicking it, so a user who answered a permission
prompt by typing into the pane was left with a card claiming the agent
was still blocked on them.

THREE EVENTS ANSWER THINGS, AND THEY ANSWER DIFFERENT THINGS. This is
the whole content of the module, and each set is narrow on purpose:

  UserPromptSubmit - the user typed a prompt. That answers EVERYTHING
      the session was asking of them: a permission prompt they approved
      in the pane, a notification they read on their way past, a startup
      prompt they cleared to be able to type at all, and a "your turn"
      that they have plainly taken. This is the owner's case.
  PreToolUse - the agent is about to run a tool. That is proof a
      PERMISSION was granted, and proof of nothing else. It says nothing
      about a Notification the user has not read, and a notice cleared
      by a tool call the user never saw would be a notification silently
      destroyed. So this set has exactly one member.
  Stop - the turn ended. An agent cannot end a turn while blocked on a
      permission prompt, so any permission still marked open has been
      answered; a startup prompt is likewise plainly past. Notifications
      raised during the turn are cleared for the same reason
      ``session_activity`` clears ``notice_open`` on Stop: the turn they
      belonged to is over.

STOP NEVER ACKS A ``Stop`` TOAST, AND THAT IS STRUCTURAL RATHER THAN
POSITIONAL. Stop both RAISES a "your turn" toast and answers others, so
the obvious defect is a Stop dismissing the very card it just put on
screen. It would be tempting to rely on call order - ack before
recording, and the new toast cannot be seen - but that is a guarantee
that survives only until someone moves a line, and it fails outright for
a DUPLICATED Stop, whose predecessor's toast is a real unacked record by
the time the duplicate arrives. Excluding the kind instead makes the
property hold for every ordering, every duplicate and every future call
site: no Stop can ack any "your turn" toast, its own or anybody's. The
only thing that clears a "your turn" is the user turning up, which is
``UserPromptSubmit``, or a click.

THE CUTOFF IS THE EVENT'S OWN INSTANT, NOT THE ACK'S. Hook events are
unordered, duplicated and droppable (CLAUDE.md), so the moment this code
RUNS says nothing about when the thing it describes HAPPENED. A
``UserPromptSubmit`` redelivered late, or simply processed behind a
burst, must not acknowledge a toast raised by something that happened
AFTER the user typed - that would eat a genuinely new notification and
leave the user with no record of it. So the caller passes the instant
the hook POST arrived, captured before any state is mutated, and a
record newer than that instant is never touched. A toast raised after an
event cannot have been answered by it.

Note the interaction with supersession, which is safe by accident of
direction: ``SessionManager.record_toast`` refreshes ``created_at`` when
it replaces an unacked ``Stop`` in place, which only ever moves a record
FORWARD relative to an older cutoff. It can spare a record; it can never
expose one.

IDEMPOTENT BY CONSTRUCTION. Already-acknowledged records are filtered
out here, and ``SessionManager.ack_toast`` refuses a second ack anyway,
so the same event delivered ten times acks on the first and does nothing
nine times: no duplicate log lines, no duplicate WebSocket frames, no
history churn.
"""

from __future__ import annotations

from datetime import datetime
from typing import Iterable, List, Mapping, Optional, Sequence

from src.models import Toast

#: A human clicked the x, or a sweep control the human operated. The
#: DEFAULT for ``SessionManager.ack_toast``, so every pre-existing caller
#: keeps recording exactly what it always meant.
ACK_REASON_DISMISSED = "dismissed"

#: The user turned up and dealt with it, and a hook said so. Written only
#: by this path. The distinction is the point: "I dealt with it" and "it
#: got cleared for me" are different facts about the same record, and
#: until now the history could not tell them apart because nothing
#: stamped a reason (docs/notifications.md open item 2).
ACK_REASON_ANSWERED = "answered"

#: Toast kinds, restated here as the vocabulary this module partitions.
#: Imported from nowhere on purpose: ``session_startup_gate`` owns
#: ``STARTUP_TOAST_KIND`` and the other three are the hook event names,
#: so a single import would not cover the set and four would put a
#: circular import on the hook critical path for four string literals.
KIND_STOP = "Stop"
KIND_PERMISSION = "PermissionRequest"
KIND_NOTIFICATION = "Notification"
KIND_STARTUP_PROMPT = "StartupPrompt"

#: Which toast kinds each hook event ANSWERS. An event kind absent from
#: this mapping answers nothing, which is the overwhelmingly common case
#: (PostToolUse, SubagentStart, SubagentStop, the lifecycle pair) and is
#: why the resolver's first act is a dict lookup that usually misses.
#:
#: THE ASYMMETRY IS THE DESIGN. See the module docstring for why
#: PreToolUse has exactly one member and why ``Stop`` is absent from
#: every set except the prompt's.
AUTO_ACK_KINDS: Mapping[str, frozenset] = {
    "UserPromptSubmit": frozenset(
        {KIND_STOP, KIND_PERMISSION, KIND_NOTIFICATION, KIND_STARTUP_PROMPT}
    ),
    "PreToolUse": frozenset({KIND_PERMISSION}),
    KIND_STOP: frozenset({KIND_PERMISSION, KIND_NOTIFICATION, KIND_STARTUP_PROMPT}),
}


def kinds_answered_by(event_kind: str) -> frozenset:
    """Return the toast kinds a hook event of this kind answers.

    Description: the ONE reader of ``AUTO_ACK_KINDS``, so "does this
        event answer anything" has a single spelling. An unknown or
        unmapped event kind yields an empty set rather than raising -
        the hook endpoint accepts a documented list of event kinds and
        this module must never be the reason one of them fails.
    Inputs:
        event_kind: the hook event kind as received, e.g. "PreToolUse".
    Output: frozenset[str] - toast kinds answered, possibly empty.
    Example:
        >>> sorted(kinds_answered_by("PreToolUse"))
        ['PermissionRequest']
        >>> kinds_answered_by("PostToolUse")
        frozenset()
    """
    return AUTO_ACK_KINDS.get(event_kind, frozenset())


def resolve_auto_acks(
    records: Sequence[Toast],
    event_kind: str,
    *,
    cutoff: Optional[datetime] = None,
) -> List[str]:
    """Return the ids of the toasts this hook event has answered.

    Description: the whole rule set, as a filter over one session's
        records. A record is answered when it is still open, its kind is
        one this event answers, and it was raised at or before the
        instant the event arrived. Order of the returned ids follows the
        order of ``records`` (newest-first as the bucket is stored),
        which makes the result deterministic and therefore assertable.
    Inputs:
        records: one session's Toast records, in any order.
        event_kind: the hook event kind that just arrived.
        cutoff: the instant that event arrived, as a NAIVE UTC datetime
            to match ``Toast.created_at``. None means "do not apply the
            ordering guard", which is correct only for a caller that has
            no event instant to offer; the hook route always has one.
    Output: list[str] - toast ids to acknowledge. Empty is the common
        answer and never an error.
    Example:
        >>> resolve_auto_acks([], "UserPromptSubmit")
        []
    """
    kinds = kinds_answered_by(event_kind)
    if not kinds:
        return []
    answered: List[str] = []
    for toast in records or ():
        if toast is None or toast.acknowledged:
            continue
        if toast.kind not in kinds:
            continue
        if cutoff is not None and _raised_after(toast, cutoff):
            # RAISED AFTER THE EVENT, so this event cannot have answered
            # it. See the module docstring: a late or redelivered hook
            # must not eat a notification about something that happened
            # after the user acted.
            continue
        answered.append(toast.id)
    return answered


def _raised_after(toast: Toast, cutoff: datetime) -> bool:
    """Was this record raised strictly after the event's own instant?

    Description: the ordering guard, isolated so the one comparison that
        can raise is in one place. A record whose ``created_at`` cannot
        be compared against the cutoff (a naive/aware mismatch from a
        caller that built its own cutoff) is treated as NOT after, which
        keeps the feature working rather than making a timezone slip
        silently disable every auto-ack. The guard is a refinement on
        top of the kind rules, never the thing holding them up.
    Inputs: toast (Toast). cutoff (datetime).
    Output: bool - True when the record is newer than the event.
    """
    created = getattr(toast, "created_at", None)
    if created is None:
        return False
    try:
        return created > cutoff
    except TypeError:
        # Naive vs aware. Documented above: degrade to "not after".
        return False


def describe(event_kind: str, acked_ids: Iterable[str]) -> dict:
    """Summarise one auto-ack pass for a structured log line.

    Description: keeps the log call at the seam to one argument and
        keeps the vocabulary here with the rules it describes. Reports
        the COUNT and the event, never the toast bodies - a toast body
        carries the tail of what Claude said, which is the owner's work
        and does not belong in a log.
    Inputs: event_kind (str). acked_ids (iterable of str).
    Output: dict suitable for ``**kwargs`` into structlog.
    Example:
        >>> describe("PreToolUse", ["a"])
        {'event_kind': 'PreToolUse', 'answered': 1, 'reason': 'answered'}
    """
    return {
        "event_kind": event_kind,
        "answered": len(list(acked_ids)),
        "reason": ACK_REASON_ANSWERED,
    }
