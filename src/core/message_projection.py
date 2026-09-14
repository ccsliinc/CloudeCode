"""Project the transcript archive into the v16 message model, one file at a time.

THE DEFECT THIS CLOSES, STATED PLAINLY. The background ingester fills
``transcript_archives`` / ``transcript_records``; the archive browser
reads ``message_transcripts`` / ``message_bodies`` /
``message_content_blocks`` / ``message_appearances``. Measured on the
owner's 2026-09-10 backup: 22,828 archive rows holding 3,703,771,340
compressed bytes, and ZERO rows in all four of the tables the browser
reads. Every statement in that system was individually true and nobody
put two of them side by side. This module is the join.

WHY THE ARCHIVE AND NOT THE FILESYSTEM, WHICH IS THE WHOLE DESIGN. Every
existing entry point into the message model reads ``~/.claude/projects``
directly, and that is what makes growth unanswerable there: the same
path arrives again and again with different bytes, and ``ingest_lines``
correctly refuses it. Reading the ARCHIVE instead inherits a problem
already solved. The archive layer stores each version of a file as its
own immutable row, proves the growth relationship link by link
(:mod:`src.core.transcript_prefix_dedupe`), and marks the older row
``superseded_by_archive_id``. Measured on that same backup: among the
19,401 rows with no superseding row, ``source_path`` is unique 19,401
times out of 19,401. So "the current archive set" is already exactly one
row per file, and projecting it gives exactly one message transcript per
file with no deduplication of our own.

THE MODEL'S REFUSAL IS NOT WEAKENED, AND THAT MATTERS BECAUSE IT WAS
DELIBERATE. ``ingest_lines`` still refuses a ``source_ref`` it already
holds, with its original wording. A file whose bytes changed is handled
one level up, by DELETING the stored transcript and ingesting the new
bytes - and only when :mod:`src.core.message_projection_ledger` shows
that the archive layer itself measured a different ``content_sha256``.
That is a recorded replacement driven by somebody else's measurement,
not a silent overwrite driven by this module's opinion. The delete
cascades to ``message_appearances`` and STOPS THERE: ``message_bodies``
are interned, shared across transcripts, and are reused by the very next
ingest of the grown file, which is what makes a replace cheap - a file
that gained ten lines re-interns nothing and creates ten bodies.

WHAT A REPLACE LEAVES BEHIND, SAID OUT LOUD. Bodies that no surviving
appearance points at are not collected here. Measured basis for
accepting that: 849 of 22,828 archive rows carry ``growth_kind='append'``,
so the population is small and bounded, and a body is a small row whose
presence costs a reader nothing. Collecting them is a separate pass with
its own claim to prove and is NOT pretended to have been done.

COST, MEASURED RATHER THAN ESTIMATED. On 300 real archives sampled from
the owner's corpus, projecting 169,333,023 raw bytes took 202.65s
(0.84 MB/s) and produced a database 1.50x the raw bytes. Only 0.23s of
that was decompression; the rest is JSON parsing and the model's own
per-line fidelity round trip. Extrapolated to the 11,007,070,921 raw
bytes of the current archive set that is roughly 3.6 hours of CPU and
roughly 16.5 GB of database - which is why this runs BUDGETED in the
background and why the whole-corpus drain is an operator script the
owner runs deliberately, rather than something an upgrade does to his
disk while he is not looking.

ONE FILE IS ONE TRANSACTION, AND THE BIGGEST FILE IS THE BOUND. The
whole of one archive's ingest happens inside a single ``BEGIN
IMMEDIATE``, which is what makes a replace atomic: there is no instant
where a transcript has been deleted and not yet rewritten. The cost of
that is a write lock held for as long as the file takes, and the largest
transcript in the owner's corpus is 244 MB - about five minutes at the
measured throughput. WAL plus the 30s busy timeout
(``src.core.db.CONNECTION_PRAGMAS``) is what lets another writer wait
rather than fail, and within one server process the question does not
arise at all because the scheduler runs the ingest and this pass
sequentially. Shrinking that window means moving the parse outside the
transaction, which is a change to ``ingest_lines`` and is NOT pretended
to have been made here. It is also why the first-run drain is an
operator script the owner runs when it suits him.

IT IS NEVER ON THE EVENT LOOP. ``run_projection_once`` is synchronous
sqlite and synchronous CPU from end to end, and its only in-process
caller hands it to ``asyncio.to_thread``. See
:mod:`src.core.corpus_ingest_task`.
"""

