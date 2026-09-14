"""Publish what the archive drain is doing, so silence is never ambiguous.

THE RULE THIS SERVES IS ALREADY IN THIS CODEBASE, in
``src/core/corpus_ingest_state.py``: an ingester that dies looks exactly
like one finding nothing new. Both produce no output and no alert. The
drain is a THREE AND A HALF HOUR write on a machine its owner is using,
so "no news" has to be distinguishable from "it fell over ninety minutes
ago" without attaching a debugger.

So the artifact is stamped on EVERY BATCH and on EVERY TERMINATING PATH,
including the failures, and what a reader trusts is its AGE. The four
freshness words are the ones this project already uses
(``current`` / ``stale`` / ``never_ran`` / ``cannot_determine``), reused
rather than re-invented, because a second vocabulary for the same idea is
how two readers come to disagree.

IT CARRIES A RATE AND AN ETA, AND BOTH ARE DERIVED FROM THIS RUN'S OWN
MEASUREMENTS rather than from the script's documented 0.84 MB/s. A
figure measured on 300 sampled archives is a fine planning number and a
poor progress bar: the owner's corpus is not uniform, and an ETA that
disagrees with what the machine is actually doing is worse than no ETA.
When too little has happened to derive a rate, both are None, which the
reader renders as "not yet known" rather than as zero.
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from src.core.corpus_ingest_state import classify_freshness, utc_now_iso
from src.core.json_artifact import atomic_write_json, read_json_object

#: Subdirectory of the state dir. Beside ``corpus-ingest/`` and
#: ``db-integrity/`` rather than inside either: three subsystems, three
#: dead-man's switches, and a reader must be able to tell which died.
DRAIN_DIRNAME = "message-drain"

LATEST_FILENAME = "latest.json"

#: Terminating statuses. ``running`` is the only non-terminal one, and it
#: is the reason the AGE of the record matters: a ``running`` record from
#: two hours ago means the process is gone, not that it is busy.
STATUS_RUNNING = "running"
STATUS_COMPLETE = "complete"
STATUS_INTERRUPTED = "interrupted"
STATUS_FAILED = "failed"

#: How stale a ``running`` record may be before a reader should assume the
#: process died. The drain's batches are bounded by BATCH_SECONDS, so a
#: gap much larger than one batch is not slowness.
STALE_AFTER_SECONDS = 300


def artifact_dir(state_dir: Path) -> Path:
    """Return the directory the drain publishes into.

    Inputs: state_dir (Path).
    Output: Path - not created here.
    Example: artifact_dir(Path("/s")).name  # 'message-drain'
    """
    return Path(state_dir) / DRAIN_DIRNAME


def latest_path(state_dir: Path) -> Path:
    """Return the drain's liveness artifact path.

    Inputs: state_dir (Path).
    Output: Path.
    Example: latest_path(Path("/s")).name  # 'latest.json'
    """
    return artifact_dir(state_dir) / LATEST_FILENAME


def publish(
    state_dir: Path, status: str, *,
    done: int, pending: Optional[int], elapsed_seconds: float,
    bytes_done: int = 0, detail: Optional[str] = None,
    archive_bytes: Optional[int] = None,
) -> Dict[str, Any]:
    """Stamp one progress record, whatever the outcome.

    Description: called after every batch and on every exit path. Never
      raises: a drain that died because its progress file was unwritable
      would be an absurd failure, so a write error is swallowed by
      ``atomic_write_json`` and the record is still returned to the
      caller for printing.
    Inputs: state_dir (Path), status (str - one of the STATUS_*
      constants), done (int - archives projected so far), pending (int |
      None - archives still to do, None when it could not be read),
      elapsed_seconds (float), bytes_done (int - raw transcript bytes
      processed, for the rate), detail (str | None), archive_bytes (int |
      None - current size of cloude-archive.db, so growth is observable
      without a second tool).
    Output: dict - the record as written.
    Example: publish(Path("/s"), STATUS_RUNNING, done=10, pending=90,
        elapsed_seconds=60.0)["status"]  # 'running'
    """
    rate = (done / elapsed_seconds) if elapsed_seconds > 1 and done else None
    eta = (pending / rate) if (rate and pending) else None
    record: Dict[str, Any] = {
        "status": status,
        "finished_at": utc_now_iso(),
        "archives_done": done,
        "archives_pending": pending,
        "elapsed_seconds": round(elapsed_seconds, 1),
        "archives_per_second": round(rate, 3) if rate else None,
        "eta_seconds": round(eta) if eta else None,
        "bytes_done": bytes_done,
        "archive_db_bytes": archive_bytes,
        "detail": detail,
        "pid": os.getpid(),
    }
    atomic_write_json(
        latest_path(state_dir), record,
        log_event="message_drain_artifact_write_failed",
    )
    return record


def read_status(
    state_dir: Path, now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Report what the drain is doing, including "it died".

    Description: the reader half. A ``running`` record older than
      :data:`STALE_AFTER_SECONDS` is reported as ``stale``, which is the
      only way a caller can tell a working drain from a dead one, since
      both write nothing new.
    Inputs: state_dir (Path), now (float | None - epoch seconds, for
      tests, a datetime).
    Output: dict with "freshness", "status" and the record itself under
      "record"; ``never_ran`` when there is no artifact at all.
    Example: read_status(Path("/s"))["freshness"]  # 'never_ran'
    """
    record = read_json_object(
        latest_path(state_dir),
        log_event="message_drain_artifact_unreadable",
    )
    if not record:
        return {"freshness": "never_ran", "status": None, "record": None}
    # Hand it the WHOLE record: classify_freshness reads finished_at
    # itself and owns the "timestamp unparseable" and "stamped in the
    # future" cases, both of which are cannot_determine rather than a
    # guess. Re-deriving that here would be a second vocabulary.
    freshness, age, reason = classify_freshness(
        record, now=now, stale_after_seconds=STALE_AFTER_SECONDS,
    )
    return {
        "freshness": freshness,
        "age_seconds": age,
        "reason": reason,
        "status": record.get("status"),
        "record": record,
    }
