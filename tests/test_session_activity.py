"""What survived ``src.core.session_activity`` when the hooks were deleted.

THIS FILE USED TO BE 57 TESTS OF A HOOK-DRIVEN STATE MACHINE: a sub-agent
depth counter, a tool-use heartbeat, a turn-open boolean, a suppression
latch, and the priority ladder that resolved them into a display state.
All of it went on 2026-09-13. ``CLOUDECODE_SESSION_ID`` is a PANE-WIDE
environment variable, so the parent agent and every background agent it
spawned posted their hooks under one session id; measured over 50.8 hours
of the live server log the counter reported 410 of 459 attributable
turn-ends as finished while the transcript's own record said background
agents were still pending. The INPUT was mislabeled at the source, so no
ordering fix inside the machine could have moved the number.

The same question is answered now by ``src.core.attention``, which reads
what the harness already writes to disk. Its ladder is tested in
``tests/test_attention_resolve.py`` and replayed against the real
production window in ``tests/test_attention_replay.py``.

THREE THINGS SURVIVED AND THESE ARE THEIR TESTS.

  * ``map_tmux_fallback``, the graceful-degradation path for a session
    with no evidence beyond what tmux can see. Its load-bearing case is
    the one that looks wrong: a RUNNING pane answers ``unknown``, not
    ``working``.
  * ``WORKING_HEARTBEAT_TIMEOUT_SECONDS``, which three other modules
    import so the durable row, the transcript read and the alert contract
    all judge staleness by one window.
  * The permission and notice CLAIM STORE, whose readers are the view
    seam and the pane re-verify. It has no writer today - see the
    module's own docstring - so these assert the clears against state
    installed directly, which is what the readers will see once a passive
    writer supplies one.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from src.core.session_activity import (
    WORKING_HEARTBEAT_TIMEOUT_SECONDS,
    SessionActivitySignal,
    SessionActivityTracker,
    map_tmux_fallback,
)
from src.core.session_status import (
    ALL_ACTIVITY_STATUSES,
    STATUS_DEAD,
    STATUS_FINISHED_UNREAD,
    STATUS_IDLE,
    STATUS_RUNNING,
    STATUS_UNKNOWN,
)

T0 = datetime(2026, 9, 8, 12, 0, 0)


# ---- the tmux fallback ------------------------------------------------


def test_a_running_pane_is_unknown_and_never_working():
    """THE LOAD-BEARING CASE, and it looks like a bug until you read why.

    This used to answer ``working`` and that was a claim tmux cannot
    support. ``running`` means only "the pane's foreground command is not
    a bare shell", which is equally true of an agent mid-tool-call and
    one parked at an empty prompt - the exact distinction tmux cannot
    make.

    Measured 2026-09-08: 15 of 19 live sessions report a claude VERSION
    STRING as ``pane_current_command`` (the binary renames its own
    process), so this branch is the common one, not the exotic one it was
    assumed to be, and every one of those sessions was reading a
    permanent, never-expiring ``working``. The fallback carries no
    timestamp, so nothing could ever expire the claim.
    """
    assert map_tmux_fallback(STATUS_RUNNING) == STATUS_UNKNOWN
    assert map_tmux_fallback(STATUS_RUNNING, unread=True) == STATUS_UNKNOWN


def test_a_dead_pane_reads_dead():
    """tmux is the only thing that can report a death, so it is believed."""
    assert map_tmux_fallback(STATUS_DEAD) == STATUS_DEAD
    assert map_tmux_fallback(STATUS_DEAD, unread=True) == STATUS_DEAD


def test_an_idle_pane_splits_on_the_unread_flag():
    """ONE DERIVATION, shared with every other source.

    The read/unread half of this vocabulary is a projection of the flag,
    never a value a source decides for itself.
    """
    assert map_tmux_fallback(STATUS_IDLE) == STATUS_IDLE
    assert map_tmux_fallback(STATUS_IDLE, unread=True) == STATUS_FINISHED_UNREAD


def test_an_unknown_pane_stays_unknown_even_when_unread():
    """Not having measured a session is not a claim that it is resting."""
    assert map_tmux_fallback(STATUS_UNKNOWN) == STATUS_UNKNOWN
    assert map_tmux_fallback(STATUS_UNKNOWN, unread=True) == STATUS_UNKNOWN


def test_the_fallback_never_answers_outside_the_declared_vocabulary():
    """A state the vocabulary does not contain fails validation at the
    API boundary, which is exactly where nobody is looking."""
    for raw in (STATUS_RUNNING, STATUS_IDLE, STATUS_DEAD, STATUS_UNKNOWN, "garbage"):
        for unread in (True, False):
            assert map_tmux_fallback(raw, unread=unread) in ALL_ACTIVITY_STATUSES


def test_an_unrecognised_tmux_status_is_unknown_and_does_not_raise():
    """Forward-compat: a status this app has never heard of is a refusal."""
    assert map_tmux_fallback("something_new") == STATUS_UNKNOWN


# ---- the one window three modules share -------------------------------


def test_the_heartbeat_window_is_the_one_every_importer_reads():
    """ONE NUMBER, THREE IMPORTERS.

    ``activity_persist`` judges the durable row by it,
    ``session_transcript_status`` judges a transcript's own mtime by it,
    and ``alert_state_contract`` documents it. A second copy anywhere
    would let the live answer and the restored answer disagree about the
    same session at the same instant.
    """
    from src.core.activity_persist import (
        WORKING_HEARTBEAT_TIMEOUT_SECONDS as PERSIST,
    )
    from src.core.alert_state_contract import (
        WORKING_HEARTBEAT_TIMEOUT_SECONDS as CONTRACT,
    )
    from src.core.session_transcript_status import (
        WORKING_HEARTBEAT_TIMEOUT_SECONDS as TRANSCRIPT,
    )

    assert PERSIST is WORKING_HEARTBEAT_TIMEOUT_SECONDS
    assert TRANSCRIPT is WORKING_HEARTBEAT_TIMEOUT_SECONDS
    assert CONTRACT is WORKING_HEARTBEAT_TIMEOUT_SECONDS


def test_the_heartbeat_window_is_a_positive_number_of_seconds():
    """A zero or negative window would expire every claim instantly."""
    assert isinstance(WORKING_HEARTBEAT_TIMEOUT_SECONDS, int)
    assert WORKING_HEARTBEAT_TIMEOUT_SECONDS > 0


# ---- the claim store --------------------------------------------------


def _with_claims(*, notice=False, permission=False, at=T0):
    """A tracker holding one session's claims in the given state.

    Description: the claims used to be opened by feeding the tracker a
      hook event. That writer is deleted and the store is waiting on a
      passive replacement, so the state is installed directly. What is
      under test is unchanged: which claim each clear retires, and which
      it must leave alone.
    Inputs: notice / permission (bool); at (datetime).
    Output: SessionActivityTracker holding session "s1".
    """
    tracker = SessionActivityTracker()
    tracker._signals["s1"] = SessionActivitySignal(
        permission_open=permission,
        permission_opened_at=at if permission else None,
        notice_open=notice,
    )
    return tracker


def test_a_fresh_tracker_claims_nothing_for_anyone():
    """An unknown session is "no claim", never a claim it cannot see."""
    tracker = SessionActivityTracker()
    assert tracker.permission_open_since("never-seen") is None
    assert tracker.clear_notice("never-seen") is False
    assert tracker.clear_permission("never-seen") is False


def test_clear_notice_retires_a_notice_and_says_it_did():
    """The return value is how a caller logs the difference."""
    tracker = _with_claims(notice=True)
    assert tracker.clear_notice("s1") is True
    assert tracker._signals["s1"].notice_open is False
    assert tracker.clear_notice("s1") is False


def test_clear_permission_retires_the_flag_and_its_stamp_together():
    """They are ONE FACT IN TWO FIELDS.

    A stamp left behind after the flag cleared would date a claim that no
    longer exists, and the pane re-verify keys its throttle on that stamp.
    """
    tracker = _with_claims(permission=True)
    assert tracker.permission_open_since("s1") == T0

    assert tracker.clear_permission("s1") is True

    assert tracker._signals["s1"].permission_open is False
    assert tracker._signals["s1"].permission_opened_at is None
    assert tracker.permission_open_since("s1") is None


@pytest.mark.parametrize(
    "clear,survivor",
    [("clear_notice", "permission_open"), ("clear_permission", "notice_open")],
)
def test_each_clear_moves_exactly_one_claim(clear, survivor):
    """ONE METHOD, ONE FIELD. The negative control for both.

    That a VIEW clears both is a fact about ``session_view_clears``,
    which calls the two methods. It is not a reason for either method to
    reach into the other's field: a caller that wants only one of them
    must not have to want both.
    """
    tracker = _with_claims(notice=True, permission=True)

    getattr(tracker, clear)("s1")

    assert getattr(tracker._signals["s1"], survivor) is True


def test_a_permission_open_with_no_stamp_reports_no_stamp():
    """A CLAIM WITH NO STAMP IS NOT A DATED CLAIM.

    ``session_permission_verify_ledger`` keys on the stamp, so answering
    a fabricated one would give the throttle a key that moves.
    """
    tracker = SessionActivityTracker()
    tracker._signals["s1"] = SessionActivitySignal(
        permission_open=True, permission_opened_at=None
    )
    assert tracker.permission_open_since("s1") is None


def test_forget_drops_one_session_and_never_a_neighbour():
    """Session ids are not reused, so what is forgotten is unreachable."""
    tracker = _with_claims(notice=True)
    tracker._signals["s2"] = SessionActivitySignal(notice_open=True)

    tracker.forget("s1")

    assert "s1" not in tracker._signals
    assert tracker._signals["s2"].notice_open is True
    tracker.forget("s1")  # idempotent
