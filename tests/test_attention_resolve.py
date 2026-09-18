"""One test per rung of the attention precedence table, and one per rule.

WHAT THIS SUITE IS FOR. ``resolve_attention`` is the only thing standing
between four tiers of evidence and a toast on somebody's phone. Over 50.8
measured hours the old path fired 501 "your session is done" toasts and
410 of the 459 attributable ones were wrong, every one of them because a
background-agent count that was never written got read as a count of
zero. So the tests that matter here are not the happy path. They are the
ones that prove each REFUSAL can actually fire, and that no combination
of missing evidence adds up to ``done_idle``.

GOTCHA 11 IS THE HOUSE RULE THIS FILE IS WRITTEN AGAINST: a green check
must first prove it can go red. Every rung below is asserted on all three
axes at once - STATE, REASON and TIER - because a resolver that answered
``unknown`` to everything would satisfy a state-only assertion on half
this file. The tier is the axis that catches the subtle failure: a verdict
with the right state that came from the wrong evidence is a verdict that
will be wrong the next time that evidence changes.

SEVEN CLAIMS ARE PROVEN BY MUTATION, not by assertion alone. Each was
broken in ``resolve.py`` or in ``transcript_facts.py``, one at a time,
and confirmed to turn a named test in this file red: an absent pending
count defaulting to zero; the pane tier producing ``done_idle``; an
untrusted claude version reaching the ``done_idle`` rung; the
evidence-disagrees refusal being dropped so a stale ``busy`` answers
done; an OMITTED count on a modern record refusing to read as zero, which
makes ``done_idle`` unreachable on real data; the open-question rung
put back below the background-agent rungs, which loses the question toast
for every session that asks something while an agent is still running;
and a LONE stale idle record allowed to originate ``done_idle`` with
nothing corroborating it, which is rule (c) itself.

WHY THE EVIDENCE IS BUILT THROUGH THE REAL READERS. Every
``RegistryRecord`` below comes out of ``parse_registry_record`` or
``registry_for_session`` fed a payload in claude 2.1.266's own on-disk
shape, and the ambiguous-pane case is built by writing two real files and
running the real index scan. A suite whose fixtures were hand-built
dataclasses would keep passing after the reader's field names drifted,
which is the failure shape gotcha 12 names.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from src.core.attention.display import to_display
from src.core.attention.evidence import (
    ALL_REASONS,
    ALL_STATES,
    FAMILY_CLAUDE,
    REASON_AMBIGUOUS_PANE,
    REASON_EVIDENCE_DISAGREES,
    REASON_INPUT,
    REASON_NO_EVIDENCE,
    REASON_PANE_DEAD,
    REASON_PERMISSION,
    REASON_PLAN_APPROVAL,
    REASON_QUESTION,
    REASON_QUEUED_REINVOKE,
    REASON_REGISTRY_ABSENT,
    REASON_REGISTRY_STALE,
    REASON_REGISTRY_UNREADABLE,
    REASON_SHELL,
    REASON_STREAMING,
    REASON_SUBAGENTS,
    REASON_TOOL,
    REASON_TURN_ENDED,
    STATE_BUSY,
    STATE_DONE_IDLE,
    STATE_NEEDS_USER,
    STATE_UNKNOWN,
    TIER_NONE,
    TIER_PANE,
    TIER_REGISTRY,
    TIER_TMUX,
    TIER_TRANSCRIPT,
    AttentionVerdict,
    Evidence,
    PaneVerdict,
)
from src.core.attention.pane_markers import classify_pane_tail
from src.core.attention.registry_read import (
    REG_BUSY,
    REG_IDLE,
    REG_OK,
    REG_SHELL,
    REG_UNREADABLE,
    REG_WAITING,
    REGISTRY_STALE_AFTER_SECONDS,
    parse_registry_record,
    pid_is_running,
    registry_for_session,
)
from src.core.attention.resolve import (
    AMBIGUOUS_PANE_DETAIL_MARKER,
    DONE_QUIET_SECONDS,
    STREAMING_LOOKBACK_SECONDS,
    WAITING_DIALOG_OPEN,
    WAITING_INPUT_NEEDED,
    WAITING_PERMISSION_PROMPT,
    WAITING_SANDBOX_REQUEST,
    WAITING_WORKER_REQUEST,
    resolve_attention,
)
from src.core.attention.transcript_facts import (
    FACTS_FOUND,
    FACTS_NO_RECORD,
    FACTS_UNREADABLE,
    TranscriptFacts,
)
from src.core.session_status import (
    LIVENESS_GONE,
    LIVENESS_LIVE,
    LIVENESS_UNKNOWN,
    STATUS_DEAD,
    STATUS_FINISHED_UNREAD,
    STATUS_IDLE,
    STATUS_NOTICE,
    STATUS_QUESTION,
    STATUS_RUNNING,
    STATUS_UNKNOWN,
    STATUS_WORKING,
    STATUS_WORKING_SUBAGENT,
)

# ---------------------------------------------------------------------
# The clock. Fixed, because the resolver takes ``now`` on the evidence
# and every age in this file is therefore an exact number rather than a
# race with the test runner.
# ---------------------------------------------------------------------

NOW = datetime(2026, 9, 13, 18, 0, 0, tzinfo=timezone.utc)

#: One real registry payload, copied out of ``~/.claude/sessions/*.json``
#: on 2026-09-13 running claude 2.1.266. Keys, the epoch-millis shape and
#: the ``<session>:@<window>.%<pane>`` tmux spelling are the writer's.
REGISTRY_PAYLOAD = {
    "sessionId": "83e263d8-bc64-4bcb-8244-632664f0ecb6",
    "cwd": "/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode",
    "pid": 51292,
    "startedAt": 1789095742551,
    "version": "2.1.266",
    "kind": "interactive",
    "entrypoint": "cli",
    "tmux": "cloude_cloudecode-2:@205.%205",
    "status": "idle",
    "updatedAt": 1789327656518,
    "statusUpdatedAt": 1789327655830,
}

#: The bare tmux session name inside that ``tmux`` field.
TMUX_NAME = "cloude_cloudecode-2"

#: ``startedAt`` above, in epoch SECONDS, plus a minute. Handing this to
#: ``registry_for_session`` as the tmux session's creation time makes the
#: record older than the session it claims, which is the instance floor
#: the reader refuses on.
LATER_THAN_STARTED_EPOCH = 1789095742 + 60


def _millis(at: datetime) -> int:
    """Epoch milliseconds, the unit claude writes its timestamps in.

    Inputs: at (datetime), timezone aware. Output: int.
    """
    return int(at.timestamp() * 1000)


def _registry(
    status: str,
    *,
    waiting_for: str = None,
    version: object = "2.1.266",
    status_age: float = 10.0,
):
    """A REG_OK record, built by the real parser from a real payload.

    Description: only the four fields a rung reads are parameterised;
      everything else stays as claude wrote it. ``version`` takes any
      type so the untrusted cases can pass the real garbage on disk, and
      ``status_age`` is seconds before NOW.
    Inputs: status, waiting_for (omitted when None), version, status_age.
    Output: RegistryRecord with verdict REG_OK.
    """
    payload = dict(REGISTRY_PAYLOAD)
    payload["status"] = status
    payload["version"] = version
    payload["statusUpdatedAt"] = _millis(NOW - timedelta(seconds=status_age))
    if waiting_for is not None:
        payload["waitingFor"] = waiting_for
    return parse_registry_record(payload, path_pid=None)


#: "We looked and there is no record for this session", through the real
#: lookup against an empty index.
REGISTRY_ABSENT = registry_for_session(tmux_name=TMUX_NAME, index={})

#: "Something was there and it could not be trusted", from the real
#: parser fed an object with no pid and no status.
REGISTRY_UNREADABLE = parse_registry_record({}, path_pid=None)

#: "A record exists but it is about a DIFFERENT run", from the real
#: instance-floor gate rather than from a hand-set verdict.
REGISTRY_STALE = registry_for_session(
    tmux_name=TMUX_NAME,
    index={TMUX_NAME: _registry(REG_IDLE)},
    session_started_epoch=LATER_THAN_STARTED_EPOCH,
)


def _facts(verdict: str = FACTS_FOUND, **fields) -> TranscriptFacts:
    """A transcript answer with nothing in it but what the test names.

    Inputs: verdict (a FACTS_* constant); fields (any TranscriptFacts
    field). Output: TranscriptFacts.
    """
    return TranscriptFacts(verdict=verdict, **fields)


def _at_rest(*, pending: int = 0, quiet: float = 10.0, **fields) -> TranscriptFacts:
    """A window whose LAST word is a turn-end record: the shape rung 8 needs.

    Description: the turn end is newer than the newest assistant record,
      which is what ``_turn_at_rest`` measures, and the newest append is
      ``quiet`` seconds old so the caller drives the rung-8 quiet gate.
    Inputs: pending (the count actually written), quiet (seconds since
    the last append), fields (overrides). Output: TranscriptFacts.
    """
    end = NOW - timedelta(seconds=quiet)
    base = dict(
        pending_background_agents=pending,
        pending_field_present=True,
        turn_end_at=end,
        newest_assistant_at=end - timedelta(seconds=1),
        newest_append_at=end,
        detail="the turn ended with %s background agents pending" % pending,
    )
    base.update(fields)
    return TranscriptFacts(verdict=FACTS_FOUND, **base)


def _turn_open(*, quiet: float = 2.0, **fields) -> TranscriptFacts:
    """A window whose LAST word is claude: an open turn at EOF.

    Description: the shape a permission prompt leaves behind. claude
      emits the tool_use then writes nothing until the human answers, so
      the newest assistant record sits after the last turn boundary.
    Inputs: quiet (seconds since that append), fields (overrides).
    Output: TranscriptFacts with verdict FACTS_FOUND.
    """
    spoke = NOW - timedelta(seconds=quiet)
    base = dict(
        turn_end_at=spoke - timedelta(seconds=30),
        newest_assistant_at=spoke,
        newest_append_at=spoke,
        detail="claude spoke after the last turn end and stopped",
    )
    base.update(fields)
    return TranscriptFacts(verdict=FACTS_FOUND, **base)


def _evidence(
    *,
    registry=None,
    transcript: TranscriptFacts = None,
    pane: PaneVerdict = None,
    tmux_liveness: str = LIVENESS_LIVE,
    family: str = FAMILY_CLAUDE,
    now: datetime = NOW,
) -> Evidence:
    """One evidence bundle, defaulting every tier to a refusal.

    Description: the defaults matter. A test that does not name a tier
      gets that tier's "we know nothing" answer, so nothing in this file
      can pass because of a fact it never stated.
    Inputs: registry, transcript, pane, tmux_liveness, family, now.
    Output: Evidence.
    """
    return Evidence(
        tmux_liveness=tmux_liveness,
        agent_family=family,
        registry=registry if registry is not None else REGISTRY_ABSENT,
        transcript=transcript if transcript is not None else _facts(FACTS_NO_RECORD),
        pane=pane,
        now=now,
    )


#: A permission prompt positively on screen.
PANE_PERMISSION = PaneVerdict(
    permission_dialog=True,
    question_dialog=False,
    trust_dialog=False,
    detail="matched permission",
)

#: An AskUserQuestion menu positively on screen.
PANE_QUESTION = PaneVerdict(
    permission_dialog=False,
    question_dialog=True,
    trust_dialog=False,
    detail="matched question",
)

#: A screen we READ and measured clear. The positive negative.
PANE_CLEAR = PaneVerdict(
    permission_dialog=False,
    question_dialog=False,
    trust_dialog=False,
    detail="matched no dialog family",
)

#: What the REAL pane reader answers for a capture that held no text.
#: All three families None, which is a failed read and not a clear screen.
PANE_BLANK = classify_pane_tail([])


def _assert_verdict(
    verdict: AttentionVerdict, state: str, reason: str, tier: str
) -> None:
    """Assert all three axes at once, and report all three when one fails.

    Description: asserting the tuple rather than three separate lines
      means a failure names the rung that actually answered instead of
      only the first axis that differed.
    Inputs: verdict (AttentionVerdict); state, reason, tier (str).
    Output: None. Raises AssertionError.
    """
    assert (verdict.state, verdict.reason, verdict.tier) == (
        state,
        reason,
        tier,
    ), verdict.detail


# =====================================================================
# ONE TEST PER RUNG, 0 THROUGH 10.
# =====================================================================


def test_rung_0_a_pane_tmux_measured_gone_outranks_every_other_tier():
    """Death is measured, and nothing a dead pane's leftovers say matters."""
    verdict = resolve_attention(
        _evidence(
            tmux_liveness=LIVENESS_GONE,
            # Everything below would otherwise answer done_idle at rung 8.
            registry=_registry(REG_IDLE),
            transcript=_at_rest(pending=0),
        )
    )

    _assert_verdict(verdict, STATE_UNKNOWN, REASON_PANE_DEAD, TIER_TMUX)
    assert verdict.settle_required is False


