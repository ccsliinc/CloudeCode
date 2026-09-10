"""Flatten, order and page the toast record set that ``SessionManager`` holds.

PURE. Nothing here imports FastAPI, opens a database, or touches a
session. It is handed the per-session buckets and answers questions
about them, so every rule below is testable without a server, a socket
or a tmux pane.

WHY THIS MODULE EXISTS AT ALL. Until now the only way to read a toast
was ``GET /sessions/{id}/toasts``, one session at a time, which is
exactly the filter that made a toast raised by session B invisible to a
browser looking at session A (punchlist item 7). Answering "what has
been raised anywhere" and "what was raised, historically" both need the
same three steps - flatten the buckets, order them, cut a page - so the
three steps live here once rather than twice in a route module.

WHERE THE RECORDS ACTUALLY LIVE, and it is worth saying plainly because
a history page over them may not claim more than they can support:
``SessionManager._pending_toasts``, an IN-MEMORY dict keyed by session
id. Retention is asymmetric by design (see that file): every UNACKED
toast is kept without limit, because dropping one would lose a
notification nobody saw; ACKED toasts are kept to the last 50 PER
SESSION and older ones fall off the tail; a session's whole bucket is
dropped when its state is wiped; and the entire structure dies with the
process. So this is a history of THIS SERVER RUN. There is no toast
table and no json store on disk. The client is required to say so - see
client/js/toast-history-panel.js - rather than presenting an empty list
as "nothing ever happened".

THE ORDER NEEDS A TIEBREAK, and leaving it out is how a paged list
silently duplicates and skips rows. ``Toast.created_at`` comes from
``datetime.utcnow()`` at record time, and a hook burst records several
toasts inside the same microsecond tick on some platforms. Two records
comparing equal leave their relative order up to whatever the sort last
happened to see, so page 1 and page 2 can both contain a row, or
neither can. Ordering on ``(created_at, id)`` makes the sequence total
and therefore stable across the two independent calls a paged reader
makes.
"""

from __future__ import annotations

from typing import Iterable, List, Mapping, Optional, Sequence, Tuple

from src.core.toast_auto_ack import ACK_REASON_ANSWERED
from src.models import Toast

#: Default page size for the history view. The owner's ask was a
#: scrollback he can look through, not an export, and 100 rows is about
#: four screens on a phone.
DEFAULT_HISTORY_LIMIT = 100

#: Hard ceiling on a caller-supplied ``limit``. The whole corpus lives in
#: this process's memory, so an unbounded page would serialise every
#: toast every session has ever raised into one response body.
MAX_HISTORY_LIMIT = 500


def buckets_from_inbox(inbox: object) -> Mapping[str, Sequence[Toast]]:
    """Return the live per-session toast buckets held by a toast inbox.

    Description: the ONE place that reaches for the storage container,
        so a change of owner is a one-line change here rather than a hunt
        through route modules. It used to take the SessionManager and
        read ``_pending_toasts`` off it through a tolerant ``getattr``
        that answered ``{}`` for anything unrecognised.

        **THAT TOLERANCE IS GONE ON PURPOSE, AND IT IS THE POINT OF THIS
        CHANGE.** A missing container and a session with no toasts
        rendered identically, so deleting the attribute would have
        emptied every toast history view while raising nowhere and
        failing no test. That is the characteristic failure of this
        refactor, named in CLAUDE.md, and this function was the clearest
        instance of it in the tree. A real inbox whose container is
        renamed now raises here, loudly, at the one call site.

        ``None`` is still tolerated, and only ``None``: a request that
        arrives before the inbox is mounted yields empty buckets rather
        than a 500, because an empty notification list is the correct
        answer for a server with no sessions.
    Inputs:
        inbox: the process's ``ToastInbox``, or None when nothing is
            mounted yet.
    Output: Mapping[str, Sequence[Toast]] - session id to its records.
    Example:
        >>> buckets_from_inbox(None)
        {}
    """
    if inbox is None:
        return {}
    return inbox.pending


