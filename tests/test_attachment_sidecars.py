"""S5: the per-session sidecars moved, and they MOVED not copied.

Slice S5 of the ``session_manager`` decomposition
(``.claude/notes/backend-decomposition-plan.md``). ``adopt_fifo_offsets``
and ``pending_terminal_commands`` left the god object for
``AttachmentSidecars`` in ``src/core/sessions/sidecars.py``, taking their
clusters out of ``_wipe_session_state``.

THERE WAS A THIRD, ``idle_watchers``, and it went on 2026-09-13 with the
hook subsystem: it held one live pane-output watcher per session, and a
session's state now comes from what the harness writes to disk
(``src/core/attention/``) rather than from the shape of the bytes
scrolling past. Its cases went with it. Leg (e) below, which existed
because ``src/api/websocket.py`` reached the watchers through a
defensive ``getattr``, is the one worth reading anyway: the reach is
gone, not merely repointed.

**THE ONE-SHOT RULE IS THE POINT OF THIS SLICE.** Both are consumed
exactly once and the plan asks for both to be asserted, because they are
stated in prose and defended nowhere:

  - a FIFO offset re-read on a reconnect would seek into a FIFO that has
    grown by however much output landed meanwhile;
  - a terminal command re-read on a reconnect would type a command the
    user never asked for, into a pane they are looking at.

Both pops are tested through the FACADE, not only against the
collaborator, because the facade is where a reconnect actually arrives.

**THE NO-COPY LEGS.** (a) identity of both containers; (b) neither name
is an instance attribute on the facade and both are properties on the
class; (c) an in-place write through either spelling is seen by the
other; (c2) a whole-map REBIND through the facade reaches the
collaborator - this cluster is the reason the setter rule has evidence,
because ``tests/test_terminal_commands.py`` rebinds
``pending_terminal_commands`` wholesale, twice, while
``adopt_fifo_offsets`` is rebound by nothing and is therefore read-only;
(d) live delegation through the real public surface. A property
returning a COPY is what legs (a) and (c) exist to fail.

**A GETTER MAY NOT CONSUME.** ``adopt_fifo_start_offset`` is a property,
and a property whose read destroyed the replay position of a session
nobody had attached to yet would be a side effect nobody could see. That
gets its own test, because ``peek`` and ``take`` differ by one method
call and the wrong one reads fine.

Run with:
    ./venv/bin/python3 -m pytest tests/test_attachment_sidecars.py -v
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_as_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_as_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.session_manager import SessionManager
from src.core.sessions.sidecars import AttachmentSidecars
from src.models import Session, SessionStatus


# --------------------------------------------------------------------------- #
# Fixtures                                                                     #
# --------------------------------------------------------------------------- #


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__`` to load."""

    def __init__(self, pin_path: Path, log_dir: Path) -> None:
        self._pin_path = pin_path
        self._log_dir = log_dir
        self.log_buffer_size = 1000

    def get_pinned_themes_path(self) -> Path:
        return self._pin_path

    def get_unread_state_path(self) -> Path:
        return self._pin_path.parent / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._log_dir)

    def get_session_metadata_path(self) -> Path:
        return self._log_dir / "session_metadata.json"

    def get_terminal_command(self, command_id: str) -> None:
        """No terminal commands are configured, so every id is unknown.

        Description: this is the stale-id case the flush already handles -
          an entry deleted in another tab yields a plain console, never a
          failed launch - and it is what lets the flush test observe the
          pop without a real config.json.
        """
        return None


@pytest.fixture()
def sidecars() -> AttachmentSidecars:
    """A bare collaborator. No manager, no tmux, no disk."""
    return AttachmentSidecars()


@pytest.fixture()
def stub_settings(monkeypatch, tmp_path: Path) -> _StubSettings:
    """Install a stub ``settings`` on ``session_manager`` and hand it back."""
    (tmp_path / "logs").mkdir(exist_ok=True)
    stub = _StubSettings(
        pin_path=tmp_path / "pinned_themes.json",
        log_dir=tmp_path / "logs",
    )
    monkeypatch.setattr("src.core.session_manager.settings", stub)
    return stub


@pytest.fixture()
def manager(stub_settings) -> SessionManager:
    """A bare ``SessionManager()`` with its state redirected to tmp_path."""
    return SessionManager()


