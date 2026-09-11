"""RETARGETED SEAMS, UNCHANGED BEHAVIOUR. On this line the two theme
stores live on ``SessionManager._theme_store``; ``set_pinned_theme`` is
still the manager's own, because it also mirrors onto the live Session.

Which theme store answers for a session, and why (issue #65).

A theme has two durable stores keyed on different things: the
per-session pin in ``pinned_themes.json`` (keyed on the bare tmux name)
and the project default in ``<working_dir>/.cc.theme`` (keyed on the
directory). The dotfile used to be read FIRST, so a pin was discarded on
every server restart and two sessions in one folder could never hold two
different themes.

The tests here are the contract for the inversion:

1. Pin plus a conflicting dotfile resolves to the PIN.
2. No pin plus a dotfile resolves to the DOTFILE. POSITIVE CONTROL, and
   it is load-bearing: an inversion that broke it would pass test 1
   perfectly while deleting the shipped project-default feature.
3. Two sessions in ONE directory with two pins resolve to two themes.
4. A pin survives the manager being rebuilt from disk, which is the
   restart case the owner actually reported.
5. A working_dir reached through a symlink answers the same as the same
   directory reached by its real path (gotcha 6).

Plus two consequences of promoting the JSON map to first: a pin must not
be pruned merely because its tmux session is not running right now, and
the map's writer must back up the bytes it is about to replace.

Everything runs against REAL temp directories and a REAL symlink. The
pure ladder is exercised directly too, because a function that always
finds something is worse than useless and its "neither store holds
anything" answer is the negative control.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
# The pydantic settings loader sys.exit(1)s without these, so they are set
# BEFORE any ``src.*`` import.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_tp_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_tp_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core.session_manager import SessionManager
from src.core.session_theme_resolution import (
    THEME_SOURCE_NONE,
    THEME_SOURCE_PIN,
    THEME_SOURCE_PROJECT_DEFAULT,
    resolve_theme,
)


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__`` to load.

    ``Settings`` is a pydantic v2 model and forbids instance attribute
    monkeypatching, so the whole ``settings`` symbol in
    ``src.core.session_manager`` is swapped for this during a test. Only
    what the code under test touches is stubbed.
    """

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


def _manager(monkeypatch, tmp_path: Path) -> SessionManager:
    """Build a SessionManager whose state files live under ``tmp_path``.

    Constructing a SECOND one with the same ``tmp_path`` is how the
    restart case is measured: ``__init__`` re-reads
    ``pinned_themes.json`` off disk, so the new object knows only what
    was persisted.
    """
    state = tmp_path / "state"
    state.mkdir(exist_ok=True)
    logs = tmp_path / "logs"
    logs.mkdir(exist_ok=True)
    stub = _StubSettings(pin_path=state / "pinned_themes.json", log_dir=logs)
    monkeypatch.setattr("src.core.session_manager.settings", stub)
    return SessionManager()


# --------------------------------------------------------------------------- #
# The pure ladder, including its negative control
# --------------------------------------------------------------------------- #


def test_ladder_prefers_the_pin():
    """An explicit per-session pin outranks the folder's default."""
    got = resolve_theme(pinned="dracula", project_default="snes")
    assert got.theme_id == "dracula"
    assert got.source == THEME_SOURCE_PIN


def test_ladder_falls_through_to_the_project_default():
    """With no pin, the folder's default is what answers."""
    got = resolve_theme(pinned=None, project_default="snes")
    assert got.theme_id == "snes"
    assert got.source == THEME_SOURCE_PROJECT_DEFAULT


def test_ladder_answers_nothing_when_neither_store_holds_a_theme():
    """NEGATIVE CONTROL. Neither store holding a value must answer None.

    A resolver that always produced something would pass both tests
    above and silently paint an invented theme on every unthemed
    session, which is indistinguishable from working until a user
    notices their app changed colour on its own.
    """
    got = resolve_theme(pinned=None, project_default=None)
    assert got.theme_id is None
    assert got.source == THEME_SOURCE_NONE


def test_ladder_treats_a_blank_value_as_absent():
    """An empty string in either store is nothing, not a theme named ""."""
    assert resolve_theme(pinned="", project_default="snes").theme_id == "snes"
    assert resolve_theme(pinned="", project_default="").theme_id is None


# --------------------------------------------------------------------------- #
# 1 and 2. The inversion, against real files
# --------------------------------------------------------------------------- #


def test_pin_wins_over_a_conflicting_dotfile(monkeypatch, tmp_path):
    """A pinned session paints its pin, not the folder's default."""
    mgr = _manager(monkeypatch, tmp_path)
    project = tmp_path / "proj"
    project.mkdir()

    mgr._theme_store.set_project_theme(project, "snes")
    mgr.set_pinned_theme("cloude_proj", "dracula")

    assert mgr._theme_store.resolve_project_theme(project, "cloude_proj") == "dracula"


