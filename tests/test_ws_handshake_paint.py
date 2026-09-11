"""The attach handshake actually PAINTS, measured by the bytes the client gets.

**THIS FILE EXISTS BECAUSE THE SUITE WAS GREEN WHILE EVERY TERMINAL OPEN
LOST ITS PAINT.** On 1.4.0, `src/api/websocket.py` called
`_resolve_backend(session_manager, target_sid)` at the geometry read while
the two call sites below it correctly passed `registry`. The live session
table moved to `SessionRegistry` in the decomposition, so `SessionManager`
carries no `get_backend`, and `_resolve_backend` had just DROPPED the
`getattr` tolerance that used to turn that into a silent None. The call
raised `AttributeError`.

**THE RAISE WAS SWALLOWED, WHICH IS WHY NOTHING WENT RED.** The handshake
block sits under one `except Exception` that logs `ws_handshake_error` and
falls through to the streaming loop, so the socket lived, bytes still
streamed, and the session looked healthy. What was skipped was the
negotiated resize AND the attach paint - measured on live as
`ws_handshake_resize` 1, `ws_handshake_error` 1, `ws_handshake_painted` 0.
That is the documented mechanism behind this project's wrong-grid and
"input lag" symptom: the client's grid and cursor are never corrected, so
you type and nothing appears where you are looking.

**WHY THIS IS A BEHAVIOURAL TEST AND NOT AN ARGUMENT CHECK.** A test
asserting "line 270 passes a variable named `registry`" passes forever
while someone renames the variable and reintroduces the defect. So this
asserts the OUTCOME instead: a client that completes the handshake
RECEIVES the pane's screen. The marker bytes arriving on the socket are
the same fact the deploy gate measures as a non-zero
`ws_handshake_painted`, so the test and the production gate agree about
what "it works" means.

**THE ASSERTION HAD TO BE THE POSITIVE FACT.** A test that merely opened a
socket and checked it survived would have passed WITH the defect, because
surviving is exactly what the swallow guarantees. Only "the paint arrived"
separates the two.

The negative control is the last test: `SessionManager` genuinely lacks
the members `_resolve_backend` reaches for and `SessionRegistry` genuinely
carries them. Without it, a paint test could go green against a stand-in
that happened to answer both and prove nothing about the real pairing.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

# The token mint and the auth patch are imported rather than copied: two
# spellings of one secret drift the first time either moves. Importing the
# autouse fixture applies it to this module too.
from tests.test_ws_subprotocol_auth import (  # noqa: F401
    _mint_token,
    patched_auth_config,
)

#: What the fake pane "shows". Distinctive so a frame carrying it cannot be
#: confused with a welcome message, a resize ack or a log frame.
PAINT_MARKER = b"CLOUDE-HANDSHAKE-PAINT-MARKER"

SESSION_ID = "ses_paint_probe"
TMUX_NAME = "cloude_paint_probe"

#: THE TEST MUST BOUND ITSELF, AND THIS IS HOW. With the defect present the
#: server sends NOTHING after the dims request - the raise skips the resize,
#: the paint and the readiness message alike, since all three sit inside the
#: one `try` - so a bare `receive()` blocks forever and the suite HANGS
#: rather than failing. A hanging test is worse than a failing one: it
#: reports a timeout with no cause. So the log monitor below emits one
#: sentinel frame after this delay, which reaches the client through the
#: normal fan-out on BOTH paths, and the read loop stops there and reports
#: what it did or did not see. A healthy attach paints in about 150ms (one
#: settle), so this is an order of magnitude of headroom and is only ever
#: WAITED for when the test is about to fail.
SENTINEL_DELAY_SECONDS = 2.5
SENTINEL_TYPE = "cloude.test.handshake-window-closed"


class _PaintableBackend:
    """A backend answering exactly the probes `paint_on_attach` makes.

    Description: implements the `_PaintBackend` protocol slice
      (`pane_in_alternate_screen`, `capture_visible_screen`,
      `session_age_seconds`) and nothing else. Deliberately does NOT carry
      `pane_geometry`, so `read_pane_geometry` lands on its documented
      "unmeasured" rung - this file is about whether the paint happens at
      all, not about the resize arithmetic.
    Inputs (constructor): none.
    Output: an object usable as a session backend by the attach path.
    Example: registry.register(session, _PaintableBackend())
    """

    def __init__(self) -> None:
        self.tmux_session = TMUX_NAME

    def pane_in_alternate_screen(self) -> bool:
        """False - the normal screen, which is the shipped case."""
        return False

    def capture_visible_screen(self) -> bytes:
        """The pane's visible screen. Non-empty, so the paint is a `screen`."""
        return PAINT_MARKER

    def session_age_seconds(self) -> float:
        """Young enough that a blank screen would never be called stalled."""
        return 1.0


