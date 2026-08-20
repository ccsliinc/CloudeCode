"""Session-metadata continuity across an upgrade -> downgrade round trip.

THE QUESTION. ``v0.8.1`` reads ``session_metadata.json`` from
``LOG_DIRECTORY`` and nowhere else. The current version resolves the same
file through ``Settings._resolve_state_file()``, which prefers the state
directory and falls back to ``LOG_DIRECTORY``. The round-trip harness
(``scripts/ci/roundtrip-upgrade-downgrade.sh``) ran with zero sessions and
reported this step as CANNOT DETERMINE rather than guessing. This module
is the measurement that replaces the guess.

WHAT IS MEASURED, AND WITH WHOSE CODE. Nothing here paraphrases either
version. The new side runs the real ``Settings`` and the real
``SessionManager._load_session_metadata`` / ``_save_session_metadata``
/ ``_clear_stale_metadata``. The old side runs ``v0.8.1``'s OWN
``get_session_metadata_path`` source, extracted from the tag with
``git show`` and compiled at test time - see ``_old_reader``. If that
extraction cannot be done (shallow clone, tag absent), the affected tests
report CANNOT DETERMINE by skipping with a named reason; they never
degrade into a pass.

THE DETECTOR IS ITSELF TESTED. ``downgrade_verdict()`` returns one of
three values - INTACT, STALE, ABSENT - and
``test_detector_reports_absent_when_pointed_at_an_empty_location`` and
``test_detector_reports_stale_when_the_old_copy_diverges`` prove it can
report the losses it claims to detect. A continuity assertion that has
never been watched go red is not evidence of continuity.

SAFETY. Hermetic. Every path is a ``tmp_path`` fixture; no test here
opens a tmux socket, and the suite-wide guard in ``tests/conftest.py``
would raise if one tried to reach the production ``cloude`` socket.
"""
from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_smc_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_smc_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.config import settings
from src.core.session_manager import SessionManager
from src.models import Session

OLD_REF = "v0.8.1"

INTACT = "INTACT"
STALE = "STALE"
ABSENT = "ABSENT"


# ---- the old version's own resolver, not a paraphrase of it -----------


def _extract_old_resolver() -> Tuple[Optional[Any], str]:
    """Compile ``v0.8.1``'s ``get_session_metadata_path`` from the tag.

    Description: reads the OLD version's ``src/config.py`` out of git and
      compiles that one method verbatim, so the "what would the old
      version see" side of every assertion below is the old version's
      real code rather than this module's memory of it. A rewrite of the
      method in the tag is picked up automatically.
    Inputs: none (reads ``OLD_REF`` from the repo this file lives in).
    Output: (callable | None, reason). The callable takes one object with
      a ``log_directory`` attribute and returns a ``Path``. ``None`` plus
      a human reason when the tag or the method could not be read - the
      CANNOT-DETERMINE outcome, never silently a pass.
    """
    try:
        src = subprocess.check_output(
            ["git", "show", f"{OLD_REF}:src/config.py"],
            cwd=str(ROOT),
            text=True,
            stderr=subprocess.PIPE,
        )
    except (subprocess.CalledProcessError, OSError) as exc:
        return None, f"could not read {OLD_REF}:src/config.py from git ({exc})"

    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        return None, f"{OLD_REF}:src/config.py did not parse ({exc})"

    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef) or node.name != "Settings":
            continue
        for item in node.body:
            if (
                isinstance(item, ast.FunctionDef)
                and item.name == "get_session_metadata_path"
            ):
                module = ast.Module(body=[item], type_ignores=[])
                ast.fix_missing_locations(module)
                ns: Dict[str, Any] = {"Path": Path}
                exec(compile(module, f"<{OLD_REF}:src/config.py>", "exec"), ns)
                return ns["get_session_metadata_path"], "ok"
    return None, (
        f"{OLD_REF}:src/config.py has no Settings.get_session_metadata_path - "
        "the method this whole comparison rests on could not be located"
    )


_OLD_RESOLVER, _OLD_RESOLVER_REASON = _extract_old_resolver()


class _OldSettingsStub:
    """The one attribute ``v0.8.1``'s resolver reads. Nothing else."""

    def __init__(self, log_directory: str) -> None:
        self.log_directory = log_directory


