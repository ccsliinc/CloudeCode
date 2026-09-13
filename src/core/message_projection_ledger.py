"""The ledger that records which archive row each message transcript came from.

WHY A LEDGER AND NOT A COLUMN. ``message_transcripts`` is the v16 model's
own table and this projection is a SECOND producer for it, arriving years
after the first. Adding a column would make the model carry a fact about
a caller; a side table leaves the model exactly as it was and keeps the
projection's bookkeeping in one place a reader can delete without
touching anything the browser reads.

WHAT IT IS FOR, IN ONE SENTENCE: it is the evidence that lets a REPLACE
be a recorded decision rather than a silent overwrite. The v16 model
refuses a ``source_ref`` it has already stored, deliberately, "so that
nothing is ever silently overwritten" (see
:mod:`src.core.message_model_ingest`). That refusal is correct and is not
weakened here. What the ledger adds is the one fact the model cannot
hold: the ``content_sha256`` of the archive row a stored transcript was
derived from. A projection only replaces a transcript when the archive
layer has itself measured a DIFFERENT sha256 for that file - which is a
measurement somebody else took, not a guess this module made.

THE KEY IS ``source_path``, AND THAT IS AN INVARIANT WORTH STATING.
Measured on the owner's 2026-09-10 backup: among the 19,401 archive rows
with ``superseded_by_archive_id IS NULL`` the ``source_path`` is unique
19,401 times out of 19,401. One current archive per file, exactly. That
is what makes "one message transcript per file" true by construction
rather than by hope, and it is why the pending query can be a single
LEFT JOIN with no grouping.

SUPERSEDED ROWS ARE NOT PROJECTED, AND THE REASON IS NOT TIDINESS. The
archive layer replaces a superseded row's ``content_gzip`` with an
8-byte sentinel (measured: 3,427 superseded rows hold 27,416 bytes
between them), so a superseded row is storage bookkeeping about a file
whose current bytes live on its successor. Projecting the chain would
put every historical version of a grown transcript in the browser's rail
as its own conversation, which is not a thing the reader asked to see.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Dict, List, Optional

#: The one table this module owns. Created on demand rather than through
#: the schema chain: the projection runs only on an install that has the
#: message archive switched on, and the v16 tables it writes into are
#: themselves applied that way (``db_steps.apply_message_model_schema``).
#: Putting it in the numbered chain would create it on every install,
#: including the ones that will never hold a message model.
LEDGER_TABLE: str = "message_projection_ledger"

LEDGER_DDL: str = f"""
CREATE TABLE IF NOT EXISTS {LEDGER_TABLE} (
  source_path      TEXT PRIMARY KEY,
  source_ref       TEXT NOT NULL,
  archive_id       INTEGER NOT NULL,
  content_sha256   TEXT NOT NULL,
  transcript_id    INTEGER,
  line_count       INTEGER NOT NULL DEFAULT 0,
  raw_byte_length  INTEGER NOT NULL DEFAULT 0,
  outcome          TEXT NOT NULL,
  projected_at     TEXT NOT NULL
)
"""

#: THE INDEX THAT KEEPS BOTH QUERIES OFF THE TABLE, and it is not
#: optional. ``transcript_archives`` stores ``content_gzip`` INLINE, so
#: reaching into it for four small columns walks pages full of
#: compressed transcript. Measured on a writable copy of the owner's
#: 4.8 GB backup, 22,828 archive rows:
#:
#:   ================================  =========  ========
#:   query                             before     after
#:   ================================  =========  ========
#:   pending_count, ledger drained     529.76 ms  10.32 ms
#:   select_pending limit 64, drained  522.05 ms   9.87 ms
#:   pending_count, ledger empty        11.87 ms   1.66 ms
#:   select_pending limit 64, empty    530.06 ms   0.05 ms
#:   ================================  =========  ========
#:
#: The plan goes from SEARCH on the existing narrow
#: ``superseded_by_archive_id`` index plus a table fetch per candidate
#: plus ``USE TEMP B-TREE FOR ORDER BY``, to a single SEARCH USING
#: COVERING INDEX with no sort. Build cost 0.52s, once.
#:
#: THE COLUMN ORDER IS THE QUERY'S AND WAS ARRIVED AT BY MEASURING. A
#: PARTIAL index (``WHERE superseded_by_archive_id IS NULL``) leading on
#: ``ingested_at`` was tried first and the planner DID NOT CHOOSE IT -
#: it kept the existing narrow index and stayed at 530 ms, so the fix
#: read as no fix at all. Leading on the equality column gives the
#: planner a SEARCH it prefers, and the remaining columns ride along so
#: the index answers on its own. Never assume an index is used; read the
#: plan.
#:
#: It is created here rather than in the schema chain for the same
#: reason the ledger is: it belongs to this pass, and an install that
#: never projects should not carry it.
LEDGER_SCAN_INDEX: str = "ix_transcript_archives_projection_scan"

LEDGER_SCAN_INDEX_DDL: str = f"""
CREATE INDEX IF NOT EXISTS {LEDGER_SCAN_INDEX}
  ON transcript_archives (
    superseded_by_archive_id, ingested_at DESC, id DESC,
    source_path, content_sha256, raw_byte_length, record_count
  )