from __future__ import annotations

import sqlite3
import time
import zlib
from contextlib import closing
from pathlib import Path
from threading import Event
from typing import Dict, Optional

import structlog

from src.core import message_projection_state as state_io
from src.core.message_projection_report import (
    DEFAULT_MAX_ARCHIVES,
    DEFAULT_MAX_SECONDS,
    MIN_ARCHIVE_SCHEMA,
    MIN_HOST_SCHEMA,
    STATUS_CANCELLED,
    STATUS_DATASTORE_UNAVAILABLE,
    STATUS_DISABLED,
    STATUS_FAILED,
    STATUS_HOST_UNRESOLVED,
    STATUS_MODEL_ABSENT,
    STATUS_OK,
    STATUS_SCHEMA_TOO_OLD,
    ProjectionReport,
    resolve_max_archives,
    resolve_max_seconds,
)
from src.core import message_projection_ledger as ledger
from src.core.archive_db_partition import archive_db_path_for
from src.core.db import connect_archive_only, table_exists
from src.core.db import DatastoreError, connect, db_path_for, read_schema_version
from src.core.message_archive_flag import (
    ENABLE_ENV as MESSAGE_ARCHIVE_ENV,
    resolve as resolve_message_archive,
)
from src.core.message_model_ingest import SourceLine, ingest_lines
from src.core.transcript_archive import export_archive

logger = structlog.get_logger()

def _split_source_lines(data: bytes) -> tuple:
    """Split archived transcript bytes into the model's line sequence.

    Description: the archive stores the file's ORIGINAL bytes, so this
      decodes rather than re-serialises. ``surrogateescape`` is used so a
      byte sequence that is not valid UTF-8 survives the round trip
      instead of raising - the model measures fidelity per line and will
      say so itself if the trip is lossy, which is a better answer than
      refusing the whole file here.
    Inputs: data (bytes - exactly what export_archive returned).
    Output: (list[SourceLine], has_trailing_newline bool, line_ending str).
    Example: _split_source_lines(b'{"a":1}\\n')[1] -> True
    """
    text = data.decode("utf-8", errors="surrogateescape")
    line_ending = "CRLF" if "\r\n" in text else "LF"
    if line_ending == "CRLF":
        text = text.replace("\r\n", "\n")
    trailing = text.endswith("\n")
    body = text[:-1] if trailing else text
    if not body:
        return [], trailing, line_ending
    return (
        [SourceLine(piece) for piece in body.split("\n")],
        trailing,
        line_ending,
    )


def _session_ref_for(source_path: str) -> str:
    """Derive a transcript's session ref from its path, the corpus's own way.

    Description: THE FILE STEM IS THE IDENTITY, and that is measured
      rather than preferred. A subagent transcript's records report the
      PARENT conversation's ``sessionId``, so reading identity out of the
      records would file every subagent run under its parent. The stem is
      what ``scripts/message_model_corpus_run.py`` already uses and what
      ``session_ref_scheme`` is written to classify, including the
      ``opaque`` answer for a stem that is neither a uuid nor an agent id
      (a literal ``audit`` or ``journal``). Nothing is repaired here: a
      stem is passed through exactly as the corpus spells it.
    Inputs: source_path (str - relative to the corpus root).
    Output: str.
    Example: _session_ref_for("-Users-x/abc.jsonl") -> 'abc'
    """
    stem = source_path.rsplit("/", 1)[-1]
    return stem[: -len(".jsonl")] if stem.endswith(".jsonl") else stem


