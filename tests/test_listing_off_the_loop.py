"""The listing pass gathers its expensive reads OFF the event loop.

FIVE GROUPS, AND THE ORDER IS THE ARGUMENT.

1.  STRUCTURAL: the gather runs in a thread, proved by a stand-in read
    that parks until a coroutine BESIDE IT releases it. A coroutine can
    only release it if the loop is free, so the test can pass only when
    the work is genuinely off the loop.
2.  NEGATIVE CONTROL for group 1, reproducing the pre-fix shape inline -
    synchronous work inside a coroutine - and asserting the same harness
    reports the loop starved. Without it the structural test would pass
    against code that never moved and prove nothing.
3.  THE OUTPUT DID NOT MOVE. The whole point of this change is WHERE the
    work runs. Every row the prefetched pass produces is compared, as
    serialised JSON, against the row the pre-existing per-row reads
    produce for the same session - including the degraded paths, which
    are where a prefetch that conflated "not read" with "read and found
    nothing" would show up.
4.  THE STALENESS RULE. No WRITE was moved into the thread, so there is
    no apply stage to re-validate. What there is instead is one rule
    that has to hold: OWNERSHIP IS NOT PREFETCHED, so an adoption that
    lands while the gather thread is running - which is now possible,
    because the loop is free - is still seen on the very same pass.
    Asserted here against the DATASTORE rung, which is the one an
    adoption actually moves.
5.  A PREFETCH IS NEVER FABRICATED. A session registered while the
    gather ran has no prefetch entry and must fall THROUGH to the live
    per-row read, which is exactly what it did before this change.
6.  THE THREAD TOUCHES NO LIVE CONTAINER, proved by wrapping the real
    ones in thread recorders and driving the REAL reader bundle through
    ``asyncio.to_thread``. Group 4 of ``ListingReaders`` is an audit of
    six function bodies, and a bound method carries ``self``, so nothing
    in the signature stops one of them growing a ``self.sessions`` read.
    This is the test that stops that audit rotting.

Deliberately not timed. This box is shared and heavily loaded; a
wall-clock threshold would either flake or be loosened until it proved
nothing. Same reasoning as ``tests/test_listing_subprocess_cost.py``,
which counts subprocesses, and ``tests/test_config_files_shallow.py``,
whose loop test this one is modelled on.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_lotl_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_lotl_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core import listing_gather
from src.core.listing_prefetch import ListingPrefetch, build_listing_prefetch
from src.core.session_manager import SessionManager
from src.core.session_status_map import StatusMap
from src.models import Session, SessionStatus

TEST_SOCKET = "cloude_lotl_test"
#: How long a parked stand-in read waits for the loop to release it. Long
#: enough that a loaded box cannot fail it spuriously, short enough that a
#: genuine regression fails the build rather than hanging it.
PARK_TIMEOUT_SECONDS = 10.0
#: Heartbeat cadence for the coroutine standing in for the tmux pipe
#: reader, and the number of ticks it is allowed before giving up.
HEARTBEAT_SECONDS = 0.005
HEARTBEAT_MAX_TICKS = 400


class _FakeBackend:
    """A tmux-shaped backend that spawns nothing and probes nothing.

    Description: ``_session_info_for`` reads four attributes off a
      backend and may call ``is_alive()``. A real TmuxBackend would put a
      subprocess in the middle of a test about thread scheduling, so this
      stands in for one. ``pane_dead`` is offered so a caller can build a
      dead-pane row for the degraded cases.
    Inputs: session_id (str). tmux_session (str | None). alive (bool).
    Output: an object satisfying the attribute reads the pass makes.
    Example: _FakeBackend('ses_a', 'cloude_a')
    """

    def __init__(
        self,
        session_id: str,
        tmux_session: str | None,
        alive: bool = True,
    ) -> None:
        self.session_id = session_id
        self.tmux_session = tmux_session
        self.socket_name = TEST_SOCKET
        self.pid = 4321
        self._alive = alive

    def is_alive(self) -> bool:
        """Whether tmux would report this session as existing."""
        return self._alive


def _manager_with(sessions: list[tuple[str, str | None]]) -> SessionManager:
    """A SessionManager holding the given (session_id, tmux_name) pairs.

    Inputs: sessions (list[tuple[str, str | None]]).
    Output: SessionManager with backends and RUNNING session rows.
    Example: _manager_with([('ses_a', 'cloude_a')])
    """
    manager = SessionManager()
    for session_id, tmux_name in sessions:
        manager.backends[session_id] = _FakeBackend(session_id, tmux_name)
        manager.sessions[session_id] = Session(
            id=session_id,
            status=SessionStatus.RUNNING,
            working_dir=str(ROOT),
            created_at=datetime.utcnow(),
        )
    return manager


def _status_rows(names: list[str], *, dead: set[str] | None = None) -> StatusMap:
    """A complete bulk listing naming each session, on the test socket.

    Inputs: names (list[str]). dead (set[str] | None) - names whose pane
      must read as a dead husk.
    Output: StatusMap with ``complete=True`` and the test socket stated.
    Example: _status_rows(['cloude_a'])
    """
    dead = dead or set()
    return StatusMap(
        {
            name: {
                "name": name,
                "pane_dead": "1" if name in dead else "0",
                "pane_current_command": "sleep",
                "pid": 4321,
                "status": "dead" if name in dead else "running",
                "created_at_epoch": 1700000000,
            }
            for name in names
        },
        complete=True,
        socket=TEST_SOCKET,
    )


# ---- 1. the gather must not run on the event loop ----------------------

def test_the_listing_gather_runs_off_the_event_loop(monkeypatch):
    """The decisive test, and it is STRUCTURAL rather than timed.

    The stand-in bulk tmux read parks until a coroutine beside it
    releases it. That coroutine stands in for the tmux pipe reader
    carrying a session's terminal output, and for every other request the
    server owes an answer to. If the gather runs on the event loop the
    coroutine can never be scheduled, the release never happens, and the
    parked read fails on its own bounded wait. If the gather runs in a
    thread the loop stays free, the coroutine ticks, and both finish.
    """
    manager = _manager_with([("ses_a", "cloude_a")])
    entered = threading.Event()
    released = threading.Event()

    def parked_status_map() -> StatusMap:
        entered.set()
        if not released.wait(timeout=PARK_TIMEOUT_SECONDS):
            raise AssertionError(
                "the event loop never got to run while the gather was in "
                "progress: the gather is ON the loop"
            )
        return _status_rows(["cloude_a"])

    monkeypatch.setattr(manager, "_build_tmux_status_map", parked_status_map)
    monkeypatch.setattr(
        manager, "_instance_index_for_listing", lambda **_kw: None
    )
    monkeypatch.setattr(manager, "_label_for_tmux_name", lambda _n: None)
    monkeypatch.setattr(manager, "_identity_for_live_name", lambda _n: None)
    monkeypatch.setattr(manager, "_restored_activity_state", lambda _n: None)
    monkeypatch.setattr(manager, "_owned_instances_from_db", lambda: set())

    async def scenario():
        task = asyncio.create_task(manager.list_session_infos())
        ticks = 0
        for _ in range(HEARTBEAT_MAX_TICKS):
            await asyncio.sleep(HEARTBEAT_SECONDS)
            ticks += 1
            if entered.is_set():
                released.set()
                break
        infos = await task
        return ticks, infos

    ticks, infos = asyncio.run(scenario())
    assert entered.is_set(), "the gather never started"
    assert ticks > 0, "the loop was starved for the whole gather"
    assert len(infos) == 1, "a cheaper pass that loses rows is not the fix"


def test_the_loop_test_can_detect_a_gather_that_is_on_the_loop():
    """NEGATIVE CONTROL for the test above.

    A harness that could never observe starvation would pass against the
    pre-fix code and prove nothing at all. This reproduces the pre-fix
    shape inline - synchronous work inside a coroutine, which is exactly
    what ``list_session_infos`` was before ``asyncio.to_thread`` - and
    asserts the heartbeat beside it does NOT advance.
    """
    ticks = 0

    async def heartbeat():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.001)
            ticks += 1

    async def scenario():
        nonlocal ticks
        beat = asyncio.create_task(heartbeat())
        await asyncio.sleep(0.02)
        assert ticks > 0, "the heartbeat never started, so it proves nothing"
        before = ticks
        time.sleep(0.30)
        during = ticks - before
        beat.cancel()
        return during

    assert asyncio.run(scenario()) == 0, (
        "a synchronous 300ms call inside a coroutine let the loop run, so "
        "this harness cannot detect loop blocking and the test above is "
        "worthless"
    )


# ---- 2. the answer did not move ---------------------------------------

@pytest.mark.parametrize(
    "case,label,identity,restored,owned,dead",
    [
        ("a fully decorated row", "work", {"id": 7, "parent_session_id": None,
         "agent_type": "claude-chrome", "agent_family_source": "launched"},
         "idle", {("cloude_a", 1700000000)}, False),
        ("an unreadable row - every reader answers None", None, None, None,
         None, False),
        ("a row with no label but a real identity", None,
         {"id": 9, "parent_session_id": None, "agent_type": None,
          "agent_family_source": None}, None, set(), False),
        ("a dead pane", "work", None, None, set(), True),
    ],
)
def test_the_prefetched_row_is_identical_to_the_per_row_read(
    monkeypatch, case, label, identity, restored, owned, dead
):
    """Byte-identical output, prefetched against read-per-row.

    The pass's job did not change; only where the reads happen did. So
    the row built from a prefetch must serialise to exactly the bytes the
    row built from the live per-row readers does, on every path INCLUDING
    the degraded ones - an unreadable datastore, a row with no label, and
    a pane measured dead, which drops the row on both sides.
    """
    name = "cloude_a"
    manager = _manager_with([("ses_a", name)])
    monkeypatch.setattr(
        manager,
        "_build_tmux_status_map",
        lambda: _status_rows([name], dead={name} if dead else set()),
    )
    monkeypatch.setattr(
        manager, "_instance_index_for_listing", lambda **_kw: None
    )
    monkeypatch.setattr(manager, "_label_for_tmux_name", lambda _n: label)
    monkeypatch.setattr(manager, "_identity_for_live_name", lambda _n: identity)
    monkeypatch.setattr(manager, "_restored_activity_state", lambda _n: restored)
    monkeypatch.setattr(manager, "_owned_instances_from_db", lambda: owned)

    prefetched = asyncio.run(manager.list_session_infos())

    # The pre-change shape: no prefetch at all, so every decoration comes
    # from the live per-row reader.
    per_row = manager._session_info_for(
        "ses_a",
        status_map=manager._build_tmux_status_map(),
        instance_index=None,
        prefetch=None,
    )

    if dead:
        assert prefetched == [] and per_row is None, (
            f"{case}: a dead pane must drop off the live list on both paths"
        )
        return
    assert len(prefetched) == 1 and per_row is not None, case
    assert prefetched[0].model_dump_json() == per_row.model_dump_json(), (
        f"{case}: the prefetched row is not byte-identical to the row the "
        "per-row readers produce"
    )


def test_an_adopted_id_is_decorated_the_same_way(monkeypatch):
    """An adopted session carries ``adopted:<name>`` and must not differ.

    Anything that parses, matches or routes on a session id has to handle
    both id shapes, and the prefetch is keyed on the TMUX NAME rather
    than on the id precisely so it cannot care which one this is.
    """
    name = "cloude_adoptme"
    manager = _manager_with([(f"adopted:{name}", name)])
    monkeypatch.setattr(
        manager, "_build_tmux_status_map", lambda: _status_rows([name])
    )
    monkeypatch.setattr(
        manager, "_instance_index_for_listing", lambda **_kw: None
    )
    monkeypatch.setattr(manager, "_label_for_tmux_name", lambda _n: "adopted")
    monkeypatch.setattr(manager, "_identity_for_live_name", lambda _n: None)
    monkeypatch.setattr(manager, "_restored_activity_state", lambda _n: None)
    monkeypatch.setattr(manager, "_owned_instances_from_db", lambda: set())

    prefetched = asyncio.run(manager.list_session_infos())
    per_row = manager._session_info_for(
        f"adopted:{name}",
        status_map=manager._build_tmux_status_map(),
        instance_index=None,
        prefetch=None,
    )
    assert len(prefetched) == 1 and per_row is not None
    assert prefetched[0].model_dump_json() == per_row.model_dump_json()


def test_an_incomplete_listing_produces_the_same_row_on_both_paths(monkeypatch):
    """A probe that could not run vouches for nothing, prefetch or not.

    An empty ``StatusMap`` with ``complete=False`` is the honest
    degradation when tmux cannot be probed. The row must survive on the
    backend's own ``is_alive()``, and must read the same either way.
    """
    name = "cloude_a"
    manager = _manager_with([("ses_a", name)])
    monkeypatch.setattr(manager, "_build_tmux_status_map", StatusMap)
    monkeypatch.setattr(
        manager, "_instance_index_for_listing", lambda **_kw: None
    )
    monkeypatch.setattr(manager, "_label_for_tmux_name", lambda _n: "x")
    monkeypatch.setattr(manager, "_identity_for_live_name", lambda _n: None)
    monkeypatch.setattr(manager, "_restored_activity_state", lambda _n: None)
    monkeypatch.setattr(manager, "_owned_instances_from_db", lambda: None)

    prefetched = asyncio.run(manager.list_session_infos())
    per_row = manager._session_info_for(
        "ses_a", status_map=StatusMap(), instance_index=None, prefetch=None
    )
    assert len(prefetched) == 1 and per_row is not None
    assert prefetched[0].model_dump_json() == per_row.model_dump_json()


# ---- 3. what a stale snapshot may and may not decide -------------------

def test_an_adoption_landing_during_the_gather_is_reported_owned(monkeypatch):
    """THE STALENESS RULE, and it is why ownership is NOT prefetched.

    AN ADOPTION MOVES THE DATASTORE AND NOTHING ELSE.
    ``adopt_external_session`` says in its own docstring that it does not
    add to ``owned_tmux_sessions``, and the only three ``.add`` sites are
    the boot backfill, create and rename. So the datastore is the rung an
    adoption lands on, which is exactly the rung a prefetch would have
    frozen - and freeing the loop is what makes an adoption able to land
    while the gather runs at all.

    This drives the REAL pass and moves the DATASTORE answer at the
    moment the gather is in flight, which is the mechanism production
    uses. An earlier version of this test faked the adoption by calling
    ``owned_tmux_sessions.add``, a path adoption never takes, so it was
    green while vouching for nothing.
    """
    manager = _manager_with([("ses_a", "cloude_a")])
    adopted: set[tuple[str, int]] = set()

    def entering_gather() -> StatusMap:
        # The adoption lands here, in the window the gather thread owns.
        adopted.add(("cloude_a", 1700000000))
        return _status_rows(["cloude_a"])

    monkeypatch.setattr(manager, "_build_tmux_status_map", entering_gather)
    monkeypatch.setattr(
        manager, "_instance_index_for_listing", lambda **_kw: None
    )
    monkeypatch.setattr(manager, "_label_for_tmux_name", lambda _n: None)
    monkeypatch.setattr(manager, "_identity_for_live_name", lambda _n: None)
    monkeypatch.setattr(manager, "_restored_activity_state", lambda _n: None)
    monkeypatch.setattr(
        manager, "_owned_instances_from_db", lambda: set(adopted)
    )

    infos = asyncio.run(manager.list_session_infos())
    assert [i.created_by_cloude for i in infos] == [True], (
        "an adoption that landed while the gather ran was reported unowned, "
        "so the ownership read is being answered from a frozen snapshot"
    )


def test_ownership_is_never_answered_from_the_prefetch():
    """The prefetch has no ownership rung to be answered from.

    Structural rather than behavioural: a future edit that puts the
    ownership read back into the gather has to argue with this. The
    prefetch's whole surface is the three name-keyed decorations.
    """
    prefetch = build_listing_prefetch(
        names=["cloude_a"],
        label_for_name=lambda _n: None,
        identity_for_live_name=lambda _n: None,
        restored_activity_state=lambda _n: None,
    )
    # ``hasattr`` on the CLASS cannot answer this: a dataclass field with
    # no default is not a class attribute, so it would read as absent
    # whether or not it exists. The field table is the real answer.
    fields = set(type(prefetch).__dataclass_fields__)
    assert fields == {"by_name"}, (
        f"the prefetch grew a field beyond the three name-keyed "
        f"decorations: {sorted(fields)}. If that field is the ownership "
        "read, it re-opens the window where an adoption landing during "
        "the gather is reported unowned for a poll cycle."
    )
    assert "owned_instances_from_db" not in (
        listing_gather.ListingReaders.__dataclass_fields__
    ), "the ownership read is back in the gather thread"


def test_a_session_registered_during_the_gather_falls_through_to_live_reads(
    monkeypatch,
):
    """A name the prefetch never covered must not read as "no decorations".

    The row set is taken AFTER the gather, so a session created while the
    thread ran is in this pass with no prefetch entry. It has to fall
    through to the per-row readers, which is exactly what it did before
    this change - inventing a None for it would blank its label and its
    row identity.
    """
    manager = _manager_with([("ses_a", "cloude_a")])
    live_reads: list[str] = []

    def entering_gather() -> StatusMap:
        # Stands in for the session that gets registered while the
        # gather thread is busy.
        manager.backends["ses_b"] = _FakeBackend("ses_b", "cloude_b")
        manager.sessions["ses_b"] = Session(
            id="ses_b",
            status=SessionStatus.RUNNING,
            working_dir=str(ROOT),
            created_at=datetime.utcnow(),
        )
        return _status_rows(["cloude_a", "cloude_b"])

    monkeypatch.setattr(manager, "_build_tmux_status_map", entering_gather)
    monkeypatch.setattr(
        manager, "_instance_index_for_listing", lambda **_kw: None
    )

    def label(name):
        live_reads.append(name)
        return f"label-{name}"

    monkeypatch.setattr(manager, "_label_for_tmux_name", label)
    monkeypatch.setattr(manager, "_identity_for_live_name", lambda _n: None)
    monkeypatch.setattr(manager, "_restored_activity_state", lambda _n: None)
    monkeypatch.setattr(manager, "_owned_instances_from_db", lambda: set())

    infos = asyncio.run(manager.list_session_infos())
    labels = {i.tmux_session: i.label for i in infos}
    assert labels == {
        "cloude_a": "label-cloude_a",
        "cloude_b": "label-cloude_b",
    }, "the late session lost its decorations instead of reading them live"
    assert "cloude_b" in live_reads, (
        "the late session must reach the live reader, not a fabricated None"
    )


# ---- 4. the prefetch builder's own rules ------------------------------

def test_names_are_deduplicated_and_falsy_names_are_skipped():
    """A name is read once however many sessions carry it, and None costs nothing."""
    seen: list[str] = []

    def label(name):
        seen.append(name)
        return name

    prefetch = build_listing_prefetch(
        names=["cloude_a", "cloude_a", None, "", "cloude_b"],
        label_for_name=label,
        identity_for_live_name=lambda _n: None,
        restored_activity_state=lambda _n: None,
    )
    assert seen == ["cloude_a", "cloude_b"]
    assert prefetch.has("cloude_a") and prefetch.has("cloude_b")
    assert not prefetch.has(None) and not prefetch.has("cloude_c")


def test_an_empty_prefetch_reports_every_name_absent():
    """The default is complete and correct: everything falls back."""
    empty = ListingPrefetch()
    assert empty.has("cloude_a") is False
    assert empty.label_for("cloude_a") is None


def test_the_gather_reaches_nothing_but_its_two_arguments():
    """The thread body's reach is a property of its signature.

    ``gather_listing_inputs`` takes bound callables and an immutable
    snapshot. This drives it with stand-ins carrying no manager at all,
    which it could not do if the body reached through ``self`` for
    anything.
    """
    snapshot = listing_gather.ListingSnapshot(
        socket=TEST_SOCKET,
        seed_candidate_names=("cloude_a",),
        decorated_names=("cloude_a", "cloude_b"),
    )
    readers = listing_gather.ListingReaders(
        build_status_map=lambda: _status_rows(["cloude_a"]),
        build_instance_index=lambda **kw: kw,
        label_for_name=lambda n: f"L{n}",
        identity_for_live_name=lambda _n: None,
        restored_activity_state=lambda _n: None,
    )
    gathered = listing_gather.gather_listing_inputs(readers, snapshot)
    assert gathered.instance_index == {
        "socket": TEST_SOCKET,
        "names": ["cloude_a"],
    }, "the seed index must be built over the SEED candidates only"
    assert set(gathered.prefetch.by_name) == {"cloude_a", "cloude_b"}, (
        "the decorations must be built over every listed name, which is a "
        "wider set than the seed candidates"
    )
    assert gathered.elapsed_ms >= 0.0


# ---- 5. no live container may be touched from the gather thread -------

#: The manager attributes the event loop mutates while a gather runs.
#: ``sessions`` and ``backends`` are written by create, adopt and destroy;
#: ``_instance_epochs`` and ``_hook_tmux_names`` by the adopt and hook
#: paths; ``pinned_themes`` by the theme PATCH; ``_activity_tracker``
#: holds the mutable dataclasses the hook route writes on every event.
LIVE_CONTAINERS = (
    "sessions",
    "backends",
    "_instance_epochs",
    "pinned_themes",
    "_hook_tmux_names",
    "_activity_tracker",
)


class _ThreadRecordingProxy:
    """Wrap a live container and record which thread touched it.

    Description: THE TRIPWIRE. ``ListingReaders`` narrows what
      ``listing_gather`` itself can reach and narrows nothing about the
      reader BODIES, because a bound method carries ``self``. So the
      containers are wrapped rather than the module inspected: any
      attribute access, item lookup, membership test or iteration lands
      here and the accessing thread is recorded. Every access is then
      forwarded to the real object, so the pass under measurement is the
      production one and a reader that legitimately touches a container
      ON THE LOOP is not broken by this.
    Inputs: wrapped (object) - the real container. name (str) - the
      attribute it is reachable as, for the failure message. seen
      (dict[str, set[str]]) - the shared tally, name to thread names.
    Output: a proxy that behaves as the wrapped object.
    Example: _ThreadRecordingProxy(mgr.sessions, 'sessions', {})
    """

    def __init__(self, wrapped: object, name: str, seen: dict) -> None:
        object.__setattr__(self, "_wrapped", wrapped)
        object.__setattr__(self, "_name", name)
        object.__setattr__(self, "_seen", seen)

    def _record(self) -> None:
        """Note the current thread against this container. Output: None."""
        name = object.__getattribute__(self, "_name")
        seen = object.__getattribute__(self, "_seen")
        seen.setdefault(name, set()).add(threading.current_thread().name)

    def __getattr__(self, item):
        self._record()
        return getattr(object.__getattribute__(self, "_wrapped"), item)

    def __getitem__(self, key):
        self._record()
        return object.__getattribute__(self, "_wrapped")[key]

    def __setitem__(self, key, value) -> None:
        self._record()
        object.__getattribute__(self, "_wrapped")[key] = value

    def __contains__(self, key) -> bool:
        self._record()
        return key in object.__getattribute__(self, "_wrapped")

    def __iter__(self):
        self._record()
        return iter(object.__getattribute__(self, "_wrapped"))

    def __len__(self) -> int:
        self._record()
        return len(object.__getattribute__(self, "_wrapped"))


def _run_readers_in_a_thread(manager: SessionManager) -> dict:
    """Drive the REAL reader bundle through a worker and report accesses.

    Description: the manager's live containers are swapped for recording
      proxies, ``_listing_readers()`` is taken AFTER the swap so the
      bound methods close over the proxied manager, and the gather is
      awaited through ``asyncio.to_thread`` exactly as the pass does it.
    Inputs: manager (SessionManager).
    Output: dict[str, set[str]] - container name to the thread names that
      touched it.
    Example: _run_readers_in_a_thread(mgr)['sessions']
    """
    seen: dict = {}
    for name in LIVE_CONTAINERS:
        setattr(
            manager,
            name,
            _ThreadRecordingProxy(getattr(manager, name), name, seen),
        )
    readers = manager._listing_readers()
    snapshot = listing_gather.ListingSnapshot(
        socket=TEST_SOCKET,
        seed_candidate_names=("cloude_a",),
        decorated_names=("cloude_a",),
    )

    async def drive() -> None:
        await asyncio.to_thread(
            listing_gather.gather_listing_inputs, readers, snapshot
        )

    asyncio.run(drive())
    return seen


def test_the_gather_thread_touches_no_live_shared_container():
    """THE TEST THAT STOPS THE AUDIT ROTTING, and it drives the real bundle.

    ``test_the_gather_reaches_nothing_but_its_two_arguments`` drives
    LAMBDAS, so it proves only that ``gather_listing_inputs`` does not
    reach through ``self``. It cannot see a reader BODY growing a
    ``self.sessions`` read, because a bound method carries ``self`` and
    the signature says nothing about what the body does with it. This one
    runs ``_listing_readers()`` itself, in a real worker thread, with
    every live container wrapped, and fails naming the container and the
    thread.

    Any access is a failure, read or write. A dict read off the loop is
    not safe merely because it does not mutate: another thread resizing
    the dict under an iteration raises, and a read-modify-write the hook
    route performs is not atomic just because this half of it is.
    """
    manager = _manager_with([("ses_a", "cloude_a")])
    main_thread = threading.current_thread().name
    seen = _run_readers_in_a_thread(manager)

    off_loop = {
        name: sorted(threads - {main_thread})
        for name, threads in seen.items()
        if threads - {main_thread}
    }
    assert not off_loop, (
        "a listing reader touched live shared state from the gather "
        f"thread: {off_loop}. The loop mutates every one of these from "
        "the hook route, the adopt path and the theme PATCH while the "
        "gather runs. Snapshot the value into ListingSnapshot on the "
        "loop instead of reading it here."
    )


def test_the_tripwire_can_detect_a_reader_that_reads_a_live_container():
    """THE NEGATIVE CONTROL. Without it the tripwire proves nothing.

    A proxy that never records, or a swap that never took, would leave
    the test above passing against a reader bundle that does touch live
    state. So one reader is replaced with a body that reads
    ``self.sessions``, which is precisely the edit the tripwire exists to
    catch, and the same harness must report it.
    """
    manager = _manager_with([("ses_a", "cloude_a")])
    main_thread = threading.current_thread().name

    def reads_live_state(_name):
        # The edit being controlled for: a reader that reaches back into
        # a container the event loop mutates.
        return str(len(manager.sessions))

    manager._label_for_tmux_name = reads_live_state
    seen = _run_readers_in_a_thread(manager)

    assert any(
        threads - {main_thread} for threads in seen.values()
    ), (
        "the harness did not notice a reader reading self.sessions from "
        "the gather thread, so the tripwire beside it is vouching for "
        "nothing"
    )
