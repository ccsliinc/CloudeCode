#!/usr/bin/env python3
"""Compress ``message_bodies.body_json`` in place. DRY RUN BY DEFAULT.

Measured on 216,716 real bodies, 2026-09-13: 756.8 MiB of ``body_json``
becomes 398.1 MiB at zlib level 6, a ratio of 0.526, for a decode cost of
6.30 us per body on read.

NO FLAG DAY. A row declares its own shape through
``typeof(body_json)`` - TEXT for the JSON, BLOB for the frame - so both
live side by side forever, the work remaining is
``WHERE typeof(body_json) = 'text'``, and an interrupted run resumes
exactly where it stopped. Stopping half way is a supported state, not a
broken one.

IT WILL NOT RUN WHILE SEARCH STILL GREPS THE COLUMN. The two changes are
coupled: the column was TEXT so ``INSTR`` could scan it. This script
therefore refuses unless the FTS5 block index exists, because compressing
bodies on an install whose search still reads them would blind it
silently. That check is a REFUSAL, not a warning.

    scripts/compress_message_bodies.py                 # dry run
    scripts/compress_message_bodies.py --apply

TAKE A BACKUP FIRST. This rewrites a column in place. Every rewrite is
verified by decoding it again and comparing before it is written, and a
mismatch aborts the pass, but a backup is what makes the whole operation
reversible rather than only each row.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional, Sequence

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.core.db import connect, db_path_for, transaction  # noqa: E402
from src.core.message_body_compress import (  # noqa: E402
    DEFAULT_BATCH_ROWS,
    MIN_COMPRESS_CHARS,
    compress_pending,
    pending_compression_count,
    shape_census,
)
from src.core.message_block_search_status import (  # noqa: E402
    index_table_exists,
)


def _resolve_db(explicit: Optional[str]) -> Path:
    """Pick the database file to work on.

    Inputs: explicit (str|None).
    Output: Path.
    Raises: SystemExit - the file does not exist.
    Example: _resolve_db("/tmp/x.db") -> Path('/tmp/x.db')
    """
    if explicit:
        path = Path(explicit).expanduser()
    else:
        from src.config import settings
        path = db_path_for(Path(settings.get_state_dir()))
    if not path.exists():
        raise SystemExit(f"no database at {path}")
    return path


def _print_census(conn: sqlite3.Connection) -> None:
    """Print the storage-shape census and the remaining work.

    Inputs: conn (sqlite3.Connection).
    Output: None - prints.
    """
    census = shape_census(conn)
    for shape in ("text", "blob"):
        block = census.get(shape)
        if block is None:
            print(f"  {shape:5s} rows 0")
            continue
        units = "chars" if shape == "text" else "bytes"
        print(f"  {shape:5s} rows {block['rows']:>10d}  "
              f"{block['stored_units']:>14d} {units} "
              f"({block['stored_units']/1048576:.1f} MiB)")
    print(f"  frame header {census['frame_header_bytes']} bytes per "
          f"compressed row")


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Entry point.

    Inputs: argv (Sequence[str]|None).
    Output: int - 0 success, 2 could-not-evaluate. 2 IS NOT 0.
    Example: main([]) -> 0
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=None, help="path to cloude.db")
    parser.add_argument("--apply", action="store_true",
                        help="actually write; omit for a dry run")
    parser.add_argument("--batch", type=int, default=DEFAULT_BATCH_ROWS,
                        help=f"rows per pass (default {DEFAULT_BATCH_ROWS})")
    args = parser.parse_args(argv)

    path = _resolve_db(args.db)
    conn = connect(path, create=False)
    try:
        print(f"database {path}")
        _print_census(conn)
        pending = pending_compression_count(conn)
        print(f"\n{pending} bodies of at least {MIN_COMPRESS_CHARS} "
              f"characters are stored uncompressed")
        if not index_table_exists(conn):
            print(
                "\nREFUSING: the FTS5 block-search index does not exist on "
                "this database, so search may still be reading body_json "
                "directly. Compressing now would blind it silently. Migrate "
                "to schema v27 and run scripts/rebuild_block_search_index.py "
                "first."
            )
            return 2
        if not args.apply:
            print("\nDRY RUN. Nothing was written. Re-run with --apply.")
            return 0
        started = time.perf_counter()
        rewritten = 0
        skipped = 0
        while True:
            with transaction(conn):
                report = compress_pending(conn, max_rows=args.batch)
            rewritten += report.rewritten
            skipped += report.skipped_not_smaller
            ratio = "n/a" if report.ratio is None else f"{report.ratio:.3f}x"
            print(f"  rewrote {rewritten} ({ratio} this pass), "
                  f"{report.pending_after} pending")
            if report.pending_after == 0 or (
                    report.rewritten == 0 and report.skipped_not_smaller == 0):
                break
        print(f"\ndone: {rewritten} rewritten, {skipped} left as text "
              f"because the frame was not smaller, in "
              f"{time.perf_counter()-started:.2f}s")
        _print_census(conn)
        print("\nVACUUM is NOT run here: it rewrites the whole file, needs "
              "as much free space again, and is an operator's decision. The "
              "pages this freed are reused by the database either way.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
