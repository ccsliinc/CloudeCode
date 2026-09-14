#!/usr/bin/env python3
"""Measure what an archive export does to the event loop, threaded or not.

WHY THIS SCRIPT EXISTS. This project has shipped loop-blocking work three
times: a ``PRAGMA integrity_check`` on the version endpoint blocked 14 of
every 20 seconds, and a synchronous listing pass cost 1008 ms per poll and
reached the user as typing lag. An archive export reconstructs a whole
transcript - 416.5 ms for the corpus's largest row - so the claim "it runs
in a thread" has to be MEASURED, not asserted.

HOW IT MEASURES. A heartbeat coroutine wakes every
``HEARTBEAT_INTERVAL_SECONDS`` and records how LATE it actually was. That
lateness is the only thing a user feels: while the loop is blocked it
cannot read the tmux pipe, deliver a keystroke, or answer another request.
The same export runs twice - once directly on the loop, once through
``asyncio.to_thread`` - and the LARGEST gap is reported for each, because
a p50 hides exactly the stall this is looking for.

READ-ONLY, ALWAYS. The live archive is opened ``mode=ro`` and never
written. Run it while the app is running; it cannot disturb anything.

Usage:
    venv/bin/python3 scripts/transcript-archive/measure_export_loop_gap.py
    venv/bin/python3 scripts/transcript-archive/measure_export_loop_gap.py --archive-id 16874
"""

from __future__ import annotations

import argparse
import asyncio
import sqlite3
import sys
import time
from pathlib import Path
from typing import List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.transcript_archive import export_archive  # noqa: E402

#: How often the heartbeat wakes. Small enough to catch a short stall,
#: large enough that the sampler is not itself the load.
HEARTBEAT_INTERVAL_SECONDS: float = 0.005

DEFAULT_ARCHIVE_DB = (
    Path.home() / "Library" / "Application Support" / "CloudeCode"
    / "cloude-archive.db"
)


def open_read_only(path: Path) -> sqlite3.Connection:
    """Open an archive database read-only, never for writing.

    Inputs: path (Path) - the cloude-archive.db file.
    Output: sqlite3.Connection with row_factory set.
    Raises: sqlite3.Error - the file could not be opened.
    Example: open_read_only(DEFAULT_ARCHIVE_DB)
    """
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def pick_archive_id(conn: sqlite3.Connection, explicit: Optional[int]) -> int:
    """Choose the row to measure: the caller's, else the largest in the corpus.

    Description: the largest row is the worst case and therefore the only
      one whose cost is worth quoting as a bound.
    Inputs: conn (sqlite3.Connection), explicit (int | None).
    Output: int - a transcript_archives.id.
    Raises: LookupError - the table is empty.
    Example: pick_archive_id(conn, None) -> 16874
    """
    if explicit is not None:
        return explicit
    row = conn.execute(
        "SELECT id FROM transcript_archives"
        " ORDER BY raw_byte_length DESC LIMIT 1"
    ).fetchone()
    if row is None:
        raise LookupError("transcript_archives is empty")
    return int(row["id"])


async def heartbeat(stop: asyncio.Event, gaps: List[float]) -> None:
    """Record how late each scheduled wake-up actually was, in milliseconds.

    Description: the lateness IS the loop gap. Anything blocking the loop
      delays this coroutine by exactly the time it was blocked.
    Inputs: stop (asyncio.Event) - set to finish. gaps (list) - appended to.
    Output: None.
    Example: asyncio.create_task(heartbeat(stop, gaps))
    """
    while not stop.is_set():
        started = time.perf_counter()
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
        late = (time.perf_counter() - started) - HEARTBEAT_INTERVAL_SECONDS
        gaps.append(late * 1000.0)


async def measure(
    db_path: Path, archive_id: int, threaded: bool
) -> Tuple[float, float, int]:
    """Run one export under a live heartbeat and report the worst loop gap.

    Description: opens its own connection inside whichever context the
      export runs in, because a sqlite3 connection belongs to the thread
      that created it.
    Inputs: db_path (Path), archive_id (int), threaded (bool) - True to
      run through asyncio.to_thread, False to run on the loop.
    Output: (max_gap_ms, export_ms, byte_count).
    Example: await measure(p, 16874, True) -> (3.1, 431.0, 244117661)
    """
    def work() -> Tuple[float, int]:
        conn = open_read_only(db_path)
        try:
            started = time.perf_counter()
            data = export_archive(conn, archive_id)
            return (time.perf_counter() - started) * 1000.0, len(data)
        finally:
            conn.close()

    gaps: List[float] = []
    stop = asyncio.Event()
    beat = asyncio.create_task(heartbeat(stop, gaps))
    await asyncio.sleep(0.05)  # let the heartbeat settle before measuring
    if threaded:
        export_ms, size = await asyncio.to_thread(work)
    else:
        export_ms, size = work()
    stop.set()
    await beat
    return (max(gaps) if gaps else 0.0), export_ms, size


async def main_async(args: argparse.Namespace) -> int:
    """Run both arms and print the comparison.

    Inputs: args (argparse.Namespace).
    Output: int - process exit code.
    """
    db_path = Path(args.db)
    if not db_path.exists():
        print(f"no archive database at {db_path}", file=sys.stderr)
        return 2
    conn = open_read_only(db_path)
    try:
        archive_id = pick_archive_id(conn, args.archive_id)
        row = conn.execute(
            "SELECT raw_byte_length, superseded_by_archive_id"
            "  FROM transcript_archives WHERE id = ?", (archive_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        print(f"no transcript_archives row with id {archive_id}",
              file=sys.stderr)
        return 2

    print(f"archive_id        {archive_id}")
    print(f"raw_byte_length   {row['raw_byte_length']:,}")
    print(f"chain walked      "
          f"{row['superseded_by_archive_id'] is not None}")
    print(f"heartbeat         every {HEARTBEAT_INTERVAL_SECONDS * 1000:.0f} ms")
    print()

    on_loop_gap, on_loop_ms, size = await measure(db_path, archive_id, False)
    threaded_gap, threaded_ms, _ = await measure(db_path, archive_id, True)

    print(f"{'arm':<22}{'max loop gap':>16}{'export':>14}")
    print(f"{'-' * 52}")
    print(f"{'on the event loop':<22}{on_loop_gap:>13.1f} ms"
          f"{on_loop_ms:>11.1f} ms")
    print(f"{'asyncio.to_thread':<22}{threaded_gap:>13.1f} ms"
          f"{threaded_ms:>11.1f} ms")
    print()
    print(f"reconstructed     {size:,} bytes")
    if threaded_gap > 0:
        print(f"improvement       {on_loop_gap / threaded_gap:.0f}x smaller "
              f"worst-case stall")
    return 0


def main() -> int:
    """Parse arguments and run.

    Inputs: none (reads sys.argv). Output: int - exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=str(DEFAULT_ARCHIVE_DB),
                        help="path to cloude-archive.db (opened read-only)")
    parser.add_argument("--archive-id", type=int, default=None,
                        help="row to measure (default: the largest)")
    return asyncio.run(main_async(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
