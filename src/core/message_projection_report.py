"""The projection pass's budget, its statuses, and the record it publishes.

SPLIT OUT FOR THE 500-LINE RULE, and the seam is a real one rather than a
cut: everything here is what a pass DECLARES about itself before and
after it runs, with no knowledge of sqlite, of the archive, or of the
message model. :mod:`src.core.message_projection` owns the doing.

THE COUNTS ARE EMITTED EVEN WHEN ZERO. A key that disappears at zero
makes "ran and found nothing" indistinguishable from "did not run", which
is the exact confusion this feature exists to end.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import structlog

logger = structlog.get_logger()

#: Schema floors, imported in spirit from the ingester and restated here
#: because this pass needs BOTH: v14 for the archive tables it reads and
#: v17 for the host dimension it attributes against. A datastore below
#: v17 can hold a perfect archive and still not be able to say which host
#: a transcript came from, and the browser's rail is built on exactly
#: that dimension, so projecting without it would fill the tables and
#: still render an empty rail.
MIN_ARCHIVE_SCHEMA: int = 14
MIN_HOST_SCHEMA: int = 17

#: How many archives one background pass may project. Set from the
#: measured throughput rather than from taste: at 0.84 MB/s and a median
#: archive well under a megabyte, 64 files is a pass of a few seconds in
#: steady state and a bounded one during a backfill. The pass also
#: carries a SECONDS budget, and whichever binds first wins.
DEFAULT_MAX_ARCHIVES: int = 64

#: Wall-clock ceiling for one pass. A budget in files alone cannot bound
#: a pass: one 244 MB transcript exists in this corpus, and sixty-four of
#: those is not a few seconds. The check is made BETWEEN files, so a
#: single file larger than the budget is still finished rather than
#: abandoned half written.
DEFAULT_MAX_SECONDS: float = 30.0

#: Pass-level statuses. Every terminating path sets exactly one, and
#: there is no path that reports ``ok`` without a pass having run.
STATUS_OK: str = "ok"
STATUS_CANCELLED: str = "cancelled"
STATUS_DISABLED: str = "disabled"
STATUS_DATASTORE_UNAVAILABLE: str = "datastore_unavailable"
STATUS_SCHEMA_TOO_OLD: str = "schema_too_old"
STATUS_MODEL_ABSENT: str = "model_absent"
STATUS_HOST_UNRESOLVED: str = "host_unresolved"
STATUS_FAILED: str = "failed"


@dataclass
class ProjectionReport:
    """What one projection pass did, in numbers a caller can assert on.

    Every field is of something that actually happened. ``pending_after``
    is the backlog measured AFTER the pass, so a reader can tell a pass
    that drained the queue from one that merely spent its budget.
    """

    started_at: str = ""
    finished_at: str = ""
    status: str = STATUS_OK
    reason: Optional[str] = None
    schema_version: Optional[int] = None
    projected: int = 0
    replaced: int = 0
    could_not_read: int = 0
    could_not_ingest: int = 0
    lines_written: int = 0
    raw_bytes_read: int = 0
    pending_before: Optional[int] = None
    pending_after: Optional[int] = None
    budget_archives: int = DEFAULT_MAX_ARCHIVES
    budget_seconds: float = DEFAULT_MAX_SECONDS
    budget_spent: Optional[str] = None
    wall_clock_seconds: float = 0.0
    refusals: List[Dict[str, str]] = field(default_factory=list)

    def to_record(self) -> dict:
        """Render this report as the JSON object published to disk.

        Description: the liveness artifact's whole content. Counts are
          emitted even when zero, because a reader has to be able to tell
          "ran and found nothing" from "did not run", and a key that
          disappears when it is zero makes that unsayable.
        Inputs: none.
        Output: dict.
        Example: ProjectionReport().to_record()["status"] -> 'ok'
        """
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "status": self.status,
            "reason": self.reason,
            "schema_version": self.schema_version,
            "projected": self.projected,
            "replaced": self.replaced,
            "could_not_read": self.could_not_read,
            "could_not_ingest": self.could_not_ingest,
            "lines_written": self.lines_written,
            "raw_bytes_read": self.raw_bytes_read,
            "pending_before": self.pending_before,
            "pending_after": self.pending_after,
            "budget_archives": self.budget_archives,
            "budget_seconds": self.budget_seconds,
            "budget_spent": self.budget_spent,
            "wall_clock_seconds": round(self.wall_clock_seconds, 3),
            "refusals": list(self.refusals[:20]),
        }




#: Switches the background projection off without switching the archive
#: off. Anything in ``_FALSEY`` (case-insensitive) disables it; every
#: other value including an empty string leaves it on, because a
#: malformed kill switch must fail towards the documented default rather
#: than towards silence. Matches ``corpus_ingest_task.ingest_enabled``'s
#: rule deliberately, so one reader learns both.
ENABLE_ENV: str = "CLOUDE_MESSAGE_PROJECTION"

#: Overrides :data:`DEFAULT_MAX_ARCHIVES` and :data:`DEFAULT_MAX_SECONDS`.
#: An operator draining a backlog raises these; nothing else should.
MAX_ARCHIVES_ENV: str = "CLOUDE_MESSAGE_PROJECTION_MAX_ARCHIVES"
MAX_SECONDS_ENV: str = "CLOUDE_MESSAGE_PROJECTION_MAX_SECONDS"

_FALSEY = frozenset({"0", "false", "off", "no"})
_TRUTHY = frozenset({"1", "true", "on", "yes"})


def projection_enabled() -> bool:
    """Report whether the background projection pass is switched on.

    Description: default ON. This switch does NOT gate the archive
      itself - :mod:`src.core.message_archive_flag` still does that, and
      ``run_projection_once`` checks it independently - so turning this
      off leaves the archive ingesting and stops only the join into the
      model. That is the knob an operator wants when a backfill is
      running from a script and the background pass would contend with it.
    Inputs: none (reads ``CLOUDE_MESSAGE_PROJECTION``).
    Output: bool.
    Example: projection_enabled() -> True
    """
    raw = os.environ.get(ENABLE_ENV)
    if raw is None:
        return True
    value = raw.strip().lower()
    if value in _TRUTHY:
        return True
    return value not in _FALSEY


def _resolve_positive(env_name: str, default, caster):
    """Read a positive numeric override, or fall back with a warning.

    Description: an unparseable or non-positive value is IGNORED rather
      than honoured, because a typo in a budget must not silently stop
      the pass doing any work at all - a zero budget looks exactly like a
      drained queue from the outside.
    Inputs: env_name (str), default (int | float), caster (callable).
    Output: the same type as ``default``.
    Example: _resolve_positive("NOPE", 5, int) -> 5
    """
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return default
    try:
        value = caster(raw)
    except ValueError:
        logger.warning("message_projection_budget_unparseable",
                       env=env_name, value=raw)
        return default
    if value <= 0:
        logger.warning("message_projection_budget_not_positive",
                       env=env_name, value=raw)
        return default
    return value


def resolve_max_archives() -> int:
    """Return the per-pass archive budget, honouring the env override.

    Inputs: none (reads ``CLOUDE_MESSAGE_PROJECTION_MAX_ARCHIVES``).
    Output: int - always positive.
    Example: resolve_max_archives() -> 64
    """
    return int(_resolve_positive(MAX_ARCHIVES_ENV, DEFAULT_MAX_ARCHIVES, int))


def resolve_max_seconds() -> float:
    """Return the per-pass wall-clock budget, honouring the env override.

    Inputs: none (reads ``CLOUDE_MESSAGE_PROJECTION_MAX_SECONDS``).
    Output: float - always positive.
    Example: resolve_max_seconds() -> 30.0
    """
    return float(_resolve_positive(MAX_SECONDS_ENV, DEFAULT_MAX_SECONDS, float))
