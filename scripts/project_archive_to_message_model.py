#!/usr/bin/env python3
"""Drain the archive-to-message-model projection backlog. DRY RUN BY DEFAULT.

WHY A SCRIPT AS WELL AS THE BACKGROUND PASS. The background pass in
``src/core/message_projection.py`` is budgeted, because a background pass
that is not budgeted is a background pass that eats the machine. That
makes it right for keeping up and wrong for catching up: on the owner's
corpus the FIRST run has 19,401 archives and 11,007,070,921 raw bytes in
front of it, measured 2026-09-10.

THE TWO NUMBERS YOU NEED BEFORE YOU RUN THIS, both measured on 300 real
archives sampled from that corpus rather than estimated:

  * THROUGHPUT 1.19 MB/s of raw transcript, MEASURED over the full run
    on 2026-09-14: 7,882,265,700 bytes in 6,630 s, 19,587 archives, one
    hour and fifty minutes. (The older figure here was 0.84 MB/s from a
    300-archive sample, which was pessimistic by 40 percent.) The cost is
    JSON parsing, the model's own per-line fidelity round trip, and the
    secret scan, which alone runs at 3.51 MB/s of GIL-holding Python.
  * SIZE 0.95x the raw bytes on disk, MEASURED OVER THE WHOLE CORPUS on
    2026-09-14: 10.42 GiB of raw transcript added 9.89 GiB of file. The
    model is SMALLER than the transcripts it holds, because
    message_bodies dedupes. The 1.50x this line used to carry came from
    a 300-archive sample and was wrong by 58 percent - it predicted 15.6
    GiB of growth against the 9.89 GiB that actually landed. A sample
    taken off the head of a queue ordered `ingested_at DESC` is not a
    sample of the corpus; see LESSONS.md.

That second number is why this is a script you run on purpose and not
something an upgrade does to your disk while you are not looking. The
dry run prints both, computed from YOUR datastore's own rows, and writes
nothing.

WHAT IT DOES NOT DO. It does not read ``~/.claude/projects``; every byte
comes from ``transcript_archives``, which is what makes a growing
transcript answerable (see the module docstring of
:mod:`src.core.message_projection`). It does not create the message model
schema - a datastore that has never had the archive switched on refuses
with ``model_absent``, by name. It never writes to a database you did not
name, and ``--state-dir`` has no default that points at anything live
unless you are running it on the machine that owns the install.

Usage:
  ./venv/bin/python3 scripts/project_archive_to_message_model.py \\
      --state-dir "$HOME/Library/Application Support/CloudeCode"
  # add --apply to actually write, --limit N to stop after N archives
"""

from __future__ import annotations

import argparse
from contextlib import closing
import os
import signal
import sys
import time
from pathlib import Path
from threading import Event
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.core import message_projection_ledger as ledger  # noqa: E402
from src.core.db import (  # noqa: E402
    DatastoreError, connect, connect_archive_only, db_path_for,
    read_schema_version, table_exists,
)
from src.core import message_drain_liveness as liveness
from src.core.archive_db_partition import ARCHIVE_DB_FILENAME, archive_db_path_for
from src.core.message_projection import (  # noqa: E402
    STATUS_OK, run_projection_once,
)

#: Measured on 300 real archives from the owner's corpus, 2026-09-13.
#: Quoted here so the dry run can size YOUR backlog rather than print a
#: number somebody remembered. Re-measure before trusting either on very
#: different hardware; the script says so in its output.
MEASURED_BYTES_PER_SECOND: float = 835_000.0
MEASURED_DB_BYTES_PER_RAW_BYTE: float = 1.50

#: One batch of the drain. Larger than the background pass's budget on
#: purpose - this is the catching-up tool - but still bounded, so a
#: Ctrl-C lands within one batch and the ledger is consistent either way.
BATCH_ARCHIVES: int = 256
BATCH_SECONDS: float = 600.0


def _human(num: float) -> str:
    """Render a byte count in the largest unit that keeps it readable.

    Inputs: num (float) - bytes.
    Output: str.
    Example: _human(1536) -> '1.5 KiB'
    """
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(num) < 1024.0 or unit == "TiB":
            return f"{num:,.1f} {unit}"
        num /= 1024.0
    return f"{num:,.1f} TiB"


