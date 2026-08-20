"""The ordered schema steps, and the driver that runs a range of them.

Kept apart from src/core/db_migration.py so the STEPS table stays a short,
readable list of "what each version bump does" rather than being buried
inside the startup-resolution logic that decides WHETHER to run it.

EVERY STEP MUST BE IDEMPOTENT. A step inspects sqlite_master /
PRAGMA table_info before it acts, so re-running it after an interrupted
attempt either finishes the remaining work or finds it already there and
does nothing. This is what makes a retry after an INTERRUPTED trail entry
safe by construction rather than by hoping the crash happened at a
convenient moment.

EVERY STEP MUST BE ADDITIVE. CREATE TABLE, CREATE INDEX, ALTER TABLE ADD
COLUMN. Never a drop, a rename or a retype. The whole rollback design
depends on this: forward is additive, and backward is a RESTORE from a
verified backup rather than a hand-written reversal nobody can prove is
complete.
"""

from __future__ import annotations

import sqlite3
from typing import Callable, Dict, List

from src.core.db import ensure_install_id, get_meta, set_meta
from src.core.db_models import (
    DDL_V1,
    DDL_V2,
    DDL_V3,
    DDL_V4,
    DDL_V5,
    META_CREATED_AT,
    META_PROJECT_TOMBSTONES_LEGACY_GAP,
    META_PROJECT_TOMBSTONES_SINCE,
    META_SCHEMA_VERSION,
)
from src.core.migration_trail import utc_now


def _step_v0_to_v1(conn: sqlite3.Connection) -> None:
    """Create the v1 schema: the meta and migration_trail tables.

    Description: idempotent by construction - every statement in DDL_V1
      carries IF NOT EXISTS, so re-running this after an interrupted
      attempt finishes whatever is missing and no-ops on the rest. Also
      seeds meta.created_at and meta.install_id on a genuinely new file,
      never overwriting an existing value.
    Inputs: conn (sqlite3.Connection) - inside the caller's transaction.
    Output: None.
    """
    for statement in DDL_V1:
        conn.execute(statement)
    if not conn.execute(
        "SELECT 1 FROM meta WHERE key=?", (META_CREATED_AT,)
    ).fetchone():
        stamp = utc_now()
        set_meta(conn, META_CREATED_AT, stamp)
        # A DATABASE CREATED BY THIS CODE HAS DELETION TRACKING FROM BIRTH.
        # It runs the whole chain 0 -> 5 in one transaction, so
        # project_tombstones exists before any project row can be created,
        # let alone deleted - there is no window in which a deletion could
        # have left no trace. Recording it HERE, on the genuinely-new-file
        # path, is what lets _step_v4_to_v5 read the ABSENCE of the marker
        # as proof that the database predates this code. Row counts cannot
        # do that job: a database whose projects were all deleted is
        # indistinguishable from a fresh one by counting, which is the
        # exact false-negative this replaces.
        set_meta(conn, META_PROJECT_TOMBSTONES_SINCE, stamp)
        set_meta(conn, META_PROJECT_TOMBSTONES_LEGACY_GAP, "0")
    ensure_install_id(conn)


def _step_v1_to_v2(conn: sqlite3.Connection) -> None:
    """Create the sessions table and its four indexes (design section 3.3).

    Description: build step S4. Idempotent by construction - every
      statement in DDL_V2 carries IF NOT EXISTS, so re-running this after
      an interrupted attempt creates whatever is missing and no-ops on
      the rest. Purely additive: it creates one table and four indexes
      and touches nothing that shipped in v1, so a v1 reader that has not
      been upgraded keeps working against the same file.

      The unique index it installs, ux_sessions_tmux_instance, is the
      object that makes tmux-name reuse safe: identity is the triple
      (tmux_socket, tmux_name, tmux_created_epoch), never the name alone.
    Inputs: conn (sqlite3.Connection) - inside the caller's transaction.
    Output: None.
    Example: _step_v1_to_v2(conn)  # after _step_v0_to_v1
    """
    for statement in DDL_V2:
        conn.execute(statement)


def _step_v2_to_v3(conn: sqlite3.Connection) -> None:
    """Add ``sessions.tmux_session_id``, the instance discriminator.

    Description: build step S4 hardening. Purely additive - one nullable
      column and no index, so a v2 reader that has not been upgraded keeps
      working against the same file and every existing row simply carries
      NULL.

      IDEMPOTENT BY INSPECTION, NOT BY THE STATEMENT. SQLite's
      ``ALTER TABLE ADD COLUMN`` has no ``IF NOT EXISTS``, so re-running
      this after an interrupted attempt would raise "duplicate column
      name". PRAGMA table_info is read first and the step no-ops when the
      column is already present, which is what makes a retry after an
      INTERRUPTED trail entry safe by construction.

      The column holds tmux's ``#{session_id}``. It is NOT part of the
      identity key - see the comment above ``DDL_SESSIONS_ADD_SESSION_ID``
      in db_models for why a per-server-lifetime counter is a worse
      durable key than the creation epoch and a better live discriminator.
    Inputs: conn (sqlite3.Connection) - inside the caller's transaction.
    Output: None.
    Example: _step_v2_to_v3(conn)  # after _step_v1_to_v2
    """
    existing = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(sessions)")
    }
    if "tmux_session_id" in existing:
        return
    for statement in DDL_V3:
        conn.execute(statement)


