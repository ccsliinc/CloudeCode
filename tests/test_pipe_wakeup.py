"""The pipe reader must wake on the append, not on a timer.

WHY THIS FILE EXISTS. ``TmuxBackend._tail_loop`` used to sleep a fixed
20ms whenever a read came back empty, which made that interval a FLOOR ON
KEYSTROKE LATENCY - the echo of a keypress lands in the pipe file at a
uniformly random point inside the window, so it was seen about half an
interval late on every keystroke forever.

MEASURED, interleaved A/B in one process so the same machine load hit
both arms, 4 rounds of 25 keystrokes through a real tmux pane:

    poll     p50 26.10ms   p90 60.20ms   p99 141.32ms
    kqueue   p50 12.31ms   p90 28.44ms   p99  77.59ms

and idle CPU across 11 idle panes, interleaved the same way, was
0.97% of one core against 0.98% - indistinguishable, which is the whole
reason this was worth keeping rather than reverting.

HOW THESE TESTS AVOID THE OBVIOUS TRAP. A latency assertion on a loaded
developer box is exactly the kind of test that flakes or gets loosened
until it proves nothing. So none of these assert a millisecond figure
against the real backstop. Instead the timeout handed to ``wait`` is made
ENORMOUS relative to the thing being measured: a test that passes cannot
have passed by timing out, because timing out would take seconds and the
assertion allows a fraction of one. The claim under test is "the append
itself released the wait", and that is what is measured.

The producer here is ``sh -c "cat >> <file>"`` - not a Python write -
because that is literally what ``tmux pipe-pane`` spawns, and a watch
that works for an in-process write but not for a separate appending
process would pass a weaker test and fail in production.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_pw_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_pw_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.pipe_wakeup import KQUEUE_AVAILABLE, PipeWaiter

requires_kqueue = pytest.mark.skipif(
    not KQUEUE_AVAILABLE,
    reason="no select.kqueue on this platform; the waiter uses its sleep fallback",
)

#: The backstop handed to ``wait`` in the wake tests. Deliberately
#: absurd next to :data:`WAKE_BUDGET_SECONDS`: a wait released by this
#: would take five seconds, so a passing test PROVES the append released
#: it and cannot have been satisfied by the timer.
ABSURD_TIMEOUT_SECONDS = 5.0

#: How long an append may take to release a wait before the test calls it
#: a failure. Two orders of magnitude above the 0.186ms measured through
#: a real event loop, so ordinary load cannot reach it, and two orders
#: BELOW the backstop above, so a timeout cannot be mistaken for a wake.
WAKE_BUDGET_SECONDS = 0.5


class _Appender:
    """A separate process appending to a file, exactly as tmux does.

    Description: ``tmux pipe-pane`` runs ``sh -c "cat >> <file>"``, so
        the bytes arrive from another process rather than from this one.
        Reproducing that is not pedantry - a file watch can behave
        differently for a write made through a descriptor this process
        already holds.
    Inputs: path (Path) - the file to append to.
    Output: a context manager exposing ``append(data)``.
    Example:
        with _Appender(p) as a:
            a.append(b"hi\\n")
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._proc = None

    def __enter__(self) -> "_Appender":
        self._proc = subprocess.Popen(
            ["sh", "-c", f"cat >> '{self._path}'"], stdin=subprocess.PIPE
        )
        self._wait_until_appending()
        return self

    def _wait_until_appending(self) -> None:
        """Block until the child has actually opened the file and written.

        WHY THIS IS NOT OPTIONAL, and why it is here rather than in each
        test. ``Popen`` returns as soon as the fork succeeds - it does not
        mean ``sh`` has exec'd ``cat``, nor that ``cat`` has opened the
        file. Bytes written before then sit in the pipe buffer and produce
        NO file append and therefore NO notification. On a loaded machine
        that startup can take longer than the wake budget, so a test that
        measured from its first write was timing process startup and
        calling it wake latency. It failed exactly that way once in a full
        suite run at load average 14, and passed the same suite minutes
        later - a flake of the test's own making, not of the product.

        A warm-up append proves the child is live, and the measured
        appends afterwards time only what they claim to.
        Inputs: none.
        Output: None. Raises AssertionError if the child never appends,
            which is a broken fixture and must not be silently tolerated.
        """
        marker = b"__appender_ready__\n"
        self.append(marker)
        deadline = time.monotonic() + 20.0
        while time.monotonic() < deadline:
            try:
                if self._path.stat().st_size >= len(marker):
                    return
            except FileNotFoundError:
                pass
            time.sleep(0.005)
        raise AssertionError(
            f"the `cat >>` appender never wrote to {self._path} - the "
            "fixture is broken, so nothing below would be measuring the "
            "watch"
        )

    def append(self, data: bytes) -> None:
        """Append bytes and flush them out of this process. Output: None."""
        assert self._proc is not None and self._proc.stdin is not None
        self._proc.stdin.write(data)
        self._proc.stdin.flush()

    def __exit__(self, *exc) -> None:
        if self._proc is not None:
            try:
                if self._proc.stdin is not None:
                    self._proc.stdin.close()
                self._proc.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self._proc.kill()


