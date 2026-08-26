"""ONE inclusion rule for stored sessions: ended shows, deleted does not.

WHAT THIS MODULE IS FOR. Two surfaces disagreed about which stored
sessions they list. RECENT (``lifecycle='stopped' AND archived_at IS
NULL``) showed a session the home-screen project tree did not, and the
app read as contradicting itself. The rule these tests pin down is:

  * ENDED (``lifecycle`` is 'stopped') is SHOWN. It is a real session
    with real history; hiding it is how a user loses track of work.
  * DELETED (``archived_at IS NOT NULL``) is NOT SHOWN. It is the user
    saying "take this off my screen".

WHY THE ASSERTIONS ARE PER-SURFACE AND NOT AGAINST A SHARED HELPER.
Asserting that ``session_store.list_sessions(include_archived=False)``
filters correctly proves the helper works and proves nothing about
whether each surface CALLS it that way - which is precisely the defect
that was shipped. Every test below reaches the surface by its own name.

THE NEGATIVE CONTROL IS LOAD-BEARING. ``GET /sessions/records`` is
deliberately the one reader that DOES return archived rows (its
docstring makes that a documented contract, so a route-level filter
cannot quietly break the RUNNING guarantee for a caller that needs
everything). A test suite in which every surface hides archived rows
would pass just as happily if the column were never read at all, so this
module asserts that records still returns one - the same discipline as
running a bogus-token request beside a real one.
"""

from __future__ import annotations

from contextlib import closing

import pytest

from src.core import session_store
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.db_models import (
    SESSION_ATTRIBUTION_UNKNOWN,
    SESSION_LIFECYCLE_STOPPED,
    SESSION_LIFECYCLE_UNKNOWN,
)
from tests.lifecycle_helpers import add_row

ARCHIVED_STAMP = "2026-08-20T00:00:00.000000Z"


@pytest.fixture()
def conn(tmp_path):
    """A migrated cloude.db connection at the current schema version.

    Inputs: tmp_path (Path) - pytest's per-test directory.
    Output: sqlite3.Connection, closed on teardown.
    """
    ensure_db_migrated(tmp_path, 4, "0.8.2")
    with closing(connect(db_path_for(tmp_path))) as connection:
        yield connection


def _uuids(rows):
    """Project a list of session rows onto their session_uuid values.

    Inputs: rows (Iterable[dict]).
    Output: set[str].
    Example: _uuids([{'session_uuid': 'u1'}]) -> {'u1'}
    """
    return {str(row["session_uuid"]) for row in rows}


# ---------------------------------------------------------------------
# SURFACE 1 - RECENT (session_store.list_sessions as GET /sessions/recent
# calls it: lifecycle='stopped', include_archived=False).
# ---------------------------------------------------------------------


def test_recent_shows_an_ended_session(conn):
    """An ended session is history the user still wants; RECENT lists it."""
    add_row(
        conn,
        uuid="ended",
        name="cloude_ended",
        epoch=1000,
        lifecycle=SESSION_LIFECYCLE_STOPPED,
    )
    rows = session_store.list_sessions(
        conn, lifecycle=SESSION_LIFECYCLE_STOPPED, include_archived=False
    )
    assert "ended" in _uuids(rows)


def test_recent_hides_a_deleted_session(conn):
    """A row the user deleted is off every screen, ended or not."""
    add_row(
        conn,
        uuid="deleted",
        name="cloude_deleted",
        epoch=1001,
        lifecycle=SESSION_LIFECYCLE_STOPPED,
        archived_at=ARCHIVED_STAMP,
    )
    rows = session_store.list_sessions(
        conn, lifecycle=SESSION_LIFECYCLE_STOPPED, include_archived=False
    )
    assert "deleted" not in _uuids(rows)


# ---------------------------------------------------------------------
# SURFACE 2 - NEEDS ATTENTION (session_store.needs_attention).
#
# This is the surface the sweep found. It reads the same table and had NO
# archived clause at all, so a session the user deleted kept nagging from
# the home screen forever with no affordance to make it stop - a check
# that never clears is furniture.
# ---------------------------------------------------------------------


