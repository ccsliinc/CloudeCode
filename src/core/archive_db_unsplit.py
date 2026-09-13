"""Put the transcript archive back inside cloude.db.

WRITTEN AND TESTED IN THE SAME CHANGE AS THE FORWARD SPLIT, because a
one-way migration on a live install with 19 sessions and five gigabytes
of irreplaceable-adjacent data is a much bigger ask than a two-way one,
and "we will write the reverse if we ever need it" is how a two-way door
quietly becomes a one-way door.

WHAT REVERSIBILITY ACTUALLY COSTS, stated in three tiers rather than
flattened into the word "reversible":

  BEFORE THE DROP   free. The source tables are still in cloude.db and
                    the destination is a file nobody depends on yet.
                    Aborting is deleting that file. This covers the whole
                    multi-hour copy, which is where the risk-time is.
  AFTER THE DROP,   cheap. This module. The space in cloude.db was never
  BEFORE VACUUM     reclaimed, so the pages are reused rather than
                    re-allocated.
  AFTER VACUUM      a full rewrite, and it needs the disk back. This is
                    why VACUUM is a separate operator command and not
                    part of the migration: it is the point after which
                    reversing stops being cheap, and it deserves its own
                    decision made after the split has been lived with.

THE REVERSE IS WHERE THE GIVEN-UP GUARANTEE IS COLLECTED. The forward
split turns three enforced foreign keys into plain INTEGER columns. This
module recreates them as REAL CONSTRAINTS, from the pre-strip DDL the
forward pass recorded verbatim in ``archive_split_origin``, so they come
back exactly as they were rather than as this code's best guess at how to
spell them. If any of the 4,667 populated references has been orphaned
while the databases were apart, the copy back FAILS LOUDLY at insert
time. That is a feature: it is the integrity check the split gave up, run
once, at the only moment anyone would want the answer.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Tuple

import structlog

from src.core.archive_db_partition import (
    ARCHIVE_SCHEMA,
    SIDE_ARCHIVE,
    archive_db_path_for,
    classify_objects,
)
from src.core.archive_db_split import (
    ORIGIN_TABLE,
    PROGRESS_TABLE,
    drop_order,
    table_count,
)
from src.core.db import connect, db_path_for

logger = structlog.get_logger()

#: Bookkeeping tables the forward pass created in the archive. They
#: describe the migration rather than the data, so they do NOT travel
#: back into cloude.db.
BOOKKEEPING = (PROGRESS_TABLE, ORIGIN_TABLE)

ORIGIN_MISSING = "origin_record_missing"
TABLE_ALREADY_IN_MAIN = "table_already_in_main"
COUNT_MISMATCH = "row_count_mismatch"
ORPHANED_REFERENCE = "orphaned_reference_blocks_constraint"
ARCHIVE_UNREADABLE = "archive_unreadable"


@dataclass
class UnsplitReport:
    """What one reverse run measured and did.

    Description: the mirror of
      :class:`src.core.archive_db_split.SplitReport`, deliberately the
      same shape so an operator reads one format for both directions.
    Inputs: built by :func:`run_unsplit`.
    Output: a mutable record.
    """

    apply: bool = False
    tables: List[str] = field(default_factory=list)
    restored_counts: Dict[str, int] = field(default_factory=dict)
    constraints_restored: Dict[str, List[str]] = field(default_factory=dict)
    refusals: List[Tuple[str, str]] = field(default_factory=list)
    duration_seconds: float = 0.0

    @property
    def refused(self) -> bool:
        """True when any refusal was raised.

        Description: the reverse has no unchecked/measured split because
          every one of its rungs is a direct reading.
        Inputs: none.
        Output: bool.
        Example: UnsplitReport().refused  # False
        """
        return bool(self.refusals)


def run_unsplit(state_dir: Path, *, apply: bool = False) -> UnsplitReport:
    """Plan, and optionally perform, the reverse of the archive split.

    Description: DRY RUN BY DEFAULT, matching the forward direction and
      the two backfill scripts already in ``scripts/``. Reads the
      pre-strip DDL out of ``archive_split_origin`` so the three crossing
      foreign keys return as enforced constraints rather than as plain
      columns, then copies the rows back under those constraints.
    Inputs: state_dir (Path) - as resolved by Settings.get_state_dir().
      apply (bool) - perform the work.
    Output: UnsplitReport.
    Raises: DatastoreUnreadableError - cloude.db could not be opened.
    Example: run_unsplit(Path("/s")).refused  # False
    """
    started = time.monotonic()
    report = UnsplitReport(apply=apply)
    source = db_path_for(state_dir)
    archive = archive_db_path_for(state_dir)

    if not archive.exists():
        report.refusals.append((
            ARCHIVE_UNREADABLE,
            f"no archive database at {archive}; there is nothing to reverse",
        ))
        return report

    with closing(connect(source, create=False)) as conn:
        conn.execute(f"ATTACH DATABASE ? AS {ARCHIVE_SCHEMA}", (str(archive),))
        try:
            origin = {
                r[0]: (r[1], r[2])
                for r in conn.execute(
                    f"SELECT object_name, object_kind, original_sql "
                    f"FROM {ARCHIVE_SCHEMA}.{ORIGIN_TABLE}"
                )
            }
        except sqlite3.Error as exc:
            report.refusals.append((
                ORIGIN_MISSING,
                f"the archive carries no {ORIGIN_TABLE} record ({exc}), so the "
                "original DDL is unknown; reversing would mean guessing how "
                "the three crossing constraints were spelled",
            ))
            return report

        archive_objects = [
            o for o in classify_objects(conn, ARCHIVE_SCHEMA)
            if o.name not in BOOKKEEPING
        ]
        report.tables = [
            o.name for o in archive_objects
            if o.kind == "table" and o.side == SIDE_ARCHIVE
        ]

        in_main = {
            r[0] for r in conn.execute(
                "SELECT name FROM main.sqlite_master WHERE type IN ('table','view')"
            )
        }
        clash = sorted(set(report.tables) & in_main)
        if clash:
            report.refusals.append((
                TABLE_ALREADY_IN_MAIN,
                f"cloude.db already holds {clash}; the reverse will not write "
                "over tables it did not put there",
            ))
            return report

        missing = sorted(t for t in report.tables if t not in origin)
        if missing:
            report.refusals.append((
                ORIGIN_MISSING,
                f"no recorded original DDL for {missing}",
            ))
            return report

        if not apply:
            report.duration_seconds = round(time.monotonic() - started, 3)
            return report

        _apply_unsplit(conn, report, origin, archive_objects)

    report.duration_seconds = round(time.monotonic() - started, 3)
    logger.info(
        "archive_unsplit_applied",
        tables=len(report.restored_counts),
        refused=report.refused,
    )
    return report


def _apply_unsplit(
    conn: sqlite3.Connection, report: UnsplitReport,
    origin: Dict[str, Tuple[str, str]], archive_objects,
) -> None:
    """Recreate the tables in main under their original constraints and copy back.

    Description: private. Creates PARENTS FIRST (the reverse of the drop
      order) so a child's foreign key always has something to point at,
      then copies in the same order for the same reason. The copy runs
      with ``PRAGMA foreign_keys=ON`` inherited from the connection, which
      is the whole point: an orphaned crossing reference raises here.
    Inputs: conn (sqlite3.Connection with the archive attached), report
      (UnsplitReport - mutated), origin (dict of name -> (kind, sql)),
      archive_objects (Sequence[ObjectRow]).
    Output: None.
    Example: internal.
    """
    creation_order = list(reversed(drop_order(conn, report.tables)))

    for name in creation_order:
        kind, sql = origin[name]
        conn.execute(sql)
        removed = [
            row[2] for row in conn.execute(f'PRAGMA main.foreign_key_list("{name}")')
        ]
        if removed:
            report.constraints_restored[name] = sorted(set(removed))

    for name in creation_order:
        try:
            conn.execute("BEGIN")
            conn.execute(
                f'INSERT INTO main."{name}" '
                f'SELECT * FROM {ARCHIVE_SCHEMA}."{name}"'
            )
            conn.execute("COMMIT")
        except sqlite3.IntegrityError as exc:
            conn.execute("ROLLBACK")
            report.refusals.append((
                ORPHANED_REFERENCE,
                f"copying {name} back under its original constraints failed: "
                f"{exc}. This is the integrity guarantee the split gave up, "
                "collected: a crossing reference was orphaned while the two "
                "databases were apart, and it must be resolved by hand before "
                "the reverse can complete",
            ))
            return

    for name in creation_order:
        src_n = table_count(conn, ARCHIVE_SCHEMA, name)
        dst_n = table_count(conn, "main", name)
        report.restored_counts[name] = dst_n
        if src_n != dst_n:
            report.refusals.append((
                COUNT_MISMATCH,
                f"{name}: archive holds {src_n} rows, cloude.db received {dst_n}",
            ))

    if report.refusals:
        return

    for obj in archive_objects:
        if obj.kind == "view" and obj.name in origin:
            conn.execute(origin[obj.name][1])

    conn.execute("BEGIN")
    for name in drop_order(conn, report.tables):
        conn.execute(f'DROP TABLE IF EXISTS {ARCHIVE_SCHEMA}."{name}"')
    conn.execute("COMMIT")
