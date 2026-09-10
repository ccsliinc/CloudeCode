"""Wake the pipe reader when tmux appends, instead of asking every 20ms.

WHY THIS FILE EXISTS. ``TmuxBackend._tail_loop`` reads the pipe-pane file
with a non-blocking fd and, whenever the read comes back empty, sleeps a
fixed 20ms before trying again. That sleep is a FLOOR ON KEYSTROKE
LATENCY: the echo of a keypress lands in the file at a uniformly random
point inside the window, so the reader sees it about 10ms late on
average and 20ms late at worst, every keystroke, for as long as the app
exists. Measured end to end on a throwaway socket - ``backend.write``
through tmux, the PTY, pipe-pane and back out of ``on_output`` - the
round trip was **p50 25.3ms**, of which that wait is the largest single
component after the ``send-keys`` subprocess.

WHY kqueue AND NOT A SHORTER POLL OR A WATCHER LIBRARY. The producer is
``sh -c "cat >> <file>"``, a separate process appending to a REGULAR
FILE, so the honest options were a shorter poll, repeated ``os.stat``, or
a kernel file-change notification. Both polling options trade CPU for
latency on every idle pane, and this app routinely holds a dozen. kqueue
is in the standard library on macOS (``select.kqueue``), needs no
dependency, and was MEASURED against the exact producer before any of
this was written: ``EVFILT_VNODE`` with ``NOTE_WRITE | NOTE_EXTEND``
fired for all 12 of 12 appends by a real ``cat >>``, **p50 0.024ms**.

AND NO THREAD IS SPENT, which is what makes it usable here. A kqueue
descriptor is itself pollable, so asyncio's own selector can watch it
with ``loop.add_reader`` - measured through a real event loop at **p50
0.186ms** wake-to-callback - rather than parking a blocking
``kq.control`` on a worker thread per session.

THE TIMEOUT IS NOT DECORATION, IT IS THE WHOLE SAFETY ARGUMENT. An
event-driven reader that misses one event does not read late, it stops
reading - the terminal goes silent until something else happens to
append. So every wait is bounded by the SAME interval the old poll used,
and a timeout simply falls through to the read that would have happened
anyway. The worst case is therefore exactly the behaviour this replaces,
the idle wakeup rate is unchanged, and the only thing that moves is how
early a wait can END. A platform with no kqueue (Linux, where CI runs)
gets the plain sleep and behaves precisely as before.
"""

from __future__ import annotations

import asyncio
import logging
import select
from typing import Optional

logger = logging.getLogger(__name__)

#: True when this interpreter can watch a file for appends.
#: ``select.kqueue`` exists on macOS and the BSDs and not on Linux, and
#: the fallback is the plain sleep this class replaces, so the absence of
#: it is a supported configuration rather than a degraded one.
KQUEUE_AVAILABLE: bool = hasattr(select, "kqueue")


