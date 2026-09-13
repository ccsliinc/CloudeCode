#!/usr/bin/env python3
"""Build or rebuild the FTS5 index over content-block text. DRY RUN BY DEFAULT.

The migration CREATES the index and does not POPULATE it, because a 1.80 s
write (measured over 112,623 blocks) may not sit inside a startup
transaction and on a corpus twenty times that size it is a boot that looks
hung. So a freshly migrated install reports ``never_built`` and search
REFUSES rather than answering zero hits. This is the named operation that
moves it to ``current``.

A dry run prints the backlog and the two shapes of work and writes
NOTHING. ``--apply`` does the work, in bounded passes, publishing a
liveness record on every terminating path including a failure - a
rebuilder that died and one with nothing to do are otherwise
indistinguishable, which is this project's recurring false-green.

    scripts/rebuild_block_search_index.py                    # dry run
    scripts/rebuild_block_search_index.py --apply
    scripts/rebuild_block_search_index.py --apply --rebuild  # from scratch

NEVER POINT THIS AT A LIVE cloude.db YOU CARE ABOUT WITHOUT A BACKUP.
``--rebuild`` empties the index first; that is recoverable by running it
again, but it leaves search refusing in between.
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
from src.core.message_block_search_index import (  # noqa: E402
    DEFAULT_MAX_ROWS,
    BlockSearchIndexUnavailable,
    build_pending,
    indexable_count,
    pending_count,
)
from src.core.message_block_search_state import (  # noqa: E402
    latest_path,
    read_liveness,
)
from src.core.message_block_search_status import (  # noqa: E402
    resolve_index_state,
)


def _resolve_db(explicit: Optional[str]) -> Path:
    """Pick the database file to work on.

    Description: an explicit path wins; otherwise the app's own state
      directory is resolved through Settings, so the script and the
      server agree about which file they mean.
    Inputs: explicit (str|None).
    Output: Path.
    Raises: SystemExit - the file does not exist, which is better than
      creating an empty database that looks like a healthy empty install.
    Example: _resolve_db(None) -> Path('~/.../cloude.db')
    """
    if explicit:
        path = Path(explicit).expanduser()
    else:
        from src.config import settings
        path = db_path_for(Path(settings.get_state_dir()))
    if not path.exists():
        raise SystemExit(f"no database at {path}")
    return path


def _report(conn: sqlite3.Connection, state_dir: Path) -> None:
    """Print what a run would do, against the caller's own rows.

    Inputs: conn (sqlite3.Connection), state_dir (Path).
    Output: None - prints.
    """
    state = resolve_index_state(conn, read_liveness(state_dir))
    print(f"index state        {state.state}")
    print(f"  reason           {state.reason}")
    print(f"  indexed rows     {state.indexed_rows}")
    print(f"  indexable blocks {state.block_rows}")
    print(f"  last build       {state.built_at}")
    print(f"  liveness file    {latest_path(state_dir)}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Entry point.

    Inputs: argv (Sequence[str]|None).
    Output: int - 0 success, 2 could-not-evaluate. 2 IS NOT 0, matching
      scripts/upgrade-verify.sh's convention in this repo.
    Example: main(["--apply"]) -> 0
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=None, help="path to cloude.db")
    parser.add_argument("--apply", action="store_true",
                        help="actually write; omit for a dry run")
    parser.add_argument("--rebuild", action="store_true",
                        help="empty the index first, a full rebuild")
    parser.add_argument("--batch", type=int, default=DEFAULT_MAX_ROWS,
                        help=f"rows per pass (default {DEFAULT_MAX_ROWS})")
    args = parser.parse_args(argv)

    path = _resolve_db(args.db)
    state_dir = path.parent
    conn = connect(path, create=False)
    try:
        try:
            _report(conn, state_dir)
            pending = pending_count(conn)
            total = indexable_count(conn)
        except BlockSearchIndexUnavailable as exc:
            print(f"\nCANNOT EVALUATE: {exc}")
            return 2
        print(f"\n{pending} of {total} indexable blocks are not indexed")
        if not args.apply:
            print("\nDRY RUN. Nothing was written. Re-run with --apply.")
            return 0
        started = time.perf_counter()
        done = 0
        reset = args.rebuild
        while True:
            with transaction(conn):
                report = build_pending(
                    conn, max_rows=args.batch, state_dir=state_dir,
                    reset=reset,
                )
            reset = False
            done += report.indexed
            print(f"  indexed {done}, {report.pending_after} pending")
            if report.pending_after == 0 or report.indexed == 0:
                break
        print(f"\ndone: {done} blocks in {time.perf_counter()-started:.2f}s")
        _report(conn, state_dir)
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