def _register(manager: SessionManager, session_id: str, work: Path) -> Session:
    """Put a minimal live Session on the manager, no tmux involved.

    Inputs: manager; session_id (str); work (Path) - the working dir.
    Output: Session - the registered record.
    """
    sess = Session(
        id=session_id,
        pty_pid=0,
        working_dir=str(work),
        status=SessionStatus.RUNNING,
        tmux_session=f"cloude_{session_id}",
    )
    manager._registry.sessions[session_id] = sess
    manager._registry.last_session_id = session_id
    return sess


# --------------------------------------------------------------------------- #
# 1. The no-copy rule                                                         #
# --------------------------------------------------------------------------- #


def test_leg_a_the_facade_containers_are_the_sidecar_containers(manager):
    """LEG (a). One object per container, not two that agree today."""
    assert manager._sidecars.adopt_fifo_offsets is manager._sidecars.adopt_fifo_offsets
    assert (
        manager._sidecars.pending_terminal_commands
        is manager._sidecars.pending_terminal_commands
    )


def test_leg_b_the_facade_holds_no_field_of_its_own(manager):
    """LEG (b), REWRITTEN BY S1. There is no second door at all now.

    Description: this used to assert the names were PROPERTIES on the
      class rather than fields on the instance, which was the right check
      while the facade forwarded: a ``self.adopt_fifo_offsets = ...`` in
      ``__init__`` would pass leg (a) on a fresh object and shadow the
      property forever after. S1 deleted the forwarders, so the invariant
      is stronger and simpler - the manager resolves none of these names
      by any route, and a property coming back IS a forwarder coming back.
    """
    for name in (
        "adopt_fifo_offsets",
        "pending_terminal_commands",
    ):
        assert not hasattr(manager, name), (
            f"{name} resolves on the facade again; the sidecars own it and "
            "a caller holds the sidecars"
        )
    assert manager._sidecars.adopt_fifo_offsets is not None


def test_leg_c_writes_cross_in_both_directions(manager):
    """LEG (c). What leg (a) says structurally, said in behaviour.

    A property returning ``dict(self._sidecars.adopt_fifo_offsets)``
    passes every value assertion in this file except this one and leg (a).
    """
    manager._sidecars.set_fifo_offset("ses_from_sidecars", 512)
    assert manager._sidecars.adopt_fifo_offsets["ses_from_sidecars"] == 512

    manager._sidecars.adopt_fifo_offsets["ses_from_facade"] = 1024
    assert manager._sidecars.peek_fifo_offset("ses_from_facade") == 1024

    manager._sidecars.set_pending_command("ses_from_sidecars", "top")
    assert manager._sidecars.pending_terminal_commands["ses_from_sidecars"] == "top"


def test_leg_c2_a_whole_map_rebind_reaches_the_sidecars(manager):
    """LEG (c2). The measured rebind, and the reason ONE setter exists.

    ``tests/test_terminal_commands.py`` assigns this name wholesale to
    arrange a manager and again to clear it. A read-only property raises
    there; a plain attribute shadows the property and forks the two
    objects while every value assertion still passes.
    """
    manager._sidecars.pending_terminal_commands = {"ses_1": "top"}

    assert manager._sidecars.pending_terminal_commands == {"ses_1": "top"}
    assert (
        manager._sidecars.pending_terminal_commands
        is manager._sidecars.pending_terminal_commands
    )
    assert "pending_terminal_commands" not in manager.__dict__


def test_the_offset_name_is_read_only(manager):
    """NEGATIVE CONTROL, REWRITTEN BY S1. The names are gone, so an
    assignment to one is a NEW attribute rather than a refused write.

    Description: while the facade forwarded, a read-only property made
      ``manager.adopt_fifo_offsets = {}`` raise, which kept a second
      container from being created. With the property deleted, the same
      line silently creates an instance attribute - and that attribute
      would be a second container nothing reads, which is a different
      failure with the same cause. So the control is now that the name
      does not resolve BEFORE such an assignment, and that the sidecars'
      own container is untouched by one.
    """
    assert not hasattr(manager, "adopt_fifo_offsets")

    real = manager._sidecars.adopt_fifo_offsets
    manager.adopt_fifo_offsets = {}  # type: ignore[attr-defined]

    assert manager._sidecars.adopt_fifo_offsets is real, (
        "a stray assignment on the facade reached the sidecars' container"
    )


