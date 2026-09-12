"""S2: the theme cluster moved to ``ThemeStore``, and it MOVED not copied.

Slice S2 of the ``session_manager`` decomposition
(``.claude/notes/backend-decomposition-plan.md``). ``pinned_themes``, the
``.cc.theme`` dotfile and the theme-manifest accent cache left the god
object for ``src/core/sessions/theme_store.py`` and its two neighbours.

**THE NO-COPY RULE NEEDS FOUR LEGS HERE, AND EACH CATCHES A DIFFERENT
WRONG ANSWER.** S1's cluster was scalars, so an ``is`` check proved
nothing and it used three legs. This cluster is two shared DICTS, so
identity is meaningful - but identity ALONE is still not enough, because
the naive wrong implementation (assigning ``self.pinned_themes =
store.pinned_themes`` in ``__init__``) satisfies it perfectly on a fresh
manager and forks the moment anything rebinds either name. The four:

(a) IDENTITY. ``manager._theme_store.pinned_themes is store.pinned_themes``, and the
    same for the accent cache down its two hops. Catches a defensive
    ``dict(...)`` copy.
(b) NO FIELD ON THE FACADE. The names must not appear in the manager's
    instance ``__dict__``; they resolve through properties on the class.
    Catches the ``__init__`` reference-copy that leg (a) cannot see.
(c) WRITES CROSS IN BOTH DIRECTIONS, including a whole-dict REBIND.
    ``tests/test_tmux_listing_consumers.py`` really does assign a fresh
    dict through the facade, and a read-only property would raise while a
    plain attribute would silently shadow. Catches both.
(d) LIVE DELEGATION THROUGH A REAL PUBLIC METHOD. Not a stub: a real
    ``set_pinned_theme`` round-trip onto real disk, read back by a second
    store. Catches a facade that keeps its own map coherent while the
    store's is the one being persisted, which every value assertion above
    would still pass.

The negative controls matter as much: a store asked about a theme that
does not exist must answer None rather than find something, and
``prune_to_live`` must be reachable only with a MEASURED set of live
names - an empty set from a failed probe would wipe every pin the user
has, which is why the caller gates on ``listing.ok``.

Run with:
    ./venv/bin/python3 -m pytest tests/test_theme_store.py -v
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds --------------
# ``src.config`` validates required settings at import time, so seed the
# defaults BEFORE any ``src.*`` import. Same preamble as
# ``tests/test_project_theme.py``.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_ts_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_ts_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.session_manager import SessionManager
from src.core.sessions.theme_accents import ThemeAccents
from src.core.sessions.theme_store import ThemeStore
from src.core.sessions import theme_dotfile


# --------------------------------------------------------------------------- #
# Fixtures                                                                     #
# --------------------------------------------------------------------------- #


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__`` to load.

    Description: pydantic v2 forbids instance-level monkeypatching of
      ``Settings``, so tests swap the whole ``settings`` symbol inside
      ``src.core.session_manager``. Mirrors the stub in
      ``tests/test_project_theme.py`` so a manager can be built without
      touching the developer's real ``~/.cloude-sessions``.
    Inputs: pin_path (Path) - where ``pinned_themes.json`` should live.
      log_dir (Path) - the throwaway log directory.
    Output: an object exposing the members ``__init__`` reads.
    """

    def __init__(self, pin_path: Path, log_dir: Path) -> None:
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


@pytest.fixture()
def store(tmp_path: Path) -> ThemeStore:
    """A store pointed at a throwaway pin file.

    Description: constructed with the same callable shape the facade
      uses, so the tests exercise the real injection point.
    Output: ThemeStore.
    """
    return ThemeStore(pin_path=lambda: tmp_path / "pinned_themes.json")


@pytest.fixture()
def manager(monkeypatch, tmp_path: Path) -> SessionManager:
    """A bare ``SessionManager()`` with its state redirected to tmp_path.

    Description: patches ``settings`` in the ``session_manager`` module,
      which is exactly the patch the store's injected path callable has
      to keep seeing.
    Output: SessionManager.
    """
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr(
        "src.core.session_manager.settings",
        _StubSettings(
            pin_path=tmp_path / "pinned_themes.json",
            log_dir=tmp_path / "logs",
        ),
    )
    return SessionManager()