def collect_toasts(
    buckets: Mapping[str, Sequence[Toast]],
    *,
    unacked_only: bool = False,
) -> List[Toast]:
    """Flatten every session's bucket into one newest-first list.

    Description: the cross-session view. Ordering is ``created_at``
        descending with ``id`` descending as the tiebreak, which makes
        the sequence total - see this module's docstring for why an
        unstable order is a paging bug rather than a cosmetic one.
    Inputs:
        buckets: session id to that session's records, in any order.
        unacked_only: when True, drop records already acknowledged.
    Output: list[Toast] - newest first, across all sessions.
    Example:
        >>> collect_toasts({}, unacked_only=True)
        []
    """
    flat: List[Toast] = []
    for records in buckets.values():
        if not records:
            continue
        for toast in records:
            if unacked_only and toast.acknowledged:
                continue
            flat.append(toast)
    flat.sort(key=lambda t: (t.created_at, t.id), reverse=True)
    return flat


def clamp_limit(limit: Optional[int], default: int = DEFAULT_HISTORY_LIMIT) -> int:
    """Coerce a caller-supplied page size into the supported range.

    Description: a missing or non-positive limit means "use the default"
        rather than "return nothing", because a client that forgot the
        parameter wants the page, not an empty list it will read as an
        empty history.
    Inputs:
        limit: the requested page size, or None.
        default: what to use when nothing usable was supplied.
    Output: int - between 1 and ``MAX_HISTORY_LIMIT`` inclusive.
    Example:
        >>> clamp_limit(None), clamp_limit(0), clamp_limit(10_000)
        (100, 100, 500)
    """
    if limit is None or limit <= 0:
        limit = default
    return min(limit, MAX_HISTORY_LIMIT)


def page(
    records: Sequence[Toast],
    *,
    limit: int,
    offset: int = 0,
) -> Tuple[List[Toast], int, Optional[int]]:
    """Cut one page out of an ordered record list.

    Description: offset/limit paging over an in-memory sequence. The
        third return value is the offset a caller should ask for next,
        or None when this page reached the end - so a client advances by
        reading a field rather than by re-deriving the arithmetic and
        getting it wrong at the boundary.
    Inputs:
        records: the ordered full set (typically from ``collect_toasts``).
        limit: page size, already clamped.
        offset: how many records to skip. Negative is treated as 0.
    Output: (items, total, next_offset).
    Example:
        >>> page([], limit=100)
        ([], 0, None)
    """
    if offset < 0:
        offset = 0
    total = len(records)
    items = list(records[offset:offset + limit])
    next_offset = offset + len(items)
    return items, total, (next_offset if next_offset < total else None)


def summarize(records: Iterable[Toast]) -> dict:
    """Count a record set by acknowledgement state and by kind.

    Description: the header line the history view prints above the list,
        computed server-side so two clients cannot disagree about what
        the same page says. Counts describe the WHOLE set handed in, not
        the page, so the caller decides which it wants by choosing what
        it passes.
    Inputs: records - any iterable of Toast.
    Output: dict with ``total``, ``open`` (unacknowledged), ``dismissed``
        (acknowledged, whatever acked it), ``answered`` and ``by_kind``
        (kind -> count).

    ``answered`` IS A SUBSET OF ``dismissed``, NOT A SIBLING OF IT, and
    that is deliberate. ``dismissed`` has always meant "no longer open"
    and the history panel's header reads it; redefining it to exclude
    the auto-acked set would silently change a number already on screen
    to mean something else. So the existing count keeps its meaning and
    the new fact is added beside it: of the records no longer open,
    ``answered`` many were cleared because a hook said the user turned
    up (``src/core/toast_auto_ack.py``) rather than by a click.

    A record acked before ``ack_reason`` existed carries None and counts
    only in ``dismissed`` - not having recorded a reason is not evidence
    of which reason it was.

    Example:
        >>> summarize([])
        {'total': 0, 'open': 0, 'dismissed': 0, 'answered': 0, 'by_kind': {}}
    """
    total = 0
    open_count = 0
    answered_count = 0
    by_kind: dict = {}
    for toast in records:
        total += 1
        if not toast.acknowledged:
            open_count += 1
        elif getattr(toast, "ack_reason", None) == ACK_REASON_ANSWERED:
            answered_count += 1
        by_kind[toast.kind] = by_kind.get(toast.kind, 0) + 1
    return {
        "total": total,
        "open": open_count,
        "dismissed": total - open_count,
        "answered": answered_count,
        "by_kind": by_kind,
    }
