"""What the tail of a Claude Code transcript says about a finished turn.

THE HARNESS WRITES THE TRUTH DOWN; THIS FILE READS IT. Claude Code
appends a ``system`` / ``turn_duration`` record when a turn ends, and it
carries ``pendingBackgroundAgentCount``, the number of background agents
still running when the turn closed. That is the fact the toast path has
been guessing at with an in-memory counter fed by hooks every process in
the pane posts under the same id; the guess was wrong 410 times in 50.8
hours and the file was right the whole time.

THREE OUTCOMES, NEVER TWO. :data:`FACTS_FOUND` read a turn-end record.
:data:`FACTS_NO_RECORD` read the window and found none, which IS NOT
"zero agents are pending": it is "the record sits further back than the
bound, or this turn has not ended yet". :data:`FACTS_UNREADABLE` could
not read the file at all, which measures nothing. Collapse any two and
the product tells somebody their session is done in the middle of its
work. Same discipline as ``session_status_seed_records``.

``pendingBackgroundAgentCount`` IS OMITTED WHEN THE COUNT IS ZERO, AND
THE VERSION ON THE RECORD ITSELF IS WHAT TELLS THAT APART FROM A HARNESS
THAT NEVER WROTE THE FIELD. Measured over 300 turn-end records in 40
recent transcripts on claude 2.1.266: 236 carry a POSITIVE count, 64
OMIT the key, and NOT ONE carries a literal null or a literal 0. So the
harness writes the field only when something is pending. At or above
2.1.241 (:data:`MIN_PENDING_VERSION`) an absent key therefore means ZERO
agents were pending and the turn genuinely finished; below that floor the
field did not exist yet, so an absent key there means UNKNOWN. The
version read is the one stamped ON THE TURN-END RECORD, written by the
process that wrote that record, never a version from anywhere else.

AN EARLIER NOTE IN THIS FILE CLAIMED NULL MEANT ZERO. It was wrong: it
came from jq printing a MISSING key as null, and the corpus holds no
literal null at all. A field that is present but is not a number is
therefore UNKNOWN and not zero, because nothing has ever been observed
that says what it would mean.

ONLY AN ABSENT FIELD ON A RECORD THAT EXISTS MAY BE READ AS ZERO. A
window holding no turn-end record at all keeps the count None, because
the turn may simply still be running.

THE WINDOW IS 256 KB HERE AND 64 KB EVERYWHERE ELSE, ON PURPOSE. The
shared reader ``claude_title_sync.read_tail_records`` keeps its 64 KB
default because it runs on the hook path on every tool call. This caller
runs on the watcher tick and needs the NEWEST ``turn_duration``, which
sits behind everything the current turn has appended since: 3 of 9 live
transcripts on this Mac had theirs beyond 64 KB mid-turn. The bound is
raised by passing ``tail_bytes``, for this caller only.

BOUNDED MEANS THIS CAN UNDERCOUNT, WHICH IS THE SAFE DIRECTION. An agent
launched before the window opened is not counted. Every count here is a
floor on how busy the session is, never a ceiling: read a positive count
as proof of work, never a zero as proof of rest on its own.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Set

from src.core.attention.registry_read import MIN_PENDING_VERSION, parse_version
from src.core.claude_title_sync import read_tail_records
from src.core.session_status_seed_records import parse_timestamp

# ---------------------------------------------------------------------
# Outcomes. See the module docstring for why there are three.
# ---------------------------------------------------------------------

#: A turn-end record was read out of the window. Every other field on the
#: result is populated from that same window.
FACTS_FOUND: str = "found"

#: The window was read and holds no turn-end record. A DEFINITE negative
#: about the window and NOT a count of zero: the record may sit further
#: back than the bound, or the turn may still be running.
FACTS_NO_RECORD: str = "no_record"

#: The transcript could not be read at all: no path, absent, unreadable.
#: Not an absence, and not a measurement of anything.
FACTS_UNREADABLE: str = "unreadable"

#: How much of the end of the transcript this caller reads. Raised from
#: the shared 64 KB default for THIS caller only; the module docstring
#: carries the measurement that justifies it.
FACTS_TAIL_BYTES: int = 256 * 1024

#: Tools whose ``tool_use`` at the end of the file means claude is
#: BLOCKED ON THE HUMAN rather than running something. Both write the
#: tool_use and then write nothing at all until the answer arrives, so an
#: unanswered one at EOF is the question itself. Verified on 2.1.266.
BLOCKING_TOOL_NAMES: frozenset = frozenset({"AskUserQuestion", "ExitPlanMode"})

# ---------------------------------------------------------------------
# Record shapes, verified against the live corpus on claude 2.1.266.
# ---------------------------------------------------------------------

#: The ``system`` subtype claude writes when a turn completes.
TURN_END_SUBTYPE: str = "turn_duration"

#: The field on that record holding the background agent count. Written
#: only when the count is POSITIVE; see the module docstring for the 300
#: record measurement behind that sentence.
PENDING_AGENTS_FIELD: str = "pendingBackgroundAgentCount"

#: The claude version stamped on every record, including the turn-end
#: one. The version on THAT record is the process that wrote it, which is
#: the only authority on whether an absent count means zero.
RECORD_VERSION_FIELD: str = "version"

#: The ``queue-operation`` that ADDS a message to the input queue. Its
#: siblings ``dequeue`` and ``remove`` carry no ``content``, so only the
#: ORDERING of an enqueue against the last turn end is matchable here; a
#: balance of enqueues against dequeues is not, and nothing here pretends
#: otherwise.
ENQUEUE_OPERATION: str = "enqueue"

#: The head of the text claude queues when a background agent reports
#: back. It arrives first as a ``queue-operation`` enqueue, then later as
#: a ``user`` record with ``origin.kind`` naming it.
TASK_NOTIFICATION_MARKER: str = "<task-notification>"

#: The ``origin.kind`` on the ``user`` record that DELIVERS a background
#: agent's completion. Such a record is not a human prompt.
TASK_NOTIFICATION_KIND: str = "task-notification"

#: ``promptSource`` on a record the harness generated rather than the
#: human typing it.
SYSTEM_PROMPT_SOURCE: str = "system"


@dataclass(frozen=True)
class TranscriptFacts:
    """Everything the tail of one transcript says about attention.

    Description: the return of :func:`classify_transcript_records` and
      :func:`read_transcript_facts`. Frozen because it reports a
      measurement of a file, not a plan.

      - ``verdict``: one of the three ``FACTS_*`` constants, describing
        THE TURN-END RECORD only. Every other field is filled in from the
        same window whatever the verdict is, so a window holding an
        unanswered question but no turn end answers
        :data:`FACTS_NO_RECORD` and still names the tool.
      - ``pending_background_agents``: how many background agents were
        pending when the turn ended, or None when that could not be
        determined. A None is never a substituted zero, and a zero is
        never a substituted None: on claude 2.1.241 and up an OMITTED
        field on a turn-end record is a measured zero, which is what a
        finished turn looks like.
      - ``pending_field_present``: whether the key was LITERALLY in the
        record. It is the raw fact, not a trust gate: False beside a
        count of 0 is the ordinary shape of a finished turn on 2.1.241
        and up, and False beside None is a record whose own version is
        too old, or too unparseable, to have written one.
      - ``turn_end_at``: timestamp of the newest turn-end record.
      - ``newest_assistant_at``: the newest ``assistant`` record, so a
        caller can ask whether the turn end is newer than it.
      - ``newest_append_at``: the newest record of ANY type, the
        transcript's own heartbeat.
      - ``blocked_on_tool``: the blocking tool the window ENDS on
        unanswered, else None.
      - ``queued_reinvoke``: a completion notice is queued and newer than
        the last turn end, so a re-invoke is coming with no human in it.
      - ``open_async_agents``: launches in the window with no matching
        completion in it. A FLOOR, never a ceiling.
      - ``newest_user_prompt_at``: the newest record the HUMAN typed, the
        passive replacement for the UserPromptSubmit hook.
      - ``detail``: a plain sentence naming what was read and why.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    verdict: str
    pending_background_agents: Optional[int] = None
    pending_field_present: bool = False
    turn_end_at: Optional[datetime] = None
    newest_assistant_at: Optional[datetime] = None
    newest_append_at: Optional[datetime] = None
    blocked_on_tool: Optional[str] = None
    queued_reinvoke: bool = False
    open_async_agents: int = 0
    newest_user_prompt_at: Optional[datetime] = None
    detail: str = ""

    @property
    def found(self) -> bool:
        """True only when a turn-end record was actually read.

        Description: the one-line test a "the turn is over" rung may be
          built on, False for both other verdicts so an unreadable file
          is never spelled the same way as a finished turn.
        Inputs: n/a.
        Output: bool.
        Example: read_transcript_facts(p).found
        """
        return self.verdict == FACTS_FOUND