# --------------------------------------------------------------------------- #
# 1. The no-copy rule, four legs                                              #
# --------------------------------------------------------------------------- #


def test_leg_a_the_facade_maps_are_the_store_maps(manager: SessionManager):
    """LEG (a). One dict per cluster, reached through three spellings."""
    assert manager._theme_store.pinned_themes is manager._theme_store.pinned_themes
    assert manager._theme_store.accent_cache is manager._theme_store.accent_cache
    # ...and the accent cache's second hop, into the composed object.
    assert (
        manager._theme_store.accent_cache
        is manager._theme_store.accents.cache
    )


def test_leg_b_the_facade_holds_no_field_of_its_own(manager: SessionManager):
    """LEG (b), REWRITTEN BY S1. There is no second door at all now.

    Description: this used to assert the names were PROPERTIES on the
      class rather than fields on the instance, which was the right check
      while the facade forwarded: a ``self.pinned_themes = ...`` in
      ``__init__`` would pass leg (a) on a fresh object and shadow the
      property forever after. S1 deleted the forwarders, so the invariant
      is stronger and simpler - the manager resolves none of these names
      by any route, and a property coming back IS a forwarder coming back.
    """
    moved = ["pinned_themes", "_theme_accent_cache"]

    leftovers = [name for name in moved if hasattr(manager, name)]
    assert leftovers == [], (
        f"{leftovers} resolve on the facade again; the theme cluster is "
        "reached through the store and nothing else"
    )
    assert manager._theme_store.pinned_themes is not None


def test_leg_c_writes_cross_in_both_directions(manager: SessionManager):
    """LEG (c). Mutation either way is visible from the other side."""
    manager._theme_store.pinned_themes["via_facade"] = "matrix"
    assert manager._theme_store.pinned_themes["via_facade"] == "matrix"

    manager._theme_store.pinned_themes["via_store"] = "metal"
    assert manager._theme_store.pinned_themes["via_store"] == "metal"

    manager._theme_store.accent_cache["fake_theme"] = "#123456"
    assert manager._theme_store.accents.cache["fake_theme"] == "#123456"


def test_leg_c_a_whole_dict_rebind_lands_on_the_store(manager: SessionManager):
    """LEG (c), the half a plain property would get wrong.

    Real tests assign the whole map through the facade. Without a setter
    this raises AttributeError; with a plain instance attribute it
    silently forks the two objects. Only a setter that writes THROUGH
    keeps one dict.
    """
    replacement = {"cloude_Test": "matrix"}
    manager._theme_store.pinned_themes = replacement

    assert manager._theme_store.pinned_themes is replacement
    assert manager._theme_store.pinned_themes is replacement


def test_leg_d_a_real_public_method_persists_through_the_store(
    manager: SessionManager, tmp_path: Path
):
    """LEG (d). Live delegation, real disk, no stub anywhere.

    ``set_pinned_theme`` is a real public method with four external
    callers. A facade keeping its own coherent copy would satisfy every
    assertion above and still write nothing here.
    """
    manager.set_pinned_theme("cloude_live", "lovecraft")

    on_disk = json.loads((tmp_path / "pinned_themes.json").read_text())
    assert on_disk == {"cloude_live": "lovecraft"}

    # A SECOND store reading the same file agrees, which is what proves
    # the write went through the owner rather than into a facade copy.
    second = ThemeStore(pin_path=lambda: tmp_path / "pinned_themes.json")
    second.load()
    assert second.get_pin("cloude_live") == "lovecraft"

    # And clearing round-trips too - a cleared pin has to survive a
    # restart exactly as a set one does.
    manager.set_pinned_theme("cloude_live", None)
    assert json.loads((tmp_path / "pinned_themes.json").read_text()) == {}


# --------------------------------------------------------------------------- #
# 2. The injected pin path, which is the landmine this slice stepped over     #
# --------------------------------------------------------------------------- #


