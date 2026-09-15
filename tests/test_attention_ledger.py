"""The edge detector's five rules, one test each, plus the controls.

EVERY RULE HERE EXISTS BECAUSE OF A MEASURED DEFECT, so every test names
the defect it stops rather than restating the code. The two controls at
the end are the ones that matter most: a green check that has never been
shown to go red is not a check (gotcha 11), so the settle test asserts
BOTH that a too-soon second sighting is held AND that a late-enough one
passes, and the emit-once test asserts BOTH that a repeat is silent AND
that a real change is not.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.core.attention.evidence import (
    AttentionVerdict,
    REASON_INPUT,
    REASON_PERMISSION,
    REASON_QUESTION,
    REASON_STREAMING,
    REASON_SUBAGENTS,
    REASON_TURN_ENDED,
    REASON_NO_EVIDENCE,
    STATE_BUSY,
    STATE_DONE_IDLE,
    STATE_NEEDS_USER,
    STATE_UNKNOWN,
    TIER_PANE,
    TIER_REGISTRY,
    TIER_TRANSCRIPT,
)
from src.core.attention.ledger import AttentionLedger
from src.core.attention.resolve import DONE_QUIET_SECONDS, SETTLE_SECONDS
from src.core.unread_store import UnreadStore

#: A fixed instant, so nothing in this file reads a clock.
T0 = datetime(2026, 9, 13, 12, 0, 0, tzinfo=timezone.utc)

#: The key shape the ledger is contracted to, built the same way the
#: unread flag builds it. Spelled through UnreadStore rather than typed,
#: because the two must never disagree about what an instance is.
KEY = UnreadStore.compose_key("cloude_Sauna", 1757000000)


def at(seconds: float) -> datetime:
    """``seconds`` after T0. Inputs: seconds (float). Output: datetime."""
    return T0 + timedelta(seconds=seconds)


def busy(reason: str = REASON_STREAMING) -> AttentionVerdict:
    """A registry-decided busy verdict, which needs no settle.

    Inputs: reason (str). Output: AttentionVerdict.
    """
    return AttentionVerdict(
        state=STATE_BUSY, reason=reason, tier=TIER_REGISTRY, settle_required=False
    )


def done() -> AttentionVerdict:
    """A registry-decided done_idle verdict. Output: AttentionVerdict."""
    return AttentionVerdict(
        state=STATE_DONE_IDLE,
        reason=REASON_TURN_ENDED,
        tier=TIER_REGISTRY,
        pending_background_agents=0,
        settle_required=False,
    )


def needs_user(
    reason: str = REASON_QUESTION, *, settle: bool = True
) -> AttentionVerdict:
    """A needs_user verdict, settle-required by default.

    Inputs: reason (str), settle (bool). Output: AttentionVerdict.
    """
    return AttentionVerdict(
        state=STATE_NEEDS_USER,
        reason=reason,
        tier=TIER_PANE if settle else TIER_REGISTRY,
        settle_required=settle,
    )


def unknown() -> AttentionVerdict:
    """An unknown verdict. Output: AttentionVerdict."""
    return AttentionVerdict(
        state=STATE_UNKNOWN, reason=REASON_NO_EVIDENCE, tier=TIER_TRANSCRIPT
    )


# ---------------------------------------------------------------------
# Rule 1: first sight is a baseline
# ---------------------------------------------------------------------


def test_first_sight_of_a_key_is_a_baseline_and_raises_nothing():
    """The defect: a restart read every surviving session and toasted."""
    ledger = AttentionLedger()
    assert ledger.observe(KEY, done(), T0) is None
    assert ledger.confirmed_state(KEY) == STATE_DONE_IDLE


def test_a_tick_of_already_idle_sessions_after_a_restart_raises_nothing():
    """THE RESTART BASELINE. A fresh ledger, twelve finished sessions."""
    ledger = AttentionLedger()
    keys = [UnreadStore.compose_key("cloude_s%d" % i, 1757000000) for i in range(12)]
    first = [ledger.observe(key, done(), T0) for key in keys]
    assert first == [None] * 12
    # And the SECOND tick is silent too: nothing changed, so there is no
    # news, which is the half a "first sight only" rule would miss.
    second = [ledger.observe(key, done(), at(2)) for key in keys]
    assert second == [None] * 12


def test_the_baseline_state_is_still_news_after_a_real_detour():
    """A baseline suppresses the FIRST sighting, not the state forever."""
    ledger = AttentionLedger()
    assert ledger.observe(KEY, done(), T0) is None
    assert ledger.observe(KEY, busy(), at(2)) is not None
    edge = ledger.observe(KEY, done(), at(4))
    assert edge is not None
    assert edge.state == STATE_DONE_IDLE
    assert edge.previous_state == STATE_BUSY


# ---------------------------------------------------------------------
# Rule 2: a settle-required verdict must be seen twice
# ---------------------------------------------------------------------


def test_a_settle_required_verdict_is_held_on_its_first_sighting():
    """The defect: capture-pane catching a dialog half drawn."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    assert ledger.observe(KEY, needs_user(), at(1)) is None


