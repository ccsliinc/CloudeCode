"""feat/db-is-authoritative - the authority inversion and its three outcomes.

Covers the read side (which source answers, and how each failure is
named), the diff (how disagreement is reported), and the snapshot writer
(how config.json is kept current as a rollback artifact).

The ROLLBACK path itself - delete cloude.db, come back up on config.json
with the user's projects intact - is tests/test_project_rollback.py,
because it is the load-bearing claim of the whole change and deserves to
be findable by name.

Validated against the SHAPE of his real config.json: 13 entries collapsing
onto 9 unique roots, with three names ("test pause", "ses_ec5bf2a3",
"qqwe") sharing /Users/jsugamele/Development/ses_ec5bf2a3. That shape is
reproduced in ``duplicate_laden_config`` rather than approximated, because
the triplication bug is a property of that exact shape.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_auth_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_auth_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.project_authority import (
    MODE_CONFIG_FALLBACK,
    MODE_DB,
    MODE_DB_EMPTY_CONFIG_HAS,
    ProjectsReadOnlyError,
    refresh_snapshot,
    require_writable,
    resolve_projects,
)
from src.core.project_diff import diff_projects
from src.core.project_snapshot import (
    SNAPSHOT_CONFIG_MISSING,
    SNAPSHOT_CONFIG_UNPARSEABLE,
    SNAPSHOT_OK,
    build_projects_array,
    snapshot_projects,
)
from src.core.project_store import import_from_config
from src.core.project_writes import (
    ProjectNameAmbiguous,
    ProjectNotFound,
    ProjectRootConflict,
    create_project,
    delete_project,
    list_projects_ordered,
    resolve_by_name,
    touch_project_by_path,
    update_project,
)

# His real config.json's project list, verified 2026-08-18 against a
# read-only copy: 13 entries, 9 unique roots, 3 duplicated roots. Held as
# data rather than as a fixture file so the duplicate structure is visible
# at the point the tests reason about it.
REAL_CONFIG_PROJECTS: List[Dict[str, Any]] = [
    {"name": "fs2", "path": "/Users/jsugamele/Development/scrolltest"},
    {"name": "scrolltest", "path": "/Users/jsugamele/Development/scrolltest"},
    {"name": "test pause", "path": "/Users/jsugamele/Development/ses_ec5bf2a3"},
    {"name": "ses_ec5bf2a3", "path": "/Users/jsugamele/Development/ses_ec5bf2a3"},
    {"name": "asd", "path": "/Users/jsugamele/Development/ses_8704e610"},
    {"name": "qqwe", "path": "/Users/jsugamele/Development/ses_ec5bf2a3"},
    {"name": "Test", "path": "/Users/jsugamele/Development/ses_c3737fbe"},
    {"name": "console-msw4z3m5", "path": "/Users/jsugamele"},
    {"name": "claude-config-sync-2", "path": "/Users/jsugamele/Development/claude-config-sync"},
    {"name": "claude-config-sync", "path": "/Users/jsugamele/Development/claude-config-sync"},
    {"name": "CloudeCode", "path": "/Users/jsugamele/Development/CloudeCode"},
    {"name": "Development", "path": "/Users/jsugamele/Development"},
    {"name": "ai-setup", "path": "/Users/jsugamele/Development/ai-setup"},
]

REAL_UNIQUE_ROOT_COUNT = 9


def cfg(name: str, path: str, description=None, agent_type=None) -> SimpleNamespace:
    """Build a ProjectConfig-like object for the config side of a test.

    Inputs: name (str), path (str), description (str | None),
      agent_type (str | None).
    Output: SimpleNamespace with those four attributes.
    """
    return SimpleNamespace(
        name=name, path=path, description=description, agent_type=agent_type
    )


@pytest.fixture
def duplicate_laden_config() -> List[SimpleNamespace]:
    """His real config.json project list, in its real duplicate-laden shape.

    Inputs: none.
    Output: list[SimpleNamespace] - 13 entries over 9 unique roots.
    """
    return [cfg(p["name"], p["path"]) for p in REAL_CONFIG_PROJECTS]


@pytest.fixture
def state_dir(tmp_path: Path) -> Path:
    """A migrated, empty datastore directory.

    Inputs: tmp_path (Path) - pytest's per-test directory.
    Output: Path - the state directory, with cloude.db at CURRENT schema.
    """
    d = tmp_path / "state"
    d.mkdir()
    state = ensure_db_migrated(d, 4, "0.0.0")
    assert state.status == "ok", state.message
    return d


@pytest.fixture
def seeded(state_dir: Path, duplicate_laden_config) -> Path:
    """A datastore holding his 9 unique projects, imported from his config.

    Inputs: state_dir (Path). duplicate_laden_config (list).
    Output: Path - the state directory.
    """
    with closing(connect(db_path_for(state_dir))) as conn:
        with conn:
            import_from_config(conn, duplicate_laden_config)
    return state_dir


def write_config(path: Path, projects: List[SimpleNamespace], **extra) -> None:
    """Write a config.json holding the given projects plus other keys.

    Inputs: path (Path). projects (list). extra - additional top-level
      keys, used to prove the snapshot preserves them.
    Output: None.
    """
    doc: Dict[str, Any] = {"config_version": 4, "template_path": "claude-template"}
    doc.update(extra)
    doc["projects"] = [
        {"name": p.name, "path": p.path, "description": p.description}
        for p in projects
    ]
    path.write_text(json.dumps(doc, indent=2))


# --- the import, against his real duplicate shape -------------------------


class TestRealDuplicateShape:
    """The 13-entry / 9-root collapse, asserted on his actual data shape."""

    def test_thirteen_config_entries_become_nine_rows(self, seeded: Path) -> None:
        with closing(connect(db_path_for(seeded))) as conn:
            rows = list_projects_ordered(conn)
        assert len(REAL_CONFIG_PROJECTS) == 13
        assert len(rows) == REAL_UNIQUE_ROOT_COUNT

    def test_the_triplicated_root_has_exactly_one_row(self, seeded: Path) -> None:
        """The root three config names shared resolves to a single project."""
        with closing(connect(db_path_for(seeded))) as conn:
            rows = list_projects_ordered(conn)
        target = [
            r for r in rows if r["root"] == "/Users/jsugamele/Development/ses_ec5bf2a3"
        ]
        assert len(target) == 1
        # The FIRST config name for that root wins, not the last.
        assert target[0]["display_name"] == "test pause"

    def test_dropped_duplicates_are_recorded_not_erased(self, seeded: Path) -> None:
        """A refused duplicate is a fact the app remembers."""
        from src.core.db import get_meta
        from src.core.db_models import META_IMPORTED_FROM_JSON_RESULT

        with closing(connect(db_path_for(seeded))) as conn:
            raw = get_meta(conn, META_IMPORTED_FROM_JSON_RESULT)
        dropped = json.loads(raw)["projects_duplicate_roots_dropped"]
        names = {d["name"] for d in dropped}
        assert {"scrolltest", "ses_ec5bf2a3", "qqwe", "claude-config-sync"} <= names


# --- resolve_projects: the three named outcomes ---------------------------


class TestResolveProjectsOutcomes:
    """Each outcome is named, and none collapses into another."""

    def test_db_mode_serves_rows_and_says_it_is_authoritative(
        self, seeded: Path, duplicate_laden_config
    ) -> None:
        view = resolve_projects(seeded, duplicate_laden_config)
        assert view.mode == MODE_DB
        assert view.writable is True
        assert view.degraded is False
        assert len(view.projects) == REAL_UNIQUE_ROOT_COUNT
        assert all(p["id"] is not None for p in view.projects)

    def test_missing_db_is_config_fallback_not_an_empty_list(
        self, tmp_path: Path, duplicate_laden_config
    ) -> None:
        """A database that will not open must never render as "no projects"."""
        empty_dir = tmp_path / "no_db"
        empty_dir.mkdir()
        view = resolve_projects(empty_dir, duplicate_laden_config)
        assert view.mode == MODE_CONFIG_FALLBACK
        assert view.projects, "the user's projects must still be shown"
        assert "UNREACHABLE" in view.message

    def test_config_fallback_refuses_writes(
        self, tmp_path: Path, duplicate_laden_config
    ) -> None:
        empty_dir = tmp_path / "no_db2"
        empty_dir.mkdir()
        view = resolve_projects(empty_dir, duplicate_laden_config)
        assert view.writable is False
        with pytest.raises(ProjectsReadOnlyError):
            require_writable(view)

    def test_config_fallback_still_deduplicates_by_root(
        self, tmp_path: Path, duplicate_laden_config
    ) -> None:
        """The degraded path must not resurrect the triplication bug."""
        empty_dir = tmp_path / "no_db3"
        empty_dir.mkdir()
        view = resolve_projects(empty_dir, duplicate_laden_config)
        assert len(view.projects) == REAL_UNIQUE_ROOT_COUNT
        roots = [p["root"] for p in view.projects]
        assert len(roots) == len(set(roots))

    def test_config_fallback_carries_no_diff_rather_than_an_agreeing_one(
        self, tmp_path: Path, duplicate_laden_config
    ) -> None:
        """"Could not compare" must never render as "they agree"."""
        empty_dir = tmp_path / "no_db4"
        empty_dir.mkdir()
        view = resolve_projects(empty_dir, duplicate_laden_config)
        assert view.diff is None
        assert view.to_dict()["diff"] is None
        assert view.to_dict()["diff_state"] == "cannot_determine"

    def test_empty_db_with_populated_config_is_its_own_outcome(
        self, state_dir: Path, duplicate_laden_config
    ) -> None:
        """An empty table plus a populated config is not "you have none"."""
        view = resolve_projects(state_dir, duplicate_laden_config)
        assert view.mode == MODE_DB_EMPTY_CONFIG_HAS
        assert view.mode != MODE_DB
        assert view.mode != MODE_CONFIG_FALLBACK
        assert view.projects
        assert "NOT a claim" in view.message

    def test_empty_db_with_empty_config_is_plain_db_mode(
        self, state_dir: Path
    ) -> None:
        """Genuinely having no projects is the healthy mode, not a warning."""
        view = resolve_projects(state_dir, [])
        assert view.mode == MODE_DB
        assert view.projects == []

    def test_corrupt_db_falls_back_rather_than_raising(
        self, tmp_path: Path, duplicate_laden_config
    ) -> None:
        d = tmp_path / "corrupt"
        d.mkdir()
        db_path_for(d).write_bytes(b"this is definitely not a sqlite file" * 40)
        view = resolve_projects(d, duplicate_laden_config)
        assert view.mode == MODE_CONFIG_FALLBACK
        assert view.detail

    def test_a_failure_that_is_not_DatastoreUnreadableError_also_falls_back(
        self, seeded: Path, duplicate_laden_config, monkeypatch
    ) -> None:
        """The generic guard is load-bearing, not decoration.

        The database opens fine and then the READ fails - a corrupt page,
        a disk error, a locked table. That raises sqlite3.DatabaseError,
        not DatastoreUnreadableError, so it reaches the second except
        clause. Without that clause a project read 500s instead of
        degrading, which is the loudest possible way to lose a launcher.
        """

        def boom(_conn):
            raise sqlite3.DatabaseError("database disk image is malformed")

        monkeypatch.setattr(
            "src.core.project_authority.list_projects_ordered", boom
        )
        view = resolve_projects(seeded, duplicate_laden_config)

        assert view.mode == MODE_CONFIG_FALLBACK
        assert "DatabaseError" in (view.detail or "")
        assert view.projects, "the config fallback must still show projects"

    def test_resolving_never_creates_the_database(
        self, tmp_path: Path, duplicate_laden_config
    ) -> None:
        """Reading must not manufacture an empty datastore (db_health's rule)."""
        d = tmp_path / "untouched"
        d.mkdir()
        resolve_projects(d, duplicate_laden_config)
        assert not db_path_for(d).exists()


# --- the diff: disagreement is reported, never silently resolved ----------


class TestProjectDiff:
    """Every disagreement lands in exactly one named bucket."""

    def test_identical_sources_agree(self, seeded: Path) -> None:
        with closing(connect(db_path_for(seeded))) as conn:
            rows = list_projects_ordered(conn)
        config = [cfg(r["display_name"], r["raw_path"], r["description"]) for r in rows]
        d = diff_projects(rows, config)
        assert d.agree is True
        assert d.difference_count == 0

    def test_duplicates_alone_do_not_break_agreement(
        self, seeded: Path, duplicate_laden_config
    ) -> None:
        """The steady state right after an import is agreement, with dupes noted."""
        with closing(connect(db_path_for(seeded))) as conn:
            rows = list_projects_ordered(conn)
        d = diff_projects(rows, duplicate_laden_config)
        assert d.agree is True
        assert len(d.duplicate_config_roots) == 3
        dup_roots = {x["root"] for x in d.duplicate_config_roots}
        assert "/Users/jsugamele/Development/ses_ec5bf2a3" in dup_roots

    def test_project_only_in_db_is_named(self, seeded: Path) -> None:
        with closing(connect(db_path_for(seeded))) as conn:
            rows = list_projects_ordered(conn)
        d = diff_projects(rows, [])
        assert len(d.only_in_db) == REAL_UNIQUE_ROOT_COUNT
        assert d.agree is False

    def test_project_only_in_config_is_named(self, seeded: Path) -> None:
        with closing(connect(db_path_for(seeded))) as conn:
            rows = list_projects_ordered(conn)
        config = [cfg(r["display_name"], r["raw_path"]) for r in rows]
        config.append(cfg("hand-edited", "/Users/jsugamele/Development/added-by-hand"))
        d = diff_projects(rows, config)
        assert [x["name"] for x in d.only_in_config] == ["hand-edited"]
        assert d.agree is False

    def test_a_renamed_project_is_a_field_mismatch_not_a_disappearance(
        self, seeded: Path
    ) -> None:
        """Same root, different name: nothing missing, something stale."""
        with closing(connect(db_path_for(seeded))) as conn:
            rows = list_projects_ordered(conn)
        config = [cfg(r["display_name"], r["raw_path"]) for r in rows]
        config[0] = cfg("a-different-name", config[0].path)
        d = diff_projects(rows, config)
        assert d.only_in_db == []
        assert d.only_in_config == []
        assert len(d.field_mismatches) == 1
        assert d.field_mismatches[0]["field"] == "name"

    def test_null_and_empty_description_are_not_a_permanent_mismatch(self) -> None:
        """A check that can never clear is furniture, not a monitor."""
        rows = [
            {
                "root": "/a",
                "raw_path": "/a",
                "display_name": "a",
                "description": None,
            }
        ]
        d = diff_projects(rows, [cfg("a", "/a", "")])
        assert d.field_mismatches == []
        assert d.agree is True

    def test_the_diff_normalises_roots_exactly_as_the_table_does(
        self, tmp_path: Path
    ) -> None:
        """A diff that normalises differently invents disagreements.

        Uses a REAL symlinked directory, because that is the case where
        expanduser() and the symlink-collapsing resolve() actually differ
        - on macOS /tmp is itself such a link. The table stores the
        uncollapsed spelling on purpose (project_store.normalize_root),
        so a diff that collapsed it would report every symlinked project
        as present on one side and absent on the other, forever, with no
        user action able to clear it.
        """
        real = tmp_path / "real_project"
        real.mkdir()
        link = tmp_path / "linked_project"
        link.symlink_to(real, target_is_directory=True)
        assert str(link.resolve()) != str(link), "fixture must actually differ"

        rows = [
            {
                "root": str(link),
                "raw_path": str(link),
                "display_name": "linked",
                "description": None,
            }
        ]
        d = diff_projects(rows, [cfg("linked", str(link))])

        assert d.agree is True, d.to_dict()
        assert d.only_in_db == []
        assert d.only_in_config == []

    def test_the_report_names_the_authoritative_side(self, seeded: Path) -> None:
        with closing(connect(db_path_for(seeded))) as conn:
            rows = list_projects_ordered(conn)
        assert diff_projects(rows, []).to_dict()["authoritative"] == "db"
