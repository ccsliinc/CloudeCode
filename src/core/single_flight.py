"""Coalesce CONCURRENT calls for one answer into ONE underlying pass.

WHY THIS FILE EXISTS. ``GET /sessions/list`` runs
``SessionManager.list_session_infos``, whose body is entirely
SYNCHRONOUS inside ``async def``, so for as long as it runs the server's
event loop does nothing else at all - it cannot read the tmux pipe that
carries terminal output, cannot spawn the ``send-keys`` that delivers a
keystroke, and cannot answer any other request. Measured on the owner's
box 2026-09-10, interleaved A/B against an idle control server in a
separate process sampled at the same instants: the app's ``/health``
read p50 74.8 ms / p99 1262 ms while the control read p50 1.2 ms / p99
30.7 ms, so the stall is the app's own loop and not the machine. The
listing pass itself measured p50 291 ms, and ``/health`` sampled INSIDE
a listing window measured p50 211 ms against 48 ms outside one.

THE MULTIPLIER IS THE THING THIS MODULE REMOVES. The cost of one pass is
already as low as several rounds of work have been able to make it (see
``session_status_map.py``, ``session_instance_index.py``, and the two
cost-ceiling tests that pin them). What nothing had addressed is HOW
MANY passes run: 15 established connections - browsers, the Electron
tray, and python clients - each poll this endpoint every 5 seconds from
BOTH the sidebar and the launchpad, so the measured signature on the
owner's box had a period of about 0.85 s rather than 5 s and the passes
overlapped almost continuously. Fifteen callers were each paying for a
full pass to receive an IDENTICAL answer.

So while a pass is in flight, a caller asking the same question AWAITS
THAT PASS instead of starting its own.

THREE RULES, AND EACH OF THEM IS LOAD BEARING.

**THIS IS NOT A CACHE, AND IT MUST NEVER BECOME ONE.** Nothing here is
keyed on time and nothing is retained after a flight finishes. A caller
arriving one microsecond after a pass completes starts a FRESH pass. A
TTL would be a bigger win and would buy it by serving an answer that was
true a moment ago, which on this endpoint means painting a session alive
after its pane died - this project's single most repeated failure, and
the reason ``StatusMap`` distinguishes "measured absent" from "not
measured" at all. A result is shared only with callers who were already
waiting while it was being produced, and never with one that arrived
after it finished.

THAT IS STILL NOT THE SAME AS "AS FRESH AS YOUR OWN PASS", AND SAYING SO
WOULD BE A LIE THIS FILE CANNOT AFFORD. A joiner receives an answer
measured at the moment the flight STARTED, not at the moment it asked,
so the staleness it accepts is however much of the pass had already
elapsed when it joined - bounded by one whole pass, which measured p50
291 ms on the owner's box and has a worse tail. A caller that arrived
first and ran the pass itself would have had the same 291 ms of age by
the time it got its answer; a caller joining at the last instant gets an
answer a full pass old. Against the 5 second poll this endpoint is
actually driven by that is comfortably within the interval and is why
this trade is taken - but it IS a real bound, it belongs in any decision
about reusing this module for something polled faster, and it is the
ceiling a TTL would raise rather than introduce.

**A FAILURE IS NEVER RETAINED AND NEVER SHARED FORWARD.** An exception
propagates to every caller awaiting THAT flight - they each asked for
work that failed, so each is told - and the flight is then gone. The
next caller starts clean. A poisoned entry would turn one transient
tmux or datastore failure into a permanently broken endpoint.

**ONE CALLER'S CANCELLATION MAY NOT POISON THE OTHERS.** A client
disconnecting mid-request is routine here (a phone locking its screen
does it), and the caller that STARTED the flight is as likely to vanish
as any other. So the work is owned by an independent ``asyncio.Task``
rather than by the coroutine that happened to ask first, and every
caller - the starter included - awaits it through ``asyncio.shield``.
Cancelling a caller then cancels only that caller's own shield wrapper;
the task runs on and the remaining awaiters still get their result.
``asyncio.shield`` was chosen over hanging a list of bare Futures off
the flight because the Future design needs its own fan-out step, its own
exception-copying step, and its own answer to "what if the producer is
cancelled" - three places to get wrong, where the Task already defines
all three.

DELIBERATELY NOT GENERALISED. There is no key space, no per-key map, no
metrics endpoint and no TTL knob, because this has exactly one use and
every one of those is a decision better made by whoever turns out to
need it.
"""
from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Generic, Optional, TypeVar

import structlog

logger = structlog.get_logger()

T = TypeVar("T")

# The attribute a lazily created flight is parked on. Named here so the
# owner object and its reader cannot drift into two spellings.
SESSION_LIST_FLIGHT_ATTR = "_session_list_flight"

# The name that flight reports itself under in the log.
SESSION_LIST_FLIGHT_NAME = "sessions_list"


class _Flight:
    """One in-progress pass, and the count of callers riding on it.

    Description: a plain holder. ``callers`` is exact rather than
      approximate because a caller may only JOIN a task that is not yet
      done (see ``SingleFlight.run``), so once the task completes the
      count can no longer move.
    Inputs: task (asyncio.Task) - the running pass.
    Output: None.
    Example: _Flight(task=asyncio.ensure_future(work()))
    """

    __slots__ = ("task", "callers")

    def __init__(self, task: "asyncio.Task[Any]") -> None:
        self.task = task
        self.callers = 0


