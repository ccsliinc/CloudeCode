"""Corpus-wide transcript ingester built on top of transcript_archive.py.

WHY THIS EXISTS. transcript_archive.py (schema v14) is the proven storage
layer: byte-exact ingest, export, verify, and a rooting primitive that
never guesses. This module is the layer ABOVE it - the thing that walks a
real ``~/.claude/projects`` corpus (via transcript_corpus_discover.py),
decides what is new versus already stored, ingests everything (never
gates storage on classification - see below), and then applies only the
DECISIVE rooting rules this project's STANDING HAZARDS forbid inventing
heuristics for.

STORE FIRST, CLASSIFY SECOND. The owner's goal is "confirm all my history
is preserved... i can consider it 100 percent backed up." A file being an
automated liveness probe, an orphaned subagent transcript, or a session
this database has never heard of are all CLASSIFICATION questions - they
decide how something is later DISPLAYED, never whether it is STORED. This
module ingests every readable ``*.jsonl`` under the corpus root,
including the probes (entrypoint ``sdk-cli``, see
claude_transcript_correlate.PROBE_ENTRYPOINT) and every subagent
transcript. Nothing here ever skips a file for what it appears to be.

IDEMPOTENCY KEY, STATED EXPLICITLY (this was the task's own instruction -
"this is the most important design decision"). The identity of "already
ingested" is the pair ``(source_path, content_sha256)``, evaluated in
that order:

  1. ``source_path`` (corpus-relative, e.g. ``<slug>/<uuid>.jsonl`` or
     ``<slug>/<uuid>/subagents/agent-x.jsonl`` - never an absolute path,
     because an absolute path is host-specific and this identity must
     mean the same thing on any machine that mounts the same corpus)
     names WHICH file. Corpus-relative rather than absolute so the same
     logical transcript ingested from two different checkouts of the
     corpus (e.g. two rsync copies) is recognised as the same file.
  2. ``content_sha256`` of the CURRENT bytes on disk names WHAT STATE
     that file is in right now.

A re-run against unchanged content is a no-op: the newest
``transcript_archives`` row for that ``source_path`` already carries that
exact ``content_sha256``, so nothing is written - this is what makes
re-running the ingester safe after an interruption.

THE GROWING-FILE CASE, THE NORMAL CASE, NOT AN EDGE CASE. A live Claude
Code session's transcript file grows continuously while the conversation
is in progress - every run of this ingester against a live corpus will
find some fraction of files whose content_sha256 no longer matches the
last-ingested row for that source_path. When that happens this module
does NOT overwrite or delete the old row - transcript_archives has no
UPDATE path for content_gzip anywhere in this codebase, on purpose, since
overwriting a byte-exact archive would silently discard whatever the
previous ingest had captured (an earlier snapshot of an in-progress
conversation is still real history: if this process were ever
interrupted or lost mid-conversation, the earlier snapshot is the only
copy of what existed at that point). Instead a NEW transcript_archives
row is inserted, ``kind`` and ``source_path`` identical, content and
content_sha256 different, root_state starting again at 'unrooted'. The
rooting pass in this module re-resolves it independently. The
consequence, stated plainly: a session ingested three times while live
produces three transcript_archives rows for the same source_path, and
that is correct - it is the append-only philosophy this database already
uses for transcript_root_decisions, applied to the growing-file case. A
caller that wants "the current state of this transcript" queries for
MAX(id) among rows sharing a source_path, which is exactly the query this
module's own idempotency check performs internally
(:func:`_latest_archive_for_source`).

ROOTING, DECISIVE ONLY - see the module docstring in transcript_archive.py
for the stop-case this must never violate. Two rules, both structural,
neither a guess:

  (a) SUBAGENT -> PARENT, BY DIRECTORY STRUCTURE. A subagent transcript's
      ``source_path`` is always ``<slug>/<uuid>/subagents/<file>.jsonl``
      - the ``<uuid>`` directory component IS the parent session's own
      filename stem. :func:`_derive_parent_source_path` recovers
      ``<slug>/<uuid>.jsonl`` by pure path arithmetic (no content is
      read, no heuristic is applied); if a session-kind archive with
      that exact source_path exists, the subagent archive is rooted to
      it via ``parent_archive_id``. If the parent was never ingested
      (missing, unreadable, or genuinely does not exist in the corpus),
      the subagent stays unrooted - reported as
      ``subagent_unrooted_no_parent``, never guessed at.
  (b) SESSION -> sessions ROW, BY EXACT UUID MATCH. A top-level
      transcript's filename IS the Claude session uuid (schema v13's
      ``claude_session_uuid`` capture is what makes this decisive - see
      claude_session_correlate_ladder.py). transcript_archives already
      extracts this into its own ``claude_session_uuid`` column at
      ingest time (see transcript_archive.py's ``_write_archive_rows``).
      This module looks up ``sessions.claude_session_uuid`` for an EXACT
      match: zero rows leaves it unrooted
      (``session_unrooted_no_session_row`` - most of the corpus, since
      most historical transcripts predate this app's own session
      tracking), exactly one rows it, more than one is refused and left
      unrooted (``session_unrooted_ambiguous`` - sessions.
      claude_session_uuid is UNIQUE in the schema, so this should be
      structurally impossible; it is handled anyway rather than assumed
      away, per the three-outcome rule).

THE OTHER DIRECTION: sessions WITH NO TRANSCRIPT. See
:func:`sessions_without_transcript` - a pure read, never mutates
anything, answers the owner's explicit second question ("anything in
original database that we dont have jsonl transcripts for") as a
three-way report, not a single count: sessions that name a
claude_session_uuid this ingest never saw a matching filename for (a
real gap), and sessions that have never learned a claude_session_uuid at
all (a DIFFERENT, weaker finding - there is no transcript filename to
even look for, so "no transcript" cannot be distinguished from "we never
learned which transcript is ours").
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Dict, List, Optional

try:
    import structlog

    logger = structlog.get_logger()
except ImportError:  # pragma: no cover - see transcript_archive.py's own guard
    class _NoOpLogger:
        def __getattr__(self, _name: str):
            return lambda *a, **k: None

    logger = _NoOpLogger()

from src.core.db import transaction
from src.core.transcript_archive import root_archive
from src.core.transcript_prefix_dedupe import ingest_with_prefix_dedupe
from src.core.transcript_project_root import root_pending_archives_by_project
from src.core.transcript_corpus_discover import (
    CorpusEntry,
    SUBAGENTS_DIRNAME,
    discover_corpus,
    hash_file,
    mtime_iso,
)

#: Decided-by tag written on every rooting decision this module makes,
#: so a human reviewing transcript_root_decisions can tell an automated
#: structural rooting apart from a manual one.
DECIDED_BY_INGESTER = "corpus_ingest:structural"


@dataclass
class FileOutcome:
    """The result of attempting to ingest one :class:`CorpusEntry`.

    Description: one row of the per-file detail a :class:`RunReport`
      aggregates from - kept separate so a caller that wants the detail
      (e.g. a "could not read" list with reasons) does not have to
      re-derive it from counts alone.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    source_path: str
    kind: str
    outcome: str  # "ingested" | "already_present" | "could_not_read"
    archive_id: Optional[int] = None
    raw_byte_length: Optional[int] = None
    reason: Optional[str] = None
    #: One of transcript_prefix_dedupe.VALID_GROWTH_KINDS when
    #: outcome == "ingested"; None otherwise (already_present and
    #: could_not_read never touch growth_kind).
    growth_kind: Optional[str] = None


