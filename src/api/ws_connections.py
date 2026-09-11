"""The per-viewer connection registry, and the one place a broadcast enters it.

WHY THIS IS ITS OWN MODULE. ``src/api/websocket.py`` is the endpoint, the
session scoping and the resize handshake, and it is already over this
project's 500 line guideline with a REGISTERED ceiling that may shrink or
hold and may not grow (``tests/test_api_route_modules.py``). The
integration that brought the bounded fan out over added a one-writer
teardown, a readiness message and a per-viewer outbox to this class, so
it moved out rather than pushing the endpoint further past its number.

EVERY BROADCAST PATH OFFERS INTO A VIEWER'S OUTBOX AND NEVER CALLS
``send_*`` ITSELF. A broadcast arriving from a toast, a rename or a
resize while that viewer's writer task is mid-send would be a SECOND
writer on one socket, and two coroutines awaiting ``send`` there
interleave frames into a corrupted byte stream that nothing reports. The
single writer is ``ws_viewer_drain._drain_viewer``.
"""

from __future__ import annotations

import json
from typing import Optional, Set

import structlog
from fastapi import WebSocket

from src.core import viewer_fanout
from src.core.bounded_stream import BoundedStream

logger = structlog.get_logger()


def _resolve_backend(registry, session_id: Optional[str]):
    """The backend for a session id, or for the current session.

    Description: takes the ``SessionRegistry`` rather than the manager,
      because the registry is what owns the ``backends`` map. The two
      ``hasattr`` / ``getattr`` guards this used to carry were tolerance
      for a manager that might not have the methods; a moved field read
      through tolerance answers None instead of raising, which is a
      silent wrong answer rather than a loud failure.
    Inputs: registry (SessionRegistry); session_id (str | None) - None
      asks for the current session's backend.
    Output: SessionBackend | None - None when nothing is registered
      under that id, or when nothing is registered at all.
    Example: _resolve_backend(services.registry, "ses_1")
    """
    if session_id:
        return registry.get_backend(session_id)
    return registry.current_backend()


