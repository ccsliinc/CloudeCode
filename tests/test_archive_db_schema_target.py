"""Archive DDL must land in exactly one file, and the right one.

THE FAILURE THIS GUARDS, MEASURED ON LIVE 2026-09-14. After the split
moved ``message_*`` into the archive and dropped it from ``cloude.db``,
the server's own self-heal (``apply_message_model_schema``, which runs on
every enabled start by design) recreated 23 of those objects IN MAIN. Both
files then held them, sqlite resolves an unqualified name to main, and
every archive read would have come from the empty copy.

TWO INSTALLS, BOTH MUST END WITH THE TABLES IN EXACTLY ONE PLACE:

  fresh   no archive file yet -> DDL goes to main, unchanged behaviour
  split   archive attached    -> DDL goes to the archive, nothing in main

The split case makes the two databases DIFFER by giving them
distinguishable marker rows, so an assertion cannot be satisfied by the
files being identical.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from src.core.archive_db_partition import ARCHIVE_SCHEMA, archive_db_path_for
from src.core.archive_db_schema_target import (
    archive_schema_if_attached,
    execute_archive_ddl,
    qualify_ddl,
)
from src.core.db import connect, db_path_for
from tests.test_archive_db_split import build_state

SAMPLE_DDL = (
    "CREATE TABLE IF NOT EXISTS message_probe (id INTEGER PRIMARY KEY, who TEXT)",
    "CREATE INDEX IF NOT EXISTS ix_message_probe_who ON message_probe(who)",
)


def _objects(path: Path) -> set:
    """Name every table and index in one database file.

    Inputs: path (Path).
    Output: set[str].
    """
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return {
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
            )
        }
    finally:
        conn.close()


# ------------------------------------------------------------- the rewrite


@pytest.mark.parametrize(
    "statement, expected_name",
    [
        ("CREATE TABLE IF NOT EXISTS t (a INTEGER)", "t"),
        ("CREATE TABLE t (a INTEGER)", "t"),
        ('CREATE TABLE "t" (a INTEGER)', "t"),
        ("CREATE TABLE 't' (a INTEGER)", "t"),
        ("CREATE UNIQUE INDEX IF NOT EXISTS ix ON t(a)", "ix"),
        ("CREATE VIEW v AS SELECT 1", "v"),
        ("CREATE VIRTUAL TABLE fts USING fts5(x)", "fts"),
    ],
)
def test_every_spelling_is_qualified(statement: str, expected_name: str) -> None:
    """All five identifier quotings mean one identifier, and all are handled.

    The single-quoted form is the one that matters most: sqlite stores
    fts5 shadow DDL that way, and a rewrite that missed it is what put
    four junk tables in a live database.
    """
    out = qualify_ddl(statement, ARCHIVE_SCHEMA)
    assert out is not None
    assert f'{ARCHIVE_SCHEMA}."{expected_name}"' in out
    # the body is untouched: an index's ON and a view's FROM resolve
    # inside the schema the object was created in, which is what we want
    assert out.count(ARCHIVE_SCHEMA) == 1


def test_an_alter_is_passed_through_explicitly() -> None:
    """ALTER resolves to the attached schema on its own, and is allowed."""
    stmt = "ALTER TABLE message_transcripts ADD COLUMN host_id INTEGER"
    assert qualify_ddl(stmt, ARCHIVE_SCHEMA) == stmt


def test_no_schema_is_a_no_op_not_an_error() -> None:
    """The fresh-install case must behave exactly as before."""
    stmt = "CREATE TABLE IF NOT EXISTS t (a INTEGER)"
    assert qualify_ddl(stmt, None) == stmt


@pytest.mark.parametrize("statement", [
    "SELECT 1",
    "DROP TABLE t",
    "CREATE TABLE archive.t (a INTEGER)",
    "-- a comment only",
])
def test_anything_unrecognised_refuses_rather_than_guessing(
    statement: str,
) -> None:
    """NEGATIVE CONTROL for the whole module.

    The alternative, rewriting whatever looks close enough, is precisely
    what created four junk tables named ``archive.message_block_search_*``
    in the owner's live cloude.db.
    """
    assert qualify_ddl(statement, ARCHIVE_SCHEMA) is None


def test_execute_refuses_and_writes_nothing(tmp_path: Path) -> None:
    """A refusal must not half-apply the batch it was given."""
    state = build_state(tmp_path)
    archive = archive_db_path_for(state)
    sqlite3.connect(archive).close()
    conn = connect(db_path_for(state))
    try:
        assert archive_schema_if_attached(conn) == ARCHIVE_SCHEMA
        with pytest.raises(sqlite3.OperationalError, match="refusing"):
            execute_archive_ddl(conn, ["DROP TABLE nope"])
    finally:
        conn.close()


# ------------------------------------------------------------- both installs


def test_a_fresh_install_puts_archive_ddl_in_main(tmp_path: Path) -> None:
    """No archive file means unchanged behaviour: the tables go to main."""
    state = build_state(tmp_path)
    assert not archive_db_path_for(state).exists()
    conn = connect(db_path_for(state))
    try:
        assert archive_schema_if_attached(conn) is None
        assert execute_archive_ddl(conn, SAMPLE_DDL) == 0
    finally:
        conn.close()
    assert "message_probe" in _objects(db_path_for(state))
    assert not archive_db_path_for(state).exists()


def test_a_split_install_puts_archive_ddl_in_the_archive(
    tmp_path: Path,
) -> None:
    """THE FIX. With an archive attached, nothing lands in main.

    The two files are made to DIFFER first: main gets a marker table the
    archive does not have. Without that, "the object is present" could be
    satisfied by either file and the test would prove nothing.
    """
    state = build_state(tmp_path)
    archive = archive_db_path_for(state)
    seed = sqlite3.connect(archive, isolation_level=None)
    seed.execute("CREATE TABLE archive_only_marker (x INTEGER)")
    seed.close()
    main_before = _objects(db_path_for(state))
    assert "archive_only_marker" not in main_before  # the files DIFFER

    conn = connect(db_path_for(state))
    try:
        assert archive_schema_if_attached(conn) == ARCHIVE_SCHEMA
        assert execute_archive_ddl(conn, SAMPLE_DDL) == len(SAMPLE_DDL)
    finally:
        conn.close()

    main_after = _objects(db_path_for(state))
    archive_after = _objects(archive)
    assert "message_probe" in archive_after, "the DDL did not reach the archive"
    assert "message_probe" not in main_after, (
        "the DDL landed in main as well, which is the shadowing this "
        "module exists to prevent"
    )
    assert "ix_message_probe_who" in archive_after
    assert "ix_message_probe_who" not in main_after
    # exactly one place
    assert len(archive_after & {"message_probe"}) == 1
    assert main_after == main_before


def test_the_self_heal_no_longer_shadows_after_a_real_split(
    tmp_path: Path,
) -> None:
    """END TO END, the exact live failure.

    Run the real migration, then run the real self-heal the server runs on
    every start, and assert nothing is shadowed afterwards. Before the
    fix this left 23 objects in both files.
    """
    from src.core.archive_db_attach import shadowed_tables
    from src.core.archive_db_split_run import run_split
    from src.core.db_steps import apply_message_model_schema

    state = build_state(tmp_path, archives=4)
    assert not run_split(state, apply=True, content_sample=4).refused

    conn = connect(db_path_for(state))
    try:
        assert shadowed_tables(conn) == []
        conn.execute("BEGIN")
        apply_message_model_schema(conn)
        conn.execute("COMMIT")
        assert shadowed_tables(conn) == [], (
            "the boot self-heal recreated archive tables in main; every "
            "archive read would now come from the empty copy"
        )
    finally:
        conn.close()

    # and the model really is present, in the archive, not merely absent
    archive_objects = _objects(archive_db_path_for(state))
    assert "message_transcripts" in archive_objects
    assert "message_transcripts" not in _objects(db_path_for(state))
