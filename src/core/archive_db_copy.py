"""Copy the archive across, prove it landed, and order the teardown.

Split out of :mod:`src.core.archive_db_split` to keep both files under
this project's 500-line guideline. The division is by JOB, not by size:
that module MEASURES and DECIDES (sizes, destination state, the schema it
will create), this one MOVES DATA and PROVES IT ARRIVED.

The three checks here are the ones the drop is gated on, and each catches
something the others cannot:

  copy_table            resumable, so an interruption costs nothing
  probe_writability     the DDL looked fine; can the table be WRITTEN to
  verify_content_sample the count matched; did the BYTES arrive
  drop_order            children before parents, from the real FK graph
"""

from __future__ import annotations

import sqlite3
import time
from typing import Dict, List, Optional, Sequence, Tuple

from src.core.archive_db_partition import ARCHIVE_SCHEMA


from src.core.archive_db_split import (
    CHUNK_ROWS,
    CONTENT_SAMPLE_ROWS,
    PROGRESS_TABLE,
    table_count,
)


#: A table whose content this copier must not touch at all.
STRATEGY_SKIP = "skip"
#: Copy in one statement, because the table has no rowid to page on.
STRATEGY_WHOLE = "whole"
#: The normal path: rowid-ordered, chunked, resumable.
STRATEGY_CHUNKED = "chunked"


def copy_strategy(conn: sqlite3.Connection, table: str, schema: str = "main") -> str:
    """Decide how one table's rows must be copied.

    Description: MEASURED PER TABLE, not assumed, because the archive
      family is not uniformly shaped and a wrong assumption here took
      down a live migration. Three cases:

      VIRTUAL tables (``message_block_search``, an fts5 index) own no
      storage of their own. Their rows live in shadow tables, and
      ``CREATE VIRTUAL TABLE`` in the destination creates those shadows
      empty and ready. Copying the virtual table's own "rows" is
      meaningless, and on a ``content=''`` contentless fts5 index it is
      not even expressible. So it is SKIPPED, and the index arrives with
      its shadows.

      WITHOUT ROWID tables have no ``rowid`` to page on.
      ``message_block_search_idx`` and ``message_block_search_config``
      are two of them, and they are what raised
      ``no such column: rowid`` on the live run. They are copied WHOLE in
      one statement. That is safe here because they are small (an fts5
      index's config and b-tree metadata), and the alternative, paging on
      their declared primary key, is a generic problem not worth solving
      for two small tables.

      Everything else takes the chunked, resumable path.
    Inputs: conn (sqlite3.Connection), table (str), schema (str).
    Output: str - one of the STRATEGY_* constants.
    Example: copy_strategy(conn, "message_block_search")  # 'skip'
    """
    row = conn.execute(
        f"SELECT sql FROM {schema}.sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    sql = (row[0] or "") if row else ""
    if "CREATE VIRTUAL TABLE" in sql.upper():
        return STRATEGY_SKIP
    try:
        conn.execute(f'SELECT rowid FROM {schema}."{table}" LIMIT 1').fetchone()
    except sqlite3.OperationalError:
        return STRATEGY_WHOLE
    return STRATEGY_CHUNKED


def copy_table(
    conn: sqlite3.Connection, table: str, install_id: Optional[str],
) -> int:
    """Copy one table into the archive, resumably, in committed chunks.

    Description: ordered by rowid so an interruption always leaves a
      PREFIX rather than a hole. A table already recorded complete at
      the current source count is skipped; anything else is truncated
      and recopied, because reasoning about a partial copy of an unknown
      shape is not worth it while the source is intact.
      NOT EVERY TABLE TAKES THAT PATH. :func:`copy_strategy` decides per
      table: a virtual fts5 index is skipped (its shadows carry the
      data), and a WITHOUT ROWID table is copied whole because there is
      no rowid to page on.
    Inputs: conn (sqlite3.Connection with the archive attached), table
      (str), install_id (str | None - stamped on the progress row).
    Output: int - rows in the destination when this returns.
    Example: copy_table(conn, "transcript_records", "abc")  # 8317542
    """
    strategy = copy_strategy(conn, table)
    if strategy == STRATEGY_SKIP:
        # A virtual table's CREATE already built its shadows in the
        # destination; there is nothing of its own to move.
        conn.execute(
            f"INSERT OR REPLACE INTO {ARCHIVE_SCHEMA}.{PROGRESS_TABLE} "
            "(table_name, source_rows, copied_rows, finished_at, install_id) "
            "VALUES (?,0,0,?,?)",
            (table, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), install_id),
        )
        return 0

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

    if strategy == STRATEGY_WHOLE:
        conn.execute("BEGIN")
        conn.execute(
            f'INSERT INTO {ARCHIVE_SCHEMA}."{table}" SELECT * FROM main."{table}"'
        )
        conn.execute("COMMIT")
        dest_n = table_count(conn, ARCHIVE_SCHEMA, table)
        conn.execute(
            f"UPDATE {ARCHIVE_SCHEMA}.{PROGRESS_TABLE} "
            "SET copied_rows=?, finished_at=? WHERE table_name=?",
            (dest_n, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), table),
        )
        return dest_n

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
      THE TWO SIDES TO EACH OTHER: blob against blob, and the recorded
      ``content_sha256`` column against the recorded column. Sampled
      rather than exhaustive because the source is 3.7 GB of blob and an
      exhaustive compare would double the migration's runtime for a
      check the destination integrity pragma largely covers.

      IT DELIBERATELY DOES NOT HASH THE BLOB AND COMPARE IT TO
      ``content_sha256``, and an earlier version of this docstring said
      it did, which is how the next person would have written the bug.
      That check asks the wrong question: ``transcript_prefix_dedupe``
      replaces a SUPERSEDED row's blob with an 8-byte empty sentinel and
      deliberately leaves ``content_sha256`` and ``raw_byte_length``
      alone, because the bytes live forward along
      ``superseded_by_archive_id``. Measured over the whole live table,
      16.5 percent of rows are in that state BY DESIGN and all 23,429
      reconstruct correctly. A naive blob-versus-hash check reports them
      as corrupt forever.

      The correct whole-row check is
      ``src.core.transcript_archive.export_archive`` plus BOTH the hash
      and the length; see ``docs/transcript-archive-integrity.md`` and
      ``scripts/transcript-archive/verify_archive_integrity.py``. It is
      not what this function needs: comparing the two SIDES answers "did
      the copy move the bytes faithfully", which is chain-agnostic by
      construction, and is the only question a migration has to settle.
    Inputs: conn (sqlite3.Connection with the archive attached), limit
      (int) - how many rows to compare.
    Output: tuple[int, list[str]] - rows checked, and the archive_uuids
      that did not match.
    Example: verify_content_sample(conn, 10)  # (10, [])
    """
    mismatches: List[str] = []
    # A SECOND RUN OVER AN ALREADY-SPLIT INSTALL HAS NO transcript_archives
    # IN MAIN, and hardcoding it crashed exactly there: the copy had
    # succeeded, verification raised, and the drop never ran. Safe, but it
    # made the migration un-re-runnable. Nothing to sample is reported as
    # zero rows checked rather than as zero mismatches found, so a reader
    # can tell "there was nothing to compare" from "I compared and all
    # matched": the report prints content_checked alongside the mismatch
    # count for that reason.
    present = conn.execute(
        "SELECT COUNT(*) FROM main.sqlite_master "
        "WHERE type='table' AND name='transcript_archives'"
    ).fetchone()[0]
    if not present:
        return 0, []
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