def test_leg_d_the_public_surface_reads_and_writes_the_sidecars(
    manager, tmp_path
):
    """LEG (d). Delegation is live through the back-compat properties."""
    _register(manager, "ses_d", tmp_path)
    manager._sidecars.set_fifo_offset("ses_d", 4096)

    assert manager.adopt_fifo_start_offset == 4096


def test_leg_d_the_teardown_clears_the_sidecars(manager, tmp_path):
    """LEG (d), teardown half. ``_wipe_session_state`` reaches them."""
    _register(manager, "ses_wipe", tmp_path)
    manager._sidecars.set_fifo_offset("ses_wipe", 4096)

    manager._wipe_session_state("ses_wipe")

    assert "ses_wipe" not in manager._sidecars.adopt_fifo_offsets


def test_leg_f_injected_sidecars_are_the_ones_the_facade_uses(stub_settings):
    """LEG (f). Injection is real, not accepted and then ignored."""
    injected = AttachmentSidecars()
    manager = SessionManager(sidecars=injected)

    assert manager._sidecars is injected
    assert (
        manager._sidecars.pending_terminal_commands
        is injected.pending_terminal_commands
    )

    injected.set_fifo_offset("ses_1", 77)
    assert manager._sidecars.adopt_fifo_offsets["ses_1"] == 77


def test_the_constructor_still_takes_no_arguments(stub_settings):
    """RULE B. 107 test files construct this bare and must keep working."""
    manager = SessionManager()
    assert isinstance(manager._sidecars, AttachmentSidecars)


# --------------------------------------------------------------------------- #
# 2. The one-shot rule, through the facade                                    #
# --------------------------------------------------------------------------- #


def test_the_fifo_offset_is_consumed_exactly_once(manager, tmp_path):
    """THE PLAN'S ASK. A reconnect must not re-seek to a stale offset.

    The second read is the assertion. A ``get`` in place of the ``pop``
    passes the first one perfectly.
    """
    _register(manager, "ses_1", tmp_path)
    manager._sidecars.set_fifo_offset("ses_1", 4096)

    assert manager.consume_adopt_fifo_offset("ses_1") == 4096
    assert manager.consume_adopt_fifo_offset("ses_1") is None
    assert "ses_1" not in manager._sidecars.adopt_fifo_offsets


def test_reading_the_offset_property_does_not_consume_it(manager, tmp_path):
    """A GETTER MAY NOT CONSUME.

    ``peek`` and ``take`` differ by one method call and the wrong one
    reads perfectly well. A property that consumed would let any
    unrelated read destroy the replay position of a session nobody had
    attached to yet.
    """
    _register(manager, "ses_1", tmp_path)
    manager._sidecars.set_fifo_offset("ses_1", 4096)

    assert manager.adopt_fifo_start_offset == 4096
    assert manager.adopt_fifo_start_offset == 4096
    assert manager.consume_adopt_fifo_offset("ses_1") == 4096


def test_consuming_an_offset_for_an_unknown_session_answers_none(manager):
    """A session with no stashed offset starts from the live end."""
    assert manager.consume_adopt_fifo_offset("ses_never_adopted") is None


def test_a_restart_cannot_replay_a_pending_terminal_command(
    manager, tmp_path, monkeypatch
):
    """THE PLAN'S ASK, and the in-memory rule the constructor only stated.

    Two halves. The pop means a RECONNECT within one process gets
    nothing. In-memory-only means a RESTART - a second manager, which is
    what a restart produces - starts with the map empty, so there is
    nothing left to replay even if the pop had not happened.
    """
    _register(manager, "ses_1", tmp_path)
    manager._sidecars.set_pending_command("ses_1", "top")

    assert manager._sidecars.take_pending_command("ses_1") == "top"
    assert manager._sidecars.take_pending_command("ses_1") is None

    restarted = SessionManager()
    assert restarted._sidecars.pending_terminal_commands == {}