def _later(left: Optional[datetime], right: Optional[datetime]) -> Optional[datetime]:
    """The later of two optional timestamps.

    Description: PURE. None means "not dated", so a date beats it.
    Inputs: left, right (datetime | None) - timezone-aware or None.
    Output: datetime | None.
    Example: _later(None, ts) is ts
    """
    if left is None:
        return right
    if right is None:
        return left
    return right if right > left else left


def _version_text(version: Sequence[int]) -> str:
    """A parsed version tuple back as the dotted string it came from.

    Description: PURE. Used only to name the version inside a ``detail``
      sentence, so a log line says which harness the reading was made
      against instead of leaving the reader to guess.
    Inputs: version (Sequence[int]) - for example ``(2, 1, 266)``.
    Output: str.
    Example: _version_text((2, 1, 266)) -> '2.1.266'
    """
    return ".".join(str(part) for part in version)


def _record_text(record: Dict[str, Any]) -> str:
    """The text of a record's message, whatever shape it is in.

    Description: PURE. ``message.content`` is either a plain string or a
      list of blocks; this reads both and answers "" for anything else.
    Inputs: record (dict) - one parsed jsonl object.
    Output: str - possibly empty, never None.
    Example: _record_text({'message': {'content': 'hi'}}) -> 'hi'
    """
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return ""


