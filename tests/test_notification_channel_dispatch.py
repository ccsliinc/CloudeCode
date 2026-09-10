"""One queue entry now contacts every external channel at once.

The two LOAD-BEARING tests here are the failure test and the hang test,
and both are written to be immune to how loaded this machine is:

* the concurrency proof does not time anything. The slow channel waits on
  an ``asyncio.Event`` that only the FAST channel's completion sets, so
  the test can only pass if the two really did overlap. A wall clock
  would either flake under load or be too loose to prove anything.
* the hang test asserts the hung coroutine was actually CANCELLED, not
  merely that we stopped waiting on it. A bound that stopped waiting and
  left the task running would leak one task per event and pass a test
  that only checked the return value.

A missed "your turn" is a worse failure than a spurious one, so every
test below asks whether a HEALTHY channel still delivered, not only
whether the broken one was handled.
"""

from __future__ import annotations

import asyncio

import pytest

from src.core.notifications import channel_dispatch
from src.core.notifications.channel_dispatch import (
    CHANNEL_TIMEOUT_SECONDS,
    OUTCOME_ERROR,
    OUTCOME_SENT,
    OUTCOME_TIMEOUT,
    ChannelResult,
    build_channel_calls,
    dispatch_channels,
)
from src.core.notifications.events import EventType, NotificationEvent
from src.core.notifications.router import NotificationRouter


def _event(kind: EventType = EventType.CLAUDE_STOP) -> NotificationEvent:
    """Build a minimal unstamped event.

    Inputs: kind (EventType).
    Output: NotificationEvent - no policy stamp, so the mute gate allows
        it and these tests observe dispatch rather than the gate.
    """
    return NotificationEvent(kind=kind, session_slug="ses_dispatch", timestamp=0.0)


class _RouterConfig:
    """A notifications config with the router's emit gate satisfied."""

    enabled = True
    ntfy_topic = "test-topic"
    ntfy_base_url = "https://example.invalid"
    slack_webhook_url = ""
    pushover_token = ""
    pushover_user_key = ""
    public_base_url = ""
    rate_limit_global_cap = 1000
    rate_limit_window_seconds = 60.0
    rate_limit_per_kind_cooldown_seconds = 0.0


def _outcome(results, channel: str) -> str:
    """Pull one channel's outcome out of a result list.

    Inputs: results (list[ChannelResult]), channel (str).
    Output: str - the outcome word.
    """
    for r in results:
        if r.channel == channel:
            return r.outcome
    raise AssertionError(f"no result for channel {channel!r} in {results!r}")


# =========================================================================== #
# 1. A failing channel does not stop a healthy one                            #
# =========================================================================== #


@pytest.mark.asyncio
async def test_a_raising_channel_does_not_stop_a_healthy_one():
    """The whole point. One channel blowing up must not cancel its siblings.

    An unhandled exception inside an ``asyncio.gather`` cancels every
    other coroutine in it, which would turn one channel's defect into a
    notification nobody received on any channel.
    """
    delivered: list[str] = []

    async def boom() -> None:
        raise RuntimeError("channel exploded")

    async def healthy() -> None:
        delivered.append("healthy")

    results = await dispatch_channels(
        _event(),
        calls=[("broken", boom), ("healthy", healthy)],
    )

    assert delivered == ["healthy"]
    assert _outcome(results, "broken") == OUTCOME_ERROR
    assert _outcome(results, "healthy") == OUTCOME_SENT


@pytest.mark.asyncio
async def test_a_failing_channel_is_reported_by_name_not_collapsed():
    """Three failures must read as three facts, each naming its channel.

    A blanket catch that logged one opaque line would make a Slack
    webhook rotation indistinguishable from Pushover being down.
    """

    async def bad_a() -> None:
        raise ValueError("a failed")

    async def bad_b() -> None:
        raise KeyError("b failed")

    results = await dispatch_channels(
        _event(), calls=[("a", bad_a), ("b", bad_b)]
    )

    assert [r.channel for r in results] == ["a", "b"]
    assert all(r.outcome == OUTCOME_ERROR for r in results)
    assert "a failed" in results[0].error
    assert "b failed" in results[1].error


@pytest.mark.asyncio
async def test_a_failure_does_not_re_send_to_the_channel_that_succeeded():
    """No retry exists, and a partial failure must not invent one."""
    calls = {"healthy": 0}

    async def boom() -> None:
        raise RuntimeError("nope")

    async def healthy() -> None:
        calls["healthy"] += 1

    await dispatch_channels(_event(), calls=[("broken", boom), ("healthy", healthy)])

    assert calls["healthy"] == 1


