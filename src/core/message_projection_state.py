"""On-disk liveness for the archive-to-message-model projection.

A PROJECTION THAT DIED LOOKS EXACTLY LIKE ONE WITH NOTHING LEFT TO DO,
which is the same sentence :mod:`src.core.corpus_ingest_state` opens
with, for the same reason. Both publish a record on EVERY terminating
path, failures included, and both report the AGE of that record rather
than its presence, because a file that exists and is four days old says
something a boolean cannot.

WHY ITS OWN ARTIFACT AND NOT A FIELD ON THE INGESTER'S. The two passes
answer different questions and can fail independently: the archive can
be perfectly current while the projection has not run since a crash, and
that is precisely the state that leaves the browser empty over a healthy
corpus - the defect this whole module set exists to close. Folding the
projection's liveness into the ingester's record would make exactly that
combination unsayable.

THE FOUR-VALUE FRESHNESS VOCABULARY IS REUSED, NOT REINVENTED:
``current`` / ``stale`` / ``never_ran`` / ``cannot_determine``, imported
from the ingester's module so the two can never drift into meaning
different things by the same words.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple

from src.core.corpus_ingest_state import (
    FRESHNESS_CANNOT_DETERMINE,
    FRESHNESS_CURRENT,
    FRESHNESS_NEVER_RAN,
    FRESHNESS_STALE,
    utc_now_iso,
)
from src.core.json_artifact import atomic_write_json, read_json_object

#: Subdirectory of the state dir holding this module's artifacts. Kept
#: beside ``corpus-ingest/`` rather than inside it: two producers writing
#: into one directory is how a prune written for one starts deleting the
#: other's records.
ARTIFACT_SUBDIR: str = "message-projection"

#: The dead-man's-switch file. As with the ingester, the timestamp INSIDE
#: it is what is trusted, never the file's mtime, because copying a state
#: directory changes one and not the other.
LATEST_NAME: str = "latest.json"

#: Age at which a published record stops being CURRENT. Set from the
#: PHASE between the producer and the checker, not from the producer's
#: period: comfortably longer than one projection interval so an
#: ordinary long backfill pass does not read as stale, and comfortably
#: shorter than a day so a dead loop is caught the day it dies.
DEFAULT_STALE_AFTER_SECONDS: int = 6 * 60 * 60


def artifact_dir(state_dir: Path) -> Path:
    """Return the directory this module writes into.

    Inputs: state_dir (Path).
    Output: Path.
    Example: artifact_dir(Path("/s")) -> Path('/s/message-projection')
    """
    return Path(state_dir) / ARTIFACT_SUBDIR


def latest_path(state_dir: Path) -> Path:
    """Return the path of the liveness record.

    Inputs: state_dir (Path).
    Output: Path.
    Example: latest_path(Path("/s")).name -> 'latest.json'
    """
    return artifact_dir(state_dir) / LATEST_NAME


def write_liveness(state_dir: Path, record: dict) -> bool:
    """Publish one pass's record, atomically.

    Description: returns False rather than raising when the write could
      not happen. A projection pass must never fail because its own
      bookkeeping could not be written; the caller logs the False.
    Inputs: state_dir (Path), record (dict - JSON-serialisable).
    Output: bool - True when the record reached disk.
    Example: write_liveness(Path("/s"), {"status": "ok"}) -> True
    """
    path = latest_path(state_dir)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    return atomic_write_json(
        path, record, log_event="message_projection_liveness_write_failed"
    )


def read_liveness(state_dir: Path) -> Optional[dict]:
    """Read the last published record, or None when there is not one.

    Description: None covers both "no pass has ever run here" and "the
      file is unreadable or is not a JSON object". The two are told apart
      by :func:`freshness`, which is the only caller that needs to.
    Inputs: state_dir (Path).
    Output: dict or None.
    Example: read_liveness(Path("/nonexistent")) -> None
    """
    return read_json_object(
        latest_path(state_dir),
        log_event="message_projection_liveness_read_failed",
    )


def freshness(
    state_dir: Path, *, now_epoch: float,
    stale_after_seconds: int = DEFAULT_STALE_AFTER_SECONDS,
) -> Tuple[str, Optional[float]]:
    """Answer how long ago the projection last finished a pass.

    Description: four outcomes, never two. ``never_ran`` means no record
      exists at all; ``cannot_determine`` means a record exists but does
      not carry a readable ``finished_at``, which is a DIFFERENT failure
      and must not be reported as "never ran"; ``current`` and ``stale``
      are the two readings of a record that could be read. The age is
      returned beside the verdict so a caller can render the number
      rather than repeat the threshold.
    Inputs: state_dir (Path), now_epoch (float - unix seconds),
      stale_after_seconds (int).
    Output: (verdict str, age_seconds float or None).
    Example: freshness(Path("/nope"), now_epoch=0.0) -> ('never_ran', None)
    """
    record = read_liveness(state_dir)
    if record is None:
        return FRESHNESS_NEVER_RAN, None
    finished = record.get("finished_at")
    if not isinstance(finished, str) or not finished:
        return FRESHNESS_CANNOT_DETERMINE, None
    try:
        from datetime import datetime

        stamp = datetime.fromisoformat(finished.replace("Z", "+00:00"))
    except ValueError:
        return FRESHNESS_CANNOT_DETERMINE, None
    age = now_epoch - stamp.timestamp()
    if age < 0:
        # A record from the future is a clock problem, not a fresh pass.
        # Claiming CURRENT here would let a skewed clock permanently
        # silence the staleness alarm.
        return FRESHNESS_CANNOT_DETERMINE, age
    verdict = FRESHNESS_CURRENT if age <= stale_after_seconds else FRESHNESS_STALE
    return verdict, age


__all__ = [
    "ARTIFACT_SUBDIR", "LATEST_NAME", "DEFAULT_STALE_AFTER_SECONDS",
    "artifact_dir", "latest_path", "write_liveness", "read_liveness",
    "freshness", "utc_now_iso",
]
