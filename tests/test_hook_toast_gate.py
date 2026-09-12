"""The two gates that can silence a hook toast, tested as a pure ladder.

Every rule here used to be reachable only through an HTTP POST with a
live session manager and a policy store attached, which is why the
ordering between the two gates had no test of its own at all. Slice S6
lifted the decision into ``src/core/hook_toast_gate.py``; these are its
assertions.

THE NEGATIVE CONTROLS ARE THE LOAD-BEARING HALF. A gate that suppressed
broadly would pass every "it went quiet" test perfectly and would be the
false-silence failure this project already paid for, where a session that
genuinely wanted the user looked exactly like one that did not. So the
cases that must RAISE are asserted as hard as the cases that must not.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import pytest

from src.core.hook_toast_gate import (
    LOG_MUTED,
    LOG_SUBAGENTS,
    SUPPRESSED_NOTIFICATIONS_MUTED,
    SUPPRESSED_SUBAGENTS_RUNNING,
    resolve_toast_gate,
)
from src.core.session_activity import EVENT_NOTIFICATION, EVENT_STOP

EVENT_PERMISSION = "PermissionRequest"


@dataclass(frozen=True)
class _Policy:
    """A notification policy double, shaped like the real one reads."""

    suppresses: bool
    verdict: str = "muted"
    generation: Optional[int] = 7


def _gate(kind, *, store=False, policy=None, depth=0):
    """Call the ladder with the defaults most cases want.

    Inputs: kind (str); store (bool) whether a policy store is attached;
      policy (object | None); depth (int) live sub-agents at this event.
    Output: ToastGateVerdict.
    """
    return resolve_toast_gate(
        kind, policy_store_attached=store, policy=policy, subagent_depth=depth
    )


# --- the cases that must RAISE. These are the negative controls. --------


@pytest.mark.parametrize("kind", [EVENT_STOP, EVENT_NOTIFICATION, EVENT_PERMISSION])
def test_a_quiet_session_with_no_policy_store_always_raises(kind):
    """The baseline: nothing configured, nothing running, toast goes out."""
    verdict = _gate(kind)
    assert verdict.raises_toast
    assert verdict.suppressed_by is None
    assert verdict.log_event is None


@pytest.mark.parametrize("kind", [EVENT_STOP, EVENT_NOTIFICATION, EVENT_PERMISSION])
def test_a_policy_that_does_not_suppress_raises(kind):
    """An explicitly un-muted session is not silenced by the mute gate."""
    assert _gate(kind, store=True, policy=_Policy(suppresses=False)).raises_toast


def test_a_permission_is_never_silenced_by_the_subagent_gate():
    """The hard block. claude has STOPPED and cannot continue.

    A permission prompt is the one ask that stays true no matter how much
    else is still running, so depth does not reach it at any value.
    """
    for depth in (1, 2, 99):
        verdict = _gate(EVENT_PERMISSION, depth=depth)
        assert verdict.raises_toast, f"suppressed a permission at depth {depth}"


def test_a_zero_depth_raises_even_for_the_gated_kinds():
    """Silence is only ever bought with a POSITIVE count of sub-agents.

    An unknown depth, a dropped ``SubagentStart`` and a read that threw
    all arrive here as 0, and every one of them must notify: a missed
    "your turn" is a worse failure than a spurious one.
    """
    assert _gate(EVENT_STOP, depth=0).raises_toast
    assert _gate(EVENT_NOTIFICATION, depth=0).raises_toast


def test_a_negative_depth_is_not_read_as_running():
    """A floored counter that underflowed must not buy silence."""
    assert _gate(EVENT_STOP, depth=-1).raises_toast


def test_an_unreadable_policy_with_NO_store_attached_still_raises():
    """A build without the feature behaves exactly as it did before mute.

    This is the case the ``policy_store_attached`` flag exists for: None
    means "unreadable" only once a store is actually present. Without the
    flag, every session on such a build would be silently muted.
    """
    assert _gate(EVENT_STOP, store=False, policy=None).raises_toast


# --- the cases that must SUPPRESS --------------------------------------


@pytest.mark.parametrize("kind", [EVENT_STOP, EVENT_NOTIFICATION, EVENT_PERMISSION])
def test_a_mute_covers_every_toast_kind_including_a_permission(kind):
    """The control does what its label says, or it does not do anything.

    Exempting a kind from an explicit user instruction would mean the
    session the user muted still interrupts them.
    """
    verdict = _gate(kind, store=True, policy=_Policy(suppresses=True))
    assert verdict.suppressed_by == SUPPRESSED_NOTIFICATIONS_MUTED
    assert verdict.log_event == LOG_MUTED
    assert verdict.log_fields == {"policy": "muted", "policy_generation": 7}


def test_an_unreadable_policy_suppresses_once_a_store_is_attached():
    """A read that did not answer may not be read as "not muted".

    The opposite posture from the sub-agent gate, on purpose: here the
    user has already asked for silence, and guessing they did not mean it
    sends a push to a phone that cannot be recalled.
    """
    verdict = _gate(EVENT_STOP, store=True, policy=None)
    assert verdict.suppressed_by == SUPPRESSED_NOTIFICATIONS_MUTED
    assert verdict.log_fields["policy"] == "unreadable"
    assert verdict.log_fields["policy_generation"] is None


@pytest.mark.parametrize("kind", [EVENT_STOP, EVENT_NOTIFICATION])
def test_live_subagents_silence_a_stop_and_a_notification(kind):
    """While sub-agents run the session is waiting on itself."""
    verdict = _gate(kind, depth=2)
    assert verdict.suppressed_by == SUPPRESSED_SUBAGENTS_RUNNING
    assert verdict.log_event == LOG_SUBAGENTS
    assert verdict.log_fields == {
        "subagent_depth": 2,
        "subagent_wait_latched": False,
    }


# --- the ORDER between them, which had no test at all before -----------


def test_mute_is_reported_when_both_gates_would_fire():
    """An explicit instruction is the more informative reason.

    Both gates end in the same silence, so the only thing that
    distinguishes them is the log line, and an operator reading
    "subagents_running" for a session the user muted a week ago has been
    sent to look at the wrong thing.
    """
    verdict = _gate(EVENT_STOP, store=True, policy=_Policy(suppresses=True), depth=3)
    assert verdict.suppressed_by == SUPPRESSED_NOTIFICATIONS_MUTED
    assert verdict.log_event == LOG_MUTED


def test_the_two_suppression_reasons_are_distinct_strings():
    """They are two answers, not one with a flag, and greps depend on it."""
    assert SUPPRESSED_NOTIFICATIONS_MUTED != SUPPRESSED_SUBAGENTS_RUNNING
    assert LOG_MUTED != LOG_SUBAGENTS