def _open_at_end(path: Path) -> int:
    """Open the file the way the tail loop does. Output: the fd."""
    fd = os.open(str(path), os.O_RDONLY | os.O_NONBLOCK)
    os.lseek(fd, 0, os.SEEK_END)
    return fd


@requires_kqueue
@pytest.mark.asyncio
async def test_an_append_releases_the_wait_long_before_the_backstop(tmp_path):
    """The append itself must end the wait, not the timer.

    THE MEASUREMENT THAT FAILS ON THE OLD BEHAVIOUR. Before this, an
    empty read was followed by ``asyncio.sleep(timeout)`` with no way for
    an arriving byte to cut it short, so this wait would have run the
    full five seconds and blown the half-second budget by an order of
    magnitude. There is no way to pass it by waiting.
    """
    pipe = tmp_path / "pane.pipe"
    pipe.write_bytes(b"")
    with _Appender(pipe) as appender:
        # Opened AFTER the appender is proven live, so the warm-up byte is
        # already behind us and the fd starts where the tail loop's does:
        # at the end, with nothing pending.
        fd = _open_at_end(pipe)
        waiter = PipeWaiter(fd)
        assert waiter.watching, (
            "kqueue is available but the watch did not register, so this "
            "test would be measuring the sleep fallback and proving nothing"
        )
        try:
            for attempt in range(5):
                # Schedule the append AFTER the wait is parked, so what is
                # measured is the wake and not the latch.
                loop = asyncio.get_running_loop()
                loop.call_later(0.05, appender.append, b"keystroke echo\n")
                t0 = time.perf_counter()
                woke = await waiter.wait(ABSURD_TIMEOUT_SECONDS)
                elapsed = time.perf_counter() - t0
                assert woke is True, (
                    f"attempt {attempt}: wait returned without an append "
                    "having released it"
                )
                assert elapsed < WAKE_BUDGET_SECONDS, (
                    f"attempt {attempt}: the append took {elapsed*1000:.1f} ms "
                    f"to release the wait, over the "
                    f"{WAKE_BUDGET_SECONDS*1000:.0f} ms budget. A "
                    f"{ABSURD_TIMEOUT_SECONDS}s backstop was in force, so "
                    "this cannot have been the timer."
                )
                assert os.read(fd, 8192), "woke, but no bytes were readable"
        finally:
            waiter.close()
            os.close(fd)


