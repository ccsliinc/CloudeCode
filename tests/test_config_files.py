"""Tests for src/core/config_files.py (claude-config file tree + editor).

Covers: path-traversal rejection, .env/.credentials refusal, JSON
validation on save, backup-before-write, and the hide-list. All
filesystem operations run against a tmp_path tree — never the real
``~/.claude``.

Run with:
    python3 -m pytest tests/test_config_files.py -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_cf_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_cf_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core import config_files as cf


@pytest.fixture()
def fake_home(tmp_path, monkeypatch):
    """Point config_files.CLAUDE_HOME at an empty tmp tree and return it."""
    home = tmp_path / "fake-claude-home"
    home.mkdir()
    monkeypatch.setattr(cf, "CLAUDE_HOME", home)
    return home


# ---- hide-list ---------------------------------------------------------

def test_list_tree_omits_hidden_dirs(fake_home):
    (fake_home / "hooks").mkdir()
    (fake_home / "hooks" / "op-readonly-guard.py").write_text("# noop\n")
    for hidden in ("projects", "cache", "todos", "shell-snapshots"):
        (fake_home / hidden).mkdir()
        (fake_home / hidden / "junk.txt").write_text("x")

    tree = cf.list_tree("user", None)
    names = {n["name"] for n in tree}
    assert "hooks" in names
    assert names.isdisjoint({"projects", "cache", "todos", "shell-snapshots"})


def test_list_tree_omits_credentials_and_history(fake_home):
    (fake_home / ".credentials.json").write_text("{}")
    (fake_home / "history.jsonl").write_text("{}\n")
    (fake_home / "stats-cache.json").write_text("{}")
    (fake_home / "CLAUDE.md").write_text("# hi\n")

    tree = cf.list_tree("user", None)
    names = {n["name"] for n in tree}
    assert names == {"CLAUDE.md"}


def test_list_tree_omits_dotenv_variants(fake_home):
    for name in (".env", ".env.local", ".env.production"):
        (fake_home / name).write_text("SECRET=1\n")
    (fake_home / "CLAUDE.md").write_text("# hi\n")

    tree = cf.list_tree("user", None)
    names = {n["name"] for n in tree}
    assert names == {"CLAUDE.md"}


def test_list_tree_only_shows_allowlisted_top_level_entries(fake_home):
    (fake_home / "CLAUDE.md").write_text("# hi\n")
    (fake_home / "settings.json").write_text("{}")
    (fake_home / "random_junk_dir").mkdir()
    (fake_home / "not_allowed.txt").write_text("x")

    tree = cf.list_tree("user", None)
    names = {n["name"] for n in tree}
    assert names == {"CLAUDE.md", "settings.json"}


def test_list_tree_marks_plugins_readonly_and_collapsed(fake_home):
    (fake_home / "plugins").mkdir()
    (fake_home / "plugins" / "somefile.json").write_text("{}")

    tree = cf.list_tree("user", None)
    plugins_node = next(n for n in tree if n["name"] == "plugins")
    assert plugins_node["read_only"] is True
    assert plugins_node["collapsed"] is True


# ---- path traversal ------------------------------------------------------

def test_resolve_safe_path_rejects_dotdot_traversal(fake_home):
    (fake_home / "hooks").mkdir()
    with pytest.raises(cf.ConfigFileError):
        cf.resolve_safe_path("user", "hooks/../../etc/passwd", None)


def test_resolve_safe_path_rejects_absolute_smuggle(fake_home):
    with pytest.raises(cf.ConfigFileError):
        cf.resolve_safe_path("user", "/etc/passwd", None)


def test_resolve_safe_path_rejects_disallowed_top_level(fake_home):
    (fake_home / "projects").mkdir()
    (fake_home / "projects" / "secret.json").write_text("{}")
    with pytest.raises(cf.ConfigFileError):
        cf.resolve_safe_path("user", "projects/secret.json", None)


def test_resolve_safe_path_accepts_valid_nested_path(fake_home):
    (fake_home / "hooks").mkdir()
    (fake_home / "hooks" / "op-readonly-guard.py").write_text("# noop\n")
    resolved = cf.resolve_safe_path("user", "hooks/op-readonly-guard.py", None)
    assert resolved == (fake_home / "hooks" / "op-readonly-guard.py").resolve()


def test_resolve_safe_path_unknown_root_rejected(fake_home):
    with pytest.raises(cf.ConfigFileError):
        cf.resolve_safe_path("nonsense", "CLAUDE.md", None)


def test_project_root_requires_existing_claude_dir(tmp_path, fake_home):
    project_dir = tmp_path / "someproject"
    project_dir.mkdir()
    # No .claude/ under it yet.
    with pytest.raises(cf.ConfigFileError):
        cf.resolve_safe_path("project", "CLAUDE.md", str(project_dir))

    (project_dir / ".claude").mkdir()
    (project_dir / ".claude" / "CLAUDE.md").write_text("# project\n")
    resolved = cf.resolve_safe_path("project", "CLAUDE.md", str(project_dir))
    assert resolved.name == "CLAUDE.md"


# ---- .env / .credentials refusal (server-side, not just hidden in UI) ----

def test_read_file_refuses_env_even_with_exact_path(fake_home):
    (fake_home / ".env").write_text("SECRET=1\n")
    with pytest.raises(cf.ConfigFileError):
        cf.read_file("user", ".env", None)


def test_read_file_refuses_credentials_even_with_exact_path(fake_home):
    (fake_home / ".credentials.json").write_text('{"token": "x"}')
    with pytest.raises(cf.ConfigFileError):
        cf.read_file("user", ".credentials.json", None)


def test_write_file_refuses_env_even_with_exact_path(fake_home):
    with pytest.raises(cf.ConfigFileError):
        cf.write_file("user", ".env", "SECRET=2\n", None)
    assert not (fake_home / ".env").exists()


# ---- JSON validation on save --------------------------------------------

def test_write_file_rejects_malformed_json(fake_home):
    settings_path = fake_home / "settings.json"
    settings_path.write_text('{"a": 1}')
    with pytest.raises(cf.ConfigFileError):
        cf.write_file("user", "settings.json", "{not valid json", None)
    # Original content untouched.
    assert settings_path.read_text() == '{"a": 1}'


def test_write_file_accepts_valid_json(fake_home):
    settings_path = fake_home / "settings.json"
    settings_path.write_text('{"a": 1}')
    result = cf.write_file("user", "settings.json", '{"a": 2}', None)
    assert result["backed_up"] is True
    assert json.loads(settings_path.read_text()) == {"a": 2}


def test_write_file_markdown_skips_json_validation(fake_home):
    (fake_home / "CLAUDE.md").write_text("# old\n")
    cf.write_file("user", "CLAUDE.md", "# new, not json at all\n", None)
    assert (fake_home / "CLAUDE.md").read_text() == "# new, not json at all\n"


# ---- backup-before-write -------------------------------------------------

def test_write_file_creates_bak_with_previous_content(fake_home):
    settings_path = fake_home / "settings.json"
    settings_path.write_text('{"version": 1}')
    cf.write_file("user", "settings.json", '{"version": 2}', None)
    bak_path = fake_home / "settings.json.bak"
    assert bak_path.exists()
    assert json.loads(bak_path.read_text()) == {"version": 1}


def test_write_file_no_backup_flag_when_file_is_new(fake_home):
    result = cf.write_file("user", "CLAUDE.md", "# brand new\n", None)
    assert result["backed_up"] is False
    assert not (fake_home / "CLAUDE.md.bak").exists()


# ---- executable-file handling --------------------------------------------

def test_write_file_refuses_executable_without_acknowledgement(fake_home):
    hooks_dir = fake_home / "hooks"
    hooks_dir.mkdir()
    (hooks_dir / "op-readonly-guard.py").write_text("# guard\n")
    with pytest.raises(cf.ConfigFileError):
        cf.write_file("user", "hooks/op-readonly-guard.py", "# modified\n", None, acknowledge_executable=False)
    assert (hooks_dir / "op-readonly-guard.py").read_text() == "# guard\n"


def test_write_file_allows_executable_with_acknowledgement(fake_home):
    hooks_dir = fake_home / "hooks"
    hooks_dir.mkdir()
    (hooks_dir / "op-readonly-guard.py").write_text("# guard\n")
    result = cf.write_file("user", "hooks/op-readonly-guard.py", "# modified\n", None, acknowledge_executable=True)
    assert result["is_executable"] is True
    assert result["backed_up"] is True
    assert (hooks_dir / "op-readonly-guard.py").read_text() == "# modified\n"


def test_read_file_flags_executable_scripts(fake_home):
    scripts_dir = fake_home / "scripts"
    scripts_dir.mkdir()
    (scripts_dir / "deploy.sh").write_text("#!/bin/bash\necho hi\n")
    result = cf.read_file("user", "scripts/deploy.sh", None)
    assert result["is_executable"] is True


def test_non_executable_dir_script_extension_not_flagged(fake_home):
    (fake_home / "rules").mkdir()
    (fake_home / "rules" / "notes.py").write_text("# just a python note, not run\n")
    result = cf.read_file("user", "rules/notes.py", None)
    assert result["is_executable"] is False


def test_write_file_refuses_plugins_readonly_root(fake_home):
    plugins_dir = fake_home / "plugins"
    plugins_dir.mkdir()
    (plugins_dir / "somefile.json").write_text("{}")
    with pytest.raises(cf.ConfigFileError):
        cf.write_file("user", "plugins/somefile.json", "{}", None)
