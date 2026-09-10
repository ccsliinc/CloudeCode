"""S4: the log buffers and command counters moved, and they MOVED not copied.

Slice S4 of the ``session_manager`` decomposition
(``.claude/notes/backend-decomposition-plan.md``). ``log_buffers`` and
``command_counts`` left the god object for ``SessionRegistry`` in
``src/core/sessions/registry.py``, along with the append, the line cap, the
per-session ensure and the teardown.

**THIS CLUSTER HAD NO TESTS AT ALL, AND THAT IS THE FIRST FINDING.** The
plan named ``tests/test_session_backend.py`` as the existing coverage.
Measured before the move: ``add_log_entry`` and ``get_recent_logs`` appear
in ZERO test files in this suite, that one included. The only exercise
either got was indirect, through ``_session_info_for`` reading
``get_recent_logs`` for a listing row. So no pre-existing test could have
gone red for any defect introduced here, which raises rather than lowers
what this file has to prove.

**THE NO-COPY LEGS, AND WHY THESE ONES.** S1's cluster was scalars, S2's
was dicts a caller rebinds, S3's was containers a defensive accessor in
another module reads. This cluster has NO reader outside
``session_manager.py`` at all - measured across ``src/`` and ``tests/`` -
so there is no consumer whose behaviour a copy could break and no
behavioural leg available from the existing suite. That absence is
exactly why the structural legs carry the proof here:

  (a) identity of both containers, facade against registry;
  (b) neither name is an instance attribute on the facade, and both are
      properties on the class. S2 MEASURED that leg (a) alone stays green
      when ``__init__`` assigns ``self.log_buffers = registry.log_buffers``,
      because on that day the two names really are one object. Leg (b) is
      what fails on it;
  (c) an in-place write through either spelling is seen by the other,
      which is the same fact as (a) said in behaviour rather than in
      identity, and the leg a COPY-returning property fails. S3 measured
      that a copying property left 66 of 66 pre-existing tests green;
  (d) live delegation in both directions through the real public methods,
      ``add_log_entry`` / ``get_recent_logs`` / ``send_command``'s counter
      and ``_wipe_session_state``;
  (e) an injected registry is the object the facade actually holds and
      uses, so injection is real rather than accepted-and-ignored.

**THE CAP MUST COME THROUGH ``session_manager.settings``.** The registry
takes the cap as a callable rather than importing ``settings``, and that
is not ceremony: four test modules install a stub settings object with
``monkeypatch.setattr("src.core.session_manager.settings", ...)``. A
registry that imported ``settings`` itself would read the developer's
real configuration during a pytest run. There is a leg for it.

Run with:
    ./venv/bin/python3 -m pytest tests/test_session_registry.py -v
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_sr_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_sr_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.session_manager import SessionManager
from src.core.sessions.registry import SessionRegistry
from src.models import Session, SessionStatus


# --------------------------------------------------------------------------- #
# Fixtures                                                                     #
# --------------------------------------------------------------------------- #


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__`` to load.

    Description: carries a MUTABLE ``log_buffer_size`` so a test can move
      the cap on a live manager and prove the callable is re-read rather
      than captured.
    """

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


@pytest.fixture()
def registry() -> SessionRegistry:
    """A bare registry with a generous cap. No manager, no disk, no tmux."""
    return SessionRegistry(log_cap=lambda: 1000)


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
    manager.sessions[session_id] = sess
    manager._last_session_id = session_id
    return sess


# --------------------------------------------------------------------------- #
# 1. The no-copy rule                                                         #
# --------------------------------------------------------------------------- #


def test_leg_a_the_facade_containers_are_the_registry_containers(manager):
    """LEG (a). One object per container, not two that agree today."""
    assert manager._registry.log_buffers is manager._registry.log_buffers
    assert manager._registry.command_counts is manager._registry.command_counts


def test_leg_b_the_facade_holds_no_field_of_its_own(manager):
    """LEG (b), REWRITTEN BY S1. There is no second door at all now.

    Description: this used to assert the names were PROPERTIES on the
      class rather than fields on the instance, which was the right check
      while the facade forwarded: a ``self.log_buffers = ...`` in
      ``__init__`` would pass leg (a) on a fresh object and shadow the
      property forever after. S1 deleted the forwarders, so the invariant
      is stronger and simpler - the manager resolves none of these names
      by any route, and a property coming back IS a forwarder coming back.
    """
    for name in ("log_buffers", "command_counts"):
        assert not hasattr(manager, name), (
            f"{name} resolves on the facade again; the registry owns it and "
            "a caller holds the registry"
        )
    assert manager._registry.log_buffers is not None