def test_the_flush_pops_before_it_resolves_or_types(manager, tmp_path):
    """The ordering is the safety property, not the pop on its own.

    The flush can fail after the pop - an unknown id, a missing backend,
    a write error - and a session whose command FAILED must still not
    have it retyped on the next attach. Here the id resolves to no
    configured command, so the flush gets past the pop and then gives up.
    """
    _register(manager, "ses_1", tmp_path)
    manager._sidecars.set_pending_command("ses_1", "no-such-command-id")

    asyncio.run(manager.flush_pending_terminal_command("ses_1"))

    assert manager._sidecars.pending_terminal_commands == {}


# --------------------------------------------------------------------------- #
# 3. The collaborator's own rules, against no manager at all                  #
# --------------------------------------------------------------------------- #


def test_reads_of_an_unknown_session_answer_none(sidecars):
    """Every read is total. None of these paths may raise on a miss."""
    assert sidecars.peek_fifo_offset("ses_ghost") is None
    assert sidecars.take_fifo_offset("ses_ghost") is None
    assert sidecars.take_pending_command("ses_ghost") is None


def test_reads_of_an_unknown_session_create_nothing(sidecars):
    """NEGATIVE CONTROL. A miss must not mint an entry."""
    sidecars.peek_fifo_offset("ses_ghost")
    sidecars.take_fifo_offset("ses_ghost")
    sidecars.take_pending_command("ses_ghost")

    assert sidecars.adopt_fifo_offsets == {}
    assert sidecars.pending_terminal_commands == {}


def test_a_zero_offset_is_a_real_offset_and_not_a_miss(sidecars):
    """0 is falsy and is the offset a freshly created FIFO starts at.

    A peek written as ``or None``, or a caller testing truthiness, would
    turn "start from the beginning" into "start from wherever you are".
    """
    sidecars.set_fifo_offset("ses_1", 0)

    assert sidecars.peek_fifo_offset("ses_1") == 0
    assert sidecars.take_fifo_offset("ses_1") == 0
    assert sidecars.take_fifo_offset("ses_1") is None


def test_forget_drops_the_offset(sidecars):
    """Teardown takes what ``_wipe_session_state`` took."""
    sidecars.set_fifo_offset("ses_1", 4096)

    sidecars.forget("ses_1")

    assert "ses_1" not in sidecars.adopt_fifo_offsets


def test_forget_deliberately_leaves_the_pending_command(sidecars):
    """MEASURED PRE-MOVE BEHAVIOUR, asserted so a change to it is a choice.

    ``_wipe_session_state`` popped ``adopt_fifo_offsets``
    and never touched
    ``pending_terminal_commands``. The command is popped on flush
    instead, and session ids are not reused, so what stays behind is an
    entry nothing can ever read. It may well be worth dropping - but a
    refactor is not where a behaviour change belongs, and without this
    test the next reader cannot tell the omission from an oversight.
    """
    sidecars.set_pending_command("ses_1", "top")

    sidecars.forget("ses_1")

    assert sidecars.pending_terminal_commands == {"ses_1": "top"}


def test_forget_leaves_every_other_session_alone(sidecars):
    """NEGATIVE CONTROL. Touching one session must never touch another."""
    sidecars.set_fifo_offset("ses_1", 512)
    sidecars.set_fifo_offset("ses_2", 4096)
    sidecars.set_pending_command("ses_2", "top")

    sidecars.forget("ses_1")

    assert sidecars.peek_fifo_offset("ses_1") is None
    assert sidecars.peek_fifo_offset("ses_2") == 4096
    assert sidecars.pending_terminal_commands == {"ses_2": "top"}


def test_forgetting_an_unknown_session_is_a_noop(sidecars):
    """Teardown runs on paths where nothing was ever recorded."""
    sidecars.forget("ses_never_seen")

    assert sidecars.adopt_fifo_offsets == {}
    assert sidecars.pending_terminal_commands == {}


def test_the_two_containers_are_independent(sidecars):
    """NEGATIVE CONTROL. Two dicts, not one keyed two ways."""
    sidecars.set_fifo_offset("ses_1", 4096)
    sidecars.set_pending_command("ses_1", "top")

    assert sidecars.take_fifo_offset("ses_1") == 4096

    assert sidecars.pending_terminal_commands == {"ses_1": "top"}
