"""Build and rebuild the block-search index, as a NAMED operation.

THE MIGRATION CREATES AND DOES NOT POPULATE, for a reason: the build is
1.80 s over the measured 112,623 blocks, and a startup transaction may
not spend that - on a corpus twenty times the size it is a boot that
looks hung. So an install arrives at v29 with an EMPTY index,
``message_block_search_status`` calls that ``never_built``, and search
REFUSES rather than answering zero hits. This module is what moves it to
``current``.

RESUMABLE BY CONSTRUCTION. The remaining work is the antijoin between the
indexable blocks and the index's own rowids, so an interrupted run
resumes exactly where it stopped with no ledger table and nothing to
reconcile. A full rebuild is the same operation with the index emptied
first.

BOUNDED, AND THE BOUND IS A COUNT RATHER THAN A CLOCK. ``max_rows``
caps one pass. A time bound was rejected: it makes the work done by a
pass depend on how loaded the box was, so two runs are not comparable
and a test cannot pin one.

LIVENESS IS PUBLISHED ON EVERY TERMINATING PATH, failure included, for
the reason ``message_block_search_state`` gives - a rebuilder that died
and one with nothing to do are otherwise indistinguishable.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import structlog

from src.core.message_block_search_ddl import BLOCK_SEARCH_TABLE
from src.core.message_block_search_state import (
    OUTCOME_BUILT,
    OUTCOME_FAILED,
    OUTCOME_NOTHING_TO_DO,
    utc_now_iso,
    write_liveness,
)
from src.core.message_block_search_status import (
    INDEXABLE_BLOCKS_SQL,
    index_table_exists,
)

logger = structlog.get_logger()

#: Rows one pass will index before returning. 50,000 is about 0.8 s at
#: the measured build rate, which is a bounded write transaction rather
#: than a multi-minute one holding the write lock on a live install.
DEFAULT_MAX_ROWS: int = 50_000

#: The rows that belong in the index and are not there. The NOT EXISTS
#: is against the FTS table's own rowid, which IS
#: ``message_content_blocks.id``, so it is an index lookup rather than a
#: scan of either side.
_PENDING_SQL: str = f"""
SELECT cb.id, cb.text
  FROM message_content_blocks cb
 WHERE cb.text IS NOT NULL AND cb.text <> ''
   AND NOT EXISTS (
         SELECT 1 FROM {BLOCK_SEARCH_TABLE} f WHERE f.rowid = cb.id)
 ORDER BY cb.id
 LIMIT :cap
"""

_PENDING_COUNT_SQL: str = f"""
SELECT COUNT(*)
  FROM message_content_blocks cb
 WHERE cb.text IS NOT NULL AND cb.text <> ''
   AND NOT EXISTS (
         SELECT 1 FROM {BLOCK_SEARCH_TABLE} f WHERE f.rowid = cb.id)
