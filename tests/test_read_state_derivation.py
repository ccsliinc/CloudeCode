"""The read/unread half of the status vocabulary is DERIVED, on every path.

WHAT WENT WRONG, MEASURED ON LIVE 2026-09-09 at 5e13cb1. The owner opened
the daily-briefing tab and nothing changed. ``/sessions/list`` for
``cloude_daily-briefing`` answered ``activity_status: finished_unread``
beside ``unread: false``, with ``status_source: seed_row``: the WebSocket
bind had cleared the flag exactly as designed, and the durable row still
held the word ``finished_unread`` stamped before the view. The seed path
returned it verbatim and the green dot stayed green over a session that
had been read.

THE RULE THESE TESTS PIN. ``finished_unread`` and ``idle`` are ONE resting
state seen through ONE flag, and which of them a session is, is decided at
resolve time by ``session_status.derive_read_state`` - the single function
every source runs through. Two directions, not one:

  - no path may answer ``finished_unread`` while the flag is False, and
  - a session at rest whose flag IS set must answer ``finished_unread``.

A one-directional derivation is what shipped, and it is not a derivation:
adding unread to an ``idle`` and never removing it from a stored
``finished_unread`` is a cache, and a cache of a fact that moves is a lie
with a timestamp.

FOUR SOURCES, ALL FOUR EXERCISED HERE, because the defect was in exactly
one of them and the other three looked fine: the hook tracker
(``SessionActivityTracker.resolve``), the tmux fallback
(``map_tmux_fallback``), the durable row / transcript seed
(``session_status_seed.display_state``) and the hookless transcript ladder
(``resolve_transcript_status``). Plus the assembled answer that
``_session_info_for`` hands the client, which is what the owner actually
looked at.

Run with:
    venv/bin/python3 -m pytest tests/test_read_state_derivation.py -q
"""

from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

# ---- minimal env bootstrap so `src.config` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_rsd_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_rsd_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.activity_persist import write_state
from src.core.session_activity import (
    EVENT_STOP,
    SessionActivityTracker,
    map_tmux_fallback,
)
from src.core.session_manager import SessionManager
from src.core.session_status import (
    STATUS_DEAD,
    STATUS_FINISHED_UNREAD,
    STATUS_IDLE,
    STATUS_RUNNING,
    STATUS_UNKNOWN,
    STATUS_WORKING,
    derive_read_state,
)
from src.core.session_status_seed import StatusSeed, display_state
from src.core.session_status_seed_records import TAIL_AT_REST, TranscriptRest
from src.core.session_transcript_status import (
    RUNG_TURN_END_SEEN,
    resolve_transcript_status,
)
from src.models import Session, SessionStatus


# =========================================================================== #
# 0. The one function                                                         #
# =========================================================================== #


def test_the_derivation_runs_in_both_directions():
    """The whole fix: it REMOVES unread as readily as it adds it."""
    assert derive_read_state(STATUS_FINISHED_UNREAD, unread=False) == STATUS_IDLE
    assert derive_read_state(STATUS_IDLE, unread=True) == STATUS_FINISHED_UNREAD
    assert derive_read_state(STATUS_IDLE, unread=False) == STATUS_IDLE
    assert (
        derive_read_state(STATUS_FINISHED_UNREAD, unread=True)
        == STATUS_FINISHED_UNREAD
    )


def test_it_is_idempotent_so_every_path_may_apply_it():
    """Applying it twice is applying it once, which is what lets the
    listing re-apply it over an answer a source already derived."""
    for state in (STATUS_IDLE, STATUS_FINISHED_UNREAD):
        for flag in (True, False):
            once = derive_read_state(state, unread=flag)
            assert derive_read_state(once, unread=flag) == once


def test_it_touches_nothing_outside_the_resting_pair():
    """A guess must not become a rest claim because a flag is set. Note
    ``unknown`` in particular: not having measured a session is not
    evidence it is at rest, and an unread flag may not manufacture one."""
    for state in (
        STATUS_WORKING,
        STATUS_DEAD,
        STATUS_UNKNOWN,
        STATUS_RUNNING,
        "question",
        "notice",
        "working_subagent",
        None,
    ):
        assert derive_read_state(state, unread=True) == state
        assert derive_read_state(state, unread=False) == state


