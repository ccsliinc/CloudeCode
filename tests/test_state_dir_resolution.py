"""feat/state-directory - tests for Settings.get_state_dir() and the
JSON-state-file old/new-location fallback in src/config.py.

Covers the three-outcome contract this repo requires (pass / fail /
could-not-evaluate applied to directory resolution):
- CLOUDE_STATE_DIR set to a valid path - used verbatim (after expanduser).
- CLOUDE_STATE_DIR unset - falls back to the macOS-native default
  (~/Library/Application Support/CloudeCode), never to a temp directory.
- CLOUDE_STATE_DIR set to a path that cannot be created - raises the
  named StateDirUnavailableError; never silently substitutes a temp
  directory, never an unhandled crash.
- session_metadata.json / pinned_themes.json / unread_state.json: old-
  location-only, new-location-only, and both-present (ambiguous - new
  wins, old is left on disk, never deleted).

Hermetic - every test points state_dir_override / log_directory at
tmp_path fixtures via monkeypatch on the ``settings`` singleton, and the
"unset" case patches Path.home() so it never touches the developer's
real ~/Library/Application Support/CloudeCode.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_sd_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_sd_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.config import settings, StateDirUnavailableError


@pytest.fixture(autouse=True)
def _reset_state_dir_override(monkeypatch):
    """Every test starts from a clean slate on the two fields under test.

    Description: ``settings`` is a process-wide singleton (see
      src/config.py's module-level construction) - a test that sets
      ``state_dir_override`` or ``log_directory`` and does not undo it
      would leak into every test that runs after it. ``monkeypatch``
      already restores attributes automatically at teardown; this
      fixture just guarantees every test starts from ``None`` regardless
      of what an earlier test (or the conftest-level env bootstrap) left
      behind.
    Inputs: monkeypatch (pytest fixture).
    Output: None.
    """
    monkeypatch.setattr(settings, "state_dir_override", None)
    monkeypatch.setattr(settings, "log_directory", None)


# ---------------------------------------------------------------------- #
# get_state_dir() - CLOUDE_STATE_DIR set / unset / uncreatable
# ---------------------------------------------------------------------- #

def test_get_state_dir_uses_override_when_set(tmp_path, monkeypatch):
    """CLOUDE_STATE_DIR set to a valid, writable path - used verbatim."""
    target = tmp_path / "cloude-state"
    monkeypatch.setattr(settings, "state_dir_override", str(target))

    resolved = settings.get_state_dir()

    assert resolved == target
    assert resolved.is_dir()


def test_get_state_dir_expands_tilde_in_override(tmp_path, monkeypatch):
    """A "~"-prefixed override expands via Path.expanduser(), matching
    the app's own convention used everywhere else in this file.

    Path.expanduser() reads $HOME directly (not Path.home()), so HOME is
    what must be patched here to redirect it under tmp_path.
    """
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(settings, "state_dir_override", "~/cloude-state-tilde")

    resolved = settings.get_state_dir()

    assert resolved == tmp_path / "cloude-state-tilde"
    assert resolved.is_dir()


def test_get_state_dir_default_when_unset(tmp_path, monkeypatch):
    """CLOUDE_STATE_DIR unset - falls back to the macOS-native default,
    NEVER to a temp directory. Path.home() is patched so this exercises
    the real default-computation code path without touching the
    developer's actual ~/Library/Application Support/CloudeCode."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert settings.state_dir_override is None

    resolved = settings.get_state_dir()

    expected = tmp_path / "Library" / "Application Support" / "CloudeCode"
    assert resolved == expected
    assert resolved.is_dir()
    # What is appended to home must be exactly the macOS-native suffix,
    # measured RELATIVE to the patched home.
    #
    # This used to read ``assert not str(resolved).startswith(
    # tempfile.gettempdir())``, which measured nothing about the code and
    # passed on macOS only by accident. ``tmp_path`` IS under the system
    # temp root on every platform - this test deliberately puts the fake
    # home there - so an absolute prefix test can only ever be asking
    # whether the FIXTURE is in a temp dir. On Linux both sides are
    # "/tmp" and it failed; on macOS pytest hands back a realpath'd
    # "/private/var/folders/..." while tempfile.gettempdir() returns
    # "/var/folders/..." (no /private), so the prefix never matched and
    # it passed. Measured 2026-08-24. The real guarantee is exercised by
    # test_get_state_dir_default_is_never_under_the_system_temp_dir
    # below, which patches home to a path that is genuinely NOT in temp.
    assert resolved.relative_to(tmp_path) == Path(
        "Library"
    ) / "Application Support" / "CloudeCode"


def test_get_state_dir_default_is_never_under_the_system_temp_dir(monkeypatch):
    """The "never a silent temp-dir fallback" guarantee from
    get_state_dir()'s docstring, measured for real.

    Description: patches Path.home() to a directory that is genuinely
      OUTSIDE the system temp root (created under the checkout, which
      build/ already gitignores), so "the resolved path is not under
      tempfile.gettempdir()" is a statement about the resolver rather
      than about where pytest happens to put tmp_path.
    Inputs: monkeypatch (pytest fixture).
    Output: None.
    """
    temp_root = Path(tempfile.gettempdir()).resolve()
    base = ROOT.resolve()
    if base == temp_root or temp_root in base.parents:
        pytest.skip(
            f"CANNOT DETERMINE: this checkout ({base}) is itself under the "
            f"system temp root ({temp_root}), so no home rooted in it can "
            "distinguish 'resolved outside temp' from 'resolved inside temp'"
        )

    fake_home = base / "build" / f"state-dir-test-home-{uuid.uuid4().hex}"
    fake_home.mkdir(parents=True)
    try:
        monkeypatch.setattr(Path, "home", lambda: fake_home)
        assert settings.state_dir_override is None

        resolved = settings.get_state_dir().resolve()

        assert resolved == (
            fake_home / "Library" / "Application Support" / "CloudeCode"
        ).resolve()
        assert resolved.is_dir()
        assert resolved != temp_root
        assert temp_root not in resolved.parents
    finally:
        shutil.rmtree(fake_home, ignore_errors=True)


def test_get_state_dir_raises_named_error_when_uncreatable(tmp_path, monkeypatch):
    """CLOUDE_STATE_DIR points under a path component that is a plain
    file, not a directory - mkdir(parents=True) cannot create it. Must
    raise StateDirUnavailableError naming the path and cause; must NOT
    silently substitute a temp directory or crash with a bare OSError."""
    blocker = tmp_path / "blocker"
    blocker.write_text("this is a file, not a directory")
    target = blocker / "state"
    monkeypatch.setattr(settings, "state_dir_override", str(target))

    with pytest.raises(StateDirUnavailableError) as exc_info:
        settings.get_state_dir()

    err = exc_info.value
    assert err.path == target
    assert isinstance(err.cause, OSError)
    # The message must name the actual path so a user can act on it -
    # not a generic "something went wrong".
    assert str(target) in str(err)
    assert not target.exists()


def test_get_state_dir_uncreatable_does_not_touch_tmp(tmp_path, monkeypatch):
    """A failed resolution must not have created ANYTHING under the
    system temp directory as a fallback - the whole point of this
    feature is that /tmp is exactly the wrong place for this data."""
    before = set(os.listdir(tempfile.gettempdir()))
    blocker = tmp_path / "blocker2"
    blocker.write_text("x")
    monkeypatch.setattr(settings, "state_dir_override", str(blocker / "state"))

    with pytest.raises(StateDirUnavailableError):
        settings.get_state_dir()

    after = set(os.listdir(tempfile.gettempdir()))
    assert after == before


# ---------------------------------------------------------------------- #
# JSON state files: old/new-location fallback and both-present ambiguity
# ---------------------------------------------------------------------- #

def _configure_dirs(monkeypatch, tmp_path):
    """Wire an install that NEVER named a state directory, plus an old
    log_directory, and return both locations.

    Description: the state dir is redirected by patching ``Path.home()``
      rather than by setting ``state_dir_override``, and that is
      load-bearing rather than stylistic. Setting ``CLOUDE_STATE_DIR`` IS
      the operator saying where state lives, and it suppresses the legacy
      rung - see ``Settings.state_dir_is_explicit()``. Every case below
      describes an install that PREDATES ``CLOUDE_STATE_DIR`` and is
      therefore incapable of having set it; declaring one here would have
      the fixture contradict the scenario each test names.
    Inputs: monkeypatch, tmp_path (pytest fixtures).
    Output: (new_dir, old_dir) tuple of Path - the default state dir and
      the legacy log_directory.
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    new_dir = tmp_path / "Library" / "Application Support" / "CloudeCode"
    old_dir = tmp_path / "old_log_directory"
    new_dir.mkdir(parents=True)
    old_dir.mkdir()
    monkeypatch.setattr(settings, "log_directory", str(old_dir))
    return new_dir, old_dir


@pytest.mark.parametrize(
    "getter_name,filename",
    [
        ("get_session_metadata_path", "session_metadata.json"),
        ("get_pinned_themes_path", "pinned_themes.json"),
        ("get_unread_state_path", "unread_state.json"),
    ],
)
def test_state_file_old_location_only(tmp_path, monkeypatch, getter_name, filename):
    """File exists only at the old log_directory location - the app must
    keep working without a manual migration step."""
    new_dir, old_dir = _configure_dirs(monkeypatch, tmp_path)
    (old_dir / filename).write_text('{"legacy": true}')

    resolved = getattr(settings, getter_name)()

    assert resolved == old_dir / filename


@pytest.mark.parametrize(
    "getter_name,filename",
    [
        ("get_session_metadata_path", "session_metadata.json"),
        ("get_pinned_themes_path", "pinned_themes.json"),
        ("get_unread_state_path", "unread_state.json"),
    ],
)
def test_state_file_new_location_only(tmp_path, monkeypatch, getter_name, filename):
    """File exists only at the new state-dir location - used directly."""
    new_dir, old_dir = _configure_dirs(monkeypatch, tmp_path)
    (new_dir / filename).write_text('{"current": true}')

    resolved = getattr(settings, getter_name)()

    assert resolved == new_dir / filename


@pytest.mark.parametrize(
    "getter_name,filename",
    [
        ("get_session_metadata_path", "session_metadata.json"),
        ("get_pinned_themes_path", "pinned_themes.json"),
        ("get_unread_state_path", "unread_state.json"),
    ],
)
def test_state_file_both_present_prefers_new_reports_and_keeps_old(
    tmp_path, monkeypatch, getter_name, filename, capsys
):
    """Ambiguous case: file exists in BOTH locations. Must prefer the
    new path, must report the ambiguity (logged, not silent), and must
    NEVER delete the old file."""
    new_dir, old_dir = _configure_dirs(monkeypatch, tmp_path)
    (new_dir / filename).write_text('{"current": true}')
    (old_dir / filename).write_text('{"legacy": true}')

    resolved = getattr(settings, getter_name)()

    assert resolved == new_dir / filename
    # Never deleted - the old file must survive this call untouched.
    assert (old_dir / filename).exists()
    assert (old_dir / filename).read_text() == '{"legacy": true}'
    # Reported, not silent - the warning names the filename and both
    # paths so an operator can see the ambiguity in the logs.
    captured = capsys.readouterr()
    combined = captured.out + captured.err
    assert "state_file_present_in_both_locations" in combined
    assert filename in combined


def test_state_file_neither_location_returns_new_path_for_creation(
    tmp_path, monkeypatch
):
    """Neither location has the file yet (fresh install, feature never
    used) - the returned path is the NEW location, where a first write
    should land."""
    new_dir, old_dir = _configure_dirs(monkeypatch, tmp_path)

    resolved = settings.get_pinned_themes_path()

    assert resolved == new_dir / "pinned_themes.json"


def test_state_file_no_old_log_directory_configured(tmp_path, monkeypatch):
    """A fresh install with log_directory never set (None) - no fallback
    location exists at all, so the new path is returned unconditionally,
    with no attempt to stat a None-derived path."""
    new_dir = tmp_path / "new_state_only"
    new_dir.mkdir()
    monkeypatch.setattr(settings, "state_dir_override", str(new_dir))
    monkeypatch.setattr(settings, "log_directory", None)

    resolved = settings.get_unread_state_path()

    assert resolved == new_dir / "unread_state.json"


# ---------------------------------------------------------------------- #
# An EXPLICIT state directory suppresses the legacy log_directory rung.
#
# LOG_DIRECTORY is populated from the install's own .env, so it is set
# for an operator who never chose it. That made CLOUDE_STATE_DIR alone
# insufficient to isolate an instance: a throwaway server resolved, held
# open and in one case WROTE the live user's real state files. A stated
# location must outrank an inferred one.
# ---------------------------------------------------------------------- #

PINNED_STATE_FILES = [
    ("get_refresh_tokens_path", "refresh_tokens.db"),
    ("get_session_metadata_path", "session_metadata.json"),
    ("get_pinned_themes_path", "pinned_themes.json"),
    ("get_unread_state_path", "unread_state.json"),
]


def test_explicit_state_dir_suppresses_the_legacy_pin(tmp_path, monkeypatch):
    """An operator who NAMED a state directory gets it, for all four
    pinned filenames, even though a legacy copy exists and
    LOG_DIRECTORY is non-empty.

    This is the isolation guarantee: setting CLOUDE_STATE_DIR and nothing
    else is enough to keep a dev or test server off the real files.
    """
    state_dir = tmp_path / "throwaway_state"
    legacy_dir = tmp_path / "legacy"
    state_dir.mkdir()
    legacy_dir.mkdir()
    monkeypatch.setattr(settings, "state_dir_override", str(state_dir))
    monkeypatch.setattr(settings, "log_directory", str(legacy_dir))

    for _getter, filename in PINNED_STATE_FILES:
        (legacy_dir / filename).write_text("live user data")

    for getter, filename in PINNED_STATE_FILES:
        resolved = getattr(settings, getter)()
        assert resolved == state_dir / filename, (
            f"{getter}() escaped the explicitly named state directory"
        )
        assert settings.get_state_file_location(filename) == "state_dir"

    # Suppressed, never consumed and never removed - the legacy copies
    # belong to whoever wrote them.
    for _getter, filename in PINNED_STATE_FILES:
        assert (legacy_dir / filename).read_text() == "live user data"


def test_legacy_pin_still_fires_when_no_state_dir_was_named(tmp_path, monkeypatch):
    """NEGATIVE CONTROL, and the load-bearing test in this file.

    An install that never set CLOUDE_STATE_DIR and whose state sits under
    LOG_DIRECTORY must keep reading it. A fix that skipped the legacy
    rung unconditionally would satisfy
    ``test_explicit_state_dir_suppresses_the_legacy_pin`` perfectly and
    silently orphan a real user's refresh tokens and pinned themes on
    their next upgrade, which is a far worse defect than the one being
    fixed here. Mutate ``_state_file_pin`` to drop the rung whatever the
    state dir says and this is the test that goes red.
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    legacy_dir = tmp_path / "legacy_only"
    legacy_dir.mkdir()
    monkeypatch.setattr(settings, "state_dir_override", None)
    monkeypatch.setattr(settings, "log_directory", str(legacy_dir))
    assert not settings.state_dir_is_explicit()

    for _getter, filename in PINNED_STATE_FILES:
        (legacy_dir / filename).write_text("pre-existing install data")

    for getter, filename in PINNED_STATE_FILES:
        resolved = getattr(settings, getter)()
        assert resolved == legacy_dir / filename, (
            f"{getter}() abandoned an existing install's data - the legacy "
            "fallback stopped firing for an install that never named a "
            "state directory"
        )
        assert settings.get_state_file_location(filename) == "log_directory"


def test_explicit_state_dir_never_resolves_under_the_real_legacy_default(
    tmp_path, monkeypatch
):
    """The measured leak, reproduced: LOG_DIRECTORY carrying the value the
    repo's own .env ships (``~/cloude-projects``) must not pull any pinned
    filename out of an explicitly named state directory.

    Nothing here writes to or creates that directory; the assertion is
    about the resolved paths only, so the test is safe to run on a box
    where the real one exists with the real user's files in it.
    """
    state_dir = tmp_path / "isolated"
    state_dir.mkdir()
    monkeypatch.setattr(settings, "state_dir_override", str(state_dir))
    monkeypatch.setattr(settings, "log_directory", "~/cloude-projects")

    real_legacy = Path("~/cloude-projects").expanduser()
    for getter, filename in PINNED_STATE_FILES:
        resolved = getattr(settings, getter)()
        assert resolved.parent == state_dir
        assert real_legacy not in resolved.parents, (
            f"{getter}() resolved inside the real legacy directory "
            f"{real_legacy} while an explicit state dir was set"
        )


# ---------------------------------------------------------------------- #
# The memoization key on _state_file_pin() must include state_dir_explicit.
#
# Both production callers (get_state_file_location, _resolve_state_file)
# always pass settings.state_dir_is_explicit() for this filename /
# state_dir_override / log_directory combination, so this defect cannot
# fire from them today. It is reachable the moment a second caller
# passes its OWN flag for the same combination - which is exactly what a
# cache key is supposed to make impossible.
# ---------------------------------------------------------------------- #

def test_pin_cache_key_must_include_state_dir_explicit(tmp_path, monkeypatch):
    """Driving ``_state_file_pin`` with the flag both ways, for the SAME
    filename/state_dir_override/log_directory, must yield two DIFFERENT
    answers - not the first call's answer replayed.

    This calls the private method directly, on purpose: its own
    docstring says the flag is "passed in rather than read here so the
    legacy rung can be driven both ways by a test". Driving it both ways
    on ONE Settings instance, with everything else held constant, is the
    only way to exercise the cache key rather than the resolution logic
    beside it.

    If the cache key regresses to ``(filename, state_key, log_key)``
    (dropping ``state_dir_explicit``), the second call below returns the
    FIRST call's cached ``"log_directory"`` decision and this test goes
    red.
    """
    monkeypatch.setattr(settings, "_state_file_pins", None)
    state_dir = tmp_path / "state"
    legacy_dir = tmp_path / "legacy"
    state_dir.mkdir()
    legacy_dir.mkdir()
    filename = "pinned_themes.json"
    (legacy_dir / filename).write_text("legacy data")

    monkeypatch.setattr(settings, "state_dir_override", str(state_dir))
    monkeypatch.setattr(settings, "log_directory", str(legacy_dir))

    # explicit=False: the legacy rung is allowed to fire, and since only
    # the legacy copy exists, it wins.
    path_a, location_a = settings._state_file_pin(filename, False)
    assert location_a == "log_directory"
    assert path_a == legacy_dir / filename

    # explicit=True, everything else UNCHANGED: an explicit state dir
    # must suppress the legacy rung and resolve fresh into the state
    # dir, not replay the previous call's cached legacy answer.
    path_b, location_b = settings._state_file_pin(filename, True)
    assert location_b == "state_dir", (
        "the cached pin from the state_dir_explicit=False call leaked "
        "into the state_dir_explicit=True call - the cache key is "
        "missing the explicit flag"
    )
    assert path_b == state_dir / filename
