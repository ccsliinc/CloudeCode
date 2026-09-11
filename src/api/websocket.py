"""WebSocket endpoints for real-time PTY communication."""

# JWT auth via Sec-WebSocket-Protocol: client sends ['cloude.jwt.v1', <token>].

import asyncio
import json
import base64
from datetime import datetime
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Optional, Set
import structlog

from src.models import (
    WSMessageType,
    WSPTYDataMessage,
    WSPTYInputMessage,
    WSPTYResizeMessage,
    WSErrorMessage,
    WSTerminalReadyMessage
)
from src.api.attach_settle import (
    NO_RESIZE_ATTEMPTED,
    ResizeOutcome,
    decide_settle,
    read_pane_geometry,
    settle_if_needed,
)
from src.api.deps import verify_jwt_from_subprotocol, SUBPROTOCOL_MARKER
from src.api.ws_connections import ConnectionManager, connection_manager, _resolve_backend
from src.api.ws_viewer_drain import _drain_viewer, _pump_text
from src.api.resize_negotiation import (
    apply_negotiated_resize,
    release_client_resize,
)
from src.api.ws_startup_paint import paint_on_attach
from src.core import viewer_fanout
from src.core.bounded_stream import OFFER_ACCEPTED, BoundedStream

logger = structlog.get_logger()

router = APIRouter()