def test_rung_1_two_live_records_on_one_pane_refuse_instead_of_picking(tmp_path):
    """No honest tie-break exists, so the resolver raises nothing at all."""
    first = os.getpid()
    second = os.getppid()
    if pid_is_running(second) is not True or second == first:
        pytest.skip("no second live pid available to collide with")

    for pid in (first, second):
        body = dict(REGISTRY_PAYLOAD, pid=pid, status=REG_WAITING)
        (tmp_path / ("%d.json" % pid)).write_text(json.dumps(body), encoding="utf-8")

    # Built through the REAL index scan, so the marker string the rung
    # matches on cannot drift on one side without this going red.
    record = registry_for_session(tmux_name=TMUX_NAME, directory=str(tmp_path))
    assert record.verdict == REG_UNREADABLE
    assert AMBIGUOUS_PANE_DETAIL_MARKER in record.detail

    verdict = resolve_attention(
        _evidence(
            registry=record,
            # A queued re-invoke would answer at rung 3 if rung 1 let it.
            transcript=_at_rest(queued_reinvoke=True),
        )
    )

    _assert_verdict(verdict, STATE_UNKNOWN, REASON_AMBIGUOUS_PANE, TIER_REGISTRY)
    assert str(first) in verdict.detail and str(second) in verdict.detail


