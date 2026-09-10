"""``/api/v1/toasts*`` - the cross-session toast views.

ITS OWN MODULE, like ``status_routes.py`` and ``corpus_routes.py``, for
the same reason: nothing new lands in ``src/api/routes.py``, which is
already 3999 lines against a 500-line budget. The per-session toast
routes (``GET/POST /sessions/{id}/toasts`` and ``POST
/toasts/{id}/ack``) stay where they are; this module adds only the two
reads that were missing.

TWO ROUTES, ANSWERING TWO DIFFERENT QUESTIONS.

``GET /toasts`` is the RAISE path for punchlist item 7. Until now a
toast reached the browser two ways and both were scoped to the session
being viewed: the ``toast.new`` WebSocket frame is fanned out only to
sockets bound to the raising session, and the REST backfill in
``client/js/terminal.js`` asks for the attached session's toasts alone.
So a session that needed attention while the user was looking somewhere
else was silent, which is exactly what the owner reported. This route is
the one the client can poll from ANY screen - including the launchpad
and the archive, which hold no terminal socket at all and were
therefore completely deaf to notifications.

``GET /toasts/history`` is the READ-BACK path for punchlist item 8: what
was raised, in what order, and whether it was ever dismissed.

NEITHER ROUTE WRITES ANYTHING. Dismissal keeps its existing endpoint and
its existing shape, and that is the point of the split: raising is
GLOBAL, dismissing stays PER SESSION. ``POST /toasts/{id}/ack`` takes a
``session_id`` and ``SessionManager.ack_toast`` walks that session's
bucket only, so a toast id that is not in that bucket is simply not
found. Making the read global cannot widen the write, because the write
is a different endpoint that this module does not touch.

AUTH IS NOT OPTIONAL. A toast carries the session's label, its tmux
name, and the tail of what Claude last said in it, which is the content
of the owner's work. Both routes carry ``Depends(require_auth)`` exactly
like every other ``/api/v1`` route.

WHAT THE HISTORY MAY NOT CLAIM. The records live in memory for the life
of the process - see ``src/core/toast_history.py`` for the retention
rules. This module reports ``storage`` on every history response so the
client can say that out loud instead of rendering an empty list as
"nothing ever happened", which would be the confidently-wrong doc that
CLAUDE.md's gotcha 8 warns about, only in a UI.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import structlog
from fastapi import APIRouter, Depends, Query, Request

from src.api.auth import require_auth
from src.core import toast_history

logger = structlog.get_logger()

router = APIRouter(tags=["toasts"])

#: What the history is a history OF. A literal rather than a prose
#: sentence built at the call site, so the client can branch on it if a
#: durable store is ever added behind the same route.
STORAGE_IN_MEMORY = "process_memory"

#: Upper bound on ``GET /toasts?limit=``. The unacked set is normally a
#: handful; this exists so a malformed client cannot ask for everything.
MAX_UNACKED_LIMIT = 500


def _buckets(request: Request) -> Dict[str, Any]:
    """Return the process's per-session toast buckets.

    Description: resolves the session manager off ``app.state`` and hands
        it to the core module's accessor. A request that arrives before
        the manager is mounted yields empty buckets rather than a 500 -
        an empty notification list is the correct answer for a server
        with no sessions, and failing the request would take the client's
        poll loop down for a state that resolves itself.
    Inputs: request (Request).
    Output: mapping of session id to that session's records.
    Example: _buckets(request)  # {'ses_a': [Toast(...)]}
    """
    manager = getattr(request.app.state, "session_manager", None)
    return dict(toast_history.buckets_from_manager(manager))


@router.get(
    "/toasts",
    response_model=None,
    dependencies=[Depends(require_auth)],
)
async def list_all_toasts(
    request: Request,
    unacked: bool = Query(
        True,
        description=(
            "Return only records the user has not dismissed. True is the "
            "default because this route's job is 'what still wants "
            "attention', not 'what has ever happened' - that is /toasts/history."
        ),
    ),
    limit: Optional[int] = Query(
        None, description="Page size. Defaults to 100, capped at 500."
    ),
) -> Dict[str, Any]:
    """List toasts across EVERY session, newest first.

    Description: the cross-session raise path. The client polls this from
        whatever screen it is on and feeds the result into the same
        ``ToastManager.backfill`` the per-session attach backfill already
        uses, so a record arriving by this route and by the WebSocket
        renders once - ``add()`` dedupes on ``toast.id``.
    Args:
        request: the incoming request, for ``app.state``.
        unacked: filter to undismissed records only.
        limit: page size; clamped into range rather than rejected.
    Returns:
        ``{'toasts': [...], 'total': int, 'unacked_only': bool}``. An
        empty list is a real answer and never an error.
    """
    records = toast_history.collect_toasts(_buckets(request), unacked_only=unacked)
    capped = toast_history.clamp_limit(limit, default=MAX_UNACKED_LIMIT)
    items, total, _ = toast_history.page(records, limit=capped, offset=0)
    return {
        "toasts": [t.model_dump(mode="json") for t in items],
        "total": total,
        "unacked_only": unacked,
    }


@router.get(
    "/toasts/history",
    response_model=None,
    dependencies=[Depends(require_auth)],
)
async def list_toast_history(
    request: Request,
    limit: Optional[int] = Query(
        None, description="Page size. Defaults to 100, capped at 500."
    ),
    offset: int = Query(0, description="How many records to skip."),
) -> Dict[str, Any]:
    """Page back through every toast this server run has recorded.

    Description: read-only scrollback for punchlist item 8, so a
        notification that was raised while the owner was elsewhere can
        still be found afterwards. Dismissed and undismissed records are
        both included - the whole point is to see what was missed - and
        each carries ``acknowledged`` so the client can mark which.
    Args:
        request: the incoming request, for ``app.state``.
        limit: page size; clamped into range rather than rejected.
        offset: paging cursor. Negative is treated as 0.
    Returns:
        ``{'toasts': [...], 'total': int, 'limit': int, 'offset': int,
        'next_offset': int | None, 'summary': {...}, 'storage': str}``.
        ``next_offset`` is None on the last page, so a client advances by
        reading a field rather than re-deriving the boundary arithmetic.
        ``summary`` counts the WHOLE set, not the page.
    """
    records = toast_history.collect_toasts(_buckets(request), unacked_only=False)
    capped = toast_history.clamp_limit(limit)
    if offset < 0:
        offset = 0
    items, total, next_offset = toast_history.page(
        records, limit=capped, offset=offset
    )
    logger.debug(
        "toast_history_read", total=total, returned=len(items), offset=offset
    )
    return {
        "toasts": [t.model_dump(mode="json") for t in items],
        "total": total,
        "limit": capped,
        "offset": offset,
        "next_offset": next_offset,
        "summary": toast_history.summarize(records),
        # SAY WHAT THIS IS A HISTORY OF. Records live in this process's
        # memory and die with it; the client renders that sentence rather
        # than letting an empty list read as "nothing ever happened".
        "storage": STORAGE_IN_MEMORY,
    }
