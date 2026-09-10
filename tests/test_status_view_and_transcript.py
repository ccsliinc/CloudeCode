"""The three status defects closed on 2026-09-09, and their negative controls.

A. A VIEW CLEARS A NOTICE. ``notice`` is set by claude's ``Notification``
   hook, outranks the heartbeat, and was cleared only by events the AGENT
   emits - so opening the tab did nothing and the session named BHPP
   painted terracotta for 46 minutes across a visit. It now clears on the
   same event the unread flag does. A PERMISSION is deliberately NOT
   cleared: it is a blocking fact about the agent, and looking at it does
   not answer it.

B. A HOOKLESS SESSION READS ITS OWN TRANSCRIPT. Only 6 of 19 live
   sessions had ever fired a hook; the other 13 rested on the seed
   ladder's rung B, which can say ``idle`` and nothing else, so three
   sessions that had touched their transcript inside the last 36 minutes
   painted exactly the same rest as ones last touched in July. Rung 0 now
   reads the file's MTIME (a timestamp, therefore expirable, which is the
   whole objection the old ladder raised against file-derived work) and
   its newest turn end.

E. WHERE A STATUS CAME FROM IS REPORTED. ``status_source`` travels beside
   ``activity_status`` so measured and inferred stop rendering as the
   same word with the same confidence.

THE NEGATIVE CONTROLS ARE THE POINT, and they are named in the test
titles: a hooked session is never touched by the transcript ladder, a
FIRST sighting of a turn end never claims unread, a duplicate pass never
re-claims, and an old turn end never re-lights one.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.core.session_activity import (
    EVENT_NOTIFICATION,
    EVENT_PERMISSION_REQUEST,
    EVENT_STOP,
    WORKING_HEARTBEAT_TIMEOUT_SECONDS,
    SessionActivityTracker,
)
from src.core.session_status import (
    STATUS_FINISHED_UNREAD,
    STATUS_IDLE,
    STATUS_NOTICE,
    STATUS_QUESTION,
    STATUS_RUNNING,
    STATUS_UNKNOWN,
    STATUS_WORKING,
)
from src.core.session_status_seed import StatusSeed, display_state
from src.core.session_status_seed_records import (
    TAIL_ABSENT,
    TAIL_AT_REST,
    TAIL_IN_FLIGHT,
    TAIL_NO_MARKER,
    TAIL_UNREADABLE,
    TranscriptRest,
)
from src.core.session_status_source import (
    ALL_STATUS_SOURCES,
    STATUS_SOURCE_HOOK,
    STATUS_SOURCE_NONE,
    STATUS_SOURCE_SEED_ROW,
    STATUS_SOURCE_TMUX,
    STATUS_SOURCE_TRANSCRIPT,
    source_for_seed_rung,
)
from src.core.session_transcript_status import (
    RUNG_MTIME,
    RUNG_NO_TRANSCRIPT,
    RUNG_STALE_IN_FLIGHT,
    RUNG_TURN_END_NEW,
    RUNG_TURN_END_SEEN,
    TranscriptStatus,
    resolve_transcript_status,
)
from src.core.session_transcript_status_read import (
    TranscriptReading,
    TranscriptTurnLedger,
    ledger_for,
    read_transcript_signal,
    transcript_status_for,
)

# The hook-driven-status suite already owns a bare SessionManager harness
# with a fake tmux backend. Reused rather than rebuilt so the two files
# cannot drift on what a registered session looks like.
from tests.test_hook_driven_status import _bare_manager, _register_session

NOW = datetime(2026, 9, 9, 14, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------- #
# A. A view clears a notice, and never a permission.
# --------------------------------------------------------------------- #


def test_clear_notice_drops_an_open_notification():
    """The defect itself: a notice survived being looked at."""
    tracker = SessionActivityTracker()
    tracker.record_event("s1", EVENT_NOTIFICATION, now=NOW)
    assert tracker.resolve("s1", STATUS_RUNNING, now=NOW) == STATUS_NOTICE

    assert tracker.clear_notice("s1") is True
    assert tracker.resolve("s1", STATUS_RUNNING, now=NOW) != STATUS_NOTICE


def test_clear_notice_is_idempotent():
    """Applied twice it reaches the same state, and says so the second time."""
    tracker = SessionActivityTracker()
    tracker.record_event("s1", EVENT_NOTIFICATION, now=NOW)
    assert tracker.clear_notice("s1") is True
    assert tracker.clear_notice("s1") is False
    assert tracker.clear_notice("never-seen") is False
    # With the notice gone and no heartbeat, a hook-fed session at a live
    # pane reads ``idle``: the tracker has signal, and nothing in it is
    # claiming anything.
    assert tracker.resolve("s1", STATUS_RUNNING, now=NOW) == STATUS_IDLE


def test_clear_notice_never_clears_a_permission():
    """ONE METHOD, ONE FIELD - not a policy about views any more.

    ``clear_notice`` moves the notice and nothing else, including when a
    Notification arrived alongside a PermissionRequest, which is the
    common shape on live. That the VIEW now clears both is a fact about
    ``session_view_clears``, which calls the two methods; it is not a
    reason for either method to reach into the other's field. See
    ``tests/test_session_permission_verify.py`` for the view's own
    contract and the 2026-09-09 measurement that changed it.
    """
    tracker = SessionActivityTracker()
    tracker.record_event("s1", EVENT_PERMISSION_REQUEST, now=NOW)
    tracker.record_event("s1", EVENT_NOTIFICATION, now=NOW)

    tracker.clear_notice("s1")

    assert tracker.resolve("s1", STATUS_RUNNING, now=NOW) == STATUS_QUESTION


def test_a_websocket_bind_clears_the_notice_and_the_unread_flag(
    monkeypatch, tmp_path
):
    """End to end through the manager: what a view actually clears."""
    mgr = _bare_manager(monkeypatch, tmp_path)
    _register_session(mgr, "ses1", "cloude_proj", tmp_path)
    mgr.record_hook_event("ses1", EVENT_NOTIFICATION, {})
    mgr.record_hook_event("ses1", EVENT_STOP, {})
    assert mgr._is_unread("cloude_proj") is True

    mgr.mark_session_viewed("ses1")

    assert mgr._is_unread("cloude_proj") is False
    assert mgr._activity_tracker.resolve("ses1", STATUS_RUNNING) != STATUS_NOTICE


def test_a_websocket_bind_clears_a_permission_prompt(monkeypatch, tmp_path):
    """REVERSED 2026-09-09, and the reversal is the point of the test.

    This asserted the opposite until the owner's rule was applied to the
    permission flag as well: "when clicking a tab, the session is marked
    read. if i want it unread i click unread." The old reasoning - that
    looking at a permission prompt does not answer it - was sound and was
    protecting the wrong thing: measured on live, one session held this
    flag with NO dialog on its pane and no reachable event that could
    ever retire it, because the clearing hooks were arriving under a
    different session id. A claim nothing can retire is a stuck bit.

    The pane check (``src/core/session_permission_verify.py``) is the
    evidence-driven retirement path; this is the user's own override of
    it, through the same seam that clears unread.
    """
    mgr = _bare_manager(monkeypatch, tmp_path)
    _register_session(mgr, "ses1", "cloude_proj", tmp_path)
    mgr.record_hook_event("ses1", EVENT_PERMISSION_REQUEST, {})
    assert mgr._activity_tracker.resolve(
        "ses1", STATUS_RUNNING
    ) == STATUS_QUESTION

    mgr.mark_session_viewed("ses1")

    assert mgr._activity_tracker.resolve(
        "ses1", STATUS_RUNNING
    ) != STATUS_QUESTION


def test_the_manual_mark_read_control_clears_the_notice_too(
    monkeypatch, tmp_path
):
    """"mark read" is a view. The two paths route through one seam."""
    mgr = _bare_manager(monkeypatch, tmp_path)
    _register_session(mgr, "ses1", "cloude_proj", tmp_path)
    mgr.record_hook_event("ses1", EVENT_NOTIFICATION, {})
    mgr.set_manual_unread("cloude_proj", True)

    mgr.set_manual_unread("cloude_proj", False)

    assert mgr._is_unread("cloude_proj") is False
    assert mgr._activity_tracker.resolve("ses1", STATUS_RUNNING) != STATUS_NOTICE


def test_marking_a_session_unread_does_not_clear_its_notice(
    monkeypatch, tmp_path
):
    """NEGATIVE CONTROL. Only the READ direction is a view.

    Setting the flag is the user saying "come back to this", which is the
    opposite of having looked, so it must move nothing else.
    """
    mgr = _bare_manager(monkeypatch, tmp_path)
    _register_session(mgr, "ses1", "cloude_proj", tmp_path)
    mgr.record_hook_event("ses1", EVENT_NOTIFICATION, {})

    mgr.set_manual_unread("cloude_proj", True)

    assert mgr._activity_tracker.resolve("ses1", STATUS_RUNNING) == STATUS_NOTICE


# --------------------------------------------------------------------- #
# B1. The pure ladder, rung by rung.
# --------------------------------------------------------------------- #


def _rest(at=None):
    """A tail verdict that ends a turn, dated ``at``.

    Inputs: at (datetime | None). Output: TranscriptRest.
    """
    return TranscriptRest(TAIL_AT_REST, at=at, detail="at rest")


def test_rung_1_a_fresh_mtime_reads_working_and_carries_an_expiry():
    """A file appended to seconds ago is a measurement of NOW."""
    status = resolve_transcript_status(
        mtime=NOW - timedelta(seconds=5),
        tail=_rest(NOW - timedelta(days=3)),
        last_turn_end_seen=None,
        unread=False,
        now=NOW,
    )
    assert status.state == STATUS_WORKING
    assert status.rung == RUNG_MTIME
    # THE CLAIM EXPIRES, and against the FILE's timestamp rather than the
    # moment it was read - which is the entire difference between this
    # rung and the permanent ``working`` a tmux ``running`` used to paint.
    assert status.expires_at == (
        NOW - timedelta(seconds=5)
        + timedelta(seconds=WORKING_HEARTBEAT_TIMEOUT_SECONDS)
    )


def test_rung_1_refuses_an_mtime_from_the_future():
    """A clock disagreement is not a measurement of the last two minutes."""
    status = resolve_transcript_status(
        mtime=NOW + timedelta(minutes=5),
        tail=_rest(NOW - timedelta(days=3)),
        last_turn_end_seen=NOW - timedelta(days=4),
        unread=False,
        now=NOW,
    )
    assert status.state != STATUS_WORKING


def test_rung_1_expires_exactly_at_the_heartbeat_window():
    """The boundary is the same 120s a hook heartbeat gets, not a new number."""
    edge = NOW - timedelta(seconds=WORKING_HEARTBEAT_TIMEOUT_SECONDS)
    just_past = edge - timedelta(seconds=1)
    assert resolve_transcript_status(
        mtime=edge, tail=None, last_turn_end_seen=None, unread=False, now=NOW,
    ).state == STATUS_WORKING
    assert resolve_transcript_status(
        mtime=just_past, tail=None, last_turn_end_seen=None, unread=False,
        now=NOW,
    ).state is None


def test_rung_2_a_newer_turn_end_finishes_unread_and_owes_a_claim():
    """The hookless stand-in for a ``Stop``."""
    seen = NOW - timedelta(hours=2)
    fresh = NOW - timedelta(minutes=30)
    status = resolve_transcript_status(
        mtime=NOW - timedelta(minutes=30),
        tail=_rest(fresh),
        last_turn_end_seen=seen,
        unread=False,
        now=NOW,
    )
    assert status.state == STATUS_FINISHED_UNREAD
    assert status.rung == RUNG_TURN_END_NEW
    assert status.claim_turn_end_at == fresh


def test_rung_2_never_claims_on_a_first_sighting():
    """NEGATIVE CONTROL, and the one that keeps a restart quiet.

    The ledger is in memory. If a first sighting claimed, every hookless
    session on the box would light up unread on every server restart,
    including conversations whose last turn ended in July. FIRST SIGHT IS
    A BASELINE, NOT AN INSTRUCTION.
    """
    status = resolve_transcript_status(
        mtime=NOW - timedelta(days=40),
        tail=_rest(NOW - timedelta(days=40)),
        last_turn_end_seen=None,
        unread=False,
        now=NOW,
    )
    assert status.claim_turn_end_at is None
    assert status.rung == RUNG_TURN_END_SEEN
    assert status.state == STATUS_IDLE


def test_rung_2_never_claims_on_an_undated_turn_end():
    """No timestamp is no key, and no key is no idempotent claim."""
    status = resolve_transcript_status(
        mtime=NOW - timedelta(days=1),
        tail=_rest(None),
        last_turn_end_seen=NOW - timedelta(days=9),
        unread=False,
        now=NOW,
    )
    assert status.claim_turn_end_at is None
    assert status.state == STATUS_IDLE


def test_rung_2_never_relights_an_older_turn_end():
    """NEGATIVE CONTROL. An old turn end can never outrank a newer view."""
    status = resolve_transcript_status(
        mtime=NOW - timedelta(days=1),
        tail=_rest(NOW - timedelta(days=5)),
        last_turn_end_seen=NOW - timedelta(days=2),
        unread=False,
        now=NOW,
    )
    assert status.claim_turn_end_at is None
    assert status.state == STATUS_IDLE


def test_rung_3_reads_the_unread_flag_a_view_left_behind():
    """The same turn end reads two ways, and the difference is the view."""
    seen = NOW - timedelta(hours=6)
    common = dict(
        mtime=NOW - timedelta(hours=6),
        tail=_rest(seen),
        last_turn_end_seen=seen,
        now=NOW,
    )
    assert resolve_transcript_status(unread=True, **common).state == (
        STATUS_FINISHED_UNREAD
    )
    assert resolve_transcript_status(unread=False, **common).state == STATUS_IDLE


@pytest.mark.parametrize("verdict", [TAIL_IN_FLIGHT, TAIL_NO_MARKER])
def test_rung_4_a_stale_in_flight_transcript_claims_nothing(verdict):
    """Mid-turn when last written, and that was ages ago. Say nothing."""
    status = resolve_transcript_status(
        mtime=NOW - timedelta(days=2),
        tail=TranscriptRest(verdict, detail="x"),
        last_turn_end_seen=None,
        unread=False,
        now=NOW,
    )
    assert status.state is None
    assert status.rung == RUNG_STALE_IN_FLIGHT


@pytest.mark.parametrize("verdict", [TAIL_ABSENT, TAIL_UNREADABLE])
def test_rung_5_no_transcript_claims_nothing(verdict):
    """A missing file and an unreadable one are both refusals, not rest."""
    status = resolve_transcript_status(
        mtime=None,
        tail=TranscriptRest(verdict, detail="x"),
        last_turn_end_seen=None,
        unread=False,
        now=NOW,
    )
    assert status.state is None


def test_the_ladder_refuses_more_often_than_it_answers_on_junk():
    """A matcher that always finds something is worse than useless."""
    refusals = 0
    for tail in (
        None,
        TranscriptRest(TAIL_ABSENT, detail="x"),
        TranscriptRest(TAIL_UNREADABLE, detail="x"),
        TranscriptRest(TAIL_IN_FLIGHT, detail="x"),
        TranscriptRest(TAIL_NO_MARKER, detail="x"),
    ):
        status = resolve_transcript_status(
            mtime=None, tail=tail, last_turn_end_seen=None, unread=False,
            now=NOW,
        )
        refusals += 0 if status.answers else 1
    assert refusals == 5


# --------------------------------------------------------------------- #
# B2. The ledger, and the once-per-turn unread claim.
# --------------------------------------------------------------------- #


def test_the_ledger_baselines_then_notices_exactly_one_new_turn():
    older = NOW - timedelta(hours=3)
    newer = NOW - timedelta(hours=1)
    ledger = TranscriptTurnLedger()
    assert ledger.observe("k", older) is False   # baseline
    assert ledger.observe("k", newer) is True    # one new turn
    assert ledger.observe("k", newer) is False   # duplicate pass
    assert ledger.observe("k", older) is False   # an old record, ignored
    assert ledger.newest_seen("k") == newer


def test_the_ledger_refuses_an_undated_or_unkeyed_observation():
    ledger = TranscriptTurnLedger()
    assert ledger.observe("k", None) is False
    assert ledger.observe("", NOW) is False


class _RecordingUnreadStore:
    """A stand-in for UnreadStore that counts writes.

    Inputs: n/a. Output: n/a.
    """

    def __init__(self) -> None:
        self.writes: list[tuple] = []

    def set_flag(self, tmux_name, field_name, value, epoch=None):
        """Record one write. Inputs/Output mirror UnreadStore.set_flag."""
        self.writes.append((tmux_name, field_name, value, epoch))


class _FakeManager:
    """The two attributes the transcript seam actually touches.

    Weakly referenceable on purpose - the ledger store keys on the
    manager, and a manager that cannot be weakly referenced silently gets
    a throwaway ledger, which would make the idempotence test below pass
    for the wrong reason.
    """

    def __init__(self) -> None:
        self._unread_store = _RecordingUnreadStore()


def test_a_new_turn_end_sets_unread_exactly_once_across_repeated_passes():
    """Idempotence under the poll, which runs this every sixty seconds."""
    mgr = _FakeManager()
    baseline = TranscriptReading(
        mtime=NOW - timedelta(days=1), tail=_rest(NOW - timedelta(days=1))
    )
    newer = TranscriptReading(
        mtime=NOW - timedelta(minutes=30), tail=_rest(NOW - timedelta(minutes=30))
    )
    common = dict(session_id="s1", tmux_name="cloude_x", epoch=1757000000,
                  unread=False, now=NOW)

    transcript_status_for(mgr, reading=baseline, **common)
    assert mgr._unread_store.writes == []

    first = transcript_status_for(mgr, reading=newer, **common)
    assert first.state == STATUS_FINISHED_UNREAD
    assert mgr._unread_store.writes == [
        ("cloude_x", "auto", True, 1757000000)
    ]

    for _ in range(5):
        transcript_status_for(mgr, reading=newer, **common)
    assert len(mgr._unread_store.writes) == 1


def test_the_working_rung_never_moves_the_turn_baseline():
    """An mtime is not a turn boundary, so it may not stand in for one.

    Recording it would push the baseline past turn ends nobody observed,
    and the next real turn end would then read as old and never light.
    """
    mgr = _FakeManager()
    turn_at = NOW - timedelta(hours=4)
    transcript_status_for(
        mgr, session_id="s1", tmux_name="cloude_x", epoch=1,
        reading=TranscriptReading(mtime=turn_at, tail=_rest(turn_at)),
        unread=False, now=NOW,
    )
    before = ledger_for(mgr).newest_seen("cloude_x@1")

    transcript_status_for(
        mgr, session_id="s1", tmux_name="cloude_x", epoch=1,
        reading=TranscriptReading(
            mtime=NOW - timedelta(seconds=5), tail=_rest(turn_at)
        ),
        unread=False, now=NOW,
    )
    assert ledger_for(mgr).newest_seen("cloude_x@1") == before


# --------------------------------------------------------------------- #
# B3. Through the seam, against a real file and a real manager.
# --------------------------------------------------------------------- #


def _write_transcript(corpus_root: Path, working_dir: str, uuid: str,
                      records: list, age_seconds: int = 3600) -> Path:
    """Write a transcript where ``conversation_presence`` will find it.

    Inputs: corpus_root (Path). working_dir (str). uuid (str). records
      (list). age_seconds (int) - how far back to stamp its mtime.
    Output: Path.
    """
    from src.core.claude_transcript_correlate import slugify_project_dir

    directory = corpus_root / slugify_project_dir(working_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{uuid}.jsonl"
    path.write_text(
        "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8"
    )
    if age_seconds:
        stamp = time.time() - age_seconds
        os.utime(path, (stamp, stamp))
    return path


@pytest.fixture()
def corpus(tmp_path, monkeypatch):
    """A throwaway ``~/.claude/projects`` nothing else can see."""
    home = tmp_path / "home"
    projects = home / ".claude" / "projects"
    projects.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    return projects


def test_the_reader_takes_both_measurements_off_one_real_file(
    corpus, tmp_path
):
    """mtime and tail, one presence resolution, against a file on disk."""
    uuid = "3f1c9a4e-1111-4111-8111-111111111111"
    wd = str(tmp_path / "proj")
    _write_transcript(
        corpus, wd, uuid,
        [{"type": "system", "subtype": "turn_duration",
          "timestamp": "2026-09-04T19:39:04.864Z", "isSidechain": False}],
        age_seconds=0,
    )
    reading = read_transcript_signal(uuid, wd)
    assert reading.tail.verdict == TAIL_AT_REST
    assert reading.mtime is not None
    assert (datetime.now(timezone.utc) - reading.mtime) < timedelta(minutes=1)


def test_a_missing_transcript_reads_absent_with_no_mtime(corpus, tmp_path):
    reading = read_transcript_signal(
        "00000000-0000-4000-8000-000000000000", str(tmp_path / "nope")
    )
    assert reading.mtime is None
    assert reading.tail.verdict in (TAIL_ABSENT, TAIL_UNREADABLE)


def test_no_uuid_is_a_named_refusal_not_a_crash():
    reading = read_transcript_signal(None, None)
    assert reading.mtime is None
    assert reading.tail.verdict == TAIL_ABSENT


# --------------------------------------------------------------------- #
# B4. The negative control that matters most: hooks still win.
# --------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_a_hooked_session_is_never_touched_by_the_transcript_ladder(
    monkeypatch, tmp_path
):
    """NEGATIVE CONTROL. Hooks are a hooked session's truth, full stop.

    The seam is reached only while ``hooks_seen`` is False. A session
    whose hooks have spoken must not have its status re-derived from a
    file, and must not have an unread flag set by one either - the Stop
    hook already owns that.
    """
    mgr = _bare_manager(monkeypatch, tmp_path)
    _register_session(mgr, "ses1", "cloude_proj", tmp_path)
    mgr.record_hook_event("ses1", "PreToolUse", {})

    calls: list = []

    def _boom(*args, **kwargs):
        calls.append(args)
        raise AssertionError("the transcript ladder ran for a hooked session")

    monkeypatch.setattr(
        "src.core.session_status_seed_read.seeded_display", _boom
    )
    monkeypatch.setattr(mgr, "_build_tmux_status_map", lambda: {
        "cloude_proj": {"status": "running"}
    })

    infos = await mgr.list_session_infos()

    assert calls == []
    assert infos[0].activity_status == STATUS_WORKING
    assert infos[0].status_source == STATUS_SOURCE_HOOK


@pytest.mark.asyncio
async def test_a_bare_shell_stays_idle_and_is_never_re_derived(
    monkeypatch, tmp_path
):
    """NEGATIVE CONTROL. tmux answered ``idle``; nothing else is consulted.

    ``resolve_pane_status`` maps a known shell command straight to
    ``idle``, and the seed seam fires only while the answer is still
    ``unknown``, so a bare shell never reaches the transcript ladder.
    """
    mgr = _bare_manager(monkeypatch, tmp_path)
    _register_session(mgr, "ses1", "cloude_proj", tmp_path)

    def _boom(*args, **kwargs):
        raise AssertionError("the transcript ladder ran for a bare shell")

    monkeypatch.setattr(
        "src.core.session_status_seed_read.seeded_display", _boom
    )
    monkeypatch.setattr(mgr, "_build_tmux_status_map", lambda: {
        "cloude_proj": {"status": "idle"}
    })

    infos = await mgr.list_session_infos()

    assert infos[0].activity_status == STATUS_IDLE
    assert infos[0].status_source == STATUS_SOURCE_TMUX


# --------------------------------------------------------------------- #
# B5. The cached working claim expires.
# --------------------------------------------------------------------- #


def test_a_cached_working_seed_stops_rendering_once_its_window_closes():
    """The seed cache holds a reading for a minute; the claim lasts 120s.

    Without this, a ``working`` measured at the end of its window would
    be served for a further sixty seconds - the exact unexpirable claim
    this rung exists to avoid.
    """
    seed = StatusSeed(
        state=STATUS_WORKING,
        at=NOW,
        expires_at=NOW + timedelta(seconds=WORKING_HEARTBEAT_TIMEOUT_SECONDS),
    )
    assert display_state(seed, now=NOW) == STATUS_WORKING
    assert display_state(seed, now=NOW + timedelta(seconds=119)) == STATUS_WORKING
    assert display_state(seed, now=NOW + timedelta(seconds=121)) is None


def test_a_resting_seed_carries_no_expiry_and_never_rots():
    """Rest does not stop being rest by sitting still."""
    seed = StatusSeed(state=STATUS_IDLE, at=NOW - timedelta(days=60))
    assert seed.expires_at is None
    assert display_state(seed, now=NOW + timedelta(days=365)) == STATUS_IDLE


# --------------------------------------------------------------------- #
# E. status_source.
# --------------------------------------------------------------------- #


def test_every_source_is_one_of_the_five_named_values():
    assert ALL_STATUS_SOURCES == {
        STATUS_SOURCE_HOOK,
        STATUS_SOURCE_TRANSCRIPT,
        STATUS_SOURCE_SEED_ROW,
        STATUS_SOURCE_TMUX,
        STATUS_SOURCE_NONE,
    }


def test_a_seed_rung_maps_to_exactly_one_source():
    from src.core.session_status_seed import (
        SEED_RUNG_NONE,
        SEED_RUNG_ROW,
        SEED_RUNG_TRANSCRIPT,
    )

    assert source_for_seed_rung(SEED_RUNG_ROW) == STATUS_SOURCE_SEED_ROW
    assert source_for_seed_rung(SEED_RUNG_TRANSCRIPT) == STATUS_SOURCE_TRANSCRIPT
    assert source_for_seed_rung(SEED_RUNG_NONE) == STATUS_SOURCE_NONE
    # An unrecognised rung refuses rather than raising: a status must
    # never be able to break a listing.
    assert source_for_seed_rung("a rung nobody defined") == STATUS_SOURCE_NONE


def test_the_wrapper_carries_status_source_and_defaults_to_none():
    """It is on the WRAPPER, beside activity_status, never on .session."""
    from src.models import SessionInfo

    assert "status_source" in SessionInfo.model_fields
    assert SessionInfo.model_fields["status_source"].default == (
        STATUS_SOURCE_NONE
    )


def test_a_status_source_is_never_reported_for_an_expired_claim():
    """Nothing supports the status, so nothing may be credited with it."""
    status = TranscriptStatus(rung=RUNG_NO_TRANSCRIPT, detail="x")
    assert status.answers is False
