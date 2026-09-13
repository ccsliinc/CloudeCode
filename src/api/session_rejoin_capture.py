"""The rejoin path's one blocking read, off the event loop.

ITS OWN MODULE BECAUSE ``session_crud_routes.py`` IS AT THE 500-LINE
CAP, and because this is a self-contained piece of work with a rule of
its own: a resize and a capture that must happen in that order, in one
thread, and whose failures are all non-fatal.

WHAT IT FIXES. ``GET /sessions?include_scrollback=1`` is the launchpad's
"return to a running session" path, and both of its tmux calls used to
run bare on the event loop. They are synchronous and measured at 20 to
150 ms at the default depth of 10000 lines, and for that whole time the
server could not read the tmux pipe carrying a pane's output, could not
spawn the ``send-keys`` that delivers a keystroke, and could not answer
another request. That is the same defect, on a third path, that the
listing pass and the file drawer's tree scan already paid for.

EVERY FAILURE HERE IS NON-FATAL, DELIBERATELY. A rejoin that cannot
pre-resize, cannot capture or cannot read a cursor still returns the
session; the client falls through to a clean-screen rejoin, which is
functional and merely has no history painted into it. Refusing the whole
request would turn a cosmetic loss into an unusable one.
"""

from __future__ import annotations

from typing import Optional, Tuple

import structlog

from src.config import settings
from src.core.scrollback_replay import with_cursor_restore

logger = structlog.get_logger()


def resize_and_capture(
    session_manager,
    *,
    session_id: str,
    cols: Optional[int],
    rows: Optional[int],
) -> bytes:
    """Resize the pane to the client's grid, then capture its scrollback.

    THE TWO CALLS TRAVEL TOGETHER BECAUSE THEY RUN IN ONE THREAD. Both
    are synchronous tmux work - measured at 20 to 150 ms at the default
    depth of 10000 lines - and both used to run bare on the event loop,
    where for that whole time the server could not read a pane's output,
    deliver a keystroke or answer another request. The ORDER is the
    reason they are one function rather than two offloads: ``capture-pane``
    snapshots at the pane's CURRENT width, so a capture that overtook its
    resize would emit the previous client's geometry, which is the reflow
    artifact the pre-resize exists to remove.

    THE CURSOR IS APPENDED HERE, NOT INSIDE ``capture_scrollback``. That
    method is also the startup gate's per-row pane probe on every listing
    poll, so reading a cursor inside it would cost one more tmux process
    per session per poll. This path pays it once, on a rejoin, and only
    when there were bytes to position into.

    Args:
        session_manager: The live ``SessionManager``.
        session_id: The resolved session id, never the name.
        cols: The client's xterm column count, or None.
        rows: The client's xterm row count, or None.

    Returns:
        Captured pane bytes with a trailing absolute cursor position, or
        ``b""`` when nothing could be captured. ``b""`` is what the caller
        reads as "leave ``initial_scrollback_b64`` as None".

    Example:
        resize_and_capture(sm, session_id="ses_1", cols=80, rows=24)
    """
    # resize_terminal is sync and no-ops when the session or backend is
    # not live, so it is safe to call whenever cols/rows look sane.
    if cols and rows and cols > 0 and rows > 0:
        try:
            session_manager.resize_terminal(
                cols=cols, rows=rows, session_id=session_id
            )
        except Exception as exc:
            logger.warning(
                "rejoin_pre_resize_failed",
                session_id=session_id,
                cols=cols,
                rows=rows,
                error=str(exc),
            )

    try:
        # Mirror the depth used elsewhere (see SessionManager.adopt path)
        # so rejoin and adopt paint the same amount of history.
        lines = settings.load_auth_config().session.scrollback_lines
        raw = session_manager.capture_scrollback(
            lines=lines,
            session_id=session_id,
        )
    except Exception as exc:
        # Non-fatal. The caller leaves the field as None so the client
        # falls through to a clean-screen rejoin (still functional; just
        # no pre-paint of history).
        logger.warning(
            "rejoin_scrollback_capture_failed",
            session_id=session_id,
            error=str(exc),
        )
        return b""

    return with_cursor_restore(raw, pane_cursor(session_manager, session_id))


def pane_cursor(session_manager, session_id: str) -> Optional[Tuple[int, int]]:
    """Read the pane's own cursor for the rejoin paint, or refuse.

    A REFUSAL IS FREE AND A GUESS IS NOT. Every failure here answers
    None, which appends nothing and leaves the client exactly where the
    replayed text ended - the behaviour before this existed. The backend
    may be absent, may be the legacy PTY one that cannot answer, or may
    have lost its tmux session between the capture and this call.

    THE SHAPE IS CHECKED, NOT ASSUMED. ``pane_cursor_position`` is not on
    the ``SessionBackend`` ABC, so finding the attribute proves only that
    something answers to the name; an answer that is not a pair of ints
    would reach the escape-sequence formatter and 500 a rejoin that had
    already captured its history perfectly.

    Args:
        session_manager: The live ``SessionManager``.
        session_id: The resolved session id.

    Returns:
        ``(x, y)`` 0-based as tmux reports it, or None.

    Example:
        pane_cursor(sm, "ses_1")  # (5, 8)
    """
    backend = session_manager._registry.get_backend(session_id)
    reader = getattr(backend, "pane_cursor_position", None)
    if reader is None:
        return None
    try:
        cursor = reader()
    except Exception as exc:
        logger.warning(
            "rejoin_cursor_read_failed", session_id=session_id, error=str(exc)
        )
        return None
    if (
        isinstance(cursor, tuple)
        and len(cursor) == 2
        and all(isinstance(value, int) for value in cursor)
    ):
        return cursor
    return None