class ConnectionManager:
    """Manages WebSocket connections.

    v0.7.0 Part 2: tracks a session_id -> {WebSocket} reverse map alongside
    the flat set, so ``broadcast_to_session`` can target only the sockets
    bound to a specific session. The existing ``broadcast`` (fanout-to-all)
    is preserved for the legacy session-status / log paths that genuinely
    want every client.
    """

    def __init__(self):
        """Initialize connection manager."""
        self.active_connections: Set[WebSocket] = set()
        # websocket -> that viewer's ONE outbox. Every broadcast path
        # OFFERS into this rather than calling `send_text` on the socket,
        # because a broadcast arriving from a toast, a rename or a resize
        # while the viewer's writer task is mid-send is a second writer -
        # and two coroutines awaiting `send` on one socket interleave
        # frames into a corrupted stream that nothing reports. See
        # src/core/viewer_fanout.py.
        self._streams: dict[int, BoundedStream] = {}
        # session_id -> set of WS connections currently bound to that
        # session. Populated by ``connect_to_session`` on the WS handshake;
        # pruned by ``disconnect``. A connection can only ever be bound to
        # ONE session (the WS endpoint is session-scoped), so we don't
        # also need a reverse WS->session map - we walk the dict on
        # disconnect, which is O(N_sessions) and dwarfed by the WS RTT.
        self._session_connections: dict[str, Set[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, stream=None):
        """
        Accept and register a new WebSocket connection.

        NOTE: As of the subprotocol-auth change (Item 3), the handler is
        responsible for calling `websocket.accept(subprotocol=...)` BEFORE
        invoking this method - the browser requires the server to echo the
        negotiated subprotocol, so accept() must happen at the auth site.
        This method now only registers an already-accepted socket.

        Args:
            websocket: WebSocket connection to register (already accepted)
        """
        self.active_connections.add(websocket)
        if viewer_fanout.is_viewer_stream(stream):
            self._streams[id(websocket)] = stream
        logger.info("websocket_connected", total_connections=len(self.active_connections))

    def bind_session(self, websocket: WebSocket, session_id: Optional[str]) -> None:
        """Record that ``websocket`` is bound to ``session_id``.

        Idempotent. ``session_id`` of None is a no-op (legacy/orphan WS
        sockets that never resolved to a session - e.g. the auth-only
        test path - don't enter the per-session map).
        """
        if not session_id:
            return
        self._session_connections.setdefault(session_id, set()).add(websocket)

    def disconnect(self, websocket: WebSocket):
        """
        Unregister a WebSocket connection.

        Also prunes the per-session reverse map so ``broadcast_to_session``
        never tries to send through a torn-down socket. We walk the dict
        rather than tracking a reverse pointer - the per-session set
        cardinality is low (one tab per session typically) so the cost
        is negligible.

        Args:
            websocket: WebSocket connection to unregister
        """
        self.active_connections.discard(websocket)
        self._streams.pop(id(websocket), None)
        for sid, conns in list(self._session_connections.items()):
            conns.discard(websocket)
            if not conns:
                self._session_connections.pop(sid, None)
        logger.info("websocket_disconnected", total_connections=len(self.active_connections))

    async def broadcast(self, message: str):
        """
        Broadcast a message to all connected clients.

        Args:
            message: Message to broadcast (JSON string)
        """
        for connection in self.active_connections.copy():
            if not self._offer(connection, message):
                self.active_connections.discard(connection)
                self._streams.pop(id(connection), None)

    async def broadcast_to_session(self, session_id: str, message: str) -> int:
        """Broadcast a message to every WS connection bound to ``session_id``.

        Used by the toast routes (v0.7.0 Part 2) to fan a ``toast.new`` or
        ``toast.ack`` payload out to every browser tab attached to the
        session - including the tab that triggered the action, so the
        creator's own UI gets the new toast without a special-case round
        trip. Failures on a single socket are logged + the socket is
        removed from BOTH the per-session map and the flat active set;
        other sockets in the session still receive the message.

        Returns:
            The count of sockets the message was successfully sent to.
            0 when no socket is bound to the session (e.g. the toast
            fires before any browser has attached).
        """
        sent = 0
        conns = self._session_connections.get(session_id)
        if not conns:
            return 0
        for connection in list(conns):
            if self._offer(connection, message):
                sent += 1
            else:
                logger.warning(
                    "broadcast_to_session_undeliverable",
                    session_id=session_id,
                )
                conns.discard(connection)
                self.active_connections.discard(connection)
                self._streams.pop(id(connection), None)
        if not conns:
            self._session_connections.pop(session_id, None)
        return sent

    def _offer(self, websocket: WebSocket, message: str) -> bool:
        """Queue one text frame for a socket's own writer. Never awaits.

        Description: THE SINGLE-WRITER SEAM. Everything that used to call
          ``websocket.send_text`` from a broadcast now lands here, so the
          only coroutine that ever touches a live terminal socket is that
          viewer's writer task. It also stops one unreachable browser
          delaying the rest of a fan-out, because an offer cannot block.
          A socket registered WITHOUT a stream falls back to nothing and
          is reported undeliverable rather than being sent to directly -
          that would be the second writer coming back through the door
          this closes.
        Inputs: websocket (WebSocket); message (str) - JSON to send.
        Output: bool - False when the frame could not be queued, which is
          the caller's signal to drop that socket.
        Example: if not self._offer(ws, payload): drop(ws)
        """
        stream = self._streams.get(id(websocket))
        if stream is None:
            return False
        return viewer_fanout.offer_text(stream, message) == OFFER_ACCEPTED


# Global connection manager

#: THE ONE INSTANCE. Imported by name from the endpoint, the hook route
#: and the rename path, so a test patching it patches what they all use.
connection_manager = ConnectionManager()