def project_one(
    conn: sqlite3.Connection, pending: ledger.PendingArchive, *,
    host_id: int, corpus_id: int, corpus_key: str, machine_id: str,
    layout: str,
) -> Dict[str, object]:
    """Project one archive row into the message model, inside one transaction.

    Description: reads the archive's original bytes, deletes any stored
      transcript for the same file (a REPLACE, only reachable because the
      ledger showed a different content_sha256), ingests the lines, then
      attributes the result to its host, corpus and project. Store first,
      classify second: attribution is a second write, so a file whose
      project slug cannot be derived is still fully stored.
    Inputs: conn (sqlite3.Connection, NOT already in a transaction),
      pending (PendingArchive), host_id (int), corpus_id (int),
      corpus_key (str), machine_id (str), layout (str - one of
      message_host_dimension.LAYOUTS).
    Output: dict with 'outcome' (one of the ledger OUTCOME_* values),
      'lines' (int), and 'reason' (str or None).
    Raises: nothing it can name. sqlite3.Error from the ledger write is
      left to the caller, which is the only failure that means the pass
      itself is broken rather than one file.
    Example: project_one(conn, p, host_id=1, corpus_id=1,
      corpus_key="claude-projects", machine_id="M",
      layout="claude_projects")["outcome"] -> 'projected'
    """
    from src.core.message_host_dimension import (
        PROJ_NONE_DECLARED, attribute_transcript, derive_slug, global_source_ref,
        upsert_project,
    )

    source_ref = global_source_ref(machine_id, corpus_key, pending.source_path)
    session_ref = _session_ref_for(pending.source_path)
    try:
        data = export_archive(conn, pending.archive_id)
    except (LookupError, ValueError, zlib.error, sqlite3.Error) as exc:
        return {
            "outcome": ledger.OUTCOME_COULD_NOT_READ,
            "lines": 0,
            "reason": f"{type(exc).__name__}: {exc}",
            "source_ref": source_ref,
            "transcript_id": None,
        }

    lines, trailing, line_ending = _split_source_lines(data)
    replacing = pending.prior_outcome is not None

    conn.execute("BEGIN IMMEDIATE")
    try:
        # The DELETE is the replace, and it is keyed on source_ref rather
        # than on the ledger's remembered transcript_id: the ledger can
        # be behind (a refusal recorded no id) while the model holds a
        # row, and leaving that row behind would make the next ingest
        # raise on the UNIQUE constraint forever.
        deleted = conn.execute(
            "DELETE FROM message_transcripts WHERE source_ref = ?", (source_ref,)
        ).rowcount
        result = ingest_lines(
            conn, source_ref=source_ref, session_ref=session_ref,
            lines=lines, has_trailing_newline=trailing,
            line_ending=line_ending, now=pending.ingested_at,
        )
        slug, attribution = derive_slug(pending.source_path, layout)
        project_id = (
            upsert_project(conn, corpus_id, slug, None, pending.ingested_at)
            if slug else None
        )
        attribute_transcript(
            conn, result.transcript_id, host_id=host_id, corpus_id=corpus_id,
            project_id=project_id, source_path=pending.source_path,
            host_attribution="declared",
            project_attribution=attribution if slug else PROJ_NONE_DECLARED,
        )
        conn.execute("COMMIT")
    except (sqlite3.Error, ValueError, KeyError, TypeError) as exc:
        conn.execute("ROLLBACK")
        return {
            "outcome": ledger.OUTCOME_COULD_NOT_INGEST,
            "lines": 0,
            "reason": f"{type(exc).__name__}: {exc}",
            "source_ref": source_ref,
            "transcript_id": None,
        }
    outcome = (
        ledger.OUTCOME_REPLACED if (replacing or deleted)
        else ledger.OUTCOME_PROJECTED
    )
    return {
        "outcome": outcome,
        "lines": result.line_count,
        "reason": None,
        "source_ref": source_ref,
        "transcript_id": result.transcript_id,
    }


def run_projection_once(
    state_dir: Path, *, cancel: Optional[Event] = None,
    max_archives: int = DEFAULT_MAX_ARCHIVES,
    max_seconds: float = DEFAULT_MAX_SECONDS,
    publish: bool = True,
    respect_flag: bool = True,
) -> ProjectionReport:
    """Perform exactly one budgeted projection pass. Never raises.

    Description: resolves the datastore, checks both schema floors,
      confirms the message model's tables exist, interns this host and
      corpus, then projects pending archives newest-first until either
      budget is spent or the queue is empty, checking ``cancel`` between
      files. The liveness record is published on EVERY terminating path
      including failures, because a projection whose failures are silent
      is indistinguishable from one that has nothing left to do.
    Inputs: state_dir (Path - Settings.get_state_dir()), cancel
      (threading.Event | None - set it to stop between files),
      max_archives (int), max_seconds (float), publish (bool - False
      suppresses the liveness write, for callers that are probing),
      respect_flag (bool - False runs even when the message archive is
      switched off, which only an operator script may ask for).
    Output: ProjectionReport.
    Example: run_projection_once(Path("/nonexistent")).status
      -> 'datastore_unavailable'
    """
    started = time.monotonic()
    report = ProjectionReport(
        started_at=state_io.utc_now_iso(),
        budget_archives=max_archives,
        budget_seconds=max_seconds,
    )
    try:
        _run_inner(state_dir, cancel, max_archives, max_seconds,
                   respect_flag, report)
    except (sqlite3.Error, OSError, ValueError, DatastoreError) as exc:
        report.status = STATUS_FAILED
        report.reason = f"{type(exc).__name__}: {exc}"
        logger.warning("message_projection_failed", error=report.reason)
    report.wall_clock_seconds = time.monotonic() - started
    report.finished_at = state_io.utc_now_iso()
    if publish:
        state_io.write_liveness(state_dir, report.to_record())
    logger.info(
        "message_projection_run", status=report.status,
        projected=report.projected, replaced=report.replaced,
        could_not_read=report.could_not_read,
        could_not_ingest=report.could_not_ingest,
        pending_after=report.pending_after,
        seconds=round(report.wall_clock_seconds, 3),
    )
    return report


