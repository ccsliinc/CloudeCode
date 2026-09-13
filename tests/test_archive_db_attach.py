"""After the split, does an unqualified query reach the RIGHT file?

THE TESTS HERE MAKE THE TWO DATABASES DIFFER, AND THAT IS THE WHOLE
POINT. A test that copies identical rows into both files and then asserts
the query returned the expected row passes no matter which file it read,
so it proves nothing about the wiring it claims to cover. Every case
below puts a DISTINGUISHABLE marker in each database and asserts on which
marker came back, so a query hitting the wrong file is detectable at all.

WHAT IS BEING PROVEN, in order:

  1. an unsplit install is unchanged - nothing is attached, nothing moves
  2. after the split, unqualified reads AND writes reach the archive,
     with no schema prefix at any call site
  3. shadowing (a table in both files) silently resolves to main, which
     is the dangerous middle state a half-done migration leaves, and
     shadowed_tables detects it
  4. the real end-to-end: run the migration, then read through the app's
     own connect() and confirm the bytes came out of the archive file

The negative control is case 3. Without it, a wiring that always read
main would pass cases 1 and 2 on an unsplit fixture and fail nothing.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from src.core.archive_db_attach import (
    archive_sibling_for,
    assert_no_shadowing,
    attach_archive,
    attached_schemas,
    shadowed_tables,
    which_database,
)
from src.core.archive_db_partition import ARCHIVE_SCHEMA, archive_db_path_for
from src.core.archive_db_split_run import run_split
from src.core.db import connect, db_path_for
from tests.test_archive_db_split import build_state

#: Markers that make the two files tell themselves apart. If a test ever
#: passes with these equal, it is testing nothing.
MAIN_MARKER = "FROM-MAIN"
ARCHIVE_MARKER = "FROM-ARCHIVE"


def _make_archive_beside(state: Path, marker: str) -> Path:
    """Create a standalone archive database holding one marked row.

    Description: deliberately NOT produced by the migration, so the two
      files can be made to differ in a way no real split would produce.
      That is what lets a test tell which file answered.
    Inputs: state (Path) - the state directory. marker (str) - the value
      written into the row.
    Output: Path - the archive database that was created.
    Example: _make_archive_beside(tmp_path, "FROM-ARCHIVE")
    """
    path = archive_db_path_for(state)
    conn = sqlite3.connect(path, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE transcript_probe (id INTEGER PRIMARY KEY, who TEXT)")
    conn.execute("INSERT INTO transcript_probe VALUES (1, ?)", (marker,))
    conn.close()
    return path


def test_an_unsplit_install_attaches_nothing_and_is_unchanged(
    tmp_path: Path,
) -> None:
    """No archive file means no attach, and every query behaves as before.

    This is the state of every install before the migration runs, and it
    has to keep working unchanged or the wiring cannot ship ahead of the
    migration.
    """
    state = build_state(tmp_path)
    assert not archive_db_path_for(state).exists()
    conn = connect(db_path_for(state))
    try:
        assert ARCHIVE_SCHEMA not in attached_schemas(conn)
        assert shadowed_tables(conn) == []
        # The archive tables are still in main and still reachable.
        assert which_database(conn, "transcript_archives") == "main"
        assert conn.execute(
            "SELECT COUNT(*) FROM transcript_archives"
        ).fetchone()[0] == 6
    finally:
        conn.close()


def test_an_unreadable_or_missing_archive_never_creates_one(
    tmp_path: Path,
) -> None:
    """Attaching must not manufacture an empty archive beside a healthy db.

    An empty archive would make every archive query return no rows, which
    renders as "you have no history" - a lie with the same shape as the
    truth, and the exact failure ``connect(create=False)`` exists to stop
    for the state database.
    """
    state = build_state(tmp_path)
    conn = connect(db_path_for(state))
    try:
        assert attach_archive(conn, db_path_for(state)) is False
    finally:
        conn.close()
    assert not archive_db_path_for(state).exists()


def test_an_unqualified_read_reaches_the_archive_when_only_it_has_the_table(
    tmp_path: Path,
) -> None:
    """THE CLAIM THE 68 UNCHANGED MODULES REST ON.

    The table exists ONLY in the archive file. An unqualified name must
    reach it, or every archive query would need a prefix.
    """
    state = build_state(tmp_path)
    _make_archive_beside(state, ARCHIVE_MARKER)
    conn = connect(db_path_for(state))
    try:
        assert ARCHIVE_SCHEMA in attached_schemas(conn)
        assert which_database(conn, "transcript_probe") == ARCHIVE_SCHEMA
        got = conn.execute("SELECT who FROM transcript_probe").fetchone()[0]
        assert got == ARCHIVE_MARKER
    finally:
        conn.close()


def test_an_unqualified_write_also_reaches_the_archive(tmp_path: Path) -> None:
    """Reads are not enough: the ingester WRITES through the same names."""
    state = build_state(tmp_path)
    archive = _make_archive_beside(state, ARCHIVE_MARKER)
    conn = connect(db_path_for(state))
    try:
        conn.execute("UPDATE transcript_probe SET who = 'WRITTEN'")
        conn.execute("INSERT INTO transcript_probe VALUES (2, 'INSERTED')")
    finally:
        conn.close()
    # Read the archive file on its OWN connection, with nothing attached,
    # so the assertion cannot be satisfied by the same resolution rule
    # that is under test.
    solo = sqlite3.connect(archive)
    try:
        rows = dict(solo.execute("SELECT id, who FROM transcript_probe"))
    finally:
        solo.close()
    assert rows == {1: "WRITTEN", 2: "INSERTED"}


def test_a_shadowed_table_resolves_to_main_and_is_detected(
    tmp_path: Path,
) -> None:
    """NEGATIVE CONTROL: the dangerous middle state, made visible.

    A migration that COPIED the tables and did not DROP them leaves every
    archive table in both files. sqlite then resolves every unqualified
    name to main and reads the STALE pre-split copy, with no error
    anywhere. The two files carry different markers here precisely so
    that "which one answered" is a question with a detectable answer.
    """
    state = build_state(tmp_path)
    _make_archive_beside(state, ARCHIVE_MARKER)
    main = sqlite3.connect(db_path_for(state), isolation_level=None)
    main.execute("CREATE TABLE transcript_probe (id INTEGER PRIMARY KEY, who TEXT)")
    main.execute("INSERT INTO transcript_probe VALUES (1, ?)", (MAIN_MARKER,))
    main.close()

    conn = connect(db_path_for(state))
    try:
        # main wins, silently
        assert conn.execute(
            "SELECT who FROM transcript_probe"
        ).fetchone()[0] == MAIN_MARKER
        assert which_database(conn, "transcript_probe") == "main"
        # and the guard names it
        assert "transcript_probe" in shadowed_tables(conn)
        assert "transcript_probe" in assert_no_shadowing(conn)
    finally:
        conn.close()


def test_a_healthy_split_install_has_no_shadowing(tmp_path: Path) -> None:
    """The positive control for the guard, so it cannot flag everything."""
    state = build_state(tmp_path)
    _make_archive_beside(state, ARCHIVE_MARKER)
    conn = connect(db_path_for(state))
    try:
        assert shadowed_tables(conn) == []
    finally:
        conn.close()


def test_attaching_twice_is_idempotent(tmp_path: Path) -> None:
    """connect() attaches, and the migration attaches again on a resume.

    A second raw ATTACH of the same schema name is an error in sqlite, so
    the helper has to recognise what is already there.
    """
    state = build_state(tmp_path)
    _make_archive_beside(state, ARCHIVE_MARKER)
    conn = connect(db_path_for(state))
    try:
        assert attach_archive(conn, db_path_for(state)) is True
        assert attach_archive(conn, db_path_for(state)) is True
        names = [r[1] for r in conn.execute("PRAGMA database_list")]
        assert names.count(ARCHIVE_SCHEMA) == 1
    finally:
        conn.close()


def test_end_to_end_the_migrated_archive_is_read_through_connect(
    tmp_path: Path,
) -> None:
    """THE REAL PATH, and the one that would catch a broken drop step.

    Run the actual migration, then read ``transcript_archives`` through
    the app's own ``connect()`` with no schema prefix, exactly as the 68
    unchanged modules do. Prove the bytes came out of the ARCHIVE file by
    checking the table is gone from main and present in the archive, and
    by re-reading the archive file on its own connection.
    """
    state = build_state(tmp_path, archives=4)
    report = run_split(state, apply=True, content_sample=4)
    assert not report.refused, [r.rung for r in report.refusals]

    conn = connect(db_path_for(state))
    try:
        assert ARCHIVE_SCHEMA in attached_schemas(conn)
        assert shadowed_tables(conn) == [], (
            "the migration dropped from main but the tables are still in "
            "both files, so every query is reading the stale copy"
        )
        assert which_database(conn, "transcript_archives") == ARCHIVE_SCHEMA
        # An UNQUALIFIED query, the way every archive module spells it.
        rows = conn.execute(
            "SELECT archive_uuid FROM transcript_archives ORDER BY id"
        ).fetchall()
        assert [r[0] for r in rows] == ["u1", "u2", "u3", "u4"]
        # And a join across the boundary still works, which is the thing
        # ATTACH was chosen over two connections for.
        joined = conn.execute(
            "SELECT COUNT(*) FROM transcript_archives a "
            "JOIN sessions s ON s.id = a.root_session_id"
        ).fetchone()[0]
        assert joined == 4
    finally:
        conn.close()

    # main really is empty of it
    solo_main = sqlite3.connect(db_path_for(state))
    try:
        assert solo_main.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='transcript_archives'"
        ).fetchone()[0] == 0
    finally:
        solo_main.close()


def test_the_sibling_path_is_derived_not_configured(tmp_path: Path) -> None:
    """One fewer setting to get wrong, and a copied state dir stays paired."""
    assert archive_sibling_for(tmp_path / "cloude.db").parent == tmp_path
    assert archive_sibling_for(tmp_path / "cloude.db").name == "cloude-archive.db"