def _content_blocks(record: Dict[str, Any], kind: str) -> List[Dict[str, Any]]:
    """Every block of one type in a record's message content.

    Description: PURE. Answers [] for string-shaped or missing content,
      so the callers below can index the list without guarding.
    Inputs: record (dict). kind (str) - ``tool_use`` or ``tool_result``.
    Output: list[dict] - in the order they appear.
    Example: _content_blocks(rec, 'tool_use')[-1]['name'] -> 'Bash'
    """
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return []
    return [
        block
        for block in content
        if isinstance(block, dict) and block.get("type") == kind
    ]


def _tag_value(text: str, tag: str) -> Optional[str]:
    """The text between one pair of angle-bracket tags.

    Description: PURE. A task-notification is xml-ish text inside a json
      string, not json, so the ids come out by hand. FIRST occurrence
      only; None when either side is missing, never a guessed boundary.
    Inputs: text (str) - the notification body. tag (str) - no brackets.
    Output: str | None - the stripped value, or None.
    Example: _tag_value('<task-id>abc</task-id>', 'task-id') -> 'abc'
    """
    opener = "<" + tag + ">"
    closer = "</" + tag + ">"
    start = text.find(opener)
    if start < 0:
        return None
    start += len(opener)
    end = text.find(closer, start)
    if end < 0:
        return None
    value = text[start:end].strip()
    return value or None


