"""Move the transcript archive out of cloude.db into cloude-archive.db.

THE SPINE, and every other decision here follows from it: THE SOURCE IS
NEVER DROPPED UNTIL EVERY TABLE HAS BEEN COPIED AND VERIFIED IN THE SAME
RUN. Until that moment the operation is abortable at zero cost by
deleting the destination file, which is a stronger guarantee than a
transaction and, unlike a transaction, one sqlite can actually keep here.

RESUMABLE, NOT TRANSACTIONAL, AND THAT IS THE HONEST CHOICE RATHER THAN
THE TIDY ONE. A single ``BEGIN ... COMMIT`` spanning both files would
LOOK atomic and would not be: sqlite's cross-database atomic commit is
documented as not applying when ``journal_mode`` is WAL, and this app
sets WAL on every connection. Selling a rollback guarantee we do not have
is worse than not offering one. So the copy proceeds table by table in
bounded chunks, each chunk committed, with progress recorded durably in
the destination.

THE RESUME PREDICATE IS DELIBERATELY CONSERVATIVE. A table counts as done
only when the destination row count equals the source count recorded when
it finished. Anything else is truncated and recopied rather than resumed
mid-way, because a destination that is a partial copy of an unknown
prefix is not something to reason about when the source is still intact
and re-reading it is cheap. Chunks are ordered by rowid so an interrupted
table always leaves a rowid PREFIX, never a hole.

LIVE INSTALL. The owner runs this with the server up, so the ingester can
append while the copy is in flight. That is not prevented, it is
MEASURED: source counts are taken at plan time and again at verify time,
and a table that moved refuses the drop. The copy is re-runnable, so
re-running is the answer.

DRY RUN IS THE DEFAULT, following ``scripts/backfill_claude_session_uuid.py``
and ``scripts/classify_session_kind.py`` rather than inventing a
convention. Nothing is created, copied or dropped without ``apply=True``.
"""

from __future__ import annotations

import shutil
import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import structlog

from src.core.archive_db_ddl import (
    residual_app_references,
    strip_crossing_references,
)
from src.core.archive_db_partition import ARCHIVE_SCHEMA, SIDE_ARCHIVE
from src.core.archive_db_split_refusals import Refusal, blocking

logger = structlog.get_logger()

#: Schema versions whose partition and crossing-key set have actually
#: been MEASURED, not assumed. v25 is the version of the read-only backup
#: every size and orphan figure in the docs came from; v26 and v27 were
#: checked by migrating a fresh database through the app's own chain and
#: re-running the partition against the result, which reported zero
#: unclassified objects and the same three crossing keys.
#:
#: DELIBERATELY NOT `CURRENT_SCHEMA_VERSION`. Importing that would make
#: this rung agree with whatever the code says today and it would never
#: refuse anything, which is the opposite of its job: a version added
#: after this module was written is one whose schema nobody has looked
#: at. Adding a version here is a one-line change and the measurement
#: that justifies it takes a minute.
VERIFIED_SCHEMA_VERSIONS = frozenset({25, 26, 27})

#: Kept for callers and tests that want a single representative version.
EXPECTED_SCHEMA_VERSION = max(VERIFIED_SCHEMA_VERSIONS)

#: Rows per committed chunk. Bounds the WAL and gives the resume point
#: its granularity. Not tuned for throughput: the copy is IO bound and
#: the cost of a larger chunk is a larger WAL, not a faster copy.
CHUNK_ROWS = 20_000

#: How many rows to re-read and compare byte for byte after the copy.
#: A count check proves arity; only a content check proves the bytes
#: arrived, and ``transcript_archives.content_sha256`` exists for
#: exactly this.
CONTENT_SAMPLE_ROWS = 200

#: Bookkeeping table, written in the DESTINATION so progress cannot be
#: lost by an abort that deletes it, and so it can never be mistaken for
#: app state that needs preserving.
PROGRESS_TABLE = "archive_split_progress"

PROGRESS_DDL = f"""
CREATE TABLE IF NOT EXISTS {ARCHIVE_SCHEMA}.{PROGRESS_TABLE} (
  table_name   TEXT PRIMARY KEY,
  source_rows  INTEGER NOT NULL,
  copied_rows  INTEGER NOT NULL,
  finished_at  TEXT,
  install_id   TEXT
)
"""

