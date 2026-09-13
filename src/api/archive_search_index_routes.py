"""``GET /api/v1/archive/search/index`` - is the block-search index sound.

WHY THE SEARCH PATH CANNOT ANSWER THIS. Deciding ``current`` against
``stale`` means counting both sides, measured at 37.08 ms on the
400-transcript projection against a search query that costs 0.07 ms for a
miss. So a search takes the O(1) probe and reports ``present``, which
says the index has rows and says its coverage was not measured there.
This route is where somebody pays for the real answer, and it is the only
place that does.

OFF THE EVENT LOOP, like every other read in this family. The counts are
two full traversals; this project has twice shipped a synchronous
database read on a request path and twice paid for it (a pragma that
blocked 14 of every 20 seconds, a listing pass that cost 1008 ms and
presented as typing lag). ``asyncio.to_thread`` is not optional here.

IT REPORTS AND IT DOES NOT REPAIR. A stale index is fixed by
``scripts/rebuild_block_search_index.py``, which is a named operation
with a liveness record. A route that quietly rebuilt would turn a 1.80 s
write into something a page refresh can trigger.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from src.api.archive_support import respond, state_dir
from src.api.auth import require_auth
from src.core.archive_read import (
    RESULT_CANNOT_DETERMINE,
    RESULT_OK,
    SCOPE_CANNOT_DETERMINE,
    SCOPE_RESOLVED,
    envelope,
    run_read,
)
from src.core.message_block_search_index import (
    indexable_count,
    pending_count,
    BlockSearchIndexUnavailable,
)
from src.core.message_block_search_state import read_liveness
from src.core.message_block_search_status import resolve_index_state

router = APIRouter(tags=["archive"])


def _index_report(conn: sqlite3.Connection, sd: Path) -> Dict[str, Any]:
    """Take the exact index measurement and render it as an envelope.

    Description: runs inside ``run_read``'s connection, which is inside
      ``asyncio.to_thread``, so both traversals are off the loop. The
      liveness record is read from the SAME state directory the caller
      resolved, not from settings a second time.
    Inputs: conn (sqlite3.Connection) - read-only. sd (Path).
    Output: dict - the three-outcome envelope.
    Raises: nothing - an unavailable index becomes a cannot_determine
      naming the index, because a route needs a payload.
    Example: _index_report(conn, sd)["meta"]["index"]["state"]
    """
    liveness = read_liveness(sd)
    state = resolve_index_state(conn, liveness)
    try:
        pending = pending_count(conn)
        indexable = indexable_count(conn)
    except BlockSearchIndexUnavailable as exc:
        return envelope(
            result=None, result_status=RESULT_CANNOT_DETERMINE,
            scope_status=SCOPE_CANNOT_DETERMINE,
            unevaluated=[{"subject": "index", "reason": str(exc)}],
            meta={"index": state.to_meta(), "build": liveness})
    except sqlite3.Error as exc:
        # Specific, and deliberately not re-raised: a status route that
        # 500s tells an operator less than one that says what it could
        # not read.
        return envelope(
            result=None, result_status=RESULT_CANNOT_DETERMINE,
            scope_status=SCOPE_CANNOT_DETERMINE,
            unevaluated=[{"subject": "datastore", "reason": (
                f"sqlite refused the index count: {type(exc).__name__}: "
                f"{exc}")}],
            meta={"index": state.to_meta(), "build": liveness})
    return envelope(
        result={
            "state": state.state,
            "indexed_rows": state.indexed_rows,
            "indexable_block_rows": indexable,
            "pending_rows": pending,
        },
        result_status=RESULT_OK, scope_status=SCOPE_RESOLVED,
        unevaluated=[],
        # ``build`` is the liveness record VERBATIM, including a None,
        # because "no build has ever been recorded here" is a different
        # fact from a recorded build that failed and both have to be
        # readable from this one field.
        meta={"index": state.to_meta(), "build": liveness})


@router.get("/archive/search/index", response_model=None,
            dependencies=[Depends(require_auth)])
async def get_search_index_status() -> JSONResponse:
    """Report whether the block-search index covers the content blocks.

    Description: the EXACT measurement, which a search deliberately does
        not take. ``state`` is ``missing`` / ``never_built`` / ``stale``
        / ``current``; ``pending_rows`` is what a rebuild would do, and
        it is the number to watch rather than the elapsed time, because
        a bounded pass is meant to leave work behind.

    Returns:
        The envelope. ``meta.build`` is the liveness record for the last
        rebuild, or null when none has ever run here - which is not the
        same as one that ran and failed, and the record says which.
    """
    sd = state_dir()
    result = await asyncio.to_thread(
        run_read, sd, _index_report, sd,
        subject="datastore", unreadable_result=None,
    )
    meta_index = (result.get("meta") or {}).get("index") or {}
    return respond(
        result, route="search_index", index_state=meta_index.get("state"),
    )