def _is_task_notification(record: Dict[str, Any]) -> bool:
    """Is this ``user`` record a background agent reporting back.

    Description: PURE. Reads ``origin.kind``, which the harness stamps on
      the record it generates itself. Counting one as a prompt is how a
      session looks like the user showed up when a sub-agent finished.
    Inputs: record (dict) - one parsed jsonl object.
    Output: bool.
    Example: _is_task_notification({'origin': {'kind': 'task-notification'}})
    """
    origin = record.get("origin")
    if not isinstance(origin, dict):
        return False
    return origin.get("kind") == TASK_NOTIFICATION_KIND


def _is_real_user_prompt(record: Dict[str, Any]) -> bool:
    """Did the HUMAN type this record.

    Description: PURE, and every clause is a measured exclusion. A
      ``user`` record is also how the harness delivers a tool result
      (``toolUseResult``), its own bookkeeping (``isMeta``), a background
      agent's completion (``origin.kind``) and anything else it generates
      (``promptSource``). A SIDECHAIN record is a sub-agent's prompt from
      its parent, not the user talking to anybody, the same reason
      ``session_status_seed_records.classify_record`` refuses one.
    Inputs: record (dict) - one parsed jsonl object.
    Output: bool.
    Example: _is_real_user_prompt({'type': 'user', 'message': {}}) -> True
    """
    if record.get("type") != "user":
        return False
    if record.get("isMeta") is True:
        return False
    if record.get("isSidechain") is True:
        return False
    if record.get("toolUseResult") is not None:
        return False
    if record.get("promptSource") == SYSTEM_PROMPT_SOURCE:
        return False
    return not _is_task_notification(record)


def _async_launch(record: Dict[str, Any]) -> Optional[Dict[str, Optional[str]]]:
    """The identifiers of a background agent launch, if this is one.

    Description: PURE. A launch is the ``user`` record carrying the Agent
      tool's immediate result, ``toolUseResult.isAsync`` true. The
      completion notice quotes both of its ids: the agent id (its
      ``task-id``) and the tool_use it answers (its ``tool-use-id``). A
      launch carrying NEITHER can never be reconciled, so it is not
      counted at all rather than counted open forever.
    Inputs: record (dict) - one parsed jsonl object.
    Output: dict | None - keys ``key``, ``agent_id``, ``tool_use_id``.
    Example: _async_launch(rec)['agent_id'] -> 'ac21bf291415e825e'
    """
    result = record.get("toolUseResult")
    if not isinstance(result, dict) or result.get("isAsync") is not True:
        return None
    agent_id = result.get("agentId")
    agent_id = agent_id if isinstance(agent_id, str) and agent_id else None
    tool_use_id: Optional[str] = None
    for block in _content_blocks(record, "tool_result"):
        candidate = block.get("tool_use_id")
        if isinstance(candidate, str) and candidate:
            tool_use_id = candidate
    key = tool_use_id or agent_id
    if key is None:
        return None
    return {"key": key, "agent_id": agent_id, "tool_use_id": tool_use_id}


