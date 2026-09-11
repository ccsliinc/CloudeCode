"""`/ws/events`: the authenticated, per-browser application event channel.

AUTHENTICATION IS THE TERMINAL SOCKET'S, REUSED VERBATIM. The JWT arrives
in `Sec-WebSocket-Protocol` and is verified by the SAME
`verify_jwt_from_subprotocol` the terminal endpoint calls, with the same
`SUBPROTOCOL_MARKER` echoed back on accept and the same two close codes
(4401 for a missing or invalid token, 4400 for a header that is present
but malformed). There is no second scheme and there must not be: the token
is kept out of the URL on purpose, because query strings are routinely
written to proxy and access logs and the subprotocol header is not.

ONE WRITER, BY CONSTRUCTION. Exactly one coroutine in this file calls
`websocket.send_*` for a given socket - `_drain_to_socket`. The receive
side handles pings by ANSWERING THROUGH THE STREAM rather than by sending
directly, so a pong cannot interleave with a notice mid-frame. The only
sends outside that task are the pre-accept close and the final close,
neither of which can run concurrently with it.

WHAT THE CLIENT DOES ON CONNECT IS THE CORRECTNESS HALF. `events.hello`
means "you are now receiving notices, and you missed everything before
this moment". The client answers it with an AUTHORITATIVE REFRESH: it
re-reads the real endpoints. It does not ask to be caught up and nothing
here replays, because a channel that promised replay would have to buffer
for browsers that may never come back.

AND THE POLL STAYS. Nothing in this file may become load-bearing. A tmux
session someone starts by hand on the `cloude` socket produces no event at
all, so the five second reconciliation is what covers it, and a client
whose socket is down converges on exactly the schedule it did before this
existed.
"""

from __future__ import annotations

import asyncio
import json
from typing import Optional

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from src.api.deps import SUBPROTOCOL_MARKER, verify_jwt_from_subprotocol
from src.core.bounded_stream import BoundedStream
from src.core.event_hub import (
    EVENTS_OVERFLOW_CLOSE_CODE,
    EventClient,
    EventHub,
)
from src.models import WSMessageType

logger = structlog.get_logger()

router = APIRouter()

# A pong is small and there is exactly one in flight per ping, so it
# shares the client's own budget rather than getting a lane of its own.
# A client spamming pings therefore overflows itself, which is the right
# place for that cost to land.
_PONG_FRAME = json.dumps({"type": WSMessageType.PONG})


def _auth_close_code(websocket: WebSocket) -> int:
    """Pick 4400 or 4401 for a failed handshake, exactly as /ws/terminal does.

    Description: a header that is ABSENT means the client presented no
      credentials, which is an auth failure. A header that is present but
      empty or whitespace-only is a malformed request. The distinction is
      the terminal endpoint's and is copied rather than re-decided, so the
      two sockets cannot start answering a bad handshake differently.
    Inputs: websocket (WebSocket) - not yet accepted.
    Output: int - 4400 or 4401.
    """
    raw_header = websocket.headers.get("sec-websocket-protocol")
    header_present_but_empty = (
        raw_header is not None
        and (
            not raw_header.strip()
            or all(not part.strip() for part in raw_header.split(","))
        )
    )
    return 4400 if header_present_but_empty else 4401


async def _drain_to_socket(websocket: WebSocket, stream: BoundedStream) -> str:
    """THE ONE WRITER. Drain this client's stream onto its socket.

    Description: runs until the stream finishes, which happens on an
      ordinary teardown or on an overflow. Returns which, so the caller
      can pick the close code without re-deriving it. A send that raises
      means the socket is gone; the stream is closed so nothing keeps
      offering to it and the reason already recorded is preserved.
    Inputs: websocket (WebSocket) - accepted; stream (BoundedStream).
    Output: str - "overflow" when the stream crossed its bound, else
      "done".
    Example: verdict = await _drain_to_socket(ws, client.stream)
    """
    while True:
        frame = await stream.get()
        if frame is None:
            return "overflow" if stream.overflowed else "done"
        try:
            await websocket.send_text(frame)
        except (WebSocketDisconnect, RuntimeError) as exc:
            # RuntimeError is what starlette raises when the socket has
            # already completed its close handshake. Both mean the same
            # thing here and neither is worth an error line.
            logger.debug("events_send_failed", error=str(exc))
            return "done"