@router.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    """
    WebSocket endpoint for real-time PTY terminal streaming.

    Provides bidirectional communication:
    - Server -> Client: PTY output data (base64 encoded)
    - Client -> Server: User input, resize events

    Args:
        websocket: WebSocket connection

    Auth protocol:
        Client opens WS with subprotocols=["cloude.jwt.v1", <jwt_token>].
        Server validates the JWT, accepts the handshake echoing the marker
        as the negotiated subprotocol. Failures close with:
          - 4401 on missing marker / missing token / invalid token
          - 4400 on malformed Sec-WebSocket-Protocol header
    """
    # Validate auth BEFORE accepting. If we close pre-accept, FastAPI sends
    # HTTP 403 (the browser sees the handshake fail), which is the correct
    # behavior - no WS connection is ever established with an invalid token.
    ok, detail = verify_jwt_from_subprotocol(websocket)
    if not ok:
        # Close codes in the 4xxx app range per RFC 6455 / IANA registry.
        # 4401 = auth failure (our convention, modeled on HTTP 401).
        # 4400 = bad request - header present but malformed (empty /
        #        whitespace-only). Absence of the header is an auth failure
        #        (client simply didn't present credentials), not a protocol
        #        error.
        raw_header = websocket.headers.get("sec-websocket-protocol")
        header_present_but_empty = (
            raw_header is not None
            and (not raw_header.strip() or all(not p.strip() for p in raw_header.split(",")))
        )
        code = 4400 if header_present_but_empty else 4401
        logger.warning(
            "websocket_auth_failed",
            reason=detail,
            close_code=code,
            has_header=raw_header is not None,
        )
        await websocket.close(code=code, reason=detail or "auth failed")
        return

    # Echo the subprotocol marker back - required by RFC 6455 § 4.1. If we
    # accept() without a matching subprotocol the browser will drop the
    # connection client-side even though the TCP handshake "succeeded".
    await websocket.accept(subprotocol=SUBPROTOCOL_MARKER)

    # Get app state
    session_manager = websocket.app.state.session_manager
    # The live session table is the registry's, not the manager's.
    registry = websocket.app.state.services.registry
    local_servers = websocket.app.state.local_servers
    log_monitor = websocket.app.state.log_monitor

    # ---- session scoping --------------------------------------------------
    # Which session is this WS for? Path is ``/ws/terminal?session_id=<id>``.
    # Missing query param → fall back to the current (most-recent) session
    # so legacy single-session clients (and the auth-only test) keep working.
    requested_sid = websocket.query_params.get("session_id")
    target_sid: Optional[str] = None
    if requested_sid:
        if requested_sid not in registry.sessions:
            # Unknown session id - close with a clear app-range code.
            logger.warning("ws_unknown_session", session_id=requested_sid)
            await websocket.close(code=4404, reason="unknown session")
            return
        target_sid = requested_sid
    else:
        cur = registry.current_session()
        target_sid = cur.id if cur is not None else None

    # Subscribe to THIS session's PTY output only. Taken BEFORE the
    # registration below because the registration needs the stream: every
    # broadcast into this socket goes through it, and a socket registered
    # without one cannot be written to at all.
    # THE VIEWER'S BOUNDED OUTBOX, from the registry that owns the
    # subscriber list on this line. It arrived as
    # ``session_manager.subscribe_output``; that seam does not exist here.
    viewer_stream = registry.subscribe(target_sid)

    await connection_manager.connect(websocket, viewer_stream)
    # v0.7.0 Part 2 - register the WS in the per-session reverse map so
    # ``broadcast_to_session`` can target it for toast fanout. Bind AFTER
    # the validated session id has been resolved so the map never holds
    # entries for sessions that don't exist.
    connection_manager.bind_session(websocket, target_sid)
    # feat/hook-driven-status - a WS terminal actually binding to a
    # session is the strongest "the user is looking at this" signal the
    # server has (stronger than merely appearing in a /sessions/list poll
    # response), so this is where the auto-unread flag (set by a Stop
    # hook) clears. Best-effort: an unknown session_manager shim without
    # the method, or any internal error, must never break the WS connect.
    if target_sid and hasattr(session_manager, "mark_session_viewed"):
        try:
            session_manager.mark_session_viewed(target_sid)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "mark_session_viewed_failed", session_id=target_sid, error=str(exc)
            )

    # Subscribe to local-server events (replaces the old tunnel queue -
    # carries `local_server_detected` / `local_server_lost` payloads).
    local_servers_queue = local_servers.subscribe()

    # Subscribe to log events (keep for system messages)
    log_queue = log_monitor.subscribe()

    # Send initial connection message
    try:
        welcome_msg = {
            "type": "log",
            # Lowercase and unbracketed: this is rendered as a UI notice
            # now, not written into the xterm buffer, so it no longer
            # needs to look like a terminal banner.
            "content": "websocket connected, pty terminal ready",
            "timestamp": datetime.utcnow().isoformat()
        }
        await websocket.send_text(json.dumps(welcome_msg))
    except Exception as e:
        logger.error("failed_to_send_welcome", error=str(e))

    # ---- Resize handshake (replaces legacy scrollback replay) ----
    #
    # Why the handshake: historical scrollback was captured at the pane's
    # PREVIOUS geometry. If the reconnecting client's viewport is different
    # (common - rotation, window resize, different device), replaying those
    # frozen bytes paints them at the wrong coordinates and you get visible
    # character shrapnel until the next full app redraw.
    #
    # New contract:
    #   1. Server -> Client:  {"type": "request_dims"}
    #   2. Client -> Server:  {"type": "pty_resize", cols, rows}  (bypasses
    #                         the 100ms debounce client-side - this is the
    #                         handshake path, not a normal user-driven
    #                         resize)
    #   3. Server reads the PANE's own #{pane_width}/#{pane_height}, then
    #      applies backend.resize(cols, rows) unless the pane is already
    #      measured at the negotiated size.
    #   4. Server sleeps ~150ms so SIGWINCH reaches the pane's foreground
    #      process (Claude/bash/etc.) and that process has a chance to
    #      finish any in-flight ANSI write before we stomp its buffer -
    #      but ONLY when there is something to wait for. Three outcomes,
    #      and the third is why this is not a two-way branch:
    #        - pane measured AND already at the negotiated grid: no
    #          resize, no sleep. The common reconnect.
    #        - pane measured and DIFFERENT: resize issued, sleep as ever.
    #        - pane could not be measured, or the resize failed: sleep as
    #          ever. A reading that did not happen is not a reading of
    #          nothing, and treating unknown as unchanged would leave the
    #          pane's grid disagreeing with the browser, invisibly, until
    #          the user typed. See src/api/attach_settle.py.
    #   5. Server paints the pane's screen (see ws_startup_paint). Every
    #      pane, full-screen TUI or not, gets its visible screen captured
    #      post-resize and sent to the client. Nothing is written into
    #      the pane: Ctrl+L into a canonical-mode line reader is data
    #      rather than a redraw, and Claude Code's fullscreen renderer
    #      answers it with a full erase plus only a partial repaint.
    #      Live-stream bytes then arrive via pipe-pane as usual.
    #
    # Trade-off: user loses historical scrollback on reconnect. Accepted
    # because a clean screen beats a corrupted one, and xterm.js retains
    # its own client-side scrollback within a single page load anyway.
    try:
        await websocket.send_text(json.dumps({
            "type": WSMessageType.REQUEST_DIMS,
        }))
        logger.debug("ws_request_dims_sent")

        # Wait for the client's handshake pty_resize. We accept the NEXT
        # pty_resize message we see and ignore binary input and other
        # control frames until it arrives. Bounded timeout: if the client
        # never replies, we still proceed (backend stays at birth dims and
        # the paint captures the pane at whatever size that is).
        handshake_cols: Optional[int] = None
        handshake_rows: Optional[int] = None
        handshake_deadline_s = 2.0  # generous but bounded
        handshake_start = asyncio.get_event_loop().time()
        while True:
            remaining = handshake_deadline_s - (
                asyncio.get_event_loop().time() - handshake_start
            )
            if remaining <= 0:
                logger.warning("ws_handshake_timeout")
                break
            try:
                raw = await asyncio.wait_for(
                    websocket.receive(),
                    timeout=remaining,
                )
            except asyncio.TimeoutError:
                logger.warning("ws_handshake_timeout")
                break

            if "text" in raw and raw["text"]:
                try:
                    msg = json.loads(raw["text"])
                except json.JSONDecodeError:
                    continue
                if msg.get("type") == WSMessageType.PTY_RESIZE:
                    try:
                        handshake_cols = int(msg["cols"])
                        handshake_rows = int(msg["rows"])
                    except (KeyError, ValueError, TypeError):
                        logger.warning("ws_handshake_bad_dims", msg=msg)
                    break
                # Ignore other control frames during the handshake window
                # (ping, etc.); they'll be processed by receive_messages
                # once the loop starts.
                continue
            # Drop binary frames that arrive before the handshake - the
            # user can't have typed anything yet. In practice clients
            # don't send binary before their first resize, but be safe.

        if handshake_cols and handshake_rows:
            logger.info(
                "ws_handshake_resize",
                cols=handshake_cols,
                rows=handshake_rows,
            )
            # Measured BEFORE the resize, off the PANE rather than off any
            # cache: a previous socket's negotiated size says nothing about
            # where the pane is now, and a stale value reading "unchanged"
            # is exactly the silent wrong-grid failure this guards.
            measured = await read_pane_geometry(
                _resolve_backend(session_manager, target_sid)
            )
            try:
                outcome = await apply_negotiated_resize(
                    session_manager, target_sid, websocket,
                    handshake_cols, handshake_rows, connection_manager,
                    known_pane_size=measured,
                )
            except Exception as exc:
                logger.error("ws_handshake_resize_failed", error=str(exc))
                # A resize that raised leaves the pane's geometry unknown,
                # which is the strongest possible reason to wait.
                outcome = ResizeOutcome(
                    target=(handshake_cols, handshake_rows),
                    issued=True,
                    failed=True,
                )

            # Let SIGWINCH propagate + foreground app finish any mid-flight
            # write, when a resize actually went out. 150ms is empirically
            # enough for tmux -> pane delivery and for Claude/bash to ack
            # the signal. We use asyncio.sleep so the event loop keeps
            # draining other tasks.
            verdict = decide_settle(measured, outcome)
            await settle_if_needed(verdict)
            logger.debug(
                "ws_handshake_settle",
                settled=verdict.settle,
                reason=verdict.reason,
            )

            # Make the pane's screen visible at the new size. A TUI gets
            # Ctrl+L and repaints itself; anything else gets the pane's
            # visible screen captured post-resize. See ws_startup_paint
            # for why the second branch exists.
            _strategy = await paint_on_attach(
                websocket,
                _resolve_backend(registry, target_sid),
            )
            logger.debug("ws_handshake_painted", strategy=_strategy)
        else:
            # Degraded-mode fallback: client never delivered handshake dims
            # (timeout, bad dims, or disconnect-during-handshake recovered).
            # A frozen banner is the worst possible UX - paint at the
            # pane's current (birth) size so the user sees SOMETHING.
            #
            # SAME RULE, SAME FUNCTION, and it can never take the fast
            # path: with no client geometry there is nothing to confirm
            # unchanged, so this always settles, exactly as before. Both
            # sleep sites go through one gate on purpose - a fast path
            # that is fast on only one branch is worse than either.
            verdict = decide_settle(None, NO_RESIZE_ATTEMPTED)
            await settle_if_needed(verdict)
            _strategy = await paint_on_attach(
                websocket,
                _resolve_backend(registry, target_sid),
            )
            logger.info("ws_handshake_painted_fallback", strategy=_strategy)

        # feat/settings-tabs-and-commands - a console launched from the
        # settings "terminal" tab has a configured command waiting on it.
        # It is typed HERE, after the resize + Ctrl+L repaint above, because
        # that repaint clears anything written earlier: typed at create
        # time the command runs but its output is only in scrollback, and
        # the user lands on a blank prompt. Popped on flush, so a reconnect
        # never re-runs it. Only an ID ever crossed the API boundary; the
        # text comes from config.json (src/core/terminal_commands.py).
        startup_command = "unknown"
        if target_sid and hasattr(session_manager, "flush_pending_terminal_command"):
            try:
                startup_command = await session_manager.flush_pending_terminal_command(
                    target_sid)
            except (OSError, RuntimeError, ValueError, KeyError) as exc:
                # The flush swallows its own write failures, so reaching
                # here means something structural went wrong instead.
                # That leaves what reached the pane UNESTABLISHED, which
                # is a different answer from "nothing was configured".
                logger.warning("ws_pending_terminal_command_failed", error=str(exc))
                startup_command = "unknown"
        elif not target_sid:
            # No session id to resolve a pending command against. Nothing
            # was looked up, so nothing may be claimed about it.
            startup_command = "unknown"
        else:
            # A session manager without the method cannot have a pending
            # command, because nothing could ever have recorded one.
            startup_command = "none"

        # THE PANE CAN TAKE INPUT NOW, AND THIS IS THE ONLY THING THAT
        # SAYS SO. Everything above it - the dims handshake, the settle,
        # the attach paint, the startup command - happens with the socket
        # OPEN and with the handshake loop DISCARDING binary frames, so a
        # client that treats "socket open" as "ready" loses whatever the
        # user typed in that window. Sent once, after all of it, and
        # never withheld: a startup command that failed does not make the
        # pane unable to receive input, so `startup_command` reports what
        # happened rather than gating the message.
        #
        # ADDITIVE. Nothing waits for a reply and nothing is gated on the
        # client having read it, so a client that ignores this message
        # behaves exactly as every client did before it existed.
        try:
            await websocket.send_text(json.dumps(
                WSTerminalReadyMessage(startup_command=startup_command).model_dump()
            ))
            logger.debug("ws_terminal_ready_sent", startup_command=startup_command)
        except (WebSocketDisconnect, RuntimeError) as exc:
            # The client left between the paint and here. The outer
            # handler owns the cleanup; say it happened and carry on so
            # the disconnect is handled in exactly one place.
            logger.info("ws_terminal_ready_not_delivered", error=str(exc))
    except WebSocketDisconnect:
        # Client bailed during the handshake. Let the outer handler deal
        # with cleanup; no point proceeding to the live-stream loop.
        logger.info("ws_handshake_client_disconnected")
        registry.unsubscribe(viewer_stream, target_sid)
        local_servers.unsubscribe(local_servers_queue)
        log_monitor.unsubscribe(log_queue)
        await release_client_resize(
            session_manager, target_sid, websocket, connection_manager)
        connection_manager.disconnect(websocket)
        return
    except Exception as exc:
        logger.error("ws_handshake_error", error=str(exc))

    try:
        # ONE WRITER, THREE FEEDERS. Until issue 38 this was four tasks
        # all calling `websocket.send_*` concurrently, plus whatever a
        # broadcast reached in with. Two coroutines awaiting `send` on one
        # socket interleave frames, and the result is a corrupted stream
        # rather than an exception - nothing in the system reports it. So
        # `_drain_viewer` is now the only thing that touches this socket
        # after the handshake, and everything else OFFERS into the
        # viewer's bounded outbox.
        writer_task = asyncio.create_task(
            _drain_viewer(websocket, viewer_stream, log_monitor, target_sid)
        )
        receive_task = asyncio.create_task(
            receive_messages(websocket, session_manager, target_sid, viewer_stream)
        )
        pump_local_servers_task = asyncio.create_task(
            _pump_text(local_servers_queue, viewer_stream)
        )
        pump_logs_task = asyncio.create_task(
            _pump_text(log_queue, viewer_stream)
        )

        # Wait for any task to complete (or fail)
        done, pending = await asyncio.wait(
            [receive_task, writer_task, pump_local_servers_task, pump_logs_task],
            return_when=asyncio.FIRST_COMPLETED
        )

        # A viewer that crossed its bound is told so with a code it can
        # tell apart from a server restart, so the client recaptures the
        # pane silently instead of showing a reconnect banner. Read BEFORE
        # the cancellations below, because the teardown closes the stream.
        overflowed = viewer_stream.overflowed

        # Cancel remaining tasks. CANCEL AND DO NOT AWAIT: a task parked
        # in an `await` takes the cancellation AT that await and can never
        # resume to send again, so the single-writer claim holds through
        # teardown without this handler waiting on anything.
        for task in pending:
            task.cancel()

        if overflowed:
            logger.warning(
                "viewer_disconnected_queue_overflow",
                session_id=target_sid,
                close_code=viewer_fanout.VIEWER_OVERFLOW_CLOSE_CODE,
                max_chunks=viewer_fanout.MAX_VIEWER_QUEUE_CHUNKS,
                max_bytes=viewer_fanout.MAX_VIEWER_QUEUE_BYTES,
            )
            try:
                await websocket.close(
                    code=viewer_fanout.VIEWER_OVERFLOW_CLOSE_CODE,
                    reason="viewer queue overflow",
                )
            except RuntimeError:
                # Already closing from the other end. The client notices
                # the drop and recaptures, which is the same recovery.
                pass

    except WebSocketDisconnect:
        logger.info("websocket_client_disconnected")
    except Exception as e:
        logger.error("websocket_error", error=str(e))
    finally:
        # Cleanup - unsubscribe ONLY this session's queue. Do NOT detach or
        # destroy the session: other tabs (or a later reconnect) may want it.
        registry.unsubscribe(viewer_stream, target_sid)
        local_servers.unsubscribe(local_servers_queue)
        log_monitor.unsubscribe(log_queue)
        # fix/multiclient-tmux-size - drop this client from size negotiation
        # and re-apply the recomputed effective size so the pane grows back
        # for whoever is left, rather than staying letterboxed forever.
        # Hooked here (the endpoint's own finally, not ConnectionManager.
        # disconnect) because that method is sync bookkeeping with no
        # access to session_manager/resize_terminal or the session id.
        await release_client_resize(
            session_manager, target_sid, websocket, connection_manager)
        connection_manager.disconnect(websocket)