# =========================================================================== #
# 1. SOURCE ONE - the hook tracker                                            #
# =========================================================================== #


def test_hook_tracker_a_stop_with_the_flag_set_reads_finished_unread():
    tracker = SessionActivityTracker()
    tracker.record_event("s1", EVENT_STOP)
    assert tracker.resolve("s1", STATUS_IDLE, unread=True) == STATUS_FINISHED_UNREAD


def test_hook_tracker_the_same_stop_with_the_flag_clear_reads_idle():
    """The Stop is unchanged and the state machine is unchanged; the only
    thing that moved is the flag, and the answer follows it."""
    tracker = SessionActivityTracker()
    tracker.record_event("s1", EVENT_STOP)
    assert tracker.resolve("s1", STATUS_IDLE, unread=False) == STATUS_IDLE


def test_hook_tracker_never_answers_finished_unread_on_a_clear_flag():
    """The negative control over the whole tmux vocabulary. A hooked
    session at rest may answer ``idle`` or ``unknown``; it may never claim
    something is waiting for the user when nothing is."""
    tracker = SessionActivityTracker()
    tracker.record_event("s1", EVENT_STOP)
    for tmux_status in (STATUS_IDLE, STATUS_RUNNING, STATUS_UNKNOWN):
        assert (
            tracker.resolve("s1", tmux_status, unread=False)
            != STATUS_FINISHED_UNREAD
        )


def test_hook_tracker_a_dead_pane_is_dead_whatever_the_flag_says():
    tracker = SessionActivityTracker()
    tracker.record_event("s1", EVENT_STOP)
    assert tracker.resolve("s1", STATUS_DEAD, unread=True) == STATUS_DEAD


# =========================================================================== #
# 2. SOURCE TWO - the tmux fallback                                           #
# =========================================================================== #


def test_tmux_fallback_derives_both_ways():
    assert map_tmux_fallback(STATUS_IDLE, unread=True) == STATUS_FINISHED_UNREAD
    assert map_tmux_fallback(STATUS_IDLE, unread=False) == STATUS_IDLE


def test_tmux_fallback_still_refuses_to_claim_rest_it_did_not_measure():
    """``running`` means only "not a bare shell" and stays ``unknown``;
    the derivation must not have quietly turned it into a rest state."""
    assert map_tmux_fallback(STATUS_RUNNING, unread=True) == STATUS_UNKNOWN
    assert map_tmux_fallback(STATUS_DEAD, unread=True) == STATUS_DEAD


# =========================================================================== #
# 3. SOURCE THREE - the seed (the durable row, and the transcript rung)       #
# =========================================================================== #


def test_seed_a_stored_finished_unread_renders_idle_once_the_flag_clears():
    """THE LIVE DEFECT, at the layer that produced it. Rows written before
    the fix still carry the old spelling, so this is the case that must
    keep working without a migration."""
    seed = StatusSeed(state=STATUS_FINISHED_UNREAD, at=None, rung="row")
    assert display_state(seed, unread=False) == STATUS_IDLE
    assert display_state(seed, unread=True) == STATUS_FINISHED_UNREAD


def test_seed_a_stored_idle_renders_finished_unread_when_the_flag_is_set():
    seed = StatusSeed(state=STATUS_IDLE, at=None, rung="row")
    assert display_state(seed, unread=True) == STATUS_FINISHED_UNREAD
    assert display_state(seed, unread=False) == STATUS_IDLE


def test_seed_a_refusal_still_renders_nothing():
    """The derivation must not turn "no rung answered" into an answer."""
    assert display_state(StatusSeed(), unread=True) is None


def test_seed_an_expired_working_claim_is_still_refused():
    """The expiry gate runs before the derivation and is unaffected by
    it: a claim about NOW that has run out renders nothing, and a set
    flag does not resurrect it as a rest state."""
    now = datetime.now(timezone.utc)
    seed = StatusSeed(
        state=STATUS_WORKING,
        rung="transcript",
        expires_at=now - timedelta(seconds=1),
    )
    assert display_state(seed, unread=True, now=now) is None


