"""S4 v2: the live session table moved onto the registry, and it MOVED.

Slice S4 of ``.claude/notes/backend-decomposition-plan.md`` version 2.
``sessions``, ``backends``, ``_subscribers`` and ``_last_session_id``
left ``SessionManager`` for ``SessionRegistry``, together with the
registration path, every lookup, the "current session" pointer, the
output fan-out and ``_registered_ids_for_tmux_name``.

**THE LEGS ARE CHOSEN FOR THIS DATA, AND THE DATA IS WHY THERE ARE
FIVE.** What can go wrong here is not "the value is wrong", it is "there
are two containers". Two dicts that start empty and receive the same
writes through the same path agree forever, and the divergence only
appears when TWO paths write - a create through the manager and a boot
re-adopt through the registry - which is exactly the shape that returned
22 ``/sessions/list`` rows for 21 live tmux panes. So:

  (a) IDENTITY, the cheap canary. It is first because it is free and
      last in usefulness: an ``is`` check alone has failed to catch a
      real mutation four times in this project.
  (b) FORWARD, write through the manager's own path and read through a
      registry reference obtained BEFORE that write happened. A copy
      taken at construction passes (a) and fails here.
  (c) REVERSE, write through the registry and read through the manager's
      public methods. This is the leg S1 measured a copying property
      surviving both of the first two.
  (d) TWO REFERENCES, ONE PANE. Register one tmux name under two ids
      through two different references and assert
      ``registered_ids_for_tmux_name`` sees BOTH. This is the plan's
      named negative control and a no-copy leg at once, which is right
      because the invariant it guards IS a two-containers invariant.
  (e) DELETION, a direction insertion cannot cover. ``pop`` on a copy
      leaves the original populated, and a test that only ever adds
      cannot see that.

Run with:
    ./venv/bin/python3 -m pytest tests/test_session_registry_live.py -v
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_srl_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_srl_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.session_manager import SessionManager
from src.core.sessions.registry import ORPHAN_BUCKET, SessionRegistry
from src.models import Session, SessionStatus


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__`` to load."""

    def __init__(self, pin_path: Path, log_dir: Path, log_buffer_size: int = 1000):
        self._pin_path = pin_path
        self._log_dir = log_dir
        self.log_buffer_size = log_buffer_size

    def get_pinned_themes_path(self) -> Path:
        return self._pin_path

    def get_unread_state_path(self) -> Path:
        return self._pin_path.parent / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._log_dir)

    def get_session_metadata_path(self) -> Path:
        return self._log_dir / "session_metadata.json"


class _FakeBackend:
    """A backend carrying only what the registry and its readers touch.

    Description: ``tmux_session`` is the one attribute the registry
      itself reads; ``is_alive`` is what ``has_active_session`` asks,
      and it is here so a reverse-direction leg can go through a real
      manager method rather than through another registry read.
    """

    def __init__(self, tmux_session: str, alive: bool = True) -> None:
        self.tmux_session = tmux_session
        self._alive = alive

    def is_alive(self) -> bool:
        """Whether the pane behind this backend is still running."""
        return self._alive


@pytest.fixture()
def manager(monkeypatch, tmp_path: Path) -> SessionManager:
    """A bare manager with its state redirected into tmp_path."""
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr(
        "src.core.session_manager.settings",
        _StubSettings(
            pin_path=tmp_path / "pinned_themes.json",
            log_dir=tmp_path / "logs",
        ),
    )
    return SessionManager()


def _session(session_id: str, tmux_name: str | None = None) -> Session:
    """A minimal live Session record, no tmux and no disk involved."""
    return Session(
        id=session_id,
        pty_pid=0,
        working_dir="/tmp",
        status=SessionStatus.RUNNING,
        tmux_session=tmux_name or f"cloude_{session_id}",
    )


# --------------------------------------------------------------------------- #
# 1. The no-copy rule, five legs                                              #
# --------------------------------------------------------------------------- #


def test_leg_a_the_manager_resolves_none_of_the_moved_names(manager):
    """LEG (a). No second door, and no identity to compare because of it.

    Description: the strongest form this leg can take after Rule B. The
      manager does not resolve ``sessions``, ``backends``,
      ``_subscribers`` or ``_last_session_id`` by ANY route - not a
      field, not a property - so there is nothing for a copy to hide in.
      A property coming back IS a forwarder coming back, which is why
      ``hasattr`` is the assertion rather than an identity comparison.
    """
    for name in ("sessions", "backends", "_subscribers", "_last_session_id"):
        assert not hasattr(manager, name), (
            f"SessionManager.{name} resolves again; the registry owns that "
            "container and a caller holds the registry"
        )
    assert manager._registry.sessions == {}
    assert manager._registry.backends == {}