def test_leg_c_writes_cross_in_both_directions(manager):
    """LEG (c). Behaviour saying what leg (a) says structurally.

    A property returning ``dict(self._registry.log_buffers)`` passes every
    value assertion in the rest of this file and fails here.
    """
    manager._registry.log_buffers["ses_from_registry"] = []
    assert "ses_from_registry" in manager._registry.log_buffers

    manager._registry.log_buffers["ses_from_facade"] = []
    assert "ses_from_facade" in manager._registry.log_buffers

    manager._registry.command_counts["ses_from_registry"] = 7
    assert manager._registry.command_counts["ses_from_registry"] == 7

    manager._registry.command_counts["ses_from_facade"] = 3
    assert manager._registry.command_counts["ses_from_facade"] == 3


def test_leg_d_the_public_methods_read_and_write_the_registry(manager, tmp_path):
    """LEG (d). Delegation is live through the real public surface."""
    _register(manager, "ses_d", tmp_path)

    manager.add_log_entry("first line", session_id="ses_d")
    assert [e.content for e in manager._registry.log_buffers["ses_d"]] == [
        "first line"
    ]

    manager._registry.append_log("ses_d", "second line")
    assert [e.content for e in manager.get_recent_logs(session_id="ses_d")] == [
        "first line",
        "second line",
    ]


def test_leg_d_the_teardown_clears_the_registry(manager, tmp_path):
    """LEG (d), teardown half. ``_wipe_session_state`` reaches the registry."""
    _register(manager, "ses_wipe", tmp_path)
    manager.add_log_entry("something", session_id="ses_wipe")
    manager._registry.count_command("ses_wipe")
    assert "ses_wipe" in manager._registry.log_buffers

    manager._wipe_session_state("ses_wipe")

    assert "ses_wipe" not in manager._registry.log_buffers
    assert "ses_wipe" not in manager._registry.command_counts


def test_leg_e_an_injected_registry_is_the_one_the_facade_uses(
    stub_settings, tmp_path
):
    """LEG (e). Injection is real, not accepted and then ignored."""
    injected = SessionRegistry(log_cap=lambda: 3)
    manager = SessionManager(registry=injected)

    assert manager._registry is injected
    assert manager._registry.log_buffers is injected.log_buffers

    _register(manager, "ses_inject", tmp_path)
    manager.add_log_entry("via the facade", session_id="ses_inject")
    assert [e.content for e in injected.log_buffers["ses_inject"]] == [
        "via the facade"
    ]


def test_the_constructor_still_takes_no_arguments(stub_settings):
    """RULE B. 107 test files construct this bare and must keep working."""
    manager = SessionManager()
    assert isinstance(manager._registry, SessionRegistry)


# --------------------------------------------------------------------------- #
# 2. The cap comes from session_manager's settings, at append time            #
# --------------------------------------------------------------------------- #


def test_the_cap_is_read_through_the_patched_settings_object(
    stub_settings, manager, tmp_path
):
    """THE RULE-3 LEG. A registry importing ``settings`` would miss this.

    The stub installed on ``src.core.session_manager.settings`` says the
    cap is 2. If the registry resolved the cap itself, the real
    ``Settings.log_buffer_size`` of 1000 would apply and nothing would be
    trimmed - silently, and against the developer's own configuration.
    """
    stub_settings.log_buffer_size = 2
    _register(manager, "ses_cap", tmp_path)

    for i in range(5):
        manager.add_log_entry(f"line {i}", session_id="ses_cap")

    kept = [e.content for e in manager.get_recent_logs(session_id="ses_cap")]
    assert kept == ["line 3", "line 4"]


def test_the_cap_is_re_read_per_append_not_captured(stub_settings, manager, tmp_path):
    """A settings reload has to take effect on a LIVE manager."""
    stub_settings.log_buffer_size = 10
    _register(manager, "ses_recap", tmp_path)
    for i in range(6):
        manager.add_log_entry(f"line {i}", session_id="ses_recap")
    assert len(manager._registry.log_buffers["ses_recap"]) == 6

    stub_settings.log_buffer_size = 2
    manager.add_log_entry("line 6", session_id="ses_recap")

    kept = [e.content for e in manager._registry.log_buffers["ses_recap"]]
    assert kept == ["line 5", "line 6"]


# --------------------------------------------------------------------------- #
# 3. The registry's own rules, against no manager at all                      #
# --------------------------------------------------------------------------- #