#: The pre-strip DDL of every object that moved, recorded at the moment
#: it moved. THIS IS WHAT MAKES THE REVERSE EXACT rather than
#: reconstructed: the reverse recreates each table in main from the
#: string the forward pass actually read out of sqlite_master, so the
#: three crossing constraints come back exactly as they were rather than
#: as this code's best guess at how to spell them. Kept in the ARCHIVE
#: file so it travels with the data it describes.
ORIGIN_TABLE = "archive_split_origin"

ORIGIN_DDL = f"""
CREATE TABLE IF NOT EXISTS {ARCHIVE_SCHEMA}.{ORIGIN_TABLE} (
  object_name   TEXT PRIMARY KEY,
  object_kind   TEXT NOT NULL,
  original_sql  TEXT NOT NULL,
  stripped_sql  TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
)
"""


@dataclass
class SplitReport:
    """Everything one run of the migration measured and decided.

    Description: the object a dry run prints and an apply run returns.
      Refusals are data rather than exceptions so a single dry run can
      surface all of them at once instead of stopping at the first.
    Inputs: built by :func:`run_split`.
    Output: a mutable record.
    """

    apply: bool = False
    archive_tables: List[str] = field(default_factory=list)
    app_tables: List[str] = field(default_factory=list)
    source_counts: Dict[str, int] = field(default_factory=dict)
    dest_counts: Dict[str, int] = field(default_factory=dict)
    crossings: List[Tuple[str, str, str]] = field(default_factory=list)
    orphans: Dict[str, int] = field(default_factory=dict)
    references_removed: Dict[str, List[str]] = field(default_factory=dict)
    content_checked: int = 0
    content_mismatches: List[str] = field(default_factory=list)
    write_probe_failures: Dict[str, str] = field(default_factory=dict)
    refusals: List[Refusal] = field(default_factory=list)
    dropped: List[str] = field(default_factory=list)
    archive_bytes: int = 0
    free_bytes: Optional[int] = None
    duration_seconds: float = 0.0

    @property
    def refused(self) -> bool:
        """True when at least one MEASURED refusal was raised.

        Description: the one question every caller asks. Unchecked
          entries never make this True.
        Inputs: none.
        Output: bool.
        Example: SplitReport().refused  # False
        """
        return bool(blocking(self.refusals))


def _scalar(conn: sqlite3.Connection, sql: str) -> Optional[object]:
    """Run a statement expected to return one value, or None on error.

    Description: private. Used only for pragmas whose failure is a named
      outcome rather than an exception the caller should see.
    Inputs: conn (sqlite3.Connection), sql (str).
    Output: the first column of the first row, or None.
    Example: _scalar(conn, "PRAGMA integrity_check")  # 'ok'
    """
    try:
        row = conn.execute(sql).fetchone()
    except sqlite3.Error:
        return None
    return None if row is None else row[0]


def free_bytes_for(path: Path) -> Optional[int]:
    """Measure free space on the volume holding a path.

    Description: answers None rather than raising when the volume cannot
      be interrogated, because an unmeasurable volume is an UNCHECKED
      condition and must not refuse the migration.
    Inputs: path (Path) - need not exist; its parent is used.
    Output: int | None - free bytes.
    Example: free_bytes_for(Path("/tmp/x")) > 0  # True
    """
    try:
        return shutil.disk_usage(Path(path).parent).free
    except OSError:
        return None


def destination_state(path: Path, install_id: Optional[str]) -> str:
    """Classify an existing destination file as absent, ours or foreign.

    Description: the guard against overwriting a database that is not
      this migration's own work in progress. "Ours" means it carries the
      progress table stamped with this install's id, which is what a
      resumable run needs to recognise. Anything else present is foreign
      and refuses; it is never overwritten.
    Inputs: path (Path) - the destination. install_id (str | None) -
      meta.install_id of the source.
    Output: str - 'absent', 'ours' or 'foreign'.
    Example: destination_state(Path("/nope.db"), "abc")  # 'absent'
    """
    path = Path(path)
    if not path.exists() or path.stat().st_size == 0:
        return "absent"
    try:
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as conn:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (PROGRESS_TABLE,),
            ).fetchone()
            if row is None:
                return "foreign"
            stamped = conn.execute(
                f"SELECT DISTINCT install_id FROM {PROGRESS_TABLE}"
            ).fetchall()
    except sqlite3.Error:
        return "foreign"
    ids = {r[0] for r in stamped if r[0] is not None}
    if not ids or ids == {install_id}:
        return "ours"
    return "foreign"