def test_rung_3_a_queued_reinvoke_outranks_a_finished_turn():
    """The exact moment the old code raised done: a turn that ends and restarts."""
    verdict = resolve_attention(
        _evidence(
            # A registry idle over a settled turn: rung 8's happy path.
            registry=_registry(REG_IDLE),
            transcript=_at_rest(pending=0, queued_reinvoke=True),
        )
    )

    _assert_verdict(verdict, STATE_BUSY, REASON_QUEUED_REINVOKE, TIER_TRANSCRIPT)
    assert verdict.settle_required is False


def test_rung_4_background_agents_outrank_everything_the_registry_says():
    """410 of 459 false toasts were this condition, reported as done."""
    counted = resolve_attention(
        _evidence(registry=_registry(REG_IDLE), transcript=_at_rest(pending=2))
    )
    _assert_verdict(counted, STATE_BUSY, REASON_SUBAGENTS, TIER_TRANSCRIPT)
    assert counted.pending_background_agents == 2

    # The second arm: no count at all, but launches with no completions
    # behind them. The ledger is derived from records, not from a field.
    ledgered = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE),
            transcript=_at_rest(pending=0, open_async_agents=1),
        )
    )
    _assert_verdict(ledgered, STATE_BUSY, REASON_SUBAGENTS, TIER_TRANSCRIPT)


def test_rung_2_the_transcript_names_which_question_is_open():
    """The pane can say a dialog is there; only this says which one."""
    question = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
            transcript=_turn_open(blocked_on_tool="AskUserQuestion"),
        )
    )
    _assert_verdict(question, STATE_NEEDS_USER, REASON_QUESTION, TIER_TRANSCRIPT)
    assert question.settle_required is True

    plan = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for=WAITING_PERMISSION_PROMPT),
            transcript=_turn_open(blocked_on_tool="ExitPlanMode"),
        )
    )
    _assert_verdict(plan, STATE_NEEDS_USER, REASON_PLAN_APPROVAL, TIER_TRANSCRIPT)


def test_rung_2_an_open_question_outranks_background_agents_still_running():
    """A MISSED "your turn", proven: a question asked while an agent runs."""
    # THE MEASURED SHAPE. Replaying a real AskUserQuestion tail gives
    # blocked_on_tool="AskUserQuestion" together with a pending count of
    # 1, because the session launched an agent and then asked the user
    # something while it worked. With the question rung below the
    # background-agent rungs this answered busy(subagents) and the
    # question toast was never raised at all.
    asked_while_working = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE),
            transcript=_turn_open(
                blocked_on_tool="AskUserQuestion",
                pending_background_agents=1,
                pending_field_present=True,
            ),
        )
    )
    _assert_verdict(
        asked_while_working, STATE_NEEDS_USER, REASON_QUESTION, TIER_TRANSCRIPT
    )
    assert asked_while_working.settle_required is True

    # The same over the other arm of that rung: launches with no
    # completion behind them, counted from records rather than a field.
    ledgered = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE),
            transcript=_turn_open(
                blocked_on_tool="ExitPlanMode", open_async_agents=2
            ),
        )
    )
    _assert_verdict(
        ledgered, STATE_NEEDS_USER, REASON_PLAN_APPROVAL, TIER_TRANSCRIPT
    )

    # And over a queued re-invoke, which is the other thing that can be
    # true at the same time: the queued notification cannot be processed
    # while the main loop sits on the dialog, so it is what happens after
    # the human answers, not what the session is waiting on now.
    also_queued = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE),
            transcript=_turn_open(
                blocked_on_tool="AskUserQuestion",
                queued_reinvoke=True,
                pending_background_agents=3,
                pending_field_present=True,
            ),
        )
    )
    _assert_verdict(
        also_queued, STATE_NEEDS_USER, REASON_QUESTION, TIER_TRANSCRIPT
    )

    # No registry status gates this rung: a busy record is written on
    # change and has been seen days stale, while the unanswered tool_use
    # is claude's own record of the question it just asked.
    for status in (REG_BUSY, REG_WAITING, REG_SHELL):
        verdict = resolve_attention(
            _evidence(
                registry=_registry(status),
                transcript=_turn_open(
                    blocked_on_tool="AskUserQuestion",
                    pending_background_agents=1,
                    pending_field_present=True,
                ),
            )
        )
        _assert_verdict(verdict, STATE_NEEDS_USER, REASON_QUESTION, TIER_TRANSCRIPT)


def test_rung_5_a_dialog_on_screen_outranks_what_the_registry_is_waiting_for():
    """A rectangle of text is the strongest confirmation a session is stopped."""
    permission = resolve_attention(
        _evidence(
            # waitingFor says "input needed", which rung 5c would paint
            # as notice. The pane says permission, and the pane wins.
            registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
            transcript=_at_rest(),
            pane=PANE_PERMISSION,
        )
    )
    _assert_verdict(permission, STATE_NEEDS_USER, REASON_PERMISSION, TIER_PANE)
    assert permission.settle_required is True

    question = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
            transcript=_at_rest(),
            pane=PANE_QUESTION,
        )
    )
    _assert_verdict(question, STATE_NEEDS_USER, REASON_QUESTION, TIER_PANE)


def test_rung_5b_an_unreadable_pane_over_an_open_turn_fails_toward_the_human():
    """A permission prompt is never suppressed, including by a failed look."""
    verdict = resolve_attention(
        _evidence(
            # "input needed" would be a NOTICE at rung 5c. Reaching
            # permission here proves rung 5b answered, not 5c.
            registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
            transcript=_turn_open(),
            pane=None,
        )
    )

    _assert_verdict(verdict, STATE_NEEDS_USER, REASON_PERMISSION, TIER_TRANSCRIPT)
    assert verdict.settle_required is True