def _run_inner(
    state_dir: Path, cancel: Optional[Event], max_archives: int,
    max_seconds: float, respect_flag: bool, report: ProjectionReport,
) -> None:
    """Body of :func:`run_projection_once`, split out to keep it readable.

    Description: mutates ``report`` in place. Raises only what
      :func:`run_projection_once` catches and turns into STATUS_FAILED.
    Inputs: state_dir (Path), cancel (Event | None), max_archives (int),
      max_seconds (float), respect_flag (bool), report (mutated).
    Output: None.
    Example: _run_inner(Path("/s"), None, 1, 1.0, True, report)
    """
    if respect_flag:
        flag = resolve_message_archive()
        if not flag.enabled:
            report.status = STATUS_DISABLED
            report.reason = (
                f"the message archive is {flag.state} ({MESSAGE_ARCHIVE_ENV}); "
                "nothing was projected and nothing is claimed about coverage"
            )
            return

    # THE SCHEMA VERSION LIVES IN cloude.db AND THE WORK LIVES IN THE
    # ARCHIVE, so they are read on two connections and the cloude.db one
    # is closed before any archive write begins. A single connection
    # holding both files would take cloude.db's write lock on every
    # BEGIN IMMEDIATE - measured at 63,927 ms of blocked event loop, and
    # an ingest pass killed outright with "database is locked". See
    # db.connect_archive_only.
    try:
        with closing(connect(db_path_for(state_dir), create=False)) as app:
            version = read_schema_version(app)
    except DatastoreError as exc:
        report.status = STATUS_DATASTORE_UNAVAILABLE
        report.reason = str(exc)
        return

    try:
        conn = _projection_connection(state_dir)
    except DatastoreError as exc:
        report.status = STATUS_DATASTORE_UNAVAILABLE
        report.reason = str(exc)
        return

    with closing(conn):
        report.schema_version = version.value
        if not version.readable or version.value is None:
            report.status = STATUS_DATASTORE_UNAVAILABLE
            report.reason = (
                "schema_version could not be read, so neither the archive "
                "tables nor the message model can be assumed present"
            )
            return
        if version.value < MIN_HOST_SCHEMA:
            report.status = STATUS_SCHEMA_TOO_OLD
            report.reason = (
                f"datastore is at schema v{version.value}; the projection "
                f"needs v{MIN_ARCHIVE_SCHEMA} for the archive tables and "
                f"v{MIN_HOST_SCHEMA} for the host dimension the browser's "
                "rail is built on"
            )
            return
        _project_pass(conn, cancel, max_archives, max_seconds, report)