def test_an_unpinned_session_still_inherits_the_project_default(
    monkeypatch, tmp_path
):
    """POSITIVE CONTROL: the project default is still a working feature.

    A session that has never been pinned must take its folder's colours.
    An inversion that broke this would satisfy every precedence
    assertion above and quietly delete the reason the dotfile exists.
    """
    mgr = _manager(monkeypatch, tmp_path)
    project = tmp_path / "proj"
    project.mkdir()

    mgr._theme_store.set_project_theme(project, "snes")

    assert mgr._theme_store.resolve_project_theme(project, "cloude_never_pinned") == "snes"
    # And with no name to key a pin on at all.
    assert mgr._theme_store.resolve_project_theme(project, None) == "snes"


def test_clearing_a_pin_drops_back_to_the_project_default(
    monkeypatch, tmp_path
):
    """Clearing means "use my project's default", not "use nothing"."""
    mgr = _manager(monkeypatch, tmp_path)
    project = tmp_path / "proj"
    project.mkdir()

    mgr._theme_store.set_project_theme(project, "snes")
    mgr.set_pinned_theme("cloude_proj", "dracula")
    mgr.set_pinned_theme("cloude_proj", None)

    assert mgr._theme_store.resolve_project_theme(project, "cloude_proj") == "snes"


# --------------------------------------------------------------------------- #
# 3. Two sessions, one folder, two themes
# --------------------------------------------------------------------------- #


def test_two_sessions_in_one_folder_hold_two_different_themes(
    monkeypatch, tmp_path
):
    """The headline symptom. One directory, two pins, two answers."""
    mgr = _manager(monkeypatch, tmp_path)
    project = tmp_path / "shared"
    project.mkdir()

    mgr.set_pinned_theme("cloude_a", "snes")
    mgr.set_pinned_theme("cloude_b", "dracula")

    assert mgr._theme_store.resolve_project_theme(project, "cloude_a") == "snes"
    assert mgr._theme_store.resolve_project_theme(project, "cloude_b") == "dracula"


def test_a_third_unpinned_session_in_that_folder_takes_the_default(
    monkeypatch, tmp_path
):
    """Pinning two siblings must not change what the folder means.

    The theme PATCH used to write the dotfile as well, so pinning B
    rethemed every unpinned session in the directory. Nothing here
    writes the dotfile, so the default is whatever it was.
    """
    mgr = _manager(monkeypatch, tmp_path)
    project = tmp_path / "shared"
    project.mkdir()

    mgr._theme_store.set_project_theme(project, "blade_runner")
    mgr.set_pinned_theme("cloude_a", "snes")
    mgr.set_pinned_theme("cloude_b", "dracula")

    assert mgr._theme_store.resolve_project_theme(project, "cloude_c") == "blade_runner"
    assert mgr._theme_store.get_project_theme(project) == "blade_runner"


# --------------------------------------------------------------------------- #
# 4. The restart case
# --------------------------------------------------------------------------- #


def test_a_pin_survives_the_manager_being_rebuilt_from_disk(
    monkeypatch, tmp_path
):
    """THE REPORTED BUG. A restart must not lose the pin.

    The second manager is built from the same state directory and knows
    only what reached disk, which is exactly what a server restart or a
    boot re-adopt sees.
    """
    project = tmp_path / "proj"
    project.mkdir()

    first = _manager(monkeypatch, tmp_path)
    first._theme_store.set_project_theme(project, "snes")
    first.set_pinned_theme("cloude_proj", "dracula")

    reborn = _manager(monkeypatch, tmp_path)

    assert reborn._theme_store.pinned_themes.get("cloude_proj") == "dracula"
    assert reborn._theme_store.resolve_project_theme(project, "cloude_proj") == "dracula"


def test_two_sessions_in_one_folder_keep_their_themes_across_a_restart(
    monkeypatch, tmp_path
):
    """The reproduction from the issue, end to end through the stores."""
    project = tmp_path / "proj"
    project.mkdir()

    first = _manager(monkeypatch, tmp_path)
    first.set_pinned_theme("cloude_a", "snes")
    first.set_pinned_theme("cloude_b", "dracula")

    reborn = _manager(monkeypatch, tmp_path)

    assert reborn._theme_store.resolve_project_theme(project, "cloude_a") == "snes"
    assert reborn._theme_store.resolve_project_theme(project, "cloude_b") == "dracula"


# --------------------------------------------------------------------------- #
# 5. One directory, two spellings (gotcha 6)
# --------------------------------------------------------------------------- #


