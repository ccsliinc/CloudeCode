"""One consumer's bounded outbound stream, and the named outcome when it fills.

WHY THIS EXISTS. Two fan-outs in this app hand work to a browser that may
not be reading: the terminal's raw pane bytes (issue 38) and the
application event channel (issue 34). Both had the same shape and neither
had a bound. An `asyncio.Queue()` with no `maxsize` never blocks on `put`,
so a stalled viewer applied no backpressure and simply grew - the process
holds every byte that browser has not read, for as long as it does not
read it, and the failure lands on the whole server rather than on the one
client that caused it.

THE PRODUCER NEVER AWAITS. `offer` is a plain synchronous call. That is
the whole point: the tmux tail loop and the hook route must hand a frame
over and carry on, because anything they await is time the event loop is
not reading the pipe, not delivering a keystroke and not answering another
request. A bounded `asyncio.Queue` would have been the obvious change and
would have been wrong - `await queue.put` on a full queue is exactly the
backpressure the bound is supposed to prevent.

AN OVERFLOW IS A NAMED OUTCOME, NEVER A SILENT DROP. `offer` answers one
of three words and the stream LATCHES the overflow, so the caller can act
on it and the reader can be woken to find out. Nothing here decides what
acting on it means - the terminal path closes that viewer's socket so it
recaptures, the event path closes it so it reconnects and re-reads - but
both learn about it from the same word.

ONCE OVERFLOWED, NOTHING MORE IS ADMITTED. A stream that kept taking
frames after it crossed its bound would make the bound a number nobody can
reason from, and the consumer is going away regardless. It is also what
makes the overflow one event rather than a storm: the first crossing
closes the stream, and every later `offer` answers `closed`.

THE SIZE IS THE SIZE OF WHAT IS HELD. Callers pass the byte cost of the
item they are handing over, so the budget measures memory this process is
actually holding rather than some upstream value it was derived from.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional, Tuple

import structlog

logger = structlog.get_logger()


# The three answers `offer` can give. They are strings rather than an Enum
# so a log line, a test assertion and a JSON field can all carry the same
# token without a conversion at each boundary.
OFFER_ACCEPTED = "accepted"
OFFER_OVERFLOWED = "overflowed"
OFFER_CLOSED = "closed"

# Why a stream is no longer taking items. `REASON_DONE` is an ordinary
# teardown (the socket went away); `REASON_OVERFLOW` is the bound being
# crossed, and is the only one a caller should report to the client.
REASON_DONE = "done"
REASON_OVERFLOW = "overflow"

# The close code a socket gets when its own stream crossed the bound. ONE
# NUMBER FOR BOTH CHANNELS - the terminal's byte fan-out and the
# application event channel - because it answers the same question on
# each: "you fell behind, recover silently". An APPLICATION code in the
# 4000 range rather than a standard 1013, deliberately: the recovery is
# meant to be invisible, so the client has to be able to tell this apart
# from a server restart and show its reconnect banner for only one of
# them. Two separately chosen numbers would be two things to keep in step
# for no benefit.
OVERFLOW_CLOSE_CODE = 4429


class BoundedStream:
    """A single consumer's queue, bounded by item count AND by bytes.

    Both bounds are real and either can bind first. For terminal output
    the item count is the one that fires: the tail loop reads at most
    8192 bytes per `os.read`, so 256 chunks is at most about 2.8 MiB once
    base64 has inflated them, well inside a 4 MiB budget. The byte budget
    is the backstop that keeps the bound true if that read size ever
    grows, and it is the one that binds for event frames, which are small
    and numerous.

    Not thread safe, and does not need to be: every caller is on the one
    event loop.
    """

    def __init__(
        self,
        *,
        max_items: int,
        max_bytes: int,
        label: str = "",
    ) -> None:
        """Build an empty stream with the given bounds.

        Inputs: max_items (int) - most items held at once, must be
          positive; max_bytes (int) - most bytes held at once, must be
          positive; label (str) - what this stream is, for log lines
          only.
        Output: None.
        Example: BoundedStream(max_items=256, max_bytes=4 << 20,
                               label="viewer ses_1234")
        """
        if max_items <= 0:
            raise ValueError("max_items must be positive")
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        self._max_items = max_items
        self._max_bytes = max_bytes
        self._label = label
        self._queue: asyncio.Queue = asyncio.Queue()
        self._queued_bytes = 0
        self._queued_items = 0
        self._closed = False
        self._reason: Optional[str] = None

    # ---- what the producer calls -------------------------------------

    def offer(self, item: Any, size: int) -> str:
        """Hand one item over without ever blocking or awaiting.

        Description: admits the item when BOTH bounds still hold with it
          added. Otherwise the stream is closed with `REASON_OVERFLOW`
          and the waiting reader is woken so the caller's teardown can
          run. A closed stream takes nothing.
        Inputs: item (Any) - whatever the consumer expects to receive;
          size (int) - the item's byte cost, negative values treated as
          zero so a miscounted caller can never shrink the total.
        Output: str - one of OFFER_ACCEPTED, OFFER_OVERFLOWED,
          OFFER_CLOSED.
        Example: stream.offer(frame, len(encoded))
        """
        if self._closed:
            return OFFER_CLOSED

        cost = size if size > 0 else 0
        would_be_items = self._queued_items + 1
        would_be_bytes = self._queued_bytes + cost
        if would_be_items > self._max_items or would_be_bytes > self._max_bytes:
            logger.warning(
                "bounded_stream_overflow",
                label=self._label,
                queued_items=self._queued_items,
                queued_bytes=self._queued_bytes,
                item_bytes=cost,
                max_items=self._max_items,
                max_bytes=self._max_bytes,
            )
            self.close(REASON_OVERFLOW)
            return OFFER_OVERFLOWED

        self._queued_items = would_be_items
        self._queued_bytes = would_be_bytes
        # Safe without await: the queue itself is unbounded, so this can
        # never block. OUR bound is the one enforced above.
        self._queue.put_nowait((item, cost))
        return OFFER_ACCEPTED

    # ---- what the consumer calls -------------------------------------

    async def get(self) -> Optional[Any]:
        """Wait for the next item, or learn the stream is finished.

        Description: returns items in the order they were offered. A
          `None` means the stream is closed AND drained, which is the
          signal for the one writer task to stop; the caller then reads
          `overflowed` to decide what to tell the client. Draining before
          reporting closure is deliberate - items already admitted were
          inside the bound and the consumer is entitled to them.
        Inputs: none.
        Output: the next item, or None when finished.
        Example: while (item := await stream.get()) is not None: ...
        """
        while True:
            if self._queue.empty() and self._closed:
                return None
            got: Tuple[Any, int] = await self._queue.get()
            item, cost = got
            if item is _SENTINEL:
                # A wakeup, not data. Loop round and re-test closure.
                continue
            self._queued_items -= 1
            self._queued_bytes -= cost
            return item

    # ---- lifecycle ----------------------------------------------------

    def close(self, reason: str = REASON_DONE) -> None:
        """Stop accepting items and wake any waiting reader. Idempotent.

        Description: the FIRST reason wins. An overflow followed by an
          ordinary teardown must still report the overflow, or the client
          is told its socket closed for no reason and the one thing worth
          knowing is lost.
        Inputs: reason (str) - REASON_DONE or REASON_OVERFLOW.
        Output: None.
        Example: stream.close(REASON_DONE)
        """
        if self._closed:
            return
        self._closed = True
        self._reason = reason
        # Wake a reader parked in `get`. It re-tests closure and returns.
        self._queue.put_nowait((_SENTINEL, 0))

    @property
    def closed(self) -> bool:
        """True once the stream stopped accepting items."""
        return self._closed

    @property
    def overflowed(self) -> bool:
        """True when this stream closed because it crossed its bound."""
        return self._reason == REASON_OVERFLOW

    @property
    def reason(self) -> Optional[str]:
        """Why the stream closed, or None while it is still open."""
        return self._reason

    @property
    def queued_items(self) -> int:
        """How many items are held right now."""
        return self._queued_items

    @property
    def queued_bytes(self) -> int:
        """How many bytes are held right now."""
        return self._queued_bytes

    @property
    def max_items(self) -> int:
        """The item bound this stream was built with."""
        return self._max_items

    @property
    def max_bytes(self) -> int:
        """The byte bound this stream was built with."""
        return self._max_bytes


class _Sentinel:
    """Marker put on the queue purely to wake a parked reader."""


_SENTINEL = _Sentinel()
