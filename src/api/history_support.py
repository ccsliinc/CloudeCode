"""Response envelope and archive-reader plumbing for the history API.

Split out of ``src/api/history.py`` so that module is nothing but route
definitions. What lives here is the part that must be IDENTICAL across every
endpoint: the three-outcome envelope, the freshness caveats, and the
open-then-check-hard-staleness sequence. Retyping any of those five times is
how two endpoints end up disagreeing about what "ok" means.
"""

from __future__ import annotations

from typing import Any, Optional

import structlog

from src.config import HistoryConfig
from src.core.history_db import (
    REASON_INDEX_STALE,
    REASON_MESSAGES,
    HistoryUnavailable,
    get_history_config,
    open_archive,
)
from src.core.history_freshness import FRESHNESS_UNKNOWN, Freshness, read_freshness
from src.core.history_queries import build_queries

logger = structlog.get_logger()

STATUS_OK = "ok"
STATUS_NO_MATCHES = "no_matches"
STATUS_UNAVAILABLE = "unavailable"

#: Freshness caveat text. A stale archive still answers -- degrading a
#: working read to unavailable at 6h would burn the signal's credibility
#: for no gain -- but it says so on every response.
_STALE_CAVEAT = (
    "The archive was last ingested {lag} ago, so anything more recent than "
    "that is missing from this answer."
)
_UNKNOWN_FRESHNESS_CAVEAT = (
    "The archive's ingest history could not be read, so how current this "
    "answer is CANNOT BE DETERMINED. It is not known to be current."
)


def unavailable_body(reason: str, message: Optional[str] = None, **extra: Any) -> dict:
    """Build an ``unavailable`` envelope.

    Args:
        reason: one of the ``REASON_*`` constants.
        message: human sentence; defaults to the reason's standard text.
        **extra: additional top-level fields (e.g. ``freshness``).

    Returns:
        dict: the response body.
    """
    body = {
        "status": STATUS_UNAVAILABLE,
        "reason": reason,
        "message": message or REASON_MESSAGES.get(reason, "The archive could not be read."),
    }
    body.update(extra)
    return body


def caveats_for(freshness: Freshness) -> list[str]:
    """Derive the caveat list a successful answer must carry.

    Args:
        freshness: the measured freshness of the archive.

    Returns:
        list[str]: zero or more human sentences. Empty means the archive
        was measured and found current, which is a different thing from
        having no information about it.
    """
    if freshness.state == FRESHNESS_UNKNOWN:
        return [_UNKNOWN_FRESHNESS_CAVEAT]
    if freshness.state != "current" and freshness.lag_seconds is not None:
        return [_STALE_CAVEAT.format(lag=humanize_seconds(freshness.lag_seconds))]
    return []


def humanize_seconds(seconds: int) -> str:
    """Render a lag in seconds as a short human phrase.

    Args:
        seconds: elapsed seconds, non-negative.

    Returns:
        str: e.g. "3 hours", "2 days".
    """
    if seconds < 90:
        return f"{seconds} seconds"
    if seconds < 5400:
        return f"{seconds // 60} minutes"
    if seconds < 172800:
        return f"{seconds // 3600} hours"
    return f"{seconds // 86400} days"


def ok_body(freshness: Freshness, **payload: Any) -> dict:
    """Build an ``ok`` envelope carrying freshness and any caveats.

    Args:
        freshness: measured freshness.
        **payload: the endpoint's data fields.

    Returns:
        dict: the response body.
    """
    body: dict[str, Any] = {
        "status": STATUS_OK,
        "freshness": freshness.to_dict(),
        "caveats": caveats_for(freshness),
    }
    body.update(payload)
    return body


class ArchiveReader:
    """Context manager pairing an open archive session with its freshness.

    Every endpoint needs both, and needs the hard-stale check applied
    identically, so the sequence lives in one place rather than being
    retyped (and eventually diverging) five times.
    """

    def __init__(self, config: Optional[HistoryConfig] = None) -> None:
        """Bind to a config block.

        Args:
            config: the ``history`` block. Every route passes one
                explicitly; the settings fallback exists only for ad-hoc
                callers and is not the path any endpoint takes.
        """
        self._config = config if config is not None else get_history_config()
        self._ctx: Any = None

    def __enter__(self) -> tuple[Any, Any, Freshness]:
        """Open the archive and measure freshness.

        Returns:
            tuple: (queries, session, freshness).

        Raises:
            HistoryUnavailable: including ``index_stale`` when the archive
                is past ``hard_stale_after_seconds``, at which point a
                confident answer is worse than none.
        """
        self._ctx = open_archive(self._config)
        db = self._ctx.__enter__()
        freshness = read_freshness(db, self._config)
        if freshness.is_hard_stale:
            self._ctx.__exit__(None, None, None)
            raise HistoryUnavailable(
                REASON_INDEX_STALE,
                f"{REASON_MESSAGES[REASON_INDEX_STALE]} Last completed ingest: "
                f"{freshness.last_ingest_completed_at} "
                f"({humanize_seconds(freshness.lag_seconds or 0)} ago).",
            )
        return build_queries(db), db, freshness

    def __exit__(self, exc_type, exc, tb) -> bool:
        """Close the archive session."""
        if self._ctx is not None:
            self._ctx.__exit__(exc_type, exc, tb)
        return False


def attach_tool_counts(stubs: list[dict], tool_seqs: list[int]) -> None:
    """Count tool calls falling between consecutive user turns.

    Both inputs are already sorted by ``seq_in_file``, so this is a single
    merge pass rather than a query per turn.

    Args:
        stubs: user-turn stubs, ascending by ``seq_in_file``. Mutated in
            place: each gains ``tool_calls_after``.
        tool_seqs: ``seq_in_file`` of every tool-bearing assistant turn.

    Returns:
        None.
    """
    index = 0
    for position, stub in enumerate(stubs):
        upper = (
            stubs[position + 1]["seq_in_file"] if position + 1 < len(stubs) else None
        )
        count = 0
        while index < len(tool_seqs) and (upper is None or tool_seqs[index] < upper):
            if tool_seqs[index] > stub["seq_in_file"]:
                count += 1
            index += 1
        stub["tool_calls_after"] = count

