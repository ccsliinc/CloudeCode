"""The application event channel's fan-out: one bounded stream per browser.

WHAT THIS CLOSES. Until now the only socket in the app was the terminal's,
which exists only while a terminal is open and is scoped to ONE session.
So a browser on the home screen held no socket at all and learned nothing
until its next five second poll, and a browser looking at session A learned
nothing about session B. The preferences work that shipped before this had
to broadcast over that same terminal socket and recorded the gap honestly.
This is the channel that gap was waiting for.

ONE CONNECTION PER BROWSER, NOT PER SESSION. A client registers once and
receives notices about every session it is entitled to see. That is the
whole reason it can work on the home screen.

COMPACT CHANGE NOTICES, NEVER PAYLOADS. A notice says what changed and, at
most, the handful of fields a list row paints. It never carries a whole
`SessionInfo`. If it did, this channel would become a second serialization
of the session list with its own bugs, and the two would drift - the client
would then be showing a row assembled from a source `/sessions/list` never
agreed to. A notice that says "re-read" cannot drift, which is why the
structural notice carries nothing but its own name.

THE HUB NEVER TOUCHES A SOCKET. It offers a frame to each client's
`BoundedStream` and returns. Anything it awaited would be time the hook
route is not answering claude, so `publish` is synchronous by
construction - and that is also what makes one slow browser unable to
delay a notice reaching a fast one.

AN OVERFLOWING CLIENT IS CLOSED, AND ONLY THAT CLIENT. Crossing the bound
closes that client's stream; the endpoint's writer task sees the stream
finish, reads `overflowed`, and closes the socket with a code the client
can tell apart from a server restart. The client then reconnects and
performs an AUTHORITATIVE REFRESH - it re-reads the real endpoints rather
than resuming a stream, because a stream that dropped frames cannot be
resumed into a correct picture. Nothing is replayed and nothing is
buffered for a client that is not there.

THE CHANNEL IS AN OPTIMISATION, NOT A DEPENDENCY. The five second
reconciliation poll is untouched and stays untouched: a tmux session
created by hand on the `cloude` socket generates no event here at all, and
adopting an external session is a first-class case in this app. If this
socket never connects, every screen still converges within one poll.
"""

from __future__ import annotations

import itertools
import json
from typing import Any, Dict, Optional

import structlog

from src.core.bounded_stream import (
    OFFER_ACCEPTED,
    OFFER_OVERFLOWED,
    OVERFLOW_CLOSE_CODE,
    REASON_DONE,
    BoundedStream,
)

logger = structlog.get_logger()


# The bound, from the plan's Interfaces section: 1 MiB or 256 events per
# connected client. Event frames are small (a status notice is under 200
# bytes), so the ITEM bound is the one that fires in practice and the byte
# budget is the backstop that keeps the promise true if a frame ever grows.
MAX_EVENT_QUEUE_ITEMS = 256
MAX_EVENT_QUEUE_BYTES = 1 * 1024 * 1024

# Close code for a client that crossed its bound. IMPORTED, not spelled
# again: the terminal fan-out uses the same number for the same reason
# and a second literal is how the two drift. See bounded_stream.py.
EVENTS_OVERFLOW_CLOSE_CODE = OVERFLOW_CLOSE_CODE


class EventClient:
    """One connected browser's registration on the hub.

    Holds the client's bounded stream and nothing else. The socket lives
    in the endpoint; this object is deliberately ignorant of it so the
    hub can never be made to await one.
    """

    def __init__(self, client_id: str, stream: BoundedStream) -> None:
        """Bind an id to a stream.

        Inputs: client_id (str) - unique within this process, for logs;
          stream (BoundedStream) - this client's outbound queue.
        Output: None.
        """
        self.client_id = client_id
        self.stream = stream