class _ParkedQueue:
    """An async queue whose `get` never resolves, so its feeder parks."""

    async def get(self):
        """Block forever. Inputs: none. Output: never returns."""
        import asyncio

        await asyncio.Future()


class _SentinelQueue:
    """Yields ONE frame after a delay, then parks forever.

    Description: the read loop's bound. The server's feeders go through
      `_pump_text` into the viewer's outbox, so a frame offered here is
      delivered as ordinary text on the painted and the unpainted path
      alike - which is what makes it a fair terminator rather than a
      second way of asserting success.
    Inputs (constructor): delay (float) - seconds before the sentinel.
    Output: an object with the async `get` the pump expects.
    Example: _pump_text(_SentinelQueue(2.5), stream)
    """

    def __init__(self, delay: float) -> None:
        self._delay = delay
        self._sent = False

    async def get(self) -> str:
        """The sentinel once, then block. Output: str - a JSON frame."""
        import asyncio

        if self._sent:
            await asyncio.Future()
        self._sent = True
        await asyncio.sleep(self._delay)
        return json.dumps({"type": SENTINEL_TYPE})


class _NoBackendLookupManager:
    """The manager surface the handshake still legitimately uses.

    Description: FAITHFUL ON THE ONE AXIS THAT MATTERS - it carries no
      `get_backend`, exactly like the real `SessionManager` since the
      registry decomposition. A stand-in that answered `get_backend` would
      make this whole file pass against the defect.
    Inputs (constructor): none.
    Output: an object usable as `app.state.session_manager`.
    Example: app.state.session_manager = _NoBackendLookupManager()
    """

    def capture_scrollback(self, lines=3000, session_id=None) -> bytes:
        """No scrollback. Inputs: ignored. Output: empty bytes."""
        return b""

    async def send_input(self, text, session_id=None) -> None:
        """Swallow input. Inputs: text, session_id. Output: None."""

    def resize_terminal(self, cols, rows, session_id=None) -> None:
        """Swallow a resize. Inputs: cols, rows, session_id. Output: None."""


class _FakeLocalServers:
    """Stand-in for `LocalServersTracker` - only the WS surface is needed."""

    def subscribe(self):
        """Output: a queue that never yields."""
        return _ParkedQueue()

    def unsubscribe(self, q) -> None:
        """Inputs: q. Output: None."""


class _FakeLogMonitor:
    """Stand-in for the log monitor, carrying the read loop's terminator."""

    def subscribe(self):
        """Output: a queue yielding one sentinel, then parking."""
        return _SentinelQueue(SENTINEL_DELAY_SECONDS)

    def unsubscribe(self, q) -> None:
        """Inputs: q. Output: None."""

    def _detect_patterns(self, text) -> None:
        """Inputs: text. Output: None."""


@pytest.fixture
def paint_app():
    """A WS app holding ONE session whose backend can be painted.

    Description: mirrors production wiring - the live table is a REAL
      `SessionRegistry` on `app.state.services.registry`, and
      `app.state.session_manager` is the manager surface WITHOUT a
      `get_backend`. That pairing is the whole point: it is the pairing
      that raised on live.
    Inputs: none.
    Output: a FastAPI app with `/ws/terminal` mounted.
    """
    from fastapi import FastAPI

    from src.api.websocket import router as ws_router
    from src.core.sessions.registry import SessionRegistry
    from src.models import Session

    registry = SessionRegistry(log_cap=lambda: 1000)
    registry.register(
        Session(id=SESSION_ID, working_dir="/tmp"),
        _PaintableBackend(),
    )

    app = FastAPI()
    app.state.session_manager = _NoBackendLookupManager()
    app.state.services = SimpleNamespace(registry=registry)
    app.state.local_servers = _FakeLocalServers()
    app.state.log_monitor = _FakeLogMonitor()
    app.include_router(ws_router)
    return app