def test_needs_attention_shows_an_unevaluable_session(conn):
    """Positive control: the group still surfaces what it exists for."""
    add_row(
        conn,
        uuid="cannot-tell",
        name="cloude_cannot_tell",
        epoch=1002,
        lifecycle=SESSION_LIFECYCLE_UNKNOWN,
    )
    assert "cannot-tell" in _uuids(session_store.needs_attention(conn))


def test_needs_attention_hides_a_deleted_session(conn):
    """A deleted row must not keep nagging from NEEDS ATTENTION."""
    add_row(
        conn,
        uuid="deleted-unknown",
        name="cloude_deleted_unknown",
        epoch=1003,
        lifecycle=SESSION_LIFECYCLE_UNKNOWN,
        archived_at=ARCHIVED_STAMP,
    )
    assert "deleted-unknown" not in _uuids(session_store.needs_attention(conn))


def test_needs_attention_hides_a_deleted_row_with_unknown_attribution(conn):
    """The OTHER arm of the needs_attention OR must be filtered too.

    Description: the group is ``lifecycle='unknown' OR
      project_attribution='unknown'``. Filtering only the rows that
      arrive through the first arm would leave the second arm as a hole
      of exactly the same shape - the mistake this whole module exists
      to stop being repeated one clause over.
    """
    add_row(
        conn,
        uuid="deleted-attr",
        name="cloude_deleted_attr",
        epoch=1004,
        lifecycle=SESSION_LIFECYCLE_STOPPED,
        archived_at=ARCHIVED_STAMP,
    )
    conn.execute(
        "UPDATE sessions SET project_attribution = ? WHERE session_uuid = ?",
        (SESSION_ATTRIBUTION_UNKNOWN, "deleted-attr"),
    )
    assert "deleted-attr" not in _uuids(session_store.needs_attention(conn))


# ---------------------------------------------------------------------
# SURFACE 3 - the project tree's data source. The tree is rendered in the
# browser, but the rows it merges in come from ONE server call, and this
# is the assertion that the call can carry an ended session at all.
# ---------------------------------------------------------------------


def test_listable_sessions_carries_ended_and_running_and_drops_deleted(conn):
    """The tree's feed: every lifecycle, minus what the user deleted."""
    add_row(conn, uuid="live", name="cloude_live", epoch=2000)
    add_row(
        conn,
        uuid="over",
        name="cloude_over",
        epoch=2001,
        lifecycle=SESSION_LIFECYCLE_STOPPED,
    )
    add_row(
        conn,
        uuid="gone",
        name="cloude_gone",
        epoch=2002,
        lifecycle=SESSION_LIFECYCLE_STOPPED,
        archived_at=ARCHIVED_STAMP,
    )
    got = _uuids(session_store.listable_sessions(conn))
    assert got == {"live", "over"}


def test_listable_sessions_is_empty_on_a_pre_v2_database(tmp_path):
    """An absent sessions table is an empty list, never an exception."""
    with closing(connect(db_path_for(tmp_path), create=True)) as fresh:
        assert session_store.listable_sessions(fresh) == []


# ---------------------------------------------------------------------
# NEGATIVE CONTROL - the one surface that must NOT filter.
# ---------------------------------------------------------------------


def test_records_still_returns_archived_rows(conn):
    """GET /sessions/records keeps its documented all-rows contract.

    Without this, every other assertion in this module would hold just
    as well on a build where ``archived_at`` was never written or read -
    a suite that cannot tell those apart is not measuring anything.
    """
    add_row(
        conn,
        uuid="archived",
        name="cloude_archived",
        epoch=3000,
        lifecycle=SESSION_LIFECYCLE_STOPPED,
        archived_at=ARCHIVED_STAMP,
    )
    assert "archived" in _uuids(session_store.list_sessions(conn))
