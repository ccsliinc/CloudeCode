"""Defect 1: a re-upgrade silently drops a project, then makes it permanent.

MEASURED, not read off the migration's promises. Upgrade, downgrade to
v0.8.1, let the old version create a project, upgrade again:

    config: 6 projects   db: 5 rows   served_mode: "db"   degraded: false
    in_config_but_not_in_db: ["roundtrip-probe-after-downgrade"]

Nothing warned. The three-outcome machinery in project_authority never
fired because the database ANSWERED SUCCESSFULLY - it just answered with
the wrong row set, which is exactly the failure shape the three-outcome
rule exists to catch and the one case it cannot see. The first project
write afterwards called ``snapshot_projects``, which rebuilds
config.json's ``projects`` key wholesale from the table, and the entry
left the file too. At that point it is unrecoverable.

THE CAUSE: the config-projects import was reached only after the
once-only sessions latch (``meta.imported_from_json_at``, stamped
exactly once per install, ever), so it ran on the first start and never
again. That latch is correct FOR SESSIONS - it guards a live tmux probe,
an input that is gone by tomorrow. It is wrong for projects, whose input
is a durable file that can be re-read safely on every start.

THESE TESTS DELIBERATELY IMPORT NOTHING NEW. They drive the same public
entry point src/main.py calls at startup, so they fail on an ASSERTION
about the user's data against the unfixed code rather than on a missing
import - a collection error would prove only that a module is absent.
Both were observed RED before the fix.
"""

from __future__ import annotations

from contextlib import closing
from types import SimpleNamespace

import pytest

from src.core.db import connect, db_path_for, transaction
from src.core.db_migration import ensure_db_migrated
from src.core.project_store import list_projects, normalize_root
from src.core.project_writes import delete_project
from src.core.session_import import run_first_run_import
from src.core.tmux_listing import TmuxListing


def _cfg(name, path):
    """Build one config.json project entry in the shape the import reads.

    Inputs: name (str) - display name. path (str) - raw project path.
    Output: SimpleNamespace matching ``project_store.ProjectConfigLike``.
    Example: _cfg("app", "/tmp/app").path
    """
    return SimpleNamespace(
        name=name, path=path, description=None, agent_type="claude"
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


def test_a_project_created_while_downgraded_survives_the_re_upgrade(conn):
    """THE DEFECT. RED before the fix: the row count stayed at 2 of 3.

    Two starts of the same install, with a downgrade in between during
    which the old version appended its own entry to config.json's
    ``projects`` array. The second start must see it.
    """
    before = [_cfg("alpha", "/tmp/alpha"), _cfg("beta", "/tmp/beta")]
    with transaction(conn):
        run_first_run_import(
            conn, projects=before, listing=TmuxListing.answered([])
        )
    assert len(list_projects(conn)) == 2

    after = before + [_cfg("made-while-downgraded", "/tmp/downgraded")]
    with transaction(conn):
        run_first_run_import(
            conn, projects=after, listing=TmuxListing.answered([])
        )

    roots = {row["root"] for row in list_projects(conn)}
    assert normalize_root("/tmp/downgraded") in roots, (
        "the project the old version created during the downgrade never "
        "reached the table; snapshot_projects would delete it from "
        "config.json on the next project write"
    )


def test_the_startup_path_reports_what_the_projects_stage_did(conn):
    """The repair has to be visible, not silent.

    A reconcile that quietly fixes the data leaves the user with the same
    thing he had before: a correct-looking screen and no account of what
    happened to his projects. RED before the fix - the second call
    returned ALREADY_DONE carrying ``projects=None``.
    """
    with transaction(conn):
        run_first_run_import(
            conn,
            projects=[_cfg("alpha", "/tmp/alpha")],
            listing=TmuxListing.answered([]),
        )
    with transaction(conn):
        result = run_first_run_import(
            conn,
            projects=[_cfg("alpha", "/tmp/alpha"), _cfg("new", "/tmp/new")],
            listing=TmuxListing.answered([]),
        )

    assert result.projects is not None
    assert [e["root"] for e in result.projects.imported] == [
        normalize_root("/tmp/new")
    ]


def test_a_deletion_made_in_the_NEW_version_is_never_undone(conn):
    """The counterweight, and the reason a set comparison is not enough.

    A root absent from the table because it was never imported and one
    absent because the user deleted it look IDENTICAL if all you compare
    is the two sets. A reconcile built on that comparison alone would
    resurrect every deleted project on the next start - trading one
    silent data defect for another.
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

    # config.json still carries the entry - the snapshot has not run yet,
    # or ran and reported SNAPSHOT_WRITE_FAILED. Either way it stays gone.
    with transaction(conn):
        run_first_run_import(
            conn, projects=projects, listing=TmuxListing.answered([])
        )

    roots = {row["root"] for row in list_projects(conn)}
    assert normalize_root("/tmp/doomed") not in roots, (
        "the reconcile resurrected a project the user deliberately deleted"
    )