def test_a_settle_required_verdict_is_still_held_just_under_the_window():
    """CAN THIS CHECK GO RED. Just under SETTLE_SECONDS must not pass."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    ledger.observe(KEY, needs_user(), at(1))
    assert ledger.observe(KEY, needs_user(), at(1 + SETTLE_SECONDS - 0.01)) is None


def test_a_settle_required_verdict_transitions_on_the_second_sighting():
    """And the same pair, SETTLE_SECONDS apart, does transition."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    ledger.observe(KEY, needs_user(), at(1))
    edge = ledger.observe(KEY, needs_user(), at(1 + SETTLE_SECONDS))
    assert edge is not None
    assert (edge.state, edge.reason) == (STATE_NEEDS_USER, REASON_QUESTION)


def test_a_different_verdict_in_between_resets_the_settle():
    """The defect: two half-read screens adding up to one confirmation."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    assert ledger.observe(KEY, needs_user(REASON_QUESTION), at(1)) is None
    assert ledger.observe(KEY, needs_user(REASON_PERMISSION), at(2)) is None
    # The question is now only one sighting old again, not two.
    assert ledger.observe(KEY, needs_user(REASON_QUESTION), at(3)) is None
    edge = ledger.observe(KEY, needs_user(REASON_QUESTION), at(3 + SETTLE_SECONDS))
    assert edge is not None


def test_a_registry_decided_verdict_needs_no_settle_at_all():
    """settle_required is the resolver's word, and the ledger obeys it."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    edge = ledger.observe(KEY, needs_user(REASON_INPUT, settle=False), at(0.1))
    assert edge is not None
    assert edge.reason == REASON_INPUT


# ---------------------------------------------------------------------
# Rule 3: done_idle needs quiet
# ---------------------------------------------------------------------


def test_done_idle_is_held_until_the_transcript_has_been_quiet():
    """The defect: reading the 25 ms gap between two records as rest."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    held = ledger.observe(
        KEY, done(), at(10), last_append_at=at(10 - DONE_QUIET_SECONDS + 0.5)
    )
    assert held is None


def test_done_idle_passes_once_the_quiet_window_has_elapsed():
    """And the same reading, a moment later, is an edge."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    ledger.observe(KEY, done(), at(10), last_append_at=at(9))
    edge = ledger.observe(
        KEY, done(), at(12), last_append_at=at(12 - DONE_QUIET_SECONDS)
    )
    assert edge is not None
    assert edge.state == STATE_DONE_IDLE


def test_an_unmeasurable_append_time_skips_the_quiet_gate():
    """None means could not measure, and the resolver already gated it.

    Refusing here as well would silence a finished session forever.
    """
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    assert ledger.observe(KEY, done(), at(10), last_append_at=None) is not None


def test_the_quiet_gate_does_not_apply_to_any_other_state():
    """Only done_idle waits for quiet; a question must reach the user."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    edge = ledger.observe(
        KEY, needs_user(REASON_INPUT, settle=False), at(10), last_append_at=at(9.9)
    )
    assert edge is not None


# ---------------------------------------------------------------------
# Rule 4: a flicker through unknown freezes the entry
# ---------------------------------------------------------------------


def test_unknown_raises_nothing_and_confirms_nothing():
    """unknown is a failure to observe, not an observation."""
    ledger = AttentionLedger()
    assert ledger.observe(KEY, unknown(), T0) is None
    assert ledger.confirmed_state(KEY) is None


def test_a_flicker_through_unknown_cannot_manufacture_a_second_edge():
    """The defect: a file being rewritten reading as a new state."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    ledger.observe(KEY, done(), at(4), last_append_at=T0)
    assert ledger.observe(KEY, unknown(), at(6)) is None
    # Back to the same state. The entry was frozen, so this is not news.
    assert ledger.observe(KEY, done(), at(8), last_append_at=T0) is None
    assert ledger.confirmed_state(KEY) == STATE_DONE_IDLE


