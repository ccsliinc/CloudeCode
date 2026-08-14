"""feat/launch-wrappers — tests for src/core/config_migration.py.

Covers:
- migrate_config_dict: old-key-only config -> wrappers seeded + versioned
- Environment-aware seeding: cld-only, cldor-only, neither, both (mocked
  shell probe, no dependency on the real machine)
- Idempotency: running migrate_config_dict twice changes nothing the
  second time
- Fail-safe: an unresolvable/malformed input leaves the config completely
  untouched (no config_version stamped, no partial mutation)
- migrate_config_file: real file I/O — backup written, atomic write,
  no-op case leaves config.json AND the .bak file alone
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.config_migration import (
    CURRENT_CONFIG_VERSION,
    build_seed_wrappers,
    ensure_config_migrated,
    migrate_config_dict,
    migrate_config_file,
    probe_shell_function,
)


# ---------------------------------------------------------------------- #
# probe_shell_function — mocked runner, never touches the real shell
# ---------------------------------------------------------------------- #

def _fake_runner(returncode_map):
    def runner(argv):
        name = argv[-1].split()[-1]  # "type cld" -> "cld"
        return subprocess.CompletedProcess(argv, returncode_map.get(name, 1))
    return runner


def test_probe_shell_function_found():
    runner = _fake_runner({"cld": 0})
    assert probe_shell_function("cld", runner=runner) is True


def test_probe_shell_function_not_found():
    runner = _fake_runner({"cld": 1})
    assert probe_shell_function("cld", runner=runner) is False


def test_probe_shell_function_runner_exception_is_not_found():
    def raising_runner(argv):
        raise OSError("zsh not found")
    assert probe_shell_function("cld", runner=raising_runner) is False


# ---------------------------------------------------------------------- #
# build_seed_wrappers
# ---------------------------------------------------------------------- #

def test_build_seed_wrappers_neither_detected():
    wrappers = build_seed_wrappers(False, False)
    ids = [w["id"] for w in wrappers]
    assert ids == ["claude"]
    assert wrappers[0]["default"] is True


def test_build_seed_wrappers_cld_only():
    wrappers = build_seed_wrappers(True, False)
    ids = [w["id"] for w in wrappers]
    assert ids == ["claude", "cld"]
    by_id = {w["id"]: w for w in wrappers}
    assert by_id["cld"]["default"] is True
    assert by_id["claude"]["default"] is False


def test_build_seed_wrappers_both_detected():
    wrappers = build_seed_wrappers(True, True)
    ids = [w["id"] for w in wrappers]
    assert ids == ["claude", "cld", "cldor"]
    by_id = {w["id"]: w for w in wrappers}
    assert by_id["cld"]["default"] is True
    assert by_id["cldor"]["default"] is False


# ---------------------------------------------------------------------- #
# migrate_config_dict — pure function
# ---------------------------------------------------------------------- #

def test_migrate_old_keys_only_seeds_wrappers_and_stamps_version():
    data = {
        "agents": {
            "claude_command": "",
            "codex_command": "codex",
            "hermes_command": "hermes",
            "openclaw_command": "openclaw tui",
        }
    }
    new_data, changed = migrate_config_dict(data, has_cld=True, has_cldor=True)
    assert changed is True
    assert new_data["config_version"] == CURRENT_CONFIG_VERSION
    ids = [w["id"] for w in new_data["agents"]["wrappers"]]
    assert ids == ["claude", "cld", "cldor"]
    # legacy keys untouched, still present verbatim
    assert new_data["agents"]["codex_command"] == "codex"
    assert new_data["agents"]["hermes_command"] == "hermes"
    assert new_data["agents"]["openclaw_command"] == "openclaw tui"
    assert new_data["agents"]["claude_command"] == ""
    # original dict never mutated
    assert "wrappers" not in data["agents"]
    assert "config_version" not in data


def test_migrate_no_agents_block_at_all():
    data = {"projects": []}
    new_data, changed = migrate_config_dict(data, has_cld=False, has_cldor=False)
    assert changed is True
    assert new_data["agents"]["wrappers"][0]["id"] == "claude"
    assert new_data["config_version"] == CURRENT_CONFIG_VERSION


def test_migrate_neither_cld_nor_cldor_detected_seeds_plain_claude_only():
    data = {"agents": {}}
    new_data, changed = migrate_config_dict(data, has_cld=False, has_cldor=False)
    assert changed is True
    ids = [w["id"] for w in new_data["agents"]["wrappers"]]
    assert ids == ["claude"]


# ---------------------------------------------------------------------- #
# Idempotency
# ---------------------------------------------------------------------- #

def test_migration_idempotent_second_run_is_noop():
    data = {"agents": {}}
    first, changed1 = migrate_config_dict(data, has_cld=True, has_cldor=False)
    assert changed1 is True
    second, changed2 = migrate_config_dict(first, has_cld=True, has_cldor=False)
    assert changed2 is False
    assert second == first  # byte-identical, no re-seeding, no version bump


def test_already_current_version_untouched_even_with_different_probe_results():
    """A config already at CURRENT_CONFIG_VERSION is never re-seeded, even
    if the environment now looks different (e.g. cld got removed from
    ~/.zshrc after the first migration) — migration runs ONCE."""
    data = {"config_version": CURRENT_CONFIG_VERSION, "agents": {"wrappers": [{"id": "cld"}]}}
    new_data, changed = migrate_config_dict(data, has_cld=False, has_cldor=False)
    assert changed is False
    assert new_data is data


# ---------------------------------------------------------------------- #
# Fail-safe path
# ---------------------------------------------------------------------- #

def test_malformed_agents_block_leaves_config_untouched():
    data = {"agents": "not-a-dict", "config_version": 0}
    new_data, changed = migrate_config_dict(data, has_cld=True, has_cldor=True)
    assert changed is False
    assert new_data is data
    assert "config_version" not in new_data or new_data["config_version"] == 0


def test_bad_version_type_leaves_config_untouched():
    data = {"config_version": "not-an-int", "agents": {}}
    new_data, changed = migrate_config_dict(data, has_cld=True, has_cldor=True)
    assert changed is False
    assert new_data is data


def test_explicit_claude_command_present_stamps_version_but_seeds_no_wrappers():
    """A user who already opted into a custom claude_command keeps that
    fallback working — wrappers are NOT seeded on top of it (would
    silently override their choice, since wrappers are checked first)."""
    data = {"agents": {"claude_command": "claude --dangerously-skip-permissions"}}
    new_data, changed = migrate_config_dict(data, has_cld=True, has_cldor=True)
    assert changed is True
    assert new_data["config_version"] == CURRENT_CONFIG_VERSION
    assert "wrappers" not in new_data["agents"]
    assert new_data["agents"]["claude_command"] == "claude --dangerously-skip-permissions"


def test_existing_wrappers_block_not_overwritten():
    data = {"agents": {"wrappers": [{"id": "custom", "label": "x", "script": "y", "default": True}]}}
    new_data, changed = migrate_config_dict(data, has_cld=True, has_cldor=True)
    assert changed is True
    assert new_data["agents"]["wrappers"] == [{"id": "custom", "label": "x", "script": "y", "default": True}]
    assert new_data["config_version"] == CURRENT_CONFIG_VERSION


# ---------------------------------------------------------------------- #
# migrate_config_file — real file I/O
# ---------------------------------------------------------------------- #

def test_migrate_config_file_writes_backup_and_migrates(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    original = {"agents": {"codex_command": "codex"}}
    config_path.write_text(json.dumps(original, indent=2))

    monkeypatch.setattr(
        "src.core.config_migration.probe_shell_function",
        lambda name, runner=None: name == "cld",
    )

    result = migrate_config_file(config_path)
    assert result["migrated"] is True
    assert result["wrapper_ids"] == ["claude", "cld"]

    backup_path = config_path.with_suffix(".json.bak")
    assert backup_path.exists()
    assert json.loads(backup_path.read_text()) == original

    on_disk = json.loads(config_path.read_text())
    assert on_disk["config_version"] == CURRENT_CONFIG_VERSION
    assert [w["id"] for w in on_disk["agents"]["wrappers"]] == ["claude", "cld"]
    assert on_disk["agents"]["codex_command"] == "codex"

    tmp_file = config_path.with_suffix(".json.tmp")
    assert not tmp_file.exists()


def test_migrate_config_file_noop_leaves_no_backup(tmp_path, monkeypatch):
    config_path = tmp_path / "config.json"
    already_current = {"config_version": CURRENT_CONFIG_VERSION, "agents": {"wrappers": []}}
    config_path.write_text(json.dumps(already_current, indent=2))

    monkeypatch.setattr(
        "src.core.config_migration.probe_shell_function", lambda name, runner=None: False
    )

    result = migrate_config_file(config_path)
    assert result["migrated"] is False

    backup_path = config_path.with_suffix(".json.bak")
    assert not backup_path.exists()
    # file bytes completely unchanged
    assert json.loads(config_path.read_text()) == already_current


def test_migrate_config_file_missing_raises():
    with pytest.raises(FileNotFoundError):
        migrate_config_file(Path("/nonexistent/config.json"))


def test_migrate_config_file_invalid_json_raises(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{not valid json")
    with pytest.raises(ValueError):
        migrate_config_file(config_path)


def test_ensure_config_migrated_never_raises_on_missing_file(tmp_path):
    # Must not raise even though the file doesn't exist.
    ensure_config_migrated(tmp_path / "nope.json")


def test_ensure_config_migrated_never_raises_on_invalid_json(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text("{bad")
    ensure_config_migrated(config_path)  # must not raise
