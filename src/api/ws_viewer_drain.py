"""The per-viewer feeders and the ONE writer that owns a viewer's socket.

WHY THIS IS ITS OWN MODULE. ``src/api/websocket.py`` carries the
endpoint, the handshake and the resize negotiation and is already over
this project's 500 line guideline with a registered ceiling
(``tests/test_api_route_modules.py``). These two coroutines are not the
endpoint: they are the transport half of the bounded fan out, and the
one-writer claim below is the whole reason the bound exists.

ONE WRITER PER VIEWER. ``_drain_viewer`` is the only coroutine that
calls ``websocket.send_*`` once the handshake is over. Two coroutines
awaiting ``send`` on one socket interleave frames, and the result is a
corrupted byte stream rather than an exception - nothing else in the
system would report it. ``_pump_text`` is a FEEDER and never touches the
socket, so adding a source of server-to-client messages cannot add a
second writer.
"""

from __future__ import annotations

import asyncio
import base64

import structlog
from fastapi import WebSocket

from src.core import viewer_fanout
from src.core.bounded_stream import BoundedStream

logger = structlog.get_logger()


async def _pump_text(queue: asyncio.Queue, stream: BoundedStream) -> None:
    """Move text messages from a source queue into a viewer's outbox.

    Description: A FEEDER, NOT A WRITER. It never touches the socket, so
      adding a source of server-to-client messages cannot add a second
      coroutine sending on it. The log monitor and the local-server
      tracker each hand out their own unbounded fan-out queue; this is
      where their output enters this viewer's bound and starts counting
      against the same budget as its terminal bytes. Returns when the
      viewer's stream is finished, which is the teardown signal.
    Inputs: queue (asyncio.Queue) - the source's own subscription;
      stream (BoundedStream) - this viewer's outbox.
    Output: None.
    Example: asyncio.create_task(_pump_text(log_queue, viewer_stream))
    """
    try:
        while True:
            message = await queue.get()
            if stream.closed:
                return
            viewer_fanout.offer_text(stream, message)
    except asyncio.CancelledError:
        pass


async def _drain_viewer(
    websocket: WebSocket,
    stream: BoundedStream,
    log_monitor=None,
    session_id=None,
) -> None:
    """THE ONE WRITER for this viewer's socket.

    Description: drains the viewer's bounded outbox and is the only
      coroutine that calls ``websocket.send_*`` once the handshake is
      over. A pty frame is base64 and goes out as a BINARY frame after
      the same pattern detection and idle watching the old
      ``send_pty_output`` did; everything else goes out verbatim as text.
      Returns when the stream finishes - an ordinary teardown or an
      overflow - and the caller reads ``stream.overflowed`` to decide
      what to tell the client.

      A SEND THAT RAISES ENDS THE VIEWER, and the stream is closed so the
      feeders stop offering into a queue nobody will drain.
    Inputs: websocket (WebSocket); stream (BoundedStream) - this viewer's
      outbox; log_monitor - optional, for pattern detection; session_id -
      the session this stream is bound to.
    Output: None.
    Example: asyncio.create_task(_drain_viewer(ws, stream, lm, sid))
    """
    try:
        while True:
            frame = await stream.get()
            if frame is None:
                return
            if frame.kind == viewer_fanout.FRAME_TEXT:
                await websocket.send_text(frame.payload)
                continue

            raw_bytes = base64.b64decode(frame.payload)

            # Pattern detection + idle watching, scoped to THIS session.
            # We skip both when the backend is in replay mode so replayed
            # scrollback doesn't look like "new" activity downstream.
            # THROUGH THE COMPOSITION ROOT, NOT THE MANAGER. This arrived
            # reading ``sm.get_backend`` and ``sm.idle_watchers``, neither
            # of which exists on this line: the registry owns the backend
            # map and AttachmentSidecars owns the watchers. Left as it
            # arrived, ``hasattr`` and ``getattr(..., {})`` would both
            # have answered falsy rather than raising, so pattern
            # detection and idle watching would have gone quietly dead on
            # every session while every test still passed.
            _services = getattr(websocket.app.state, "services", None)
            _registry = getattr(_services, "registry", None)
            _sidecars = getattr(_services, "sidecars", None)
            _backend = None
            _idle_watcher = None
            if _registry is not None:
                if session_id:
                    _backend = _registry.get_backend(session_id)
                    _idle_watcher = (
                        _sidecars.watcher(session_id)
                        if _sidecars is not None
                        else None
                    )
                else:
                    _backend = _registry.current_backend()
                    current = _registry.current_session()
                    _idle_watcher = (
                        _sidecars.watcher(current.id)
                        if current is not None and _sidecars is not None
                        else None
                    )
            in_replay = (
                _backend is not None
                and getattr(_backend, "replay_in_progress", False)
            )
            if log_monitor and not in_replay:
                try:
                    text = raw_bytes.decode("utf-8", errors="replace")
                    log_monitor._detect_patterns(text)
                except Exception as e:
                    # Don't let pattern detection errors break streaming.
                    logger.debug("pattern_detection_error", error=str(e))

            if _idle_watcher is not None and not in_replay:
                try:
                    await _idle_watcher.handle_chunk(raw_bytes)
                except Exception as e:
                    # Terminal streaming is load-bearing, notifications
                    # are not.
                    logger.debug("idle_watcher_chunk_error", error=str(e))

            await websocket.send_bytes(raw_bytes)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.error("drain_viewer_error", error=str(e))
    finally:
        # Stop the feeders offering into a queue nothing will drain. The
        # first close reason wins, so a stream that already overflowed
        # still reports the overflow to the endpoint.
        stream.close()
