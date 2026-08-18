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

from src.core.db import ensure_install_id, set_meta
from src.core.db_models import (
    DDL_V1,
    DDL_V2,
    META_CREATED_AT,
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
        set_meta(conn, META_CREATED_AT, utc_now())
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


# from_version -> the function that advances it by one. Adding a key here
# without bumping CURRENT_SCHEMA_VERSION in db_models (or vice versa) is
# caught by tests/test_db_migration.py, because a bumped constant with no
# step is a database that can never reach the version the code demands.
STEPS: Dict[int, Callable[[sqlite3.Connection], None]] = {
    0: _step_v0_to_v1,
    1: _step_v1_to_v2,
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