def test_leg_b_a_write_through_the_manager_lands_on_a_reference_taken_first(
    manager,
):
    """LEG (b), FORWARD. The reference is captured BEFORE the write.

    Description: a copy taken at construction time agrees with leg (a)
      and still fails here, because the reference under test predates
      every write the manager makes.
    """
    held = manager._registry
    sessions_before = held.sessions
    backends_before = held.backends

    session = _session("ses_fwd")
    backend = _FakeBackend("cloude_ses_fwd")
    manager._registry.register(session, backend)

    assert "ses_fwd" in sessions_before, (
        "a session registered through the manager is invisible to a "
        "registry reference taken before the write; there are two dicts"
    )
    assert backends_before["ses_fwd"] is backend
    assert held.last_session_id == "ses_fwd"


def test_leg_c_a_write_through_the_registry_is_seen_by_the_manager(manager):
    """LEG (c), REVERSE. The direction a copying property survives.

    Description: S1 measured a property returning ``dict(...)`` passing
      both identity and the forward leg. Writing through the collaborator
      and reading through the facade's own public surface is what fails
      on it.
    """
    session = _session("ses_rev")
    backend = _FakeBackend("cloude_ses_rev")
    manager._registry.sessions["ses_rev"] = session
    manager._registry.backends["ses_rev"] = backend
    manager._registry.last_session_id = "ses_rev"

    assert manager._registry.current_session() is session
    assert [s.id for s in manager._registry.list_sessions()] == ["ses_rev"]
    # Through MANAGER methods, which are the real consumers of these
    # containers inside the facade. Both walk the dicts themselves, so a
    # copy handed to the manager answers False here while every registry
    # read above still answers correctly.
    assert manager.has_active_session() is True
    assert manager.is_session_live("ses_rev") is True
    assert manager.active_tmux_names() == {"cloude_ses_rev"}


def test_leg_d_one_pane_registered_twice_is_visible_as_two_ids(manager):
    """LEG (d) AND THE NEGATIVE CONTROL. ONE PANE IS ONE REGISTRATION.

    Description: the two registrations go in through DIFFERENT
      references - one through the manager's registration path, one
      written straight onto the registry - and the query must see both.
      With two containers it sees one, the teardown drops one, and the
      other backend keeps tailing the same FIFO. That is the defect that
      measured 22 ``/sessions/list`` rows against 21 live tmux sessions,
      and it is stated here as an assertion rather than as a paragraph.
    """
    name = "cloude_one_pane"
    manager._registry.register(_session("ses_first", name), _FakeBackend(name))
    manager._registry.backends["ses_second"] = _FakeBackend(name)

    found = manager._registry.registered_ids_for_tmux_name(name)

    assert sorted(found) == ["ses_first", "ses_second"], (
        "one tmux pane is registered under two session ids and the query "
        f"reports {found}; a teardown keyed on this leaves the other "
        "backend on the same FIFO"
    )


def test_leg_d_negative_control_an_unregistered_name_finds_nothing(manager):
    """THE CONTROL ON LEG (d). A matcher that always finds something is
    worse than useless.

    Description: leg (d) proves the query FINDS two. This proves it can
      answer nothing at all, so the pair together say the query
      discriminates. ``also`` is included only when it is actually
      registered, which is the second half of the same claim.
    """
    manager._registry.register(
        _session("ses_real", "cloude_real"), _FakeBackend("cloude_real")
    )

    assert manager._registry.registered_ids_for_tmux_name("cloude_ghost") == []
    assert (
        manager._registry.registered_ids_for_tmux_name(
            "cloude_ghost", also="ses_never_registered"
        )
        == []
    ), "``also`` named an id with no backend and the query invented it"
    assert manager._registry.registered_ids_for_tmux_name(
        "cloude_ghost", also="ses_real"
    ) == ["ses_real"]


def test_leg_e_the_teardown_empties_the_reference_taken_first(manager):
    """LEG (e), DELETION. A direction insertion cannot cover.

    Description: ``pop`` against a copy leaves the original populated,
      so a suite that only ever ADDS through both references would stay
      green over a divergence. The reference is taken before the wipe
      for the same reason leg (b) takes it before the write.
    """
    held_sessions = manager._registry.sessions
    held_backends = manager._registry.backends
    held_subscribers = manager._registry.subscribers

    manager._registry.register(_session("ses_gone"), _FakeBackend("cloude_gone"))
    assert "ses_gone" in held_sessions

    manager._wipe_session_state("ses_gone")

    assert "ses_gone" not in held_sessions, (
        "the manager's teardown left the session on a registry reference "
        "taken earlier; the pop landed on a different dict"
    )
    assert "ses_gone" not in held_backends
    assert "ses_gone" not in held_subscribers
    assert manager._registry.last_session_id is None


# --------------------------------------------------------------------------- #
# 2. The behaviour that moved                                                 #
# --------------------------------------------------------------------------- #