def _old_reader(log_directory: Path) -> Path:
    """Where the OLD version would look for session metadata.

    Inputs: log_directory (Path) - the install's ``LOG_DIRECTORY``.
    Output: Path, as computed by ``v0.8.1``'s own method.
    Raises: pytest.skip when the old source could not be compiled - the
      CANNOT-DETERMINE outcome, reported by name.
    """
    if _OLD_RESOLVER is None:
        pytest.skip(f"CANNOT DETERMINE: {_OLD_RESOLVER_REASON}")
    return _OLD_RESOLVER(_OldSettingsStub(str(log_directory)))


# ---- the detector -----------------------------------------------------


def downgrade_verdict(log_directory: Path, live_session_id: str) -> str:
    """What the OLD version gets when it starts after the NEW one ran.

    Description: resolves the metadata file the way ``v0.8.1`` resolves
      it, then classifies the result into the three outcomes this repo
      requires. STALE is called out separately from ABSENT on purpose:
      an absent file makes the app start clean and is visible to the
      user, whereas a stale one silently rehydrates a session that is no
      longer the live one.
    Inputs: log_directory (Path) - the install's ``LOG_DIRECTORY``.
      live_session_id (str) - the id the NEW version last persisted.
    Output: one of ``INTACT`` / ``STALE`` / ``ABSENT``.
    Example: downgrade_verdict(log_dir, "sess-1") == INTACT
    """
    path = _old_reader(log_directory)
    if not path.exists():
        return ABSENT
    try:
        raw = json.loads(path.read_text())
    except (ValueError, OSError):
        return ABSENT
    return INTACT if raw.get("id") == live_session_id else STALE


# ---- fixtures ---------------------------------------------------------


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch) -> Tuple[Path, Path]:
    """A throwaway (old LOG_DIRECTORY, new state dir) pair, wired live.

    Inputs: tmp_path, monkeypatch (pytest fixtures).
    Output: (log_dir, state_dir).
    """
    log_dir = tmp_path / "logs"
    state_dir = tmp_path / "state"
    log_dir.mkdir()
    state_dir.mkdir()
    monkeypatch.setattr(settings, "log_directory", str(log_dir))
    monkeypatch.setattr(settings, "state_dir_override", str(state_dir))
    return log_dir, state_dir


def _session(session_id: str, name: str, working_dir: str = "/tmp/wd") -> Session:
    return Session(
        id=session_id,
        working_dir=working_dir,
        tmux_session=name,
        agent_type="claude",
    )


def _write_old_metadata(
    log_dir: Path, session_id: str, name: str, owned: list
) -> Path:
    """Write metadata where ``v0.8.1`` would have written it.

    The payload shape is produced by the CURRENT ``Session`` model plus
    the ``owned_tmux_sessions`` key, which is exactly what
    ``_save_session_metadata`` writes - the two versions share the file
    format; only the directory differs.
    """
    path = log_dir / "session_metadata.json"
    payload = json.loads(_session(session_id, name).model_dump_json())
    payload["owned_tmux_sessions"] = sorted(owned)
    path.write_text(json.dumps(payload, indent=2))
    return path


# ---- the measurements -------------------------------------------------


def test_old_version_resolver_was_really_loaded():
    """Guard: without this, every comparison below silently becomes a skip."""
    assert _OLD_RESOLVER is not None, _OLD_RESOLVER_REASON
    probe = _OLD_RESOLVER(_OldSettingsStub("/some/log/dir"))
    assert probe == Path("/some/log/dir/session_metadata.json")


def test_upgrade_reads_metadata_left_at_the_old_location(dirs):
    """UPGRADE. The new version finds and rehydrates old-location state."""
    log_dir, state_dir = dirs
    _write_old_metadata(log_dir, "sess-upgrade", "work-a", ["work-a", "work-b"])

    mgr = SessionManager()
    mgr._load_session_metadata()

    current = mgr.current_session()
    assert current is not None, "the new version did not rehydrate the old file"
    assert current.id == "sess-upgrade"
    assert current.tmux_session == "work-a"
    assert mgr.owned_tmux_sessions == {"work-a", "work-b"}
    assert not (state_dir / "session_metadata.json").exists(), (
        "reading must not copy the file to the new location - that would "
        "create the both-present ambiguity this test set is about"
    )


