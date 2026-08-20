"""The two release-blocking migration defects an executed round trip found.

Both were measured by upgrading to the new version, downgrading to v0.8.1
and upgrading again - not by reading the migration's own promises. See
docs/upgrade-downgrade-roundtrip.md for the reproductions.

DEFECT 1 - re-upgrade silently drops a project, then makes the loss
permanent. A project the OLD version wrote into config.json during a
downgrade never reaches the projects table, because the projects import
was gated on the once-only sessions latch. Nothing warned: the database
answered SUCCESSFULLY, it just answered with the wrong row set, so every
three-outcome check in project_authority correctly reported ``db`` /
``degraded: False``. The next project write then snapshotted config.json
from the table and deleted the entry from the file too.

DEFECT 2 - an object-form ``common_slash_commands`` entry is a hard
downgrade break. v0.8.1 types the key ``List[str]``; one object entry
makes its ``load_auth_config`` raise a pydantic ValidationError and the
server EXIT at startup. An entry with no real description carries no
information the object form is needed for, so the write path emits the
bare string instead and only a genuine description keeps the object.

WHAT THESE TESTS HAD TO BE ABLE TO SEE. Every one of them was run
against the unfixed code first and observed to FAIL. A test that was
never red is not evidence that anything was fixed.
"""

from __future__ import annotations

import json
from contextlib import closing
from types import SimpleNamespace

import pytest

from src.core import slash_favorites
from src.core.db import connect, db_path_for, transaction
from src.core.db_migration import ensure_db_migrated
from src.core.db_models import (
    META_PROJECT_TOMBSTONES_LEGACY_GAP,
    META_PROJECT_TOMBSTONES_SINCE,
)
from src.core.db_steps import run_chain
from src.core.project_reconcile import (
    RECONCILE_IMPORTED,
    RECONCILE_SKIPPED_DELETED,
    RECONCILE_UNDETERMINED,
    reconcile_projects,
    reconcile_summary,
)
from src.core.project_store import (
    import_from_config,
    list_projects,
    normalize_root,
)
from src.core.project_tombstones import tombstoned_roots
from src.core.project_writes import create_project, delete_project
from src.core.session_import import run_first_run_import
from src.core.tmux_listing import TmuxListing


def _cfg(name, path):
    """Build one config.json project entry in the shape the import reads.

    Inputs: name (str) - display name. path (str) - raw project path.
    Output: SimpleNamespace matching ``ProjectConfigLike``.
    Example: _cfg("app", "/tmp/app").path
    """
    return SimpleNamespace(
        name=name, path=path, description=None, agent_type="claude"
    )


def _legacy_v4_db(tmp_path):
    """Create a cloude.db stopped at schema v4 - below the tombstone table.

    Description: the shape every install that predates deletion tracking
      has on disk. Built with ``run_chain`` rather than
      ``ensure_db_migrated`` because that entry point always migrates all
      the way to CURRENT_SCHEMA_VERSION, which is the thing this fixture
      needs NOT to happen.
    Inputs: tmp_path (Path) - the state directory to create it in.
    Output: None - the file is left on disk at ``db_path_for(tmp_path)``.
    """
    with closing(connect(db_path_for(tmp_path))) as c:
        with transaction(c):
            run_chain(c, 0, 4)
            # run_chain here is THIS version's code, and its v0 -> v1 step
            # stamps the deletion-tracking marker on a genuinely new file.
            # A database actually created by the old code carries neither
            # key, because the old code had never heard of them. Removing
            # them is what makes this fixture a v4 database rather than a
            # current database wearing a v4 label - without it the test
            # would measure the fixture's own anachronism and pass for the
            # wrong reason.
            c.execute(
                "DELETE FROM meta WHERE key IN (?, ?)",
                (
                    META_PROJECT_TOMBSTONES_SINCE,
                    META_PROJECT_TOMBSTONES_LEGACY_GAP,
                ),
            )


@pytest.fixture()
def conn(tmp_path):
    """A migrated cloude.db connection at the current schema version.

    Inputs: tmp_path (Path) - pytest's per-test directory.
    Output: sqlite3.Connection, closed on teardown.
    """
    ensure_db_migrated(tmp_path, 4, "0.8.2")
    with closing(connect(db_path_for(tmp_path))) as connection:
        yield connection


# ===========================================================================
# DEFECT 1 - the re-upgrade drop
# ===========================================================================


