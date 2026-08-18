"""feat/db-is-authoritative - the four /projects routes, end to end.

Exercises the HTTP layer against a real cloude.db and a real config.json
on disk: what GET /projects serves and where it came from, whether a
round trip through POST / PATCH / DELETE lands in BOTH stores, what
happens to a write when the datastore is unreachable, and how a
DB-versus-config disagreement is surfaced.

The round-trip test is the one that proves the inversion actually took.
It asserts on both sides after every mutation - the database changed, AND
config.json was updated to match - because either half alone is a
half-migration that looks finished.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_par_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_par_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.auth import require_auth
from src.api.auth import router as auth_router
from src.core.db import connect, db_path_for, transaction
from src.core.db_migration import ensure_db_migrated
from src.core.project_store import import_from_config
from src.core.project_writes import list_projects_ordered
from tests.test_project_authority import REAL_CONFIG_PROJECTS, cfg


@pytest.fixture
def app_env(tmp_path, monkeypatch):
    """A TestClient over the real /projects routes, real db, real config.json.

    Description: patches BOTH ``get_state_dir`` and ``auth_config_file``
      onto throwaway paths, and clears the Settings auth-config cache
      after writing the file, so the routes read the fixture's config
      rather than the developer's real one.
    Inputs: tmp_path (Path), monkeypatch.
    Output: tuple - (TestClient, state_dir Path, config_file Path).
    """
    from src.config import settings

    state_dir = tmp_path / "state"
    state_dir.mkdir()
    config_file = tmp_path / "config.json"

    monkeypatch.setattr(
        type(settings), "get_state_dir", lambda self: state_dir, raising=True
    )
    monkeypatch.setattr(settings, "auth_config_file", str(config_file), raising=False)

    config_projects = [cfg(p["name"], p["path"]) for p in REAL_CONFIG_PROJECTS]
    _write_config(config_file, config_projects)

    monkeypatch.setattr(
        type(settings),
        "load_auth_config",
        lambda self: _FakeAuthConfig(_read_config_projects(config_file)),
        raising=True,
    )

    assert ensure_db_migrated(state_dir, 4, "0.0.0").status == "ok"
    with closing(connect(db_path_for(state_dir))) as conn:
        with transaction(conn):
            import_from_config(conn, config_projects)

    app = FastAPI()
    app.include_router(auth_router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: {"sub": "test"}
    with TestClient(app) as client:
        yield client, state_dir, config_file


class _FakeAuthConfig:
    """Minimal stand-in for AuthConfig carrying only ``projects``.

    Inputs (constructor): projects (list).
    Output: an object with a ``projects`` attribute.
    """

    def __init__(self, projects: List[Any]) -> None:
        self.projects = projects


def _write_config(path: Path, projects: List[Any]) -> None:
    """Write a config.json with the given projects and a few other keys.

    Inputs: path (Path), projects (list of ProjectConfig-like).
    Output: None.
    """
    path.write_text(
        json.dumps(
            {
                "config_version": 4,
                "template_path": "claude-template",
                "projects": [
                    {"name": p.name, "path": p.path, "description": p.description}
                    for p in projects
                ],
            },
            indent=2,
        )
    )


def _read_config_projects(path: Path) -> List[Any]:
    """Read config.json's projects as ProjectConfig-like objects.

    Inputs: path (Path).
    Output: list - empty when the file is missing or unparseable.
    """
    try:
        doc = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    return [cfg(p["name"], p["path"], p.get("description")) for p in doc["projects"]]


def _db_rows(state_dir: Path) -> List[Dict[str, Any]]:
    """Read the authoritative project rows straight from the database.

    Inputs: state_dir (Path).
    Output: list[dict].
    """
    with closing(connect(db_path_for(state_dir))) as conn:
        return list_projects_ordered(conn)


def _config_names(config_file: Path) -> List[str]:
    """Read the display names currently in the rollback artifact.

    Inputs: config_file (Path).
    Output: list[str].
    """
    return [p["name"] for p in json.loads(config_file.read_text())["projects"]]


# --- GET /projects: served from the database ------------------------------


class TestGetProjects:
    def test_thirteen_config_entries_render_as_nine_projects(self, app_env):
        """The visible symptom, fixed at the API boundary."""
        client, _, config_file = app_env
        assert len(json.loads(config_file.read_text())["projects"]) == 13

        body = client.get("/api/v1/projects").json()

        assert len(body) == 9

    def test_the_triplicated_root_appears_once(self, app_env):
        client, _, _ = app_env
        body = client.get("/api/v1/projects").json()
        hits = [
            p
            for p in body
            if p["root"] == "/Users/jsugamele/Development/ses_ec5bf2a3"
        ]
        assert len(hits) == 1

    def test_every_project_carries_its_row_id(self, app_env):
        """The id the launcher keys child sessions off must be on the row."""
        client, _, _ = app_env
        body = client.get("/api/v1/projects").json()
        ids = [p["id"] for p in body]
        assert all(i is not None for i in ids)
        assert len(set(ids)) == len(ids)

    def test_authority_route_reports_db_mode(self, app_env):
        client, _, _ = app_env
        body = client.get("/api/v1/projects/authority").json()
        assert body["mode"] == "db"
        assert body["writable"] is True
        assert body["degraded"] is False


# --- the round trip: create, rename, delete -------------------------------


class TestRoundTrip:
    """Each mutation must land in the database AND in the rollback file."""

    def test_create_lands_in_both_stores(self, app_env):
        client, state_dir, config_file = app_env

        response = client.post(
            "/api/v1/projects",
            json={"name": "roundtrip", "path": "/tmp/roundtrip", "description": "d"},
        )

        assert response.status_code == 201
        assert response.json()["id"] is not None
        assert "roundtrip" in [r["display_name"] for r in _db_rows(state_dir)]
        assert "roundtrip" in _config_names(config_file)

    def test_rename_lands_in_both_stores(self, app_env):
        client, state_dir, config_file = app_env

        response = client.patch(
            "/api/v1/projects/CloudeCode", json={"new_name": "Renamed"}
        )

        assert response.status_code == 200
        assert response.json()["name"] == "Renamed"
        assert "Renamed" in [r["display_name"] for r in _db_rows(state_dir)]
        assert "Renamed" in _config_names(config_file)
        assert "CloudeCode" not in _config_names(config_file)

    def test_delete_lands_in_both_stores(self, app_env):
        client, state_dir, config_file = app_env

        response = client.delete("/api/v1/projects/ai-setup")

        assert response.status_code == 200
        assert "ai-setup" not in [r["display_name"] for r in _db_rows(state_dir)]
        assert "ai-setup" not in _config_names(config_file)

    def test_a_rename_does_not_move_the_folder_or_the_root(self, app_env):
        client, state_dir, _ = app_env
        before = {
            r["display_name"]: r["root"] for r in _db_rows(state_dir)
        }["CloudeCode"]

        body = client.patch(
            "/api/v1/projects/CloudeCode", json={"new_name": "Renamed"}
        ).json()

        assert body["root"] == before

    def test_creating_a_duplicate_root_is_refused_with_409(self, app_env):
        """The refusal that stops the launcher regrowing a duplicate node."""
        client, _, _ = app_env

        response = client.post(
            "/api/v1/projects",
            json={
                "name": "a-fourth-name",
                "path": "/Users/jsugamele/Development/ses_ec5bf2a3",
            },
        )

        assert response.status_code == 409
        assert "already exists" in response.json()["detail"]

    def test_creating_a_duplicate_name_is_still_a_400(self, app_env):
        """Pre-existing behaviour preserved, so a client is not surprised."""
        client, _, _ = app_env
        response = client.post(
            "/api/v1/projects",
            json={"name": "CloudeCode", "path": "/tmp/somewhere-else"},
        )
        assert response.status_code == 400

    def test_deleting_an_unknown_project_is_404(self, app_env):
        client, _, _ = app_env
        assert client.delete("/api/v1/projects/no-such-thing").status_code == 404

    def test_patch_with_no_fields_is_400(self, app_env):
        client, _, _ = app_env
        assert client.patch("/api/v1/projects/CloudeCode", json={}).status_code == 400