@pytest.mark.parametrize(
    "waiting_for, reason",
    [
        (WAITING_INPUT_NEEDED, REASON_INPUT),
        (WAITING_PERMISSION_PROMPT, REASON_PERMISSION),
        (WAITING_SANDBOX_REQUEST, REASON_INPUT),
        (WAITING_WORKER_REQUEST, REASON_INPUT),
        (WAITING_DIALOG_OPEN, REASON_INPUT),
    ],
)
def test_rung_5c_claude_names_what_it_is_waiting_for_and_is_believed(
    waiting_for, reason
):
    """All five values claude writes into waitingFor are mapped, none guessed."""
    verdict = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for=waiting_for),
            transcript=_at_rest(),
            pane=None,
        )
    )

    _assert_verdict(verdict, STATE_NEEDS_USER, reason, TIER_REGISTRY)
    # The REGISTRY decided, so this one is instant.
    assert verdict.settle_required is False


def test_rung_5d_a_waiting_nothing_corroborates_refuses_rather_than_picking():
    """A waiting has been observed to outlive its own dialog by nine minutes."""
    vetoed = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
            transcript=_at_rest(),
            pane=PANE_CLEAR,
        )
    )
    _assert_verdict(vetoed, STATE_UNKNOWN, REASON_EVIDENCE_DISAGREES, TIER_REGISTRY)

    unnamed = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for="something new in 2.2"),
            transcript=_at_rest(),
            pane=None,
        )
    )
    _assert_verdict(unnamed, STATE_UNKNOWN, REASON_EVIDENCE_DISAGREES, TIER_REGISTRY)


def test_rung_6_a_registry_busy_is_refined_by_the_shape_at_the_end_of_the_window():
    """Busy is instant either way; only the shade comes from the transcript."""
    streaming = resolve_attention(
        _evidence(
            registry=_registry(REG_BUSY, status_age=1.0),
            transcript=_at_rest(quiet=10.0),
        )
    )
    _assert_verdict(streaming, STATE_BUSY, REASON_STREAMING, TIER_REGISTRY)
    assert streaming.settle_required is False

    running_a_tool = resolve_attention(
        _evidence(
            registry=_registry(REG_BUSY, status_age=1.0),
            transcript=_turn_open(quiet=2.0),
        )
    )
    _assert_verdict(running_a_tool, STATE_BUSY, REASON_TOOL, TIER_REGISTRY)


def test_rung_6a_a_busy_older_than_the_turn_end_it_contradicts_refuses():
    """Write-on-change means a busy can outlive the turn it described."""
    verdict = resolve_attention(
        _evidence(
            # Stamped 60s ago; the turn ended 10s ago, which is after it.
            registry=_registry(REG_BUSY, status_age=60.0),
            transcript=_at_rest(quiet=10.0),
        )
    )

    _assert_verdict(verdict, STATE_UNKNOWN, REASON_EVIDENCE_DISAGREES, TIER_REGISTRY)


def test_rung_7_a_shell_command_the_user_started_is_its_own_rung():
    """claude is idle underneath it, and a later cut may want to say so."""
    verdict = resolve_attention(
        _evidence(registry=_registry(REG_SHELL), transcript=_at_rest())
    )

    _assert_verdict(verdict, STATE_BUSY, REASON_SHELL, TIER_REGISTRY)
    assert verdict.settle_required is False


def test_rung_8_the_only_path_to_done_idle_needs_every_gate_at_once():
    """The one state that raises a toast, and the one with the most gates."""
    verdict = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE, status_age=10.0),
            transcript=_at_rest(pending=0, quiet=DONE_QUIET_SECONDS + 1),
        )
    )

    _assert_verdict(verdict, STATE_DONE_IDLE, REASON_TURN_ENDED, TIER_REGISTRY)
    assert verdict.settle_required is False
    assert verdict.pending_background_agents == 0

    # Now remove ONE gate at a time and prove each of them is load
    # bearing. A count that was never written is the defect this whole
    # package exists to remove, so it leads.
    #
    # WHERE THE ZERO COMES FROM, MEASURED. claude 2.1.266 never writes a
    # literal 0: across 300 turn-end records in 40 transcripts, 236 carry
    # a positive count and 64 OMIT the key entirely. So the reader turns
    # an omitted field on a record whose own version is 2.1.241 or newer
    # into a zero, and this rung sees that zero like any other. What
    # stays refused is a count that could not be determined at all, which
    # is what the next assertion pins: a None, from a record too old or
    # too unreadable to have written one, never becomes a rest claim.
    never_written = _evidence(
        registry=_registry(REG_IDLE),
        transcript=_at_rest(pending=None, pending_field_present=False),
    )
    assert resolve_attention(never_written).state != STATE_DONE_IDLE
    assert resolve_attention(never_written).pending_background_agents is None

    still_quieting = _evidence(
        registry=_registry(REG_IDLE),
        transcript=_at_rest(pending=0, quiet=DONE_QUIET_SECONDS - 1),
    )
    assert resolve_attention(still_quieting).state != STATE_DONE_IDLE


def test_rung_8_a_turn_whose_count_was_omitted_still_reaches_done_idle():
    """The shape 83 of 83 real done toasts have, and every one was lost."""
    # claude 2.1.266 OMITS pendingBackgroundAgentCount when nothing is
    # pending, so on real data a finished turn arrives here with the
    # count read as 0 and the field recorded as absent. This rung must
    # see an ordinary zero, or done_idle is unreachable in production
    # while every synthetic test that writes a literal 0 still passes.
    omitted = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE, status_age=10.0),
            transcript=_at_rest(
                pending=0,
                pending_field_present=False,
                quiet=DONE_QUIET_SECONDS + 1,
            ),
        )
    )

    _assert_verdict(omitted, STATE_DONE_IDLE, REASON_TURN_ENDED, TIER_REGISTRY)
    assert omitted.pending_background_agents == 0

    # AND THE PAIR THAT MUST NOT COLLAPSE WITH IT: a window holding no
    # turn-end record at all is not a zero, and never reaches done_idle.
    no_record = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE, status_age=10.0),
            transcript=_facts(
                FACTS_NO_RECORD,
                newest_append_at=NOW - timedelta(seconds=DONE_QUIET_SECONDS + 1),
            ),
        )
    )
    assert no_record.state != STATE_DONE_IDLE
    assert no_record.pending_background_agents is None


def test_rung_8b_an_idle_over_a_transcript_still_moving_is_still_generating():
    """The status settles 25ms after the record, so read the record."""
    verdict = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE, status_age=5.0),
            transcript=_turn_open(quiet=5.0),
        )
    )

    _assert_verdict(verdict, STATE_BUSY, REASON_STREAMING, TIER_TRANSCRIPT)

    # The lookback is a real bound: the same shape older than it refuses
    # rather than claiming the session is generating.
    long_ago = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE, status_age=5.0),
            transcript=_turn_open(quiet=STREAMING_LOOKBACK_SECONDS + 1),
        )
    )
    assert long_ago.state == STATE_UNKNOWN