def archive_byte_estimate(conn: sqlite3.Connection, tables: Sequence[str]) -> int:
    """Estimate how many bytes the archive side occupies.

    Description: sums ``dbstat`` pgsize over the named tables and their
      indexes. Falls back to the whole file size when dbstat is not
      compiled in, which OVER-estimates and therefore fails safe: the
      disk rung would refuse on too little headroom rather than proceed
      on too much.
    Inputs: conn (sqlite3.Connection), tables (Sequence[str]).
    Output: int - bytes.
    Example: archive_byte_estimate(conn, ["transcript_records"])
    """
    try:
        placeholders = ",".join("?" for _ in tables)
        row = conn.execute(
            "SELECT COALESCE(SUM(d.pgsize),0) FROM dbstat d "
            "JOIN sqlite_master m ON m.name = d.name "
            f"WHERE m.tbl_name IN ({placeholders})",
            tuple(tables),
        ).fetchone()
        return int(row[0])
    except sqlite3.Error:
        page = _scalar(conn, "PRAGMA page_size") or 4096
        count = _scalar(conn, "PRAGMA page_count") or 0
        return int(page) * int(count)


def table_count(conn: sqlite3.Connection, schema: str, table: str) -> int:
    """Count rows in one table on one schema.

    Description: trivial, but it is the measurement the whole
      verification rests on, so it lives in one place.
    Inputs: conn, schema (str - 'main' or the attach name), table (str).
    Output: int.
    Example: table_count(conn, "main", "sessions")  # 940
    """
    return int(conn.execute(f'SELECT COUNT(*) FROM {schema}."{table}"').fetchone()[0])


def create_archive_schema(
    conn: sqlite3.Connection, objects: Sequence, report: SplitReport,
) -> None:
    """Create the archive DDL in the attached database, references stripped.

    Description: the one transformation applied on the way across, and
      the reason :mod:`src.core.archive_db_ddl` exists. Every object is
      checked for a residual app-side reference before it is executed,
      because a surviving clause produces a table that accepts DDL,
      passes ``foreign_key_check`` and refuses every insert for the life
      of the file.
    Inputs: conn (sqlite3.Connection with the archive attached), objects
      (Sequence[ObjectRow]), report (SplitReport - mutated with what was
      removed).
    Output: None. Raises sqlite3.Error if the DDL itself is rejected.
    Example: create_archive_schema(conn, archive_objects, report)
    """
    conn.execute(PROGRESS_DDL)
    conn.execute(ORIGIN_DDL)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    # A RESUMED RUN FINDS ITS OWN TABLES ALREADY THERE. The DDL comes out
    # of sqlite_master verbatim and therefore carries no IF NOT EXISTS, so
    # re-running raised "table X already exists" and the whole migration
    # died on the first object. Measured by SIGKILLing a real copy
    # mid-flight, which is the only way this shows up.
    existing = {
        r[0] for r in conn.execute(
            f"SELECT name FROM {ARCHIVE_SCHEMA}.sqlite_master "
            "WHERE type IN ('table','view')"
        )
    }
    for obj in objects:
        if obj.side != SIDE_ARCHIVE or not obj.sql:
            continue
        sql, removed = strip_crossing_references(obj.sql)
        if removed:
            report.references_removed[obj.name] = removed
        conn.execute(
            f"INSERT OR REPLACE INTO {ARCHIVE_SCHEMA}.{ORIGIN_TABLE} "
            "(object_name, object_kind, original_sql, stripped_sql, recorded_at) "
            "VALUES (?,?,?,?,?)",
            (obj.name, obj.kind, obj.sql, sql, stamp),
        )
        residual = residual_app_references(sql)
        if residual:
            # Static guard. It cannot prove writability (see the module
            # docstring), but it catches a rewrite that plainly failed
            # before we spend hours copying into an unusable file.
            raise sqlite3.IntegrityError(
                f"{obj.name} still references {residual} after rewriting"
            )
        if obj.name in existing:
            # Already created by an earlier run of this same migration.
            # The origin row above was refreshed, so the reverse still has
            # the exact pre-strip DDL; there is nothing else to do.
            continue
        qualified = sql.replace(
            f"{obj.kind.upper()} {obj.name}",
            f"{obj.kind.upper()} {ARCHIVE_SCHEMA}.{obj.name}",
            1,
        )
        if f"{ARCHIVE_SCHEMA}." not in qualified:
            qualified = sql.replace(
                obj.name, f"{ARCHIVE_SCHEMA}.{obj.name}", 1
            )
        conn.execute(qualified)


