"""WebSocket endpoints for real-time communication."""

import asyncio
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Set
import structlog

from src.models import WSMessageType, WSCommandMessage, WSErrorMessage

logger = structlog.get_logger()

router = APIRouter()


class ConnectionManager:
    """Manages WebSocket connections."""

    def __init__(self):
        """Initialize connection manager."""
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        """
        Accept and register a new WebSocket connection.

        Args:
            websocket: WebSocket connection to register
        """
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info("websocket_connected", total_connections=len(self.active_connections))

    def disconnect(self, websocket: WebSocket):
        """
        Unregister a WebSocket connection.

        Args:
            websocket: WebSocket connection to unregister
        """
        self.active_connections.discard(websocket)
        logger.info("websocket_disconnected", total_connections=len(self.active_connections))

    async def broadcast(self, message: str):
        """
        Broadcast a message to all connected clients.

        Args:
            message: Message to broadcast (JSON string)
        """
        for connection in self.active_connections.copy():
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error("broadcast_failed", error=str(e))
                self.active_connections.discard(connection)


# Global connection manager
connection_manager = ConnectionManager()


@router.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    """
    WebSocket endpoint for real-time terminal streaming.

    Provides bidirectional communication:
    - Server -> Client: Log entries, tunnel events, session status
    - Client -> Server: Commands to execute

    Args:
        websocket: WebSocket connection
    """
    await connection_manager.connect(websocket)

    # Get app state
    log_monitor = websocket.app.state.log_monitor
    auto_tunnel = websocket.app.state.auto_tunnel
    session_manager = websocket.app.state.session_manager

    # Subscribe to log and tunnel events
    log_queue = log_monitor.subscribe()
    tunnel_queue = auto_tunnel.subscribe()

    try:
        # Create tasks for receiving and sending
        receive_task = asyncio.create_task(
            receive_messages(websocket, session_manager)
        )
        send_logs_task = asyncio.create_task(
            send_queue_messages(websocket, log_queue)
        )
        send_tunnels_task = asyncio.create_task(
            send_queue_messages(websocket, tunnel_queue)
        )

        # Wait for any task to complete (or fail)
        done, pending = await asyncio.wait(
            [receive_task, send_logs_task, send_tunnels_task],
            return_when=asyncio.FIRST_COMPLETED
        )

        # Cancel remaining tasks
        for task in pending:
            task.cancel()

    except WebSocketDisconnect:
        logger.info("websocket_client_disconnected")
    except Exception as e:
        logger.error("websocket_error", error=str(e))
    finally:
        # Cleanup
        log_monitor.unsubscribe(log_queue)
        auto_tunnel.unsubscribe(tunnel_queue)
        connection_manager.disconnect(websocket)


async def receive_messages(websocket: WebSocket, session_manager):
    """
    Receive messages from the WebSocket client.

    Args:
        websocket: WebSocket connection
        session_manager: SessionManager instance
    """
    try:
        while True:
            # Wait for message from client
            data = await websocket.receive_text()

            try:
                message = json.loads(data)
                msg_type = message.get("type")

                if msg_type == WSMessageType.COMMAND:
                    # Handle command
                    command_msg = WSCommandMessage(**message)
                    logger.info("ws_command_received", command=command_msg.command[:50])

                    try:
                        await session_manager.send_command(command_msg.command)
                    except Exception as e:
                        # Send error back to client
                        error_msg = WSErrorMessage(
                            error="command_failed",
                            message=str(e)
                        )
                        await websocket.send_text(error_msg.model_dump_json())

                elif msg_type == WSMessageType.PING:
                    # Respond to ping
                    pong_msg = {"type": WSMessageType.PONG}
                    await websocket.send_text(json.dumps(pong_msg))

            except json.JSONDecodeError:
                logger.warning("invalid_json_received", data=data[:100])
            except Exception as e:
                logger.error("message_processing_error", error=str(e))

    except WebSocketDisconnect:
        raise
    except Exception as e:
        logger.error("receive_messages_error", error=str(e))
        raise


async def send_queue_messages(websocket: WebSocket, queue: asyncio.Queue):
    """
    Send messages from a queue to the WebSocket client.

    Args:
        websocket: WebSocket connection
        queue: Queue to read messages from
    """
    try:
        while True:
            # Wait for message in queue
            message = await queue.get()

            try:
                # Send to client
                await websocket.send_text(message)
            except Exception as e:
                logger.error("send_message_error", error=str(e))
                raise

    except asyncio.CancelledError:
        # Task was cancelled, exit gracefully
        pass
    except Exception as e:
        logger.error("send_queue_messages_error", error=str(e))
        raise
