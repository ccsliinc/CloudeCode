"""The boot integrity gate must read where the daily check writes.

This file exists because of a specific, SILENT failure mode. The gate
(``src/core/db_integrity_gate.py``) skips a 20 to 50 second
``PRAGMA integrity_check`` when a cached verdict in
``<state_dir>/db-integrity/latest.json`` is fresh, bound to this install
and ``ok``. The daily background check writes that artifact. Both sides
resolve the state directory independently of one another.

If those two ever resolve DIFFERENT directories, the gate finds nothing,
falls to its ``never_ran`` rung and re-walks the whole database on every
single boot. Nothing raises, nothing is logged as an error, and the only
symptom is that the feature stops helping - which is indistinguishable
from the gate being broken, and invites exactly the wrong diagnosis.

Issue #113 (Adam's ``state_dir_is_explicit()``, ported onto this line's
``src/config/`` package) changes what an explicit ``CLOUDE_STATE_DIR``
does to the legacy ``log_directory`` pin. That is a change in the same
area, so this file pins the property the port must not break, in BOTH
configurations: with a state directory explicitly named, and with the
default in force.

Three things here are deliberate.

  * The state directory is resolved through the REAL path, a ``Settings``
    instance, never by handing a ``tmp_path`` to the helpers. A test that
    passes the same Path to both sides proves only that two functions
    agree about an argument, which was never in doubt. The question is
    whether the two SITES derive the same directory.
  * ``test_a_reader_pointed_elsewhere_does_not_skip`` is the negative
    control and the load-bearing test. It reproduces the feared failure
    exactly. Without it, a test that asserted "the gate skipped" would
    pass just as happily against a gate that skips unconditionally, and
    the whole file would be decoration.
  * ``test_main_derives_one_state_dir_for_both_sites`` reads
    ``src/main.py`` itself, because the agreement above is a property of
    the two CALL SITES, not of the functions they call. A future edit
    introducing a second derivation at either site would leave every
    behavioural test in this file green.
"""

from __future__ import annotations

import ast
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault(
    "DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_gatesd_wd_")
)
os.environ.setdefault(
    "LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_gatesd_logs_")
)
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.config import Settings
from src.config import state_paths
from src.core import db_integrity_gate as gate
from src.core.db_integrity import (
    ENABLE_ENV,
    SOURCE_SCHEDULED,
    latest_path,
    read_verdict,
    run_integrity_check_once,
)
from src.core.db_integrity_task import DatabaseIntegrityScheduler
from src.core.db_migration import ensure_db_migrated
from src.core.db_state import STATUS_OK
from src.core.db import db_path_for

APP_VERSION = "0.0.0-test"
CONFIG_VERSION = 4

#: The one rung on which the gate is allowed to skip the pragma.
SKIP_RUNG = gate.SKIP_CACHED_OK


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _settings_for(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    explicit: bool,
) -> Tuple[Settings, Path]:
    """Build a Settings wired like a real install, and its legacy dir.

    Description: ``explicit=True`` names a state directory the way an
      operator isolating an instance does; ``explicit=False`` is the
      shape of this owner's live install, where neither
      ``CLOUDE_STATE_DIR`` nor ``LOG_DIRECTORY`` is set and the default
      under ``Path.home()`` is in force. Both cases ALSO declare a legacy
      ``log_directory`` holding decoy copies, because the whole point of
      issue #113 is what an explicit state dir does to that rung.
    Inputs: tmp_path (Path), monkeypatch (pytest.MonkeyPatch), explicit
      (bool) - whether the install names a state directory.
    Output: (Settings, Path) - the settings object and the legacy dir.
    Example: s, legacy = _settings_for(tmp_path, mp, explicit=True)
    """
    legacy_dir = tmp_path / "legacy_log_directory"
    legacy_dir.mkdir()
    monkeypatch.setenv(ENABLE_ENV, "1")

    kwargs: Dict[str, Any] = {
        "_env_file": None,
        "DEFAULT_WORKING_DIR": str(tmp_path / "wd"),
        "LOG_DIRECTORY": str(legacy_dir),
        "TOTP_SECRET": "testsecretnotreal",
        "JWT_SECRET": "testjwtnotreal",
    }
    if explicit:
        named = tmp_path / "named_state"
        named.mkdir()
        kwargs["CLOUDE_STATE_DIR"] = str(named)
    else:
        home = tmp_path / "home"
        (home / "Library" / "Application Support" / "CloudeCode").mkdir(
            parents=True
        )
        monkeypatch.setattr(Path, "home", lambda: home)
        monkeypatch.delenv("CLOUDE_STATE_DIR", raising=False)

    settings_obj = Settings(**kwargs)
    assert settings_obj.state_dir_is_explicit() is explicit
    return settings_obj, legacy_dir


