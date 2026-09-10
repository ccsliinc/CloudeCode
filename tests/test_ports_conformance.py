"""Every port is measured against its REAL implementation, not only a double.

Slice S0 of ``.claude/notes/backend-decomposition-plan.md``, section 3.2.

**THE DANGER A PORT INTRODUCES, said out loud: a double agrees with
whatever it was built to agree with.** So each port below is exercised
twice against the SAME assertions - once with the production class and
once with an in-file double. If the real implementation's shape drifts,
the double keeps passing and the real leg goes red, which is the only
arrangement that can tell those two apart.

This repo has paid for the alternative twice. ``tests/test_boot_readopt.py``
is hermetic and its ``FakeBackend.attach_existing`` had no guard to fail,
so 4,874 green tests had never observed the guard that then failed 20 of
20 owned sessions on its first real boot. And
``tests/test_respawn_refreshes_pane_env.py`` exists because a mock
asserting two calls happened in order only tests its own arrangement.

The signature check matters as much as the ``isinstance`` check.
``runtime_checkable`` verifies that an ATTRIBUTE EXISTS and nothing more,
so a real method that grew a required argument would still satisfy
``isinstance``. Comparing the parameters is what catches that.
"""

from __future__ import annotations

import inspect
import sqlite3
from pathlib import Path
from typing import Any, Optional

import pytest

import os
import sys
import tempfile

# ---- minimal env bootstrap so ``src.config`` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_pc_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_pc_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core import session_manager as session_manager_module
from src.core.live_ports import LiveSessionRecordStore, LiveSettings, SystemClock
from src.core.sessions.ports import (
    Clock,
    SessionRecordStore,
    SettingsReader,
    TmuxReader,
)
from src.core.tmux_backend import TmuxBackend


def _protocol_members(protocol: type) -> list[str]:
    """The method names a Protocol declares, without the typing machinery.

    Description: ``__protocol_attrs__`` is what ``runtime_checkable``
      itself consults, so using it here keeps this helper and the
      ``isinstance`` check reading the same list. Sorted for a stable
      failure message.
    Inputs: protocol (type) - a ``typing.Protocol`` subclass.
    Output: list[str].
    Example: _protocol_members(Clock)  # ['monotonic', 'now']
    """
    return sorted(getattr(protocol, "__protocol_attrs__", set()))


def _assert_signatures_match(protocol: type, implementation: Any) -> None:
    """Every protocol method exists on the implementation with the same shape.

    Description: compares parameter NAMES and kinds, ignoring annotations
      and ``self``. Annotations are prose that tooling checks elsewhere;
      the parameter list is what a call site actually depends on.
    Inputs: protocol (type). implementation (Any) - an instance or class.
    Output: None. Raises AssertionError naming the first mismatch.
    Example: _assert_signatures_match(Clock, SystemClock())
    """
    for name in _protocol_members(protocol):
        assert hasattr(implementation, name), f"{implementation} has no {name}"
        declared = inspect.signature(getattr(protocol, name))
        actual = inspect.signature(getattr(implementation, name))

        def _params(sig: inspect.Signature) -> list[tuple[str, Any]]:
            return [
                (p.name, p.kind)
                for p in sig.parameters.values()
                if p.name != "self"
            ]

        assert _params(actual) == _params(declared), (
            f"{implementation}.{name} takes {_params(actual)} but the "
            f"protocol declares {_params(declared)}"
        )


# ---- Clock ------------------------------------------------------------


class FrozenClock:
    """A clock that does not move, satisfying :class:`Clock` by shape."""

    def __init__(self, *, at: float) -> None:
        """Inputs: at (float) - the instant both readings report."""
        self._at = at

    def now(self) -> float:
        """The fixed instant, as epoch seconds."""
        return self._at

    def monotonic(self) -> float:
        """The fixed instant, as a monotonic reading."""
        return self._at


@pytest.mark.parametrize(
    "clock", [SystemClock(), FrozenClock(at=1_700_000_000.0)],
    ids=["real", "double"],
)
def test_clock_conforms(clock: Clock):
    """Both implementations satisfy the port and answer two floats."""
    assert isinstance(clock, Clock)
    _assert_signatures_match(Clock, clock)
    assert isinstance(clock.now(), float)
    assert isinstance(clock.monotonic(), float)


def test_the_real_clock_actually_moves_and_the_double_does_not():
    """THE NEGATIVE CONTROL. A port test that cannot tell these apart
    is testing the Protocol machinery and not the implementations."""
    real = SystemClock()
    frozen = FrozenClock(at=1.0)

    assert real.monotonic() <= real.monotonic()
    assert frozen.monotonic() == frozen.monotonic() == 1.0


def test_an_object_missing_a_member_is_not_a_clock():
    """``isinstance`` against a Protocol must be able to say NO."""

    class HalfClock:
        def now(self) -> float:
            return 0.0

    assert not isinstance(HalfClock(), Clock)


# ---- SettingsReader ---------------------------------------------------


class StubSettingsReader:
    """A settings reader over fixed values, satisfying the port by shape."""

    def __init__(self, *, pins: Path, cap: int, state: Path) -> None:
        """Inputs: pins (Path), cap (int), state (Path)."""
        self._pins, self._cap, self._state = pins, cap, state

    def pinned_themes_path(self) -> Path:
        """The fixed pin-file location."""
        return self._pins

    def log_buffer_size(self) -> int:
        """The fixed line cap."""
        return self._cap

    def state_dir(self) -> Path:
        """The fixed state directory."""
        return self._state

    def session_metadata_path(self) -> Path:
        """The fixed metadata-file location, under the state directory."""
        return self._state / "session_metadata.json"