def _drive_handshake(ws, cols: int = 100, rows: int = 30):
    """Answer the server's dims request and report whether it painted.

    Description: reads frames until the server asks for dimensions, replies
      with one `pty_resize`, then keeps reading until either a BINARY frame
      arrives (the paint) or the sentinel does (the window closed without
      one). Other text frames - the welcome, the readiness message - are
      skipped rather than asserted on, so an unrelated control message
      added to the handshake does not break this.
    Inputs: ws (TestClient websocket); cols (int); rows (int).
    Output: bytes | None - the painted frame, or None when the window
      closed without one.
    Example: painted = _drive_handshake(ws)
    """
    from src.models import WSMessageType

    answered = False
    while True:
        message = ws.receive()

        if message.get("bytes"):
            return message["bytes"]

        text = message.get("text")
        if not text:
            # A close frame ends the stream; report it as "never painted"
            # rather than looping on a socket with nothing left to give.
            if message.get("type") == "websocket.close":
                return None
            continue

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            continue

        if parsed.get("type") == SENTINEL_TYPE:
            return None

        if not answered and parsed.get("type") == WSMessageType.REQUEST_DIMS:
            ws.send_text(json.dumps({
                "type": WSMessageType.PTY_RESIZE,
                "cols": cols,
                "rows": rows,
            }))
            answered = True


def test_a_completed_handshake_paints_the_pane_to_the_client(paint_app):
    """THE ONE THAT WOULD HAVE CAUGHT IT.

    Description: drives the real handshake against the real registry and
      asserts the pane's screen REACHES the client. With
      `_resolve_backend(session_manager, ...)` the geometry read raises,
      the swallow skips the paint, and no binary frame is ever sent.
    """
    from fastapi.testclient import TestClient

    client = TestClient(paint_app)
    token = _mint_token()

    with client.websocket_connect(
        f"/ws/terminal?session_id={SESSION_ID}",
        subprotocols=["cloude.jwt.v1", token],
    ) as ws:
        painted = _drive_handshake(ws)

    assert painted is not None, (
        "the attach never painted: the handshake window closed without a "
        "single binary frame. This is the 1.4.0 defect - the geometry read "
        "was handed an object with no `get_backend`, the AttributeError was "
        "swallowed, and the resize and the paint were both skipped while "
        "the socket stayed up and streaming"
    )
    assert PAINT_MARKER in painted, (
        "a binary frame arrived but did not carry the pane's screen; the "
        f"attach painted something else: {painted!r}"
    )


def test_the_handshake_does_not_swallow_an_error_on_the_way(paint_app, caplog):
    """The paint must happen on the HAPPY path, not after a swallow.

    Description: `ws_handshake_error` is logged by the one `except
      Exception` wrapping the whole handshake. A paint that arrived while
      that line was also emitted would mean something else on the path is
      raising, which is the exact shape of the defect this file exists for.
      So the absence of that line is asserted ALONGSIDE the paint, never
      instead of it.
    """
    from fastapi.testclient import TestClient

    client = TestClient(paint_app)
    token = _mint_token()

    with caplog.at_level("ERROR"):
        with client.websocket_connect(
            f"/ws/terminal?session_id={SESSION_ID}",
            subprotocols=["cloude.jwt.v1", token],
        ) as ws:
            painted = _drive_handshake(ws)

    assert painted is not None and PAINT_MARKER in painted
    assert "ws_handshake_error" not in caplog.text, (
        "the handshake raised and was swallowed; the paint above may be "
        f"masking a real failure:\n{caplog.text}"
    )


def test_the_two_collaborators_are_not_interchangeable():
    """THE NEGATIVE CONTROL, and it is not optional.

    Description: the tests above are only load-bearing if the object the
      handshake passes actually MATTERS. This asserts the real pairing:
      `SessionRegistry` carries the lookups `_resolve_backend` makes and
      `SessionManager` does not, so passing the manager cannot quietly
      work. If this ever goes green in both directions - a forwarder added
      back to the manager, say - the paint tests stop proving anything
      about which object was passed, and this says so rather than leaving
      them looking like they still do.
    """
    from src.core.session_manager import SessionManager
    from src.core.sessions.registry import SessionRegistry

    for member in ("get_backend", "current_backend"):
        assert hasattr(SessionRegistry, member), (
            f"SessionRegistry lost {member}; _resolve_backend's contract "
            "moved and this suite is now measuring the wrong pairing"
        )
        assert not hasattr(SessionManager, member), (
            f"SessionManager grew {member}. That is not automatically "
            "wrong, but it makes the wrong-object defect silent again, so "
            "the paint tests above no longer prove which object was passed"
        )
