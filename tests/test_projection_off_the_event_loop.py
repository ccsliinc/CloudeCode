"""The projection must not block the event loop, and this MEASURES it.

WHY THIS FILE EXISTS RATHER THAN A MOCK. This project has paid for
event-loop blocking three times, each time in a way the code read fine:
a ``PRAGMA integrity_check`` on a request path that blocked the loop for
14 of every 20 seconds, a synchronous listing pass that cost 1008 ms per
poll and presented to the user as typing lag, and a per-row connection
pattern costing 33 connections a pass. A test asserting that
``asyncio.to_thread`` appears in the source would have passed in all
three of those worlds, because the defect is never in whether the call
exists. So this file starts a real event loop, starts a real ticker on
it, runs a real projection over a real corpus, and COUNTS THE TICKS.

THE ASSERTION IS DELIBERATELY LOOSE AND STILL DECISIVE. A blocking
projection produces a tick gap the length of the whole pass; a threaded
one produces gaps at the tick interval. Those differ by orders of
magnitude, so a bound set well inside that gulf cannot flake on a loaded
machine and cannot pass if the work moves back onto the loop. The
control run at the bottom proves the ticker itself is honest by
measuring a DELIBERATELY blocking call with the same instrument - a
measurement with no control is a number, not evidence.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.corpus_ingest_service import run_ingest_once
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.db_steps import apply_message_model_schema
from src.core.message_projection import run_projection_once

#: How often the ticker wakes. Small enough that a pass of a few tens of
#: milliseconds still yields a usable count.
TICK_SECONDS = 0.002

#: Transcripts in the throwaway corpus. Enough that the pass takes
#: measurably longer than one tick, few enough that the suite stays fast.
CORPUS_FILES = 120


def _build(tmp_path: Path) -> Path:
    """Write a corpus, archive it, and return the state dir.

    Inputs: tmp_path (Path).
    Output: Path - a state dir holding archives and an empty message model.
    Example: _build(tmp_path) / "cloude.db"
    """
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    conn = connect(db_path_for(state), create=False)
    try:
        apply_message_model_schema(conn)
        conn.commit()
    finally:
        conn.close()
    corpus = tmp_path / "corpus"
    slug = corpus / "-Users-x-loop"
    slug.mkdir(parents=True)
    for index in range(CORPUS_FILES):
        uuid = f"{index:08d}-0000-0000-0000-000000000000"
        (slug / f"{uuid}.jsonl").write_text(
            "".join(
                '{"type":"user","uuid":"u%d","sessionId":"%s",'
                '"timestamp":"2026-08-29T00:00:00.000Z",'
                '"message":{"role":"user","content":"line %d %s"}}\n'
                % (line, uuid, line, "padding " * 40)
                for line in range(20)
            ),
            encoding="utf-8",
        )
    run_ingest_once(state, corpus_root=corpus)
    return state


async def _tick_while(coro_factory):
    """Run a ticker on the loop while awaiting the given work, and count it.

    Description: THE COUNT IS THE MEASUREMENT. A ticker waking every
      ``TICK_SECONDS`` should wake roughly ``elapsed / TICK_SECONDS``
      times while the work runs; a loop that is blocked wakes ZERO times
      and then once at the end. The largest gap is reported beside it,
      with a stamp taken immediately after the work so the gap that spans
      a stall is actually in the series - without that final stamp the
      stall is invisible, which is a mistake this instrument made once
      and is why the control test below exists.
    Inputs: coro_factory (callable returning an awaitable).
    Output: (elapsed float, max_gap float, ticks_during int).
    Example: await _tick_while(lambda: asyncio.sleep(0.05))
    """
    stamps = []
    stop = asyncio.Event()

    async def ticker() -> None:
        while not stop.is_set():
            stamps.append(time.perf_counter())
            await asyncio.sleep(TICK_SECONDS)

    task = asyncio.ensure_future(ticker())
    await asyncio.sleep(TICK_SECONDS * 3)
    del stamps[:]
    started = time.perf_counter()
    await coro_factory()
    elapsed = time.perf_counter() - started
    during = list(stamps)
    stop.set()
    await task
    series = [started] + during + [started + elapsed]
    gaps = [b - a for a, b in zip(series, series[1:])]
    return elapsed, (max(gaps) if gaps else elapsed), len(during)


@pytest.mark.asyncio
async def test_a_projection_pass_does_not_stall_the_event_loop(tmp_path):
    state = _build(tmp_path)

    elapsed, max_gap, ticks = await _tick_while(
        lambda: asyncio.to_thread(
            run_projection_once, state, max_archives=CORPUS_FILES,
            respect_flag=False,
        )
    )

    # The pass has to have actually done work, or this measures nothing.
    assert elapsed > TICK_SECONDS * 5, (
        f"the pass finished in {elapsed:.4f}s, too fast to measure against"
    )
    # The loop kept being served throughout. The bound is a third of the
    # pass, which a blocking pass can never meet (its single gap IS the
    # pass) and a threaded one beats by orders of magnitude.
    assert max_gap < elapsed / 3, (
        f"largest loop gap {max_gap * 1000:.1f} ms over a {elapsed:.3f}s "
        "pass; the work is back on the event loop"
    )
    # A served loop wakes about elapsed/TICK_SECONDS times. A blocked one
    # wakes zero. Ten is far below the first and unreachable by the second.
    assert ticks > 10, f"the loop woke only {ticks} times during the pass"


@pytest.mark.asyncio
async def test_the_control_shows_the_ticker_can_detect_a_stall(tmp_path):
    # THE NEGATIVE CONTROL FOR THE INSTRUMENT. The same measurement, made
    # against a call deliberately left ON the loop. If this does not show
    # a stall then the test above proves nothing, because the ticker
    # would report a clean loop no matter what was run.
    state = _build(tmp_path)

    async def blocking():
        run_projection_once(
            state, max_archives=CORPUS_FILES, respect_flag=False,
        )

    elapsed, max_gap, ticks = await _tick_while(blocking)

    assert max_gap > elapsed / 2, (
        f"a synchronous pass of {elapsed:.3f}s produced a largest gap of "
        f"only {max_gap * 1000:.1f} ms, so the ticker is not measuring "
        "what this file claims it measures"
    )
    assert ticks == 0, (
        f"the loop woke {ticks} times during a pass that was supposed to "
        "block it; the instrument is not measuring a stall"
    )