class EventHub:
    """Registry of connected event clients, and the one publish path.

    Not thread safe and does not need to be: every caller is on the one
    event loop.
    """

    def __init__(
        self,
        *,
        max_items: int = MAX_EVENT_QUEUE_ITEMS,
        max_bytes: int = MAX_EVENT_QUEUE_BYTES,
    ) -> None:
        """Build an empty hub.

        Inputs: max_items (int); max_bytes (int) - the per-client bound.
        Output: None.
        Example: hub = EventHub()
        """
        self._clients: Dict[str, EventClient] = {}
        self._ids = itertools.count(1)
        self._max_items = max_items
        self._max_bytes = max_bytes

    # ---- registration -------------------------------------------------

    def register(self) -> EventClient:
        """Add a client and hand back its registration.

        Inputs: none.
        Output: EventClient - caller drains `client.stream` and must call
          `unregister` in its own teardown.
        Example: client = hub.register()
        """
        client_id = f"evt_{next(self._ids)}"
        stream = BoundedStream(
            max_items=self._max_items,
            max_bytes=self._max_bytes,
            label=f"events {client_id}",
        )
        client = EventClient(client_id, stream)
        self._clients[client_id] = client
        logger.info("event_client_registered", client_id=client_id,
                    total_clients=len(self._clients))
        return client

    def unregister(self, client: EventClient) -> None:
        """Remove a client and close its stream. Idempotent.

        Description: closes with the ORDINARY reason, which cannot
          overwrite an overflow already recorded - `BoundedStream.close`
          keeps the first reason, so a teardown following an overflow
          still reports the overflow.
        Inputs: client (EventClient).
        Output: None.
        Example: hub.unregister(client)
        """
        self._clients.pop(client.client_id, None)
        client.stream.close(REASON_DONE)
        logger.info("event_client_unregistered", client_id=client.client_id,
                    total_clients=len(self._clients))

    @property
    def client_count(self) -> int:
        """How many browsers are connected to the event channel."""
        return len(self._clients)

    # ---- publishing ---------------------------------------------------

    def publish(self, frame: Dict[str, Any]) -> int:
        """Offer one frame to every connected client. Never awaits.

        Description: serialises ONCE and hands the same string to every
          client, so the cost of a notice is one `json.dumps` plus one
          `offer` per client rather than one encode each. A client that
          crosses its bound is dropped from the registry here and its
          stream closed; its endpoint learns about it when its writer
          task next wakes, and closes the socket with
          `EVENTS_OVERFLOW_CLOSE_CODE`. No other client is affected and
          nothing is retried.
        Inputs: frame (dict) - a JSON-encodable compact change notice,
          carrying a `type` from `WSMessageType`.
        Output: int - how many clients accepted the frame.
        Example: hub.publish({"type": "sessions.changed"})
        """
        if not self._clients:
            return 0
        try:
            encoded = json.dumps(frame)
        except (TypeError, ValueError) as exc:
            # A frame this process built and cannot encode is a defect in
            # the caller, not in the transport, so it is logged loudly
            # rather than dropped quietly. Publishing nothing is correct:
            # every client converges on its next poll.
            logger.error(
                "event_frame_unencodable",
                frame_type=frame.get("type") if isinstance(frame, dict) else None,
                error=str(exc),
            )
            return 0

        size = len(encoded.encode("utf-8"))
        delivered = 0
        for client in list(self._clients.values()):
            result = client.stream.offer(encoded, size)
            if result == OFFER_ACCEPTED:
                delivered += 1
                continue
            if result == OFFER_OVERFLOWED:
                logger.warning(
                    "event_client_overflowed",
                    client_id=client.client_id,
                    frame_type=frame.get("type"),
                    max_items=client.stream.max_items,
                    max_bytes=client.stream.max_bytes,
                )
            # OFFER_CLOSED reaches here too: the stream is already
            # finished and its endpoint has not torn down yet. Either way
            # the client leaves the registry, so a closed stream is never
            # offered a second frame.
            self._clients.pop(client.client_id, None)
        return delivered


def get_hub(app_state: Any) -> Optional[EventHub]:
    """Read the hub off an app state object, tolerating its absence.

    Description: every publish site is FAIL-SOFT. An app built without
      the channel (an older test harness, a partially constructed app)
      must behave exactly as it did before this existed, so callers that
      cannot find a hub publish nothing and say nothing.
    Inputs: app_state (Any) - typically `request.app.state`.
    Output: EventHub or None.
    Example: hub = get_hub(request.app.state)
    """
    hub = getattr(app_state, "event_hub", None)
    return hub if isinstance(hub, EventHub) else None