@requires_kqueue
@pytest.mark.asyncio
async def test_an_append_that_arrives_between_waits_is_not_slept_through(tmp_path):
    """A byte that lands while nobody is waiting must not cost a backstop.

    THE RACE THIS EXISTS TO CLOSE, and it is real rather than theoretical:
    the loop reads, gets nothing, and only THEN calls ``wait``. An append
    landing in that gap has already been notified, so a waiter that only
    listened for FUTURE events would sleep through bytes sitting on disk
    and deliver them a backstop late - which is precisely the latency the
    change exists to remove, reappearing on the unlucky keystrokes.
    """
    pipe = tmp_path / "pane.pipe"
    pipe.write_bytes(b"")
    with _Appender(pipe) as appender:
        fd = _open_at_end(pipe)
        waiter = PipeWaiter(fd)
        assert waiter.watching
        try:
            # Land the append while no wait is outstanding, and give the
            # loop turns so the kqueue callback actually runs. The wait
            # here is for the NOTIFICATION to be delivered, not for the
            # append - the appender is already proven live - and it is
            # generous because a loaded box schedules callbacks late.
            appender.append(b"arrived between waits\n")
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline and not waiter._pending_data:
                await asyncio.sleep(0.005)
            assert waiter._pending_data, (
                "the append was never latched, so the race this test "
                "exists to close is still open"
            )
            t0 = time.perf_counter()
            woke = await waiter.wait(ABSURD_TIMEOUT_SECONDS)
            elapsed = time.perf_counter() - t0
            assert woke is True and elapsed < WAKE_BUDGET_SECONDS, (
                f"a wait that began with data already on disk took "
                f"{elapsed*1000:.1f} ms and returned {woke}. The append was "
                "notified before the wait started, so it has to be latched."
            )
            assert os.read(fd, 8192)
        finally:
            waiter.close()
            os.close(fd)


@pytest.mark.asyncio
async def test_a_quiet_file_still_returns_at_the_backstop(tmp_path):
    """With nothing appended, the wait must end on time and say so.

    The safety half of the design. An event-driven reader that misses a
    notification does not read LATE, it stops reading - so every wait is
    bounded by the same interval the old poll used, and the bound has to
    actually work. Runs on every platform, because the sleep fallback
    must satisfy it too.
    """
    pipe = tmp_path / "quiet.pipe"
    pipe.write_bytes(b"")
    fd = _open_at_end(pipe)
    waiter = PipeWaiter(fd)
    try:
        t0 = time.perf_counter()
        woke = await waiter.wait(0.05)
        elapsed = time.perf_counter() - t0
        assert woke is False, "nothing was appended, so nothing may claim a wake"
        assert elapsed >= 0.04, (
            f"the wait returned after {elapsed*1000:.1f} ms without an "
            "append. A backstop that fires early is a busy loop."
        )
        assert elapsed < 2.0, (
            f"the backstop took {elapsed*1000:.1f} ms to fire; a missed "
            "notification would strand the terminal for that long"
        )
    finally:
        waiter.close()
        os.close(fd)


@pytest.mark.asyncio
async def test_the_fallback_behaves_exactly_like_the_old_sleep(tmp_path, monkeypatch):
    """Without a watch, the waiter must be the sleep it replaced.

    Linux has no ``select.kqueue`` and CI runs there, so the fallback is
    a shipped configuration and not a curiosity. It must wait the whole
    interval and report that nothing woke it - anything else would make
    the tail loop spin on a platform nobody is measuring.
    """
    monkeypatch.setattr("src.core.pipe_wakeup.KQUEUE_AVAILABLE", False)
    pipe = tmp_path / "fallback.pipe"
    pipe.write_bytes(b"")
    with _Appender(pipe) as appender:
        fd = _open_at_end(pipe)
        waiter = PipeWaiter(fd)
        assert waiter.watching is False, (
            "KQUEUE_AVAILABLE was forced off, so no watch may be registered"
        )
        try:
            appender.append(b"ignored by the fallback\n")
            t0 = time.perf_counter()
            woke = await waiter.wait(0.05)
            elapsed = time.perf_counter() - t0
        finally:
            waiter.close()
            os.close(fd)
        assert woke is False
        assert elapsed >= 0.04, (
            f"the fallback returned after {elapsed*1000:.1f} ms; it must "
            "sleep the full interval exactly as the old loop did"
        )


@pytest.mark.asyncio
async def test_close_is_idempotent_and_survives_a_double_call(tmp_path):
    """The tail loop closes this from a ``finally`` during teardown.

    A leaked kqueue descriptor per session would outlive the pane it
    watched, and a close that raised inside that ``finally`` would mask
    whatever actually ended the loop.
    """
    pipe = tmp_path / "close.pipe"
    pipe.write_bytes(b"")
    fd = _open_at_end(pipe)
    waiter = PipeWaiter(fd)
    try:
        waiter.close()
        waiter.close()
        assert waiter.watching is False
        # Still usable as a plain sleep after closing, rather than raising
        # into a caller that has no way to recover mid-teardown.
        assert await waiter.wait(0.01) is False
    finally:
        os.close(fd)
