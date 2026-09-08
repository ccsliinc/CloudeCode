"""The read-only "what happened while you were away" endpoint.

``GET /sessions/away/summary`` answers one question for one session: what
did the server record between a moment the client names and now. It reads
the toast bucket, the ephemeral activity signal and one tmux probe. It
spawns nothing, writes nothing, and acks nothing, so it is safe to call
from a bar the user has not decided anything on yet. That is also why it
is a GET.

WHY IT EXISTS AT ALL, since the client could nearly build this itself.
``GET /sessions/{id}/toasts`` already exists and carries kinds and
timestamps. Three of the facts the summary needs are not on any endpoint:
the time of the last tool or turn event (the activity tracker keeps it in
memory and publishes only the derived ``activity_status``), whether this
server process is even old enough to have witnessed the window, and
whether the pane is on the alternate screen, which is what decides
whether "full history" means history or means the current screen. Rather
than three new fields on three existing shapes, this is one route.

WHY A MISSING SIGNAL IS A 200 WITH NULLS. ``permission_open``,
``notice_open``, ``last_activity_at`` and ``history.mode`` are all
three-valued on purpose. The activity tracker is in-memory and a restart
legitimately forgets it; the tmux probe can fail. A 500 would blame the
server for a state it correctly detected, and a False would claim a
measurement nobody took.

Mounted under ``/api/v1`` from ``src/main.py``. Its own module rather
than more lines in ``src/api/routes.py``, which is already far past the
project's 500-line budget.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from src.api.auth import require_auth
from src.config import settings
from src.core.session_away_report import build_report

logger = structlog.get_logger()

router = APIRouter(tags=["sessions"])

#: When this server process imported this module. Used ONLY to answer
#: "was this process alive for the whole window", which is what separates
#: a quiet session from a toast bucket a restart emptied. Import time is
#: a few milliseconds after process start and always before the first
#: request, so it is a sound lower bound on what this process witnessed.
SERVER_LOADED_AT: datetime = datetime.utcnow()

#: The default a "full history" replay is bounded by when the config read
#: fails. Mirrors ``TmuxBackend.capture_scrollback``'s own default so the
#: number the bar prints is the number tmux is actually asked for.
DEFAULT_HISTORY_BOUND_LINES = 3000


def parse_since(raw: str, now: datetime) -> datetime:
    """Parse the client's ``since`` into a naive-UTC datetime.

    Accepts ISO-8601, including the trailing ``Z`` that
    ``Date#toISOString`` emits. An aware value is converted to UTC and
    stripped, because every timestamp this app stores is naive UTC and
    comparing the two kinds raises.

    A value in the FUTURE is clamped to ``now`` rather than refused: a
    phone whose clock is a few seconds ahead is a normal client, and the
    honest reading of "since a moment that has not happened" is an empty
    window.

    Args:
        raw: the query parameter as sent.
        now: the report clock, already naive UTC.

    Returns:
        A naive-UTC datetime no later than ``now``.

    Raises:
        ValueError: the string is not ISO-8601.

    Example:
        >>> parse_since('2026-09-08T10:00:00Z', datetime(2026, 9, 8, 11))
        datetime.datetime(2026, 9, 8, 10, 0)
    """
    text = raw.strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return min(parsed, now)


def read_activity_signal(
    session_manager: Any, session_id: str
) -> tuple[Optional[bool], Optional[bool], Optional[datetime]]:
    """Read one session's live hook signal, or decline.

    The tracker holds this state and publishes only the DERIVED
    ``activity_status`` through ``/sessions/list``; the two raw booleans
    and the last-event time have no accessor. This reads the tracker's
    own record rather than starting a second copy of it, and refuses
    outright if the shape is not what it expects, so a change to
    ``session_activity`` degrades this endpoint to three nulls instead of
    making it lie.

    Args:
        session_manager: the app's SessionManager.
        session_id: the session to read.

    Returns:
        ``(permission_open, notice_open, last_activity_at)``. Any element
        is None when it could not be read. ``last_activity_at`` is the
        later of the last tool event and the last Stop.

    Example:
        >>> read_activity_signal(object(), 's1')
        (None, None, None)
    """
    tracker = getattr(session_manager, "_activity_tracker", None)
    signals = getattr(tracker, "_signals", None)
    if not isinstance(signals, dict):
        return (None, None, None)
    signal = signals.get(session_id)
    if signal is None:
        return (None, None, None)

    permission = getattr(signal, "permission_open", None)
    notice = getattr(signal, "notice_open", None)
    stamps = [
        getattr(signal, "last_tool_event_ts", None),
        getattr(signal, "last_stop_ts", None),
    ]
    real = [s for s in stamps if isinstance(s, datetime)]
    last = max(real) if real else None
    return (
        permission if isinstance(permission, bool) else None,
        notice if isinstance(notice, bool) else None,
        last,
    )


def read_alternate_screen(
    session_manager: Any, session_id: str
) -> Optional[bool]:
    """Is this session's pane on the alternate screen?

    Answers the only question that makes "full history" honest: tmux
    keeps no scrollback for an alternate-screen pane, so a replay of one
    is the current frame and nothing before it.

    Args:
        session_manager: the app's SessionManager.
        session_id: the session to probe.

    Returns:
        True / False as tmux reported, or None when there is no live tmux
        backend or the probe raised. None is a refusal, not a False.

    Example:
        >>> read_alternate_screen(object(), 's1') is None
        True
    """
    getter = getattr(session_manager, "get_backend", None)
    if not callable(getter):
        return None
    backend = getter(session_id)
    probe = getattr(backend, "pane_in_alternate_screen", None)
    if not callable(probe):
        return None
    try:
        return bool(probe())
    except OSError as exc:
        # A failed tmux read is a refusal, never a False: claiming the
        # pane scrolls when we could not look is exactly the mistake the
        # three-valued fields exist to prevent.
        logger.warning(
            "away_alt_screen_probe_failed", session_id=session_id, error=str(exc)
        )
        return None


def history_bound_lines() -> int:
    """How many lines a "full history" replay asks tmux for.

    Read from the same config the rejoin capture reads
    (``session.scrollback_lines``) so the bound the bar prints is the
    bound the replay actually uses.

    Returns:
        A positive line count, falling back to
        :data:`DEFAULT_HISTORY_BOUND_LINES`.

    Example:
        >>> history_bound_lines() > 0
        True
    """
    try:
        value = int(settings.load_auth_config().session.scrollback_lines)
    except (AttributeError, TypeError, ValueError) as exc:
        logger.debug("away_scrollback_config_read_failed", error=str(exc))
        return DEFAULT_HISTORY_BOUND_LINES
    return value if value > 0 else DEFAULT_HISTORY_BOUND_LINES


@router.get("/sessions/away/summary", dependencies=[Depends(require_auth)])
async def away_summary(
    request: Request,
    session_id: str = Query(..., description="Session the report is about"),
    since: str = Query(
        ..., description="ISO-8601 start of the away window, e.g. 2026-09-08T10:00:00Z"
    ),
):
    """Report what the server recorded for one session since a moment.

    Returns the dict documented in
    ``src/core/session_away_report.build_report``: coverage, per-kind
    toast-record counts, the two attention booleans, the last activity
    time and what a full-history replay would reach.

    Raises:
        HTTPException(400): ``since`` is not ISO-8601.
        HTTPException(404): no session with that id.
    """
    session_manager = request.app.state.session_manager

    sessions = getattr(session_manager, "sessions", {})
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="No such session")

    now = datetime.utcnow()
    try:
        window_start = parse_since(since, now)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Bad since: {exc}")

    getter = getattr(session_manager, "get_toasts", None)
    toasts = getter(session_id) if callable(getter) else []

    permission_open, notice_open, last_activity_at = read_activity_signal(
        session_manager, session_id
    )

    return build_report(
        session_id=session_id,
        since=window_start,
        now=now,
        server_loaded_at=SERVER_LOADED_AT,
        toasts=toasts,
        permission_open=permission_open,
        notice_open=notice_open,
        last_activity_at=last_activity_at,
        alternate_screen=read_alternate_screen(session_manager, session_id),
        history_bound_lines=history_bound_lines(),
    )