@pytest.mark.parametrize(
    "record, reason",
    [
        (REGISTRY_ABSENT, REASON_REGISTRY_ABSENT),
        (REGISTRY_STALE, REASON_REGISTRY_STALE),
        (REGISTRY_UNREADABLE, REASON_REGISTRY_UNREADABLE),
    ],
)
def test_rung_9_without_a_registry_the_transcript_may_say_busy_but_never_done(
    record, reason
):
    """Each refusal keeps its own name, and a perfect transcript is still not done."""
    # A transcript that clears every gate rung 8 has. Without claude's own
    # status there is still no way to tell a finished turn from one about
    # to write its next line.
    refused = resolve_attention(
        _evidence(registry=record, transcript=_at_rest(pending=0))
    )
    _assert_verdict(refused, STATE_UNKNOWN, reason, TIER_REGISTRY)

    # The transcript may still say a question is open ...
    blocked = resolve_attention(
        _evidence(registry=record, transcript=_turn_open(blocked_on_tool="AskUserQuestion"))
    )
    _assert_verdict(blocked, STATE_NEEDS_USER, REASON_QUESTION, TIER_TRANSCRIPT)
    assert blocked.settle_required is True

    # ... and it may still say agents are running.
    agents = resolve_attention(
        _evidence(registry=record, transcript=_at_rest(pending=3))
    )
    _assert_verdict(agents, STATE_BUSY, REASON_SUBAGENTS, TIER_TRANSCRIPT)


def test_rung_10_a_status_string_this_resolver_does_not_know_refuses():
    """Four values have been seen; a future claude may write a fifth."""
    verdict = resolve_attention(
        _evidence(registry=_registry("compacting"), transcript=_at_rest())
    )

    _assert_verdict(verdict, STATE_UNKNOWN, REASON_NO_EVIDENCE, TIER_NONE)
    assert "compacting" in verdict.detail


# =====================================================================
# THE FIVE RULES UNDER THE TABLE.
# =====================================================================


#: Every shape a pane read can come back in, including the two that are
#: easy to confuse: a capture we never took (None) and a capture that
#: held no text (all three families None).
PANE_TABLE = [
    ("no capture attempted", None),
    ("capture held no text", PANE_BLANK),
    ("read and clear", PANE_CLEAR),
    ("permission prompt", PANE_PERMISSION),
    ("question menu", PANE_QUESTION),
    ("trust dialog only", PaneVerdict(trust_dialog=True, detail="matched trust")),
    (
        "permission and question at once",
        PaneVerdict(permission_dialog=True, question_dialog=True, detail="both"),
    ),
]


def test_rule_a_no_pane_input_over_any_registry_refusal_can_produce_done_idle():
    """A screen with nothing on it is not a finished turn."""
    registries = [
        ("absent", REGISTRY_ABSENT),
        ("stale", REGISTRY_STALE),
        ("unreadable", REGISTRY_UNREADABLE),
        ("waiting", _registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED)),
        ("busy", _registry(REG_BUSY, status_age=1.0)),
        ("unrecognised status", _registry("compacting")),
    ]

    for pane_name, pane in PANE_TABLE:
        for registry_name, registry in registries:
            verdict = resolve_attention(
                _evidence(
                    registry=registry,
                    # A transcript that would clear every rung-8 gate if
                    # the registry ever let it through.
                    transcript=_at_rest(pending=0),
                    pane=pane,
                )
            )
            where = "%s pane over a %s registry" % (pane_name, registry_name)
            assert verdict.state != STATE_DONE_IDLE, where
            if verdict.tier == TIER_PANE:
                assert verdict.state == STATE_NEEDS_USER, where


def test_rule_b_a_single_quiet_pane_read_never_retires_a_needs_user():
    """It refuses, so the ledger freezes on the last confirmed verdict."""
    named_question = _evidence(
        registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
        transcript=_turn_open(blocked_on_tool="AskUserQuestion"),
    )
    # The transcript named the question, so a clear pane cannot even
    # reach the veto: rung 2 is above it.
    assert resolve_attention(named_question).state == STATE_NEEDS_USER
    with_clear_pane = resolve_attention(
        _evidence(
            registry=named_question.registry,
            transcript=named_question.transcript,
            pane=PANE_CLEAR,
        )
    )
    _assert_verdict(with_clear_pane, STATE_NEEDS_USER, REASON_QUESTION, TIER_TRANSCRIPT)

    # And where the pane CAN veto, the answer is a refusal, never a
    # resting state and never a working one. A refusal raises nothing and
    # clears nothing, which is how the earlier needs_user survives.
    vetoed = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for=WAITING_PERMISSION_PROMPT),
            transcript=_at_rest(pending=0),
            pane=PANE_CLEAR,
        )
    )
    _assert_verdict(vetoed, STATE_UNKNOWN, REASON_EVIDENCE_DISAGREES, TIER_REGISTRY)


def test_rule_c_a_registry_record_about_a_previous_run_may_never_originate_done_idle():
    """A record that is not about this process corroborates nothing at all."""
    perfect_transcript = _at_rest(pending=0, quiet=10.0)

    # Refused by the real instance floor: this is a DIFFERENT run's
    # record, not an old record about this one, so no amount of
    # transcript agreement can rehabilitate it.
    previous_run = resolve_attention(
        _evidence(registry=REGISTRY_STALE, transcript=perfect_transcript)
    )
    _assert_verdict(previous_run, STATE_UNKNOWN, REASON_REGISTRY_STALE, TIER_REGISTRY)

    # Positive control: a record about THIS run, well inside the
    # staleness window, and the same evidence answers done. Without this,
    # a resolver that refused every idle would pass the line above.
    inside = resolve_attention(
        _evidence(
            registry=_registry(
                REG_IDLE, status_age=REGISTRY_STALE_AFTER_SECONDS - 1
            ),
            transcript=perfect_transcript,
        )
    )
    assert inside.state == STATE_DONE_IDLE