def survey(state_dir: Path) -> dict:
    """Measure the backlog without writing anything.

    Description: one connection, three statements. Reports the three
      outcomes a caller has to tell apart - the datastore could not be
      opened, the message model is not present, or here is the backlog -
      rather than returning zero for all three.
    Inputs: state_dir (Path).
    Output: dict with 'status' and, when measured, 'pending',
      'pending_bytes', 'archives' and 'modelled'.
    Example: survey(Path("/nope"))["status"] -> 'datastore_unavailable'
    """
    # TWO CONNECTIONS, for the reason in db.connect_archive_only: the
    # schema version is in cloude.db and every row this surveys is in
    # the archive. Holding both on one connection is what made a
    # projection transaction take cloude.db's write lock.
    try:
        with closing(connect(db_path_for(state_dir), create=False)) as app:
            version = read_schema_version(app)
    except DatastoreError as exc:
        return {"status": "datastore_unavailable", "reason": str(exc)}
    if not version.readable or version.value is None:
        return {"status": "datastore_unavailable",
                "reason": "meta.schema_version is unreadable"}
    try:
        conn = (
            connect_archive_only(state_dir)
            if archive_db_path_for(state_dir).exists()
            else connect(db_path_for(state_dir), create=False)
        )
    except DatastoreError as exc:
        return {"status": "datastore_unavailable", "reason": str(exc)}
    with conn:
        present = (table_exists(conn, "message_transcripts") or None)
        if present is None:
            return {"status": "model_absent", "schema_version": version.value}
        ledger.ensure_ledger(conn)
        archives, arch_bytes = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(raw_byte_length), 0) "
            "FROM transcript_archives WHERE superseded_by_archive_id IS NULL"
        ).fetchone()
        pending, pending_bytes = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(a.raw_byte_length), 0) "
            "FROM transcript_archives a "
            f"LEFT JOIN {ledger.LEDGER_TABLE} l ON l.source_path = a.source_path "
            "WHERE a.superseded_by_archive_id IS NULL "
            "AND (l.source_path IS NULL OR l.content_sha256 <> a.content_sha256)"
        ).fetchone()
        modelled = conn.execute(
            "SELECT COUNT(*) FROM message_transcripts").fetchone()[0]
    return {
        "status": "measured",
        "schema_version": version.value,
        "archives": int(archives),
        "archive_bytes": int(arch_bytes),
        "pending": int(pending),
        "pending_bytes": int(pending_bytes),
        "modelled": int(modelled),
    }


def _print_survey(state_dir: Path, found: dict) -> None:
    """Print a survey, with its projected cost, to stdout.

    Inputs: state_dir (Path), found (dict from :func:`survey`).
    Output: None.
    Example: _print_survey(Path("/s"), survey(Path("/s")))
    """
    print(f"datastore            {db_path_for(state_dir)}")
    if found["status"] != "measured":
        print(f"status               {found['status']}")
        if found.get("reason"):
            print(f"reason               {found['reason']}")
        return
    print(f"schema_version       {found['schema_version']}")
    print(f"current archives     {found['archives']:,}"
          f"  ({_human(found['archive_bytes'])} raw)")
    print(f"message transcripts  {found['modelled']:,}")
    print(f"pending              {found['pending']:,}"
          f"  ({_human(found['pending_bytes'])} raw)")
    seconds = found["pending_bytes"] / MEASURED_BYTES_PER_SECOND
    grows = found["pending_bytes"] * MEASURED_DB_BYTES_PER_RAW_BYTE
    print(f"projected time       ~{seconds / 3600:.2f} h"
          f"   (at the measured {MEASURED_BYTES_PER_SECOND / 1e6:.2f} MB/s)")
    print(f"projected db growth  ~{_human(grows)}"
          f"   (at the measured {MEASURED_DB_BYTES_PER_RAW_BYTE:.2f}x)")
    print("both figures are EXTRAPOLATIONS from a 300-archive sample on one "
          "machine, not measurements of this run")