async def _read_from_socket(websocket: WebSocket, stream: BoundedStream) -> None:
    """Read the client's frames, and answer a ping THROUGH THE STREAM.

    Description: the channel is server-to-client, so the only thing a
      client may send is a keepalive. Anything else is ignored rather
      than refused - a newer client sending a frame this server does not
      know must not have its socket torn down. This coroutine never
      sends: routing the pong through the stream is what keeps the single
      writer claim true, and it is the reason a pong can never land
      halfway through a notice.
    Inputs: websocket (WebSocket) - accepted; stream (BoundedStream).
    Output: None. Returns when the client disconnects.
    Example: await _read_from_socket(ws, client.stream)
    """
    while True:
        try:
            message = await websocket.receive()
        except (WebSocketDisconnect, RuntimeError):
            return
        if message.get("type") == "websocket.disconnect":
            return
        text = message.get("text")
        if not text:
            continue
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            logger.debug("events_bad_json_ignored")
            continue
        if isinstance(parsed, dict) and parsed.get("type") == WSMessageType.PING:
            stream.offer(_PONG_FRAME, len(_PONG_FRAME))


@router.websocket("/ws/events")
async def websocket_events(websocket: WebSocket) -> None:
    """The application event channel: one authenticated socket per browser.

    Description: verifies the JWT BEFORE accepting, so an unauthenticated
      client never establishes a connection at all (FastAPI turns a
      pre-accept close into an HTTP 403 and the browser's handshake
      fails). Registers on the hub, sends `events.hello`, then runs
      exactly two tasks: the one writer and the reader. Whichever finishes
      first ends the connection.
    Inputs: websocket (WebSocket).
    Output: None.
    """
    ok, detail = verify_jwt_from_subprotocol(websocket)
    if not ok:
        code = _auth_close_code(websocket)
        logger.warning(
            "events_websocket_auth_failed",
            reason=detail,
            close_code=code,
            has_header=websocket.headers.get("sec-websocket-protocol") is not None,
        )
        await websocket.close(code=code, reason=detail or "auth failed")
        return

    hub: Optional[EventHub] = getattr(websocket.app.state, "event_hub", None)
    if hub is None:
        # Nothing to subscribe to. Refusing is honest and costs the client
        # only the optimisation: its poll is untouched and it converges
        # exactly as it would with the socket down.
        logger.warning("events_websocket_no_hub")
        await websocket.close(code=1011, reason="event hub unavailable")
        return

    await websocket.accept(subprotocol=SUBPROTOCOL_MARKER)

    client: EventClient = hub.register()
    # THE FIRST FRAME IS THE INSTRUCTION TO REFRESH. Everything before
    # this instant was missed and nothing here will replay it, so the
    # client's only sound move is to re-read the authoritative endpoints.
    hello = json.dumps({"type": WSMessageType.EVENTS_HELLO,
                        "client_id": client.client_id})
    client.stream.offer(hello, len(hello))

    writer = asyncio.create_task(_drain_to_socket(websocket, client.stream))
    reader = asyncio.create_task(_read_from_socket(websocket, client.stream))
    verdict = "done"
    try:
        done, pending = await asyncio.wait(
            [writer, reader], return_when=asyncio.FIRST_COMPLETED
        )
        if writer in done and not writer.cancelled():
            verdict = writer.result()
        # CANCEL AND DO NOT AWAIT, which is the same shape /ws/terminal
        # has used since it shipped and is not laziness. A task parked in
        # an `await` takes the cancellation AT that await and can never
        # resume to send again, so cancelling is already enough to keep
        # the single-writer claim true through teardown. Awaiting the
        # cancellations here is what breaks: the framework cancels this
        # handler at the same instant the client closes, and `gather`
        # re-raises a FRESH CancelledError rather than the one the
        # server's cancel scope is watching for - so the scope cannot
        # recognise its own cancellation and the connection tears down as
        # an error instead of a clean close.
        for task in pending:
            task.cancel()
    except WebSocketDisconnect:
        logger.debug("events_client_disconnected", client_id=client.client_id)
    finally:
        hub.unregister(client)

    if verdict == "overflow":
        logger.warning(
            "events_client_closed_overflow",
            client_id=client.client_id,
            close_code=EVENTS_OVERFLOW_CLOSE_CODE,
        )
        try:
            await websocket.close(
                code=EVENTS_OVERFLOW_CLOSE_CODE, reason="event queue overflow"
            )
        except RuntimeError:
            # Already closed from the other end; the client will notice
            # the drop and reconnect, which is the same recovery.
            pass
