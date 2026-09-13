"""The archive split: it must refuse on a measured defect, never half-do.

THE LOAD-BEARING TEST IN THIS FILE IS THE NEGATIVE CONTROL, and it is
:func:`test_refuses_when_a_crossing_reference_survives`. A migration that
completes is easy to test and proves very little. What has to be proven
is that a migration which CANNOT be completed correctly leaves the source
exactly where it found it, because the alternative is silent data loss on
a five gigabyte live database.

That control was WATCHED RED before it was trusted green: with the
``CONSTRAINT_NOT_STRIPPED`` rung disabled, the run completes, reports
success, drops the source tables, and leaves an archive whose three
re-homed tables refuse every INSERT for the life of the file. See
``docs/history-archive-db-split.md`` for the transcript of that run.

WHY A REAL SQLITE AND NOT A DOUBLE. Every claim here is about sqlite's
own behaviour: what it accepts at DDL time versus DML time, what
``foreign_key_check`` reports, and what order a DROP is legal in. A
double agrees with whatever it was built to agree with, so all of this
runs against real files on a tmp_path.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Tuple

import pytest

from src.core.archive_db_ddl import (
    residual_app_references,
    restore_crossing_references,
    strip_crossing_references,
)
from src.core.archive_db_partition import (
    ARCHIVE_SCHEMA,
    EXPECTED_CROSSING_FKS,
    SIDE_APP,
    SIDE_ARCHIVE,
    SIDE_UNCLASSIFIED,
    archive_db_path_for,
    classify_objects,
    crossing_foreign_keys,
    orphaned_reference_counts,
    side_for_table,
    unclassified_objects,
)
from src.core.archive_db_copy import copy_table, drop_order
from src.core.archive_db_split import VERIFIED_SCHEMA_VERSIONS
from src.core.archive_db_split_refusals import (
    CONSTRAINT_NOT_STRIPPED,
    COUNT_MISMATCH,
    CROSSING_FK_SET_CHANGED,
    DEST_FK_VIOLATIONS,
    KIND_MEASURED,
    KIND_UNCHECKED,
    ORPHANED_REFERENCE,
    SCHEMA_VERSION_UNEXPECTED,
    UNCLASSIFIED_OBJECT,
    blocking,
    predrop_refusals,
    preflight_refusals,
)
from src.core.archive_db_split_run import run_split
from src.core.archive_db_unsplit import run_unsplit

# The real crossing columns, spelled as the live schema spells them.
APP_DDL = (
    "CREATE TABLE sessions (id INTEGER PRIMARY KEY, title TEXT)",
    "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)",
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
)

ARCHIVE_DDL = (
    "CREATE TABLE transcript_archives ("
    " id INTEGER PRIMARY KEY,"
    " archive_uuid TEXT NOT NULL UNIQUE,"
    " content_gzip BLOB NOT NULL,"
    " content_sha256 TEXT NOT NULL,"
    " parent_archive_id INTEGER REFERENCES transcript_archives(id),"
    " root_session_id INTEGER REFERENCES sessions(id),"
    " project_id INTEGER REFERENCES projects(id))",
    "CREATE TABLE transcript_records ("
    " id INTEGER PRIMARY KEY,"
    " archive_id INTEGER NOT NULL"
    "  REFERENCES transcript_archives(id) ON DELETE CASCADE,"
    " line_no INTEGER NOT NULL)",
    "CREATE TABLE transcript_root_decisions ("
    " id INTEGER PRIMARY KEY,"
    " archive_id INTEGER NOT NULL REFERENCES transcript_archives(id),"
    " project_id INTEGER REFERENCES projects(id),"
    " note TEXT)",
)


def build_state(tmp_path: Path, *, archives: int = 6) -> Path:
    """Create a small cloude.db with the real crossing-key shape.

    Description: a synthetic but structurally faithful source database:
      the three crossing foreign keys, one archive-internal cascade, one
      self-reference, and populated values on every crossing column so a
      migration that dropped them would be caught by content rather than
      by arity alone.

      IT CARRIES FORWARD SELF-REFERENCES ON PURPOSE, and it did not
      until a full-scale rehearsal against the owner's real 5.57 GB
      database died with "FOREIGN KEY constraint failed". The copy walks
      rowid order, so a row whose ``parent_archive_id`` points at a
      HIGHER id is inserted before its parent exists. The live data holds
      16,387 such forward references; this fixture held ZERO, because it
      was originally built by filtering exactly those rows out to get a
      clean subset. A fixture that cannot contain the failure cannot
      catch it, and this one now can.
    Inputs: tmp_path (Path), archives (int) - how many archive rows.
    Output: Path - the state directory holding cloude.db.
    Example: build_state(tmp_path)
    """
    state = tmp_path / "state"
    state.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(state / "cloude.db", isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    for ddl in APP_DDL + ARCHIVE_DDL:
        conn.execute(ddl)
    conn.execute("INSERT INTO meta VALUES ('schema_version','25')")
    conn.execute("INSERT INTO meta VALUES ('install_id','test-install')")
    for i in range(1, 4):
        conn.execute("INSERT INTO sessions VALUES (?,?)", (i, f"s{i}"))
        conn.execute("INSERT INTO projects VALUES (?,?)", (i, f"p{i}"))
    for i in range(1, archives + 1):
        conn.execute(
            "INSERT INTO transcript_archives "
            "(id, archive_uuid, content_gzip, content_sha256,"
            " root_session_id, project_id) VALUES (?,?,?,?,?,?)",
            (i, f"u{i}", bytes([i % 256]) * 512, f"sha{i}",
             (i % 3) + 1, (i % 3) + 1),
        )
        conn.execute(
            "INSERT INTO transcript_records (archive_id, line_no) VALUES (?,?)",
            (i, 1),
        )
        conn.execute(
            "INSERT INTO transcript_root_decisions (archive_id, project_id, note)"
            " VALUES (?,?,?)", (i, (i % 3) + 1, f"n{i}"),
        )
    # FORWARD self-references, pointing at the LAST row rather than the
    # next one. The distance is the point: a reference to the very next
    # row lands inside the same chunk, and one chunk is one
    # ``INSERT ... SELECT`` whose foreign keys sqlite checks at STATEMENT
    # END, so a short hop resolves and proves nothing. Pointing at the
    # final row guarantees the reference crosses a chunk boundary at any
    # chunk size smaller than the table, which is the shape the live
    # database actually failed on.
    #
    # Written after the inserts with enforcement deferred, because the
    # fixture cannot create a forward reference in one pass either.
    conn.execute("PRAGMA foreign_keys=OFF")
    for i in range(1, archives, 2):
        conn.execute(
            "UPDATE transcript_archives SET parent_archive_id=? WHERE id=?",
            (archives, i),
        )
    conn.execute("PRAGMA foreign_keys=ON")
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == [], (
        "the fixture itself is not referentially sound"
    )
    conn.close()
    return state


@pytest.fixture()
def state(tmp_path: Path) -> Path:
    """A fresh source database for one test.

    Inputs: tmp_path (Path) - pytest's per-test directory.
    Output: Path - the state directory.
    """
    return build_state(tmp_path)


def _open(state_dir: Path) -> sqlite3.Connection:
    """Open the state database with this app's pragmas.

    Inputs: state_dir (Path).
    Output: sqlite3.Connection.
    """
    conn = sqlite3.connect(state_dir / "cloude.db", isolation_level=None)
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ---------------------------------------------------------------- partition


def test_the_partition_places_every_table_and_guesses_none(state: Path) -> None:
    """Every table lands on a side, and nothing is unclassified."""
    with _open(state) as conn:
        objects = classify_objects(conn)
        assert unclassified_objects(objects) == []
        sides = {o.name: o.side for o in objects}
    assert sides["sessions"] == SIDE_APP
    assert sides["projects"] == SIDE_APP
    assert sides["transcript_archives"] == SIDE_ARCHIVE
    assert sides["transcript_records"] == SIDE_ARCHIVE


def test_an_unknown_table_is_unclassified_rather_than_defaulted() -> None:
    """A name matching neither rule refuses instead of picking a side."""
    assert side_for_table("something_new") == SIDE_UNCLASSIFIED
    # And the FTS5 shadow tables nobody declares are still caught.
    assert side_for_table("message_block_search_data") == SIDE_ARCHIVE


def test_exactly_three_foreign_keys_cross_and_none_are_orphaned(state: Path) -> None:
    """The measured crossing set matches what the migration expects."""
    with _open(state) as conn:
        crossings = crossing_foreign_keys(conn)
        assert tuple(sorted(crossings)) == EXPECTED_CROSSING_FKS
        assert set(orphaned_reference_counts(conn, crossings).values()) == {0}


# ---------------------------------------------------------------- the DDL trap


def test_an_unstripped_cross_database_reference_is_the_silent_trap(
    tmp_path: Path,
) -> None:
    """NEGATIVE CONTROL for the whole design, measured against real sqlite.

    Proves the three facts that make ``probe_writability`` mandatory: the
    unqualified DDL is ACCEPTED, every insert is then REFUSED, and
    ``foreign_key_check`` reports the table as clean anyway.
    """
    main, arch = tmp_path / "m.db", tmp_path / "a.db"
    conn = sqlite3.connect(main, isolation_level=None)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY)")
    conn.execute("INSERT INTO sessions VALUES (1)")
    conn.execute(f"ATTACH DATABASE '{arch}' AS {ARCHIVE_SCHEMA}")

    # 1. the DDL is accepted, which is what the scope doc did not expect
    conn.execute(
        f"CREATE TABLE {ARCHIVE_SCHEMA}.t "
        "(id INTEGER PRIMARY KEY, sid INTEGER REFERENCES sessions(id))"
    )

    # 2. and every insert fails, even one whose parent exists in main
    with pytest.raises(sqlite3.OperationalError, match="no such table"):
        conn.execute(f"INSERT INTO {ARCHIVE_SCHEMA}.t VALUES (1, 1)")

    # 3. and the integrity pragma says nothing about it
    assert conn.execute(f"PRAGMA {ARCHIVE_SCHEMA}.foreign_key_check").fetchall() == []
    conn.close()


def test_stripping_removes_only_app_references(state: Path) -> None:
    """Crossing keys go; archive-internal keys and the cascade stay."""
    with _open(state) as conn:
        sql = dict(conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table'"
        ))
    stripped, removed = strip_crossing_references(sql["transcript_archives"])
    assert sorted(removed) == ["projects", "sessions"]
    assert residual_app_references(stripped) == []
    assert "transcript_archives(id)" in stripped      # self-reference kept

    stripped_records, removed_records = strip_crossing_references(
        sql["transcript_records"]
    )
    assert removed_records == []
    assert "ON DELETE CASCADE" in stripped_records


def test_restoring_puts_the_constraints_back(state: Path) -> None:
    """The reverse transformation re-imposes what the forward removed."""
    with _open(state) as conn:
        sql = dict(conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table'"
        ))
    stripped, _ = strip_crossing_references(sql["transcript_archives"])
    restored = restore_crossing_references(
        stripped, [("root_session_id", "sessions"), ("project_id", "projects")]
    )
    assert residual_app_references(restored) != []


# ---------------------------------------------------------------- drop order


def test_drop_order_puts_children_before_parents(state: Path) -> None:
    """The order is derived from the FK graph, not from the alphabet.

    An alphabetical order was measured wrong on real data: it died on
    ``message_bodies`` because ``message_content_blocks`` referenced both
    it and an already-dropped table.
    """
    with _open(state) as conn:
        order = drop_order(conn, [
            "transcript_archives", "transcript_records",
            "transcript_root_decisions",
        ])
    assert order.index("transcript_records") < order.index("transcript_archives")
    assert order.index("transcript_root_decisions") < order.index(
        "transcript_archives"
    )


# ---------------------------------------------------------------- the ladder


def _preflight(**over) -> list:
    """Run the pre-flight ladder with everything clean except an override.

    Inputs: over (kwargs) - fields to replace.
    Output: list[Refusal].
    """
    kwargs = dict(
        source_integrity="ok", schema_version=25,
        expected_schema_version=VERIFIED_SCHEMA_VERSIONS,
        unclassified=[], crossings=list(EXPECTED_CROSSING_FKS),
        expected_crossings=list(EXPECTED_CROSSING_FKS), orphans={},
        destination_state="absent", free_bytes=10 ** 13, archive_bytes=1,
    )
    kwargs.update(over)
    return preflight_refusals(**kwargs)


def test_a_clean_preflight_refuses_nothing() -> None:
    """The positive control: without it, a ladder that always refuses passes."""
    assert _preflight() == []


@pytest.mark.parametrize("version", sorted(VERIFIED_SCHEMA_VERSIONS))
def test_every_measured_schema_version_is_accepted(version: int) -> None:
    """The other half of the version rung, so it cannot refuse everything.

    v25 is the read-only backup every figure in the docs came from. v26
    and v27 were checked by migrating a fresh database through the app's
    own chain and re-running the partition against the result: zero
    unclassified objects, and the same three crossing keys.
    """
    assert _preflight(schema_version=version) == []


@pytest.mark.parametrize(
    "override, rung",
    [
        # A version nobody has measured. 25, 26 and 27 are in
        # VERIFIED_SCHEMA_VERSIONS and must NOT refuse; see the positive
        # control below.
        ({"schema_version": 99}, SCHEMA_VERSION_UNEXPECTED),
        ({"unclassified": ["mystery_table"]}, UNCLASSIFIED_OBJECT),
        ({"crossings": []}, CROSSING_FK_SET_CHANGED),
        ({"orphans": {"transcript_archives.project_id": 4}}, ORPHANED_REFERENCE),
    ],
)
def test_each_measured_defect_refuses(override: dict, rung: str) -> None:
    """Every measured pre-flight defect blocks, and names itself."""
    refusals = _preflight(**override)
    assert rung in [r.rung for r in refusals]
    assert all(r.kind == KIND_MEASURED for r in refusals if r.rung == rung)
    assert blocking(refusals)


def test_an_unmeasurable_volume_records_but_does_not_refuse() -> None:
    """UNCHECKED is not a refusal: not having looked is not evidence."""
    refusals = _preflight(free_bytes=None)
    assert [r.kind for r in refusals] == [KIND_UNCHECKED]
    assert blocking(refusals) == []


def test_a_measured_disk_shortfall_does_refuse() -> None:
    """The other half of that asymmetry, so the direction is pinned."""
    refusals = _preflight(free_bytes=1, archive_bytes=10 ** 12)
    assert blocking(refusals)


# ---------------------------------------------------------------- end to end


def test_dry_run_is_the_default_and_writes_nothing(state: Path) -> None:
    """No destination file, no dropped table, on a plain call."""
    report = run_split(state)
    assert report.apply is False
    assert not report.refused
    assert report.dropped == []
    assert not archive_db_path_for(state).exists()
    with _open(state) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM transcript_archives"
        ).fetchone()[0] == 6


def test_apply_moves_the_archive_and_leaves_the_app_state(state: Path) -> None:
    """The forward split, verified by count and by content on both sides."""
    report = run_split(state, apply=True, content_sample=6)
    assert not report.refused, [r.rung for r in report.refusals]
    assert report.content_checked == 6
    assert report.content_mismatches == []

    with _open(state) as conn:
        remaining = {
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    assert remaining == {"sessions", "projects", "meta"}

    arch = sqlite3.connect(archive_db_path_for(state))
    assert arch.execute("SELECT COUNT(*) FROM transcript_archives").fetchone()[0] == 6
    # the crossing columns kept their VALUES, they only lost the constraint
    assert arch.execute(
        "SELECT COUNT(*) FROM transcript_archives WHERE root_session_id IS NOT NULL"
    ).fetchone()[0] == 6
    parents = {
        r[2] for r in arch.execute("PRAGMA foreign_key_list('transcript_archives')")
    }
    assert parents == {"transcript_archives"}
    assert arch.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    arch.close()


def test_the_split_archive_is_actually_writable(state: Path) -> None:
    """The check the DDL string cannot give: a real INSERT must land."""
    run_split(state, apply=True, content_sample=2)
    arch = sqlite3.connect(archive_db_path_for(state), isolation_level=None)
    arch.execute("PRAGMA foreign_keys=ON")
    arch.execute(
        "INSERT INTO transcript_archives "
        "(archive_uuid, content_gzip, content_sha256, root_session_id, project_id)"
        " VALUES ('new', X'00', 'sha', 999, 999)"
    )
    assert arch.execute(
        "SELECT COUNT(*) FROM transcript_archives"
    ).fetchone()[0] == 7
    arch.close()


def test_refuses_when_a_crossing_reference_survives(
    state: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE LOAD-BEARING NEGATIVE CONTROL.

    Simulate the rewriter failing to strip the crossing references, which
    is the failure sqlite reports nowhere: the DDL is accepted, the
    integrity pragma is clean, and every insert fails forever. The
    migration must REFUSE and must leave the source tables in place.

    WATCHED RED FIRST, and the observed failure is recorded exactly as it
    happened rather than as it was predicted. With the
    ``CONSTRAINT_NOT_STRIPPED`` rung disabled this test fails on
    ``assert report.refused``, and the report carries
    ``write_probe_failures={'transcript_archives': 'no such table:
    archive.projects'}`` beside ``refusals=[]`` and ``refused=False``:
    the run reports SUCCESS while holding, in its own hand, the proof
    that the archive it just built can never be written to.

    It does not reach the drop, because ``_apply_split`` returns early on
    a probe failure whether or not the rung refuses. That early return is
    defence in depth and NOT the thing under test: without the rung the
    caller is told the migration succeeded, and the next thing to run
    would be the operator deleting a backup.
    """
    monkeypatch.setattr(
        "src.core.archive_db_split.strip_crossing_references",
        lambda sql: (sql, ["sessions"] if "sessions(id)" in sql else []),
    )
    # The static guard would also catch this, so take it out of the way:
    # what is under test is the WRITE PROBE, which is the only check that
    # works when the DDL string looks plausible.
    monkeypatch.setattr(
        "src.core.archive_db_split.residual_app_references", lambda sql: []
    )

    report = run_split(state, apply=True)

    assert report.refused
    assert CONSTRAINT_NOT_STRIPPED in [r.rung for r in report.refusals]
    assert report.dropped == []
    with _open(state) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM transcript_archives"
        ).fetchone()[0] == 6
        assert conn.execute(
            "SELECT COUNT(*) FROM transcript_records"
        ).fetchone()[0] == 6


