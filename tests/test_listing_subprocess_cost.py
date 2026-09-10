"""What one ``GET /sessions/list`` pass costs in tmux subprocesses.

WHY THIS FILE EXISTS. The listing pass is the only place in this server
where a per-request cost is multiplied by the number of live sessions,
and it runs SYNCHRONOUSLY inside ``async def list_session_infos`` - so
while it runs, the event loop does nothing else at all. It cannot read
the tmux pipe carrying terminal output, cannot spawn the ``send-keys``
that delivers a keystroke, and cannot answer another request. A cost that
looks like a listing problem is therefore felt by the user as LAG IN THE
TERMINAL, which is why it is worth a test of its own.

WHAT WAS MEASURED, on the owner's box, 2026-09-09, 13 live sessions:

    tmux list-panes -a (bulk, 1 call)            282 ms
    tmux has-session   x13                       377 ms
    tmux capture-pane  x13                       349 ms
    -------------------------------------------------
    27 subprocesses                             1008 ms

and ``GET /sessions/list`` answered in 0.35-2.24 s against it. A no-op
unauthenticated endpoint (``GET /health``) measured p99 390 ms and max
465 ms over the same period purely from waiting behind it.

Both per-session calls were asking tmux something the bulk listing in the
SAME pass had already answered:

  - ``backend.is_alive()`` is ``tmux has-session``, and the bulk
    ``list-panes -a`` already enumerates every live session by name.
  - the startup gate's ``capture-pane`` was gated on "alive, past the
    grace window, and no hook for this instance", which its own docstring
    called an empty set on a working box. It is not: the hook record is
    IN-MEMORY per server process, so an idle session that fired its last
    hook before this process started never acquires one and pays a
    capture on every poll forever. All 13 sessions were in that state,
    and all 13 were healthy.

WHY THIS TEST COUNTS SUBPROCESSES RATHER THAN TIMING ANYTHING. A wall
clock on a loaded developer box is not reproducible and would either
flake or be set so loose it proves nothing. The subprocess COUNT is the
defect exactly: the number of tmux processes a listing pass spawns must
not grow with the number of sessions. That is a property a machine can
check, and it fails hard on the shipped code (27 for 13 sessions) rather
than by a margin someone can argue about.

SAFETY. Every tmux command here goes to ``tests.socket_guard``'s
``TEST_SOCKET_NAME`` - unique per pytest process - and the installed
subprocess guard rejects any tmux argv it cannot prove is aimed there.
The production socket is unreachable from this file rather than merely
un-referenced.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import closing
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_lsc_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_lsc_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.config import settings
from src.core.session_manager import SessionManager
from src.core.session_startup_gate import STARTUP_TAIL_RECHECK_SECONDS
from src.core.tmux_backend import TmuxBackend
from src.models import Session, SessionStatus
from tests.s7_helpers import migrated_connection
from tests.socket_guard import TEST_SOCKET_NAME

requires_tmux = pytest.mark.skipif(
    shutil.which("tmux") is None, reason="tmux not on PATH"
)

#: How many live sessions the pass is measured against. Small enough to
#: keep the test quick, large enough that a per-session call is
#: unmistakable against a per-pass one: the shipped code spends
#: ``2 * N + 1`` here, so at N=4 the difference is 9 against 1.
LIVE_SESSIONS = 4


def _tmux(*args: str) -> subprocess.CompletedProcess:
    """Run one tmux command against THIS run's test socket.

    Inputs: args (str) - the tmux argv after ``-L <test socket>``.
    Output: subprocess.CompletedProcess, text captured.
    Example: _tmux('kill-server')
    """
    return subprocess.run(
        ["tmux", "-L", TEST_SOCKET_NAME, *args],
        capture_output=True,
        text=True,
        check=False,
    )


class _TmuxCallCounter:
    """Count the tmux subprocesses one code path spawns, by subcommand.

    Description: wraps ``TmuxBackend._run_tmux_sync``, which is the one
        place every synchronous tmux invocation in the backend goes
        through, and records the tmux SUBCOMMAND of each call. Wrapping
        rather than replacing is deliberate: the real call still runs
        against the real test socket, so the pass under measurement is
        the production one and not a simulation of it.
    Inputs: none.
    Output: instances expose ``calls`` (list[str]) and ``count_of``.
    Example:
        >>> counter = _TmuxCallCounter()
        >>> counter.count_of("has-session")
        0
    """

    def __init__(self) -> None:
        self.calls: list[str] = []

    def install(self, monkeypatch) -> None:
        """Wrap ``_run_tmux_sync`` for the duration of one test.

        Inputs: monkeypatch (pytest fixture).
        Output: None.
        """
        original = TmuxBackend._run_tmux_sync
        calls = self.calls

        def counting(self_backend, *args, **kwargs):
            if args:
                calls.append(str(args[0]))
            return original(self_backend, *args, **kwargs)

        monkeypatch.setattr(TmuxBackend, "_run_tmux_sync", counting)

    def count_of(self, subcommand: str) -> int:
        """How many times this tmux subcommand was spawned.

        Inputs: subcommand (str) - e.g. ``'has-session'``.
        Output: int.
        """
        return sum(1 for c in self.calls if c == subcommand)

    def reset(self) -> None:
        """Forget every call counted so far. Inputs: none. Output: None."""
        self.calls.clear()


def _shorten_the_grace_window(monkeypatch) -> None:
    """Make a seconds-old tmux instance count as past its startup grace.

    Description: the gate ignores a pane younger than
        ``STARTUP_HOOK_GRACE_SECONDS`` (20s), and it dates the pane from
        tmux's own ``#{session_created}``, so a session this fixture just
        created is always inside the window and no capture is attempted
        at all. Sleeping 20s per test is not a real option.

        The two functions take ``grace_seconds`` precisely as an
        "override for tests", but ``_startup_gate_for`` does not thread
        it, so the override is reached where the caller actually binds
        it: the keyword-only default. THE REAL FUNCTIONS STILL RUN - this
        shortens one constant and replaces no logic, so the throttle,
        the ladder and the manager's call sequence under test are all the
        production ones.
    Inputs: monkeypatch (pytest fixture).
    Output: None.
    """
    from src.core import session_startup_gate as gate

    for func in (gate.should_capture_tail, gate.resolve_startup_gate):
        patched = dict(func.__kwdefaults__)
        patched["grace_seconds"] = 0
        monkeypatch.setattr(func, "__kwdefaults__", patched)


@pytest.fixture
def live_manager(tmp_path, monkeypatch):
    """A SessionManager holding ``LIVE_SESSIONS`` REAL tmux sessions.

    Description: real panes on the throwaway socket, registered on the
        manager the way the adopt path registers them, so
        ``list_session_infos`` walks the production code with production
        objects. A double cannot be used here: the whole claim is about
        how many subprocesses the REAL backend spawns.

        The panes are bare shells, which is what matters for the startup
        gate: with no hook ever recorded for them and the grace window
        shortened so a seconds-old pane counts as past it, they are
        exactly the population that was paying a ``capture-pane`` on
        every poll forever.
    Inputs: tmp_path, monkeypatch.
    Output: tuple[SessionManager, list[str]] - the manager and the tmux
        names it holds.
    """
    log_dir = tmp_path / "logs"
    state = tmp_path / "state"
    log_dir.mkdir()
    state.mkdir()
    monkeypatch.setattr(settings, "log_directory", str(log_dir))
    monkeypatch.setattr(settings, "state_dir_override", str(state))
    # The socket needs no pinning here: conftest's session-scoped
    # ``tmux_socket_isolation`` fixture has already rewritten every
    # default socket binding in the process to the test socket, and the
    # subprocess guard fails any argv it cannot prove is aimed there.
    with closing(migrated_connection(state)):
        pass
    _shorten_the_grace_window(monkeypatch)

    manager = SessionManager()
    names: list[str] = []
    try:
        for index in range(LIVE_SESSIONS):
            name = f"cloude_cost_{index}_{uuid.uuid4().hex[:6]}"
            created = _tmux(
                "new-session", "-d",
                "-s", name,
                "-c", str(tmp_path),
                "-x", "132", "-y", "40",
            )
            assert created.returncode == 0, created.stderr
            names.append(name)

            session_id = f"ses_cost_{index}"
            backend = TmuxBackend(
                session_id=session_id,
                working_dir=tmp_path,
                on_output=None,
                socket_name=TEST_SOCKET_NAME,
                session_name=name,
            )
            manager.backends[session_id] = backend
            manager.sessions[session_id] = Session(
                id=session_id,
                status=SessionStatus.RUNNING,
                working_dir=str(tmp_path),
                created_at=datetime.utcnow(),
            )
        yield manager, names
    finally:
        _tmux("kill-server")


@requires_tmux
@pytest.mark.asyncio
async def test_listing_tmux_subprocesses_do_not_grow_with_session_count(
    live_manager,
    monkeypatch,
):
    """One listing pass must not spawn a tmux process per session.

    THE MEASUREMENT THAT FAILS ON THE SHIPPED CODE. Before the fix this
    pass spawned ``2 * N + 1`` tmux subprocesses for N live sessions -
    one bulk ``list-panes -a``, then a ``has-session`` and a
    ``capture-pane`` for every row - so at N=4 it spawned 9. The bulk
    listing had already answered both questions.

    The bound asserted is deliberately expressed against N rather than as
    a fixed number: a pass that is correct spends a constant, so any
    growth term at all is the defect returning.
    """
    manager, names = live_manager
    counter = _TmuxCallCounter()
    counter.install(monkeypatch)

    infos = await manager.list_session_infos()
    assert len(infos) == LIVE_SESSIONS, (
        "the pass must still return every live session - a cheaper pass "
        f"that loses rows is not the fix. got {len(infos)}"
    )

    has_session = counter.count_of("has-session")
    assert has_session == 0, (
        f"the pass spawned {has_session} 'tmux has-session' calls for "
        f"{LIVE_SESSIONS} sessions. Existence is already in the bulk "
        "'list-panes -a' row this same pass fetched; asking tmux again, "
        "once per session, is what put 377 ms of blocking subprocess on "
        "the event loop and turned a listing cost into keystroke lag."
    )
    assert len(counter.calls) < 2 * LIVE_SESSIONS, (
        f"one listing pass spawned {len(counter.calls)} tmux "
        f"subprocesses for {LIVE_SESSIONS} sessions: {counter.calls}. "
        "The cost of a pass must not grow with the number of sessions."
    )


@requires_tmux
@pytest.mark.asyncio
async def test_a_second_listing_pass_re_reads_no_pane_tails(
    live_manager,
    monkeypatch,
):
    """A repeat poll must not re-run the startup gate's capture-pane.

    THE HALF THAT LOOKED FREE AND WAS NOT. ``should_capture_tail``
    refuses a session that has fired a hook, and its docstring reasoned
    from that to "on a working box the set is empty". The hook record is
    in-memory and per server process, so every session that last fired a
    hook before this process started is permanently in the set. Measured
    on the owner's box: 13 of 13 healthy sessions took a capture on every
    5-second poll, forever.

    The first pass here still captures - that is the behaviour the gate
    exists for and it is asserted, because a fix that simply stopped
    looking would pass a "cheaper" test while deleting the feature. What
    the second pass must not do is pay for it again inside the recheck
    window.
    """
    manager, names = live_manager
    counter = _TmuxCallCounter()
    counter.install(monkeypatch)

    await manager.list_session_infos()
    first_pass_captures = counter.count_of("capture-pane")
    assert first_pass_captures == LIVE_SESSIONS, (
        "the FIRST look at a hookless, long-lived pane must still happen "
        "or the startup gate has been deleted rather than throttled. "
        f"expected {LIVE_SESSIONS} captures, got {first_pass_captures}"
    )

    counter.reset()
    await manager.list_session_infos()
    assert counter.count_of("capture-pane") == 0, (
        f"a second listing pass re-read {counter.count_of('capture-pane')} "
        "pane tails inside the "
        f"{STARTUP_TAIL_RECHECK_SECONDS}s recheck window. The verdict "
        "from the first read is on the ledger and still stands; paying "
        "for it again every poll is 349 ms of blocked event loop per "
        "pass on a box with 13 sessions."
    )


@requires_tmux
@pytest.mark.asyncio
async def test_the_throttled_pass_still_answers_the_startup_gate(
    live_manager,
    monkeypatch,
):
    """Skipping the capture must not downgrade the answer to ``unknown``.

    A THROTTLE THAT MADE THE ROW FLAP WOULD BE WORSE THAN THE COST. The
    gate's rung 5 refuses when no tail was captured, so a pass that
    simply declined to look would answer ``unknown`` on every poll
    between reads - the row alternating between a measured verdict and
    "could not determine" while nothing about the session changed. The
    remembered verdict is what keeps the answer stable, and it is
    consulted only where a fresh reading is absent.
    """
    manager, names = live_manager
    counter = _TmuxCallCounter()
    counter.install(monkeypatch)

    first = {i.tmux_session: i.startup_gate for i in await manager.list_session_infos()}
    counter.reset()
    second = {i.tmux_session: i.startup_gate for i in await manager.list_session_infos()}

    assert counter.count_of("capture-pane") == 0, "the second pass should be throttled"
    assert first == second, (
        "the startup gate changed between two polls with nothing else "
        f"changing: {first} then {second}. A throttled read must reuse "
        "the verdict it already measured, not fall back to 'unknown'."
    )