def _step_v3_to_v4(conn: sqlite3.Connection) -> None:
    """Add ``projects.last_opened_at``, the launcher's ordering key.

    Description: feat/db-is-authoritative. Purely additive - one nullable
      column on ``projects``, no index - so a v3 reader that has not been
      upgraded keeps working against the same file and every existing row
      simply carries NULL.

      IDEMPOTENT BY INSPECTION, NOT BY THE STATEMENT, exactly as v2 -> v3
      is: SQLite's ``ALTER TABLE ADD COLUMN`` has no ``IF NOT EXISTS``, so
      PRAGMA table_info is read first and the step no-ops when the column
      is already there. That is what makes a retry after an INTERRUPTED
      trail entry safe by construction.

      A database that has never reached v3 has no ``projects`` table at
      all, which cannot happen here - the chain runs in order and v0 -> v1
      creates it - but the PRAGMA on a missing table returns no rows
      rather than raising, so the guard degrades to attempting the ALTER
      and surfacing SQLite's own error inside the caller's transaction
      rather than corrupting anything.
    Inputs: conn (sqlite3.Connection) - inside the caller's transaction.
    Output: None.
    Example: _step_v3_to_v4(conn)  # after _step_v2_to_v3
    """
    existing = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(projects)")
    }
    if "last_opened_at" in existing:
        return
    for statement in DDL_V4:
        conn.execute(statement)


def _step_v4_to_v5(conn: sqlite3.Connection) -> None:
    """Add ``project_tombstones`` and record whether this DB has a legacy gap.

    Description: the schema half of the every-start project reconcile.
      Purely additive - one new table, nothing on ``projects`` altered -
      and idempotent by the statement itself (``CREATE TABLE IF NOT
      EXISTS``) rather than by inspection, so a retry after an
      INTERRUPTED trail entry is safe.

      THE SECOND THING THIS STEP DOES, AND WHY IT BELONGS HERE. The
      reconcile can only tell "never imported" from "deliberately
      deleted" for deletions that happened AFTER this table existed.
      Deletions before it left no trace of any kind, so on a database
      that already held project history those two causes are
      indistinguishable - the third outcome, CANNOT EVALUATE.

      That fact is measurable exactly once, at this instant, and never
      again: a database with project rows or a stamped import latch
      predates tracking, a database created at v5 cannot. So the step
      records the answer rather than leaving a later reader to guess it.
      ``project_reconcile`` reads it to decide whether an unexplained
      absence is safe to import or has to be reported as unknown.

      A fresh install runs the whole chain 0 -> 5 in one transaction with
      no rows and no latch, so it records no gap and reconciles
      automatically from its first start.
    Inputs: conn (sqlite3.Connection) - inside the caller's transaction.
    Output: None.
    Example: _step_v4_to_v5(conn)  # after _step_v3_to_v4
    """
    for statement in DDL_V5:
        conn.execute(statement)

    if get_meta(conn, META_PROJECT_TOMBSTONES_SINCE):
        return

    # NO MARKER MEANS THIS DATABASE PREDATES THIS CODE, so it has a legacy
    # gap - full stop, no heuristic. A file created by this version was
    # stamped in _step_v0_to_v1 during its own 0 -> 5 chain and returned
    # above; reaching this line means the file was created by an earlier
    # version, which had no tombstone table and therefore deleted projects
    # without leaving any trace. Whether it ACTUALLY deleted any is
    # unknowable, and that is precisely the point: the gap records that the
    # question cannot be answered, not that a deletion happened.
    set_meta(conn, META_PROJECT_TOMBSTONES_SINCE, utc_now())
    set_meta(conn, META_PROJECT_TOMBSTONES_LEGACY_GAP, "1")


# from_version -> the function that advances it by one. Adding a key here
# without bumping CURRENT_SCHEMA_VERSION in db_models (or vice versa) is
# caught by tests/test_db_migration.py, because a bumped constant with no
# step is a database that can never reach the version the code demands.
STEPS: Dict[int, Callable[[sqlite3.Connection], None]] = {
    0: _step_v0_to_v1,
    1: _step_v1_to_v2,
    2: _step_v2_to_v3,
    3: _step_v3_to_v4,
    4: _step_v4_to_v5,
}


def run_chain(conn: sqlite3.Connection, from_version: int, to_version: int) -> List[str]:
    """Apply every step from from_version up to to_version, in order.

    Description: the caller owns the transaction, so a failure anywhere
      in the chain rolls back EVERY step in it and leaves
      meta.schema_version untouched. Forward jumping is not a separate
      mechanism: v1 straight to v4 is simply steps 2, 3 and 4 back to
      back inside that one transaction.
    Inputs: conn (sqlite3.Connection) - already inside a transaction.
      from_version (int), to_version (int).
    Output: list[str] - labels of the steps applied, e.g. ["0->1"].
    Raises: KeyError - a version in the range has no registered step.
      Anything a step itself raises, unmodified, so the caller's
      transaction context manager rolls the whole chain back.
    Example: run_chain(conn, 0, 1) -> ["0->1"]
    """
    applied: List[str] = []
    for version in range(from_version, to_version):
        step = STEPS.get(version)
        if step is None:
            raise KeyError(
                f"no migration step registered for schema v{version} -> "
                f"v{version + 1}"
            )
        step(conn)
        applied.append(f"{version}->{version + 1}")
    set_meta(conn, META_SCHEMA_VERSION, str(to_version))
    return applied
