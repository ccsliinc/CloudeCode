"""feat/db-is-authoritative - the config.json snapshot writer.

Split out of tests/test_project_authority.py to keep both files inside
this project's 500-line rule. Same fixtures, imported rather than
duplicated, so there is one definition of "his real config shape" and it
cannot drift between the two files.

WHAT THIS FILE IS ABOUT. config.json stopped being the source of truth
and became a ROLLBACK ARTIFACT. That only means anything if the file is
kept valid, kept current, and never damaged by a failure on the database
side. Every test below is one of those three properties.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List

import pytest

from tests.test_project_authority import (  # noqa: F401 - fixtures re-exported
    REAL_UNIQUE_ROOT_COUNT,
    cfg,
    duplicate_laden_config,
    seeded,
    state_dir,
    write_config,
)

from src.core.project_authority import refresh_snapshot
from src.core.project_snapshot import (
    SNAPSHOT_CONFIG_MISSING,
    SNAPSHOT_CONFIG_UNPARSEABLE,
    SNAPSHOT_OK,
    build_projects_array,
    snapshot_projects,
)


class TestSnapshot:
    """config.json stays a valid, current, deduplicated rollback artifact."""

    def test_snapshot_writes_one_entry_per_unique_root(
        self, seeded: Path, tmp_path: Path, duplicate_laden_config
    ) -> None:
        config_file = tmp_path / "config.json"
        write_config(config_file, duplicate_laden_config)
        result = refresh_snapshot(seeded, config_file)
        assert result.ok is True
        assert result.reason == SNAPSHOT_OK
        written = json.loads(config_file.read_text())["projects"]
        assert len(written) == REAL_UNIQUE_ROOT_COUNT

    def test_snapshot_does_not_resurrect_the_duplicates(
        self, seeded: Path, tmp_path: Path, duplicate_laden_config
    ) -> None:
        """Reverting must not restore the bug the user reverted to escape."""
        config_file = tmp_path / "config.json"
        write_config(config_file, duplicate_laden_config)
        refresh_snapshot(seeded, config_file)
        written = json.loads(config_file.read_text())["projects"]
        paths = [p["path"] for p in written]
        assert len(paths) == len(set(paths))
        assert paths.count("/Users/jsugamele/Development/ses_ec5bf2a3") == 1

    def test_snapshot_preserves_every_other_config_key(
        self, seeded: Path, tmp_path: Path, duplicate_laden_config
    ) -> None:
        config_file = tmp_path / "config.json"
        write_config(
            config_file,
            duplicate_laden_config,
            notifications={"enabled": True, "ntfy_topic": "keepme"},
            agents={"claude_command": "claude"},
        )
        refresh_snapshot(seeded, config_file)
        doc = json.loads(config_file.read_text())
        assert doc["notifications"]["ntfy_topic"] == "keepme"
        assert doc["agents"]["claude_command"] == "claude"
        assert doc["config_version"] == 4

    def test_snapshot_output_is_the_shape_the_old_reader_expects(
        self, seeded: Path, tmp_path: Path, duplicate_laden_config
    ) -> None:
        """A rollback file the pre-datastore code cannot read is worthless."""
        config_file = tmp_path / "config.json"
        write_config(config_file, duplicate_laden_config)
        refresh_snapshot(seeded, config_file)
        for entry in json.loads(config_file.read_text())["projects"]:
            assert set(entry.keys()) == {"name", "path", "description"}

    def test_missing_config_is_reported_not_manufactured(
        self, seeded: Path, tmp_path: Path
    ) -> None:
        target = tmp_path / "does-not-exist.json"
        result = refresh_snapshot(seeded, target)
        assert result.ok is False
        assert result.reason == SNAPSHOT_CONFIG_MISSING
        assert not target.exists()

    def test_unparseable_config_is_left_untouched(
        self, seeded: Path, tmp_path: Path
    ) -> None:
        """Never overwrite a config we could not read - it may be recoverable."""
        target = tmp_path / "broken.json"
        target.write_text("{ this is not json")
        result = refresh_snapshot(seeded, target)
        assert result.ok is False
        assert result.reason == SNAPSHOT_CONFIG_UNPARSEABLE
        assert target.read_text() == "{ this is not json"

    def test_unreadable_db_does_not_clobber_config_with_an_empty_list(
        self, tmp_path: Path, duplicate_laden_config
    ) -> None:
        """The failure that would turn a rollback file into a data shredder."""
        no_db = tmp_path / "gone"
        no_db.mkdir()
        config_file = tmp_path / "config.json"
        write_config(config_file, duplicate_laden_config)
        before = config_file.read_text()

        result = refresh_snapshot(no_db, config_file)

        assert result.ok is False
        assert config_file.read_text() == before
        assert len(json.loads(before)["projects"]) == 13

    def test_snapshot_never_raises_on_a_write_failure(
        self, seeded: Path, tmp_path: Path, monkeypatch
    ) -> None:
        """A committed mutation must not surface as an exception."""
        config_file = tmp_path / "config.json"
        write_config(config_file, [])

        def boom(*_a, **_k):
            raise OSError("No space left on device")

        monkeypatch.setattr("src.core.project_snapshot.atomic_write", boom)
        result = snapshot_projects(config_file, [])
        assert result.ok is False
        assert "No space left" in (result.detail or "")

    def test_build_array_preserves_the_order_it_is_given(self) -> None:
        rows = [
            {"display_name": "b", "raw_path": "/b", "description": None},
            {"display_name": "a", "raw_path": "/a", "description": "x"},
        ]
        assert [e["name"] for e in build_projects_array(rows)] == ["b", "a"]