def test_a_project_the_old_version_created_is_imported_on_re_upgrade(conn):
    """THE DEFECT ITSELF. Downgrade, old version adds a project, re-upgrade.

    Before the fix the second ``run_first_run_import`` returned
    ALREADY_DONE and never looked at config.json again, so the row count
    stayed at 2 while config.json held 3. RED against the unfixed code.
    """
    before = [_cfg("alpha", "/tmp/alpha"), _cfg("beta", "/tmp/beta")]
    with transaction(conn):
        run_first_run_import(
            conn, projects=before, listing=TmuxListing.answered([])
        )

    # The downgrade: v0.8.1 appends its own entry to config.json's array.
    after = before + [_cfg("made-while-downgraded", "/tmp/downgraded")]

    with transaction(conn):
        result = run_first_run_import(
            conn, projects=after, listing=TmuxListing.answered([])
        )

    roots = {row["root"] for row in list_projects(conn)}
    assert normalize_root("/tmp/downgraded") in roots
    assert result.projects is not None, (
        "the re-upgrade must report what the projects stage did, not None"
    )
    assert [e["root"] for e in result.projects.imported] == [
        normalize_root("/tmp/downgraded")
    ]


def test_reconcile_NEVER_resurrects_a_deliberately_deleted_project(conn):
    """The counterweight. Deleting through the new version must STICK.

    A row absent because it was never imported and a row absent because
    the user deleted it are indistinguishable by set comparison alone, so
    a naive reconcile would undo every deletion on the next boot - one
    silent data defect traded for another. The tombstone is what tells
    them apart.
    """
    projects = [_cfg("alpha", "/tmp/alpha"), _cfg("doomed", "/tmp/doomed")]
    with transaction(conn):
        run_first_run_import(
            conn, projects=projects, listing=TmuxListing.answered([])
        )

    doomed = next(
        row for row in list_projects(conn)
        if row["root"] == normalize_root("/tmp/doomed")
    )
    delete_project(conn, doomed["id"])
    assert normalize_root("/tmp/doomed") in tombstoned_roots(conn)

    # config.json still carries the entry: the snapshot has not run yet,
    # or ran and failed. Either way the reconcile must leave it deleted.
    with transaction(conn):
        result = reconcile_projects(conn, projects)

    roots = {row["root"] for row in list_projects(conn)}
    assert normalize_root("/tmp/doomed") not in roots
    assert [e["root"] for e in result.skipped_deleted] == [
        normalize_root("/tmp/doomed")
    ]
    assert result.imported == []


def test_recreating_a_deleted_project_clears_its_tombstone(conn):
    """A tombstone must not become a permanent ban on a path.

    Otherwise "delete it, then add it back" fails, and the next reconcile
    would silently drop the re-created project again.
    """
    with transaction(conn):
        run_first_run_import(
            conn,
            projects=[_cfg("gone", "/tmp/gone")],
            listing=TmuxListing.answered([]),
        )
    row = list_projects(conn)[0]
    delete_project(conn, row["id"])
    assert normalize_root("/tmp/gone") in tombstoned_roots(conn)

    create_project(conn, name="gone", path="/tmp/gone")
    assert normalize_root("/tmp/gone") not in tombstoned_roots(conn)

    with transaction(conn):
        reconcile_projects(conn, [_cfg("gone", "/tmp/gone")])
    assert len(list_projects(conn)) == 1


def test_reconcile_is_idempotent_and_keeps_the_first_duplicate(conn):
    """Repeated runs change nothing, and the keep-the-first rule holds.

    ``project_attribution``, ``project_snapshot``, ``project_authority``
    and ``project_diff`` all depend on one row per unique root, keeping
    the FIRST config entry for that root. The reconcile runs on every
    start, so a drift here would compound daily.
    """
    projects = [
        _cfg("first", "/tmp/same"),
        _cfg("second", "/tmp/same"),
        _cfg("other", "/tmp/other"),
    ]
    with transaction(conn):
        reconcile_projects(conn, projects)
    with transaction(conn):
        second = reconcile_projects(conn, projects)

    rows = list_projects(conn)
    assert len(rows) == 2
    same = next(r for r in rows if r["root"] == normalize_root("/tmp/same"))
    assert same["display_name"] == "first"
    assert second.imported == []
    assert [e["root"] for e in second.duplicates_dropped] == [
        normalize_root("/tmp/same")
    ]