def test_the_current_pointer_repairs_itself_when_its_session_goes(manager):
    """A stale pointer must never answer for a session that is gone.

    Description: ``last_session_id`` is set by every registration, so
      destroying the newest session leaves it naming a popped key. The
      fallback answers the newest SURVIVOR and repairs the pointer on
      its way past, which is why two consecutive calls agree.
    """
    manager._registry.register(_session("ses_old"), None)
    manager._registry.register(_session("ses_new"), None)
    assert manager._registry.last_session_id == "ses_new"

    # Drop it WITHOUT going through forget, so the pointer is genuinely
    # stale rather than repaired by the teardown.
    manager._registry.sessions.pop("ses_new")

    assert manager._registry.current_session().id == "ses_old"
    assert manager._registry.last_session_id == "ses_old"


def test_forget_moves_the_pointer_to_the_newest_survivor(manager):
    """The teardown repairs the pointer rather than leaving a dangling id."""
    manager._registry.register(_session("ses_a"), None)
    manager._registry.register(_session("ses_b"), None)

    manager._registry.forget("ses_b")

    assert manager._registry.last_session_id == "ses_a"
    assert manager._registry.current_session().id == "ses_a"


def test_forget_leaves_every_other_session_untouched(manager):
    """Isolation is the whole reason these are dicts keyed by id."""
    manager._registry.register(_session("ses_keep"), _FakeBackend("cloude_keep"))
    manager._registry.register(_session("ses_drop"), _FakeBackend("cloude_drop"))
    manager._registry.append_log("ses_keep", "still here")

    manager._registry.forget("ses_drop")

    assert "ses_keep" in manager._registry.sessions
    assert "ses_keep" in manager._registry.backends
    assert manager._registry.log_line_count("ses_keep") == 1


def test_resolve_session_id_refuses_an_id_that_is_not_registered(manager):
    """An explicit id is VALIDATED, not trusted.

    Description: answering the caller's own string back would let it go
      on to address a container entry that is not there. None is the
      refusal, and it is the same refusal an empty registry gives.
    """
    manager._registry.register(_session("ses_live"), None)

    assert manager._registry.resolve_session_id("ses_live") == "ses_live"
    assert manager._registry.resolve_session_id("ses_never") is None
    assert manager._registry.resolve_session_id(None) == "ses_live"


def test_an_orphan_subscriber_never_receives_another_session_s_bytes():
    """Subscribing with nothing registered is valid and is isolated."""
    registry = SessionRegistry(log_cap=lambda: 1000)

    orphan = registry.subscribe(None)

    assert ORPHAN_BUCKET in registry.subscribers
    registry.register(_session("ses_late"), None)
    # PUBLISH IS SYNCHRONOUS SINCE 1.4.0: the tail loop that reads the tmux
    # pipe awaits whatever the output handler returns, so a coroutine here
    # would put every keystroke echo one await behind a viewer's outbox.
    registry.publish("ses_late", b"hello")
    assert orphan.queued_items == 0, (
        "an orphan stream received a real session's bytes"
    )


def test_output_reaches_only_the_subscribers_of_that_session():
    """A session's bytes never leak into another session's queue."""
    registry = SessionRegistry(log_cap=lambda: 1000)
    registry.register(_session("ses_a"), None)
    registry.register(_session("ses_b"), None)
    stream_a = registry.subscribe("ses_a")
    stream_b = registry.subscribe("ses_b")

    registry.publish("ses_a", b"only for a")

    assert stream_a.queued_items == 1
    assert stream_b.queued_items == 0, (
        "session A's bytes landed in session B's stream"
    )


def test_unsubscribe_without_a_session_id_searches_every_bucket():
    """The back-compat path for a caller that did not track its bucket."""
    registry = SessionRegistry(log_cap=lambda: 1000)
    registry.register(_session("ses_x"), None)
    queue = registry.subscribe("ses_x")

    registry.unsubscribe(queue)

    assert registry.subscribers["ses_x"] == []
    # Idempotent: a second removal of a queue that has already gone is
    # not an error, because teardown runs from more than one path.
    registry.unsubscribe(queue)
    registry.unsubscribe(queue, "ses_x")


def test_the_manager_s_output_handler_is_bound_to_one_session():
    """Each backend's handler can only ever reach its own subscribers.

    Description: the handler is built per session id, so two backends
      cannot cross-deliver even though they share one registry. This is
      the property ``_make_output_handler`` exists for, asserted through
      the real handler rather than through ``publish`` directly.
    """
    registry = SessionRegistry(log_cap=lambda: 1000)
    registry.register(_session("ses_1"), None)
    registry.register(_session("ses_2"), None)
    stream_1 = registry.subscribe("ses_1")
    stream_2 = registry.subscribe("ses_2")

    class _Manager:
        _registry = registry
        _make_output_handler = SessionManager._make_output_handler

    handler = _Manager()._make_output_handler("ses_1")
    handler(b"for one")

    assert stream_1.queued_items == 1
    assert stream_2.queued_items == 0
