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
from src.core.archive_db_partition import (
    ARCHIVE_SCHEMA,
    SIDE_ARCHIVE,
    shadow_tables,
)
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


def _qualify_create(sql: str, kind: str, name: str) -> Optional[str]:
    """Rewrite a CREATE statement to target the archive schema, or refuse.

    Description: handles the three spellings sqlite stores a name in -
      bare, "double quoted", and 'single quoted' - and returns None when
      none of them match rather than guessing. Refusing is the whole
      point: the guess it replaces created tables in the WRONG DATABASE.
    Inputs: sql (str) - the stored CREATE statement. kind (str) - 'table'
      or 'view'. name (str) - the object name.
    Output: str | None - the qualified statement, or None to refuse.
    Example: _qualify_create("CREATE TABLE t(a)", "table", "t")
      # 'CREATE TABLE archive.t(a)'
    """
    head = f"{kind.upper()} "
    if kind.lower() == "table" and "CREATE VIRTUAL TABLE" in sql.upper():
        head = "VIRTUAL TABLE "
    for spelling in (name, f'"{name}"', f"'{name}'", f"[{name}]", f"`{name}`"):
        needle = f"{head}{spelling}"
        if needle in sql:
            return sql.replace(
                needle, f'{head}{ARCHIVE_SCHEMA}."{name}"', 1
            )
    return None


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
    # Shadow tables belong to their virtual table and are built by its
    # CREATE. Emitting their DDL is what produced four junk tables with
    # literal dots in their names in a live database; see
    # archive_db_partition.shadow_tables.
    shadows = shadow_tables(conn)
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
        if obj.name in shadows or obj.name in existing:
            # Already created by an earlier run of this same migration.
            # The origin row above was refreshed, so the reverse still has
            # the exact pre-strip DDL; there is nothing else to do.
            continue
        qualified = _qualify_create(sql, obj.kind, obj.name)
        if qualified is None:
            # REFUSE rather than guess. The old fallback rewrote the first
            # bare occurrence of the name anywhere in the statement, which
            # on a quoted DDL produced CREATE TABLE 'archive.<name>' and
            # sqlite put it, unqualified, in MAIN. A statement this code
            # cannot confidently qualify must not be executed at all.
            raise sqlite3.OperationalError(
                f"cannot qualify the DDL for {obj.name!r} onto the "
                f"{ARCHIVE_SCHEMA} schema; refusing to execute it unqualified"
            )
        conn.execute(qualified)