def classify_transcript_records(
    records: Sequence[Any],
    *,
    now: Optional[datetime] = None,
) -> TranscriptFacts:
    """Every attention fact in one window of transcript records.

    Description: PURE and it NEVER RAISES. Walks the window once, oldest
      first, tolerating non-dict entries and missing keys at every step,
      because the only thing worse than a wrong status is a watcher that
      stops ticking. The verdict describes the TURN-END record: found, or
      read the window and there is none, in which case
      ``pending_background_agents`` is None and NEVER 0. That is a
      DIFFERENT case from a record that EXISTS and omits the count,
      which on claude 2.1.241 and up is a measured zero; the two are
      never spelled the same way here.

      ``now`` is accepted so one clock threads through the whole evidence
      gather and the signature matches this package's other readers.
      Nothing here depends on it: what a record SAYS does not change with
      the time of asking, and a caller computes the ages it wants from
      the timestamps this returns.
    Inputs: records (Sequence[Any]) - parsed jsonl objects, oldest first.
      now (datetime | None) - the caller's clock; see above.
    Output: TranscriptFacts.
    Example: classify_transcript_records([]).verdict -> 'no_record'
    """
    turn_end: Optional[Dict[str, Any]] = None
    newest_append_at: Optional[datetime] = None
    newest_assistant_at: Optional[datetime] = None
    newest_user_prompt_at: Optional[datetime] = None
    newest_enqueue_at: Optional[datetime] = None
    launches: Dict[str, Dict[str, Optional[str]]] = {}
    notified: Set[str] = set()
    answered_tool_use_ids: Set[str] = set()
    last_record: Optional[Dict[str, Any]] = None

    for record in records or ():
        if not isinstance(record, dict):
            # The shared tail reader only ever yields objects; a caller
            # handing this a raw list must not crash a watcher.
            continue
        last_record = record
        at = parse_timestamp(record.get("timestamp"))
        newest_append_at = _later(newest_append_at, at)
        kind = record.get("type")

        if kind == "system":
            if record.get("subtype") == TURN_END_SUBTYPE:
                turn_end = record
            continue

        if kind == "assistant":
            newest_assistant_at = _later(newest_assistant_at, at)
            continue

        if kind == "queue-operation":
            if record.get("operation") == ENQUEUE_OPERATION:
                content = record.get("content")
                if isinstance(content, str) and content.lstrip().startswith(
                    TASK_NOTIFICATION_MARKER
                ):
                    newest_enqueue_at = _later(newest_enqueue_at, at)
            continue

        if kind != "user":
            continue

        for block in _content_blocks(record, "tool_result"):
            candidate = block.get("tool_use_id")
            if isinstance(candidate, str) and candidate:
                answered_tool_use_ids.add(candidate)

        if _is_task_notification(record):
            text = _record_text(record)
            for tag in ("tool-use-id", "task-id"):
                value = _tag_value(text, tag)
                if value:
                    notified.add(value)
            continue

        launch = _async_launch(record)
        if launch is not None:
            # Keyed, so the same launch seen twice counts once.
            launches[str(launch["key"])] = launch
            continue

        if _is_real_user_prompt(record):
            newest_user_prompt_at = _later(newest_user_prompt_at, at)

    notes: List[str] = []

    pending: Optional[int] = None
    pending_present = False
    turn_end_at: Optional[datetime] = None
    if turn_end is not None:
        turn_end_at = parse_timestamp(turn_end.get("timestamp"))
        record_version = parse_version(turn_end.get(RECORD_VERSION_FIELD))
        if PENDING_AGENTS_FIELD in turn_end:
            pending_present = True
            raw = turn_end.get(PENDING_AGENTS_FIELD)
            if isinstance(raw, bool) or not isinstance(raw, int):
                # Written, but not as a count. A literal null lands here
                # too: the corpus holds none, so nothing may claim to
                # know what one would mean. UNKNOWN, never zero.
                pending = None
                notes.append(
                    "the turn-end record carries a pending-agent count "
                    "that is not a number, so the count is unknown"
                )
            else:
                pending = max(0, raw)
        elif record_version is not None and record_version >= MIN_PENDING_VERSION:
            # OMITTED BY A HARNESS THAT WRITES THE FIELD MEANS ZERO. The
            # version gating this is the one on THIS record, which is
            # authoritative for it. Without this branch every genuinely
            # finished turn reads as unknown and no done toast is ever
            # raised: 83 of 83 legitimate ones were lost that way.
            pending = 0
            notes.append(
                "the turn-end record on claude "
                + _version_text(record_version)
                + " omits the pending-agent field, which that harness "
                "does only when the count is zero, so no background "
                "agents were pending when the turn ended"
            )
        else:
            pending = None
            notes.append(
                "the turn-end record carries no pending-agent field and "
                "names no claude version at or above "
                + _version_text(MIN_PENDING_VERSION)
                + ", so the count is unknown rather than zero"
            )

    blocked_on_tool: Optional[str] = None
    if last_record is not None and last_record.get("type") == "assistant":
        blocks = _content_blocks(last_record, "tool_use")
        block = blocks[-1] if blocks else None
        if block is not None:
            block_id = block.get("id")
            answered = isinstance(block_id, str) and block_id in answered_tool_use_ids
            name = block.get("name")
            name = name if isinstance(name, str) and name else None
            if name and not answered:
                if name in BLOCKING_TOOL_NAMES:
                    blocked_on_tool = name
                else:
                    notes.append(
                        "the window ends on an unanswered call to "
                        + name
                        + ", which is a tool still running and not a "
                        "question for the user"
                    )

    queued_reinvoke = bool(
        newest_enqueue_at is not None
        and turn_end_at is not None
        and newest_enqueue_at > turn_end_at
    )
    if queued_reinvoke:
        notes.append(
            "a background agent's completion is queued and newer than "
            "the last turn end, so claude is about to be re-invoked "
            "with nobody asking it to"
        )

    open_async = 0
    for launch in launches.values():
        ids = {value for value in launch.values() if value}
        if ids & notified:
            continue
        open_async += 1
    # Counting unmatched launches rather than subtracting a balance is
    # what floors this at zero: a completion whose launch sits behind the
    # window can never push the number negative.
    if open_async:
        notes.append(
            str(open_async)
            + " background agent launch(es) in the window have no "
            "completion in it, which is a floor and not a total"
        )
    if blocked_on_tool:
        notes.append(
            "the window ends on an unanswered "
            + blocked_on_tool
            + ", so claude is waiting on the user"
        )

    if turn_end is None:
        verdict = FACTS_NO_RECORD
        head = (
            "the transcript tail that was read holds no turn-end "
            "record, so the number of pending background agents is "
            "unknown rather than zero"
        )
    else:
        verdict = FACTS_FOUND
        if pending is None:
            head = "a turn-end record was read and it names no usable agent count"
        else:
            head = (
                "a turn-end record was read and "
                + str(pending)
                + " background agent(s) were pending when the turn ended"
            )

    return TranscriptFacts(
        verdict=verdict,
        pending_background_agents=pending,
        pending_field_present=pending_present,
        turn_end_at=turn_end_at,
        newest_assistant_at=newest_assistant_at,
        newest_append_at=newest_append_at,
        blocked_on_tool=blocked_on_tool,
        queued_reinvoke=queued_reinvoke,
        open_async_agents=open_async,
        newest_user_prompt_at=newest_user_prompt_at,
        detail="; ".join([head] + notes),
    )