def main(argv: Optional[list] = None) -> int:
    """Survey the backlog and, with --apply, drain it in bounded batches.

    Inputs: argv (list[str] | None).
    Output: int - process exit code. 0 success or a clean dry run, 2 a
      state that could not be evaluated, 1 a run that ended with a
      refusal. 2 IS NOT 0: "could not look" is not "nothing to do".
    Example: main(["--state-dir", "/s"]) -> 0
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True, type=Path,
                        help="the install's state directory holding cloude.db")
    parser.add_argument("--apply", action="store_true",
                        help="actually write; without it this only surveys")
    parser.add_argument("--limit", type=int, default=0,
                        help="stop after this many archives (0 = no limit)")
    args = parser.parse_args(argv)

    found = survey(args.state_dir)
    _print_survey(args.state_dir, found)
    if found["status"] != "measured":
        return 2
    if not args.apply:
        print("\nDRY RUN. Nothing was written. Re-run with --apply to drain.")
        return 0
    if found["pending"] == 0:
        print("\nnothing pending; the model is current with the archive")
        return 0

    cancel = Event()

    def _stop(_signum, _frame) -> None:
        """Ask the pass to stop at its next file boundary."""
        print("\ninterrupt received; finishing the current file", flush=True)
        cancel.set()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    # LIVENESS. A three and a half hour write must not be silent: an
    # ingester that dies looks exactly like one finding nothing new. The
    # artifact is stamped after EVERY batch and on EVERY exit path below,
    # and its AGE is what tells a reader which of those happened.
    arch_db = args.state_dir / ARCHIVE_DB_FILENAME

    def _arch_bytes():
        try:
            return arch_db.stat().st_size
        except OSError:
            return None

    done = 0
    raw_done = 0
    raw_left = found["pending_bytes"]
    started = time.monotonic()
    liveness.publish(
        args.state_dir, liveness.STATUS_RUNNING, done=0,
        pending=found["pending"], elapsed_seconds=0.0,
        bytes_done=0, bytes_pending=raw_left,
        archive_bytes=_arch_bytes(), detail="starting",
    )
    while not cancel.is_set():
        budget = BATCH_ARCHIVES
        if args.limit:
            budget = min(budget, args.limit - done)
            if budget <= 0:
                break
        report = run_projection_once(
            args.state_dir, cancel=cancel, max_archives=budget,
            max_seconds=BATCH_SECONDS, respect_flag=False,
        )
        done += report.projected + report.replaced
        raw_done += report.raw_bytes_read
        raw_left = max(0, raw_left - report.raw_bytes_read)
        print(f"[{time.monotonic() - started:8.1f}s] "
              f"status={report.status} projected={report.projected} "
              f"replaced={report.replaced} refused="
              f"{report.could_not_read + report.could_not_ingest} "
              f"pending={report.pending_after}", flush=True)
        liveness.publish(
            args.state_dir, liveness.STATUS_RUNNING, done=done,
            pending=report.pending_after,
            elapsed_seconds=time.monotonic() - started,
            bytes_done=raw_done, bytes_pending=raw_left,
            archive_bytes=_arch_bytes(),
        )
        for refusal in report.refusals:
            print(f"    REFUSED {refusal['source_path']}: "
                  f"{refusal['outcome']} {refusal['reason']}")
        # THE INTERRUPT BRANCH IS TESTED FIRST, AND THAT ORDER IS THE
        # WHOLE POINT. A cancelled pass returns a status that is not
        # STATUS_OK, so a bare `!= STATUS_OK` check catches a deliberate
        # SIGTERM and publishes FAILED for it. Measured 2026-09-14: a
        # clean operator pause at a file boundary was recorded as
        # `status: failed`, which is how a reader learns to distrust the
        # artifact, and it was reported upward as a crash. An asked-for
        # stop is a named outcome, never a fault.
        if cancel.is_set():
            break
        if report.status != STATUS_OK:
            print(f"stopping: {report.reason}")
            liveness.publish(
                args.state_dir, liveness.STATUS_FAILED, done=done,
                pending=report.pending_after,
                elapsed_seconds=time.monotonic() - started,
                bytes_done=raw_done, bytes_pending=raw_left,
                archive_bytes=_arch_bytes(), detail=report.reason,
            )
            return 1
        if (report.pending_after or 0) == 0:
            break

    liveness.publish(
        args.state_dir,
        liveness.STATUS_INTERRUPTED if cancel.is_set()
        else liveness.STATUS_COMPLETE,
        done=done, pending=survey(args.state_dir).get("pending"),
        elapsed_seconds=time.monotonic() - started,
        bytes_done=raw_done, bytes_pending=raw_left,
        archive_bytes=_arch_bytes(),
        detail="stopped at a file boundary; re-run to resume"
        if cancel.is_set() else None,
    )
    print("\nafter:")
    _print_survey(args.state_dir, survey(args.state_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
