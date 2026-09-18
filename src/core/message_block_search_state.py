"""The liveness record for the block-search index build.

WHY A RECORD AT ALL. A rebuilder that dies looks exactly like one that
found nothing to do: both leave the index unchanged and say nothing. That
is the same shape as a green dot over a dead session, so the AGE of this
artifact is the signal, and it is published on EVERY terminating path,
failures included. This is the discipline
``src/core/corpus_ingest_state.py`` already established for the corpus
ingester and ``src/core/db_integrity.py`` for the daily check; it is
reused rather than re-invented, down to the four freshness words.

WHAT IT DOES NOT DO. It is NOT the authority on whether the index is
usable - the row counts are, because they are a measurement of the index
itself rather than a note somebody left about it. See
``message_block_search_status``, which reads both and says which of them
answered. A record claiming a successful build over an index that is
empty is a record that is wrong, and the counts are what catch that.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from src.core.json_artifact import atomic_write_json, read_json_object

#: Directory under the state dir, beside ``corpus-ingest`` and
#: ``db-integrity``, so an operator finds all three in one place.
ARTIFACT_DIRNAME: str = "block-search-index"

#: The one file. Overwritten each run; there is no dated history here
#: because the only question this answers is "how long ago", and a
#: history of that is what the structured log is for.
LATEST_FILENAME: str = "latest.json"

#: Outcomes a completed pass may record. ``failed`` is written by the
#: pass itself before it re-raises, which is the whole reason a dead
#: rebuilder is distinguishable from an idle one.
OUTCOME_BUILT: str = "built"
OUTCOME_NOTHING_TO_DO: str = "nothing_to_do"
OUTCOME_FAILED: str = "failed"


def artifact_dir(state_dir: Path) -> Path:
    """Return the directory this module's artifact lives in.

    Inputs: state_dir (Path) - Settings.get_state_dir().
    Output: Path.
    Example: artifact_dir(Path("/s")) -> Path("/s/block-search-index")
    """
    return Path(state_dir) / ARTIFACT_DIRNAME


def latest_path(state_dir: Path) -> Path:
    """Return the path of the latest-run record.

    Inputs: state_dir (Path). Output: Path.
    """
    return artifact_dir(state_dir) / LATEST_FILENAME


def utc_now_iso() -> str:
    """Return the current UTC instant as a fixed-width ISO-8601 Z string.

    Description: the same spelling every other artifact in this app uses,
      so two records can be compared lexicographically.
    Inputs: none. Output: str.
    Example: utc_now_iso() -> '2026-09-13T15:00:00.000000Z'
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def write_liveness(state_dir: Path, record: Dict[str, Any]) -> bool:
    """Publish one pass's record, atomically, never raising.

    Description: NEVER RAISES, because it is called from a ``finally``
      and from failure paths - an artifact write that threw would mask
      the failure it was recording. A False return is itself reportable.
    Inputs: state_dir (Path), record (dict) - at minimum ``outcome`` and
      ``finished_at``; the caller's own counts ride along.
    Output: bool - True when the file was replaced.
    Example: write_liveness(sd, {"outcome": "built", "indexed": 5})
    """
    path = latest_path(Path(state_dir))
    path.parent.mkdir(parents=True, exist_ok=True)
    return atomic_write_json(
        path, dict(record), log_event="block_search_liveness_write",
    )


def read_liveness(state_dir: Path) -> Optional[Dict[str, Any]]:
    """Read the latest-run record, or None when there is not one.

    Description: None means NO RECORD - never looked - and is kept apart
      from a record whose ``outcome`` is ``failed``, which means somebody
      looked and it went wrong. A tolerant read: an unparseable file
      answers None rather than raising into a status route.
    Inputs: state_dir (Path).
    Output: dict or None.
    Example: read_liveness(sd) -> {"outcome": "built", ...}
    """
    return read_json_object(
        latest_path(Path(state_dir)), log_event="block_search_liveness_read",
    )