def test_unknown_does_not_reset_a_settle_in_progress():
    """Freezing is freezing: a failed read is not a different verdict."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    assert ledger.observe(KEY, needs_user(), at(1)) is None
    assert ledger.observe(KEY, unknown(), at(1.5)) is None
    edge = ledger.observe(KEY, needs_user(), at(1 + SETTLE_SECONDS))
    assert edge is not None


def test_unknown_as_the_very_first_reading_still_leaves_a_baseline_owed():
    """An entry exists, but nothing is confirmed, so the next real
    reading is still the baseline and still raises nothing."""
    ledger = AttentionLedger()
    ledger.observe(KEY, unknown(), T0)
    assert ledger.observe(KEY, done(), at(2)) is None
    assert ledger.confirmed_state(KEY) == STATE_DONE_IDLE


# ---------------------------------------------------------------------
# Rule 5: one edge per (key, state, reason) until the state moves
# ---------------------------------------------------------------------


def test_a_state_that_holds_raises_exactly_once():
    """The defect: a ten minute permission prompt as three hundred asks."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    ledger.observe(KEY, needs_user(), at(1))
    edges = [
        ledger.observe(KEY, needs_user(), at(1 + SETTLE_SECONDS + n))
        for n in range(0, 300, 2)
    ]
    assert len([edge for edge in edges if edge is not None]) == 1


def test_a_new_reason_inside_one_state_is_news():
    """needs_user(input) becoming needs_user(permission) is a different
    question, and the user is told about the new one."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    first = ledger.observe(KEY, needs_user(REASON_INPUT, settle=False), at(1))
    second = ledger.observe(KEY, needs_user(REASON_PERMISSION, settle=False), at(2))
    assert first is not None and second is not None
    assert second.reason == REASON_PERMISSION


def test_the_emitted_set_is_cleared_when_the_state_actually_moves():
    """The same ask after a real detour is news again."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    soft = needs_user(REASON_INPUT, settle=False)
    assert ledger.observe(KEY, soft, at(1)) is not None
    assert ledger.observe(KEY, busy(REASON_SUBAGENTS), at(2)) is not None
    assert ledger.observe(KEY, soft, at(3)) is not None


def test_a_busy_reason_change_is_an_edge_but_the_state_does_not_move():
    """busy(streaming) to busy(subagents): the previous state is busy."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(REASON_STREAMING), T0)
    edge = ledger.observe(KEY, busy(REASON_SUBAGENTS), at(2))
    assert edge is not None
    assert edge.previous_state == STATE_BUSY


# ---------------------------------------------------------------------
# Keying and forgetting
# ---------------------------------------------------------------------


def test_two_instances_of_one_tmux_name_are_two_keys():
    """Gotcha 4b and 10: the instance is the identity, not the name."""
    ledger = AttentionLedger()
    old = UnreadStore.compose_key("cloude_a", 1757000000)
    new = UnreadStore.compose_key("cloude_a", 1757999999)
    assert old != new
    assert ledger.observe(old, done(), T0) is None
    # The new instance has never been seen, so IT gets a baseline too
    # rather than inheriting the old conversation's confirmed state.
    assert ledger.observe(new, needs_user(settle=False), at(1)) is None


def test_forget_drops_the_entry_so_the_next_sighting_is_a_baseline():
    """A destroyed session must not lend an edge to the next one."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    ledger.forget(KEY)
    assert ledger.confirmed_state(KEY) is None
    assert ledger.observe(KEY, done(), at(2)) is None


def test_forget_is_idempotent_on_a_key_never_seen():
    """Inputs: none. A key that was never observed is not an error."""
    ledger = AttentionLedger()
    ledger.forget("never-seen")
    assert ledger.tracked_keys() == ()


def test_tracked_keys_reports_what_the_ledger_is_holding():
    """For logs and for a test that wants to assert a leak."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    ledger.observe("other@1", busy(), T0)
    assert set(ledger.tracked_keys()) == {KEY, "other@1"}


def test_a_naive_clock_cannot_crash_the_ledger():
    """A watcher that raises stops every notification on the machine, so
    an interval that cannot be measured is one that has not elapsed."""
    ledger = AttentionLedger()
    ledger.observe(KEY, busy(), T0)
    ledger.observe(KEY, needs_user(), at(1))
    naive = datetime(2026, 9, 13, 12, 0, 30)
    assert ledger.observe(KEY, needs_user(), naive) is None
