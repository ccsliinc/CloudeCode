"""The plan is the regression guard, not the stopwatch.

WHY THIS FILE EXISTS RATHER THAN A TIMING TEST. This repo has already
paid for the lesson once: a covering index was added for the projection's
pending query, it was PARTIAL and led on the wrong column, the planner
ignored it, and the elapsed time did not move enough for anyone to
notice. ``EXPLAIN QUERY PLAN`` is what found it and
``tests/test_projection_query_plan.py`` is what keeps it found. The same
discipline applies here and the risk is larger: an FTS5 MATCH that stops
being driven by the index does not fail, it silently becomes a scan of
every indexed row, and on a loaded box a wall clock would either flake or
be too loose to prove anything.

WHAT THE PLAN HAS TO SAY, and each line is load-bearing:

  SCAN f VIRTUAL TABLE INDEX 0:M1   the MATCH constraint reached FTS5.
                                    Without the ``M`` the query still
                                    returns the right rows, by scanning.
  SEARCH cb USING INTEGER PRIMARY KEY   the FTS rowid IS
                                    message_content_blocks.id, which is
                                    the whole reason a contentless index
                                    is affordable.
  SEARCH a USING INDEX ix_message_appearances_body   the existing body
                                    index carries the join to appearances.

The ORDER BY's temp b-tree is NOT asserted. It is a consequence of
ordering across three tables and it sorts only the matched set; pinning
it would fail the day SQLite learns to avoid it, which would be an
improvement.
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.archive_search_fts import (
    ORDER_POSITION,
    ORDER_RELEVANCE,
    BlockFilters,
    build_hit_query,
)
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.db_steps import apply_message_model_schema

#: The MATCH marker in an FTS5 plan line. SQLite spells a virtual table's
#: chosen plan as ``VIRTUAL TABLE INDEX <n>:<idxStr>``, and FTS5 puts an
#: ``M`` in that string exactly when it is answering a MATCH. Asserting
#: the substring rather than the whole line keeps this from breaking on a
#: cosmetic change to the plan's wording while still failing the moment
#: the MATCH stops being used.
FTS_MATCH_MARKER = "VIRTUAL TABLE INDEX 0:M"


@pytest.fixture()
def conn(tmp_path: Path):
    """A real datastore carrying the whole message schema, v27 included.

    Description: the plan depends on which indexes exist, so this has to
      be the REAL schema rather than a hand-written subset that might
      happen to have the index the query wants.
    Inputs: tmp_path (Path).
    Output: sqlite3.Connection, closed by the fixture.
    """
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    connection = connect(db_path_for(state), create=False)
    try:
        apply_message_model_schema(connection)
        connection.commit()
        yield connection
    finally:
        connection.close()


def _plan(connection: sqlite3.Connection, sql: str, params: dict) -> list:
    """Return the EXPLAIN QUERY PLAN detail lines for one query.

    Inputs: connection (sqlite3.Connection), sql (str), params (dict).
    Output: list[str].
    Example: _plan(conn, "SELECT 1", {}) -> []
    """
    return [str(row[3]) for row in
            connection.execute("EXPLAIN QUERY PLAN " + sql, params)]


def _hit_plan(connection: sqlite3.Connection, **kwargs) -> list:
    """Build the real hit query and return its plan.

    Description: builds through ``build_hit_query``, the SAME builder a
      request uses, so this cannot drift into testing a query nobody
      runs.
    Inputs: connection. kwargs - forwarded to build_hit_query, minus the
      params dict which is created here.
    Output: list[str] - plan detail lines.
    """
    params = {"match": '"tmux"*', "q": "tmux", "scope_id": 1, "cap": 51}
    kwargs.setdefault("scope", "project")
    kwargs.setdefault("case_sensitive", False)
    kwargs.setdefault("filters", BlockFilters())
    kwargs.setdefault("resume", None)
    kwargs.setdefault("order", ORDER_POSITION)
    sql = build_hit_query(params=params, **kwargs)
    return _plan(connection, sql, params)


def test_the_match_is_answered_by_the_fts_index(conn) -> None:
    """The one that matters: FTS5 drives the query.

    Description: without this the query still returns the right rows -
      by walking every indexed row and testing each. That is a defect no
      assertion about results could ever see.
    """
    plan = _hit_plan(conn)
    assert any(FTS_MATCH_MARKER in line for line in plan), (
        "the FTS5 MATCH must drive the query; plan was:\n  "
        + "\n  ".join(plan))


def test_the_block_row_is_fetched_by_its_rowid(conn) -> None:
    """The FTS rowid IS the block id, which is why contentless is affordable."""
    plan = _hit_plan(conn)
    assert any("cb USING INTEGER PRIMARY KEY" in line for line in plan), (
        "message_content_blocks must be reached by rowid; plan was:\n  "
        + "\n  ".join(plan))


def test_the_appearance_join_uses_the_body_index(conn) -> None:
    """The existing ix_message_appearances_body carries the join."""
    plan = _hit_plan(conn)
    assert any("ix_message_appearances_body" in line for line in plan), (
        "the appearance join must use ix_message_appearances_body; plan "
        "was:\n  " + "\n  ".join(plan))


def test_no_shape_of_the_query_loses_the_index(conn) -> None:
    """Every filter, scope, order and resume combination keeps the MATCH.

    Description: the builder assembles the SQL from fragments, and a
      fragment that accidentally made the MATCH unusable would show up in
      exactly one combination. Enumerating them is cheap; discovering it
      in production is not.
    """
    shapes = [
        {"scope": "transcript"},
        {"case_sensitive": True},
        {"order": ORDER_RELEVANCE},
        {"filters": BlockFilters(role="assistant")},
        {"filters": BlockFilters(block_type="tool_use", tool_name="Bash")},
        {"filters": BlockFilters(is_error=True)},
        {"resume": {"t_ingested_at": "2026-01-01T00:00:00Z", "t_id": 3,
                    "line_no": -1}},
        {"resume": {"t_ingested_at": "2026-01-01T00:00:00Z", "t_id": 3,
                    "line_no": 12}},
    ]
    for shape in shapes:
        plan = _hit_plan(conn, **shape)
        assert any(FTS_MATCH_MARKER in line for line in plan), (
            f"shape {shape} lost the FTS index; plan was:\n  "
            + "\n  ".join(plan))


def test_a_negative_control_shows_what_losing_the_index_looks_like(
    conn,
) -> None:
    """Prove the assertion can fail, by writing a query that fails it.

    Description: an assertion nobody has watched fail is an assertion
      that might be checking a substring present in every plan. This runs
      the SAME join with the MATCH replaced by a LIKE - the shape a
      well-meaning change might introduce - and confirms the marker is
      absent, so the four tests above are measuring something.
    """
    sql = (
        "SELECT cb.id FROM message_block_search f "
        "JOIN message_content_blocks cb ON cb.id = f.rowid "
        "WHERE cb.text LIKE :like"
    )
    plan = _plan(conn, sql, {"like": "%tmux%"})
    assert not any(FTS_MATCH_MARKER in line for line in plan), (
        "the control must NOT show an FTS match, or the marker is "
        f"meaningless; plan was:\n  " + "\n  ".join(plan))
