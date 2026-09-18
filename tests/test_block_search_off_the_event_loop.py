"""Neither search route may block the loop, and the gap is MEASURED.

WHY THIS FILE EXISTS. This project has paid twice for a synchronous
database read on a request path. ``PRAGMA integrity_check`` inside
``GET /api/v1/version`` blocked the loop for roughly 14 of every 20
seconds on a 4.5 GB file. ``list_session_infos`` was an ``async def``
whose body was entirely synchronous, cost 1008 ms per pass, and the user
reported it as typing lag. Both looked fine in every functional test.

So the claim is not "we call asyncio.to_thread" - that is a grep, not a
measurement. The claim is that while the route runs, a coroutine that
wants to wake every millisecond KEEPS waking. That is measured directly:
a watcher coroutine records the interval between its own wakeups and the
largest one is the loop gap.

THE POSITIVE CONTROL IS LOAD-BEARING. The same work is also run
SYNCHRONOUSLY on the loop, in the same process, against the same
database, and its gap is asserted to be much larger. Without it, a
machine fast enough to make both look instantaneous would pass this file
while proving nothing, and so would a test whose "work" was too small to
block anything.

The two routes are tested separately because they are different costs:
``/archive/search`` is one index query, and ``/archive/search/index`` is
two full traversals, which is exactly the one that would hurt.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Callable, Tuple

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
os.environ.setdefault("DEFAULT_WORKING_DIR", "/tmp")
os.environ.setdefault("LOG_DIRECTORY", "/tmp")
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.api import archive_search_index_routes, archive_search_routes
from src.core.corpus_ingest_service import STATUS_OK as INGEST_OK, run_ingest_once
from src.core.db import connect, db_path_for
from src.core.db_migration import ensure_db_migrated
from src.core.db_steps import apply_message_model_schema
from src.core.message_projection import STATUS_OK, run_projection_once

SESSION_UUID = "55555555-5555-5555-5555-555555555555"
SLUG = "-Users-x-loopgap"

#: Enough records that the synchronous control has real work to do. Each
#: is padded so the projection produces substantial block text.
RECORDS = 400

#: The watcher's target interval. One millisecond is well below anything
#: a healthy loop struggles with and well above the scheduler's own
#: resolution, so the gaps it reports are the route's, not the timer's.
TICK_SECONDS = 0.001


def _write_corpus(root: Path) -> None:
    """Write one transcript with RECORDS padded assistant turns.

    Inputs: root (Path) - corpus root, created here.
    Output: None.
    """
    slug_dir = root / SLUG
    slug_dir.mkdir(parents=True)
    pad = "the quick brown fox jumps over the lazy dog " * 8
    lines = []
    for i in range(RECORDS):
        lines.append(
            '{"type":"assistant","uuid":"a%d","sessionId":"%s",'
            '"timestamp":"2026-08-29T00:00:%02d.000Z",'
            '"cwd":"/Users/x/loopgap",'
            '"message":{"role":"assistant","model":"claude-test","content":'
            '[{"type":"text","text":"row %d tmux %s"}]}}'
            % (i, SESSION_UUID, i % 60, i, pad)
        )
    (slug_dir / f"{SESSION_UUID}.jsonl").write_text(
        "\n".join(lines) + "\n", encoding="utf-8")


@pytest.fixture(scope="module")
def populated(tmp_path_factory) -> Tuple[Path, int, int]:
    """A real, populated, indexed datastore. Built once for the module.

    Inputs: tmp_path_factory.
    Output: (state_dir Path, project_id int, transcript_id int).
    """
    tmp_path = tmp_path_factory.mktemp("loopgap")
    state = tmp_path / "state"
    ensure_db_migrated(state, 4, "0.8.2")
    conn = connect(db_path_for(state), create=False)
    try:
        apply_message_model_schema(conn)
        conn.commit()
    finally:
        conn.close()
    corpus = tmp_path / "corpus"
    _write_corpus(corpus)
    assert run_ingest_once(state, corpus_root=corpus).status == INGEST_OK
    assert run_projection_once(state).status == STATUS_OK
    conn = connect(db_path_for(state), create=False)
    try:
        tid, pid = conn.execute(
            "SELECT id, project_id FROM message_transcripts ORDER BY id LIMIT 1"
        ).fetchone()
        indexed = int(conn.execute(
            "SELECT COUNT(*) FROM message_block_search").fetchone()[0])
    finally:
        conn.close()
    assert indexed >= RECORDS, (
        f"the triggers must have indexed the projection: {indexed} rows")
    return state, int(pid), int(tid)


async def _largest_gap(work: Callable[[], object]) -> Tuple[float, float]:
    """Run ``work`` on the loop and report the largest watcher gap.

    Description: the watcher sleeps for TICK_SECONDS in a loop and
      records how long each wakeup actually took. While a coroutine holds
      the loop, the watcher cannot run at all, so the largest interval IS
      the block. Returns the elapsed time too, so a caller can confirm
      the work was not trivially fast.
    Inputs: work (callable) - returns an awaitable or a value.
    Output: (largest_gap_seconds, elapsed_seconds).
    Example: await _largest_gap(lambda: asyncio.sleep(0.1))
    """
    stop = False
    gaps = []

    async def watcher() -> None:
        last = time.perf_counter()
        while not stop:
            await asyncio.sleep(TICK_SECONDS)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    task = asyncio.ensure_future(watcher())
    await asyncio.sleep(0.01)  # let the watcher settle before measuring
    gaps.clear()
    started = time.perf_counter()
    result = work()
    if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
        await result
    elapsed = time.perf_counter() - started
    stop = True
    await task
    return (max(gaps) if gaps else 0.0), elapsed


def test_the_search_route_does_not_block_the_loop(populated, monkeypatch):
    """GET /archive/search runs its query in a thread.

    Description: the route already used asyncio.to_thread before this
      change; the query behind it is new, so the claim is re-measured
      rather than inherited.
    """
    state, pid, _ = populated
    monkeypatch.setattr(archive_search_routes, "state_dir", lambda: state)

    async def run() -> None:
        threaded, elapsed = await _largest_gap(
            lambda: archive_search_routes.get_search(
                q="tmux", project_id=pid, transcript_id=None, limit=50,
                cursor=None, scan_budget=64, scan_bytes=536870912,
                case_sensitive=False, snippets=True, role=None,
                block_type=None, tool_name=None, is_error=None,
                order="position"))
        assert elapsed > 0, "the route must actually have run"
        assert threaded < 0.05, (
            f"the search route blocked the loop for {threaded*1000:.1f} ms")

    asyncio.run(run())


def test_the_index_status_route_does_not_block_the_loop(populated, monkeypatch):
    """GET /archive/search/index runs TWO full traversals, in a thread.

    Description: this is the one that would hurt. On the real corpus its
      two COUNT(*) queries measured 37.08 ms; on a live 5.2 GB database
      they are much more, and on the loop that is the integrity_check
      defect all over again.
    """
    state, _, _ = populated
    monkeypatch.setattr(archive_search_index_routes, "state_dir", lambda: state)

    async def run() -> None:
        threaded, elapsed = await _largest_gap(
            archive_search_index_routes.get_search_index_status)
        assert elapsed > 0
        assert threaded < 0.05, (
            f"the index status route blocked the loop for "
            f"{threaded*1000:.1f} ms")

    asyncio.run(run())


def test_the_control_shows_the_same_work_on_the_loop_does_block(populated):
    """THE POSITIVE CONTROL: prove the measurement can detect a block.

    Description: without this, a box fast enough to make everything look
      instantaneous would pass the two tests above while proving nothing.
      Here the SAME two traversals run synchronously inside the coroutine
      - which is exactly what an ``async def`` with a synchronous body
      does - and the gap must be measurably worse.
    """
    state, _, _ = populated
    from src.core.archive_read import open_read_only
    from src.core.message_block_search_status import resolve_index_state

    def blocking() -> None:
        conn = open_read_only(state)
        try:
            # Repeated so the control is unambiguous on a fast box. This
            # is still exactly the work the route does, not a sleep.
            for _ in range(2000):
                resolve_index_state(conn)
        finally:
            conn.close()

    async def run() -> None:
        gap, elapsed = await _largest_gap(blocking)
        assert elapsed > 0.02, (
            f"the control must take real time to be a control; took "
            f"{elapsed*1000:.1f} ms")
        assert gap > 0.02, (
            f"the control ran on the loop for {elapsed*1000:.1f} ms and the "
            f"watcher only saw a {gap*1000:.1f} ms gap, so this file's "
            f"measurement cannot detect a block and the two tests above "
            f"prove nothing")

    asyncio.run(run())
