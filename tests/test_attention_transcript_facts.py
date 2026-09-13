"""Tests for reading attention facts out of a transcript tail.

EVERY FIXTURE IS A REAL RECORD SHAPE, captured from the live corpus on
claude 2.1.266 and reproduced key for key: the ``system`` /
``turn_duration`` record with its ``pendingBackgroundAgentCount``, the
``queue-operation`` enqueue whose ``content`` is a ``<task-notification>``
body, the ``user`` record carrying ``toolUseResult.isAsync`` that a
background agent launch leaves behind, the ``user`` record with
``origin.kind`` of ``task-notification`` that delivers its completion,
and the assistant ``tool_use`` an AskUserQuestion ends the file on.

THE NEGATIVE CONTROL IS THE POINT OF THIS FILE. A reader that always
finds something is worse than useless here, because "the turn ended with
zero agents pending" is what authorises telling the user their session is
done, and the defect this whole change exists to kill is exactly that
sentence said 410 times while agents were still running. So an empty
window and a missing file are both asserted to REFUSE, and asserted to
refuse in DIFFERENT ways, right next to the positives that prove the
reader fires at all.

THREE WAYS OF HAVING NO NUMBER ARE TESTED APART, BECAUSE THEY MEAN THREE
DIFFERENT THINGS. Measured over 300 turn-end records in 40 recent
transcripts on claude 2.1.266: 236 carry a POSITIVE count, 64 OMIT the
key, and not one carries a literal null or a literal 0. So (1) an
omitted field on a record whose OWN version is 2.1.241 or newer is a
measured ZERO, the ordinary shape of a finished turn; (2) an omitted
field below that floor, or on a record naming no readable version, is
UNKNOWN, because the harness never wrote the field at all; (3) no
turn-end record in the window is UNKNOWN as well, and for a third
reason: the turn may still be running. A suite that only checked the
number would pass against an implementation that collapsed any two of
them, and each collapse breaks a different half of the product. Collapse
(1) into (2) and every real done toast is suppressed, which is what
happened: all 83 legitimate ones in the ground-truth corpus were lost.
Collapse (3) into (1) and every false one comes back.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from src.core.attention.transcript_facts import (
    BLOCKING_TOOL_NAMES,
    FACTS_FOUND,
    FACTS_NO_RECORD,
    FACTS_TAIL_BYTES,
    FACTS_UNREADABLE,
    classify_transcript_records,
    read_transcript_facts,
)
from src.core.claude_title_sync import DEFAULT_TAIL_BYTES

SESSION_UUID = "9160010b-90b4-4267-b31e-4ce4d4a6dcd6"
CWD = "/Users/Adam/cloude-projects/ses_3da07dde"


def _turn_end(
    timestamp: str, pending: Any = "omit", version: Optional[str] = "2.1.266"
) -> Dict[str, Any]:
    """One ``system`` / ``turn_duration`` record.

    Description: the real key set. ``pending`` defaults to the sentinel
      ``"omit"`` so a test can ask for the field to be ABSENT, which is a
      different fixture from the field being present and null. ``version``
      is the one the harness stamps on THIS record, and it is what says
      whether an absent field is a zero or an unknown, so a test can move
      it below the floor or take it away entirely.
    Inputs: timestamp (str) - ISO with the trailing Z the harness writes.
      pending (Any) - the count, None for JSON null, or "omit".
      version (str | None) - the record's own version, None to omit it.
    Output: dict - one record.
    Example: _turn_end('2026-09-13T18:30:58.233Z', pending=3)
    """
    record: Dict[str, Any] = {
        "parentUuid": "7d9deb25-12da-455b-b61e-5b4385e6a0eb",
        "isSidechain": False,
        "type": "system",
        "subtype": "turn_duration",
        "durationMs": 75930,
        "messageCount": 56,
        "timestamp": timestamp,
        "uuid": "2c6a3bac-0183-47b6-a32c-67712e89b6e9",
        "isMeta": False,
        "userType": "external",
        "entrypoint": "cli",
        "cwd": CWD,
        "sessionId": SESSION_UUID,
        "version": "2.1.266",
        "gitBranch": "master",
        "slug": "reactive-foraging-dream",
    }
    if pending != "omit":
        record["pendingBackgroundAgentCount"] = pending
    if version is None:
        del record["version"]
    else:
        record["version"] = version
    return record


def _assistant_tool_use(
    timestamp: str, name: str, tool_use_id: str
) -> Dict[str, Any]:
    """One ``assistant`` record that stopped to call a tool.

    Description: the EOF shape a question leaves behind. Nothing at all
      is appended after it until the answer arrives, which is what makes
      an unanswered one at the end of the window the question itself.
    Inputs: timestamp (str). name (str) - the tool. tool_use_id (str).
    Output: dict - one record.
    Example: _assistant_tool_use(ts, 'AskUserQuestion', 'toolu_01')
    """
    return {
        "type": "assistant",
        "isSidechain": False,
        "timestamp": timestamp,
        "sessionId": SESSION_UUID,
        "message": {
            "role": "assistant",
            "stop_reason": "tool_use",
            "content": [
                {"type": "text", "text": "let me ask"},
                {
                    "type": "tool_use",
                    "id": tool_use_id,
                    "name": name,
                    "input": {"questions": []},
                },
            ],
        },
    }


def _tool_result(timestamp: str, tool_use_id: str) -> Dict[str, Any]:
    """The ``user`` record that answers a tool call.

    Description: the harness writes it, not the human, so it carries a
      ``toolUseResult`` and must never read as a prompt.
    Inputs: timestamp (str). tool_use_id (str) - the call it answers.
    Output: dict - one record.
    Example: _tool_result(ts, 'toolu_01')
    """
    return {
        "type": "user",
        "isSidechain": False,
        "timestamp": timestamp,
        "sessionId": SESSION_UUID,
        "toolUseResult": "Your questions have been answered: yes",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": "Your questions have been answered: yes",
                }
            ],
        },
    }


def _notification_body(task_id: str, tool_use_id: str) -> str:
    """The xml-ish body of a background agent's completion notice.

    Description: reproduced from the live corpus, ids first, so the tag
      parser is exercised against the real ordering and the real
      surrounding text rather than a minimal pair.
    Inputs: task_id (str). tool_use_id (str).
    Output: str - the notification text.
    Example: _notification_body('ac21bf29', 'toolu_01')
    """
    return (
        "<task-notification>\n"
        "<task-id>" + task_id + "</task-id>\n"
        "<tool-use-id>" + tool_use_id + "</tool-use-id>\n"
        "<status>completed</status>\n"
        '<summary>Agent "Research" finished</summary>\n'
        "</task-notification>"
    )


def _enqueue(timestamp: str, task_id: str, tool_use_id: str) -> Dict[str, Any]:
    """The ``queue-operation`` that queues a completion notice.

    Description: the FIRST sight of a re-invoke. Its siblings ``dequeue``
      and ``remove`` carry no content, which is why only its ordering
      against the last turn end is matchable.
    Inputs: timestamp (str). task_id (str). tool_use_id (str).
    Output: dict - one record.
    Example: _enqueue(ts, 'ac21bf29', 'toolu_01')
    """
    return {
        "type": "queue-operation",
        "operation": "enqueue",
        "timestamp": timestamp,
        "sessionId": SESSION_UUID,
        "content": _notification_body(task_id, tool_use_id),
    }


def _async_launch(
    timestamp: str, task_id: str, tool_use_id: str
) -> Dict[str, Any]:
    """The ``user`` record left behind when a background agent starts.

    Description: the Agent tool answers IMMEDIATELY with
      ``status: async_launched``, so this record means an agent is now
      running, not that one finished.
    Inputs: timestamp (str). task_id (str) - becomes ``agentId``.
      tool_use_id (str) - the call it answers.
    Output: dict - one record.
    Example: _async_launch(ts, 'ac21bf29', 'toolu_01')
    """
    return {
        "type": "user",
        "isSidechain": False,
        "timestamp": timestamp,
        "sessionId": SESSION_UUID,
        "toolUseResult": {
            "isAsync": True,
            "status": "async_launched",
            "agentId": task_id,
            "description": "Research",
            "outputFile": "/tmp/" + task_id + ".output",
        },
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": "Agent started",
                }
            ],
        },
    }


def _task_notification(
    timestamp: str, task_id: str, tool_use_id: str
) -> Dict[str, Any]:
    """The ``user`` record that DELIVERS a completion notice.

    Description: ``origin.kind`` and ``promptSource`` both say the
      harness generated it. It is the completion half of the async
      ledger and it must never read as the user showing up.
    Inputs: timestamp (str). task_id (str). tool_use_id (str).
    Output: dict - one record.
    Example: _task_notification(ts, 'ac21bf29', 'toolu_01')
    """
    return {
        "type": "user",
        "isSidechain": False,
        "timestamp": timestamp,
        "sessionId": SESSION_UUID,
        "origin": {"kind": "task-notification"},
        "promptSource": "system",
        "message": {
            "role": "user",
            "content": _notification_body(task_id, tool_use_id),
        },
    }


def _user_prompt(timestamp: str, text: str = "keep going") -> Dict[str, Any]:
    """One record the human actually typed.

    Description: no ``isMeta``, no ``toolUseResult``, no ``origin`` and
      no ``promptSource``, which is exactly what a typed prompt looks
      like on disk.
    Inputs: timestamp (str). text (str) - the prompt.
    Output: dict - one record.
    Example: _user_prompt('2026-09-13T18:00:00.000Z')
    """
    return {
        "type": "user",
        "isSidechain": False,
        "timestamp": timestamp,
        "sessionId": SESSION_UUID,
        "message": {"role": "user", "content": text},
    }


def _write(tmp_path, records: List[Any], torn_tail: Optional[str] = None) -> str:
    """Write records to a jsonl file and answer its path.

    Description: one json object per line, exactly as the harness
      appends them. ``torn_tail`` appends a raw fragment with no trailing
      newline, which is what a transcript looks like while its writer is
      mid-append.
    Inputs: tmp_path (pathlib.Path) - pytest's temp dir. records (list) -
      objects to serialise. torn_tail (str | None) - a raw fragment.
    Output: str - the file path.
    Example: _write(tmp_path, [rec], torn_tail='{"type":"sys')
    """
    path = tmp_path / (SESSION_UUID + ".jsonl")
    body = "".join(json.dumps(record) + "\n" for record in records)
    if torn_tail is not None:
        body += torn_tail
    path.write_text(body, encoding="utf-8")
    return str(path)


# ---------------------------------------------------------------------
# The pending-agent count, which is the fact the whole change rests on.
# ---------------------------------------------------------------------


def test_turn_end_with_one_pending_agent_reports_one():
    facts = classify_transcript_records(
        [_turn_end("2026-09-13T18:30:58.233Z", pending=1)]
    )
    assert facts.verdict == FACTS_FOUND
    assert facts.found is True
    assert facts.pending_background_agents == 1
    assert facts.pending_field_present is True


def test_turn_end_with_three_pending_agents_reports_three():
    facts = classify_transcript_records(
        [_turn_end("2026-09-13T18:30:58.233Z", pending=3)]
    )
    assert facts.pending_background_agents == 3
    assert facts.pending_field_present is True


def test_pending_count_of_json_null_is_unknown_because_none_was_ever_written():
    # 300 turn-end records on 2.1.266 carry no literal null at all, so
    # nothing may claim to know what one would mean. The earlier reading
    # of "null is zero" came from jq printing a MISSING key as null.
    facts = classify_transcript_records(
        [_turn_end("2026-09-13T18:30:58.233Z", pending=None)]
    )
    assert facts.verdict == FACTS_FOUND
    assert facts.pending_background_agents is None
    assert facts.pending_field_present is True


def test_an_omitted_pending_field_at_or_above_the_version_floor_is_zero():
    # THE MEASURED RULE, and the one that makes done_idle reachable at
    # all: 64 of 300 records omit the key and every one of them is a
    # finished turn with nothing pending.
    facts = classify_transcript_records(
        [_turn_end("2026-09-13T18:30:58.233Z", version="2.1.266")]
    )
    assert facts.verdict == FACTS_FOUND
    assert facts.pending_background_agents == 0
    # The KEY really was absent; the zero is read off the version, not
    # off a field that was there all along.
    assert facts.pending_field_present is False


def test_an_omitted_pending_field_at_the_version_floor_itself_is_zero():
    facts = classify_transcript_records(
        [_turn_end("2026-09-13T18:30:58.233Z", version="2.1.241")]
    )
    assert facts.pending_background_agents == 0


def test_an_omitted_pending_field_below_the_version_floor_is_unknown():
    # One release earlier the field did not exist, so its absence there
    # says nothing whatever about how many agents were running.
    facts = classify_transcript_records(
        [_turn_end("2026-09-13T18:30:58.233Z", version="2.1.240")]
    )
    assert facts.verdict == FACTS_FOUND
    assert facts.pending_background_agents is None
    assert facts.pending_field_present is False


def test_an_omitted_pending_field_with_no_readable_version_is_unknown():
    for version in (None, "2.1.266-beta.1"):
        facts = classify_transcript_records(
            [_turn_end("2026-09-13T18:30:58.233Z", version=version)]
        )
        assert facts.pending_background_agents is None, version


def test_the_version_that_counts_is_the_one_on_the_turn_end_record():
    # A newer record later in the window must not lend its version to an
    # older one, and an older record must not take the newer one's away:
    # the count is read off the SAME record the version is read off.
    facts = classify_transcript_records(
        [
            _turn_end("2026-09-13T18:00:00.000Z", version="2.1.266"),
            _turn_end("2026-09-13T18:10:00.000Z", version="2.1.240"),
        ]
    )
    assert facts.pending_background_agents is None

    facts = classify_transcript_records(
        [
            _turn_end("2026-09-13T18:00:00.000Z", version="2.1.240"),
            _turn_end("2026-09-13T18:10:00.000Z", version="2.1.266"),
        ]
    )
    assert facts.pending_background_agents == 0


def test_an_omitted_count_and_a_missing_record_are_not_the_same_answer():
    # THE PAIR THAT MUST NEVER COLLAPSE. One is a turn that ended with
    # nothing pending; the other is a window that holds no turn end at
    # all, which may simply be a turn still running.
    omitted = classify_transcript_records(
        [_turn_end("2026-09-13T18:30:58.233Z", version="2.1.266")]
    )
    none_at_all = classify_transcript_records(
        [_assistant_tool_use("2026-09-13T18:30:58.233Z", "Bash", "toolu_a")]
    )

    assert omitted.verdict == FACTS_FOUND
    assert omitted.pending_background_agents == 0
    assert none_at_all.verdict == FACTS_NO_RECORD
    assert none_at_all.pending_background_agents is None
    assert none_at_all.turn_end_at is None


def test_a_pending_count_that_is_not_a_number_is_unknown_and_says_so():
    facts = classify_transcript_records(
        [_turn_end("2026-09-13T18:30:58.233Z", pending="lots")]
    )
    assert facts.pending_background_agents is None
    assert facts.pending_field_present is True
    assert "not a number" in facts.detail


def test_a_window_with_no_turn_end_record_refuses_rather_than_reporting_zero():
    facts = classify_transcript_records(
        [
            _user_prompt("2026-09-13T18:00:00.000Z"),
            _assistant_tool_use("2026-09-13T18:00:01.000Z", "Bash", "toolu_a"),
        ]
    )
    assert facts.verdict == FACTS_NO_RECORD
    assert facts.pending_background_agents is None
    assert facts.pending_field_present is False


def test_the_newest_turn_end_record_in_the_window_is_the_one_that_counts():
    facts = classify_transcript_records(
        [
            _turn_end("2026-09-13T18:00:00.000Z", pending=3),
            _user_prompt("2026-09-13T18:05:00.000Z"),
            _turn_end("2026-09-13T18:10:00.000Z"),
        ]
    )
    assert facts.pending_background_agents == 0
    assert facts.turn_end_at is not None
    assert facts.turn_end_at.hour == 18 and facts.turn_end_at.minute == 10


# ---------------------------------------------------------------------
# The end of the file: a question, an answered question, a running tool.
# ---------------------------------------------------------------------


def test_a_window_ending_on_an_unanswered_ask_user_question_names_the_tool():
    facts = classify_transcript_records(
        [
            _turn_end("2026-09-13T18:00:00.000Z", pending=None),
            _assistant_tool_use(
                "2026-09-13T18:00:10.000Z", "AskUserQuestion", "toolu_q"
            ),
        ]
    )
    assert facts.blocked_on_tool == "AskUserQuestion"


def test_a_window_ending_on_an_unanswered_exit_plan_mode_names_the_tool():
    facts = classify_transcript_records(
        [
            _assistant_tool_use(
                "2026-09-13T18:00:10.000Z", "ExitPlanMode", "toolu_p"
            )
        ]
    )
    assert facts.blocked_on_tool == "ExitPlanMode"
    assert "ExitPlanMode" in BLOCKING_TOOL_NAMES


def test_an_answered_question_is_not_blocking_any_more():
    facts = classify_transcript_records(
        [
            _assistant_tool_use(
                "2026-09-13T18:00:10.000Z", "AskUserQuestion", "toolu_q"
            ),
            _tool_result("2026-09-13T18:01:00.000Z", "toolu_q"),
        ]
    )
    assert facts.blocked_on_tool is None


def test_a_running_tool_at_the_end_of_the_window_is_not_a_question():
    facts = classify_transcript_records(
        [_assistant_tool_use("2026-09-13T18:00:10.000Z", "Bash", "toolu_b")]
    )
    assert facts.blocked_on_tool is None
    assert "still running" in facts.detail


# ---------------------------------------------------------------------
# The re-invoke that is already queued, and the async ledger.
# ---------------------------------------------------------------------


def test_an_enqueued_notification_newer_than_the_turn_end_is_a_queued_reinvoke():
    facts = classify_transcript_records(
        [
            _turn_end("2026-09-13T18:25:11.174Z", pending=1),
            _enqueue("2026-09-13T18:25:58.808Z", "ac21bf29", "toolu_01"),
        ]
    )
    assert facts.queued_reinvoke is True


def test_an_enqueued_notification_older_than_the_turn_end_is_not_one():
    facts = classify_transcript_records(
        [
            _enqueue("2026-09-13T18:20:00.000Z", "ac21bf29", "toolu_01"),
            _turn_end("2026-09-13T18:25:11.174Z", pending=None),
        ]
    )
    assert facts.queued_reinvoke is False


def test_three_launches_with_two_completions_leave_one_agent_open():
    facts = classify_transcript_records(
        [
            _async_launch("2026-09-13T18:00:01.000Z", "task_a", "toolu_a"),
            _async_launch("2026-09-13T18:00:02.000Z", "task_b", "toolu_b"),
            _async_launch("2026-09-13T18:00:03.000Z", "task_c", "toolu_c"),
            _task_notification("2026-09-13T18:10:00.000Z", "task_a", "toolu_a"),
            _task_notification("2026-09-13T18:11:00.000Z", "task_b", "toolu_b"),
        ]
    )
    assert facts.open_async_agents == 1


def test_a_completion_whose_launch_is_behind_the_window_never_goes_negative():
    facts = classify_transcript_records(
        [_task_notification("2026-09-13T18:10:00.000Z", "task_z", "toolu_z")]
    )
    assert facts.open_async_agents == 0


# ---------------------------------------------------------------------
# Who typed it. The passive replacement for the UserPromptSubmit hook.
# ---------------------------------------------------------------------


def test_a_typed_prompt_is_the_newest_user_prompt():
    facts = classify_transcript_records(
        [_user_prompt("2026-09-13T18:00:00.000Z")]
    )
    assert facts.newest_user_prompt_at is not None


def test_a_task_notification_is_not_the_user_showing_up():
    facts = classify_transcript_records(
        [_task_notification("2026-09-13T18:10:00.000Z", "task_a", "toolu_a")]
    )
    assert facts.newest_user_prompt_at is None


def test_a_tool_result_is_not_the_user_showing_up():
    facts = classify_transcript_records(
        [_tool_result("2026-09-13T18:10:00.000Z", "toolu_q")]
    )
    assert facts.newest_user_prompt_at is None


def test_a_sub_agents_own_prompt_is_not_the_user_showing_up():
    sidechain = _user_prompt("2026-09-13T18:10:00.000Z")
    sidechain["isSidechain"] = True
    facts = classify_transcript_records([sidechain])
    assert facts.newest_user_prompt_at is None


def test_the_newest_append_is_the_newest_record_of_any_type():
    facts = classify_transcript_records(
        [
            _user_prompt("2026-09-13T18:00:00.000Z"),
            _turn_end("2026-09-13T18:30:00.000Z", pending=None),
        ]
    )
    assert facts.newest_append_at is not None
    assert facts.newest_append_at.minute == 30


def test_the_newest_assistant_record_is_reported_apart_from_the_turn_end():
    facts = classify_transcript_records(
        [
            _assistant_tool_use("2026-09-13T18:00:00.000Z", "Bash", "toolu_b"),
            _turn_end("2026-09-13T18:30:00.000Z", pending=None),
        ]
    )
    assert facts.newest_assistant_at is not None
    assert facts.newest_assistant_at.minute == 0
    assert facts.turn_end_at is not None
    assert facts.turn_end_at.minute == 30


def test_junk_entries_in_the_window_are_tolerated():
    facts = classify_transcript_records(
        ["not a record", 7, None, _turn_end("2026-09-13T18:30:00.000Z", pending=2)]
    )
    assert facts.pending_background_agents == 2


# ---------------------------------------------------------------------
# The file on disk: torn writes, absence, emptiness.
# ---------------------------------------------------------------------


def test_a_torn_final_line_still_reads_the_good_records_before_it(tmp_path):
    path = _write(
        tmp_path,
        [
            _user_prompt("2026-09-13T18:00:00.000Z"),
            _turn_end("2026-09-13T18:30:00.000Z", pending=2),
        ],
        torn_tail='{"type":"system","subtype":"turn_dur',
    )
    facts = read_transcript_facts(path)
    assert facts.verdict == FACTS_FOUND
    assert facts.pending_background_agents == 2


def test_a_real_file_reads_the_same_facts_as_the_pure_classifier(tmp_path):
    records = [
        _turn_end("2026-09-13T18:25:11.174Z", pending=1),
        _enqueue("2026-09-13T18:25:58.808Z", "task_a", "toolu_a"),
    ]
    path = _write(tmp_path, records)
    assert read_transcript_facts(path) == classify_transcript_records(records)


def test_a_missing_transcript_is_unreadable_and_not_an_absence_of_work(tmp_path):
    facts = read_transcript_facts(str(tmp_path / "nothing-here.jsonl"))
    assert facts.verdict == FACTS_UNREADABLE
    assert facts.detail


def test_no_path_at_all_is_unreadable():
    assert read_transcript_facts(None).verdict == FACTS_UNREADABLE


def test_an_empty_transcript_holds_no_record_rather_than_refusing_to_read(tmp_path):
    path = _write(tmp_path, [])
    facts = read_transcript_facts(path)
    assert facts.verdict == FACTS_NO_RECORD


def test_this_caller_widens_its_own_window_and_leaves_the_shared_one_alone():
    assert FACTS_TAIL_BYTES == 256 * 1024
    assert DEFAULT_TAIL_BYTES == 64 * 1024


# ---------------------------------------------------------------------
# CAN GO RED. A green check that looked at nothing is the most repeated
# failure shape in this project, so the refusals are asserted to be
# refusals and asserted to differ from each other.
# ---------------------------------------------------------------------


def test_neither_an_empty_window_nor_a_missing_file_claims_the_turn_ended(tmp_path):
    empty = classify_transcript_records([])
    missing = read_transcript_facts(str(tmp_path / "gone.jsonl"))

    for facts in (empty, missing):
        # The exact sentence the product must never say on no evidence:
        # "zero agents are pending and the turn is over".
        assert facts.verdict != FACTS_FOUND
        assert facts.found is False
        assert facts.pending_background_agents is None
        assert facts.pending_field_present is False
        assert facts.turn_end_at is None
        assert facts.open_async_agents == 0
        assert facts.queued_reinvoke is False
        assert facts.blocked_on_tool is None

    # And the two refusals are DIFFERENT facts about the world: one
    # looked and found nothing, the other could not look.
    assert empty.verdict == FACTS_NO_RECORD
    assert missing.verdict == FACTS_UNREADABLE
    assert empty.verdict != missing.verdict


def test_the_positive_control_proves_the_reader_can_go_green(tmp_path):
    # The same assertions as the refusal test, with a real turn end in
    # the file, so the refusal test above cannot be passing because the
    # reader finds nothing ever.
    path = _write(
        tmp_path,
        [
            _async_launch("2026-09-13T18:00:01.000Z", "task_a", "toolu_a"),
            _turn_end("2026-09-13T18:30:00.000Z", pending=1),
        ],
    )
    facts = read_transcript_facts(path)
    assert facts.verdict == FACTS_FOUND
    assert facts.found is True
    assert facts.pending_background_agents == 1
    assert facts.pending_field_present is True
    assert facts.turn_end_at is not None
    assert facts.open_async_agents == 1
