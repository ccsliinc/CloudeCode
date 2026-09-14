"""The read-only status block for the archive-to-message-model projection.

THIS BLOCK EXISTS BECAUSE ``model_not_populated`` WAS TRUE AND NOBODY
COULD ACT ON IT. ``corpus_status._gate_findings_block`` has reported that
word honestly since it was written, and it is still the right answer for
a model holding nothing. What it could not say is WHY nothing is there,
or how far off "something" is: an install with 19,401 archives and a
projection that has never run reads identically to one with an empty
corpus. This block is the missing half - the backlog, the last pass, and
how old that pass is.

PURE READ. It opens one connection, runs two statements, and reads one
small JSON file. Nothing here walks the corpus, projects anything, or
writes. It is called from a request handler, so that discipline is not
optional: this project has already paid for a ``PRAGMA integrity_check``
on a request path (measured: 14 seconds of blocked event loop in every
20).
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any, Dict

from src.core import message_projection_state as state_io
from src.core.db import DatastoreError, connect, db_path_for, read_schema_version
from src.core.message_projection_ledger import LEDGER_TABLE, ledger_summary
from src.core.message_projection_report import MIN_HOST_SCHEMA
from src.core.db import table_exists

#: Statuses this block may report. ``never_projected`` is deliberately
#: distinct from ``measured`` with a zero count: the first says the join
#: has not been wired up on this install, the second says it ran and the
#: queue is empty, and treating them as one is the whole defect this
#: module set closes.
STATUS_MEASURED: str = "measured"
STATUS_NEVER_PROJECTED: str = "never_projected"
STATUS_SCHEMA_TOO_OLD: str = "schema_too_old"
STATUS_CANNOT_DETERMINE: str = "cannot_determine"


def projection_block(
    state_dir: Path, *, now_epoch: float = None,
    stale_after_seconds: int = state_io.DEFAULT_STALE_AFTER_SECONDS,
) -> Dict[str, Any]:
    """Report what the projection has done and what it has left to do.

    Description: four outcomes, never two. ``cannot_determine`` is
      returned for an unopenable datastore or an unreadable schema
      version and never collapsed into "nothing projected", because not
      having looked is not evidence of absence. The ledger's absence is
      ``never_projected``, which is a measurement: the table is created
      by the first pass, so its absence proves no pass has completed here.
    Inputs: state_dir (Path), now_epoch (float | None - unix seconds,
      defaults to now), stale_after_seconds (int).
    Output: dict with 'status' and, when measured, 'ledger', 'freshness',
      'age_seconds' and 'last_run'.
    Example: projection_block(Path("/nonexistent"))["status"]
      -> 'cannot_determine'
    """
    epoch = time.time() if now_epoch is None else now_epoch
    freshness, age = state_io.freshness(
        state_dir, now_epoch=epoch, stale_after_seconds=stale_after_seconds,
    )
    base: Dict[str, Any] = {
        "freshness": freshness,
        "age_seconds": None if age is None else round(age, 1),
        "stale_after_seconds": stale_after_seconds,
        "last_run": state_io.read_liveness(state_dir),
        "liveness_artifact": str(state_io.latest_path(state_dir)),
    }
    try:
        conn = connect(db_path_for(state_dir), create=False)
    except DatastoreError as exc:
        return {**base, "status": STATUS_CANNOT_DETERMINE, "reason": str(exc)}
    with closing(conn):
        version = read_schema_version(conn)
        if not version.readable or version.value is None:
            return {
                **base, "status": STATUS_CANNOT_DETERMINE,
                "reason": "meta.schema_version is unreadable",
            }
        if version.value < MIN_HOST_SCHEMA:
            return {
                **base, "status": STATUS_SCHEMA_TOO_OLD,
                "schema_version": version.value,
                "reason": (
                    f"schema v{version.value} predates the v{MIN_HOST_SCHEMA} "
                    "host dimension the browser's rail is built on"
                ),
            }
        try:
            exists = (table_exists(conn, LEDGER_TABLE) or None)
            if exists is None:
                return {
                    **base, "status": STATUS_NEVER_PROJECTED,
                    "schema_version": version.value,
                    "reason": (
                        f"{LEDGER_TABLE} does not exist, so no projection "
                        "pass has ever completed on this datastore; the "
                        "archive may be perfectly current and the history "
                        "browser will still render nothing"
                    ),
                }
            summary = ledger_summary(conn)
        except sqlite3.Error as exc:
            return {
                **base, "status": STATUS_CANNOT_DETERMINE,
                "reason": f"{type(exc).__name__}: {exc}",
            }
    return {
        **base,
        "status": STATUS_MEASURED,
        "schema_version": version.value,
        "ledger": summary,
    }
