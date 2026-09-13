"""Which tables live in cloude.db and which live in cloude-archive.db.

THE SINGLE SOURCE OF TRUTH FOR WHERE THE LINE FALLS. The migration, the
integrity gate, the ATTACH wiring and the tests all read the partition
from here, because two descriptions of one boundary are two boundaries
the moment they disagree.

THE RULE IS BY TABLE NAME, NEVER BY MODULE GLOB. A glob on ``*archive*``
over ``src/`` picks up :mod:`src.core.project_archive`, which retires a
project shelf and has nothing to do with the transcript archive. Names in
``sqlite_master`` do not have that ambiguity.

THE APP SIDE IS AN EXPLICIT ALLOW-LIST AND THE ARCHIVE SIDE IS A PREFIX
RULE, and the asymmetry is deliberate. The app side is small, stable and
irreplaceable, so naming its eight tables one by one costs nothing and
makes an accidental move impossible. The archive side grows (the v16
message model, and the FTS5 shadow tables ``message_block_search_data``,
``_idx``, ``_content``, ``_docsize``, ``_config`` that sqlite creates on
its own and nobody declares), so it has to be a rule rather than a list.

ANYTHING MATCHING NEITHER IS ``UNCLASSIFIED`` AND THE CALLER MUST REFUSE.
That is the rung that catches a table added after this module was
written. Leaving an unknown table in main would be a half-done split;
moving it would risk putting irreplaceable state into a file the backup
policy treats as rebuildable. Neither is safe, so neither is guessed.

MEASURED ON THE v25 BACKUP, 2026-09-13, and these are the numbers the
migration's expectations are pinned to:

  * archive side 5,142,835,200 bytes of 5,143,564,288 = 99.9858 percent
  * app side plus sqlite_schema = 729,088 bytes = 712 KiB
  * exactly THREE foreign keys cross, all archive -> app, all with zero
    orphans: ``transcript_archives.root_session_id -> sessions.id``
    (1,507 populated), ``transcript_archives.project_id -> projects.id``
    (3,160), ``transcript_root_decisions.project_id -> projects.id``
    (3,160)
  * NOTHING crosses app -> archive, which is what makes the split viable
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, FrozenSet, List, Sequence, Tuple

#: Filename of the separated archive database, beside cloude.db.
ARCHIVE_DB_FILENAME = "cloude-archive.db"

#: The schema name the archive is ATTACHed under. Every qualified read in
#: the ingester and the browser spells it this way; it is a constant so a
#: typo is an ImportError rather than "no such table" at runtime.
ARCHIVE_SCHEMA = "archive"

SIDE_APP = "app"
SIDE_ARCHIVE = "archive"
SIDE_UNCLASSIFIED = "unclassified"

#: Stays in cloude.db. Named one by one on purpose: this is the
#: irreplaceable state, it is 712 KiB, and it is what the two-tier backup
#: policy exists to protect.
APP_TABLES: FrozenSet[str] = frozenset({
    "sessions",
    "projects",
    "meta",
    "migration_trail",
    "project_tombstones",
    "session_groups",
    "session_group_members",
    "session_group_membership",
})

#: Moves to cloude-archive.db. A prefix rule because the archive side
#: acquires tables nobody declares: sqlite creates five shadow tables for
#: the ``message_block_search`` FTS5 index, and they all carry the
#: ``message_`` prefix.
ARCHIVE_PREFIXES: Tuple[str, ...] = (
    "transcript_",
    "message_",
    "archive_",
)

#: The crossing foreign keys this migration was written against, as
#: ``(child_table, child_column, parent_table)``. Recomputed at runtime
#: and compared: a fourth crossing key means the line moved and a human
#: has to decide, so the migration refuses rather than inventing a
#: policy for a constraint it has never seen.
EXPECTED_CROSSING_FKS: Tuple[Tuple[str, str, str], ...] = (
    ("transcript_archives", "project_id", "projects"),
    ("transcript_archives", "root_session_id", "sessions"),
    ("transcript_root_decisions", "project_id", "projects"),
)


def archive_db_path_for(state_dir: Path) -> Path:
    """Return the cloude-archive.db path inside a state directory.

    Description: the archive twin of ``db.db_path_for``, so the filename
      lives in exactly one place.
    Inputs: state_dir (Path) - as resolved by Settings.get_state_dir().
    Output: Path - state_dir / "cloude-archive.db".
    Example: archive_db_path_for(Path("/s")).name  # 'cloude-archive.db'
    """
    return Path(state_dir) / ARCHIVE_DB_FILENAME


def side_for_table(name: str) -> str:
    """Classify one table name onto a side of the partition.

    Description: the app allow-list is consulted FIRST, so a future app
      table that happens to start with an archive prefix is still kept
      in main by naming it here. Anything matching neither answers
      ``unclassified``, which every caller must treat as a refusal and
      never as a default side.
    Inputs: name (str) - a table or view name from sqlite_master.
    Output: str - SIDE_APP, SIDE_ARCHIVE or SIDE_UNCLASSIFIED.
    Example: side_for_table("transcript_records")  # 'archive'
    """
    if name in APP_TABLES:
        return SIDE_APP
    if name.startswith(ARCHIVE_PREFIXES):
        return SIDE_ARCHIVE
    return SIDE_UNCLASSIFIED


@dataclass(frozen=True)
class ObjectRow:
    """One row of sqlite_master, classified.

    Description: carries the side alongside the DDL so a caller never
      has to re-derive one from the other.
    Inputs: name, kind ('table' or 'view'), sql (str | None - sqlite
      stores NULL for internal objects), side (str).
    Output: a frozen record.
    """

    name: str
    kind: str
    sql: str
    side: str


def classify_objects(conn: sqlite3.Connection, schema: str = "main") -> List[ObjectRow]:
    """Read sqlite_master and classify every table and view in it.

    Description: skips ``sqlite_%`` internal objects (autoindexes and
      sqlite_sequence), which belong to whichever table owns them and
      are recreated by the DDL rather than copied.
    Inputs: conn (sqlite3.Connection), schema (str) - 'main' or an
      attached schema name.
    Output: list[ObjectRow] ordered by name.
    Example: [o.name for o in classify_objects(c) if o.side == 'app']
    """
    rows = conn.execute(
        f"SELECT name, type, sql FROM {schema}.sqlite_master "
        "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' "
        "ORDER BY name"
    ).fetchall()
    return [
        ObjectRow(name=r[0], kind=r[1], sql=r[2] or "", side=side_for_table(r[0]))
        for r in rows
    ]


def unclassified_objects(objects: Sequence[ObjectRow]) -> List[str]:
    """Name every object the partition map could not place.

    Description: a non-empty result is refusal rung UNCLASSIFIED_OBJECT.
      It is a MEASURED unknown, not an unchecked one: sqlite_master was
      read and these names were in it.
    Inputs: objects (Sequence[ObjectRow]) - from classify_objects.
    Output: list[str] - the names, sorted.
    Example: unclassified_objects(classify_objects(c))  # []
    """
    return sorted(o.name for o in objects if o.side == SIDE_UNCLASSIFIED)


def crossing_foreign_keys(
    conn: sqlite3.Connection, schema: str = "main",
) -> List[Tuple[str, str, str]]:
    """Recompute every foreign key that crosses the partition.

    Description: walks ``PRAGMA foreign_key_list`` for every classified
      table and keeps the pairs whose child and parent land on different
      sides. Recomputed rather than trusted so that a schema change
      which adds a fourth crossing key is MEASURED at migration time.
      Unclassified tables are skipped here because their presence is
      already a refusal in its own right.
    Inputs: conn (sqlite3.Connection), schema (str).
    Output: list[tuple[str, str, str]] - (child, column, parent), sorted.
    Example: crossing_foreign_keys(c)[0]
      # ('transcript_archives', 'project_id', 'projects')
    """
    out: List[Tuple[str, str, str]] = []
    for obj in classify_objects(conn, schema):
        if obj.kind != "table" or obj.side == SIDE_UNCLASSIFIED:
            continue
        for row in conn.execute(
            f'PRAGMA {schema}.foreign_key_list("{obj.name}")'
        ).fetchall():
            parent, column = row[2], row[3]
            if side_for_table(parent) != obj.side:
                out.append((obj.name, column, parent))
    return sorted(out)


def orphaned_reference_counts(
    conn: sqlite3.Connection, crossings: Sequence[Tuple[str, str, str]],
) -> Dict[str, int]:
    """Count rows whose crossing reference has no parent row.

    Description: the measurement the REVERSE migration depends on. The
      forward split turns these columns into plain INTEGERs, so nothing
      would complain; the reverse re-imposes the constraint and cannot
      succeed if a reference has been orphaned. Refusing forward on a
      non-zero count is what keeps the door two-way. Measured zero on
      all three crossings on the v25 backup, 2026-09-13.
    Inputs: conn (sqlite3.Connection), crossings (Sequence of
      (child, column, parent) as returned by crossing_foreign_keys).
    Output: dict[str, int] - "child.column" -> orphan count, every
      crossing present even when the count is zero.
    Example: orphaned_reference_counts(c, crossing_foreign_keys(c))
      # {'transcript_archives.project_id': 0, ...}
    """
    counts: Dict[str, int] = {}
    for child, column, parent in crossings:
        row = conn.execute(
            f'SELECT COUNT(*) FROM "{child}" x '
            f'LEFT JOIN "{parent}" p ON x."{column}" = p.id '
            f'WHERE x."{column}" IS NOT NULL AND p.id IS NULL'
        ).fetchone()
        counts[f"{child}.{column}"] = int(row[0])
    return counts