async def receive_messages(
    websocket: WebSocket, session_manager, session_id=None, stream=None
):
    """
    Receive messages from the WebSocket client.

    IT READS AND IT DOES NOT SEND. Its two replies - the pong and the
    input-failure error - are OFFERED into the viewer's outbox so the
    writer task delivers them, because a send from here would be a second
    coroutine on this socket and two of those interleave frames into a
    stream nothing reports as broken. With no stream (an older caller, a
    test double) those replies are skipped rather than sent directly: a
    dropped pong costs a keepalive, and a silent second writer costs a
    corrupted terminal.

    Args:
        websocket: WebSocket connection
        session_manager: SessionManager instance
        session_id: the session this WS is bound to (None = current)
        stream: this viewer's outbox (BoundedStream), or None
    """
    try:
        while True:
            # Try to receive binary data first (PTY input)
            try:
                message = await websocket.receive()

                # Handle binary PTY input
                if "bytes" in message:
                    data = message["bytes"]
                    logger.debug("pty_input_received", data_len=len(data))
                    try:
                        if len(data) <= 16:
                            logger.info("ws_input_short", hex=data.hex(), length=len(data))
                        # Convert bytes to string for PTY input
                        text = data.decode('utf-8')
                        await session_manager.send_input(text, session_id=session_id)
                    except Exception as e:
                        logger.error("input_failed", error=str(e))
                        if viewer_fanout.is_viewer_stream(stream):
                            error_msg = WSErrorMessage(
                                error="input_failed",
                                message=str(e)
                            )
                            viewer_fanout.offer_text(
                                stream, error_msg.model_dump_json()
                            )

                # Handle text messages (control messages)
                elif "text" in message:
                    data = message["text"]
                    try:
                        msg = json.loads(data)
                        msg_type = msg.get("type")

                        if msg_type == WSMessageType.PTY_RESIZE:
                            # Handle terminal resize
                            resize_msg = WSPTYResizeMessage(**msg)
                            logger.info("terminal_resize_request", cols=resize_msg.cols, rows=resize_msg.rows)
                            try:
                                await apply_negotiated_resize(
                                    session_manager, session_id, websocket,
                                    resize_msg.cols, resize_msg.rows,
                                    connection_manager,
                                )
                            except Exception as e:
                                logger.error("resize_failed", error=str(e))

                        elif msg_type == WSMessageType.PING:
                            # Respond to ping, THROUGH THE ONE WRITER.
                            if viewer_fanout.is_viewer_stream(stream):
                                viewer_fanout.offer_text(
                                    stream, json.dumps({"type": WSMessageType.PONG})
                                )

                    except json.JSONDecodeError:
                        logger.warning("invalid_json_received", data=data[:100])
                    except Exception as e:
                        logger.error("message_processing_error", error=str(e))

            except RuntimeError as e:
                # Handle the case where websocket is already disconnected
                if "Cannot call \"receive\" once a disconnect message has been received" in str(e):
                    logger.debug("websocket_already_disconnected", error=str(e))
                    break
                else:
                    logger.error("receive_error", error=str(e))
                    raise
            except Exception as e:
                logger.error("receive_error", error=str(e))
                raise

    except WebSocketDisconnect:
        raise
    except Exception as e:
        logger.error("receive_messages_error", error=str(e))
        raise