def read_transcript_facts(
    path: Optional[str],
    *,
    tail_bytes: int = FACTS_TAIL_BYTES,
    now: Optional[datetime] = None,
) -> TranscriptFacts:
    """Read the tail of one transcript and say what it means.

    Description: the I/O half, and it NEVER RAISES. The read is
      ``claude_title_sync.read_tail_records``, the one bounded transcript
      reader in this codebase, at the wider window this caller needs; no
      second reader is built here. It already drops the partial first
      line of a mid-file window and skips any line that does not parse,
      which is what makes a TORN final line from a live writer normal
      rather than a failure: the good records around it still count, and
      only a file that could not be OPENED refuses. So the mapping is
      two-way, not three-way: a refusal (no path, absent, unreadable)
      becomes :data:`FACTS_UNREADABLE` carrying the reader's own
      sentence, and anything read goes to the pure classifier.
    Inputs: path (str | None) - the conversation jsonl. tail_bytes (int)
      - the hard cap on how much is read. now (datetime | None) - the
      caller's clock, passed through to the classifier.
    Output: TranscriptFacts.
    Example:
      read_transcript_facts('/x/abc.jsonl').pending_background_agents -> 3
    """
    read = read_tail_records(path, tail_bytes=tail_bytes)
    if not read.readable:
        return TranscriptFacts(
            verdict=FACTS_UNREADABLE,
            detail=read.detail or "the transcript could not be read",
        )
    return classify_transcript_records(read.records, now=now)