def test_the_trim_drops_the_oldest_and_keeps_the_newest():
    """The cap bounds the buffer, and it is the HEAD that goes.

    A trim that took from the tail would keep a stale window and drop the
    line the user is waiting to see, which is the wrong half of a log.
    """
    registry = SessionRegistry(log_cap=lambda: 3)
    for i in range(6):
        registry.append_log("ses_1", f"line {i}")

    assert [e.content for e in registry.log_buffers["ses_1"]] == [
        "line 3",
        "line 4",
        "line 5",
    ]


def test_append_creates_the_buffer_for_an_unseen_session(registry):
    """A line for a session that never reached ``ensure`` is still kept."""
    entry = registry.append_log("ses_new", "hello", "stderr")

    assert registry.log_buffers["ses_new"] == [entry]
    assert entry.log_type == "stderr"
    assert entry.session_id == "ses_new"


def test_ensure_is_idempotent_and_never_clobbers(registry):
    """Create, adopt and boot rehydrate all register; two must not reset one."""
    registry.append_log("ses_1", "already here")
    registry.count_command("ses_1")

    registry.ensure("ses_1")

    assert len(registry.log_buffers["ses_1"]) == 1
    assert registry.command_counts["ses_1"] == 1


def test_ensure_gives_a_fresh_session_both_containers(registry):
    """Both halves, because a counter absent from the map reads as no session."""
    registry.ensure("ses_fresh")

    assert registry.log_buffers["ses_fresh"] == []
    assert registry.command_counts["ses_fresh"] == 0


def test_forget_drops_both_containers_for_one_session(registry):
    """Teardown takes the pair. Dropping one leaves a counter with no buffer."""
    registry.append_log("ses_1", "x")
    registry.count_command("ses_1")

    registry.forget("ses_1")

    assert "ses_1" not in registry.log_buffers
    assert "ses_1" not in registry.command_counts


def test_forget_leaves_every_other_session_alone(registry):
    """NEGATIVE CONTROL. Touching one session must never touch another.

    These are dicts keyed by session id precisely so two browser tabs on
    two sessions cannot interfere, and a teardown that reset a shared
    container would pass every single-session assertion above.
    """
    registry.append_log("ses_1", "mine")
    registry.append_log("ses_2", "theirs")
    registry.count_command("ses_2")

    registry.forget("ses_1")

    assert [e.content for e in registry.log_buffers["ses_2"]] == ["theirs"]
    assert registry.command_counts["ses_2"] == 1


def test_forgetting_an_unknown_session_is_a_noop(registry):
    """Teardown runs on paths where registration may never have happened."""
    registry.forget("ses_never_seen")

    assert registry.log_buffers == {}
    assert registry.command_counts == {}


def test_counting_creates_the_counter_for_an_unseen_session(registry):
    """``send_command`` can reach a session that skipped ``ensure``."""
    assert registry.count_command("ses_x") == 1
    assert registry.count_command("ses_x") == 2
    assert registry.command_count("ses_x") == 2


def test_counts_are_scoped_to_the_session(registry):
    """NEGATIVE CONTROL. One session's traffic is not another's."""
    registry.count_command("ses_1")
    registry.count_command("ses_1")
    registry.count_command("ses_2")

    assert registry.command_count("ses_1") == 2
    assert registry.command_count("ses_2") == 1


def test_reads_of_an_unknown_session_answer_empty_and_create_nothing(registry):
    """A read must not mint a bucket, or a listing pass would grow the map."""
    assert registry.recent_logs("ses_ghost", 100) == []
    assert registry.command_count("ses_ghost") == 0
    assert registry.log_line_count("ses_ghost") == 0

    assert registry.log_buffers == {}
    assert registry.command_counts == {}


def test_recent_logs_honours_the_limit_and_returns_the_newest(registry):
    """The API contract: the TAIL, oldest first within it."""
    for i in range(5):
        registry.append_log("ses_1", f"line {i}")

    assert [e.content for e in registry.recent_logs("ses_1", 2)] == [
        "line 3",
        "line 4",
    ]


def test_recent_logs_hands_back_a_new_list_not_the_live_buffer(registry):
    """NEGATIVE CONTROL, and the one place a copy is CORRECT.

    The caller serialises this into a response while the output fan-out
    may be appending. Handing out the live container would let a
    serializer iterate a list that is growing under it, and would let a
    caller truncate the real buffer by slicing its own view.
    """
    registry.append_log("ses_1", "line 0")

    view = registry.recent_logs("ses_1", 100)
    view.clear()

    assert registry.log_line_count("ses_1") == 1