def test_the_pin_path_is_resolved_at_call_time_not_construction(
    monkeypatch, tmp_path: Path
):
    """The store must follow a settings patch installed AFTER it is built.

    The loose ``_load_pinned_themes`` called
    ``settings.get_pinned_themes_path()`` fresh every time. A store that
    captured a Path at construction would quietly diverge from that, and
    the divergence would only show on a machine where the two differ -
    which is every developer machine, because the real path is under the
    owner's home directory.
    """
    first = tmp_path / "first.json"
    second = tmp_path / "second.json"
    current = {"path": first}

    store = ThemeStore(pin_path=lambda: current["path"])
    store.set_pin("a", "matrix")
    assert first.exists() and not second.exists()

    current["path"] = second
    store.set_pin("b", "metal")
    assert second.exists()
    assert json.loads(second.read_text()) == {"a": "matrix", "b": "metal"}


def test_a_bare_manager_never_reads_the_real_pinned_themes_file(
    manager: SessionManager, tmp_path: Path
):
    """NEGATIVE CONTROL on the patch reaching the store.

    If ``ThemeStore`` imported ``settings`` itself, the manager fixture's
    ``monkeypatch.setattr("src.core.session_manager.settings", ...)``
    would not bind and this manager would be holding whatever the
    developer's real pin file contains. Asserting the write LANDS in
    tmp_path is the only way to see that from inside the test.
    """
    manager.set_pinned_theme("cloude_scoped", "matrix")
    assert (tmp_path / "pinned_themes.json").exists()


# --------------------------------------------------------------------------- #
# 3. The pin map's own behaviour                                              #
# --------------------------------------------------------------------------- #


def test_get_pin_answers_none_for_an_empty_name(store: ThemeStore):
    """An empty name is not a lookup, and must not raise."""
    assert store.get_pin("") is None
    assert store.get_pin(None) is None


def test_set_pin_reports_whether_it_did_anything(store: ThemeStore):
    """The bool is what tells the facade whether to mirror onto a session."""
    assert store.set_pin("cloude_x", "matrix") is True
    assert store.set_pin("", "matrix") is False
    assert store.pinned_themes == {"cloude_x": "matrix"}


def test_discard_pin_is_a_noop_when_absent(store: ThemeStore, tmp_path: Path):
    """Nothing to drop means nothing written.

    NEGATIVE CONTROL: the file must not be created by a discard that
    found no entry, or every destroy of an unpinned session would touch
    the disk.
    """
    store.discard_pin("never_pinned")
    assert not (tmp_path / "pinned_themes.json").exists()


def test_rekey_pin_moves_a_pin_and_reports_it(store: ThemeStore):
    """A rename has to carry the legacy pin, or a downgrade loses it."""
    store.set_pin("old", "matrix")
    assert store.rekey_pin("old", "new") is True
    assert store.pinned_themes == {"new": "matrix"}
    assert store.rekey_pin("absent", "other") is False


def test_prune_to_live_drops_only_the_dead(store: ThemeStore):
    """Pins for names the listing did not report are dropped."""
    store.set_pin("alive", "matrix")
    store.set_pin("dead", "metal")

    pruned = store.prune_to_live({"alive"})

    assert pruned == ["dead"]
    assert store.pinned_themes == {"alive": "matrix"}


def test_prune_to_live_on_an_empty_map_writes_nothing(
    store: ThemeStore, tmp_path: Path
):
    """NEGATIVE CONTROL. No pins means no work and no file.

    This runs on every successful listing, which on a healthy box is
    every poll. A version that saved unconditionally would rewrite the
    pin file several times a minute forever.
    """
    store.prune_to_live(set())
    assert not (tmp_path / "pinned_themes.json").exists()


def test_load_drops_non_string_values(store: ThemeStore, tmp_path: Path):
    """A corrupt preferences file must not poison the map or crash boot."""
    (tmp_path / "pinned_themes.json").write_text(
        json.dumps({"good": "matrix", "bad": 7, "empty": ""})
    )
    store.load()
    assert store.pinned_themes == {"good": "matrix"}


