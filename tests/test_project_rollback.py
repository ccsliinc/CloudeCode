"""feat/db-is-authoritative - does deleting cloude.db actually bring the
user's projects back from config.json?

THIS IS THE LOAD-BEARING TEST OF THE WHOLE CHANGE. The user's reason for
moving projects into the database was, verbatim: "for v1, we move into the
db. and for a very good reason. this way we can leave the config file for
a user to revert backwards." If the revert does not work, the database
being authoritative has bought nothing and cost a rollback path.

So this file does not test that config.json LOOKS right. It performs the
actual revert - mutate through the app's write path, delete cloude.db,
boot the datastore again from nothing - and asserts the projects come
back, by name, by path, and in order.

TWO REVERT SHAPES, BOTH TESTED, because a user will hit both:

  RUNTIME LOSS   the database disappears while the app is running. There
                 is no restart and no import. The app must serve
                 config.json read-only and SAY it is degraded. Nothing is
                 written back to config.json in that state.
  FULL REVERT    the database is deleted and the app is restarted. The
                 one-time import latch lives IN cloude.db, so deleting
                 the file also deletes the latch, the first-run import
                 runs again, and the projects are rebuilt from
                 config.json. This is the path the user actually means.

A NOTE ON WHAT "INTACT" MEANS. The revert restores the projects, not the
duplicate config entries the import collapsed. That is deliberate and is
asserted here rather than left implicit: reverting must not restore the
launcher bug the user is reverting to escape.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_rb_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_rb_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.db import connect, db_path_for, get_meta
from src.core.db_migration import ensure_db_migrated
from src.core.db_models import META_IMPORTED_FROM_JSON_AT
from src.core.project_authority import (
    MODE_CONFIG_FALLBACK,
    MODE_DB,
    ProjectsReadOnlyError,
    refresh_snapshot,
    require_writable,
    resolve_projects,
)
from src.core.project_store import import_from_config
from src.core.project_writes import (
    create_project,
    delete_project,
    list_projects_ordered,
    resolve_by_name,
    update_project,
)
from tests.test_project_authority import (
    REAL_CONFIG_PROJECTS,
    REAL_UNIQUE_ROOT_COUNT,
    cfg,
)


def load_config_projects(config_file: Path) -> List[SimpleNamespace]:
    """Read config.json's projects back as ProjectConfig-like objects.

    Description: deliberately re-reads the FILE rather than reusing an
      in-memory list. A rollback test that trusts a variable is not
      testing the rollback artifact, it is testing its own bookkeeping.
    Inputs: config_file (Path).
    Output: list[SimpleNamespace].
    """
    doc = json.loads(config_file.read_text())
    return [
        cfg(p["name"], p["path"], p.get("description"))
        for p in doc["projects"]
    ]


@pytest.fixture
def installed(tmp_path: Path) -> Dict[str, Any]:
    """A working install: migrated DB, imported projects, current snapshot.

    Description: models the state the user is actually in - his 13-entry
      config.json already imported down to 9 rows, and config.json then
      re-snapshotted from the table so the two are in step.
    Inputs: tmp_path (Path).
    Output: dict - ``{"state_dir", "config_file", "config_projects"}``.
    """
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    assert ensure_db_migrated(state_dir, 4, "0.0.0").status == "ok"

    config_projects = [cfg(p["name"], p["path"]) for p in REAL_CONFIG_PROJECTS]
    config_file = tmp_path / "config.json"
    config_file.write_text(
        json.dumps(
            {
                "config_version": 4,
                "template_path": "claude-template",
                "notifications": {"enabled": False},
                "projects": [
                    {"name": p.name, "path": p.path, "description": p.description}
                    for p in config_projects
                ],
            },
            indent=2,
        )
    )

    with closing(connect(db_path_for(state_dir))) as conn:
        with conn:
            import_from_config(conn, config_projects)
    refresh_snapshot(state_dir, config_file)

    return {
        "state_dir": state_dir,
        "config_file": config_file,
        "config_projects": config_projects,
    }


# --- the mutation half: config.json tracks the database -------------------


class TestSnapshotTracksMutations:
    """Every project mutation leaves config.json describing the new truth."""

    def test_create_lands_in_config(self, installed) -> None:
        state_dir, config_file = installed["state_dir"], installed["config_file"]
        with closing(connect(db_path_for(state_dir))) as conn:
            create_project(conn, name="freshly-made", path="/tmp/freshly-made")
        assert refresh_snapshot(state_dir, config_file).ok

        names = [p.name for p in load_config_projects(config_file)]
        assert "freshly-made" in names

    def test_rename_lands_in_config(self, installed) -> None:
        state_dir, config_file = installed["state_dir"], installed["config_file"]
        with closing(connect(db_path_for(state_dir))) as conn:
            target = resolve_by_name(conn, "CloudeCode")
            update_project(conn, target["id"], new_name="Cloude Code Renamed")
        assert refresh_snapshot(state_dir, config_file).ok

        names = [p.name for p in load_config_projects(config_file)]
        assert "Cloude Code Renamed" in names
        assert "CloudeCode" not in names

    def test_delete_lands_in_config(self, installed) -> None:
        state_dir, config_file = installed["state_dir"], installed["config_file"]
        with closing(connect(db_path_for(state_dir))) as conn:
            target = resolve_by_name(conn, "ai-setup")
            delete_project(conn, target["id"])
        assert refresh_snapshot(state_dir, config_file).ok

        names = [p.name for p in load_config_projects(config_file)]
        assert "ai-setup" not in names
        assert len(names) == REAL_UNIQUE_ROOT_COUNT - 1

    def test_the_snapshot_collapsed_the_duplicates_on_first_write(
        self, installed
    ) -> None:
        """The installed fixture already re-snapshotted; 13 became 9."""
        entries = load_config_projects(installed["config_file"])
        assert len(entries) == REAL_UNIQUE_ROOT_COUNT
        paths = [e.path for e in entries]
        assert len(paths) == len(set(paths))


# --- runtime loss: degraded, read-only, and it says so --------------------


class TestRuntimeDatabaseLoss:
    """cloude.db vanishes mid-run: serve config.json, refuse writes, announce."""

    def test_projects_still_render_from_config(self, installed) -> None:
        state_dir, config_file = installed["state_dir"], installed["config_file"]
        db_path_for(state_dir).unlink()

        view = resolve_projects(state_dir, load_config_projects(config_file))

        assert view.mode == MODE_CONFIG_FALLBACK
        assert len(view.projects) == REAL_UNIQUE_ROOT_COUNT
        assert "CloudeCode" in [p["name"] for p in view.projects]

    def test_the_degradation_is_announced_not_silent(self, installed) -> None:
        state_dir, config_file = installed["state_dir"], installed["config_file"]
        db_path_for(state_dir).unlink()

        view = resolve_projects(state_dir, load_config_projects(config_file))
        payload = view.to_dict()

        assert payload["degraded"] is True
        assert payload["writable"] is False
        assert "UNREACHABLE" in payload["message"]
        assert "rollback" in payload["message"]

    def test_writes_are_refused_while_degraded(self, installed) -> None:
        state_dir, config_file = installed["state_dir"], installed["config_file"]
        db_path_for(state_dir).unlink()

        view = resolve_projects(state_dir, load_config_projects(config_file))
        with pytest.raises(ProjectsReadOnlyError):
            require_writable(view)

    def test_config_is_not_written_while_degraded(self, installed) -> None:
        """The one intact copy of the data must not be edited unwitnessed."""
        state_dir, config_file = installed["state_dir"], installed["config_file"]
        before = config_file.read_text()
        db_path_for(state_dir).unlink()

        result = refresh_snapshot(state_dir, config_file)

        assert result.ok is False
        assert config_file.read_text() == before


# --- the full revert: delete the db, boot again, get the projects back ----


class TestFullRevert:
    """The user's stated reason for the change, executed end to end."""

    def _revert_and_reboot(self, installed) -> List[Dict[str, Any]]:
        """Delete cloude.db, re-migrate from nothing, re-run the import.

        Description: this is the ACTUAL revert, not a simulation of one.
          The file is removed, ``ensure_db_migrated`` builds a brand new
          database, and the projects stage of the first-run import runs
          against the config.json on disk - the same call
          ``run_first_run_import`` makes at startup.
        Inputs: installed (dict) - the fixture.
        Output: list[dict] - the rebuilt project rows, in launcher order.
        """
        state_dir = installed["state_dir"]
        config_file = installed["config_file"]

        db_path_for(state_dir).unlink()
        assert not db_path_for(state_dir).exists()

        state = ensure_db_migrated(state_dir, 4, "0.0.0")
        assert state.status == "ok", state.message

        with closing(connect(db_path_for(state_dir))) as conn:
            # The latch lives in the database, so deleting the file
            # deleted the latch. A fresh install imports.
            assert get_meta(conn, META_IMPORTED_FROM_JSON_AT) is None
            with conn:
                import_from_config(conn, load_config_projects(config_file))
            return list_projects_ordered(conn)

    def test_deleting_the_database_brings_the_projects_back(
        self, installed
    ) -> None:
        """The headline claim: revert works."""
        rows = self._revert_and_reboot(installed)

        assert len(rows) == REAL_UNIQUE_ROOT_COUNT
        names = {r["display_name"] for r in rows}
        assert {"CloudeCode", "Development", "ai-setup", "test pause"} <= names

    def test_the_recovered_projects_point_at_the_right_folders(
        self, installed
    ) -> None:
        rows = self._revert_and_reboot(installed)
        by_name = {r["display_name"]: r["root"] for r in rows}
        assert by_name["CloudeCode"] == "/Users/jsugamele/Development/CloudeCode"
        assert by_name["ai-setup"] == "/Users/jsugamele/Development/ai-setup"
        assert by_name["test pause"] == "/Users/jsugamele/Development/ses_ec5bf2a3"

    def test_a_mutation_made_before_the_revert_survives_it(
        self, installed
    ) -> None:
        """This is what makes config.json a rollback artifact and not a fossil.

        A create, a rename and a delete are applied through the write
        path, config.json is re-snapshotted, and only THEN is the
        database destroyed. All three must be present in the rebuilt
        table - otherwise config.json is a copy of the install, not a
        copy of the user's work.
        """
        state_dir, config_file = installed["state_dir"], installed["config_file"]

        with closing(connect(db_path_for(state_dir))) as conn:
            create_project(conn, name="made-before-revert", path="/tmp/made-before")
            renamed = resolve_by_name(conn, "Development")
            update_project(conn, renamed["id"], new_name="Dev Root")
            doomed = resolve_by_name(conn, "asd")
            delete_project(conn, doomed["id"])
        assert refresh_snapshot(state_dir, config_file).ok

        rows = self._revert_and_reboot(installed)
        names = {r["display_name"] for r in rows}

        assert "made-before-revert" in names, "the create survived the revert"
        assert "Dev Root" in names, "the rename survived the revert"
        assert "Development" not in names
        assert "asd" not in names, "the delete survived the revert"

    def test_the_revert_does_not_resurrect_the_duplicates(
        self, installed
    ) -> None:
        """Reverting must not restore the launcher bug it is escaping."""
        rows = self._revert_and_reboot(installed)
        roots = [r["root"] for r in rows]
        assert len(roots) == len(set(roots))
        assert roots.count("/Users/jsugamele/Development/ses_ec5bf2a3") == 1

    def test_after_the_revert_the_app_is_fully_writable_again(
        self, installed
    ) -> None:
        """Not degraded, not read-only - a genuine recovery."""
        self._revert_and_reboot(installed)
        state_dir, config_file = installed["state_dir"], installed["config_file"]

        view = resolve_projects(state_dir, load_config_projects(config_file))

        assert view.mode == MODE_DB
        assert view.writable is True
        assert view.degraded is False
        require_writable(view)

    def test_after_the_revert_the_two_sources_agree(self, installed) -> None:
        self._revert_and_reboot(installed)
        state_dir, config_file = installed["state_dir"], installed["config_file"]

        view = resolve_projects(state_dir, load_config_projects(config_file))

        assert view.diff is not None
        assert view.diff.agree is True, view.diff.to_dict()

    def test_ordering_survives_the_revert(self, installed) -> None:
        """The launcher looks the same after the revert as before it."""
        state_dir = installed["state_dir"]
        with closing(connect(db_path_for(state_dir))) as conn:
            before = [r["display_name"] for r in list_projects_ordered(conn)]

        after = [r["display_name"] for r in self._revert_and_reboot(installed)]

        assert after == before

    def test_the_rebuilt_database_reaches_the_current_schema(
        self, installed
    ) -> None:
        """A revert must not strand the user on an old schema."""
        from src.core.db import get_schema_version
        from src.core.db_models import CURRENT_SCHEMA_VERSION

        self._revert_and_reboot(installed)
        with closing(connect(db_path_for(installed["state_dir"]))) as conn:
            assert get_schema_version(conn) == CURRENT_SCHEMA_VERSION