def test_a_symlinked_working_dir_resolves_to_the_same_theme(
    monkeypatch, tmp_path
):
    """A folder reached through a symlink is the SAME folder.

    ``~/Development`` on the owner's box is a symlink into iCloud, and a
    directory-keyed store that did not canonicalise would split one
    project into two, each with its own default. Measured against a real
    symlink rather than trusted from reading the code.
    """
    mgr = _manager(monkeypatch, tmp_path)
    real = tmp_path / "real_project"
    real.mkdir()
    link = tmp_path / "linked_project"
    link.symlink_to(real, target_is_directory=True)

    # Written through the link.
    mgr._theme_store.set_project_theme(link, "snes")

    # One file, under the real path, readable by either spelling.
    assert (real / ".cc.theme").is_file()
    assert not (link / ".cc.theme").is_symlink()
    assert mgr._theme_store.get_project_theme(real) == "snes"
    assert mgr._theme_store.get_project_theme(link) == "snes"
    assert mgr._theme_store.resolve_project_theme(real, "cloude_x") == "snes"
    assert mgr._theme_store.resolve_project_theme(link, "cloude_x") == "snes"


# --------------------------------------------------------------------------- #
# Consequences of the JSON map becoming the primary store
# --------------------------------------------------------------------------- #


def test_a_pin_is_not_dropped_because_its_session_is_not_running(
    monkeypatch, tmp_path
):
    """A reconcile pass must not delete a pin for an absent tmux name.

    Dropping absent names was safe while the dotfile was the real store.
    Now it is the user's choice being erased, on a name this app re-mints
    from a project slug and will hand out again. The removal path is the
    explicit close, ``ThemeStore.discard_pin``, and nothing else.
    """
    mgr = _manager(monkeypatch, tmp_path)
    mgr.set_pinned_theme("cloude_gone", "dracula")

    source = Path(SessionManager.__module__.replace(".", "/") + ".py")
    text = (ROOT / source).read_text(encoding="utf-8")
    assert "pinned_themes_pruning_dead" not in text, (
        "the liveness prune is back; a pin for a session that is not "
        "running right now is not a dead pin"
    )

    # The explicit close is still the way an entry goes away.
    mgr._theme_store.discard_pin("cloude_gone")
    assert "cloude_gone" not in mgr._theme_store.pinned_themes


def test_the_pin_map_is_backed_up_before_it_is_replaced(monkeypatch, tmp_path):
    """The writer keeps one generation of the bytes it overwrites.

    ``_load_pinned_themes`` starts from an empty map when it cannot parse
    the file, so without this one corrupt read plus one pin would write
    that empty map over every pin the user has, unrecoverably.
    """
    mgr = _manager(monkeypatch, tmp_path)
    path = tmp_path / "state" / "pinned_themes.json"

    mgr.set_pinned_theme("cloude_a", "snes")
    assert json.loads(path.read_text()) == {"cloude_a": "snes"}
    # Nothing to back up on the very first write.
    assert not path.with_suffix(path.suffix + ".bak").exists()

    mgr.set_pinned_theme("cloude_b", "dracula")

    backup = path.with_suffix(path.suffix + ".bak")
    assert backup.is_file()
    assert json.loads(backup.read_text()) == {"cloude_a": "snes"}
    assert json.loads(path.read_text()) == {
        "cloude_a": "snes",
        "cloude_b": "dracula",
    }
    assert not path.with_suffix(path.suffix + ".tmp").exists()


def test_an_unparseable_pin_map_does_not_take_the_process_down(
    monkeypatch, tmp_path
):
    """A corrupt preferences file degrades to empty, it never raises."""
    state = tmp_path / "state"
    state.mkdir()
    (state / "pinned_themes.json").write_text("{ this is not json",
                                              encoding="utf-8")

    mgr = _manager(monkeypatch, tmp_path)

    assert mgr._theme_store.pinned_themes == {}
    # And the bytes are still there to be rescued, until the next write
    # moves them to the .bak beside it.
    assert (state / "pinned_themes.json").read_text(encoding="utf-8") == (
        "{ this is not json"
    )


def test_an_unreadable_dotfile_does_not_defeat_a_pin(monkeypatch, tmp_path):
    """A dotfile that cannot be read is the LOWER rung, so a pin stands.

    A reading that did not happen is not a reading of nothing. Here the
    pin answers before the dotfile is consulted at all, so an unreadable
    default cannot cost the user their pinned theme.
    """
    mgr = _manager(monkeypatch, tmp_path)
    project = tmp_path / "proj"
    project.mkdir()
    mgr._theme_store.set_project_theme(project, "snes")
    mgr.set_pinned_theme("cloude_proj", "dracula")

    dotfile = project / ".cc.theme"
    dotfile.chmod(0o000)
    try:
        if os.access(dotfile, os.R_OK):
            pytest.skip("running as a user that ignores file modes")
        assert mgr._theme_store.resolve_project_theme(project, "cloude_proj") == "dracula"
    finally:
        dotfile.chmod(0o644)
