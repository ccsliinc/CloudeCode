"""Tests for coalescing concurrent listing passes into one.

Four properties, and each one carries a NEGATIVE CONTROL that reproduces
the WRONG implementation inline and proves this harness would catch it:

1.  N concurrent callers cost ONE underlying pass, and all N get it.
2.  A caller arriving AFTER a pass completes gets a FRESH pass. This is
    the anti-staleness control. Serving a remembered list would paint a
    session alive after its pane died, which is the failure this whole
    project keeps paying to remove, so the freshness test is the one
    that matters most here.
3.  A failure reaches every caller awaiting THAT pass and leaves nothing
    behind, so the next caller starts clean.
4.  Cancelling the caller that STARTED the pass still delivers the
    result to the remaining awaiters.

STRUCTURAL, NEVER TIMED. Nothing here asserts on a wall clock or a
threshold. Every wait is a real asyncio primitive that either happens or
does not, so a loaded box can make these tests slow and cannot make them
wrong. Same discipline as tests/test_config_files_shallow.py.

Run with:
    venv/bin/python3 -m pytest tests/test_single_flight.py -v
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_sf_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_sf_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.single_flight import (  # noqa: E402
    SESSION_LIST_FLIGHT_ATTR,
    SESSION_LIST_FLIGHT_NAME,
    SingleFlight,
    flight_on,
)

# How many callers stand in for the fifteen real pollers. Small enough to
# read in a failure message, more than two so "coalesced" cannot be
# satisfied by accident.
CALLERS = 5

# A bound on the number of event-loop turns a test will spend waiting for
# every caller to reach its await. It is a turn count, NOT a duration, so
# it cannot flake under load.
MAX_TURNS = 100


class _Pass:
    """A stand-in listing pass: counts its runs, parks until released.

    Description: the counter is the whole measurement. It is incremented
      on ENTRY, so a second pass that starts and blocks is still counted
      - a coalescer that started a redundant pass could not hide behind
      the redundant pass not having finished.
    Inputs: none.
    Output: None.
    Example: work = _Pass(); await work()
    """

    def __init__(self) -> None:
        self.runs = 0
        self.gate = asyncio.Event()
        self.fail_with: BaseException | None = None

    async def __call__(self) -> list:
        self.runs += 1
        mine = self.runs
        await self.gate.wait()
        if self.fail_with is not None:
            raise self.fail_with
        # A DIFFERENT VALUE PER PASS, so a test can tell a fresh answer
        # from a remembered one by its content alone.
        return ["pass", mine]


async def _settle(turns: int = MAX_TURNS) -> None:
    """Give every already-scheduled coroutine a chance to run.

    Description: ``asyncio.sleep(0)`` yields to the loop's ready queue
      without consulting a clock, so this is a number of TURNS and never
      a duration. Used to let a batch of just-created caller tasks reach
      their await before the test acts.
    Inputs: turns (int) - how many yields to spend.
    Output: None.
    Example: await _settle()
    """
    for _ in range(turns):
        await asyncio.sleep(0)


# ---- 1. concurrent callers cost one pass -------------------------------

def test_concurrent_callers_share_one_pass():
    """N callers arriving during one pass run the work exactly ONCE."""

    async def scenario():
        work = _Pass()
        flight: SingleFlight[Any] = SingleFlight("test")
        callers = [
            asyncio.create_task(flight.run(work)) for _ in range(CALLERS)
        ]
        await _settle()
        assert work.runs == 1, (
            f"{work.runs} passes started while only one was needed"
        )
        work.gate.set()
        results = await asyncio.gather(*callers)
        return work, flight, results

    work, flight, results = asyncio.run(scenario())
    assert work.runs == 1, f"{CALLERS} callers cost {work.runs} passes"
    assert all(r == ["pass", 1] for r in results), results
    assert flight.passes_started == 1
    assert flight.callers_served == CALLERS
    assert flight.callers_coalesced == CALLERS - 1
    assert not flight.in_flight


def test_the_harness_detects_an_implementation_that_does_not_coalesce():
    """NEGATIVE CONTROL for the test above.

    Reproduces the pre-fix rule inline - every caller runs its own pass -
    and asserts this harness sees all N of them. Without this, a harness
    that could never observe a redundant pass would pass against the
    unfixed code and prove nothing.
    """

    class _NoCoalescing:
        async def run(self, work: Callable[[], Awaitable[Any]]) -> Any:
            return await work()

    async def scenario():
        work = _Pass()
        flight = _NoCoalescing()
        callers = [
            asyncio.create_task(flight.run(work)) for _ in range(CALLERS)
        ]
        await _settle()
        runs_during = work.runs
        work.gate.set()
        await asyncio.gather(*callers)
        return runs_during

    assert asyncio.run(scenario()) == CALLERS, (
        "the harness did not see redundant passes, so the coalescing test "
        "above is worthless"
    )


# ---- 2. freshness: no caching, ever ------------------------------------

def test_a_caller_arriving_after_a_pass_gets_a_fresh_one():
    """THE ANTI-STALENESS CONTROL, and it is the mandatory one.

    Two callers in sequence must cost two passes. A TTL cache would fail
    this, which is the point: a remembered list paints a session alive
    after its pane died.

    This covers the RETIRE half of the rule - the finished flight being
    dropped. The other half, refusing to join a task that is done but
    not yet retired, cannot be reached through the public API and has
    its own test below.
    """

    async def scenario():
        work = _Pass()
        work.gate.set()
        flight: SingleFlight[Any] = SingleFlight("test")
        first = await flight.run(work)
        second = await flight.run(work)
        return work, flight, first, second

    work, flight, first, second = asyncio.run(scenario())
    assert work.runs == 2, "the second caller was served a remembered answer"
    assert first == ["pass", 1]
    assert second == ["pass", 2]
    assert flight.passes_started == 2
    assert flight.callers_coalesced == 0
    assert not flight.in_flight


def test_a_finished_flight_is_never_joined_even_before_it_is_retired():
    """The ordering-independent half of the freshness rule.

    MEASURED rather than assumed: the retire callback is registered
    before any awaiter's own, so on CPython today it always runs first
    and the slot is already empty by the time a caller returns. That
    makes the ``.done()`` check in ``run`` unreachable through the
    public API - and it is kept anyway, because callback ordering is an
    implementation detail and freshness is a correctness claim. The only
    way to exercise it is to build the state it defends against: a
    finished task still parked on the slot.

    ``_Flight`` is private and imported here deliberately. This test is
    an assertion about an internal invariant, and there is no honest way
    to make it from the outside.
    """
    from src.core.single_flight import _Flight

    async def scenario():
        work = _Pass()
        work.gate.set()
        flight: SingleFlight[Any] = SingleFlight("test")
        stale = asyncio.ensure_future(work())
        await stale
        # The state the guard exists for: done, and still parked.
        flight._flight = _Flight(task=stale)
        fresh = await flight.run(work)
        return work.runs, fresh

    runs, fresh = asyncio.run(scenario())
    assert runs == 2, "a finished flight was joined instead of replaced"
    assert fresh == ["pass", 2]


def test_the_harness_detects_a_cache():
    """NEGATIVE CONTROL for the freshness test above.

    Reproduces the tempting wrong implementation - join the stored task
    whether or not it has finished - and asserts this harness sees the
    stale answer. A TTL cache would fail the same way and is forbidden
    for the same reason.
    """

    class _Caching:
        def __init__(self) -> None:
            self.task: asyncio.Task | None = None

        async def run(self, work: Callable[[], Awaitable[Any]]) -> Any:
            if self.task is None:
                self.task = asyncio.ensure_future(work())
            return await asyncio.shield(self.task)

    async def scenario():
        work = _Pass()
        work.gate.set()
        flight = _Caching()
        first = await flight.run(work)
        second = await flight.run(work)
        return work.runs, first, second

    runs, first, second = asyncio.run(scenario())
    assert runs == 1 and first == second, (
        "the harness could not tell a remembered answer from a fresh one, so "
        "the freshness test above is worthless"
    )


# ---- 3. a failure reaches everyone and is never retained ---------------

def test_a_failure_reaches_every_awaiter_and_clears_the_flight():
    """All current awaiters raise; the NEXT caller starts clean."""

    async def scenario():
        work = _Pass()
        work.fail_with = ValueError("the pass failed")
        flight: SingleFlight[Any] = SingleFlight("test")
        callers = [
            asyncio.create_task(flight.run(work)) for _ in range(CALLERS)
        ]
        await _settle()
        work.gate.set()
        raised = await asyncio.gather(*callers, return_exceptions=True)
        # The flight must be gone, and the next caller must get a real,
        # freshly computed answer rather than the stale exception.
        work.fail_with = None
        after = await flight.run(work)
        return work, flight, raised, after

    work, flight, raised, after = asyncio.run(scenario())
    assert len(raised) == CALLERS
    assert all(isinstance(r, ValueError) for r in raised), raised
    assert all(str(r) == "the pass failed" for r in raised)
    assert work.runs == 2, "the failed pass was re-used instead of re-run"
    assert after == ["pass", 2]
    assert not flight.in_flight


def test_the_harness_detects_a_poisoned_flight():
    """NEGATIVE CONTROL for the failure test above.

    Reproduces a flight that is not cleared when it fails, and asserts
    this harness sees the next caller being handed the stale exception
    instead of a fresh pass.
    """

    class _Poisoned:
        def __init__(self) -> None:
            self.task: asyncio.Task | None = None

        async def run(self, work: Callable[[], Awaitable[Any]]) -> Any:
            if self.task is None:
                self.task = asyncio.ensure_future(work())
            return await asyncio.shield(self.task)

    async def scenario():
        work = _Pass()
        work.fail_with = ValueError("the pass failed")
        work.gate.set()
        flight = _Poisoned()
        with pytest.raises(ValueError):
            await flight.run(work)
        work.fail_with = None
        with pytest.raises(ValueError):
            await flight.run(work)
        return work.runs

    assert asyncio.run(scenario()) == 1, (
        "the harness did not notice a retained failure, so the failure test "
        "above is worthless"
    )


# ---- 4. one caller's cancellation may not poison the others ------------

def test_cancelling_the_starter_still_delivers_to_the_others():
    """The pass belongs to the flight, not to whoever asked first."""

    async def scenario():
        work = _Pass()
        flight: SingleFlight[Any] = SingleFlight("test")
        starter = asyncio.create_task(flight.run(work))
        await _settle()
        others = [
            asyncio.create_task(flight.run(work))
            for _ in range(CALLERS - 1)
        ]
        await _settle()
        assert work.runs == 1
        starter.cancel()
        await _settle()
        work.gate.set()
        results = await asyncio.gather(*others)
        return work, starter, results

    work, starter, results = asyncio.run(scenario())
    assert starter.cancelled(), "the starter was supposed to be cancelled"
    assert work.runs == 1
    assert all(r == ["pass", 1] for r in results), results


def test_the_harness_detects_an_unshielded_await():
    """NEGATIVE CONTROL for the cancellation test above.

    Awaiting the shared task WITHOUT ``asyncio.shield`` is the obvious
    implementation and it is the broken one: cancelling an awaiting task
    cancels the future it is waiting on, which here IS the shared pass.
    This asserts the harness sees the other callers being cancelled with
    it, so the test above is proving something real.
    """

    class _Unshielded:
        def __init__(self) -> None:
            self.task: asyncio.Task | None = None

        async def run(self, work: Callable[[], Awaitable[Any]]) -> Any:
            if self.task is None or self.task.done():
                self.task = asyncio.ensure_future(work())
            return await self.task

    async def scenario():
        work = _Pass()
        flight = _Unshielded()
        starter = asyncio.create_task(flight.run(work))
        await _settle()
        others = [
            asyncio.create_task(flight.run(work))
            for _ in range(CALLERS - 1)
        ]
        await _settle()
        starter.cancel()
        await _settle()
        work.gate.set()
        return await asyncio.gather(*others, return_exceptions=True)

    outcomes = asyncio.run(scenario())
    assert any(isinstance(o, asyncio.CancelledError) for o in outcomes), (
        "cancelling one caller did not disturb the others even without a "
        "shield, so the cancellation test above is worthless"
    )


def test_every_caller_cancelling_leaves_nothing_behind():
    """The orphaned pass finishes, is retired, and breaks nothing.

    A phone locking its screen cancels its request, and it can be the
    only caller. The pass cannot be un-started, so it runs to completion
    and its answer is discarded - which is correct, because keeping it
    would be the cache this module refuses to be.
    """

    async def scenario():
        work = _Pass()
        flight: SingleFlight[Any] = SingleFlight("test")
        callers = [
            asyncio.create_task(flight.run(work)) for _ in range(CALLERS)
        ]
        await _settle()
        for caller in callers:
            caller.cancel()
        await _settle()
        work.gate.set()
        await _settle()
        outcomes = await asyncio.gather(*callers, return_exceptions=True)
        # A fresh caller after the orphan is served normally.
        fresh = await flight.run(work)
        return work, flight, outcomes, fresh

    work, flight, outcomes, fresh = asyncio.run(scenario())
    assert all(isinstance(o, asyncio.CancelledError) for o in outcomes)
    assert work.runs == 2
    assert fresh == ["pass", 2]
    assert not flight.in_flight


# ---- the endpoint is actually wired to it ------------------------------

def test_the_sessions_list_endpoint_coalesces():
    """The route, not just the primitive. Same measurement, real handler."""
    from src.api import routes

    class _FakeState:
        pass

    class _FakeApp:
        def __init__(self, manager: Any) -> None:
            self.state = _FakeState()
            self.state.session_manager = manager

    class _FakeRequest:
        def __init__(self, manager: Any) -> None:
            self.app = _FakeApp(manager)

    class _FakeManager:
        def __init__(self, work: _Pass) -> None:
            self._work = work

        async def list_session_infos(self) -> list:
            return await self._work()

    async def scenario():
        work = _Pass()
        manager = _FakeManager(work)
        request = _FakeRequest(manager)
        callers = [
            asyncio.create_task(routes.list_sessions(request))
            for _ in range(CALLERS)
        ]
        await _settle()
        during = work.runs
        work.gate.set()
        results = await asyncio.gather(*callers)
        # And the flight really was parked on the manager, under the one
        # constant both sides read.
        parked = getattr(manager, SESSION_LIST_FLIGHT_ATTR, None)
        return during, work.runs, results, parked

    during, runs, results, parked = asyncio.run(scenario())
    assert during == 1, f"the endpoint started {during} concurrent passes"
    assert runs == 1
    assert all(r == ["pass", 1] for r in results)
    assert isinstance(parked, SingleFlight)


def test_flight_on_returns_the_same_instance_per_owner():
    """One owner, one flight; two owners, two flights."""

    class _Owner:
        pass

    first_owner = _Owner()
    second_owner = _Owner()
    a = flight_on(first_owner, SESSION_LIST_FLIGHT_ATTR, SESSION_LIST_FLIGHT_NAME)
    b = flight_on(first_owner, SESSION_LIST_FLIGHT_ATTR, SESSION_LIST_FLIGHT_NAME)
    c = flight_on(second_owner, SESSION_LIST_FLIGHT_ATTR, SESSION_LIST_FLIGHT_NAME)
    assert a is b
    assert a is not c
