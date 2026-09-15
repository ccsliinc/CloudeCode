"""The listing pass's attention evidence: read in the gather, resolved on the loop.

WHAT MOVED AND WHY. ``/sessions/list`` used to take its
``activity_status`` from an in-memory counter fed by Claude Code's
lifecycle hooks, with a durable-row restore and a transcript seed behind
it. That counter's INPUT was mislabeled at the source - every background
agent in a pane posts hooks under the pane's one session id - so no
ordering fix could move the number. The listing now asks the same pure
resolver the watcher asks, ``src.core.attention.resolve``, and paints
what it answers.

THE SPLIT IS THE SAME ONE ``listing_gather`` ALREADY ENFORCES. The two
readings the resolver needs are FILE READS, so both happen in the gather
thread; the resolving is arithmetic on frozen dataclasses, so it happens
on the loop with the rest of the per-row work. Nothing here touches live
shared state, which is why the readers can be handed to the thread as
bare callables.

THE REGISTRY IS READ ONCE PER PASS, NOT ONCE PER ROW. It is a single
scandir over about ten sub-1KB files, and every row's answer is a lookup
into the one mapping that scan produced. Reading it per row would turn a
constant into an N and would additionally let two rows in one pass
disagree about the same instant.

THE TRANSCRIPT IS READ PER ROW, IN THE THREAD, AND THE PATH COMES FROM
THE ROW THE PASS ALREADY READ. ``claude_session_uuid`` and
``working_dir`` are two of the four columns ``InstanceIndex`` already
carries, so no new query is issued: the index this pass builds anyway is
asked for a conversation and the conversation resolves to a file. A
session whose instance is not in the index answers ``(None, None)``, and
a transcript with no path answers :data:`FACTS_UNREADABLE` - a refusal
the resolver cannot turn into "done", which is the whole point.

ABSENT IS NOT AN ANSWER, AND NEITHER READER CAN RETURN ``None``. Both
``registry_for_session`` and :func:`transcript_facts_for` answer a record
carrying their own refusal verdict, so the only ``None`` a caller can see
is the prefetch reporting that this name was NOT READ - which is a
different fact and falls through to a live read.
"""

from __future__ import annotations

import os
import threading
from datetime import datetime
from typing import Any, Dict, Mapping, Optional, Tuple

import structlog

from src.core.attention.display import status_source_for, to_display
from src.core.attention.evidence import Evidence, PaneVerdict
from src.core.attention.registry_read import RegistryRecord, registry_for_session
from src.core.attention.resolve import resolve_attention
from src.core.attention.transcript_facts import (
    FACTS_UNREADABLE,
    TranscriptFacts,
    read_transcript_facts,
)

logger = structlog.get_logger()

#: What a transcript read may fail with. Everything here is a filesystem
#: or decode failure a live writer produces in the ordinary course; each
#: one is a refusal, never an exception the listing may propagate.
_READ_ERRORS = (OSError, ValueError, TypeError, AttributeError, KeyError)

#: Path to (mtime_ns, size, facts) for transcripts already parsed.
#:
#: WHY A MEMO AT ALL. A 256 KB tail read plus its json parse measured
#: 2.45 ms p50 on the owner's box, and the listing takes it once per
#: session every poll: at 14 sessions on a 5 s poll that is 35 ms of
#: work per pass, twelve times more often than the status seed this
#: replaced (which re-derived at most once a minute per session).
#:
#: WHY IT IS NOT A TIMER. The key is the file's own (mtime, size), so a
#: transcript that has not been appended to serves the parse it already
#: paid for, and one that HAS is re-read on the very next pass. That is
#: strictly fresher than an interval cache as well as cheaper: an
#: interval can serve a stale answer about a file that moved, and this
#: cannot. A jsonl that a live agent appends to changes both halves of
#: the key on every write.
_FACTS_MEMO: Dict[str, Tuple[int, int, TranscriptFacts]] = {}

#: Guards :data:`_FACTS_MEMO`. The listing gather runs in a worker
#: thread and two passes can overlap, so the dict is not left to the GIL.
_FACTS_MEMO_LOCK = threading.Lock()

#: How many parsed transcripts the memo holds before it is emptied. One
#: entry is a small frozen dataclass, and the working set is the live
#: session count; the bound exists so a long-running server that has
#: seen thousands of conversations cannot grow without limit.
FACTS_MEMO_MAX_ENTRIES: int = 256


