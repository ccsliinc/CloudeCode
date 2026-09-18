"""The projection's two queries must be answered by their covering index.

NEVER ASSUME AN INDEX IS USED. The first version of this index was
PARTIAL (``WHERE superseded_by_archive_id IS NULL``) and led on
``ingested_at``. It was created, it was correct, and the planner ignored
it: it kept the existing narrow ``superseded_by_archive_id`` index and
the query stayed at 530 ms on the owner's 22,828 rows, so the fix read as
no fix at all and only ``EXPLAIN QUERY PLAN`` said so.

THIS IS A REGRESSION GUARD, NOT A BENCHMARK, and that is deliberate. A
wall-clock assertion on a small fixture would measure nothing and flake
on a loaded box; the PLAN is the defect exactly. Measured on a writable
copy of the 4.8 GB backup, the plan this file pins is the difference
between 10.32 ms and 529.76 ms on a path ``GET /corpus/status`` calls.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.db_steps import apply_message_model_schema
from src.core.message_projection_ledger import (
    LEDGER_SCAN_INDEX,
    _PENDING_COUNT_SQL,
    _PENDING_SQL,
    ensure_ledger,
)


def _state(tmp_path: Path) -> Path:
    """Create a state dir with the archive tables and the message model.

    Inputs: tmp_path (Path).
    Output: Path - the state dir.
    Example: _state(tmp_path) / "cloude.db"
    """
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    conn = connect(db_path_for(state), create=False)
    try:
        apply_message_model_schema(conn)
        conn.commit()
    finally:
        conn.close()
    return state


def test_the_pending_query_is_answered_by_a_covering_index(tmp_path):
    # NEVER ASSUME AN INDEX IS USED. The first version of this index was
    # a PARTIAL one leading on ingested_at; the planner ignored it and
    # kept the existing narrow superseded_by_archive_id index, so the
    # query stayed at 530 ms on the owner's 22,828 rows and the "fix"
    # changed nothing measurable. This reads the plan.
    state = _state(tmp_path)
    conn = connect(db_path_for(state), create=False)
    try:
        ensure_ledger(conn)
        conn.commit()
        plans = {
            "select_pending": conn.execute(
                "EXPLAIN QUERY PLAN " + _PENDING_SQL, (64,)).fetchall(),
            "pending_count": conn.execute(
                "EXPLAIN QUERY PLAN " + _PENDING_COUNT_SQL).fetchall(),
        }
    finally:
        conn.close()

    for name, plan in plans.items():
        text = " ".join(str(row[3]) for row in plan)
        assert f"COVERING INDEX {LEDGER_SCAN_INDEX}" in text, (
            f"{name} is not answered by the covering index; its plan was "
            f"{text!r}. On a real corpus that is the difference between "
            "10 ms and 530 ms, on a path the status endpoint calls."
        )
        # A sort here would mean the index's column order stopped
        # matching the ORDER BY, which costs a temp b-tree over every
        # current archive.
        assert "TEMP B-TREE" not in text, (
            f"{name} now sorts: {text!r}"
        )
