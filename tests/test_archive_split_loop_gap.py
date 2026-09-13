"""The split must not run on the event loop, and this MEASURES the gap.

WHY A MEASUREMENT AND NOT AN ASSERTION ABOUT STRUCTURE. A test that
checks ``run_split`` is called through ``asyncio.to_thread`` proves only
that today's call site is spelled a particular way. What actually matters
to the user is how long the loop goes unserved, because while it is
blocked the server cannot read the tmux pipe carrying terminal output,
cannot spawn the ``send-keys`` that delivers a keystroke, and cannot
answer another request. That is the mechanism CLAUDE.md already records
for the listing pass, which measured 1008 ms per pass and was reported by
the owner as typing lag.

So this runs a high-frequency heartbeat on the loop and records the
largest interval between consecutive ticks, once with the split in a
thread and once with it called directly on the loop. The on-loop arm is
the CONTROL: without it a fast machine could make both arms look fine and
the test would prove nothing.

Numbers are REPORTED, never asserted as absolutes, because a wall clock
on a loaded box either flakes or is too loose to mean anything. The only
assertion is the RELATIONSHIP: the threaded arm's worst gap must be a
small fraction of the blocking arm's, which is a claim about where the
work happened rather than about how fast this machine is.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import List, Tuple

import pytest

from src.core.archive_db_split_run import run_split
from tests.test_archive_db_split import build_state

#: Heartbeat period. Short enough that a stall of a few tens of
#: milliseconds is visible, long enough not to be self-inflicted load.
TICK_SECONDS = 0.002

#: Archive rows in the fixture. Enough that the copy is measurably longer
#: than one heartbeat, which is what makes the control arm stall at all.
FIXTURE_ARCHIVES = 4000


async def _heartbeat(stop: asyncio.Event, gaps: List[float]) -> None:
    """Tick on the loop and record the interval between consecutive ticks.

    Description: the instrument. Each recorded value is how long the loop
      went without running this coroutine, which is exactly the latency a
      keystroke or a pipe read would have suffered at that moment.
    Inputs: stop (asyncio.Event) - set when the measured work is done.
      gaps (list[float]) - appended to, in seconds.
    Output: None.
    Example: asyncio.create_task(_heartbeat(stop, gaps))
    """
    last = time.perf_counter()
    while not stop.is_set():
        await asyncio.sleep(TICK_SECONDS)
        now = time.perf_counter()
        gaps.append(now - last)
        last = now


async def _measure(state: Path, *, threaded: bool) -> Tuple[float, float]:
    """Run one split arm under a heartbeat and return its gap figures.

    Description: the two arms differ in ONE line, which is the whole
      point of the comparison.
    Inputs: state (Path) - a state directory holding cloude.db. threaded
      (bool) - hand the work to asyncio.to_thread, or call it inline.
    Output: tuple[float, float] - (largest gap seconds, elapsed seconds).
    Example: await _measure(state, threaded=True)
    """
    stop = asyncio.Event()
    gaps: List[float] = []
    beat = asyncio.create_task(_heartbeat(stop, gaps))
    await asyncio.sleep(0.02)  # let the heartbeat settle before measuring

    started = time.perf_counter()
    if threaded:
        report = await asyncio.to_thread(run_split, state, apply=True)
    else:
        report = run_split(state, apply=True)
    elapsed = time.perf_counter() - started

    stop.set()
    await beat
    assert not report.refused, [r.rung for r in report.refusals]
    return (max(gaps) if gaps else 0.0), elapsed


@pytest.mark.parametrize("threaded", [True, False])
def test_loop_gap_is_measured_for_both_arms(
    tmp_path: Path, threaded: bool, capsys: pytest.CaptureFixture,
) -> None:
    """Report the largest loop gap for one arm. No absolute assertion."""
    state = build_state(tmp_path / ("t" if threaded else "b"),
                        archives=FIXTURE_ARCHIVES)
    gap, elapsed = asyncio.run(_measure(state, threaded=threaded))
    with capsys.disabled():
        arm = "threaded" if threaded else "on the loop"
        print(f"\n  archive split {arm:12}: "
              f"largest loop gap {gap * 1000:8.2f} ms, "
              f"pass {elapsed * 1000:8.2f} ms")
    assert gap >= 0.0


def test_threading_the_split_keeps_the_loop_responsive(tmp_path: Path) -> None:
    """THE CLAIM: the work belongs off the loop, and the control proves it.

    Both arms do identical work on identical fixtures. The only
    difference is where it runs, so a difference in the loop gap can only
    be attributed to that. The blocking arm is the control: if it did not
    stall, this test would be measuring nothing and passing anyway.
    """
    threaded_state = build_state(tmp_path / "threaded", archives=FIXTURE_ARCHIVES)
    blocking_state = build_state(tmp_path / "blocking", archives=FIXTURE_ARCHIVES)

    threaded_gap, threaded_elapsed = asyncio.run(
        _measure(threaded_state, threaded=True)
    )
    blocking_gap, blocking_elapsed = asyncio.run(
        _measure(blocking_state, threaded=False)
    )

    # The control must actually have stalled, or there is nothing to compare.
    assert blocking_gap > TICK_SECONDS * 5, (
        f"the on-loop arm only stalled {blocking_gap * 1000:.2f} ms, which is "
        "too close to the heartbeat period for this comparison to mean "
        "anything; raise FIXTURE_ARCHIVES"
    )
    # And the threaded arm must be a small fraction of it.
    assert threaded_gap < blocking_gap / 3, (
        f"threaded arm stalled the loop {threaded_gap * 1000:.2f} ms against "
        f"{blocking_gap * 1000:.2f} ms blocking; the work is not actually "
        "leaving the event loop"
    )
    print(
        f"\n  loop gap: threaded {threaded_gap * 1000:.2f} ms "
        f"(pass {threaded_elapsed * 1000:.0f} ms) vs "
        f"on-loop {blocking_gap * 1000:.2f} ms "
        f"(pass {blocking_elapsed * 1000:.0f} ms)"
    )