def test_a_stale_idle_registry_with_transcript_corroboration_reaches_done_idle():
    """Age is not doubt for a write-on-change file when a second source agrees.

    Measured live on 2026-09-13: cloude_LeaveIt (idle stamp 37.3h old),
    cloude_Ob (98.5h) and cloude_Shopify (37.3h) each had a transcript
    independently recording the turn ended with nothing pending, and each
    answered unknown(registry_stale) forever. A session that has been
    idle for two days carries a two-day-old idle stamp BECAUSE NOTHING
    HAPPENED, which is confirmation, not doubt.
    """
    for hours in (37.3, 98.5):
        verdict = resolve_attention(
            _evidence(
                registry=_registry(REG_IDLE, status_age=hours * 3600.0),
                transcript=_at_rest(pending=0, quiet=hours * 3600.0),
            )
        )
        where = "an idle stamp %.1fh old" % hours
        _assert_verdict(verdict, STATE_DONE_IDLE, REASON_TURN_ENDED, TIER_REGISTRY)
        assert verdict.pending_background_agents == 0, where
        assert verdict.settle_required is False, where
        # The verdict says out loud that it rested on corroboration, so a
        # log line cannot be mistaken for a fresh record.
        assert "corroborates" in verdict.detail, where
        assert (
            to_display(verdict, unread=False, tmux_status=STATUS_RUNNING)
            == STATUS_IDLE
        ), where


@pytest.mark.parametrize(
    "name, transcript",
    [
        # No turn-end record in the window at all. This is the shape the
        # other two live stale-idle sessions had, and unknown is the
        # honest answer for them.
        ("no turn-end record", _facts(FACTS_NO_RECORD)),
        # The file could not be read, which measures nothing.
        ("transcript unreadable", _facts(FACTS_UNREADABLE)),
        # A turn-end record exists but claude spoke after it, so the turn
        # never closed. Older than the streaming lookback, so rung 8b
        # cannot answer for it either.
        ("turn still open at EOF", _turn_open(quiet=STREAMING_LOOKBACK_SECONDS + 60)),
    ],
)
def test_a_stale_idle_registry_with_no_corroboration_still_answers_registry_stale(
    name, transcript
):
    """Rule (c) preserved: a LONE stale record may not originate done_idle."""
    verdict = resolve_attention(
        _evidence(
            registry=_registry(
                REG_IDLE, status_age=REGISTRY_STALE_AFTER_SECONDS + 1
            ),
            transcript=transcript,
        )
    )

    _assert_verdict(verdict, STATE_UNKNOWN, REASON_REGISTRY_STALE, TIER_REGISTRY)
    assert verdict.state != STATE_DONE_IDLE, name
    assert to_display(verdict, unread=False, tmux_status=STATUS_RUNNING) == (
        STATUS_UNKNOWN
    )


@pytest.mark.parametrize("version", ["2.1.240", "2.0.999", "", "nightly", None])
def test_corroboration_with_an_untrusted_version_never_reaches_done_idle(version):
    """Rule (d) sits above the new corroboration: an absent count is not a zero."""
    registry = _registry(
        REG_IDLE, version=version, status_age=REGISTRY_STALE_AFTER_SECONDS + 1
    )
    assert registry.trusts_pending_count is False

    verdict = resolve_attention(
        _evidence(registry=registry, transcript=_at_rest(pending=0, quiet=37.3 * 3600))
    )

    # The corroborating count came from a claude too old to have written
    # one, so it corroborates nothing and the stale refusal stands.
    _assert_verdict(verdict, STATE_UNKNOWN, REASON_REGISTRY_STALE, TIER_REGISTRY)
    assert verdict.pending_background_agents is None


def test_a_stale_waiting_registry_still_sustains_needs_user():
    """Narrowing rule (c) touched idle only; waiting is not weakened anywhere."""
    for waiting_for, reason in (
        (WAITING_INPUT_NEEDED, REASON_INPUT),
        (WAITING_PERMISSION_PROMPT, REASON_PERMISSION),
    ):
        verdict = resolve_attention(
            _evidence(
                registry=_registry(
                    REG_WAITING,
                    waiting_for=waiting_for,
                    status_age=98.5 * 3600.0,
                ),
                # A transcript that would clear every rung-8 gate if the
                # waiting group ever fell through to idle.
                transcript=_at_rest(pending=0, quiet=98.5 * 3600.0),
            )
        )
        where = "a %s waiting stamp 98.5h old" % waiting_for
        _assert_verdict(verdict, STATE_NEEDS_USER, reason, TIER_REGISTRY)
        assert verdict.state != STATE_DONE_IDLE, where


@pytest.mark.parametrize(
    "version", ["2.1.240", "2.0.999", "2.1.266-beta.1", "", "nightly", None, 2.1]
)
def test_rule_d_an_untrusted_version_never_reaches_done_idle_and_uses_the_ledger(
    version,
):
    """Below the floor the count was never written, so its absence says nothing."""
    registry = _registry(REG_IDLE, version=version)
    assert registry.verdict == REG_OK
    assert registry.trusts_pending_count is False

    # A transcript that clears every other rung-8 gate. The version alone
    # holds it back, and the count is not reported either.
    refused = resolve_attention(
        _evidence(registry=registry, transcript=_at_rest(pending=0))
    )
    _assert_verdict(refused, STATE_UNKNOWN, REASON_NO_EVIDENCE, TIER_REGISTRY)
    assert refused.pending_background_agents is None

    # Rung 4 falls through to the async ledger, which is derived from
    # records rather than from the field this version cannot write.
    ledgered = resolve_attention(
        _evidence(
            registry=registry,
            transcript=_at_rest(pending=0, open_async_agents=2),
        )
    )
    _assert_verdict(ledgered, STATE_BUSY, REASON_SUBAGENTS, TIER_TRANSCRIPT)

    # And the count itself is not consulted on this version, even when it
    # is positive: the ledger is the only input rung 4 has here. The
    # answer is a refusal, which raises nothing, so the asymmetry with
    # rung 9 (where a positive count IS read) costs a freeze, never a
    # false done.
    uncounted = resolve_attention(
        _evidence(registry=registry, transcript=_at_rest(pending=4))
    )
    assert uncounted.state == STATE_UNKNOWN
    assert uncounted.pending_background_agents is None


@pytest.mark.parametrize("family", ["codex", "gemini", "aider", "cursor"])
def test_rule_e_a_non_claude_family_never_reaches_done_idle_through_the_registry(
    family,
):
    """Only claude writes this registry; another family gets the pane and tmux."""
    perfect = dict(
        registry=_registry(REG_IDLE), transcript=_at_rest(pending=0, quiet=10.0)
    )

    refused = resolve_attention(_evidence(family=family, **perfect))
    _assert_verdict(refused, STATE_UNKNOWN, REASON_NO_EVIDENCE, TIER_NONE)
    assert family in refused.detail

    # The pane still works for it, and still only ever says needs_user.
    on_screen = resolve_attention(
        _evidence(family=family, pane=PANE_PERMISSION, **perfect)
    )
    _assert_verdict(on_screen, STATE_NEEDS_USER, REASON_PERMISSION, TIER_PANE)
    assert on_screen.settle_required is True

    # Positive control, and a deliberate asymmetry: a family we could NOT
    # determine is not sent down that branch, because a registry record
    # joined by tmux name is itself proof a claude registered this pane.
    assert resolve_attention(_evidence(family=None, **perfect)).state == STATE_DONE_IDLE
    assert (
        resolve_attention(_evidence(family=FAMILY_CLAUDE, **perfect)).state
        == STATE_DONE_IDLE
    )


