"""Every frame that crosses the terminal WebSocket, and the enum that
names them.
"""

from datetime import datetime
from enum import Enum
from pydantic import BaseModel, Field
from .notifications import Toast
from .sessions import SessionStatus


# WebSocket Message Models

class WSMessageType(str, Enum):
    """WebSocket message types."""
    LOG = "log"
    # Plan v3.2 - replaces TUNNEL_CREATED / TUNNEL_STOPPED. Detection-only:
    # when a port shows up in pane output and a TCP listener is confirmed,
    # the tracker emits ``local_server_detected``; the periodic janitor
    # emits ``local_server_lost`` when the listener stops responding.
    LOCAL_SERVER_DETECTED = "local_server_detected"
    LOCAL_SERVER_LOST = "local_server_lost"
    SESSION_STATUS = "session_status"
    COMMAND = "command"
    ERROR = "error"
    PING = "ping"
    PONG = "pong"
    PTY_DATA = "pty_data"
    PTY_RESIZE = "pty_resize"
    # Server -> client. Sent once on WS (re)connect BEFORE any scrollback
    # or live stream. The client reacts by calling fitAddon.fit() and
    # replying immediately with a pty_resize carrying its current cols/rows,
    # bypassing its 100ms debounce. The server then applies the resize to
    # the backend, waits briefly for SIGWINCH to propagate, and sends
    # Ctrl+L so the foreground app redraws at the new size. This replaces
    # the historical-scrollback replay that used to ship frozen bytes
    # drawn at the PREVIOUS size - causing visible corruption whenever
    # the reconnecting client had different dims than the stored session.
    REQUEST_DIMS = "request_dims"
    # v0.7.0 Part 2 - toast notifications. Server -> client when a toast is
    # recorded (via the synthetic POST endpoint in v0.7.0 Part 2; via the
    # Claude Code hook endpoint in Part 3). Server -> client when a toast is
    # acked so OTHER browsers attached to the same session dismiss in sync.
    # Dot notation matches the convention used by ``local_server_*``
    # (underscore) - we use a dot here intentionally so the namespace is
    # visually distinct in client switch statements and log greps.
    TOAST_NEW = "toast.new"
    TOAST_ACK = "toast.ack"
    # Session rename - server -> client. Broadcast to every WS bound to a
    # session id after a successful ``PATCH /sessions/{id}/name``. The client
    # uses it to update the in-session header text, the launchpad row label,
    # and ``document.title``. Dot notation matches ``toast.*`` for namespace
    # consistency in client switch statements.
    SESSION_RENAMED = "session.renamed"
    # fix/multiclient-tmux-size - server -> client, sent after the server
    # applies a negotiated (possibly smaller-than-requested) terminal size
    # to a session with more than one attached client. Lets a client tell
    # that it is being letterboxed for another client's benefit, rather
    # than silently wondering why the pane is smaller than its own
    # viewport. See src/core/terminal_size.py for the negotiation rule.
    TERMINAL_SIZE = "terminal_size"
    # ---- the application event channel, /ws/events (issue 34) ----------
    # These travel on the per-BROWSER socket rather than the per-session
    # terminal one, so they reach a client sitting on the home screen or
    # looking at a different session. Dot notation, matching ``toast.*``.
    #
    # Server -> client, once, as the FIRST frame after a successful
    # handshake. It means "you are receiving notices now, and you missed
    # everything before this instant", and the client answers it with an
    # authoritative refresh. It is deliberately NOT a catch-up: nothing is
    # replayed and nothing is buffered for a client that is not connected.
    EVENTS_HELLO = "events.hello"
    # Server -> client. A COMPACT change notice about one session: the
    # instance it is about, and the handful of fields a list row paints.
    # Never a whole SessionInfo - a notice carrying a full payload would
    # be a second serialization of /sessions/list and would drift from it.
    # Distinct from the legacy ``session_status`` value above, which is a
    # different message on the terminal socket.
    SESSION_STATUS_CHANGED = "session.status"
    # Server -> client. The STRUCTURAL notice: the shape of the list
    # changed, re-read it. It carries no payload at all, on purpose - a
    # notice that says "re-read" cannot go stale or disagree with the
    # endpoint the client then reads.
    SESSIONS_CHANGED = "sessions.changed"
    # Server -> client. The typed ui_preferences block committed a change.
    # This literal predates the channel (it shipped on the terminal socket
    # and still goes out there for a client holding one) and is named here
    # so the enum stays the ONE vocabulary rather than acquiring a second
    # one made of loose strings. See src/api/preferences_routes.py.
    PREFERENCES_CHANGED = "preferences.changed"
    # Server -> client, sent ONCE per socket, after the dimension
    # handshake, after the attach paint, and after any configured startup
    # command has been written into the pane. It is the only positive
    # statement this protocol makes that the pane is able to receive
    # input, and it exists because the window before it is not merely
    # slow: the handshake loop in src/api/websocket.py deliberately DROPS
    # binary frames that arrive before the client's pty_resize, so a
    # keystroke typed during a connect is discarded with no trace.
    #
    # ADDITIVE, AND THAT IS LOAD-BEARING. A client that never reads this
    # message behaves exactly as it did before the message existed: it
    # sends input the moment its socket is OPEN, which is what every
    # client did until now. Nothing on the server waits for an
    # acknowledgement and nothing is gated on it, so an old client is not
    # degraded, only unbuffered.
    TERMINAL_READY = "terminal.ready"


