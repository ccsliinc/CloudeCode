"""What happened to one session while nobody was watching it.

WHY THIS EXISTS. When a phone sleeps and wakes, or a laptop lid closes and
opens, the browser re-attaches and the app decides on its own what to
repaint. Today that decision is
``client/js/terminal-reconnect-buffer.js``: same session with content on
screen means KEEP the browser buffer, anything else means wipe it and
paint one ``tmux capture-pane``. Both are defensible and neither is ever
offered as a choice, and neither of them ever says what the agent did
during the gap. The owner asked for the choice, not a better default.

This module owns the SUMMARY half of that choice: the read-only facts a
"what happened while you were away" line can honestly be built from. It
is pure. It reads nothing, calls no tmux, touches no clock it was not
handed, and returns a dict of facts.

IT RETURNS FACTS, NOT SENTENCES, and that is deliberate. The bar that
renders this already has to format a duration ("away 4 min") on the
client, so putting a second duration formatter here would give the app
two of them, drifting apart. ``client/js/terminal-away-gap.js`` is the
one place sentences are built.

THE TURN COUNT IS A FLOOR, NEVER A TOTAL. Toasts are the only per-session
record of hook events this app keeps, and ``SessionManager.record_toast``
SUPERSEDES an unacked ``Stop`` toast carrying the same title IN PLACE
rather than appending a second record. Twelve finished turns can therefore
be one stored record. So ``counts['stop']`` is the number of RECORDS, the
kind is named in ``coalesced_kinds``, and the client renders it as "at
least N". Reporting it as a total would be the same class of lie the
toast layer already refuses to tell in the other direction.

COVERAGE IS ITS OWN FIELD BECAUSE TOASTS DIE WITH THE PROCESS. The store
is in memory. A server restart during the away window leaves an empty
bucket that is indistinguishable from a quiet session, so a report whose
window starts before this process loaded says ``partial_server_restarted``
and the bar says so out loud. "Nothing happened" and "the record was
thrown away" must never render the same.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable, Mapping, Optional

#: The window is fully covered by records this process still holds.
COVERAGE_COMPLETE = "complete"
#: The window starts before this process did, so part of it was never
#: recorded here. NOT the same as "nothing happened".
COVERAGE_PARTIAL_RESTART = "partial_server_restarted"
#: We could not establish when this process started, so we decline to
#: claim either. A reading that did not answer is not a "complete".
COVERAGE_UNKNOWN = "unknown"

#: tmux keeps no scrollback for a pane on the alternate screen, so a
#: "full history" replay of one is the CURRENT SCREEN and nothing before
#: it. Every Claude Code session is one of these.
HISTORY_SCREEN_ONLY = "screen_only"
#: A normal pane: the capture really does reach back through history.
HISTORY_SCROLLBACK = "scrollback"
#: The pane could not be probed. Not a claim either way.
HISTORY_UNKNOWN = "unknown"

#: Toast kinds whose stored record count is a FLOOR on the real number of
#: events, because ``record_toast`` coalesces them in place. See the
#: module docstring.
COALESCED_KINDS = ("Stop",)

#: Wire-level toast kind to the key it is counted under.
_KIND_KEYS: Mapping[str, str] = {
    "Stop": "stop",
    "PermissionRequest": "permission_request",
    "Notification": "notification",
}

#: Every key ``counts_since`` always emits, so a client never has to
#: distinguish "zero" from "absent".
_COUNT_KEYS = ("stop", "permission_request", "notification", "other")


def coverage_for(
    since: datetime, server_loaded_at: Optional[datetime]
) -> str:
    """Say whether this process holds the whole away window.

    Args:
        since: start of the window the caller is asking about (naive UTC).
        server_loaded_at: when this server process loaded, or None when
            that is unknown.

    Returns:
        One of :data:`COVERAGE_COMPLETE`, :data:`COVERAGE_PARTIAL_RESTART`,
        :data:`COVERAGE_UNKNOWN`.

    Example:
        >>> coverage_for(datetime(2026, 9, 8, 10), datetime(2026, 9, 8, 9))
        'complete'
    """
    if server_loaded_at is None:
        return COVERAGE_UNKNOWN
    return (
        COVERAGE_COMPLETE
        if server_loaded_at <= since
        else COVERAGE_PARTIAL_RESTART
    )


def history_mode(alternate_screen: Optional[bool]) -> str:
    """What a "full history" replay would actually reach back through.

    Args:
        alternate_screen: True when tmux reports the pane on the
            alternate screen, False when it does not, None when the pane
            could not be probed.

    Returns:
        One of :data:`HISTORY_SCREEN_ONLY`, :data:`HISTORY_SCROLLBACK`,
        :data:`HISTORY_UNKNOWN`.

    Example:
        >>> history_mode(True)
        'screen_only'
    """
    if alternate_screen is None:
        return HISTORY_UNKNOWN
    return HISTORY_SCREEN_ONLY if alternate_screen else HISTORY_SCROLLBACK


def counts_since(toasts: Iterable[Any], since: datetime) -> dict[str, int]:
    """Count toast records created at or after ``since``, by kind.

    A record with no readable ``created_at`` is NOT counted: an
    unreadable timestamp is not evidence it landed inside the window, and
    counting it would inflate a number the client renders as a floor.

    Args:
        toasts: any iterable of objects carrying ``kind`` and
            ``created_at``. Order is irrelevant.
        since: start of the window (naive UTC).

    Returns:
        A dict with every key in :data:`_COUNT_KEYS` present, values >= 0.

    Example:
        >>> counts_since([], datetime(2026, 9, 8))
        {'stop': 0, 'permission_request': 0, 'notification': 0, 'other': 0}
    """
    out = {key: 0 for key in _COUNT_KEYS}
    for toast in toasts or ():
        created = getattr(toast, "created_at", None)
        if not isinstance(created, datetime):
            continue
        if created.tzinfo is not None:
            created = created.replace(tzinfo=None)
        if created < since:
            continue
        key = _KIND_KEYS.get(str(getattr(toast, "kind", "")), "other")
        out[key] += 1
    return out


def build_report(
    *,
    session_id: str,
    since: datetime,
    now: datetime,
    server_loaded_at: Optional[datetime],
    toasts: Iterable[Any],
    permission_open: Optional[bool],
    notice_open: Optional[bool],
    last_activity_at: Optional[datetime],
    alternate_screen: Optional[bool],
    history_bound_lines: int,
) -> dict[str, Any]:
    """Assemble the whole away report from already-gathered facts.

    Every argument is keyword-only: this has ten inputs of which four are
    three-valued, and a positional call site would be unreadable and
    silently mis-orderable.

    Args:
        session_id: the session the report is about.
        since: start of the away window (naive UTC).
        now: the moment of the report (naive UTC).
        server_loaded_at: when this process loaded, or None.
        toasts: the session's toast records, any order.
        permission_open: True when the agent is blocked on a permission
            prompt right now, False when it is not, None when the signal
            could not be read.
        notice_open: same three values for an unresolved Notification.
        last_activity_at: most recent tool/turn event, or None.
        alternate_screen: see :func:`history_mode`.
        history_bound_lines: how many lines a "full history" replay would
            ask tmux for. Reported so the bar can state the bound rather
            than implying the replay is unbounded.

    Returns:
        A JSON-safe dict. Timestamps are ISO-8601 strings or None.

    Example:
        >>> r = build_report(session_id='s1', since=datetime(2026, 9, 8),
        ...                  now=datetime(2026, 9, 8, 0, 1),
        ...                  server_loaded_at=None, toasts=[],
        ...                  permission_open=None, notice_open=None,
        ...                  last_activity_at=None, alternate_screen=None,
        ...                  history_bound_lines=3000)
        >>> r['coverage']
        'unknown'
    """
    return {
        "session_id": session_id,
        "since": since.isoformat(),
        "now": now.isoformat(),
        "coverage": coverage_for(since, server_loaded_at),
        "counts": counts_since(toasts, since),
        "coalesced_kinds": list(COALESCED_KINDS),
        "permission_open": permission_open,
        "notice_open": notice_open,
        "last_activity_at": (
            last_activity_at.isoformat() if last_activity_at else None
        ),
        "history": {
            "mode": history_mode(alternate_screen),
            "bound_lines": int(history_bound_lines),
        },
    }