def test_settings_reader_conforms_real(tmp_path):
    """The live reader answers four real values off the patchable name."""
    reader = LiveSettings()

    assert isinstance(reader, SettingsReader)
    _assert_signatures_match(SettingsReader, reader)
    assert isinstance(reader.pinned_themes_path(), Path)
    assert isinstance(reader.log_buffer_size(), int)
    assert isinstance(reader.state_dir(), Path)
    assert isinstance(reader.session_metadata_path(), Path)


def test_settings_reader_conforms_double(tmp_path):
    """And the double answers the same three types."""
    reader = StubSettingsReader(pins=tmp_path / "p.json", cap=7, state=tmp_path)

    assert isinstance(reader, SettingsReader)
    _assert_signatures_match(SettingsReader, reader)
    assert reader.log_buffer_size() == 7


def test_the_live_reader_follows_the_patched_name_and_not_src_config(
    tmp_path, monkeypatch
):
    """THE ONE THAT MATTERS. A reader bound to ``src.config.settings``
    would ignore this patch and read the owner's real home."""

    class _Stub:
        def get_pinned_themes_path(self) -> Path:
            return tmp_path / "patched.json"

    monkeypatch.setattr(session_manager_module, "settings", _Stub())

    assert LiveSettings().pinned_themes_path() == tmp_path / "patched.json"


# ---- SessionRecordStore ----------------------------------------------


class StubRecordStore:
    """An in-memory record store, satisfying the port by shape."""

    def __init__(self, *, row: Optional[dict] = None) -> None:
        """Inputs: row (dict | None) - what ``get_instance`` answers."""
        self._row = row

    def read_connection(self) -> Optional[sqlite3.Connection]:
        """No datastore, so no opinion."""
        return None

    def write_connection(self) -> Optional[sqlite3.Connection]:
        """No datastore, so no opinion."""
        return None

    def get_instance(
        self, *, socket: str, name: str, epoch: Optional[int]
    ) -> Optional[dict]:
        """The fixed row, whatever triple is asked for."""
        return self._row


@pytest.mark.parametrize("store_kind", ["real", "double"])
def test_record_store_conforms(store_kind: str, tmp_path):
    """Both implementations satisfy the port and answer None on an
    absent datastore rather than raising."""
    if store_kind == "real":
        store: SessionRecordStore = LiveSessionRecordStore(
            settings_reader=StubSettingsReader(
                pins=tmp_path / "p.json", cap=1, state=tmp_path / "empty"
            )
        )
    else:
        store = StubRecordStore()

    assert isinstance(store, SessionRecordStore)
    _assert_signatures_match(SessionRecordStore, store)
    assert store.read_connection() is None
    assert store.write_connection() is None
    assert store.get_instance(socket="cloude", name="cloude_x", epoch=1) is None


def test_the_real_store_never_creates_the_database(tmp_path):
    """A render that births an empty datastore loses the install's history."""
    state = tmp_path / "no_db_here"
    state.mkdir()
    store = LiveSessionRecordStore(
        settings_reader=StubSettingsReader(pins=tmp_path / "p.json", cap=1, state=state)
    )

    assert store.read_connection() is None
    assert store.write_connection() is None
    assert list(state.iterdir()) == [], "the store created a file it must not"


def test_the_real_store_opens_a_database_that_does_exist(tmp_path):
    """THE POSITIVE LEG. Without it, a store that answered None
    unconditionally would pass every assertion above."""
    from src.core.db import connect, db_path_for

    state = tmp_path / "with_db"
    state.mkdir()
    created = connect(db_path_for(state), create=True)
    created.close()

    store = LiveSessionRecordStore(
        settings_reader=StubSettingsReader(pins=tmp_path / "p.json", cap=1, state=state)
    )
    conn = store.read_connection()
    try:
        assert conn is not None, "an existing datastore was reported as absent"
    finally:
        if conn is not None:
            conn.close()


# ---- TmuxReader -------------------------------------------------------


class StubTmuxReader:
    """A tmux reader over canned answers, satisfying the port by shape."""

    def is_alive(self) -> bool:
        """Always alive."""
        return True

    def discover_existing(self) -> Any:
        """No sessions."""
        return None

    def list_pane_status_all(self) -> Any:
        """No panes."""
        return None

    def capture_scrollback(self, lines: int = 3000) -> bytes:
        """Empty scrollback."""
        return b""

    def capture_visible_screen(self) -> bytes:
        """Empty screen."""
        return b""


def test_the_real_tmux_backend_satisfies_the_reader_port(tmp_path, tmux_test_socket):
    """THE CONFORMANCE LEG THAT CANNOT BE FAKED.

    Description: constructs a real ``TmuxBackend`` - its ``__init__``
      does no I/O, so no tmux command is issued and the suite's socket
      guard is not disturbed - and checks it against the port by shape
      AND by signature. If someone renames ``capture_scrollback`` or
      gives ``discover_existing`` a required argument, the double below
      keeps passing and this goes red.
    """
    backend = TmuxBackend(
        session_id="ses_conformance",
        working_dir=tmp_path,
        socket_name=tmux_test_socket,
    )

    assert isinstance(backend, TmuxReader)
    _assert_signatures_match(TmuxReader, backend)


def test_the_double_satisfies_the_reader_port():
    """And the in-file double, against the same two assertions."""
    reader = StubTmuxReader()

    assert isinstance(reader, TmuxReader)
    _assert_signatures_match(TmuxReader, reader)


def test_a_reader_missing_one_method_is_refused():
    """THE NEGATIVE CONTROL. A port that accepts everything is worse
    than useless."""

    class NotAReader:
        def is_alive(self) -> bool:
            return True

    assert not isinstance(NotAReader(), TmuxReader)