def test_load_survives_a_file_that_is_not_a_dict(
    store: ThemeStore, tmp_path: Path
):
    """Malformed shape leaves an empty map rather than raising."""
    (tmp_path / "pinned_themes.json").write_text("[1, 2, 3]")
    store.load()
    assert store.pinned_themes == {}


def test_save_publishes_atomically_and_leaves_no_temp(
    store: ThemeStore, tmp_path: Path
):
    """MUTATION TARGET. The temp file must be RENAMED, not left behind.

    A save that wrote the temp and skipped ``os.replace`` would leave the
    canonical path absent while every in-memory assertion passed, and the
    pin would vanish on the next restart.
    """
    store.set_pin("cloude_x", "matrix")

    published = tmp_path / "pinned_themes.json"
    assert published.exists(), "the pin file was never published"
    assert not (tmp_path / "pinned_themes.json.tmp").exists(), (
        "a temp file survived the save, so the rename did not happen"
    )
    assert json.loads(published.read_text()) == {"cloude_x": "matrix"}


# --------------------------------------------------------------------------- #
# 4. The dotfile, and which source wins                                       #
# --------------------------------------------------------------------------- #


def test_the_pin_beats_the_project_default(store: ThemeStore, tmp_path: Path):
    """ORDER IS THE CONTRACT, AND IT INVERTED AT THE 1.4.0 INTEGRATION.

    The session's own pin wins over the folder's ``.cc.theme`` default.
    Issue #65: a default that outranks an explicit choice is not a
    default, and dotfile-first threw a pin away on every restart while
    making two sessions in one folder unable to hold two themes. The
    migration that used to ferry a pin INTO the dotfile went with the
    inversion, because under it that write turns one session's private
    choice into a folder-wide default its siblings inherit.
    """
    project = tmp_path / "proj"
    project.mkdir()
    store.set_pin("cloude_both", "lovecraft")
    store.set_project_theme(project, "metal")

    assert store.resolve_project_theme(project, "cloude_both") == "lovecraft"


def test_the_legacy_pin_is_the_fallback_only(store: ThemeStore, tmp_path: Path):
    """With no dotfile the tmux-name map answers, and only then."""
    project = tmp_path / "proj"
    project.mkdir()
    store.set_pin("cloude_legacy", "lovecraft")

    assert store.resolve_project_theme(project, "cloude_legacy") == "lovecraft"
    # NEGATIVE CONTROL: without the name there is nothing to fall back to.
    assert store.resolve_project_theme(project) is None


def test_set_project_theme_writes_one_line_and_the_mode(
    store: ThemeStore, tmp_path: Path
):
    """The format is the theme id plus a newline, at 0o644."""
    project = tmp_path / "proj"
    project.mkdir()
    store.set_project_theme(project, "metal")

    path = project / ".cc.theme"
    assert path.read_text() == "metal\n"
    assert oct(path.stat().st_mode)[-3:] == "644"


def test_set_project_theme_raises_on_a_missing_directory(store: ThemeStore, tmp_path: Path):
    """A write that cannot happen must not report success.

    This is the asymmetry with ``save()``, which logs and returns: this
    one is reached from a user action with a response to fail.
    """
    with pytest.raises(FileNotFoundError):
        store.set_project_theme(tmp_path / "absent", "metal")
    with pytest.raises(ValueError):
        store.set_project_theme(None, "metal")


def test_clearing_the_dotfile_removes_it(store: ThemeStore, tmp_path: Path):
    """An empty theme id deletes the file rather than writing an empty one."""
    project = tmp_path / "proj"
    project.mkdir()
    store.set_project_theme(project, "metal")
    store.set_project_theme(project, None)

    assert not (project / ".cc.theme").exists()
    assert store.get_project_theme(project) is None


def test_the_dotfile_module_and_the_store_agree_on_the_path(
    store: ThemeStore, tmp_path: Path
):
    """One definition of the file name, reached two ways.

    ``ThemeStore.project_theme_path`` is BOUND to the module function
    rather than re-implementing it. A second implementation is how a
    reader and a writer end up spelling one file two ways.
    """
    assert store.project_theme_path(tmp_path) == theme_dotfile.project_theme_path(
        tmp_path
    )
    assert store.project_theme_path(tmp_path).name == theme_dotfile.DOTFILE_NAME