def test_plain_upgrade_writes_back_to_the_old_location(dirs):
    """DOWNGRADE, the good path. No relocation, so the old version still sees it."""
    log_dir, state_dir = dirs
    _write_old_metadata(log_dir, "sess-old", "work-a", ["work-a"])

    mgr = SessionManager()
    mgr._load_session_metadata()
    mgr.owned_tmux_sessions = {"work-a", "work-c"}
    mgr._save_session_metadata()

    assert not (state_dir / "session_metadata.json").exists()
    written = json.loads((log_dir / "session_metadata.json").read_text())
    assert written["owned_tmux_sessions"] == ["work-a", "work-c"], (
        "the new version's write did not land at the old path"
    )
    assert downgrade_verdict(log_dir, "sess-old") == INTACT


def test_detach_sequence_relocates_metadata_and_the_old_version_loses_it(dirs):
    """DOWNGRADE, the bad path - and it is reachable from one user action.

    ``SessionManager.detach_session`` unlinks the RESOLVED metadata path
    and then, if another session is still live, calls
    ``_save_session_metadata`` - which re-resolves. After the unlink the
    old location no longer exists, so the resolver returns the NEW path
    and the file MOVES. Nothing copies it back. This test runs those two
    real methods in that real order.
    """
    log_dir, state_dir = dirs
    _write_old_metadata(log_dir, "sess-detached", "work-a", ["work-a", "work-b"])

    mgr = SessionManager()
    mgr._load_session_metadata()
    assert mgr.current_session() is not None

    # the exact pair of statements detach_session runs
    mgr._clear_stale_metadata()
    survivor = _session("sess-survivor", "work-b")
    mgr._register_session(survivor, backend=None)
    mgr.owned_tmux_sessions = {"work-b"}
    mgr._save_session_metadata()

    assert (state_dir / "session_metadata.json").exists()
    assert not (log_dir / "session_metadata.json").exists(), (
        "the file was expected to have MOVED to the state dir"
    )
    assert downgrade_verdict(log_dir, "sess-survivor") == ABSENT


def test_metadata_present_in_both_locations_leaves_the_old_copy_stale(dirs):
    """DOWNGRADE, the worst path: the old version reads a wrong answer.

    Once the file exists in BOTH places the resolver prefers the new one
    and leaves the old on disk untouched forever. A downgrade then
    rehydrates a session that is no longer the live one - which is worse
    than finding nothing, because finding nothing is visible.
    """
    log_dir, state_dir = dirs
    _write_old_metadata(log_dir, "sess-stale", "work-a", ["work-a"])
    _write_old_metadata(state_dir, "sess-stale", "work-a", ["work-a"])
    stale_bytes = (log_dir / "session_metadata.json").read_bytes()

    mgr = SessionManager()
    mgr._load_session_metadata()
    live = _session("sess-current", "work-z")
    mgr._register_session(live, backend=None)
    mgr.owned_tmux_sessions = {"work-z"}
    mgr._save_session_metadata()

    assert json.loads((state_dir / "session_metadata.json").read_text())["id"] == "sess-current"
    assert (log_dir / "session_metadata.json").read_bytes() == stale_bytes, (
        "the old copy was expected to be left untouched"
    )
    assert downgrade_verdict(log_dir, "sess-current") == STALE


# ---- proof the detector can go red ------------------------------------


def test_detector_reports_absent_when_pointed_at_an_empty_location(dirs):
    """Red-proof 1: an emptied location must NOT read as continuity."""
    log_dir, _ = dirs
    assert downgrade_verdict(log_dir, "sess-anything") == ABSENT


def test_detector_reports_stale_when_the_old_copy_diverges(dirs):
    """Red-proof 2: a file that exists but names another session is STALE."""
    log_dir, _ = dirs
    _write_old_metadata(log_dir, "sess-yesterday", "work-a", ["work-a"])
    assert downgrade_verdict(log_dir, "sess-today") == STALE
    assert downgrade_verdict(log_dir, "sess-yesterday") == INTACT
