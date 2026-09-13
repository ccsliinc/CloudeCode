#!/usr/bin/env python3
"""Move the transcript archive out of cloude.db, or put it back.

DRY RUN IS THE DEFAULT AND IS THE ONLY MODE THAT NEEDS NO ARGUMENT,
following ``scripts/backfill_claude_session_uuid.py`` and
``scripts/classify_session_kind.py`` rather than inventing a convention.
``--apply`` exists so a human can act on a report he has read.

WHAT THIS DOES, AND WHY. The archive family is 99.9858 percent of
cloude.db; the app's own irreplaceable state is 712 KiB. The archive is
rebuildable from ``~/.claude/projects`` and the state is not, so they
have different backup needs, different integrity-check costs and, once
the history browser is its own module, different owners.

    venv/bin/python3 scripts/split_archive_db.py                # read this
    venv/bin/python3 scripts/split_archive_db.py --apply        # do it
    venv/bin/python3 scripts/split_archive_db.py --reverse      # plan undo
    venv/bin/python3 scripts/split_archive_db.py --reverse --apply

STOP THE SERVER FIRST. It is not required and it is not enforced, because
a reliable "is the server running" reading is not available here and a
rung that guesses would be worse than none. What IS enforced is the
consequence: source row counts are taken at plan time and again after the
copy, and a table that moved refuses the drop. The copy is re-runnable.

``transcript_root_decisions`` IS NOT REBUILDABLE. It holds 23,023 human
and machine attribution decisions that exist nowhere in
``~/.claude/projects``. This script COPIES, and never re-ingests, for
exactly that reason. If you are ever tempted to "just rebuild the archive
instead", that table is why you must not.

VACUUM IS NOT RUN HERE. Dropping the tables does not shrink cloude.db;
the pages are freed for reuse. Reclaiming them rewrites the whole file
and is the point after which reversing stops being cheap, so it is a
separate deliberate step:

    venv/bin/python3 scripts/split_archive_db.py --vacuum
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.core.archive_db_split_run import run_split  # noqa: E402
from src.core.archive_db_unsplit import run_unsplit  # noqa: E402
from src.core.db import db_path_for  # noqa: E402


def default_state_dir() -> str:
    """Resolve the state directory the app itself would use.

    Description: RESOLVED LAZILY, and only when ``--state-dir`` was not
      given. Importing ``src.config`` runs Settings validation, which on
      a checkout with no ``.env`` prints a multi-line configuration
      banner to stdout and would bury this script's own report. An
      operator who named a directory should never pay for that, so the
      import happens inside this function and only when it is called.
      Falls back to the documented macOS location when settings will not
      load, because being unable to read a config is not a reason to
      refuse a path the user already supplied.
    Inputs: none.
    Output: str - a directory path.
    Example: default_state_dir()
    """
    try:
        from src.config import Settings

        return str(Settings().get_state_dir())
    except Exception:  # noqa: BLE001 - a broken config must not block --help
        return str(
            Path.home() / "Library" / "Application Support" / "CloudeCode"
        )


def human_report(report: Any, *, reverse: bool) -> str:
    """Render a split or unsplit report for a human to read.

    Description: leads with the refusals, because that is the only part
      that changes what the operator should do next.
    Inputs: report (SplitReport | UnsplitReport), reverse (bool).
    Output: str.
    Example: print(human_report(run_split(state), reverse=False))
    """
    lines = []
    head = "REVERSE" if reverse else "FORWARD"
    mode = "APPLIED" if report.apply else "DRY RUN, nothing was written"
    lines.append(f"archive database split: {head} [{mode}]")
    lines.append("")

    if reverse:
        lines.append(f"  tables to restore : {len(report.tables)}")
        if report.constraints_restored:
            lines.append(
                f"  constraints back  : "
                f"{sum(len(v) for v in report.constraints_restored.values())} "
                f"across {len(report.constraints_restored)} tables"
            )
        if report.restored_counts:
            lines.append(f"  rows restored     : "
                         f"{sum(report.restored_counts.values()):,}")
        for rung, detail in report.refusals:
            lines.append(f"\n  REFUSED [{rung}]\n    {detail}")
        if not report.refusals:
            lines.append("\n  no refusals")
        return "\n".join(lines)

    lines.append(f"  archive tables    : {len(report.archive_tables)}")
    lines.append(f"  app tables (stay) : {len(report.app_tables)}")
    lines.append(f"  archive rows      : {sum(report.source_counts.values()):,}")
    lines.append(f"  archive bytes     : {report.archive_bytes:,}")
    if report.free_bytes is not None:
        lines.append(f"  free on volume    : {report.free_bytes:,}")
    lines.append(f"  crossing keys     : {len(report.crossings)}")
    for child, column, parent in report.crossings:
        orphans = report.orphans.get(f"{child}.{column}")
        lines.append(
            f"      {child}.{column} -> {parent}.id   orphans={orphans}"
        )
    if report.references_removed:
        lines.append(f"  refs stripped     : {report.references_removed}")
    if report.content_checked:
        lines.append(
            f"  content verified  : {report.content_checked} sampled, "
            f"{len(report.content_mismatches)} mismatched"
        )
    if report.dropped:
        lines.append(f"  dropped from main : {len(report.dropped)} objects")

    for refusal in report.refusals:
        kind = "REFUSED" if refusal.blocking else "NOTE (unchecked)"
        lines.append(f"\n  {kind} [{refusal.rung}]\n    {refusal.detail}")
    if not report.refusals:
        lines.append("\n  no refusals")
    if not report.apply and not report.refused:
        lines.append(
            "\nNothing was written. Re-run with --apply once you have read "
            "the above,\nand stop the server first."
        )
    return "\n".join(lines)


def run_vacuum(state_dir: Path) -> int:
    """Reclaim the space the dropped archive tables left behind.

    Description: SEPARATE FROM THE MIGRATION ON PURPOSE. It rewrites the
      whole file, needs free disk equal to the result, and is the point
      after which the reverse stops being cheap. Refuses while the
      archive tables are still in cloude.db, because vacuuming then would
      spend the cost and reclaim nothing.
    Inputs: state_dir (Path).
    Output: int - process exit code.
    Example: run_vacuum(Path("/s"))  # 0
    """
    db = db_path_for(state_dir)
    conn = sqlite3.connect(db, isolation_level=None)
    try:
        still_there = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' "
            "AND name LIKE 'transcript_%'"
        ).fetchone()[0]
        if still_there:
            print(
                f"refusing: cloude.db still holds {still_there} transcript "
                "tables, so a VACUUM would reclaim nothing. Run the split "
                "with --apply first."
            )
            return 2
        before = db.stat().st_size
        conn.execute("VACUUM")
        # MEASURE AFTER THE CHECKPOINT, NOT BEFORE IT. In WAL mode the
        # rewritten pages land in the -wal sidecar and the main file does
        # not shrink until they are checkpointed back into it, which
        # otherwise happens on close. Reading st_size here without this
        # reports the PRE-vacuum size and tells the operator the vacuum
        # reclaimed nothing, which is how this was caught: a real run
        # printed "183,791,616 -> 183,791,616" for a file that was
        # already 696 KiB on disk a moment later.
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()
    after = db.stat().st_size
    print(f"cloude.db {before:,} -> {after:,} bytes ({after / 1024:.1f} KiB)")
    return 0


def main(argv: list | None = None) -> int:
    """Command-line surface. Dry run is the default; ``--apply`` is opt-in.

    Inputs: argv (list | None) - defaults to sys.argv[1:].
    Output: int - 0 clean, 1 refused, 2 could not evaluate.
    Example: main(["--json"])
    """
    parser = argparse.ArgumentParser(
        description="Split the transcript archive out of cloude.db.",
    )
    parser.add_argument(
        "--state-dir", default=None,
        help="directory holding cloude.db (default: the app's own state dir)",
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="perform the migration (default is a dry run)",
    )
    parser.add_argument(
        "--reverse", action="store_true",
        help="put the archive back into cloude.db",
    )
    parser.add_argument(
        "--vacuum", action="store_true",
        help="reclaim freed space after a completed split, then exit",
    )
    parser.add_argument(
        "--content-sample", type=int, default=None,
        help="rows to compare byte for byte (forward only)",
    )
    parser.add_argument("--json", action="store_true", help="machine-readable")
    args = parser.parse_args(argv)

    state_dir = Path(args.state_dir or default_state_dir())
    if not db_path_for(state_dir).exists():
        print(f"no cloude.db at {state_dir}", file=sys.stderr)
        return 2

    if args.vacuum:
        return run_vacuum(state_dir)

    if args.reverse:
        report = run_unsplit(state_dir, apply=args.apply)
        refused = report.refused
    else:
        report = run_split(
            state_dir, apply=args.apply, content_sample=args.content_sample,
        )
        refused = report.refused

    if args.json:
        payload: Dict[str, Any] = dict(vars(report))
        print(json.dumps(payload, default=str, indent=2))
    else:
        print(human_report(report, reverse=args.reverse))

    return 1 if refused else 0


if __name__ == "__main__":
    raise SystemExit(main())
