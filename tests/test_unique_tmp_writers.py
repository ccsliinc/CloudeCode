"""Tests for the four durable writers widened to a unique temp name.

Covers ``OwnedTmuxLedger.write_atomic`` (session_metadata.json),
``ThemeStore.save`` (pinned_themes.json), ``ThemeStore.set_project_theme``
(``<working_dir>/.cc.theme``) and ``config_files_io.atomic_write`` (the
file editor's write chokepoint).

RETARGETED AT THE 1.4.0 INTEGRATION, and that retarget is the point of
keeping this file. The three manager methods this arrived asserting
(``_write_metadata_atomic``, ``_save_pinned_themes``,
``set_project_theme``) do not exist on this line: the decomposition moved
them onto ``SessionManager._owned`` and ``SessionManager._theme_store``.
The writers are reached through those seams instead, so the property is
still measured against the code that actually performs the write rather
than against a method name that merged cleanly and was gone.

Every one of these used to compose its temp sibling as
``path.with_suffix(path.suffix + ".tmp")`` - a name shared by every
writer of that path. ``src/core/unique_tmp_path.py`` is the fix; this
file asserts the property that matters (two writes never share a temp
path, a write completes with a valid file, a failed write leaves no
orphan) rather than the implementation detail of what the name looks
like.

THE OBSERVATION POINT IS ``os.replace``, DELIBERATELY, NOT
``unique_tmp_path`` ITSELF. Every one of the four writers - fixed or not
- calls ``os.replace(tmp, final)`` as its last step, so recording the
source argument of that call is a probe that means the same thing before
and after the fix. Instrumenting ``unique_tmp_path`` instead would prove
nothing about a reverted writer, which never calls it at all - see the
negative-control note on each test.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_utw_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_utw_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core import config_files_io
from src.core.session_manager import SessionManager
from src.core.unique_tmp_path import unique_tmp_path


class _StubSettings:
    """Just enough of ``Settings`` for SessionManager.__init__ to load."""

    def __init__(self, pin_path: Path, log_dir: Path):
        self._pin_path = pin_path
        self._log_dir = log_dir

    def get_pinned_themes_path(self) -> Path:
        return self._pin_path

    def get_unread_state_path(self) -> Path:
        return self._pin_path.parent / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._log_dir)

    def get_session_metadata_path(self) -> Path:
        return self._log_dir / "session_metadata.json"


def _bare_manager(monkeypatch, tmp_path: Path) -> SessionManager:
    """A SessionManager whose disk state lives entirely under tmp_path."""
    stub = _StubSettings(
        pin_path=tmp_path / "pinned_themes.json",
        log_dir=tmp_path / "logs",
    )
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr("src.core.session_manager.settings", stub)
    return SessionManager()


def _record_replace_sources(monkeypatch) -> list:
    """Wrap ``os.replace`` to record the source path of every call.

    Description: delegates to the REAL ``os.replace`` after recording,
      so the write under test still completes normally. This is the one
      seam every writer here shares whether or not it has been fixed,
      which is what makes it a fair probe for the negative control.
    Inputs: monkeypatch (pytest fixture).
    Output: list[str] - appended to, in call order, as writes happen.
    """
    seen: list[str] = []
    real_replace = os.replace

    def _recording_replace(src, dst):
        seen.append(str(src))
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", _recording_replace)
    return seen


def _force_replace_failure(monkeypatch) -> None:
    """Make the next ``os.replace`` raise, without touching the tmp write.

    Description: the write up to and including fsync still happens for
      real, so the tmp file genuinely exists on disk when replace fails
      - which is the only way to prove the cleanup path removes a REAL
      orphan rather than one that was never created.
    Inputs: monkeypatch (pytest fixture).
    Output: None.
    """

    def _raiser(src, dst):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(os, "replace", _raiser)


def _tmp_orphans(directory: Path) -> list:
    """List of ``*.tmp`` files left behind in ``directory``."""
    return sorted(p.name for p in directory.glob("*.tmp"))


# --------------------------------------------------------------------------- #
# 0. the shared helper itself
# --------------------------------------------------------------------------- #


def test_unique_tmp_path_two_calls_differ(tmp_path):
    """Two calls for the same target return two different sibling paths."""
    target = tmp_path / "state.json"
    a = unique_tmp_path(target)
    b = unique_tmp_path(target)
    assert a != b
    assert a.parent == target.parent == b.parent
    assert a.name.startswith("state.json.") and a.name.endswith(".tmp")


# --------------------------------------------------------------------------- #
# 1. OwnedTmuxLedger.write_atomic (session_metadata.json)
# --------------------------------------------------------------------------- #


def test_metadata_two_writes_use_distinct_temp_paths(monkeypatch, tmp_path):
    """Negative control: watched RED with the fix reverted to a fixed name
    (both recorded sources were identical, ``session_metadata.json.tmp``)."""
    mgr = _bare_manager(monkeypatch, tmp_path)
    seen = _record_replace_sources(monkeypatch)

    mgr._owned.write_atomic({"id": "one"})
    mgr._owned.write_atomic({"id": "two"})

    assert len(seen) == 2
    assert seen[0] != seen[1]


def test_metadata_write_leaves_a_valid_complete_file(monkeypatch, tmp_path):
    mgr = _bare_manager(monkeypatch, tmp_path)
    mgr._owned.write_atomic({"id": "ses_abc", "owned_tmux_sessions": ["a"]})

    path = tmp_path / "logs" / "session_metadata.json"
    assert path.is_file()
    data = json.loads(path.read_text())
    assert data == {"id": "ses_abc", "owned_tmux_sessions": ["a"]}


def test_metadata_failed_write_leaves_no_orphan_temp_file(monkeypatch, tmp_path):
    mgr = _bare_manager(monkeypatch, tmp_path)
    _force_replace_failure(monkeypatch)

    with pytest.raises(OSError):
        mgr._owned.write_atomic({"id": "wont-land"})

    assert _tmp_orphans(tmp_path / "logs") == []


# --------------------------------------------------------------------------- #
# 2. ThemeStore.save (pinned_themes.json)
# --------------------------------------------------------------------------- #


def test_pinned_themes_two_saves_use_distinct_temp_paths(monkeypatch, tmp_path):
    """Negative control: watched RED with the fix reverted to a fixed name."""
    mgr = _bare_manager(monkeypatch, tmp_path)
    seen = _record_replace_sources(monkeypatch)

    mgr._theme_store.pinned_themes["cloude_a"] = "metal"
    mgr._theme_store.save()
    mgr._theme_store.pinned_themes["cloude_b"] = "matrix"
    mgr._theme_store.save()

    assert len(seen) == 2
    assert seen[0] != seen[1]


def test_pinned_themes_save_leaves_a_valid_complete_file(monkeypatch, tmp_path):
    mgr = _bare_manager(monkeypatch, tmp_path)
    mgr._theme_store.pinned_themes["cloude_proj"] = "hermes"
    mgr._theme_store.save()

    path = tmp_path / "pinned_themes.json"
    assert json.loads(path.read_text()) == {"cloude_proj": "hermes"}


def test_pinned_themes_failed_save_leaves_no_orphan_temp_file(monkeypatch, tmp_path):
    mgr = _bare_manager(monkeypatch, tmp_path)
    mgr._theme_store.pinned_themes["cloude_proj"] = "hermes"
    _force_replace_failure(monkeypatch)

    # ThemeStore.save swallows the failure (logged, never raised) -
    # the cleanup must still have run.
    mgr._theme_store.save()

    assert _tmp_orphans(tmp_path) == []


def test_pinned_themes_bak_behaviour_is_unchanged(monkeypatch, tmp_path):
    """The pre-write bytes still land in ``pinned_themes.json.bak`` before
    every save after the first - unaffected by the temp-name fix."""
    mgr = _bare_manager(monkeypatch, tmp_path)
    path = tmp_path / "pinned_themes.json"
    bak = tmp_path / "pinned_themes.json.bak"

    mgr._theme_store.pinned_themes["cloude_a"] = "metal"
    mgr._theme_store.save()
    assert not bak.exists()  # nothing to back up on the first save

    first_write_bytes = path.read_bytes()
    mgr._theme_store.pinned_themes["cloude_b"] = "matrix"
    mgr._theme_store.save()

    assert bak.exists()
    assert bak.read_bytes() == first_write_bytes
    assert json.loads(path.read_text()) == {
        "cloude_a": "metal",
        "cloude_b": "matrix",
    }


# --------------------------------------------------------------------------- #
# 3. ThemeStore.set_project_theme (<working_dir>/.cc.theme)
# --------------------------------------------------------------------------- #


def test_project_theme_two_writes_use_distinct_temp_paths(monkeypatch, tmp_path):
    """Negative control: watched RED with the fix reverted to a fixed name."""
    mgr = _bare_manager(monkeypatch, tmp_path)
    project = tmp_path / "proj"
    project.mkdir()
    seen = _record_replace_sources(monkeypatch)

    mgr._theme_store.set_project_theme(project, "metal")
    mgr._theme_store.set_project_theme(project, "matrix")

    assert len(seen) == 2
    assert seen[0] != seen[1]


def test_project_theme_write_leaves_a_valid_complete_file(monkeypatch, tmp_path):
    mgr = _bare_manager(monkeypatch, tmp_path)
    project = tmp_path / "proj"
    project.mkdir()

    mgr._theme_store.set_project_theme(project, "metal")

    dotfile = project / ".cc.theme"
    assert dotfile.read_text(encoding="utf-8") == "metal\n"


def test_project_theme_failed_write_leaves_no_orphan_temp_file(monkeypatch, tmp_path):
    mgr = _bare_manager(monkeypatch, tmp_path)
    project = tmp_path / "proj"
    project.mkdir()
    _force_replace_failure(monkeypatch)

    with pytest.raises(OSError):
        mgr._theme_store.set_project_theme(project, "metal")

    assert _tmp_orphans(project) == []


# --------------------------------------------------------------------------- #
# 4. config_files_io.atomic_write
# --------------------------------------------------------------------------- #


def test_atomic_write_two_writes_use_distinct_temp_paths(monkeypatch, tmp_path):
    """Negative control: watched RED with the fix reverted to a fixed name."""
    monkeypatch.setenv("CLOUDE_TEST_MODE", "1")
    target = tmp_path / "notes.txt"
    seen = _record_replace_sources(monkeypatch)

    config_files_io.atomic_write(target, "one")
    config_files_io.atomic_write(target, "two")

    assert len(seen) == 2
    assert seen[0] != seen[1]


def test_atomic_write_leaves_a_valid_complete_file(monkeypatch, tmp_path):
    monkeypatch.setenv("CLOUDE_TEST_MODE", "1")
    target = tmp_path / "notes.txt"

    config_files_io.atomic_write(target, "hello world")

    assert target.read_text(encoding="utf-8") == "hello world"


def test_atomic_write_failed_write_leaves_no_orphan_temp_file(monkeypatch, tmp_path):
    monkeypatch.setenv("CLOUDE_TEST_MODE", "1")
    target = tmp_path / "notes.txt"
    _force_replace_failure(monkeypatch)

    with pytest.raises(OSError):
        config_files_io.atomic_write(target, "hello world")

    assert _tmp_orphans(tmp_path) == []