"""

#: Outcomes a ledger row may record. ``projected`` is a first write,
#: ``replaced`` is a write over a file the archive layer re-measured, and
#: ``could_not_read`` / ``could_not_ingest`` are REFUSALS that are still
#: recorded, so a file that cannot be projected is a named fact rather
#: than a row that silently never appears.
OUTCOME_PROJECTED: str = "projected"
OUTCOME_REPLACED: str = "replaced"
OUTCOME_COULD_NOT_READ: str = "could_not_read"
OUTCOME_COULD_NOT_INGEST: str = "could_not_ingest"

#: A refusal is recorded with the sha256 it refused, so the same broken
#: file is not retried on every pass forever; a CHANGED sha256 makes it
#: pending again, which is the retry a genuinely repaired file needs.
REFUSAL_OUTCOMES = frozenset({OUTCOME_COULD_NOT_READ, OUTCOME_COULD_NOT_INGEST})


@dataclass(frozen=True)
class PendingArchive:
    """One current archive row that has not been projected at its current bytes.

    - ``archive_id``: ``transcript_archives.id``.
    - ``source_path``: path relative to the corpus root, posix separators.
    - ``content_sha256``: the archive layer's own hash of the file bytes.
    - ``raw_byte_length``: uncompressed size, used to spend a byte budget.
    - ``record_count``: the archive layer's line count, for reporting only.
    - ``ingested_at``: when the archive layer stored these bytes. Becomes
      the projected transcript's ``ingested_at`` so the browser's
      newest-first ordering means what it says.
    - ``prior_outcome``: the ledger's verdict for this file at its
      PREVIOUS bytes, or None when the file has never been projected.
      This is what tells a caller a write will be a replace.
    """

    archive_id: int
    source_path: str
    content_sha256: str
    raw_byte_length: int
    record_count: int
    ingested_at: str
    prior_outcome: Optional[str] = None
    prior_transcript_id: Optional[int] = None


#: ONE query, and the budget is applied inside it. The alternative shape
#: - list every current archive, then ask the ledger about each - is
#: O(rows) sqlite round trips, which is the pattern this project has
#: already paid for twice (33 connections per listing pass, and the
#: per-row status seed read). Here the whole plan is one statement whose
#: result set is bounded by :limit.
_PENDING_SQL = f"""
SELECT a.id, a.source_path, a.content_sha256, a.raw_byte_length,
       a.record_count, a.ingested_at, l.outcome, l.transcript_id
  FROM transcript_archives a
  LEFT JOIN {LEDGER_TABLE} l ON l.source_path = a.source_path
 WHERE a.superseded_by_archive_id IS NULL
   AND (l.source_path IS NULL OR l.content_sha256 <> a.content_sha256)
 ORDER BY a.ingested_at DESC, a.id DESC
 LIMIT ?
"""

_PENDING_COUNT_SQL = f"""
SELECT COUNT(*)
  FROM transcript_archives a
  LEFT JOIN {LEDGER_TABLE} l ON l.source_path = a.source_path
 WHERE a.superseded_by_archive_id IS NULL
   AND (l.source_path IS NULL OR l.content_sha256 <> a.content_sha256)