def test_a_pre_tombstone_deletion_is_UNDETERMINED_not_a_silent_import(
    tmp_path,
):
    """THE THIRD OUTCOME. An install older than the tombstone table.

    On a database that already held projects before deletion tracking
    existed, a config entry with no row could be either cause and there
    is no evidence on disk that separates them. That is CANNOT EVALUATE.
    It must not be imported (which would undo a deletion) and must not be
    quietly skipped (which would hide the round-trip loss); it is named,
    counted, and reported.
    """
    # A v4 database - one schema version BELOW the tombstone table - with
    # a project already imported, then a row removed the way the
    # pre-tombstone delete path removed it: no trace at all.
    _legacy_v4_db(tmp_path)
    with closing(connect(db_path_for(tmp_path))) as c:
        with transaction(c):
            import_from_config(
                c, [_cfg("kept", "/tmp/kept"), _cfg("hazy", "/tmp/hazy")]
            )
        # The pre-tombstone delete path: a hard DELETE leaving no trace.
        with transaction(c):
            c.execute("DELETE FROM projects WHERE root = ?",
                      (normalize_root("/tmp/hazy"),))

    # Now upgrade to the version that has tombstones.
    ensure_db_migrated(tmp_path, 4, "0.8.2")
    with closing(connect(db_path_for(tmp_path))) as c:
        with transaction(c):
            result = reconcile_projects(
                c, [_cfg("kept", "/tmp/kept"), _cfg("hazy", "/tmp/hazy")]
            )
        roots = {row["root"] for row in list_projects(c)}
        assert normalize_root("/tmp/hazy") not in roots
        assert [e["root"] for e in result.undetermined] == [
            normalize_root("/tmp/hazy")
        ]
        assert result.imported == []

        # It stays undetermined on every later run rather than being
        # imported once the adoption record exists.
        with transaction(c):
            again = reconcile_projects(
                c, [_cfg("kept", "/tmp/kept"), _cfg("hazy", "/tmp/hazy")]
            )
        assert [e["root"] for e in again.undetermined] == [
            normalize_root("/tmp/hazy")
        ]

        # ... but a project that appears AFTER the adoption run is
        # unambiguous and reconciles normally.
        with transaction(c):
            fresh = reconcile_projects(
                c,
                [
                    _cfg("kept", "/tmp/kept"),
                    _cfg("hazy", "/tmp/hazy"),
                    _cfg("new", "/tmp/new"),
                ],
            )
        assert [e["root"] for e in fresh.imported] == [
            normalize_root("/tmp/new")
        ]


def test_the_reconcile_is_observable_not_silent(conn):
    """The repair must be visible where the wizard can render it.

    A reconcile that fixes the data and says nothing is the same shape as
    the defect: a correct-looking screen with no account of what happened
    to the user's projects.
    """
    with transaction(conn):
        run_first_run_import(
            conn,
            projects=[_cfg("alpha", "/tmp/alpha")],
            listing=TmuxListing.answered([]),
        )
    with transaction(conn):
        reconcile_projects(
            conn, [_cfg("alpha", "/tmp/alpha"), _cfg("added", "/tmp/added")]
        )

    summary = reconcile_summary(conn)
    assert summary["outcomes"][RECONCILE_IMPORTED] == 1
    assert summary["outcomes"][RECONCILE_SKIPPED_DELETED] == 0
    assert summary["outcomes"][RECONCILE_UNDETERMINED] == 0
    assert summary["at"], "the summary must carry when it last ran"
    assert "added" in summary["notice"]


def test_the_summary_names_what_it_could_not_evaluate(tmp_path):
    """An undetermined project must reach the roll-up, not be skipped.

    Rule 2 of the three-outcome rule: a row nobody can evaluate makes the
    SECTION not-evaluated. It does not get dropped so the summary can
    stay clean.
    """
    _legacy_v4_db(tmp_path)
    with closing(connect(db_path_for(tmp_path))) as c:
        with transaction(c):
            import_from_config(c, [_cfg("hazy", "/tmp/hazy")])
        with transaction(c):
            c.execute("DELETE FROM projects")
    ensure_db_migrated(tmp_path, 4, "0.8.2")
    with closing(connect(db_path_for(tmp_path))) as c:
        with transaction(c):
            reconcile_projects(c, [_cfg("hazy", "/tmp/hazy")])
        summary = reconcile_summary(c)

    assert summary["outcomes"][RECONCILE_UNDETERMINED] == 1
    assert summary["cannot_determine"] is True
    assert normalize_root("/tmp/hazy") in summary["notice"]