"""

_INSERT_SQL: str = (
    f"INSERT INTO {BLOCK_SEARCH_TABLE}(rowid, text) VALUES (?, ?)"
)


class BlockSearchIndexUnavailable(RuntimeError):
    """The index cannot be built because its table is not there.

    Description: named rather than generic so a caller can tell "this
      install has not migrated" from "the build went wrong", which are
      different things to tell an operator.
    Inputs: standard RuntimeError arguments.
    Output: an exception instance.
    """


@dataclass(frozen=True)
class BuildReport:
    """What one build pass did.

    Description: ``pending_before`` and ``pending_after`` are what make a
      partial pass legible - a caller loops until ``pending_after`` is 0
      rather than guessing from ``indexed``.
    Inputs: constructed by :func:`build_pending`.
    Output: a frozen record.
    """

    outcome: str
    indexed: int
    pending_before: int
    pending_after: int
    elapsed_seconds: float
    reset: bool = False

    def as_record(self) -> dict:
        """Render this pass for the liveness artifact.

        Output: dict, JSON-serialisable.
        Example: write_liveness(sd, report.as_record())
        """
        return {
            "outcome": self.outcome,
            "finished_at": utc_now_iso(),
            "indexed": self.indexed,
            "pending_before": self.pending_before,
            "pending_after": self.pending_after,
            "elapsed_seconds": round(self.elapsed_seconds, 6),
            "reset": self.reset,
        }


def pending_count(conn: sqlite3.Connection) -> int:
    """Count the indexable blocks that are not yet in the index.

    Inputs: conn (sqlite3.Connection).
    Output: int.
    Raises: BlockSearchIndexUnavailable - the FTS table does not exist.
    Example: pending_count(conn) -> 112623
    """
    if not index_table_exists(conn):
        raise BlockSearchIndexUnavailable(
            f"{BLOCK_SEARCH_TABLE} does not exist; migrate to schema v29 "
            f"with the message archive enabled before building it"
        )
    return int(conn.execute(_PENDING_COUNT_SQL).fetchone()[0])


def indexable_count(conn: sqlite3.Connection) -> int:
    """Count every block that belongs in the index, indexed or not.

    Inputs: conn (sqlite3.Connection).
    Output: int.
    Example: indexable_count(conn) -> 112623
    """
    return int(conn.execute(INDEXABLE_BLOCKS_SQL).fetchone()[0])


def reset_index(conn: sqlite3.Connection) -> int:
    """Empty the index so the next build is a full rebuild.

    Description: a DELETE rather than a DROP, so the triggers that
      reference the table keep referencing a table that exists. On a
      ``contentless_delete=1`` table a bare DELETE is legal and is what
      makes this a one-liner.
    Inputs: conn (sqlite3.Connection) - the caller owns the transaction.
    Output: int - rows removed.
    Raises: BlockSearchIndexUnavailable - the table does not exist.
    Example: reset_index(conn) -> 112623
    """
    if not index_table_exists(conn):
        raise BlockSearchIndexUnavailable(
            f"{BLOCK_SEARCH_TABLE} does not exist; nothing to reset"
        )
    before = int(conn.execute(
        f"SELECT COUNT(*) FROM {BLOCK_SEARCH_TABLE}"
    ).fetchone()[0])
    conn.execute(f"DELETE FROM {BLOCK_SEARCH_TABLE}")
    return before


def build_pending(
    conn: sqlite3.Connection,
    *,
    max_rows: int = DEFAULT_MAX_ROWS,
    state_dir: Optional[Path] = None,
    reset: bool = False,
) -> BuildReport:
    """Index up to ``max_rows`` blocks that are not yet indexed.

    Description: the one build path, used by the operator script and by
      a test alike, so there is no second way of populating the index
      that could disagree with this one. The caller owns the transaction;
      this issues no BEGIN and no COMMIT, which is what lets a script
      wrap a pass and a test wrap a hundred.
    Inputs: conn (sqlite3.Connection) - writable. max_rows (int) - the
      per-pass bound. state_dir (Path | None) - when given, the liveness
      record is published here on every terminating path. reset (bool) -
      empty the index first, making this a full rebuild.
    Output: BuildReport.
    Raises: BlockSearchIndexUnavailable - the table does not exist.
      sqlite3.Error - propagated AFTER a ``failed`` record is published,
      so the caller's transaction rolls back and the artifact still says
      somebody tried.
    Example: build_pending(conn, max_rows=1000).pending_after -> 0
    """
    started = time.perf_counter()
    if not index_table_exists(conn):
        raise BlockSearchIndexUnavailable(
            f"{BLOCK_SEARCH_TABLE} does not exist; migrate to schema v29 "
            f"with the message archive enabled before building it"
        )
    try:
        if reset:
            reset_index(conn)
        before = int(conn.execute(_PENDING_COUNT_SQL).fetchone()[0])
        rows = conn.execute(_PENDING_SQL, {"cap": int(max_rows)}).fetchall()
        conn.executemany(_INSERT_SQL, [(row[0], row[1]) for row in rows])
        after = int(conn.execute(_PENDING_COUNT_SQL).fetchone()[0])
    except sqlite3.Error as exc:
        # Specific, published, and re-raised. Swallowing it would leave
        # the caller's transaction to commit a half-built index while the
        # artifact said the pass succeeded.
        elapsed = time.perf_counter() - started
        report = BuildReport(
            OUTCOME_FAILED, 0, -1, -1, elapsed, reset=reset,
        )
        if state_dir is not None:
            record = report.as_record()
            record["error"] = f"{type(exc).__name__}: {exc}"
            write_liveness(state_dir, record)
        logger.warning(
            "block_search_build_failed", error=str(exc),
            error_type=type(exc).__name__,
        )
        raise
    outcome = OUTCOME_BUILT if rows else OUTCOME_NOTHING_TO_DO
    report = BuildReport(
        outcome, len(rows), before, after,
        time.perf_counter() - started, reset=reset,
    )
    if state_dir is not None:
        write_liveness(state_dir, report.as_record())
    logger.info(
        "block_search_build", outcome=outcome, indexed=len(rows),
        pending_before=before, pending_after=after,
        elapsed_seconds=round(report.elapsed_seconds, 3),
    )
    return report