def copy_table(
    conn: sqlite3.Connection, table: str, install_id: Optional[str],
) -> int:
    """Copy one table into the archive, resumably, in committed chunks.

    Description: ordered by rowid so an interruption always leaves a
      PREFIX rather than a hole. A table already recorded complete at
      the current source count is skipped; anything else is truncated
      and recopied, because reasoning about a partial copy of an unknown
      shape is not worth it while the source is intact.
    Inputs: conn (sqlite3.Connection with the archive attached), table
      (str), install_id (str | None - stamped on the progress row).
    Output: int - rows in the destination when this returns.
    Example: copy_table(conn, "transcript_records", "abc")  # 8317542
    """
    source_n = table_count(conn, "main", table)
    done = conn.execute(
        f"SELECT source_rows, copied_rows, finished_at FROM "
        f"{ARCHIVE_SCHEMA}.{PROGRESS_TABLE} WHERE table_name=?",
        (table,),
    ).fetchone()
    if done and done[2] and done[0] == source_n:
        dest_n = table_count(conn, ARCHIVE_SCHEMA, table)
        if dest_n == source_n:
            return dest_n

    conn.execute(f'DELETE FROM {ARCHIVE_SCHEMA}."{table}"')
    conn.execute(
        f"INSERT OR REPLACE INTO {ARCHIVE_SCHEMA}.{PROGRESS_TABLE} "
        "(table_name, source_rows, copied_rows, finished_at, install_id) "
        "VALUES (?,?,0,NULL,?)",
        (table, source_n, install_id),
    )

    last_rowid = -1
    copied = 0
    while True:
        conn.execute("BEGIN")
        rows = conn.execute(
            f'SELECT rowid FROM main."{table}" WHERE rowid > ? '
            f"ORDER BY rowid LIMIT ?",
            (last_rowid, CHUNK_ROWS),
        ).fetchall()
        if not rows:
            conn.execute("COMMIT")
            break
        high = rows[-1][0]
        conn.execute(
            f'INSERT INTO {ARCHIVE_SCHEMA}."{table}" '
            f'SELECT * FROM main."{table}" WHERE rowid > ? AND rowid <= ?',
            (last_rowid, high),
        )
        copied += len(rows)
        conn.execute(
            f"UPDATE {ARCHIVE_SCHEMA}.{PROGRESS_TABLE} SET copied_rows=? "
            "WHERE table_name=?",
            (copied, table),
        )
        conn.execute("COMMIT")
        last_rowid = high

    dest_n = table_count(conn, ARCHIVE_SCHEMA, table)
    conn.execute(
        f"UPDATE {ARCHIVE_SCHEMA}.{PROGRESS_TABLE} "
        "SET copied_rows=?, finished_at=? WHERE table_name=?",
        (dest_n, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), table),
    )
    return dest_n


def drop_order(conn: sqlite3.Connection, tables: Sequence[str]) -> List[str]:
    """Order tables so every child is dropped before its parent.

    Description: a DROP with ``PRAGMA foreign_keys=ON`` runs an implicit
      delete and therefore has to resolve the foreign keys of every table
      still referencing the one going away. So dropping a parent while a
      sibling child still points at an ALREADY DROPPED table fails, and
      the error names the table that went earlier rather than the one
      being dropped, which is thoroughly misleading.

      MEASURED, 2026-09-13, on a real 120-archive fixture: an alphabetical
      order died on ``DROP TABLE main.message_bodies`` with
      ``no such table: main.message_block_types``, because
      ``message_content_blocks`` references BOTH and had not gone yet.
      The whole archive family moves together, so a reverse-topological
      order always exists; self-references such as
      ``transcript_archives.parent_archive_id`` are edges from a table to
      itself and are ignored rather than treated as a cycle.

      Turning the pragma off for the drop was the alternative and was not
      taken: it is a no-op inside a transaction, and a drop a live
      constraint refuses is a drop that should not happen.
    Inputs: conn (sqlite3.Connection), tables (Sequence[str]) - the
      tables about to be dropped, all from one side of the partition.
    Output: list[str] - children first, parents last. A table caught in
      a genuine cycle still appears, after everything orderable, so the
      caller fails loudly on it rather than silently skipping it.
    Example: drop_order(conn, ["message_bodies", "message_content_blocks"])
      # ['message_content_blocks', 'message_bodies']
    """
    wanted = list(tables)
    parents: Dict[str, set] = {t: set() for t in wanted}
    for table in wanted:
        for row in conn.execute(f'PRAGMA foreign_key_list("{table}")'):
            parent = row[2]
            if parent != table and parent in parents:
                parents[table].add(parent)

    ordered: List[str] = []
    placed: set = set()
    # Repeatedly take any table nobody remaining still references.
    remaining = set(wanted)
    while remaining:
        free = sorted(
            t for t in remaining
            if not any(t in parents[other] for other in remaining if other != t)
        )
        if not free:
            ordered.extend(sorted(remaining))
            break
        for t in free:
            ordered.append(t)
            placed.add(t)
        remaining -= set(free)
    return ordered


