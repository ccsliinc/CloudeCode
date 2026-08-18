"""feat/db-is-authoritative - degraded mode and disagreement, over HTTP.

Split from tests/test_projects_authority_route.py to keep both files
inside this project's 500-line rule. That file covers the healthy reads
and the create/rename/delete round trip; this one covers what the routes
do when the datastore is gone, and what they say when the two sources
disagree.

Fixtures are imported rather than duplicated, so "his real config shape"
has one definition and cannot drift between the two files.
"""

from __future__ import annotations

import pytest

from src.core.db import db_path_for
from tests.test_project_authority import REAL_CONFIG_PROJECTS, cfg
from tests.test_projects_authority_route import (  # noqa: F401 - fixture re-export
    _config_names,
    _db_rows,
    _read_config_projects,
    _write_config,
    app_env,
)


# --- datastore unreachable: degraded reads, refused writes ----------------


class TestDatastoreUnreachable:
    """The database is deleted mid-run. Read degraded, write refused, say so."""

    def test_get_still_serves_the_users_projects(self, app_env):
        client, state_dir, _ = app_env
        db_path_for(state_dir).unlink()

        body = client.get("/api/v1/projects").json()

        assert len(body) == 9, "the list must not silently empty out"
        assert "CloudeCode" in [p["name"] for p in body]

    def test_degraded_projects_carry_no_row_id(self, app_env):
        """A config entry has no row; null is the honest answer, not 0."""
        client, state_dir, _ = app_env
        db_path_for(state_dir).unlink()

        body = client.get("/api/v1/projects").json()

        assert all(p["id"] is None for p in body)

    def test_authority_announces_read_only_rollback_mode(self, app_env):
        client, state_dir, _ = app_env
        db_path_for(state_dir).unlink()

        body = client.get("/api/v1/projects/authority").json()

        assert body["mode"] == "config_fallback"
        assert body["writable"] is False
        assert body["degraded"] is True
        assert "UNREACHABLE" in body["message"]
        assert "read-only rollback mode" in body["message"]

    def test_authority_cannot_determine_the_diff_rather_than_claiming_agreement(
        self, app_env
    ):
        client, state_dir, _ = app_env
        db_path_for(state_dir).unlink()

        body = client.get("/api/v1/projects/authority").json()

        assert body["diff"] is None
        assert body["diff_state"] == "cannot_determine"

    @pytest.mark.parametrize(
        "call",
        [
            lambda c: c.post(
                "/api/v1/projects", json={"name": "nope", "path": "/tmp/nope"}
            ),
            lambda c: c.patch(
                "/api/v1/projects/CloudeCode", json={"new_name": "nope"}
            ),
            lambda c: c.delete("/api/v1/projects/CloudeCode"),
        ],
        ids=["create", "rename", "delete"],
    )
    def test_every_write_is_refused_with_503(self, app_env, call):
        client, state_dir, _ = app_env
        db_path_for(state_dir).unlink()

        response = call(client)

        assert response.status_code == 503
        assert "unreachable" in response.json()["detail"]

    def test_a_refused_write_does_not_touch_config_json(self, app_env):
        """The rollback artifact must not be edited while it is all we have."""
        client, state_dir, config_file = app_env
        before = config_file.read_text()
        db_path_for(state_dir).unlink()

        client.post("/api/v1/projects", json={"name": "nope", "path": "/tmp/nope"})

        assert config_file.read_text() == before