# =========================================================================== #
# 4. SOURCE FOUR - the hookless transcript ladder                             #
# =========================================================================== #


def _rest_tail(at: datetime) -> TranscriptRest:
    return TranscriptRest(TAIL_AT_REST, at=at, detail="a turn ended")


def test_transcript_rung_three_follows_the_flag_in_both_directions():
    now = datetime.now(timezone.utc)
    ended = now - timedelta(hours=3)
    tail = _rest_tail(ended)

    read = resolve_transcript_status(
        mtime=ended,
        tail=tail,
        last_turn_end_seen=ended,
        unread=False,
        now=now,
    )
    assert read.rung == RUNG_TURN_END_SEEN
    assert read.state == STATUS_IDLE

    unread = resolve_transcript_status(
        mtime=ended,
        tail=tail,
        last_turn_end_seen=ended,
        unread=True,
        now=now,
    )
    assert unread.rung == RUNG_TURN_END_SEEN
    assert unread.state == STATUS_FINISHED_UNREAD


def test_transcript_rung_two_still_claims_the_turn_it_just_measured():
    """THE ONE RUNG THAT IS NOT DERIVED FROM THE FLAG, because it is the
    rung that SETS it. Deriving here against the flag as it stood BEFORE
    the measurement would answer ``idle`` about a turn that finished
    unseen, which is the false green from the other direction."""
    now = datetime.now(timezone.utc)
    older = now - timedelta(hours=2)
    newer = now - timedelta(minutes=30)

    status = resolve_transcript_status(
        mtime=newer,
        tail=_rest_tail(newer),
        last_turn_end_seen=older,
        unread=False,
        now=now,
    )
    assert status.state == STATUS_FINISHED_UNREAD
    assert status.claim_turn_end_at == newer


# =========================================================================== #
# 5. THE ASSEMBLED ANSWER - what the owner actually looked at                  #
# =========================================================================== #


class _StubSettings:
    """Just enough of ``Settings`` for SessionManager.__init__."""

    def __init__(self, pin_path: Path, log_dir: Path, port: int = 5001):
        self._pin_path = pin_path
        self._log_dir = log_dir
        self.port = port

    def get_pinned_themes_path(self) -> Path:
        return self._pin_path

    def get_unread_state_path(self) -> Path:
        return self._pin_path.parent / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._log_dir)

    def get_session_metadata_path(self) -> Path:
        return self._log_dir / "session_metadata.json"


class _FakeBackend:
    """Bare enough of a SessionBackend for tmux_session lookups."""

    def __init__(self, tmux_session: str):
        self.tmux_session = tmux_session

    def is_alive(self) -> bool:
        return True


def _manager_with_row_state(monkeypatch, tmp_path: Path, stored: str) -> SessionManager:
    """A manager holding one live session whose DURABLE ROW records
    ``stored`` and which has never fired a hook - the exact shape of the
    daily-briefing session on live."""
    stub = _StubSettings(
        pin_path=tmp_path / "pinned_themes.json", log_dir=tmp_path / "logs"
    )
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr("src.core.session_manager.settings", stub)
    mgr = SessionManager()
    mgr.sessions["ses1"] = Session(
        id="ses1",
        pty_pid=None,
        working_dir=str(tmp_path),
        status=SessionStatus.RUNNING,
        tmux_session="cloude_daily-briefing",
    )
    mgr.backends["ses1"] = _FakeBackend("cloude_daily-briefing")
    mgr._subscribers.setdefault("ses1", [])
    monkeypatch.setattr(
        mgr,
        "_build_tmux_status_map",
        lambda: {"cloude_daily-briefing": {"status": STATUS_IDLE}},
    )
    # The row says what it says. Nothing rewrites it on a view, which is
    # precisely why the read has to reconcile it.
    monkeypatch.setattr(mgr, "_restored_activity_state", lambda name: stored)
    return mgr