def transcript_facts_for(
    claude_session_uuid: Optional[str],
    working_dir: Optional[str],
    *,
    now: Optional[datetime] = None,
) -> TranscriptFacts:
    """Read one session's transcript tail and say what it means. NEVER RAISES.

    Description: resolves the conversation uuid to a file through
      ``session_transcript_presence.conversation_presence`` - the same
      resolver the restart preview and the status seed use, so the
      listing cannot locate a transcript differently from anything else -
      and hands the path to
      ``src.core.attention.transcript_facts.read_transcript_facts``.

      THE THREE REFUSALS COLLAPSE TO ONE HERE, AND THAT IS CORRECT. No
      uuid, a measured absence and an unreadable path are separate facts
      for a user-facing message, but the resolver treats all three
      identically: none of them is evidence of rest. Each still carries
      its own sentence in ``detail``.
    Inputs:
      claude_session_uuid (str | None) - ``sessions.claude_session_uuid``.
      working_dir (str | None) - used only for the fast-path project slug.
      now (datetime | None) - the caller's clock, passed to the classifier.
    Output: TranscriptFacts - never None.
    Example: transcript_facts_for(uuid, '/Users/x/proj').found -> True
    """
    if not claude_session_uuid:
        return TranscriptFacts(
            verdict=FACTS_UNREADABLE,
            detail=(
                "no claude conversation is bound to this row, so there is "
                "no transcript to read attention out of"
            ),
        )
    try:
        from src.core.session_transcript_presence import conversation_presence

        presence = conversation_presence(
            str(claude_session_uuid), working_dir=working_dir
        )
    except _READ_ERRORS as exc:
        logger.warning(
            "listing_attention_presence_failed",
            uuid=str(claude_session_uuid),
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return TranscriptFacts(
            verdict=FACTS_UNREADABLE,
            detail="the transcript could not be located: %s" % exc,
        )

    if presence.path is None:
        return TranscriptFacts(
            verdict=FACTS_UNREADABLE,
            detail=presence.detail or "no transcript file was found",
        )
    return _facts_for_path(str(presence.path), now=now)


def _facts_for_path(
    path: str, *, now: Optional[datetime] = None
) -> TranscriptFacts:
    """Parse one transcript tail, reusing the parse if the file has not moved.

    Description: stats the file and answers from :data:`_FACTS_MEMO`
      when its ``(mtime_ns, size)`` are the pair that produced the cached
      facts. A file that moved, a file whose stat failed, and a file we
      have never seen all go to the real reader, so the memo can only
      ever save work and never substitute an answer about a different
      version of a file.

      A ``now`` PASSED BY THE CALLER IS NOT PART OF THE KEY, AND THAT IS
      SAFE, because the classifier uses the clock only for durations it
      reports, never to decide a verdict from an unchanged file. The
      tests that drive a frozen clock pass ``now`` against files they
      have just written, which never hit the memo.
    Inputs: path (str) - the conversation jsonl. now (datetime | None).
    Output: TranscriptFacts - never None.
    Example: _facts_for_path('/x/abc.jsonl').found -> True
    """
    try:
        stat = os.stat(path)
        key = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        # A stat that failed is not a cache miss to remember; the reader
        # below answers the refusal with its own sentence.
        return read_transcript_facts(path, now=now)

    with _FACTS_MEMO_LOCK:
        cached = _FACTS_MEMO.get(path)
    if cached is not None and (cached[0], cached[1]) == key:
        return cached[2]

    facts = read_transcript_facts(path, now=now)
    with _FACTS_MEMO_LOCK:
        if len(_FACTS_MEMO) >= FACTS_MEMO_MAX_ENTRIES:
            _FACTS_MEMO.clear()
        _FACTS_MEMO[path] = (key[0], key[1], facts)
    return facts


def attention_reads_for_name(
    tmux_name: Optional[str],
    *,
    registry_index: Optional[Mapping[str, RegistryRecord]],
    session_started_epoch: Optional[int],
    claude_session_uuid: Optional[str],
    working_dir: Optional[str],
    now: Optional[datetime] = None,
    transcript_reader: Optional[Any] = None,
) -> Tuple[RegistryRecord, TranscriptFacts]:
    """Both file-backed tiers for one tmux name. THREAD BODY, never raises.

    Description: the registry half is a LOOKUP plus two pure identity
      gates against the one index the pass scanned; the transcript half
      is the bounded tail read. Neither touches shared mutable state, so
      this is safe to call from the gather thread and is where both
      belong: the tail read is up to 256 KB and must never be paid on the
      event loop.
    Inputs:
      tmux_name (str | None) - the bare tmux session name.
      registry_index (Mapping | None) - one ``read_registry_index`` scan.
        None means the scan did not run, which answers ``REG_ABSENT``.
      session_started_epoch (int | None) - the pane's ``#{session_created}``,
        the instance floor. None skips that gate.
      claude_session_uuid (str | None) - the conversation on the row.
      working_dir (str | None) - for the transcript's slug fast path.
      now (datetime | None) - the caller's clock.
      transcript_reader (callable | None) - the tail reader, handed in so
        the gather's reader bundle stays the one place the pass's I/O is
        named. Defaults to :func:`transcript_facts_for`.
    Output: tuple[RegistryRecord, TranscriptFacts] - neither is None.
    Example: attention_reads_for_name('cloude_a', registry_index=idx,
      session_started_epoch=1788463220, claude_session_uuid=None,
      working_dir=None)
    """
    registry = registry_for_session(
        tmux_name=tmux_name,
        index=registry_index if registry_index is not None else {},
        session_started_epoch=session_started_epoch,
        claude_session_uuid=claude_session_uuid,
    )
    reader = transcript_reader or transcript_facts_for
    transcript = reader(claude_session_uuid, working_dir, now=now)
    return (registry, transcript)


def pane_verdict_from_permission(verdict: Optional[str]) -> Optional[PaneVerdict]:
    """Turn the permission re-verify's outcome into a pane tri-state.

    Description: the listing captures no pane of its own - that would be
      a subprocess per session per poll - but the permission re-verify
      already runs one ``capture-pane`` for the rare session holding an
      open claim past its grace window, and its outcome IS a reading of
      the screen. This reuses it rather than taking a second one.

      ONLY THE PERMISSION FAMILY IS FILLED IN, AND THAT IS THE POINT. The
      capture matched permission markers and looked for nothing else, so
      ``question_dialog`` stays None: we did not look. A verdict of
      ``cleared_no_dialog`` therefore yields a pane that says "no
      permission dialog" and NOT "the screen is clear", which is exactly
      the distinction ``PaneVerdict.shows_no_dialog`` requires both
      families for.
    Inputs: verdict (str | None) - a ``PERMISSION_*`` value from
      ``session_permission_verify``.
    Output: PaneVerdict | None - None whenever no capture ran, which is
      "we did not look" and never "nothing was there".
    Example: pane_verdict_from_permission('kept_dialog_present')
    """
    from src.core.session_permission_verify import (
        PERMISSION_CLEARED_NO_DIALOG,
        PERMISSION_KEPT_DIALOG,
    )

    if verdict == PERMISSION_KEPT_DIALOG:
        return PaneVerdict(
            permission_dialog=True,
            detail="the permission re-verify read a dialog on this pane",
        )
    if verdict == PERMISSION_CLEARED_NO_DIALOG:
        return PaneVerdict(
            permission_dialog=False,
            detail=(
                "the permission re-verify read this pane and matched no "
                "permission dialog; no other dialog family was looked for"
            ),
        )
    # Every other verdict - not checked, tail unreadable, pane dead -
    # means no text was read, so there is nothing to report either way.
    return None


def resolve_row_status(
    *,
    registry: RegistryRecord,
    transcript: TranscriptFacts,
    tmux_liveness: str,
    agent_family: Optional[str],
    pane: Optional[PaneVerdict],
    unread: bool,
    tmux_status: str,
    now: datetime,
) -> Tuple[str, str]:
    """One row's painted status and the tier that decided it. ON THE LOOP.

    Description: assembles the four tiers into an :class:`Evidence`
      bundle, resolves it, and projects the verdict onto the eight status
      names. PURE: every input is passed in, nothing is read here, and
      the same bundle handed to the same function is what keeps
      ``/sessions/list`` from ever disagreeing with a toast.

      ``pane`` IS OPTIONAL AND ``None`` MEANS WE DID NOT LOOK. The listing
      does not capture a pane for every row - that would be a subprocess
      per session - so it passes whatever the permission re-verify
      already measured, and ``None`` when that path did not run. A pane
      we did not look at can never contribute a ``needs_user``, which is
      the honest direction.
    Inputs:
      registry (RegistryRecord), transcript (TranscriptFacts) - the two
        file tiers, each carrying its own refusal.
      tmux_liveness (str) - a ``LIVENESS_*`` value from
        ``src.core.session_status``.
      agent_family (str | None) - the family on the row, or None when it
        was never determined.
      pane (PaneVerdict | None) - what pane text showed, or None.
      unread (bool) - the persisted unread flag, as measured.
      tmux_status (str) - the raw tmux classification, consulted for
        ``dead`` alone.
      now (datetime) - timezone-aware UTC.
    Output: tuple[str, str] - the activity status and its
      ``status_source`` token.
    Example: resolve_row_status(...) -> ('working', 'registry')
    """
    verdict = resolve_attention(
        Evidence(
            tmux_liveness=tmux_liveness,
            agent_family=agent_family,
            registry=registry,
            transcript=transcript,
            pane=pane,
            now=now,
        )
    )
    return (
        to_display(verdict, unread=unread, tmux_status=tmux_status),
        status_source_for(verdict),
    )


def conversation_for_instance(
    index: Any, tmux_name: Optional[str], epoch: Optional[int]
) -> Tuple[Optional[str], Optional[str]]:
    """The conversation uuid and working dir for one tmux instance, or (None, None).

    Description: reads two of the four columns ``InstanceIndex`` already
      carries, so the transcript path costs no query of its own. ONLY A
      COMPLETE INDEX IS BELIEVED: a False ``complete`` means nothing was
      looked at, and a None off a reading that never ran is not a reading
      of nothing - it is the same discipline ``read_instance_row``
      applies before it falls back to its own connection.
    Inputs: index (InstanceIndex | None). tmux_name (str | None). epoch
      (int | None) - the pane's ``#{session_created}``.
    Output: tuple[str | None, str | None] - uuid, working dir.
    Example: conversation_for_instance(idx, 'cloude_a', 1788463220)
    """
    if index is None or not getattr(index, "complete", False):
        return (None, None)
    reader = getattr(index, "seed_row", None)
    if not callable(reader):
        return (None, None)
    try:
        row = reader(tmux_name, epoch)
    except _READ_ERRORS:
        return (None, None)
    if not row:
        return (None, None)
    return (row.get("claude_session_uuid"), row.get("working_dir"))
