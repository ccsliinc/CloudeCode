"""Fan one queued notification out to every external channel at once.

WHY THIS EXISTS. The router drained a queue entry by awaiting ntfy, then
slack, then pushover, one after the other. Each channel builds its httpx
client with ``httpx.Timeout(5.0, connect=5.0)``, which bounds every PHASE
of a request at 5s and the request as a whole at nothing, so a peer that
accepts the connection and never answers costs 5s of read timeout per
channel and the three of them cost that three times over. Measured
against a local blackhole, one queue entry with all three channels
configured took 15.1s serially and 5.1s concurrently.

WHAT THAT COST IS, STATED ACCURATELY. It is NOT stolen keystroke latency.
The worker is its own task and every one of those awaits yields the event
loop, so unlike the listing pass in CLAUDE.md this was never blocking the
terminal stream. What it is, is HEAD-OF-LINE BLOCKING in a BOUNDED queue:
every entry behind the slow one waits the full serial cost, and the queue
drops the OLDEST on overflow. A slow channel therefore converts, at 100
queued events, into notifications that are never sent at all. A missed
"your turn" is a worse failure than a spurious one, which is why this is
worth fixing and why every rule below fails toward sending.

THE QUEUE STAYS SEQUENTIAL. Concurrency is WITHIN one entry only. Entries
are still drained one at a time, in order, which is what preserves the
rate limit and the ordering guarantee the router already makes. The mute
gate and its generation check run ABOVE this module, once per entry,
before any channel is contacted.

ORDERING BETWEEN CHANNELS IS DELIBERATELY GIVEN UP, and the old docstring
claimed it as a feature: ntfy went first "so a slow Slack request never
delays the snappier ntfy push". Concurrency delivers that guarantee
properly instead of by queueing behind it, and nothing downstream ever
depended on ntfy landing before pushover. The RESULT list is still in a
fixed order because ``asyncio.gather`` preserves argument order; only the
order the network sees is now unspecified.

THERE IS NO RETRY IN THIS PATH AND THIS MODULE DOES NOT ADD ONE. Each
channel is called exactly once per entry and its outcome is recorded, so
a partial failure cannot re-send to a channel that already succeeded.
That property is a consequence of there being nothing to retry with, not
of a check, so anything that later adds a retry has to key it on the
per-channel results this returns rather than on the entry as a whole.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Awaitable, Callable, List, Optional, Sequence, Tuple

import structlog

from src.core.notifications import ntfy, pushover, slack
from src.core.notifications.events import NotificationEvent

logger = structlog.get_logger()


# The per-channel bound, DERIVED rather than invented. Every channel
# constructs ``httpx.Timeout(5.0, connect=5.0)``, so connect plus write
# plus read is the longest a channel behaving inside its own configured
# budget can legitimately take. Setting the bound there means this
# timeout NEVER fires on a send that was going to succeed, and only ever
# catches a stall httpx's own phase timeouts cannot see: connection-pool
# exhaustion, a redirect chain, a channel that stops using httpx.
#
# It is a BACKSTOP, not a policy about when to give up on a notification.
# Picking a shorter number is a real policy decision - it would start
# abandoning sends that would have landed - and belongs to the owner, so
# it is raised rather than taken here. The router reads it through
# ``getattr`` so a config field can be added later without touching this.
CHANNEL_TIMEOUT_SECONDS = 15.0

# What one channel did with one event. Three words, and the middle one is
# not a kind of error: a timeout means we stopped waiting, which is a
# different fact from the channel telling us it failed.
OUTCOME_SENT = "sent"
OUTCOME_TIMEOUT = "timeout"
OUTCOME_ERROR = "error"


@dataclass(frozen=True)
class ChannelResult:
    """The outcome of one channel's attempt at one event.

    Attributes:
        channel: the channel name, e.g. ``"ntfy"``.
        outcome: one of ``OUTCOME_SENT`` / ``OUTCOME_TIMEOUT`` /
            ``OUTCOME_ERROR``.
        error: the exception text when ``outcome`` is ``OUTCOME_ERROR``,
            empty otherwise. Never a matched secret - the channel modules
            log their own request detail and this carries only the
            exception's own message.
    """

    channel: str
    outcome: str
    error: str = ""


# A channel is a name plus a zero-argument factory that returns the
# coroutine to await. It is a FACTORY, not a coroutine, for two reasons:
# an un-awaited coroutine warns if the caller decides not to run it, and
# building it late is what keeps ``ntfy.send`` resolved through the module
# object, so the existing tests that patch the module attribute still see
# their double.
ChannelCall = Tuple[str, Callable[[], Awaitable[None]]]


def build_channel_calls(
    event: NotificationEvent, public_base_url: str = ""
) -> List[ChannelCall]:
    """Name the external channels this event goes to, in a fixed order.

    Description: all three are always listed, exactly as the serial
        router always called all three. Each channel's own ``send``
        already short-circuits when that channel is not configured, and
        that is the ONE place the "is this channel enabled" question is
        answered; asking it a second time here would be a second copy of
        a rule that has already changed once, and a copy that disagreed
        would silently stop a configured channel sending.
    Inputs: event (NotificationEvent) - the event to deliver.
        public_base_url (str) - the deep-link base, passed to the two
        channels that build a click target from it.
    Output: list[ChannelCall] - (name, factory) pairs. Order is fixed so
        the returned results are stable to read and to assert on; it is
        NOT the order the network is contacted in.
    Example: build_channel_calls(event, "http://mac.lan:8000")
    """
    return [
        ("ntfy", lambda: ntfy.send(event, public_base_url=public_base_url)),
        ("slack", lambda: slack.send(event)),
        (
            "pushover",
            lambda: pushover.send(event, public_base_url=public_base_url),
        ),
    ]


async def _dispatch_one(
    name: str,
    factory: Callable[[], Awaitable[None]],
    timeout_s: float,
    event: NotificationEvent,
) -> ChannelResult:
    """Await one channel under a bound, and report what happened.

    Description: this NEVER raises for a channel-level problem, which is
        what makes the gather above it unable to cancel a channel's
        siblings. It does let ``asyncio.CancelledError`` through
        untouched, because that is the router shutting the worker down
        and swallowing it would leave ``stop()`` hanging on a task that
        refuses to end.
    Inputs: name (str) - channel name, used as structlog context.
        factory (Callable[[], Awaitable[None]]) - builds the coroutine.
        timeout_s (float) - the per-channel bound in seconds.
        event (NotificationEvent) - carried for log context only.
    Output: ChannelResult.
    Example: await _dispatch_one("ntfy", f, 15.0, event)
    """
    try:
        # wait_for CANCELS the coroutine when the bound expires, so a
        # hung channel is actually torn down rather than left running
        # while we stop waiting on it. That is the bound: without the
        # cancellation, one wedged send would leak a task per event.
        await asyncio.wait_for(factory(), timeout=timeout_s)
    except asyncio.TimeoutError:
        logger.warning(
            "notifications.channel_timeout",
            channel=name,
            kind=event.kind.value,
            session_slug=event.session_slug,
            timeout_seconds=timeout_s,
        )
        return ChannelResult(channel=name, outcome=OUTCOME_TIMEOUT)
    except Exception as e:
        # DELIBERATELY BROAD, AND IT DOES NOT SWALLOW: it logs with the
        # channel name and the failure's own type before returning it as
        # a result the caller reports. A channel module may raise
        # anything, and the whole point of this function is that one
        # channel's defect cannot take the other two down with it.
        # CancelledError is a BaseException and so is not caught here.
        logger.warning(
            "notifications.channel_error",
            channel=name,
            kind=event.kind.value,
            session_slug=event.session_slug,
            error=str(e),
            error_type=type(e).__name__,
        )
        return ChannelResult(channel=name, outcome=OUTCOME_ERROR, error=str(e))
    return ChannelResult(channel=name, outcome=OUTCOME_SENT)


async def dispatch_channels(
    event: NotificationEvent,
    public_base_url: str = "",
    timeout_s: float = CHANNEL_TIMEOUT_SECONDS,
    calls: Optional[Sequence[ChannelCall]] = None,
) -> List[ChannelResult]:
    """Send one event to every external channel at the same time.

    Description: the whole of the concurrency change. Each channel runs
        under its own bound and reports its own outcome, and the gather
        takes ``return_exceptions=True`` on top of that. Belt and braces
        is deliberate: an unhandled exception inside a gather CANCELS its
        siblings, so a defect in the wrapper itself would otherwise turn
        one channel's failure into a dropped notification on the other
        two. Nothing here re-raises a channel problem, so nothing above
        can mistake a partial failure for an entry that must be retried.
    Inputs: event (NotificationEvent) - the event to deliver.
        public_base_url (str) - deep-link base for the channels that use
        one. timeout_s (float) - per-channel bound, seconds.
        calls (Sequence[ChannelCall] | None) - override the channel set;
        None means the real three. Present so a test can drive this with
        a channel that hangs without hanging a real client.
    Output: list[ChannelResult] - one per channel, in the order
        ``build_channel_calls`` returned them.
    Example: await dispatch_channels(event, public_base_url="http://x")
    """
    channel_calls = list(
        calls if calls is not None else build_channel_calls(event, public_base_url)
    )
    if not channel_calls:
        return []

    settled = await asyncio.gather(
        *(
            _dispatch_one(name, factory, timeout_s, event)
            for name, factory in channel_calls
        ),
        return_exceptions=True,
    )

    results: List[ChannelResult] = []
    for (name, _factory), outcome in zip(channel_calls, settled):
        if isinstance(outcome, ChannelResult):
            results.append(outcome)
            continue
        # Only reachable if ``_dispatch_one`` itself broke. Report it as
        # that channel's failure rather than letting a None or a raw
        # exception object reach a caller that expects results.
        logger.warning(
            "notifications.channel_dispatch_wrapper_error",
            channel=name,
            kind=event.kind.value,
            error=str(outcome),
            error_type=type(outcome).__name__,
        )
        results.append(
            ChannelResult(
                channel=name, outcome=OUTCOME_ERROR, error=str(outcome)
            )
        )
    return results