# =========================================================================== #
# 2. A hanging channel is bounded, and is actually torn down                  #
# =========================================================================== #


@pytest.mark.asyncio
async def test_a_hanging_channel_is_bounded_and_cancelled():
    """The bound is the point, and so is the cancellation behind it.

    Stopping waiting is not the same as stopping. A timeout that left the
    hung coroutine running would leak one task per event forever while
    looking, from the return value, exactly like this test passing.
    """
    state = {"cancelled": False}

    async def hangs_forever() -> None:
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise

    async def healthy() -> None:
        return None

    results = await dispatch_channels(
        _event(),
        timeout_s=0.05,
        calls=[("wedged", hangs_forever), ("healthy", healthy)],
    )

    assert _outcome(results, "wedged") == OUTCOME_TIMEOUT
    assert _outcome(results, "healthy") == OUTCOME_SENT
    assert state["cancelled"] is True


@pytest.mark.asyncio
async def test_a_hanging_channel_does_not_hold_the_queue_entry_open():
    """The router marks the entry done rather than wedging on one channel.

    Held open, the entry blocks every notification behind it in a queue
    that drops the OLDEST on overflow, which is how a slow channel turns
    into notifications that are never sent at all.
    """
    router = NotificationRouter(_RouterConfig(), loop=asyncio.get_running_loop())
    router._channel_timeout_s = 0.05

    async def hangs_forever(*_args, **_kwargs) -> None:
        await asyncio.sleep(3600)

    original = channel_dispatch.build_channel_calls
    try:
        channel_dispatch.build_channel_calls = lambda event, public_base_url="": [
            ("wedged", lambda: hangs_forever())
        ]
        await router.start()
        router.emit(_event())
        await asyncio.wait_for(router._queue.join(), timeout=5.0)
    finally:
        channel_dispatch.build_channel_calls = original
        await router.stop()


# =========================================================================== #
# 3. They really are concurrent, proven without a clock                       #
# =========================================================================== #


@pytest.mark.asyncio
async def test_the_fast_channel_completes_without_waiting_for_the_slow_one():
    """Serially, this test cannot finish: the gate is set by the fast one.

    ``slow`` waits on an event that only ``fast`` sets. Run one after the
    other in the old order, ``slow`` would wait forever and this would
    time out. That is a stronger proof than any elapsed-time assertion
    and it does not care how loaded the box is.
    """
    fast_done = asyncio.Event()
    order: list[str] = []

    async def slow() -> None:
        await asyncio.wait_for(fast_done.wait(), timeout=5.0)
        order.append("slow")

    async def fast() -> None:
        order.append("fast")
        fast_done.set()

    results = await dispatch_channels(_event(), calls=[("slow", slow), ("fast", fast)])

    assert order == ["fast", "slow"]
    assert all(r.outcome == OUTCOME_SENT for r in results)


# =========================================================================== #
# 4. A permission request still gets out, unconditionally                     #
# =========================================================================== #


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [EventType.CLAUDE_PERMISSION_REQUEST, EventType.PERMISSION_PROMPT],
)
async def test_a_permission_request_still_reaches_every_healthy_channel(kind):
    """The negative control this whole area turns on.

    A permission request is a HARD BLOCK - the agent has stopped
    mid-turn and cannot continue until a human answers - so no
    concurrency, failure or timeout rule may quietly drop it. Here the
    other two channels are broken and it still lands on the one that
    works.
    """
    landed: list[str] = []

    async def boom() -> None:
        raise RuntimeError("down")

    async def hangs() -> None:
        await asyncio.sleep(3600)

    async def healthy() -> None:
        landed.append(kind.value)

    results = await dispatch_channels(
        _event(kind),
        timeout_s=0.05,
        calls=[("broken", boom), ("wedged", hangs), ("healthy", healthy)],
    )

    assert landed == [kind.value]
    assert _outcome(results, "healthy") == OUTCOME_SENT


# =========================================================================== #
# 5. The queue, the rate limit and the channel set are unchanged              #
# =========================================================================== #