def _project_pass(
    conn: sqlite3.Connection, cancel: Optional[Event], max_archives: int,
    max_seconds: float, report: ProjectionReport,
) -> None:
    """Project up to the budget, newest archive first.

    Description: the loop. The budget is checked BETWEEN files so a file
      already begun is finished rather than abandoned, and ``cancel`` is
      checked in the same place for the same reason.
    Inputs: conn (sqlite3.Connection), cancel (Event | None),
      max_archives (int), max_seconds (float), report (mutated).
    Output: None.
    Example: _project_pass(conn, None, 1, 1.0, report)
    """
    from src.core.message_host_dimension import (
        LAYOUT_CLAUDE_PROJECTS, upsert_corpus, upsert_host,
    )
    from src.core.message_host_identity import capture_identity

    if not _model_present(conn):
        report.status = STATUS_MODEL_ABSENT
        report.reason = (
            "message_transcripts is absent, so the message model schema has "
            "never been applied on this datastore; the projection wrote "
            "nothing rather than creating a model the install did not ask for"
        )
        return

    ledger.ensure_ledger(conn)

    try:
        identity = capture_identity()
        corpus_row = conn.execute(
            "SELECT root_path FROM message_corpora WHERE corpus_key = ? "
            "ORDER BY id LIMIT 1", ("claude-projects",),
        ).fetchone()
        root_path = str(corpus_row[0]) if corpus_row else ""
        conn.execute("BEGIN IMMEDIATE")
        try:
            host_id = upsert_host(conn, identity)
            corpus_id = upsert_corpus(
                conn, host_id, "claude-projects", root_path or "", None,
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    except (sqlite3.Error, OSError, ValueError) as exc:
        report.status = STATUS_HOST_UNRESOLVED
        report.reason = (
            f"this machine could not be interned as a host "
            f"({type(exc).__name__}: {exc}), and a transcript with no host "
            "cannot be reached through the browser's rail, so nothing was "
            "projected"
        )
        return

    report.pending_before = ledger.pending_count(conn)
    pending = ledger.select_pending(conn, limit=max_archives)
    deadline = time.monotonic() + max_seconds
    spent = "queue_empty" if len(pending) < max_archives else "archives"

    for index, item in enumerate(pending):
        if cancel is not None and cancel.is_set():
            report.status = STATUS_CANCELLED
            spent = "cancelled"
            break
        if index and time.monotonic() >= deadline:
            spent = "seconds"
            break
        result = project_one(
            conn, item, host_id=host_id, corpus_id=corpus_id,
            corpus_key="claude-projects", machine_id=identity.machine_id,
            layout=LAYOUT_CLAUDE_PROJECTS,
        )
        outcome = str(result["outcome"])
        report.raw_bytes_read += item.raw_byte_length
        if outcome == ledger.OUTCOME_PROJECTED:
            report.projected += 1
            report.lines_written += int(result["lines"])
        elif outcome == ledger.OUTCOME_REPLACED:
            report.replaced += 1
            report.lines_written += int(result["lines"])
        elif outcome == ledger.OUTCOME_COULD_NOT_READ:
            report.could_not_read += 1
        else:
            report.could_not_ingest += 1
        if outcome in ledger.REFUSAL_OUTCOMES:
            report.refusals.append({
                "source_path": item.source_path,
                "outcome": outcome,
                "reason": str(result["reason"]),
            })
        conn.execute("BEGIN IMMEDIATE")
        try:
            ledger.record(
                conn, item, source_ref=str(result["source_ref"]),
                transcript_id=result["transcript_id"],
                line_count=int(result["lines"]), outcome=outcome,
                now=state_io.utc_now_iso(),
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise

    report.budget_spent = spent
    report.pending_after = ledger.pending_count(conn)



def _projection_connection(state_dir: Path):
    """Open the connection the projection writes through.

    Description: the archive AS MAIN when this install is split, so a
      long ingest transaction never holds cloude.db's write lock; the
      ordinary connection otherwise, because an unsplit install keeps
      the archive tables in cloude.db and there is no second file to
      open. The split case is the one that matters and the unsplit case
      is unchanged.
    Inputs: state_dir (Path).
    Output: sqlite3.Connection.
    Raises: DatastoreError - neither file could be opened.
    Example: _projection_connection(state_dir)
    """
    if archive_db_path_for(state_dir).exists():
        return connect_archive_only(state_dir)
    return connect(db_path_for(state_dir), create=False)

def _model_present(conn: sqlite3.Connection) -> bool:
    """Report whether the v16 message model's tables exist here.

    Description: a POSITIVE check on one table rather than a guess from
      the schema version, because the message model is applied out of
      band (``db_steps.apply_message_model_schema``) on installs that
      switched the archive on, so the version number cannot answer it.
    Inputs: conn (sqlite3.Connection).
    Output: bool.
    Example: _model_present(conn) -> True
    """
    # sqlite_master is PER SCHEMA: a bare read means main only and
    # answers No for a split install. See archive_db_attach.table_exists.
    return table_exists(conn, "message_transcripts")
