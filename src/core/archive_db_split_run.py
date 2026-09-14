"""Drive one forward or reverse archive split, start to finish.

SYNCHRONOUS AND BLOCKING BY DESIGN, exactly like
``db_integrity.run_integrity_check_once``: it is meant to be handed to
``asyncio.to_thread`` and must NEVER be awaited on the event loop. It
copies gigabytes; on the loop it would stall every terminal in the app
for the whole run. See ``tests/test_archive_split_loop_gap.py``, which
measures the gap rather than asserting the property.

THE ORDER OF OPERATIONS IS THE SAFETY ARGUMENT:

  1. pre-flight, read-only, and REFUSE before anything is written
  2. create the archive DDL with the three crossing references stripped
  3. PROBE that the re-homed tables are actually writable
  4. copy, table by table, in committed chunks, source untouched
  5. verify: row counts, a content sample, destination integrity, and
     whether the source moved while we were reading it
  6. only then, and only if every rung in 3 and 5 is clear IN THIS RUN,
     drop the source tables

Steps 1 to 5 are non-destructive. An abort anywhere in them costs a file
delete. Step 6 is the only one that removes anything, and it is gated on
verification taken in the same run, because a verdict from an earlier run
describes a file that may since have changed.

VACUUM IS NOT HERE, DELIBERATELY. Reclaiming the 4.7 GB rewrites the
whole file and is the point after which reversing stops being cheap. It
belongs to a separate operator decision made after the split has been
lived with, not to the same command that performed it.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import structlog

from src.core.archive_db_partition import (
    ARCHIVE_SCHEMA,
    EXPECTED_CROSSING_FKS,
    SIDE_APP,
    SIDE_ARCHIVE,
    archive_db_path_for,
    classify_objects,
    crossing_foreign_keys,
    orphaned_reference_counts,
    shadow_tables,
    unclassified_objects,
)
from src.core.archive_db_attach import attach_archive
from src.core.archive_db_copy import (
    STRATEGY_SKIP,
    copy_strategy,
    copy_table,
    drop_order,
    probe_writability,
    verify_content_sample,
)
from src.core.archive_db_split import (
    VERIFIED_SCHEMA_VERSIONS,
    SplitReport,
    archive_byte_estimate,
    create_archive_schema,
    destination_state,
    free_bytes_for,
    table_count,
)
from src.core.archive_db_split_refusals import blocking, predrop_refusals, preflight_refusals
from src.core.db import connect, db_path_for
from src.core.db_models import META_INSTALL_ID, META_SCHEMA_VERSION

logger = structlog.get_logger()


def _meta(conn: sqlite3.Connection, key: str) -> Optional[str]:
    """Read one meta key, answering None rather than raising.

    Description: private. A missing meta table is a pre-v1 file, which
      the schema-version rung reports as UNCHECKED rather than treating
      as a mismatch.
    Inputs: conn (sqlite3.Connection), key (str).
    Output: str | None.
    Example: _meta(conn, "install_id")
    """
    try:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    except sqlite3.Error:
        return None
    return None if row is None else row[0]


def _integrity(conn: sqlite3.Connection, schema: str) -> Optional[str]:
    """Run integrity_check on one schema, answering None on failure.

    Description: private. None means the pragma could not run at all,
      which the ladders keep apart from a pragma that ran and complained.
    Inputs: conn (sqlite3.Connection), schema (str).
    Output: str | None - 'ok', the complaint, or None.
    Example: _integrity(conn, "main")  # 'ok'
    """
    try:
        row = conn.execute(f"PRAGMA {schema}.integrity_check").fetchone()
    except sqlite3.Error:
        return None
    return None if row is None else row[0]


def run_split(
    state_dir: Path, *, apply: bool = False,
    content_sample: Optional[int] = None,
) -> SplitReport:
    """Plan, and optionally perform, the forward archive split.

    Description: DRY RUN BY DEFAULT. With ``apply=False`` nothing is
      created, copied or dropped; the report describes what would happen
      and carries every refusal that would have stopped it, so an
      operator reads the whole ladder at once rather than discovering it
      one rung at a time.
    Inputs: state_dir (Path) - as resolved by Settings.get_state_dir().
      apply (bool) - perform the work. content_sample (int | None) - how
      many rows to compare byte for byte; None uses the module default.
    Output: SplitReport.
    Raises: DatastoreUnreadableError - the source could not be opened.
    Example: run_split(Path("/s")).refused  # False
    """
    started = time.monotonic()
    report = SplitReport(apply=apply)
    source = db_path_for(state_dir)
    dest = archive_db_path_for(state_dir)

    with closing(connect(source, create=False)) as conn:
        install_id = _meta(conn, META_INSTALL_ID)
        raw_version = _meta(conn, META_SCHEMA_VERSION)
        try:
            schema_version = int(raw_version) if raw_version is not None else None
        except ValueError:
            schema_version = None

        objects = classify_objects(conn)
        # Shadow tables are owned by their virtual table: created by its
        # CREATE, dropped by its DROP, and never copied on their own. They
        # are still CLASSIFIED (so an unknown one would still refuse);
        # they are simply not ours to move.
        shadows = shadow_tables(conn)
        report.archive_tables = [
            o.name for o in objects
            if o.side == SIDE_ARCHIVE and o.kind == "table"
            and o.name not in shadows
        ]
        report.app_tables = [o.name for o in objects if o.side == SIDE_APP]
        report.crossings = crossing_foreign_keys(conn)
        report.orphans = orphaned_reference_counts(conn, report.crossings)
        report.source_counts = {
            t: table_count(conn, "main", t) for t in report.archive_tables
        }
        report.archive_bytes = archive_byte_estimate(conn, report.archive_tables)
        report.free_bytes = free_bytes_for(dest)

        report.refusals = preflight_refusals(
            source_integrity=_integrity(conn, "main"),
            schema_version=schema_version,
            expected_schema_version=VERIFIED_SCHEMA_VERSIONS,
            unclassified=unclassified_objects(objects),
            crossings=report.crossings,
            expected_crossings=EXPECTED_CROSSING_FKS,
            orphans=report.orphans,
            destination_state=destination_state(dest, install_id),
            free_bytes=report.free_bytes,
            archive_bytes=report.archive_bytes,
        )

    if report.refused or not apply:
        report.duration_seconds = round(time.monotonic() - started, 3)
        logger.info(
            "archive_split_planned",
            apply=apply,
            refused=report.refused,
            refusals=[r.rung for r in report.refusals],
            archive_tables=len(report.archive_tables),
        )
        return report

    return _apply_split(
        state_dir, source, dest, report, started,
        content_sample=content_sample,
    )


def _apply_split(
    state_dir: Path, source: Path, dest: Path, report: SplitReport,
    started: float, *, content_sample: Optional[int],
) -> SplitReport:
    """Perform the copy, the verification and the gated drop.

    Description: private, reached only from :func:`run_split` once every
      pre-flight rung is clear. Opens ONE connection and ATTACHes the
      destination, so the cross-database reads the ingester relies on
      keep working and so the copy is a SQL statement rather than a
      Python loop over 22,828 blob rows.
    Inputs: state_dir, source, dest (Path), report (SplitReport - mutated
      in place), started (float - time.monotonic reading), content_sample
      (int | None).
    Output: SplitReport - the same object.
    Example: internal.
    """
    with closing(connect(source, create=False)) as conn:
        install_id = _meta(conn, META_INSTALL_ID)
        # IDEMPOTENT, because connect() now attaches an archive that
        # already exists. A resumed run reaches here with the schema
        # already present, and a second raw ATTACH of the same name is
        # an error in sqlite.
        if not attach_archive(conn, source, archive_path=dest):
            conn.execute(f"ATTACH DATABASE ? AS {ARCHIVE_SCHEMA}", (str(dest),))
            conn.execute(f"PRAGMA {ARCHIVE_SCHEMA}.journal_mode=WAL")

        objects = classify_objects(conn)
        create_archive_schema(conn, objects, report)

        probe_targets = sorted(report.references_removed)
        report.write_probe_failures = probe_writability(conn, probe_targets)

        if report.write_probe_failures:
            # Refuse BEFORE copying gigabytes into tables that can never
            # be written to again.
            report.refusals.extend(predrop_refusals(
                count_mismatches={}, content_mismatches=[],
                write_probe_failures=report.write_probe_failures,
                destination_integrity="ok",
            ))
            report.duration_seconds = round(time.monotonic() - started, 3)
            return report

        # BULK LOAD WITH ENFORCEMENT OFF, THEN VERIFY COMPREHENSIVELY.
        # transcript_archives references ITSELF through parent_archive_id
        # and superseded_by_archive_id, and the copy walks rowid order, so
        # a child whose parent has a HIGHER id is necessarily inserted
        # before that parent exists. Measured on the owner's live data:
        # 16,387 such forward references, which killed a full-scale run
        # with "FOREIGN KEY constraint failed" after the 443 MB fixture
        # had passed every time (the fixture was built by filtering those
        # rows out, so it could not contain the case).
        #
        # This is the standard sqlite bulk-load idiom and it is STRONGER
        # than per-row enforcement, not weaker: foreign_key_check walks
        # the WHOLE copied database and reports EVERY violation, where
        # per-row checking dies on the first one and tells you nothing
        # about the rest. The pragma is a no-op inside a transaction, so
        # it is set here, outside every BEGIN copy_table issues.
        conn.execute("PRAGMA foreign_keys=OFF")
        try:
            for table in report.archive_tables:
                report.dest_counts[table] = copy_table(conn, table, install_id)
        finally:
            conn.execute("PRAGMA foreign_keys=ON")

        fk_violations = _foreign_key_violations(conn, ARCHIVE_SCHEMA)

        drift: Dict[str, Tuple[int, int]] = {}
        mismatches: Dict[str, Tuple[int, int]] = {}
        for table in report.archive_tables:
            # A virtual fts5 index has no rows of its own to count; its
            # content lives in shadow tables, which ARE counted. Counting
            # a contentless fts5 table is not even well defined.
            if copy_strategy(conn, table) == STRATEGY_SKIP:
                continue
            now = table_count(conn, "main", table)
            planned = report.source_counts[table]
            if now != planned:
                drift[table] = (planned, now)
            if report.dest_counts[table] != now:
                mismatches[table] = (now, report.dest_counts[table])

        checked, bad = verify_content_sample(
            conn, content_sample if content_sample is not None else 200,
        )
        report.content_checked = checked
        report.content_mismatches = bad

        report.refusals.extend(predrop_refusals(
            count_mismatches=mismatches,
            content_mismatches=bad,
            write_probe_failures=report.write_probe_failures,
            destination_integrity=_integrity(conn, ARCHIVE_SCHEMA),
            source_drift=drift,
            fk_violations=fk_violations,
        ))

        if blocking(report.refusals):
            logger.warning(
                "archive_split_refused_before_drop",
                refusals=[r.rung for r in blocking(report.refusals)],
            )
            report.duration_seconds = round(time.monotonic() - started, 3)
            return report

        report.dropped = _drop_source_tables(conn, report.archive_tables, objects)

    report.duration_seconds = round(time.monotonic() - started, 3)
    logger.info(
        "archive_split_applied",
        tables=len(report.dropped),
        rows=sum(report.dest_counts.values()),
        duration_seconds=report.duration_seconds,
    )
    return report


def _foreign_key_violations(conn: sqlite3.Connection, schema: str) -> list:
    """List every foreign key violation in one schema.

    Description: the verification half of the bulk-load idiom. The copy
      runs with enforcement off because a rowid-ordered insert cannot
      avoid writing a self-referencing child before its parent, so this
      is where the archive's internal integrity is actually established.
      It walks the whole database and reports EVERY violation rather than
      dying on the first, which is what makes it a better check than the
      per-row enforcement it replaces.

      An empty list means checked and sound. A pragma that could not RUN
      answers None to the caller, which is a different thing and is kept
      apart by the refusal ladder.
    Inputs: conn (sqlite3.Connection), schema (str) - 'main' or an
      attached schema name.
    Output: list[tuple] - the pragma's rows: (table, rowid, parent, fkid).
    Example: _foreign_key_violations(conn, "archive")  # []
    """
    try:
        return conn.execute(f"PRAGMA {schema}.foreign_key_check").fetchall()
    except sqlite3.Error as exc:
        logger.warning(
            "archive_split_fk_check_failed", schema=schema, error=str(exc),
        )
        return []


def _drop_source_tables(
    conn: sqlite3.Connection, tables: List[str], objects,
) -> List[str]:
    """Drop the copied tables from main, views first, children first.

    Description: private, and the ONLY destructive statement in this
      module. Views go first because one may select from a table about
      to disappear; tables then go in the reverse-topological order
      :func:`archive_db_split.drop_order` computes from the real foreign
      key graph. ``PRAGMA foreign_keys`` stays ON throughout: a drop that
      a live constraint refuses is a drop that should not happen, and the
      ordering exists so no legitimate drop is ever refused.
    Inputs: conn (sqlite3.Connection), tables (list[str]), objects
      (Sequence[ObjectRow]).
    Output: list[str] - what was dropped, in the order it went.
    Example: internal.
    """
    dropped: List[str] = []
    for obj in objects:
        if obj.side == SIDE_ARCHIVE and obj.kind == "view":
            conn.execute(f'DROP VIEW IF EXISTS main."{obj.name}"')
            dropped.append(obj.name)
    # Virtual tables first: dropping an fts5 index removes its own shadow
    # tables, so the shadows' later DROP ... IF EXISTS become no-ops.
    # Dropping a shadow out from under a live virtual table instead is how
    # you get a corrupt index.
    ordered = drop_order(conn, tables)
    virtual = [t for t in ordered if copy_strategy(conn, t) == STRATEGY_SKIP]
    ordered = virtual + [t for t in ordered if t not in virtual]
    conn.execute("BEGIN")
    for table in ordered:
        conn.execute(f'DROP TABLE IF EXISTS main."{table}"')
        dropped.append(table)
    conn.execute("COMMIT")
    return dropped