@pytest.mark.asyncio
async def test_the_rate_limit_still_holds_under_concurrent_dispatch():
    """Concurrency is inside one entry. The limiter runs above it, once."""

    class _Capped(_RouterConfig):
        rate_limit_global_cap = 2
        rate_limit_window_seconds = 600.0
        rate_limit_per_kind_cooldown_seconds = 0.0

    router = NotificationRouter(_Capped(), loop=asyncio.get_running_loop())
    dispatched: list[str] = []

    async def healthy() -> None:
        dispatched.append("x")

    original = channel_dispatch.build_channel_calls
    try:
        channel_dispatch.build_channel_calls = lambda event, public_base_url="": [
            ("healthy", healthy)
        ]
        await router.start()
        # seed_cold_start primes the per-kind cooldown; clear it so this
        # test measures the GLOBAL cap and not the cooldown beside it.
        router.rate_limiter._last_by_kind.clear()
        for _ in range(6):
            router.emit(_event())
        await asyncio.wait_for(router._queue.join(), timeout=5.0)
    finally:
        channel_dispatch.build_channel_calls = original
        await router.stop()

    assert len(dispatched) == 2


@pytest.mark.asyncio
async def test_the_queue_is_still_drained_one_entry_at_a_time_in_order():
    """Concurrency is WITHIN an entry. Entries stay sequential and ordered."""
    router = NotificationRouter(_RouterConfig(), loop=asyncio.get_running_loop())
    seen: list[str] = []
    overlap = {"in_flight": 0, "max_in_flight": 0}

    def _calls(event, public_base_url=""):
        async def one() -> None:
            overlap["in_flight"] += 1
            overlap["max_in_flight"] = max(
                overlap["max_in_flight"], overlap["in_flight"]
            )
            await asyncio.sleep(0)
            seen.append(event.session_slug)
            overlap["in_flight"] -= 1

        return [("healthy", one)]

    original = channel_dispatch.build_channel_calls
    try:
        channel_dispatch.build_channel_calls = _calls
        await router.start()
        for i in range(5):
            e = _event()
            e.session_slug = f"ses-{i}"
            router.emit(e)
        await asyncio.wait_for(router._queue.join(), timeout=5.0)
    finally:
        channel_dispatch.build_channel_calls = original
        await router.stop()

    assert seen == [f"ses-{i}" for i in range(5)]
    assert overlap["max_in_flight"] == 1


def test_the_real_channel_set_is_still_the_same_three_in_the_same_order():
    """A refactor that quietly dropped a channel would be invisible."""
    calls = build_channel_calls(_event(), public_base_url="http://lan:8000")
    assert [name for name, _ in calls] == ["ntfy", "slack", "pushover"]


def test_the_default_bound_is_derived_from_the_channels_own_budget():
    """15s is connect + write + read at the channels' own 5s httpx budget.

    Pinned so a future edit that shortens it has to say out loud that it
    is now abandoning sends that would have landed, which is a policy
    decision and not a tuning one.
    """
    assert CHANNEL_TIMEOUT_SECONDS == 15.0


@pytest.mark.asyncio
async def test_a_wrapper_that_broke_is_reported_as_that_channels_failure():
    """``return_exceptions=True`` is belt and braces over the per-channel catch.

    If ``_dispatch_one`` itself ever raised, the gather would otherwise
    cancel the siblings. Here the result is converted to that channel's
    error and the healthy channel is untouched.
    """
    delivered: list[str] = []

    async def healthy() -> None:
        delivered.append("healthy")

    async def exploding_wrapper(name, factory, timeout_s, event):
        if name == "broken":
            raise RuntimeError("wrapper defect")
        return ChannelResult(channel=name, outcome=OUTCOME_SENT)

    original = channel_dispatch._dispatch_one
    try:
        channel_dispatch._dispatch_one = exploding_wrapper
        results = await dispatch_channels(
            _event(), calls=[("broken", healthy), ("healthy", healthy)]
        )
    finally:
        channel_dispatch._dispatch_one = original

    assert _outcome(results, "broken") == OUTCOME_ERROR
    assert _outcome(results, "healthy") == OUTCOME_SENT


@pytest.mark.asyncio
async def test_stopping_the_router_mid_dispatch_still_ends_the_worker():
    """Cancellation must reach through the gather, or ``stop()`` hangs.

    ``CancelledError`` is a BaseException, so the per-channel catch does
    not see it and the gather propagates it to the worker.
    """
    router = NotificationRouter(_RouterConfig(), loop=asyncio.get_running_loop())
    entered = asyncio.Event()

    async def hangs() -> None:
        entered.set()
        await asyncio.sleep(3600)

    original = channel_dispatch.build_channel_calls
    try:
        channel_dispatch.build_channel_calls = lambda event, public_base_url="": [
            ("wedged", lambda: hangs())
        ]
        await router.start()
        router.emit(_event())
        await asyncio.wait_for(entered.wait(), timeout=5.0)
        await asyncio.wait_for(router.stop(), timeout=5.0)
    finally:
        channel_dispatch.build_channel_calls = original

    assert router._worker_task is None
