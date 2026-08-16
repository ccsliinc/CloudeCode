"""Attach-time repaint: make the pane's current screen visible to a client.

WHY THIS EXISTS
---------------

The WebSocket resize handshake used to end by writing Ctrl+L (0x0c) into
the pane unconditionally. That was added with the tmux backend in
``a2a4fa2`` (2026-04-23) and extended with a degraded-mode fallback in
``6dfe52d`` (2026-05-07). Its purpose was real and still is: the handshake
replaced a scrollback replay that painted bytes captured at the pane's
PREVIOUS geometry, which on a reconnect at a different viewport size
produced character shrapnel. Ctrl+L handed the repaint back to the
foreground application, which paints at its CURRENT cell grid. The
fallback covered the case where the client never sent dims, so the user
would not sit staring at a frozen banner.

What it did NOT survive is a pane whose foreground process is reading a
line in CANONICAL mode - a password prompt, a shell ``read``. Two things
go wrong there:

1. ``pipe-pane`` (our only stream to the client) starts a few hundred
   milliseconds AFTER the pane's process does. Anything printed in that
   window - a startup prompt, notably ``password to unlock
   .../login.keychain-db:`` - is written to the pane and never enters the
   stream. The client's screen is empty and stays empty.
2. Ctrl+L is not a command to a line discipline. It is a data byte. The
   terminal echoes it in caret notation as the literal two characters
   ``^L`` and appends 0x0c to the line the process is about to read.

That combination is the reported bug: the user sees ``^L`` and a hang,
presses Enter out of desperation, the junk line is consumed, the program
re-prompts, and NOW the prompt is visible because the re-print happens
after pipe-pane is running. The echoed ``^L`` is the diagnostic - a TUI
in raw mode would have consumed the byte silently and repainted.

THE FIX
-------

Ask the pane which case it is in, using ``#{alternate_on}``:

* On the alternate screen (vim, less, the Claude CLI): a full-screen TUI
  in raw mode. Ctrl+L means redraw. Unchanged behavior, so the original
  problem stays fixed.
* Not on the alternate screen: send the client a repaint of the pane's
  visible screen instead, and write NOTHING to the pane. The capture is
  taken AFTER the resize, from tmux's own reflowed buffer, so it is at
  the current geometry - which is precisely the property the old
  scrollback replay lacked and the reason Ctrl+L was reached for in the
  first place.
"""

from __future__ import annotations

from typing import Optional, Protocol

import structlog

logger = structlog.get_logger()

#: Home the cursor and clear the screen before painting the capture, so a
#: reconnecting client's stale content cannot show through underneath.
_CLEAR_AND_HOME = b"\x1b[H\x1b[2J"

#: Redraw request for a full-screen TUI. Form feed, 0x0c.
_CTRL_L = b"\x0c"


class _PaintTarget(Protocol):
    """The slice of the WebSocket this module uses."""

    async def send_bytes(self, data: bytes) -> None: ...


class _PaintBackend(Protocol):
    """The slice of SessionBackend this module uses."""

    def pane_in_alternate_screen(self) -> bool: ...

    def capture_visible_screen(self) -> bytes: ...

    async def write(self, data: bytes) -> None: ...


async def paint_on_attach(
    websocket: _PaintTarget,
    backend: Optional[_PaintBackend],
) -> str:
    """Make the pane's current screen visible to a freshly attached client.

    Args:
        websocket: Connected client socket. Receives a binary frame in the
            screen-capture case and nothing in the redraw case.
        backend: The session's backend, or None when it could not be
            resolved (in which case there is nothing to do).

    Returns:
        The strategy used, for logging and tests: ``"redraw"`` (Ctrl+L
        written to the pane), ``"screen"`` (capture sent to the client),
        ``"none"`` (no backend, or nothing to paint).

    Example:
        >>> await paint_on_attach(ws, backend)
        'screen'
    """
    if backend is None:
        return "none"

    try:
        alternate = backend.pane_in_alternate_screen()
    except Exception as exc:
        # An unreadable pane state is not a reason to stop painting; fall
        # back to the screen capture, which cannot corrupt an input line.
        logger.warning("ws_paint_alt_probe_failed", error=str(exc))
        alternate = False

    if alternate:
        try:
            await backend.write(_CTRL_L)
            logger.debug("ws_paint_redraw_sent")
            return "redraw"
        except Exception as exc:
            logger.warning("ws_paint_redraw_failed", error=str(exc))
            return "none"

    try:
        screen = backend.capture_visible_screen()
    except Exception as exc:
        logger.warning("ws_paint_capture_failed", error=str(exc))
        return "none"

    if not screen:
        # Nothing on screen yet. Writing Ctrl+L here would be the old bug
        # with extra steps, and there is nothing to repaint anyway - the
        # live stream will carry whatever comes next.
        return "none"

    try:
        await websocket.send_bytes(_CLEAR_AND_HOME + screen)
    except Exception as exc:
        logger.warning("ws_paint_screen_send_failed", error=str(exc))
        return "none"

    logger.debug("ws_paint_screen_sent", size=len(screen))
    return "screen"