class ToastNewMessage(BaseModel):
    """WS server -> client: a new toast was recorded for this session."""
    type: WSMessageType = WSMessageType.TOAST_NEW
    toast: Toast


class ToastAckMessage(BaseModel):
    """WS server -> client: a toast was acked; other tabs should dismiss it."""
    type: WSMessageType = WSMessageType.TOAST_ACK
    toast_id: str


class SessionRenamedMessage(BaseModel):
    """WS server -> client: a session was renamed; clients should update
    their displayed name, the launchpad row label, and ``document.title``.

    Broadcast by ``PATCH /sessions/{session_id}/name`` after the underlying
    ``tmux rename-session`` succeeds and in-memory state has been re-keyed.
    """
    type: WSMessageType = WSMessageType.SESSION_RENAMED
    session_id: str = Field(..., description="Session id whose name changed")
    new_name: str = Field(..., description="New tmux session name")


class WSLogMessage(BaseModel):
    """WebSocket log message."""
    type: WSMessageType = WSMessageType.LOG
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    content: str
    log_type: str = "stdout"

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class WSLocalServerDetectedMessage(BaseModel):
    """Server -> client event when a new local dev server is detected."""
    type: WSMessageType = WSMessageType.LOCAL_SERVER_DETECTED
    session: str
    port: int
    url: str


class WSLocalServerLostMessage(BaseModel):
    """Server -> client event when a tracked local server stops responding."""
    type: WSMessageType = WSMessageType.LOCAL_SERVER_LOST
    session: str
    port: int


class WSSessionStatusMessage(BaseModel):
    """WebSocket session status message."""
    type: WSMessageType = WSMessageType.SESSION_STATUS
    status: SessionStatus
    uptime: int = 0


class WSCommandMessage(BaseModel):
    """WebSocket command message (client -> server)."""
    type: WSMessageType = WSMessageType.COMMAND
    command: str


class WSErrorMessage(BaseModel):
    """WebSocket error message."""
    type: WSMessageType = WSMessageType.ERROR
    error: str
    message: str


class WSPTYDataMessage(BaseModel):
    """WebSocket PTY data message (server -> client)."""
    type: WSMessageType = WSMessageType.PTY_DATA
    data: str  # Base64 encoded for binary safety


class WSPTYInputMessage(BaseModel):
    """WebSocket PTY input message (client -> server)."""
    type: WSMessageType = WSMessageType.PTY_DATA
    data: str  # User input to send to PTY


class WSPTYResizeMessage(BaseModel):
    """WebSocket PTY resize message (client -> server)."""
    type: WSMessageType = WSMessageType.PTY_RESIZE
    cols: int
    rows: int


class WSTerminalReadyMessage(BaseModel):
    """The pane can take input now (server -> client), sent once.

    ``startup_command`` says which ready case this is, in four words that
    are deliberately not collapsible to two. ``issued`` - a configured
    terminal command's bytes were written into the pane just before this
    message, so the first thing the user sees is that command's output.
    ``none`` - nothing was configured, and the pane is at a bare prompt.
    ``failed`` - a command WAS configured and every write attempt failed,
    so the pane is at a prompt the user did not ask for. ``unknown`` - the
    flush could not be run or raised, so what reached the pane was never
    established. A reading that did not happen is not a reading of
    nothing, which is why the last two are separate from ``none``.

    The message is sent in all four cases: readiness is about the pane
    being able to take input, and a startup command that failed does not
    make the pane unable to take input. Never withhold it.

    Example:
        WSTerminalReadyMessage(startup_command="none").model_dump()
    """
    type: WSMessageType = WSMessageType.TERMINAL_READY
    startup_command: str = Field(
        "unknown",
        description="'issued' | 'none' | 'failed' | 'unknown' - what the "
                    "startup command flush did, not what it was",
    )