# =====================================================================
# THE DISPLAY MAPPING. EIGHT NAMES IN, EIGHT NAMES OUT.
# =====================================================================

#: The eight status names ``src.core.session_status`` already defines and
#: both frontends already paint. A ninth would mean a ninth hue, a new LED
#: branch in two trees and a drift test to keep them identical.
THE_EIGHT = frozenset(
    {
        STATUS_DEAD,
        STATUS_QUESTION,
        STATUS_NOTICE,
        STATUS_WORKING,
        STATUS_WORKING_SUBAGENT,
        STATUS_FINISHED_UNREAD,
        STATUS_IDLE,
        STATUS_UNKNOWN,
    }
)

#: (state, reason) -> the status painted. ``done_idle`` is deliberately
#: absent: it is the one row that is not a function of the verdict alone.
DISPLAY_TABLE = [
    (STATE_UNKNOWN, REASON_PANE_DEAD, STATUS_DEAD),
    (STATE_NEEDS_USER, REASON_QUESTION, STATUS_QUESTION),
    (STATE_NEEDS_USER, REASON_PERMISSION, STATUS_QUESTION),
    (STATE_NEEDS_USER, REASON_PLAN_APPROVAL, STATUS_QUESTION),
    (STATE_NEEDS_USER, REASON_INPUT, STATUS_NOTICE),
    (STATE_BUSY, REASON_SUBAGENTS, STATUS_WORKING_SUBAGENT),
    (STATE_BUSY, REASON_QUEUED_REINVOKE, STATUS_WORKING_SUBAGENT),
    (STATE_BUSY, REASON_STREAMING, STATUS_WORKING),
    (STATE_BUSY, REASON_TOOL, STATUS_WORKING),
    (STATE_BUSY, REASON_SHELL, STATUS_WORKING),
    (STATE_UNKNOWN, REASON_REGISTRY_ABSENT, STATUS_UNKNOWN),
    (STATE_UNKNOWN, REASON_REGISTRY_STALE, STATUS_UNKNOWN),
    (STATE_UNKNOWN, REASON_REGISTRY_UNREADABLE, STATUS_UNKNOWN),
    (STATE_UNKNOWN, REASON_EVIDENCE_DISAGREES, STATUS_UNKNOWN),
    (STATE_UNKNOWN, REASON_NO_EVIDENCE, STATUS_UNKNOWN),
    (STATE_UNKNOWN, REASON_AMBIGUOUS_PANE, STATUS_UNKNOWN),
]


def test_to_display_maps_every_verdict_onto_one_of_the_eight_and_invents_no_ninth():
    """The whole table at once, plus the rest pair through derive_read_state."""
    for state, reason, expected in DISPLAY_TABLE:
        verdict = AttentionVerdict(state=state, reason=reason, tier=TIER_REGISTRY)
        for unread in (True, False):
            painted = to_display(verdict, unread=unread, tmux_status=STATUS_RUNNING)
            assert painted == expected, "%s(%s) unread=%s" % (state, reason, unread)

    # done_idle is the one row the flag moves, and the flag is applied by
    # session_status.derive_read_state, never by a second half-rule here.
    at_rest = AttentionVerdict(
        state=STATE_DONE_IDLE, reason=REASON_TURN_ENDED, tier=TIER_REGISTRY
    )
    assert to_display(at_rest, unread=True, tmux_status=STATUS_RUNNING) == (
        STATUS_FINISHED_UNREAD
    )
    assert to_display(at_rest, unread=False, tmux_status=STATUS_RUNNING) == STATUS_IDLE

    # And nothing outside the eight can come out of it, for any pairing
    # of any state with any reason, read or unread, over any tmux status.
    painted = {
        to_display(
            AttentionVerdict(state=state, reason=reason, tier=TIER_REGISTRY),
            unread=unread,
            tmux_status=tmux_status,
        )
        for state in ALL_STATES
        for reason in ALL_REASONS
        for unread in (True, False)
        for tmux_status in (STATUS_RUNNING, STATUS_IDLE, STATUS_DEAD, STATUS_UNKNOWN)
    }
    assert painted <= THE_EIGHT

    # The table above covers every reason the resolver can answer with,
    # so a new reason cannot be added to evidence.py without landing here.
    assert {reason for _, reason, _ in DISPLAY_TABLE} | {REASON_TURN_ENDED} == (
        ALL_REASONS
    )


def test_an_unknown_verdict_borrows_nothing_from_tmux_except_death():
    """Letting tmux's idle through would be the false green all over again."""
    refused = AttentionVerdict(
        state=STATE_UNKNOWN, reason=REASON_NO_EVIDENCE, tier=TIER_NONE
    )

    assert to_display(refused, unread=False, tmux_status=STATUS_IDLE) == STATUS_UNKNOWN
    assert to_display(refused, unread=True, tmux_status=STATUS_IDLE) == STATUS_UNKNOWN
    assert to_display(refused, unread=False, tmux_status=STATUS_DEAD) == STATUS_DEAD


# =====================================================================
# CAN-GO-RED CONTROLS. Each of these is a defect that shipped, or one
# that a plausible implementation would ship.
# =====================================================================


def test_every_tier_absent_answers_unknown_and_never_done_idle():
    """The worst failure available is a confident done about nothing."""
    verdict = resolve_attention(
        Evidence(
            tmux_liveness=LIVENESS_UNKNOWN,
            agent_family=None,
            registry=REGISTRY_ABSENT,
            transcript=_facts(FACTS_UNREADABLE),
            pane=None,
            now=NOW,
        )
    )

    _assert_verdict(verdict, STATE_UNKNOWN, REASON_REGISTRY_ABSENT, TIER_REGISTRY)
    assert verdict.pending_background_agents is None
    assert to_display(verdict, unread=True, tmux_status=STATUS_RUNNING) == STATUS_UNKNOWN