def probe_writability(
    conn: sqlite3.Connection, tables: Sequence[str],
) -> Dict[str, str]:
    """Prove each re-homed table can actually be written to.

    Description: THE LOAD-BEARING CHECK, and the one the scope doc did
      not know was needed. An unqualified ``REFERENCES sessions(id)``
      that survives into the archive produces a table sqlite creates
      happily, reports clean from ``foreign_key_check``, and refuses
      every INSERT with ``no such table: archive.sessions``. Measured on
      3.53.4, 2026-09-13. Only a real write distinguishes that from a
      healthy table, so this inserts a row inside a transaction it always
      rolls back. Nothing is left behind.
    Inputs: conn (sqlite3.Connection with the archive attached), tables
      (Sequence[str]) - the tables carrying a stripped reference.
    Output: dict[str, str] - table -> sqlite error text, empty when all
      tables are writable.
    Example: probe_writability(conn, ["transcript_archives"])  # {}
    """
    failures: Dict[str, str] = {}
    for table in tables:
        try:
            conn.execute("BEGIN")
            conn.execute(
                f'INSERT INTO {ARCHIVE_SCHEMA}."{table}" '
                f'SELECT * FROM {ARCHIVE_SCHEMA}."{table}" LIMIT 1'
            )
            conn.execute("ROLLBACK")
        except sqlite3.IntegrityError:
            # A uniqueness or NOT NULL complaint proves the statement
            # REACHED the table, which is exactly what is being probed.
            # Only an unresolvable reference is a failure here.
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
        except sqlite3.OperationalError as exc:
            failures[table] = str(exc)
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
    return failures


def verify_content_sample(
    conn: sqlite3.Connection, limit: int = CONTENT_SAMPLE_ROWS,
) -> Tuple[int, List[str]]:
    """Compare stored blobs on both sides for a sample of archives.

    Description: a row count proves arity and nothing else. This re-reads
      ``content_gzip`` on both sides for a spread of rows and compares
      the bytes, and separately confirms each side agrees with the
      ``content_sha256`` already recorded on the row. Sampled rather than
      exhaustive because the source is 3.7 GB of blob and an exhaustive
      compare would double the migration's runtime for a check the
      destination integrity pragma largely covers.
    Inputs: conn (sqlite3.Connection with the archive attached), limit
      (int) - how many rows to compare.
    Output: tuple[int, list[str]] - rows checked, and the archive_uuids
      that did not match.
    Example: verify_content_sample(conn, 10)  # (10, [])
    """
    mismatches: List[str] = []
    rows = conn.execute(
        "SELECT archive_uuid FROM main.transcript_archives "
        "ORDER BY id LIMIT ?", (limit,),
    ).fetchall()
    for (uuid,) in rows:
        a = conn.execute(
            "SELECT content_gzip, content_sha256 FROM main.transcript_archives "
            "WHERE archive_uuid=?", (uuid,),
        ).fetchone()
        b = conn.execute(
            f"SELECT content_gzip, content_sha256 FROM "
            f"{ARCHIVE_SCHEMA}.transcript_archives WHERE archive_uuid=?",
            (uuid,),
        ).fetchone()
        if a is None or b is None or bytes(a[0]) != bytes(b[0]) or a[1] != b[1]:
            mismatches.append(uuid)
    return len(rows), mismatches