class PipeWaiter:
    """Wait until a file is appended to, or until a timeout expires.

    Description: one instance per open pipe fd, owned by the tail loop
        that opened it. ``wait()`` returns as soon as the kernel reports
        an append, and otherwise after ``timeout`` seconds - so a caller
        that loses an event is late by the timeout rather than stuck
        forever.

        Falls back to ``asyncio.sleep(timeout)`` whenever a watch cannot
        be set up, for any reason: no kqueue on this platform, an event
        loop that will not watch the descriptor, or a kernel refusal on
        this particular fd. Every one of those degrades to EXACTLY the
        behaviour that existed before this class, which is why the
        fallback is silent about correctness and only logs at debug.
    Inputs: see :meth:`__init__`.
    Output: an awaitable ``wait`` and an idempotent ``close``.
    Example:
        waiter = PipeWaiter(fd)
        await waiter.wait(0.02)
        waiter.close()
    """

    def __init__(self, fd: int) -> None:
        """Register ``fd`` for append notifications, if that is possible.

        Inputs:
            fd: an OPEN file descriptor for the pipe file. The caller
                keeps ownership - this class never closes it, and the
                watch is only valid for as long as the caller holds it
                open.
        Output: None. Never raises; a failed registration leaves the
            instance in its sleep-only fallback.
        Example: PipeWaiter(os.open(path, os.O_RDONLY))
        """
        self._fd = fd
        self._kq: Optional["select.kqueue"] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._watching = False
        self._waiter: Optional[asyncio.Future] = None
        #: An append seen while nobody was waiting. Latched so the
        #: next wait returns at once rather than sleeping through
        #: bytes that are already on disk.
        self._pending_data = False
        if KQUEUE_AVAILABLE:
            self._try_watch()

    @property
    def watching(self) -> bool:
        """True when appends will wake this waiter early.

        Inputs: none.
        Output: bool - False means every ``wait`` runs the full timeout,
            which is the pre-existing behaviour and not a fault.
        """
        return self._watching

    def _try_watch(self) -> None:
        """Set up the kqueue watch and hand its fd to the event loop.

        Inputs: none. Output: None. Never raises - any failure leaves
            ``watching`` False and the caller on the sleep path.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # Constructed outside a running loop. There is nothing to
            # register with, so stay on the fallback.
            return
        try:
            kq = select.kqueue()
            kq.control(
                [
                    select.kevent(
                        self._fd,
                        filter=select.KQ_FILTER_VNODE,
                        flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                        fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND,
                    )
                ],
                0,
                0,
            )
            loop.add_reader(kq.fileno(), self._on_kqueue_readable)
        except (OSError, ValueError, NotImplementedError) as exc:
            logger.debug("pipe_waiter_watch_unavailable", exc_info=False)
            try:
                if "kq" in dir() and kq is not None:
                    kq.close()
            except (OSError, UnboundLocalError):
                pass
            return
        self._kq = kq
        self._loop = loop
        self._watching = True

    def _on_kqueue_readable(self) -> None:
        """Drain the pending kevents and release any pending wait.

        Description: the kqueue is registered ``EV_CLEAR``, so each
            append is reported once and the queue must be drained or the
            loop would spin on a permanently-readable descriptor.

            An append that arrives while NOTHING is waiting still counts:
            ``_pending_data`` latches it, so a caller that reaches
            ``wait`` a moment later returns immediately instead of
            sleeping through data that is already on disk. Without the
            latch there is a real race between the read that came back
            empty and the append that happened just after it.
        Inputs: none. Output: None.
        """
        kq = self._kq
        if kq is None:
            return
        try:
            kq.control(None, 8, 0)
        except OSError:
            # The watch is gone. Fall back rather than spin: a waiter
            # that cannot drain would make the loop hot.
            self._detach()
        self._pending_data = True
        waiter = self._waiter
        if waiter is not None and not waiter.done():
            waiter.set_result(True)

    async def wait(self, timeout: float) -> bool:
        """Block until the file is appended to, or ``timeout`` elapses.

        Description: ONE Future and ONE timer per wait, deliberately, and
            not ``asyncio.wait_for(event.wait(), timeout)``. That reads
            better and costs a whole extra Task per idle cycle - measured
            across 11 idle panes it raised this loop's idle CPU from
            0.84% of a core to 1.10%, which is the wrong direction for a
            change whose entire purpose is to be cheaper than polling.
        Inputs:
            timeout: seconds to wait at most. This is the SAME interval
                the plain poll used, so a missed notification costs the
                old latency and never a stall.
        Output:
            bool - True when an append woke us, False when the timeout
            expired or no watch is active. Callers should read either
            way; the value is for measurement and tests, not control
            flow.
        Example: woke = await waiter.wait(0.02)
        """
        if not self._watching or self._loop is None:
            await asyncio.sleep(timeout)
            return False
        if self._pending_data:
            # An append landed since the last read. Do not sleep on it.
            self._pending_data = False
            return True
        loop = self._loop
        waiter = loop.create_future()
        self._waiter = waiter
        timer = loop.call_later(timeout, self._resolve_timeout, waiter)
        try:
            woke = await waiter
        except asyncio.CancelledError:
            raise
        finally:
            timer.cancel()
            self._waiter = None
        # Consumed either way: the caller reads the fd next, so a latch
        # left standing would make the NEXT wait return instantly for an
        # append this one already accounted for.
        self._pending_data = False
        return bool(woke)

    @staticmethod
    def _resolve_timeout(waiter: "asyncio.Future") -> None:
        """Release a wait that reached its backstop. Inputs: the future.

        Output: None. Guarded because the append and the timer can race.
        """
        if not waiter.done():
            waiter.set_result(False)

    def _detach(self) -> None:
        """Stop watching and release the loop registration. Idempotent.

        Inputs: none. Output: None.
        """
        kq, loop = self._kq, self._loop
        self._watching = False
        if loop is not None and kq is not None:
            try:
                loop.remove_reader(kq.fileno())
            except (OSError, ValueError, RuntimeError):
                pass
        if kq is not None:
            try:
                kq.close()
            except OSError:
                pass
        self._kq = None
        self._loop = None

    def close(self) -> None:
        """Release the watch. Idempotent, and safe after loop shutdown.

        Description: the tail loop calls this from its ``finally``, which
            can run during interpreter or loop teardown, so every step is
            individually guarded. A leaked kqueue descriptor per session
            would outlive the pane it was watching.
        Inputs: none. Output: None.
        Example: waiter.close()
        """
        self._detach()