def test_an_interrupted_copy_resumes_rather_than_dying_on_its_own_tables(
    state: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REGRESSION. A resumed run must not trip over the schema it created.

    The DDL is read out of ``sqlite_master`` verbatim and therefore
    carries no ``IF NOT EXISTS``, so a second run raised
    ``table archive_project_overlay already exists`` and the whole
    migration died on the first object, leaving the source intact but the
    operation permanently stuck. Found by SIGKILLing a real 443 MB copy
    mid-flight, which is the only way it surfaces: every clean run creates
    the schema exactly once.

    Here the interruption is simulated by failing the copy partway, which
    leaves the archive schema and the progress rows on disk exactly as a
    kill would.
    """
    calls = {"n": 0}

    def flaky(conn, table, install_id):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("interrupted mid-copy")
        return copy_table(conn, table, install_id)

    monkeypatch.setattr("src.core.archive_db_split_run.copy_table", flaky)
    with pytest.raises(RuntimeError):
        run_split(state, apply=True)

    # The schema and at least one table's progress survive the interruption.
    assert archive_db_path_for(state).exists()
    with _open(state) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM transcript_archives"
        ).fetchone()[0] == 6

    monkeypatch.undo()
    report = run_split(state, apply=True, content_sample=6)
    assert not report.refused, [r.rung for r in report.refusals]
    arch = sqlite3.connect(archive_db_path_for(state))
    assert arch.execute("SELECT COUNT(*) FROM transcript_archives").fetchone()[0] == 6
    assert arch.execute("SELECT COUNT(*) FROM transcript_records").fetchone()[0] == 6
    arch.close()


def test_forward_self_references_survive_the_copy(
    state: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REGRESSION, and it came from a full-scale run, not from reasoning.

    ``transcript_archives`` references itself. The copy walks rowid
    order, so a row whose parent has a HIGHER id is written before that
    parent exists, and per-row enforcement kills the migration with
    "FOREIGN KEY constraint failed". Measured on the owner's real 5.57 GB
    database: 16,387 forward references. The 443 MB fixture had none
    because it was built by filtering them out, so it passed every time.

    THE CHUNK BOUNDARY IS WHAT MAKES IT FIRE, and getting that wrong is
    how this test first passed against the very bug it was written for.
    One chunk is ONE ``INSERT ... SELECT`` statement, and sqlite defers
    foreign key checks to the END of a statement, so a forward reference
    INSIDE a chunk resolves fine. The live database failed because
    10,242,817 rows span many 20,000-row chunks and a reference crossing
    a boundary meets a parent that is genuinely not there yet. So this
    shrinks CHUNK_ROWS rather than growing the fixture to 20,000 rows.
    """
    monkeypatch.setattr("src.core.archive_db_copy.CHUNK_ROWS", 2)

    with _open(state) as conn:
        forward = conn.execute(
            "SELECT COUNT(*) FROM transcript_archives "
            "WHERE parent_archive_id > id"
        ).fetchone()[0]
    assert forward > 0, (
        "the fixture carries no forward self-reference, so this test cannot "
        "observe the failure it exists for"
    )

    report = run_split(state, apply=True, content_sample=6)
    assert not report.refused, [r.rung for r in report.refusals]

    arch = sqlite3.connect(archive_db_path_for(state))
    try:
        assert arch.execute("PRAGMA foreign_key_check").fetchall() == []
        assert arch.execute(
            "SELECT COUNT(*) FROM transcript_archives "
            "WHERE parent_archive_id > id"
        ).fetchone()[0] == forward
    finally:
        arch.close()


def test_a_foreign_key_violation_in_the_copy_refuses_the_drop() -> None:
    """The verification half of the bulk-load idiom is a real refusal.

    Turning enforcement off for the copy is only safe because this rung
    turns it back into a measured check over the whole database. Without
    it, the idiom would be a way of not noticing.
    """
    refusals = predrop_refusals(
        count_mismatches={}, content_mismatches=[],
        write_probe_failures={}, destination_integrity="ok",
        fk_violations=[("transcript_archives", 41, "transcript_archives", 0)],
    )
    assert [r.rung for r in refusals] == [DEST_FK_VIOLATIONS]
    assert blocking(refusals)


def test_a_count_mismatch_refuses_the_drop() -> None:
    """Arity is verified before anything is removed."""
    refusals = predrop_refusals(
        count_mismatches={"transcript_records": (100, 99)},
        content_mismatches=[], write_probe_failures={},
        destination_integrity="ok",
    )
    assert [r.rung for r in refusals] == [COUNT_MISMATCH]
    assert blocking(refusals)


def test_a_content_mismatch_refuses_the_drop() -> None:
    """Bytes are verified too: a count proves arity and nothing else."""
    refusals = predrop_refusals(
        count_mismatches={}, content_mismatches=["u3"],
        write_probe_failures={}, destination_integrity="ok",
    )
    assert blocking(refusals)


def test_an_unverifiable_destination_refuses_the_drop() -> None:
    """A pragma that could not run is not a pass."""
    refusals = predrop_refusals(
        count_mismatches={}, content_mismatches=[],
        write_probe_failures={}, destination_integrity=None,
    )
    assert blocking(refusals)


# ---------------------------------------------------------------- round trip


def test_the_split_is_reversible_and_restores_the_constraints(state: Path) -> None:
    """Forward then reverse returns the same rows AND the same constraints."""
    def snapshot() -> Tuple[dict, dict]:
        conn = _open(state)
        tables = sorted(
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        )
        rows = {t: conn.execute(f'SELECT * FROM "{t}"').fetchall() for t in tables}
        fks = {
            t: sorted(
                (r[2], r[3])
                for r in conn.execute(f'PRAGMA foreign_key_list("{t}")')
            )
            for t in tables
        }
        conn.close()
        return rows, fks

    before_rows, before_fks = snapshot()
    assert not run_split(state, apply=True, content_sample=6).refused
    reverse = run_unsplit(state, apply=True)
    assert not reverse.refused, reverse.refusals
    after_rows, after_fks = snapshot()

    assert after_rows == before_rows
    assert after_fks == before_fks
    # and the crossing constraints are enforced again, not just declared
    conn = _open(state)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO transcript_archives "
            "(archive_uuid, content_gzip, content_sha256, root_session_id)"
            " VALUES ('x', X'00', 'sha', 424242)"
        )
    conn.close()


def test_the_reverse_refuses_rather_than_overwrite_existing_tables(
    state: Path,
) -> None:
    """A reverse will not write over tables it did not put there."""
    assert not run_split(state, apply=True, content_sample=2).refused
    conn = _open(state)
    conn.execute("CREATE TABLE transcript_records (id INTEGER PRIMARY KEY)")
    conn.close()
    report = run_unsplit(state, apply=True)
    assert report.refused
