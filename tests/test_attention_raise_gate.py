"""The one gate that can silence an attention toast, as a pure ladder.

REHOMED FROM ``tests/test_hook_toast_gate.py`` ON 2026-09-13. That file
tested two gates. The sub-agent depth gate and the idle-nudge latch went
with the hook subsystem: both were guesses about whether a session was
really waiting on the user, made from an in-memory counter fed by a
pane-wide session id that every background agent also posted under, and
measured over 50.8 hours of the live log the counter was wrong 410 times
in 459. The question they tried to answer is now answered by
``src.core.attention.resolve`` from what the harness writes to disk,
BEFORE a toast is ever considered.

The MUTE cases moved here unchanged, because the mute did not change: it
is the user's own explicit instruction about one session, and by the time
this gate is consulted the session has already been measured as needing
them.

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

from src.core.attention.raise_gate import (
    LOG_MUTED,
    SUPPRESSED_NOTIFICATIONS_MUTED,
    TOAST_KINDS,
    resolve_raise,
)
from src.core.session_activity import (
    EVENT_NOTIFICATION,
    EVENT_PERMISSION_REQUEST,
    EVENT_STOP,
)


@dataclass(frozen=True)
class _Policy:
    """A notification policy double, shaped like the real one reads."""

    suppresses: bool
    verdict: str = "muted"
    generation: Optional[int] = 7


def _gate(kind, *, store=False, policy=None):
    """Call the gate with the defaults most cases want.

    Inputs: kind (str); store (bool) whether a policy store is attached;
      policy (object | None).
    Output: RaiseVerdict.
    """
    return resolve_raise(kind, policy_store_attached=store, policy=policy)


# --- the cases that must RAISE. These are the negative controls. --------


@pytest.mark.parametrize(
    "kind", [EVENT_STOP, EVENT_NOTIFICATION, EVENT_PERMISSION_REQUEST]
)
def test_a_session_with_no_policy_store_always_raises(kind):
    """The baseline: nothing configured, toast goes out."""
    verdict = _gate(kind)
    assert verdict.raises_toast
    assert verdict.suppressed_by is None
    assert verdict.log_event is None


@pytest.mark.parametrize(
    "kind", [EVENT_STOP, EVENT_NOTIFICATION, EVENT_PERMISSION_REQUEST]
)
def test_a_policy_that_does_not_suppress_raises(kind):
    """An explicitly un-muted session is not silenced by the mute gate."""
    assert _gate(kind, store=True, policy=_Policy(suppresses=False)).raises_toast


def test_an_unreadable_policy_with_NO_store_attached_still_raises():
    """A build without the feature behaves exactly as it did before mute.

    This is the case the ``policy_store_attached`` flag exists for: None
    means "unreadable" only once a store is actually present. Without the
    flag, every session on such a build would be silently muted.
    """
    assert _gate(EVENT_STOP, store=False, policy=None).raises_toast


# --- the cases that must SUPPRESS --------------------------------------


@pytest.mark.parametrize(
    "kind", [EVENT_STOP, EVENT_NOTIFICATION, EVENT_PERMISSION_REQUEST]
)
def test_a_mute_covers_every_toast_kind_including_a_permission(kind):
    """The control does what its label says, or it does not do anything.

    A permission-class toast is the hard block - claude has stopped
    mid-turn and cannot continue until a human answers - and it is the
    one ask nothing else may silence. A mute is the user answering that
    in advance, for this session, so exempting a kind from it would mean
    the session the user muted still interrupts them.
    """
    verdict = _gate(kind, store=True, policy=_Policy(suppresses=True))
    assert verdict.suppressed_by == SUPPRESSED_NOTIFICATIONS_MUTED
    assert verdict.log_event == LOG_MUTED
    assert verdict.log_fields == {
        "policy": "muted",
        "policy_generation": 7,
        "toast_kind": kind,
    }


def test_an_unreadable_policy_suppresses_once_a_store_is_attached():
    """A read that did not answer may not be read as "not muted".

    The opposite posture from every refusal in the resolver, on purpose:
    here the user has already asked for silence, and guessing they did
    not mean it sends a push to a phone that cannot be recalled.
    """
    verdict = _gate(EVENT_STOP, store=True, policy=None)
    assert verdict.suppressed_by == SUPPRESSED_NOTIFICATIONS_MUTED
    assert verdict.log_fields["policy"] == "unreadable"
    assert verdict.log_fields["policy_generation"] is None


# --- the shape of the answer -------------------------------------------


def test_the_kind_is_recorded_and_never_branched_on():
    """Every kind gets the identical verdict for the identical policy.

    The signature takes the kind so the log line can name it and so the
    caller cannot assume some kind is exempt. If a branch on kind ever
    appears, this is what catches it.
    """
    suppressed = {
        kind: _gate(kind, store=True, policy=_Policy(suppresses=True)).suppressed_by
        for kind in TOAST_KINDS
    }
    assert set(suppressed.values()) == {SUPPRESSED_NOTIFICATIONS_MUTED}


def test_the_three_toast_kinds_are_the_vocabulary_and_not_re_spelled():
    """One table for the event names, imported rather than duplicated."""
    assert TOAST_KINDS == frozenset(
        {EVENT_STOP, EVENT_NOTIFICATION, EVENT_PERMISSION_REQUEST}
    )
