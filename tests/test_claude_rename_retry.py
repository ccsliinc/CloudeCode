"""The rename-retry ladder and its ledger, with the refusals up front.

WHY THE NEGATIVE CONTROLS ARE THE POINT OF THIS FILE. A retry that always
fires is worse than no retry at all: it would push a stale browser label
over a name the user typed in the TUI, permanently, on every session that
ever diverged. So the tests that matter most here are the ones that prove
NOTHING HAPPENS - a divergence with no witnessed agreement, a pass on
which claude's own name moved, a transcript that could not be read, and a
budget that has run out. Each was watched to FAIL against a deliberately
broken ladder before it was kept.

THE ORDERING CLAIM IS TESTED AS A CLAIM, not as a code path. The rule is
that a browser label may be pushed only when claude's recorded name has
not moved since the two columns were last seen to agree. So the tests
build that history by calling the functions in sequence - witness, then
diverge, then decide - rather than by handing the ladder a mark somebody
typed out, because a mark typed out by the test is a mark the test
invented and proves nothing about how one comes to exist.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_rr_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_rr_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
import json

import pytest

from src.core import claude_rename_retry_store as store
from src.core.claude_rename_retry import (
    MAX_PUSH_ATTEMPTS,
    MIN_ATTEMPT_INTERVAL_SECONDS,
    RETRY_AGREED,
    RETRY_EXHAUSTED,
    RETRY_PUSH,
    RETRY_SUPERSEDED,
    RETRY_UNORDERED,
    RETRY_UNREADABLE,
    RETRY_WAITING,
    RenameMark,
    budget_for,
    decide_retry,
    record_agreement,
    record_attempt,
    witness_agreement,
)
from src.core.claude_title_sync import (
    TITLE_APPLIED,
    TITLE_BASELINE_RECORDED,
    TITLE_NOT_MEASURED,
    TITLE_UNCHANGED,
)

OLD = "Agent - Hirschfeld (Helen)"
NEW = "Agent - Hirschfeld (Rustdesk)"


def _agreed_on(name: str) -> RenameMark:
    """A mark built the way the seam builds one: by witnessing agreement.

    Description: goes through :func:`witness_agreement` and
      :func:`record_agreement` rather than constructing a RenameMark, so
      a test can never assert against an ordering frame the real code
      would not have produced.
    Inputs: name (str) - the value both columns held.
    Output: RenameMark.
    Example: _agreed_on('A').agreed_title -> 'A'
    """
    seen = witness_agreement(title=name, claude_title=name)
    assert seen == name
    return record_agreement(None, seen)


# ---------------------------------------------------------------------
# THE REFUSALS. Every one of these must push nothing.
# ---------------------------------------------------------------------


def test_a_divergence_with_no_witnessed_agreement_is_refused():
    """THE LOAD-BEARING REFUSAL: no frame means no idea which is newer.

    A row can reach ``title != claude_title`` two ways, and only one of
    them is orderable. Without a witnessed agreement behind it the
    divergence may be a first-sight baseline that landed on a row whose
    visible label was already something else, in which case claude's name
    is the older one and pushing the browser's would be correct - or the
    newer one, in which case pushing would destroy it. Refusing is the
    only honest answer.
    """
    decision = decide_retry(
        sync_action=TITLE_UNCHANGED,
        title=NEW,
        claude_title=OLD,
        mark=None,
        now=0.0,
    )
    assert decision.verdict == RETRY_UNORDERED
    assert decision.acts is False
    assert decision.label is None


def test_a_mark_that_has_been_overtaken_is_refused():
    """An agreement claude has since moved away from orders nothing.

    The frame says the two columns agreed on X. If ``claude_title`` now
    reads Y, something wrote Y after the agreement, and that write is not
    ordered against the browser's. Same refusal, different cause, and the
    two are kept apart in the detail sentence rather than collapsed.
    """
    decision = decide_retry(
        sync_action=TITLE_UNCHANGED,
        title=NEW,
        claude_title="a third name",
        mark=_agreed_on(OLD),
        now=0.0,
    )
    assert decision.verdict == RETRY_UNORDERED
    assert decision.acts is False


def test_a_rename_typed_in_the_tui_supersedes_the_pending_push():
    """THE CLOBBER THIS WHOLE MODULE EXISTS TO AVOID.

    ``TITLE_APPLIED`` means the transcript carried a name that is not the
    one the row recorded, so claude renamed after we last looked. Its
    name is the newer one and last rename wins from either side, so the
    browser's pending label must die quietly rather than be re-sent.
    """
    decision = decide_retry(
        sync_action=TITLE_APPLIED,
        title=NEW,
        claude_title=OLD,
        mark=_agreed_on(OLD),
        now=0.0,
    )
    assert decision.verdict == RETRY_SUPERSEDED
    assert decision.acts is False


def test_a_first_sight_baseline_never_authorises_a_push():
    """A baseline establishes no ordering, so it cannot authorise one.

    This is the project's standing rule applied to the other direction:
    first sight of a claude-side name is recorded and acted on by
    nothing. A retry that read a baseline pass as permission would be
    inventing the very attribution v10 refused to invent.
    """
    decision = decide_retry(
        sync_action=TITLE_BASELINE_RECORDED,
        title=NEW,
        claude_title=OLD,
        mark=_agreed_on(OLD),
        now=0.0,
    )
    assert decision.verdict == RETRY_SUPERSEDED
    assert decision.acts is False


def test_an_unreadable_transcript_decides_nothing_and_spends_nothing():
    """Not having looked is not evidence, and it is not an attempt.

    ``TITLE_NOT_MEASURED`` covers both an unreadable file and a window
    holding no ``custom-title`` record. Neither confirms claude still
    holds the recorded name, so neither may authorise a push - and
    charging the budget for them would exhaust a rename on a machine
    whose corpus the checker simply cannot see.
    """
    decision = decide_retry(
        sync_action=TITLE_NOT_MEASURED,
        title=NEW,
        claude_title=OLD,
        mark=_agreed_on(OLD),
        now=0.0,
    )
    assert decision.verdict == RETRY_UNREADABLE
    assert decision.acts is False
    assert decision.attempts_spent == 0


def test_agreement_between_the_two_columns_is_the_quiet_steady_state():
    """The common case on a healthy box writes nothing and pushes nothing."""
    decision = decide_retry(
        sync_action=TITLE_UNCHANGED,
        title=OLD,
        claude_title=OLD,
        mark=_agreed_on(OLD),
        now=0.0,
    )
    assert decision.verdict == RETRY_AGREED
    assert decision.acts is False


def test_a_null_claude_title_is_not_an_agreement_and_not_a_divergence():
    """Never having seen claude's side is its own state, not a conflict.

    865 of the 941 rows on the owner's live database carry a title and a
    NULL ``claude_title``. Reading that as a divergence would aim the
    retry at the entire fleet; reading it as an agreement would mint an
    ordering frame out of nothing.
    """
    assert witness_agreement(title=NEW, claude_title=None) is None
    assert witness_agreement(title=None, claude_title=None) is None
    assert witness_agreement(title=NEW, claude_title="   ") is None
    decision = decide_retry(
        sync_action=TITLE_UNCHANGED,
        title=NEW,
        claude_title=None,
        mark=None,
        now=0.0,
    )
    assert decision.verdict == RETRY_AGREED


# ---------------------------------------------------------------------
# THE ONE CASE THAT ACTS.
# ---------------------------------------------------------------------


def test_a_browser_rename_after_a_witnessed_agreement_is_pushed():
    """The positive control, built as a history rather than asserted.

    Both columns agreed on OLD, which is what the frame records. The
    browser then wrote NEW into ``title`` alone. Claude's recorded name
    has not moved since the agreement and the transcript confirms it
    (``TITLE_UNCHANGED``), so the browser's label is provably the newer
    one and is pushed.
    """
    mark = _agreed_on(OLD)
    decision = decide_retry(
        sync_action=TITLE_UNCHANGED,
        title=NEW,
        claude_title=OLD,
        mark=mark,
        now=1000.0,
    )
    assert decision.verdict == RETRY_PUSH
    assert decision.acts is True
    assert decision.label == NEW
    assert decision.attempts_spent == 0


# ---------------------------------------------------------------------
# THE BOUND.
# ---------------------------------------------------------------------


def test_a_permanently_unreachable_session_stops_in_a_named_state():
    """THE BOUND, driven the way the seam drives it.

    Five pushes are charged through :func:`record_attempt`, each spaced
    past the interval floor so the floor is not what stops it. The sixth
    pass answers :data:`RETRY_EXHAUSTED` - a NAMED terminal state, not a
    silent stop and not another push - and keeps answering it however
    many times it is asked.
    """
    mark = _agreed_on(OLD)
    now = 1000.0
    for expected in range(MAX_PUSH_ATTEMPTS):
        decision = decide_retry(
            sync_action=TITLE_UNCHANGED,
            title=NEW,
            claude_title=OLD,
            mark=mark,
            now=now,
        )
        assert decision.verdict == RETRY_PUSH
        assert decision.attempts_spent == expected
        mark = record_attempt(mark, label=NEW, now=now)
        now += MIN_ATTEMPT_INTERVAL_SECONDS * 2

    for _ in range(3):
        decision = decide_retry(
            sync_action=TITLE_UNCHANGED,
            title=NEW,
            claude_title=OLD,
            mark=mark,
            now=now,
        )
        assert decision.verdict == RETRY_EXHAUSTED
        assert decision.acts is False
        assert decision.attempts_spent == MAX_PUSH_ATTEMPTS
        now += MIN_ATTEMPT_INTERVAL_SECONDS * 2


def test_the_interval_floor_holds_without_spending_an_attempt():
    """A busy session must not burn the whole budget inside one turn.

    The trigger is a transcript that grew, which on an active session is
    every few seconds. Without the floor, five attempts would be spent in
    seconds on a transient measured at 2m33s.
    """
    mark = record_attempt(_agreed_on(OLD), label=NEW, now=1000.0)
    decision = decide_retry(
        sync_action=TITLE_UNCHANGED,
        title=NEW,
        claude_title=OLD,
        mark=mark,
        now=1000.0 + MIN_ATTEMPT_INTERVAL_SECONDS / 2,
    )
    assert decision.verdict == RETRY_WAITING
    assert decision.acts is False
    assert decision.attempts_spent == 1

    later = decide_retry(
        sync_action=TITLE_UNCHANGED,
        title=NEW,
        claude_title=OLD,
        mark=mark,
        now=1000.0 + MIN_ATTEMPT_INTERVAL_SECONDS + 1,
    )
    assert later.verdict == RETRY_PUSH


def test_renaming_again_starts_a_fresh_budget():
    """A new label is a new fact, not a retry of the one it replaced.

    Without this the user's second rename would inherit the exhausted
    budget of their first and never be pushed at all, which is the
    original defect wearing the fix's clothes.
    """
    mark = _agreed_on(OLD)
    for _ in range(MAX_PUSH_ATTEMPTS):
        mark = record_attempt(mark, label=NEW, now=0.0)
    assert budget_for(mark, NEW) == MAX_PUSH_ATTEMPTS
    assert budget_for(mark, "a later name") == 0

    decision = decide_retry(
        sync_action=TITLE_UNCHANGED,
        title="a later name",
        claude_title=OLD,
        mark=mark,
        now=10_000.0,
    )
    assert decision.verdict == RETRY_PUSH
    assert decision.label == "a later name"


def test_an_attempt_carries_the_ordering_frame_through_untouched():
    """Spending an attempt says nothing about which side is newer.

    If a failing push could move the frame it would slowly re-authorise
    itself, which is how a bounded retry turns back into an unbounded
    one.
    """
    mark = record_attempt(_agreed_on(OLD), label=NEW, now=5.0)
    assert mark.agreed_title == OLD
    assert mark.attempts == 1
    assert mark.last_attempt_at == 5.0


def test_an_agreement_clears_a_pending_budget():
    """Whatever was pending is resolved once the two sides agree again."""
    mark = record_attempt(_agreed_on(OLD), label=NEW, now=5.0)
    settled = record_agreement(mark, NEW)
    assert settled.agreed_title == NEW
    assert settled.attempts == 0
    assert settled.attempted_label is None
    assert settled.last_attempt_at is None


# ---------------------------------------------------------------------
# THE LEDGER.
# ---------------------------------------------------------------------


@pytest.fixture
def ledger(tmp_path):
    """A throwaway state directory with the process cache cleared.

    Description: the cache is keyed on the directory it was loaded from,
      but clearing it explicitly means one test cannot inherit another's
      marks even when both resolve the same path.
    Inputs: tmp_path (pathlib.Path).
    Output: pathlib.Path - the state directory.
    """
    store.reset_cache()
    yield tmp_path
    store.reset_cache()


def test_a_mark_survives_the_process_that_wrote_it(ledger):
    """The frame has to outlive a restart or every row refuses forever.

    An agreement is witnessed once and then, on a healthy box, never
    again for the life of that name. An in-memory ledger would therefore
    lose the ordering frame on the first restart and the retry would
    answer 'unordered' for everything while looking perfectly healthy.
    """
    store.save_mark(ledger, "u1:7", _agreed_on(OLD))
    store.reset_cache()

    recovered = store.mark_for(ledger, "u1:7")
    assert recovered is not None
    assert recovered.agreed_title == OLD


def test_a_spent_budget_survives_a_restart(ledger):
    """Otherwise the bound refills on every restart and is not a bound."""
    mark = _agreed_on(OLD)
    for _ in range(MAX_PUSH_ATTEMPTS):
        mark = record_attempt(mark, label=NEW, now=1.0)
        store.save_mark(ledger, "u1:7", mark)
    store.reset_cache()

    assert budget_for(store.mark_for(ledger, "u1:7"), NEW) == MAX_PUSH_ATTEMPTS


def test_a_corrupt_ledger_fails_closed(ledger):
    """A ledger that cannot be read must refuse, never authorise.

    NEGATIVE CONTROL for the store: the failure mode of this feature has
    to be a rename that stays unsynced, never a name overwritten on
    evidence that could not actually be read.
    """
    path = store.ledger_path(ledger)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ this is not json", encoding="utf-8")
    store.reset_cache()

    assert store.load_marks(ledger) == {}
    assert store.mark_for(ledger, "u1:7") is None
    assert (
        decide_retry(
            sync_action=TITLE_UNCHANGED,
            title=NEW,
            claude_title=OLD,
            mark=store.mark_for(ledger, "u1:7"),
            now=0.0,
        ).verdict
        == RETRY_UNORDERED
    )


def test_a_ledger_from_an_unrecognised_version_fails_closed(ledger):
    """A shape this build does not understand is not a shape to guess at."""
    path = store.ledger_path(ledger)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"version": 99, "marks": {"u1:7": {"agreed_title": OLD}}}),
        encoding="utf-8",
    )
    store.reset_cache()
    assert store.load_marks(ledger) == {}


def test_a_state_directory_that_cannot_be_named_reads_as_empty():
    """No directory means no marks, which means refuse. Never raise."""
    store.reset_cache()
    assert store.load_marks(None) == {}
    assert store.mark_for(None, "u1:7") is None
    assert store.save_mark(None, "u1:7", _agreed_on(OLD)) is False
    store.reset_cache()


def test_an_unchanged_mark_does_not_rewrite_the_file(ledger):
    """The steady state is a comparison in memory and no filesystem work.

    This runs on every transcript append for every live session, so a
    write per pass would be the kind of small cost this project has
    already paid for twice.
    """
    mark = _agreed_on(OLD)
    assert store.save_mark(ledger, "u1:7", mark) is True
    before = store.ledger_path(ledger).stat().st_mtime_ns
    assert store.save_mark(ledger, "u1:7", mark) is False
    assert store.ledger_path(ledger).stat().st_mtime_ns == before


def test_the_ledger_cannot_grow_without_bound(ledger):
    """Entries are capped, and a pending budget outlives a bare frame.

    Dropping an ordering frame costs one refusal. Dropping a pending
    budget costs the bound itself, so eviction takes the frames first.
    """
    pending = record_attempt(_agreed_on(OLD), label=NEW, now=500.0)
    store.save_mark(ledger, "pending:1", pending)
    for index in range(store.MAX_ENTRIES + 20):
        store.save_mark(ledger, f"frame:{index}", _agreed_on(OLD))

    marks = store.load_marks(ledger)
    assert len(marks) <= store.MAX_ENTRIES
    assert marks.get("pending:1") == pending