"""


def ensure_ledger(conn: sqlite3.Connection) -> None:
    """Create the ledger table if this datastore does not carry it yet.

    Description: idempotent, and safe to call on every pass. It creates
      the ledger table AND the partial covering index on
      ``transcript_archives`` that the pending query needs - see
      :data:`LEDGER_SCAN_INDEX_DDL` for the measurement that makes the
      second one load-bearing rather than a nicety.
    Inputs: conn (sqlite3.Connection).
    Output: None.
    Raises: sqlite3.Error - the caller decides whether that is fatal.
    Example: ensure_ledger(conn)
    """
    conn.execute(LEDGER_DDL)
    conn.execute(LEDGER_SCAN_INDEX_DDL)


def select_pending(
    conn: sqlite3.Connection, *, limit: int,
) -> List[PendingArchive]:
    """List the current archives whose bytes are not in the message model.

    Description: "pending" means either never projected, or projected at
      a DIFFERENT ``content_sha256`` than the archive layer now holds.
      The second case is a file that grew, and it is the case the v16
      model cannot answer on its own. Newest archive first, so an install
      draining a large backlog shows the owner his recent conversations
      before his oldest ones.
    Inputs: conn (sqlite3.Connection, carrying both the archive tables
      and the ledger), limit (int, > 0 - the pass budget in archives).
    Output: list[PendingArchive], at most ``limit`` long.
    Raises: ValueError - limit is not positive, because a limit of zero
      that returned "nothing pending" would read exactly like a drained
      backlog.
    Example: select_pending(conn, limit=50)[0].source_path
      -> '-Users-x/abc.jsonl'
    """
    if limit <= 0:
        raise ValueError(f"limit must be positive, got {limit}")
    rows = conn.execute(_PENDING_SQL, (limit,)).fetchall()
    return [
        PendingArchive(
            archive_id=int(row[0]),
            source_path=str(row[1]),
            content_sha256=str(row[2]),
            raw_byte_length=int(row[3]),
            record_count=int(row[4]),
            ingested_at=str(row[5]),
            prior_outcome=row[6],
            prior_transcript_id=None if row[7] is None else int(row[7]),
        )
        for row in rows
    ]


def pending_count(conn: sqlite3.Connection) -> int:
    """Count every current archive still to be projected.

    Description: the backlog figure the status surface reports. It is a
      COUNT over one join of the current-archive set, not a walk, so it
      costs one statement whatever the backlog is.
    Inputs: conn (sqlite3.Connection).
    Output: int.
    Example: pending_count(conn) -> 19401
    """
    return int(conn.execute(_PENDING_COUNT_SQL).fetchone()[0])


def record(
    conn: sqlite3.Connection, pending: PendingArchive, *, source_ref: str,
    transcript_id: Optional[int], line_count: int, outcome: str,
    now: str,
) -> None:
    """Write this file's projection verdict, replacing any earlier one.

    Description: one row per FILE, always at the file's current bytes.
      The replace is the point: the ledger answers "what is in the model
      for this file right now", never "what has ever been in it". A
      refusal is recorded exactly as a success is, so a file that cannot
      be projected stops being retried on every pass while a file whose
      bytes then change becomes pending again by itself.
    Inputs: conn, pending (PendingArchive), source_ref (str - the
      globally unique locator stored on message_transcripts), the
      resulting transcript_id (int or None for a refusal), line_count
      (int), outcome (str - one of the OUTCOME_* constants), now (str -
      ISO-8601).
    Output: None.
    Raises: ValueError - an outcome this module does not define, because
      an unrecognised verdict in a ledger is a verdict nobody can read.
    Example: record(conn, p, source_ref="M::c::a.jsonl", transcript_id=1,
      line_count=7, outcome=OUTCOME_PROJECTED, now="2026-01-01T00:00:00Z")
    """
    if outcome not in _ALL_OUTCOMES:
        raise ValueError(f"unknown projection outcome: {outcome!r}")
    conn.execute(
        f"INSERT INTO {LEDGER_TABLE} "
        "(source_path, source_ref, archive_id, content_sha256, "
        " transcript_id, line_count, raw_byte_length, outcome, projected_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(source_path) DO UPDATE SET "
        " source_ref = excluded.source_ref, "
        " archive_id = excluded.archive_id, "
        " content_sha256 = excluded.content_sha256, "
        " transcript_id = excluded.transcript_id, "
        " line_count = excluded.line_count, "
        " raw_byte_length = excluded.raw_byte_length, "
        " outcome = excluded.outcome, "
        " projected_at = excluded.projected_at",
        (pending.source_path, source_ref, pending.archive_id,
         pending.content_sha256, transcript_id, line_count,
         pending.raw_byte_length, outcome, now),
    )


_ALL_OUTCOMES = frozenset({
    OUTCOME_PROJECTED, OUTCOME_REPLACED,
    OUTCOME_COULD_NOT_READ, OUTCOME_COULD_NOT_INGEST,
})


def ledger_summary(conn: sqlite3.Connection) -> Dict[str, int]:
    """Count ledger rows by outcome, plus the outstanding backlog.

    Description: the numbers the status endpoint renders. Refusals are
      counted separately from successes on purpose: a projection that
      reported only "12,000 done" while 300 files refused would be the
      false green this codebase keeps naming.
    Inputs: conn (sqlite3.Connection).
    Output: dict[str, int] - one key per outcome seen, plus 'pending'
      and 'total'.
    Example: ledger_summary(conn)['pending'] -> 0
    """
    summary: Dict[str, int] = {}
    for outcome, count in conn.execute(
        f"SELECT outcome, COUNT(*) FROM {LEDGER_TABLE} GROUP BY outcome"
    ):
        summary[str(outcome)] = int(count)
    summary["total"] = sum(summary.values())
    summary["pending"] = pending_count(conn)
    return summary