@dataclass
class RunReport:
    """Aggregate counts and detail for one :func:`ingest_corpus` run.

    Description: distinguishes every outcome the task requires - never
      collapses "already present" into "ingested", and a
      could-not-read file is counted nowhere but its own bucket.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    total_discovered: int = 0
    newly_ingested: int = 0
    already_present: int = 0
    could_not_read: int = 0
    bytes_ingested: int = 0
    wall_clock_seconds: float = 0.0
    could_not_read_detail: List[FileOutcome] = field(default_factory=list)
    rooting: Dict[str, int] = field(default_factory=dict)
    #: session/subagent rooting leaves an archive unrooted; this fills in
    #: the weaker project-level root for as many of those as possible -
    #: see transcript_project_root.root_pending_archives_by_project.
    project_rooting: Dict[str, int] = field(default_factory=dict)


def _latest_archive_for_source(conn, source_path: str) -> Optional[dict]:
    """Find the newest transcript_archives row for a given source_path.

    Description: the read half of this module's idempotency key - see
      the module docstring's IDEMPOTENCY KEY section. "Newest" is by
      ``id`` (monotonic insert order), not by ``ingested_at`` (a
      timestamp string comparison would be equivalent here but id is
      the primary key and cannot collide or be ambiguous).
    Inputs: conn - sqlite3.Connection. source_path (str).
    Output: dict | None with keys id, content_sha256, kind.
    """
    row = conn.execute(
        "SELECT id, content_sha256, kind FROM transcript_archives"
        " WHERE source_path = ? ORDER BY id DESC LIMIT 1",
        (source_path,),
    ).fetchone()
    if row is None:
        return None
    return {
        "id": int(row["id"]),
        "content_sha256": row["content_sha256"],
        "kind": row["kind"],
    }


def ingest_one(conn, entry: CorpusEntry) -> FileOutcome:
    """Ingest (or skip, or report unreadable) exactly one corpus entry.

    Description: applies the (source_path, content_sha256) idempotency
      key - see the module docstring. Never writes when the newest known
      row for this source_path already carries the current content's
      hash. A file that cannot be opened or read is reported as
      ``could_not_read`` and NEVER counted as ingested, per this
      project's three-outcome rule. When content HAS changed, the write
      goes through :func:`~src.core.transcript_prefix_dedupe.ingest_with_prefix_dedupe`
      rather than a bare stream ingest, so a growing file is stored once,
      not twice - see that module's docstring for the append/
      non-append-rewrite distinction this delegates to.
    Inputs: conn - sqlite3.Connection, NOT already inside a transaction
      (this function opens its own for the write case, matching every
      other write path in transcript_archive.py). entry (CorpusEntry).
    Output: FileOutcome.
    """
    try:
        current_sha, size = hash_file(entry.abs_path)
    except OSError as exc:
        logger.warning(
            "corpus_ingest_unreadable",
            source_path=entry.source_path,
            error=str(exc),
        )
        return FileOutcome(
            source_path=entry.source_path,
            kind=entry.kind,
            outcome="could_not_read",
            reason=f"{type(exc).__name__}: {exc}",
        )

    existing = _latest_archive_for_source(conn, entry.source_path)
    if existing is not None and existing["content_sha256"] == current_sha:
        return FileOutcome(
            source_path=entry.source_path,
            kind=entry.kind,
            outcome="already_present",
            archive_id=existing["id"],
            raw_byte_length=size,
        )

    mtime = mtime_iso(entry.abs_path)
    try:
        outcome = ingest_with_prefix_dedupe(
            conn,
            entry.abs_path,
            kind=entry.kind,
            source_path=entry.source_path,
            existing_archive_id=existing["id"] if existing else None,
            source_mtime=mtime,
        )
    except OSError as exc:
        logger.warning(
            "corpus_ingest_unreadable_during_stream",
            source_path=entry.source_path,
            error=str(exc),
        )
        return FileOutcome(
            source_path=entry.source_path,
            kind=entry.kind,
            outcome="could_not_read",
            reason=f"{type(exc).__name__}: {exc}",
        )

    return FileOutcome(
        source_path=entry.source_path,
        kind=entry.kind,
        outcome="ingested",
        archive_id=outcome.archive_id,
        raw_byte_length=size,
        growth_kind=outcome.growth_kind,
    )


def _derive_parent_source_path(subagent_source_path: str) -> Optional[str]:
    """Recover a subagent transcript's parent session source_path.

    Description: pure path arithmetic, no content read - see rule (a)
      in the module docstring. Expects exactly
      ``<slug>/<uuid>/subagents/<file>.jsonl``; anything else is not a
      shape this module has ever observed and is refused rather than
      guessed at.
    Inputs: subagent_source_path (str).
    Output: str | None - ``<slug>/<uuid>.jsonl``, or None if the path
      does not match the expected shape.
    Example:
      _derive_parent_source_path("slug/abc-123/subagents/agent-x.jsonl")
      -> "slug/abc-123.jsonl"
    """
    parts = PurePosixPath(subagent_source_path).parts
    if len(parts) != 4 or parts[2] != SUBAGENTS_DIRNAME:
        return None
    slug, session_uuid = parts[0], parts[1]
    return f"{slug}/{session_uuid}.jsonl"


def root_pending_archives(
    conn, *, decided_by: str = DECIDED_BY_INGESTER
) -> Dict[str, int]:
    """Apply only the decisive rooting rules to every unrooted archive.

    Description: DB-driven, not corpus-walk-driven, so it is safe to run
      standalone as a repair pass and safe to re-run (an archive already
      rooted is not revisited - it is no longer 'unrooted'). See the
      module docstring's ROOTING section for both rules; this function
      is a pure dispatch over root_state='unrooted' rows using only
      information already stored on transcript_archives and sessions -
      no corpus file is read here.
    Inputs: conn - sqlite3.Connection. decided_by (str) - recorded on
      every transcript_root_decisions row this call writes.
    Output: dict[str, int] - counts keyed by outcome:
      subagent_rooted, subagent_unrooted_no_parent,
      subagent_unrooted_bad_path, session_rooted,
      session_unrooted_no_session_row, session_unrooted_ambiguous,
      session_unrooted_no_uuid.
    """
    counts: Dict[str, int] = {
        "subagent_rooted": 0,
        "subagent_unrooted_no_parent": 0,
        "subagent_unrooted_bad_path": 0,
        "session_rooted": 0,
        "session_unrooted_no_session_row": 0,
        "session_unrooted_ambiguous": 0,
        "session_unrooted_no_uuid": 0,
    }

    rows = conn.execute(
        "SELECT id, kind, source_path, claude_session_uuid"
        " FROM transcript_archives WHERE root_state = 'unrooted'"
        " ORDER BY id ASC"
    ).fetchall()

    for row in rows:
        archive_id = int(row["id"])
        if row["kind"] == "subagent":
            parent_source_path = _derive_parent_source_path(row["source_path"])
            if parent_source_path is None:
                counts["subagent_unrooted_bad_path"] += 1
                continue
            prow = conn.execute(
                "SELECT id FROM transcript_archives"
                " WHERE kind = 'session' AND source_path = ?",
                (parent_source_path,),
            ).fetchone()
            if prow is None:
                counts["subagent_unrooted_no_parent"] += 1
                continue
            with transaction(conn):
                root_archive(
                    conn,
                    archive_id,
                    parent_archive_id=int(prow["id"]),
                    decided_by=decided_by,
                    note=(
                        "structural: parent directory is the session "
                        f"transcript {parent_source_path}"
                    ),
                )
            counts["subagent_rooted"] += 1
        else:  # kind == "session"
            uuid = row["claude_session_uuid"]
            if not uuid:
                counts["session_unrooted_no_uuid"] += 1
                continue
            srows = conn.execute(
                "SELECT id FROM sessions WHERE claude_session_uuid = ?",
                (uuid,),
            ).fetchall()
            if len(srows) == 0:
                counts["session_unrooted_no_session_row"] += 1
            elif len(srows) > 1:
                counts["session_unrooted_ambiguous"] += 1
            else:
                with transaction(conn):
                    root_archive(
                        conn,
                        archive_id,
                        root_session_id=int(srows[0]["id"]),
                        decided_by=decided_by,
                        note=(
                            "filename is the claude session uuid, matched "
                            "sessions.claude_session_uuid exactly"
                        ),
                    )
                counts["session_rooted"] += 1

    return counts


def ingest_corpus(conn, corpus_root: Path) -> RunReport:
    """Walk a corpus, ingest every readable file, then root what is decisive.

    Description: the single entry point this module exists to provide.
      Order matters: ALL files are ingested first (store first, classify
      second - see module docstring), THEN :func:`root_pending_archives`
      runs once over the whole unrooted set, so a subagent ingested
      before its parent session (directory iteration order is not
      insert order) still roots correctly in the same run.
    Inputs: conn - sqlite3.Connection, schema already at v14 or later.
      corpus_root (Path) - see transcript_corpus_discover.discover_corpus.
    Output: RunReport.
    Example:
        from src.core.transcript_corpus_discover import default_corpus_root
        report = ingest_corpus(conn, default_corpus_root())
    """
    started = time.monotonic()
    report = RunReport()
    entries = discover_corpus(corpus_root)
    report.total_discovered = len(entries)

    for entry in entries:
        outcome = ingest_one(conn, entry)
        if outcome.outcome == "ingested":
            report.newly_ingested += 1
            report.bytes_ingested += outcome.raw_byte_length or 0
        elif outcome.outcome == "already_present":
            report.already_present += 1
        else:
            report.could_not_read += 1
            report.could_not_read_detail.append(outcome)

    report.rooting = root_pending_archives(conn)
    report.project_rooting = root_pending_archives_by_project(conn)
    report.wall_clock_seconds = time.monotonic() - started

    logger.info(
        "corpus_ingest_run_complete",
        total_discovered=report.total_discovered,
        newly_ingested=report.newly_ingested,
        already_present=report.already_present,
        could_not_read=report.could_not_read,
        bytes_ingested=report.bytes_ingested,
        wall_clock_seconds=report.wall_clock_seconds,
        **report.rooting,
    )
    return report


def sessions_without_transcript(conn) -> Dict[str, list]:
    """Antijoin sessions against ingested transcripts - the honest gap report.

    Description: answers "anything in original database that we dont
      have jsonl transcripts for" as a THREE-WAY report, never a single
      count, because "no transcript" and "we never learned which
      transcript is ours" are different findings with different causes
      - see the module docstring's THE OTHER DIRECTION section. Never
      mutates anything; never invents an archive row for a gap it finds.
    Inputs: conn - sqlite3.Connection.
    Output: dict with two keys, each a list[dict]:
      "no_uuid_recorded" - sessions.claude_session_uuid IS NULL, so
        there is no filename to even search for (rows: id, session_uuid,
        origin, adopted_at, created_at).
      "uuid_recorded_no_matching_archive" - sessions.claude_session_uuid
        IS NOT NULL but no transcript_archives row (of kind 'session')
        carries that exact claude_session_uuid - a real, named gap
        (same row shape plus claude_session_uuid).
    Example: sessions_without_transcript(conn)["no_uuid_recorded"]
      -> [{"id": 3, "session_uuid": "...", ...}]
    """
    no_uuid_rows = conn.execute(
        "SELECT id, session_uuid, origin, adopted_at, created_at"
        " FROM sessions WHERE claude_session_uuid IS NULL"
        " ORDER BY id ASC"
    ).fetchall()

    gap_rows = conn.execute(
        "SELECT s.id, s.session_uuid, s.origin, s.adopted_at,"
        " s.created_at, s.claude_session_uuid"
        " FROM sessions s"
        " WHERE s.claude_session_uuid IS NOT NULL"
        " AND NOT EXISTS ("
        "   SELECT 1 FROM transcript_archives a"
        "   WHERE a.kind = 'session'"
        "   AND a.claude_session_uuid = s.claude_session_uuid"
        " )"
        " ORDER BY s.id ASC"
    ).fetchall()

    return {
        "no_uuid_recorded": [dict(r) for r in no_uuid_rows],
        "uuid_recorded_no_matching_archive": [dict(r) for r in gap_rows],
    }