class TestGuardIsLoadBearing:
    """The write guard refuses cases that merely opening the file cannot.

    Deleting cloude.db makes BOTH the guard and the connection attempt
    fail, so those tests cannot tell which one did the refusing. This one
    can: the file opens fine and the READ fails, which is what a corrupt
    page or a locked table looks like. ``connect()`` succeeds, so nothing
    downstream would refuse - only ``guard_writable`` sees that the
    authority mode is config_fallback and stops the write.
    """

    @staticmethod
    def _break_reads(monkeypatch):
        """Make the project read fail while the file still opens.

        Inputs: monkeypatch.
        Output: None.
        """
        import sqlite3

        def boom(_conn):
            raise sqlite3.DatabaseError("database disk image is malformed")

        monkeypatch.setattr(
            "src.core.project_authority.list_projects_ordered", boom
        )

    def test_the_connection_still_opens_so_only_the_guard_can_refuse(
        self, app_env, monkeypatch
    ):
        from contextlib import closing as _closing

        from src.core.db import connect as _connect

        client, state_dir, _ = app_env
        self._break_reads(monkeypatch)

        # Proof the file itself is fine: open it the way the write path does.
        with _closing(_connect(db_path_for(state_dir), create=False)):
            pass

        assert client.get("/api/v1/projects/authority").json()["writable"] is False

    def test_a_create_is_refused_by_the_guard_not_by_the_connection(
        self, app_env, monkeypatch
    ):
        client, _, _ = app_env
        self._break_reads(monkeypatch)

        response = client.post(
            "/api/v1/projects", json={"name": "sneaky", "path": "/tmp/sneaky"}
        )

        assert response.status_code == 503

    def test_no_row_is_written_when_the_guard_refuses(self, app_env, monkeypatch):
        client, state_dir, _ = app_env
        self._break_reads(monkeypatch)

        client.post("/api/v1/projects", json={"name": "sneaky", "path": "/tmp/sneaky"})

        monkeypatch.undo()
        assert "sneaky" not in [r["display_name"] for r in _db_rows(state_dir)]

    def test_config_is_untouched_when_the_guard_refuses(self, app_env, monkeypatch):
        client, _, config_file = app_env
        before = config_file.read_text()
        self._break_reads(monkeypatch)

        client.post("/api/v1/projects", json={"name": "sneaky", "path": "/tmp/sneaky"})

        assert config_file.read_text() == before


# --- disagreement is surfaced, not silently resolved ----------------------


class TestDisagreementIsSurfaced:
    def test_a_hand_edited_config_addition_is_reported(self, app_env):
        """A project only config knows about is named, never dropped."""
        client, _, config_file = app_env
        entries = _read_config_projects(config_file)
        entries.append(cfg("added-by-hand", "/tmp/added-by-hand"))
        _write_config(config_file, entries)

        body = client.get("/api/v1/projects/authority").json()

        assert body["diff"]["agree"] is False
        assert [x["name"] for x in body["diff"]["only_in_config"]] == [
            "added-by-hand"
        ]

    def test_a_project_only_the_database_has_is_reported(self, app_env):
        client, _, config_file = app_env
        client.post(
            "/api/v1/projects", json={"name": "db-only", "path": "/tmp/db-only"}
        )
        # Roll config.json back to its pre-create contents by hand, which
        # is exactly what a user reverting the FILE and not the DB does.
        _write_config(config_file, [cfg(p["name"], p["path"]) for p in REAL_CONFIG_PROJECTS])

        body = client.get("/api/v1/projects/authority").json()

        assert body["diff"]["agree"] is False
        assert "db-only" in [x["display_name"] for x in body["diff"]["only_in_db"]]

    def test_the_report_names_the_database_as_authoritative(self, app_env):
        client, _, config_file = app_env
        entries = _read_config_projects(config_file)
        entries.append(cfg("added-by-hand", "/tmp/added-by-hand"))
        _write_config(config_file, entries)

        body = client.get("/api/v1/projects/authority").json()

        assert body["diff"]["authoritative"] == "db"

    def test_the_served_list_still_comes_from_the_database_during_disagreement(
        self, app_env
    ):
        """Disagreement is reported; it does not change who wins."""
        client, _, config_file = app_env
        entries = _read_config_projects(config_file)
        entries.append(cfg("added-by-hand", "/tmp/added-by-hand"))
        _write_config(config_file, entries)

        names = [p["name"] for p in client.get("/api/v1/projects").json()]

        assert "added-by-hand" not in names
        assert len(names) == 9

    def test_duplicates_are_reported_separately_from_missing_projects(
        self, app_env
    ):
        """An expected absence must not read as data loss."""
        client, _, _ = app_env

        body = client.get("/api/v1/projects/authority").json()

        assert body["diff"]["agree"] is True
        assert body["diff"]["only_in_config"] == []
        assert len(body["diff"]["duplicate_config_roots"]) == 3