class SingleFlight(Generic[T]):
    """Run one pass at a time; concurrent callers await the pass in flight.

    Description: see the module docstring. Not a cache - a caller
      arriving after a pass has completed starts a new one.
    Inputs: name (str) - identifies this flight in log events.
    Output: None.
    Example: flight = SingleFlight('sessions_list')
    """

    def __init__(self, name: str) -> None:
        self._name = name
        self._flight: Optional[_Flight] = None
        # Cumulative, process-lifetime counters. The per-flight log line
        # is emitted at debug; these are what a later reader can total up
        # without turning debug logging on.
        self.passes_started = 0
        self.callers_served = 0
        self.callers_coalesced = 0

    @property
    def in_flight(self) -> bool:
        """Whether a pass is running right now.

        Description: true only while a task exists AND has not finished,
          which is the same condition ``run`` joins on.
        Inputs: none.
        Output: bool.
        Example: flight.in_flight -> False
        """
        return self._flight is not None and not self._flight.task.done()

    async def run(self, work: Callable[[], Awaitable[T]]) -> T:
        """Await the in-flight pass, or start one and await that.

        Description: THE CHECK AND THE ASSIGNMENT BELOW ARE SEPARATED BY
          NO AWAIT, which is the whole reason this needs no lock. asyncio
          runs one coroutine step at a time on one thread, so between
          reading ``self._flight`` and storing a replacement no other
          caller can run and no second task can be created for the same
          question.

          A task that is DONE is never joined, even for the moment
          between its completion and the done callback that clears it -
          joining one would hand a later caller an answer produced before
          it asked, which is the stale read this module refuses to
          perform.
        Inputs: work (Callable[[], Awaitable[T]]) - called with no
          arguments to produce the coroutine for ONE pass. It is invoked
          only when a pass actually starts, so a coalesced caller never
          builds one.
        Output: T - what that pass returned. The SAME object is handed to
          every caller of one flight, so a caller must treat it as
          read-only.
        Raises: whatever the pass raised, to every caller awaiting it.
        Example: infos = await flight.run(manager.list_session_infos)
        """
        flight = self._flight
        if flight is None or flight.task.done():
            flight = _Flight(task=asyncio.ensure_future(work()))
            self._flight = flight
            self.passes_started += 1
            flight.task.add_done_callback(self._retire)
        else:
            self.callers_coalesced += 1
        flight.callers += 1
        self.callers_served += 1
        # SHIELDED, so that cancelling THIS caller cancels this await and
        # not the shared pass. See the module docstring.
        return await asyncio.shield(flight.task)

    def _retire(self, task: "asyncio.Task[Any]") -> None:
        """Drop the finished flight and report what it saved.

        Description: runs as the task's done callback, on the event loop.
          It clears ``self._flight`` ONLY when the finished task is still
          the one parked there - a caller arriving between completion and
          this callback has already started its replacement, and clearing
          then would orphan a live pass.

          It also RETRIEVES a failed task's exception. Every awaiter
          still receives it (retrieving does not consume it), and doing
          so here means a flight whose only caller was cancelled is
          reported by this line rather than by asyncio's generic
          "exception was never retrieved" warning at some later garbage
          collection.
        Inputs: task (asyncio.Task) - the flight that just finished.
        Output: None.
        Example: registered via task.add_done_callback(self._retire)
        """
        flight = self._flight
        if flight is not None and flight.task is task:
            self._flight = None
        callers = flight.callers if flight is not None else 0
        if task.cancelled():
            logger.debug(
                "single_flight_cancelled", flight=self._name, callers=callers
            )
            return
        error = task.exception()
        if error is not None:
            logger.debug(
                "single_flight_failed",
                flight=self._name,
                callers=callers,
                error=str(error),
                error_type=type(error).__name__,
            )
            return
        if callers > 1:
            logger.debug(
                "single_flight_coalesced",
                flight=self._name,
                callers=callers,
                passes_saved=callers - 1,
            )


def flight_on(owner: Any, attr: str, name: str) -> SingleFlight[Any]:
    """The SingleFlight parked on ``owner``, created on first use.

    Description: the flight has to live as long as the thing it
      serialises access to, and the SessionManager is that thing - one
      per running app, replaced only when the app is. Parking it there
      keeps the endpoint that uses it to two lines and keeps a
      module-level global (which two managers in one test process would
      have to share) out of it.
    Inputs: owner (Any) - the object to hang it on, typically the
      SessionManager. attr (str) - the attribute name; pass the module
      constant, never a literal. name (str) - the flight's log name, used
      only on creation.
    Output: SingleFlight[Any] - the same instance for the same owner.
    Example: flight_on(mgr, SESSION_LIST_FLIGHT_ATTR, SESSION_LIST_FLIGHT_NAME)
    """
    existing = getattr(owner, attr, None)
    if isinstance(existing, SingleFlight):
        return existing
    created: SingleFlight[Any] = SingleFlight(name)
    setattr(owner, attr, created)
    return created