def test_a_row_recording_finished_unread_reads_idle_once_the_tab_is_opened(
    monkeypatch, tmp_path
):
    """THE OWNER'S CASE, END TO END THROUGH ``_session_info_for``."""
    mgr = _manager_with_row_state(monkeypatch, tmp_path, STATUS_FINISHED_UNREAD)

    mgr.set_manual_unread("cloude_daily-briefing", True)
    info = mgr._session_info_for("ses1")
    assert info.unread is True
    assert info.activity_status == STATUS_FINISHED_UNREAD

    # The click. A WebSocket terminal binding is what marks it viewed.
    mgr.mark_session_viewed("ses1")
    info = mgr._session_info_for("ses1")
    assert info.unread is False
    assert info.activity_status == STATUS_IDLE, (
        "the row still records finished_unread; the flag is what decides"
    )


def test_the_flag_transitions_are_idempotent_set_view_set_view(
    monkeypatch, tmp_path
):
    """Set, view, set again, view again. Each transition is applied twice
    to prove neither the flag nor the derived state ratchets: this is the
    same order-tolerance every hook consumer owes, applied to the pair the
    user can move by hand."""
    mgr = _manager_with_row_state(monkeypatch, tmp_path, STATUS_FINISHED_UNREAD)
    name = "cloude_daily-briefing"

    for _ in range(2):
        mgr.set_manual_unread(name, True)
        info = mgr._session_info_for("ses1")
        assert (info.unread, info.activity_status) == (True, STATUS_FINISHED_UNREAD)

    for _ in range(2):
        mgr.mark_session_viewed("ses1")
        info = mgr._session_info_for("ses1")
        assert (info.unread, info.activity_status) == (False, STATUS_IDLE)

    for _ in range(2):
        mgr.set_manual_unread(name, True)
        info = mgr._session_info_for("ses1")
        assert (info.unread, info.activity_status) == (True, STATUS_FINISHED_UNREAD)

    for _ in range(2):
        mgr.set_manual_unread(name, False)
        info = mgr._session_info_for("ses1")
        assert (info.unread, info.activity_status) == (False, STATUS_IDLE)


def test_a_row_recording_idle_reads_finished_unread_when_the_flag_is_set(
    monkeypatch, tmp_path
):
    """The other direction, and the one the fix must not break: a row
    holding the base state still lights up when a Stop marks it unread."""
    mgr = _manager_with_row_state(monkeypatch, tmp_path, STATUS_IDLE)
    mgr.set_manual_unread("cloude_daily-briefing", True)
    info = mgr._session_info_for("ses1")
    assert info.activity_status == STATUS_FINISHED_UNREAD


# =========================================================================== #
# 6. THE WRITER - the column holds the base state                             #
# =========================================================================== #


class _RecordingConn:
    """Captures the parameters of one UPDATE. Not a database."""

    def __init__(self):
        self.params = None

    def execute(self, sql, params):
        self.params = params

        class _Cur:
            rowcount = 1

        return _Cur()


def test_the_row_stores_the_base_state_never_the_read_verdict():
    """``finished_unread`` is ``idle`` seen through a flag that lives in
    another store. Stamping the projection into the column records an
    answer nothing rewrites on a view - the shape of the live defect."""
    conn = _RecordingConn()
    assert write_state(conn, "cloude_x", STATUS_FINISHED_UNREAD, 1757000000) is True
    assert conn.params[0] == STATUS_IDLE


def test_the_writer_leaves_every_other_state_alone():
    for state in (STATUS_WORKING, "question", "notice", STATUS_IDLE):
        conn = _RecordingConn()
        write_state(conn, "cloude_x", state, 1757000000)
        assert conn.params[0] == state


def test_the_writer_still_refuses_a_write_with_no_epoch():
    conn = _RecordingConn()
    assert write_state(conn, "cloude_x", STATUS_FINISHED_UNREAD, None) is False
    assert conn.params is None


if __name__ == "__main__":  # pragma: no cover - convenience runner
    raise SystemExit(pytest.main([__file__, "-q"]))