@pytest.mark.parametrize(
    "status_age",
    # Inside the staleness horizon, and well past it. The second case is
    # the one that proves narrowing rule (c) did not leak into busy: a
    # corroborating at-rest transcript still refuses here, because the
    # transcript is the tier that may never originate a rest claim and
    # busy is not idle.
    [600.0, REGISTRY_STALE_AFTER_SECONDS + 1, 98.5 * 3600.0],
)
def test_a_stale_busy_contradicted_by_a_newer_at_rest_transcript_disagrees(status_age):
    """Neither tier is reported, because they describe the same moment differently."""
    verdict = resolve_attention(
        _evidence(
            registry=_registry(REG_BUSY, status_age=status_age),
            transcript=_at_rest(pending=0, quiet=30.0),
        )
    )

    _assert_verdict(verdict, STATE_UNKNOWN, REASON_EVIDENCE_DISAGREES, TIER_REGISTRY)

    # Reporting busy would hold a finished session green forever; and
    # reporting done would take the word of the tier that is not allowed
    # to originate it. Both are asserted, because a resolver that picked
    # either side would still be "not unknown" in only one of them.
    assert verdict.state != STATE_BUSY
    assert verdict.state != STATE_DONE_IDLE


def test_an_all_blank_pane_is_none_not_false_and_decides_nothing():
    """capture-pane on a full-screen TUI returns blanks; that is a failed read."""
    assert PANE_BLANK.permission_dialog is None
    assert PANE_BLANK.question_dialog is None
    assert PANE_BLANK.trust_dialog is None
    assert PANE_BLANK.looked is False
    assert PANE_BLANK.shows_dialog is False
    assert PANE_BLANK.shows_no_dialog is False

    # So it cannot veto what claude says it is waiting for ...
    believed = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
            transcript=_at_rest(),
            pane=PANE_BLANK,
        )
    )
    _assert_verdict(believed, STATE_NEEDS_USER, REASON_INPUT, TIER_REGISTRY)

    # ... and it reads exactly like no capture at all when the turn is
    # open, which is the fail-toward-the-human rung.
    toward_the_human = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
            transcript=_turn_open(),
            pane=PANE_BLANK,
        )
    )
    _assert_verdict(
        toward_the_human, STATE_NEEDS_USER, REASON_PERMISSION, TIER_TRANSCRIPT
    )

    # The contrast that proves False is a different answer: the SAME
    # evidence with a screen we actually read and measured clear refuses.
    read_and_clear = resolve_attention(
        _evidence(
            registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
            transcript=_at_rest(),
            pane=PANE_CLEAR,
        )
    )
    assert read_and_clear.reason == REASON_EVIDENCE_DISAGREES


def test_a_transcript_with_no_record_is_never_read_as_zero_pending_agents():
    """No turn-end record means no count, and no count is not a count of none."""
    # THE 410-TOAST DEFECT ITSELF: a turn-end record that WAS read, from
    # a claude new enough to be trusted, that simply carries no count.
    # Every other rung-8 gate passes. An ``or 0`` anywhere in the gate
    # turns this line green and the feature back into the bug.
    absent_count = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE),
            transcript=_at_rest(pending=None, pending_field_present=False),
        )
    )
    assert absent_count.state != STATE_DONE_IDLE
    assert absent_count.pending_background_agents is None

    unwritten = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE),
            transcript=_facts(FACTS_NO_RECORD, newest_append_at=NOW - timedelta(seconds=30)),
        )
    )
    assert unwritten.state != STATE_DONE_IDLE
    assert unwritten.pending_background_agents is None

    # And the sharper case: a window with NO turn-end record that still
    # carries a zero on some older record. The verdict gate is separate
    # from the count gate, and both have to pass.
    zero_without_a_record = resolve_attention(
        _evidence(
            registry=_registry(REG_IDLE),
            transcript=_facts(
                FACTS_NO_RECORD,
                pending_background_agents=0,
                pending_field_present=True,
                turn_end_at=NOW - timedelta(seconds=30),
                newest_append_at=NOW - timedelta(seconds=30),
            ),
        )
    )
    assert zero_without_a_record.state != STATE_DONE_IDLE

    # Positive control: the same window with FACTS_FOUND does answer
    # done, so the two tests above fail for the verdict and not because
    # some unrelated gate refuses everything.
    assert (
        resolve_attention(
            _evidence(registry=_registry(REG_IDLE), transcript=_at_rest(pending=0))
        ).state
        == STATE_DONE_IDLE
    )


# =====================================================================
# SETTLE. True exactly when the pane or the EOF shape decided the STATE.
# =====================================================================


def test_settle_is_required_for_pane_and_eof_decided_verdicts():
    """Both sources can be read mid-render, so neither raises on one look."""
    cases = [
        (
            "the pane showed a dialog",
            _evidence(
                registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
                transcript=_at_rest(),
                pane=PANE_PERMISSION,
            ),
        ),
        (
            "the transcript ends on a blocking tool",
            _evidence(
                registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
                transcript=_turn_open(blocked_on_tool="AskUserQuestion"),
            ),
        ),
        (
            "the turn is open at EOF and the pane could not be read",
            _evidence(
                registry=_registry(REG_WAITING, waiting_for=WAITING_INPUT_NEEDED),
                transcript=_turn_open(),
                pane=None,
            ),
        ),
        (
            "no registry, and the transcript ends on a blocking tool",
            _evidence(transcript=_turn_open(blocked_on_tool="ExitPlanMode")),
        ),
        (
            "another family, dialog on screen",
            _evidence(family="codex", pane=PANE_QUESTION),
        ),
    ]
    for name, evidence in cases:
        assert resolve_attention(evidence).settle_required is True, name


def test_settle_is_not_required_for_registry_decided_verdicts():
    """claude's own status is instant; nothing is gained by looking twice."""
    cases = [
        ("done_idle", _evidence(registry=_registry(REG_IDLE), transcript=_at_rest())),
        (
            "busy streaming",
            _evidence(
                registry=_registry(REG_BUSY, status_age=1.0), transcript=_at_rest()
            ),
        ),
        (
            "busy tool",
            _evidence(
                registry=_registry(REG_BUSY, status_age=1.0), transcript=_turn_open()
            ),
        ),
        ("shell", _evidence(registry=_registry(REG_SHELL), transcript=_at_rest())),
        (
            "waiting, named",
            _evidence(
                registry=_registry(REG_WAITING, waiting_for=WAITING_SANDBOX_REQUEST),
                transcript=_at_rest(),
            ),
        ),
        (
            "busy on background agents",
            _evidence(registry=_registry(REG_IDLE), transcript=_at_rest(pending=5)),
        ),
        (
            "queued re-invoke",
            _evidence(
                registry=_registry(REG_IDLE),
                transcript=_at_rest(queued_reinvoke=True),
            ),
        ),
        ("pane gone", _evidence(tmux_liveness=LIVENESS_GONE)),
        ("no evidence at all", _evidence()),
        (
            "evidence disagrees",
            _evidence(
                registry=_registry(REG_BUSY, status_age=600.0),
                transcript=_at_rest(quiet=30.0),
            ),
        ),
    ]
    for name, evidence in cases:
        assert resolve_attention(evidence).settle_required is False, name
