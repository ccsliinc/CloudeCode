"""Archive freshness: how current the conversation archive is.

Its own module because freshness is the place this archive has ALREADY been
burned once -- it went two days stale with nobody noticing, because a stale
archive and a current one look identical until you query for something
recent. So the third outcome is applied to freshness itself: an empty or
unreadable ``ingest_runs`` table is ``unknown``, never ``current``.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass
from typing import Any, Optional

import structlog

from src.config import HistoryConfig

logger = structlog.get_logger()

# --- Freshness states -------------------------------------------------------
FRESHNESS_CURRENT = "current"
FRESHNESS_STALE = "stale"
FRESHNESS_UNKNOWN = "unknown"

#: ``ingest_runs.status`` values that mean a run finished successfully.
#: Measured against the live archive 2026-08-18: real rows carry
#: ``completed`` (and ``running`` for an in-flight one). ``ok`` is accepted
#: too because the working spec named it and a future writer may use it. A
#: ``running`` row is NOT evidence of a completed ingest and never counts.
INGEST_OK_STATUSES: frozenset[str] = frozenset({"completed", "ok"})


@dataclass(frozen=True)
class Freshness:
    """How current the archive is, as a measured fact plus a verdict.

    ``state`` is exactly one of ``current`` / ``stale`` / ``unknown``.
    ``unknown`` means the ``ingest_runs`` table held no completed run or
    could not be read; it is emphatically NOT ``current``.
    """

    state: str
    newest_message_at: Optional[str]
    last_ingest_completed_at: Optional[str]
    lag_seconds: Optional[int]
    threshold_seconds: int
    hard_threshold_seconds: int

    def to_dict(self) -> dict[str, Any]:
        """Render as the JSON block every endpoint carries.

        Returns:
            dict: plain JSON-serializable mapping.
        """
        return {
            "state": self.state,
            "newest_message_at": self.newest_message_at,
            "last_ingest_completed_at": self.last_ingest_completed_at,
            "lag_seconds": self.lag_seconds,
            "threshold_seconds": self.threshold_seconds,
            "hard_threshold_seconds": self.hard_threshold_seconds,
        }

    @property
    def is_hard_stale(self) -> bool:
        """True when the archive is too old to answer from confidently.

        Returns:
            bool: True only when a lag was actually measured and exceeds
            ``hard_threshold_seconds``. An UNKNOWN lag is not hard-stale --
            it is unknown, and gets said as such rather than escalated into
            a verdict nobody measured.
        """
        return self.lag_seconds is not None and self.lag_seconds > self.hard_threshold_seconds

def _parse_db_datetime(raw: Any) -> Optional[_dt.datetime]:
    """Parse an archive timestamp into a naive UTC datetime.

    The archive stores naive UTC strings (SQLAlchemy DateTime over SQLite).

    Args:
        raw: value straight out of a row; str, datetime, or None.

    Returns:
        datetime | None: naive UTC, or None when unparseable. None means
        "could not determine", and callers must not treat it as "now".
    """
    if raw is None:
        return None
    if isinstance(raw, _dt.datetime):
        return raw.replace(tzinfo=None)
    try:
        return _dt.datetime.fromisoformat(str(raw)).replace(tzinfo=None)
    except ValueError:
        return None


def read_freshness(db: Any, config: HistoryConfig) -> Freshness:
    """Measure how current the archive is.

    Reads the newest COMPLETED row in ``ingest_runs``. A ``running`` row is
    not evidence that anything finished, and an empty table is ``unknown``
    rather than ``current`` -- the third outcome applied to freshness
    itself, which is the exact failure this archive already had once when
    it went two days stale and looked identical to healthy.

    Args:
        db: an open read-only SQLAlchemy session.
        config: the ``history`` block, for the thresholds.

    Returns:
        Freshness: state plus the numbers it was derived from.
    """
    from sqlalchemy import text as sa_text

    placeholders = ", ".join(f"'{s}'" for s in sorted(INGEST_OK_STATUSES))
    try:
        completed_at = db.execute(
            sa_text(
                "SELECT completed_at FROM ingest_runs "
                f"WHERE completed_at IS NOT NULL AND status IN ({placeholders}) "
                "ORDER BY completed_at DESC LIMIT 1"
            )
        ).scalar()
        newest_message_at = db.execute(
            sa_text("SELECT max(timestamp) FROM messages")
        ).scalar()
    except Exception as exc:  # noqa: BLE001 - classified immediately below
        logger.warning("history_freshness_read_failed", error=str(exc))
        return Freshness(
            state=FRESHNESS_UNKNOWN,
            newest_message_at=None,
            last_ingest_completed_at=None,
            lag_seconds=None,
            threshold_seconds=config.stale_after_seconds,
            hard_threshold_seconds=config.hard_stale_after_seconds,
        )

    parsed = _parse_db_datetime(completed_at)
    if parsed is None:
        return Freshness(
            state=FRESHNESS_UNKNOWN,
            newest_message_at=str(newest_message_at) if newest_message_at else None,
            last_ingest_completed_at=None,
            lag_seconds=None,
            threshold_seconds=config.stale_after_seconds,
            hard_threshold_seconds=config.hard_stale_after_seconds,
        )

    now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
    lag = int((now - parsed).total_seconds())
    state = FRESHNESS_CURRENT if lag <= config.stale_after_seconds else FRESHNESS_STALE
    return Freshness(
        state=state,
        newest_message_at=str(newest_message_at) if newest_message_at else None,
        last_ingest_completed_at=str(completed_at),
        lag_seconds=lag,
        threshold_seconds=config.stale_after_seconds,
        hard_threshold_seconds=config.hard_stale_after_seconds,
    )