def _run_the_daily_check(state_dir: Path) -> Dict[str, Any]:
    """Publish a verdict by running THE DAILY CHECK, and return it.

    Description: the artifact is written by
      ``run_integrity_check_once``, which is literally what
      ``DatabaseIntegrityScheduler._loop`` hands to ``asyncio.to_thread``
      every interval - not by a hand-built dict and not by the gate's own
      forced run. That distinction is the whole point of this file: the
      question is whether the DAILY WRITER and the BOOT READER land on
      one directory, so the daily writer has to be the thing that writes.
      The database is migrated first because the check opens with
      ``create=False`` and reads ``meta.install_id`` off a real schema.
    Inputs: state_dir (Path) - as the scheduler would resolve it.
    Output: dict - the published record, with ``source`` "scheduled".
    Example: _run_the_daily_check(sd)["status"] -> 'ok'
    """
    result = ensure_db_migrated(state_dir, CONFIG_VERSION, APP_VERSION)
    assert result.status == STATUS_OK, result.message

    record = run_integrity_check_once(state_dir)
    assert record["status"] == "ok", record
    assert record["source"] == SOURCE_SCHEDULED, (
        "this artifact was not written by the daily check"
    )
    assert record.get("install_id"), "the daily check published no install_id"

    on_disk = read_verdict(state_dir)
    assert on_disk == record, "the daily check's record is not what is on disk"
    return record


def _ask_the_gate(state_dir: Path) -> gate.BootIntegrityResult:
    """Put the boot question to the gate, against a real connection.

    Inputs: state_dir (Path) - the directory the READER resolved.
    Output: BootIntegrityResult.
    Example: _ask_the_gate(sd).skipped -> True
    """
    conn = sqlite3.connect(str(db_path_for(state_dir)))
    try:
        return gate.boot_integrity_verdict(state_dir, conn)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# The property: one install, one state directory, both sites agree.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("explicit", [True, False], ids=["explicit", "default"])
def test_the_gate_finds_the_artifact_the_daily_check_wrote(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, explicit: bool
) -> None:
    """THE POINT OF THIS FILE. The daily check writes, the gate reads,
    and the gate takes its skip rung - with the state directory resolved
    through the real ``Settings`` path on both sides, in both
    configurations.

    Run with ``explicit=True`` this is the configuration issue #113
    changes; with ``explicit=False`` it is the shape of the owner's live
    install. Neither may lose the artifact.
    """
    settings_obj, legacy_dir = _settings_for(
        tmp_path, monkeypatch, explicit=explicit
    )

    # A decoy at the legacy location. Nothing may ever resolve to it, in
    # either configuration: the db-integrity artifact lives in a
    # SUBDIRECTORY and is not a bare pinned filename, so the
    # log_directory rung cannot reach it whatever #113 decides.
    (legacy_dir / "db-integrity").mkdir()
    (legacy_dir / "db-integrity" / "latest.json").write_text("{}")

    # Exactly what src/main.py does, at its two separate call sites.
    writer_state_dir = settings_obj.get_state_dir()   # DatabaseIntegrityScheduler
    reader_state_dir = settings_obj.get_state_dir()   # ensure_db_migrated

    assert writer_state_dir == reader_state_dir
    assert latest_path(writer_state_dir) == latest_path(reader_state_dir)
    assert legacy_dir not in latest_path(reader_state_dir).parents

    record = _run_the_daily_check(writer_state_dir)
    assert latest_path(writer_state_dir).exists()

    result = _ask_the_gate(reader_state_dir)

    assert result.skipped is True, (
        f"the gate did not stand on the cached verdict: rung={result.rung} "
        f"reason={result.reason}"
    )
    assert result.rung == SKIP_RUNG
    assert result.verdict == "ok"
    assert result.duration_seconds == 0.0
    # The verdict it stood on is the one the daily check published, not a
    # second one the gate wrote for itself.
    assert read_verdict(reader_state_dir)["finished_at"] == record["finished_at"]


def test_the_scheduler_writes_where_the_gate_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The daily writer is a long-lived object holding its own copy of the
    state dir, so the agreement is asserted against THAT object rather
    than against the expression that built it.

    ``DatabaseIntegrityScheduler`` stores ``self.state_dir`` at
    construction and every later write goes through it. A future change
    that normalised, resolved or defaulted that stored value would move
    the artifact without touching either resolver.
    """
    settings_obj, _legacy = _settings_for(tmp_path, monkeypatch, explicit=True)
    scheduler = DatabaseIntegrityScheduler(settings_obj.get_state_dir())

    assert scheduler.state_dir == settings_obj.get_state_dir()
    assert latest_path(scheduler.state_dir) == latest_path(
        settings_obj.get_state_dir()
    )

    _run_the_daily_check(scheduler.state_dir)
    assert _ask_the_gate(settings_obj.get_state_dir()).skipped is True


# ---------------------------------------------------------------------------
# NEGATIVE CONTROL. Watched red before any green above was trusted.
# ---------------------------------------------------------------------------


def test_a_reader_pointed_elsewhere_does_not_skip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE LOAD-BEARING TEST. The exact feared failure, reproduced.

    The daily check writes into one directory and the gate is asked about
    another. It must fall to ``never_ran`` and RUN the pragma. If this
    passes while the tests above also pass, they are measuring something;
    if a gate ever skipped here it would be skipping on no evidence at
    all, and every positive assertion in this file would be worthless.
    """
    settings_obj, _legacy = _settings_for(tmp_path, monkeypatch, explicit=True)
    written_to = settings_obj.get_state_dir()
    _run_the_daily_check(written_to)

    elsewhere = tmp_path / "somewhere_else"
    elsewhere.mkdir()
    # Give it a database so the gate reaches the artifact rungs rather
    # than refusing for a reason that has nothing to do with the path.
    for _ in range(2):
        ensure_db_migrated(elsewhere, CONFIG_VERSION, APP_VERSION)
    (elsewhere / "db-integrity" / "latest.json").unlink()

    result = _ask_the_gate(elsewhere)

    assert result.skipped is False
    assert result.rung == gate.RUN_NEVER_RAN, (
        "a gate looking in the wrong directory must report that it found "
        f"nothing, not {result.rung}"
    )