@pytest.mark.parametrize(
    ("tmux_session", "session_id", "expected"),
    [
        ("cloude_named", "ses_1", "cloude_named"),
        (None, "adopted:cloude_adopted", "cloude_adopted"),
        (None, "ses_plain", "ses_plain"),
        (None, "", None),
        (None, None, None),
    ],
)
def test_the_legacy_key_prefers_the_tmux_name(tmux_session, session_id, expected):
    """The explicit field wins; the adopted id is stripped as a fallback."""
    assert ThemeStore.legacy_pin_key(tmux_session, session_id) == expected


# --------------------------------------------------------------------------- #
# 6. Accents                                                                  #
# --------------------------------------------------------------------------- #


def test_a_real_bundled_manifest_resolves(store: ThemeStore):
    """CONFORMANCE against the real files, not a double.

    A recorded manifest would agree with whatever it was built to agree
    with. This reads ``client/css/themes/matrix/theme.json`` off disk,
    which is what the running server reads.
    """
    assert store.accent_for_theme("matrix") == "#00ff41"


def test_a_none_answer_is_cached_as_an_answer(
    monkeypatch, store: ThemeStore, tmp_path: Path
):
    """A cached None means "declares no accent" and must NOT be re-read.

    Reading it as a miss would re-parse the manifest on every toast for
    every accent-less theme, which is the entire cost the cache exists to
    avoid. The membership check (``in``) versus truthiness is the whole
    difference, and BOTH implementations return None on the first call
    and both write None into the cache - so neither the return value nor
    the cache contents can tell them apart.

    THIS TEST WAS DECORATIVE UNTIL A MUTATION CAUGHT IT. Its first draft
    asserted exactly those two things, and swapping ``in`` for
    ``.get()`` left it green. What separates the two is what happens on
    the SECOND call: a real memo answers from the cache, so publishing a
    manifest afterwards cannot change the answer. A truthiness check
    treats the cached None as a miss, goes back to disk, and finds it.
    """
    root = tmp_path / "themes"
    root.mkdir()
    monkeypatch.setattr(ThemeAccents, "themes_dir", staticmethod(lambda: root))

    # First call: no manifest, so the answer is None and is remembered.
    assert store.accent_for_theme("late_theme") is None
    assert "late_theme" in store.accent_cache
    assert store.accent_cache["late_theme"] is None

    # Publish the manifest the first call did not find.
    (root / "late_theme").mkdir()
    (root / "late_theme" / "theme.json").write_text(
        json.dumps({"cssVars": {"--color-accent": "#abcdef"}})
    )

    # A memo that honours its own None never sees it.
    assert store.accent_for_theme("late_theme") is None, (
        "the cached None was treated as a miss, so the manifest was "
        "re-read; the memo is not memoizing"
    )


def test_the_accent_read_consults_theme_accents(monkeypatch, store: ThemeStore):
    """NEGATIVE CONTROL on where the themes root comes from.

    Moving ``ThemeAccents.themes_dir`` must actually change the answer.
    If it does not, any test patching it is decorative - which is the
    state ``tests/test_toast_lifecycle.py`` would have been left in had
    its patch stayed pointed at the facade's delegate.
    """
    monkeypatch.setattr(
        ThemeAccents, "themes_dir", staticmethod(lambda: Path("/nowhere"))
    )
    assert store.accent_for_theme("matrix") is None


def test_accent_for_goes_through_the_theme_resolution(
    store: ThemeStore, tmp_path: Path
):
    """End to end: directory -> theme -> accent."""
    project = tmp_path / "proj"
    project.mkdir()
    store.set_project_theme(project, "matrix")

    assert store.accent_for(project, None) == "#00ff41"
    # NEGATIVE CONTROL: no theme anywhere means no colour, not a default.
    assert store.accent_for(tmp_path / "unthemed", None) is None