# ---------------------------------------------------------------------------
# One source of truth, asserted against src/main.py itself.
# ---------------------------------------------------------------------------


def _first_arg_source(tree: ast.AST, callee: str) -> Optional[str]:
    """The unparsed first positional argument of a named call.

    Description: finds ``callee(...)`` anywhere in the tree and returns
      its first positional argument as source text. A dotted callee is
      matched on its final attribute name, so ``mod.f()`` matches ``f``.
    Inputs: tree (ast.AST), callee (str) - the function or class name.
    Output: str | None - the argument's source, None when the call is
      absent or takes no positional argument.
    Example: _first_arg_source(ast.parse("f(a.b())"), "f") -> 'a.b()'
    """
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        func = node.func
        name = (
            func.attr if isinstance(func, ast.Attribute)
            else func.id if isinstance(func, ast.Name)
            else None
        )
        if name == callee:
            return ast.unparse(node.args[0])
    return None


def test_the_analyser_can_tell_two_derivations_apart() -> None:
    """NEGATIVE CONTROL FOR THE GUARD BELOW.

    An analyser that returned the same string for everything would make
    the next test pass against any main.py at all. This proves it reads
    the argument rather than the call.
    """
    agreeing = ast.parse(
        "ensure_db_migrated(settings.get_state_dir(), 4, v)\n"
        "DatabaseIntegrityScheduler(settings.get_state_dir())\n"
    )
    assert _first_arg_source(agreeing, "ensure_db_migrated") == (
        _first_arg_source(agreeing, "DatabaseIntegrityScheduler")
    )

    drifted = ast.parse(
        "ensure_db_migrated(settings.get_state_dir(), 4, v)\n"
        "DatabaseIntegrityScheduler(Path(os.environ['CLOUDE_STATE_DIR']))\n"
    )
    assert _first_arg_source(drifted, "ensure_db_migrated") != (
        _first_arg_source(drifted, "DatabaseIntegrityScheduler")
    )
    assert _first_arg_source(drifted, "not_called_anywhere") is None


def test_main_derives_one_state_dir_for_both_sites() -> None:
    """The gate's reader and the daily check's writer must be handed the
    SAME expression in ``src/main.py``, not two spellings that happen to
    agree today.

    The behavioural tests above pass a Settings object to both sides
    themselves, so they cannot see a second derivation introduced at a
    call site. This can. If you are here because this went red, the fix
    is to route the new site through ``settings.get_state_dir()``, not to
    relax the assertion: a second derivation is the whole defect.
    """
    main_py = Path(__file__).resolve().parents[1] / "src" / "main.py"
    tree = ast.parse(main_py.read_text())

    reader = _first_arg_source(tree, "ensure_db_migrated")
    writer = _first_arg_source(tree, "DatabaseIntegrityScheduler")

    assert reader == "settings.get_state_dir()", (
        f"the boot gate's state dir is derived as {reader!r}"
    )
    assert writer == "settings.get_state_dir()", (
        f"the daily check's state dir is derived as {writer!r}"
    )
    assert reader == writer


def test_the_artifact_never_goes_through_the_name_keyed_pin() -> None:
    """Structural reason the #113 change cannot move this artifact.

    The legacy ``log_directory`` rung keys on a BARE FILENAME. The
    integrity artifact lives at ``<state_dir>/db-integrity/latest.json``,
    a subdirectory, and is resolved by joining a Path - it never reaches
    ``state_file_pin`` at all. So even a pin that resolved every one of
    its four filenames into the legacy directory could not drag this file
    with it.
    """
    pins: Dict[tuple, Any] = {}
    state_dir = Path("/nonexistent/state")
    legacy = Path("/nonexistent/legacy")

    pinned_names: List[str] = [
        "refresh_tokens.db", "session_metadata.json",
        "pinned_themes.json", "unread_state.json",
    ]
    assert latest_path(state_dir).name not in pinned_names
    assert latest_path(state_dir).parent != state_dir

    # The pin, driven with the legacy rung fully available, answers only
    # about bare filenames and never about this one.
    for name in pinned_names:
        resolved, _location = state_paths.state_file_pin(
            name, pins=pins, resolved_state_dir=state_dir,
            state_dir_override=str(state_dir), log_directory=str(legacy),
            state_dir_explicit=False,
        )
        assert resolved.name == name
        assert resolved != latest_path(state_dir)
