"""`/ws/events`: the authenticated per-browser event channel (issue 34).

THE LOAD-BEARING TESTS HERE ARE THE OVERFLOW AND THE SINGLE WRITER, and
both are STRUCTURAL rather than timed. A test that slept and then asserted
"the fast client got its frames" would pass on the broken code too, once
the slow client finally drained, and would flake on a loaded box. So the
slow client here is a stand-in that PARKS until the test releases it: its
queue can only be drained by the test, which makes "the fast client was
served while the slow one was not" a fact about the code rather than a
race the test happened to win.

The negative control matters as much as the positive one. A bound that
fired on everything would pass the overflow test perfectly and would make
the channel useless, so a client inside its bound is asserted to keep every
frame and stay registered.
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import jwt as pyjwt
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.bounded_stream import (  # noqa: E402
    OFFER_ACCEPTED,
    OFFER_CLOSED,
    OFFER_OVERFLOWED,
    REASON_DONE,
    REASON_OVERFLOW,
    BoundedStream,
)
from src.core.event_hub import (  # noqa: E402
    EVENTS_OVERFLOW_CLOSE_CODE,
    MAX_EVENT_QUEUE_BYTES,
    MAX_EVENT_QUEUE_ITEMS,
    EventHub,
    get_hub,
)
from src.core import session_change_notice  # noqa: E402
from src.models import WSMessageType  # noqa: E402

JWT_SECRET = "test-secret-for-ws-events"


@pytest.fixture(autouse=True)
def patched_auth_config(monkeypatch):
    """Give the JWT verifier a stable secret. Same shape as the terminal
    socket's own auth tests, because this endpoint reuses that verifier."""
    from src.config import settings as real_settings

    fake_auth = SimpleNamespace(
        jwt_secret=JWT_SECRET,
        jwt_expiry_minutes=60,
        access_token_ttl_seconds=900,
        refresh_token_ttl_seconds=604800,
        refresh_grace_seconds=10,
        totp_secret="X" * 32,
    )

    class _FakeSettings:
        def load_auth_config(self):
            return fake_auth

        def __getattr__(self, name):
            return getattr(real_settings, name)

    fake_settings = _FakeSettings()
    monkeypatch.setattr("src.api.auth.settings", fake_settings)
    monkeypatch.setattr("src.api.deps.settings", fake_settings)
    yield


def _mint_token(expiry_minutes: int = 60) -> str:
    payload = {
        "exp": datetime.utcnow() + timedelta(minutes=expiry_minutes),
        "iat": datetime.utcnow(),
        "sub": "claudetunnel_user",
        "typ": "access",
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm="HS256")


@pytest.fixture
def events_app():
    """A FastAPI app carrying only /ws/events and a real hub."""
    from fastapi import FastAPI

    from src.api.events_routes import router as events_router

    app = FastAPI()
    app.state.event_hub = EventHub()
    app.include_router(events_router)
    return app


# ---------------------------------------------------------------- auth


def test_an_unauthenticated_connection_is_refused(events_app):
    """No credential, no socket. Case 2 from the issue."""
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(events_app)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/ws/events") as ws:
            ws.receive_text()
    assert exc.value.code == 4401


def test_an_invalid_token_is_refused(events_app):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(events_app)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            "/ws/events", subprotocols=["cloude.jwt.v1", "not-a-jwt"]
        ) as ws:
            ws.receive_text()
    assert exc.value.code == 4401


def test_a_valid_token_is_accepted_and_the_marker_is_echoed(events_app):
    """The browser drops a socket whose subprotocol was not echoed, so the
    echo is not decoration - without it the handshake fails client side."""
    from fastapi.testclient import TestClient

    client = TestClient(events_app)
    with client.websocket_connect(
        "/ws/events", subprotocols=["cloude.jwt.v1", _mint_token()]
    ) as ws:
        assert ws.accepted_subprotocol == "cloude.jwt.v1"
        hello = ws.receive_json()
        assert hello["type"] == WSMessageType.EVENTS_HELLO


def test_the_token_never_appears_in_the_url(events_app):
    """The credential rides the subprotocol header, and the endpoint must
    not have quietly grown a query-parameter fallback: a token in a URL
    lands in proxy and access logs, which is why it is in the header."""
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(events_app)
    token = _mint_token()
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/ws/events?token={token}") as ws:
            ws.receive_text()
    assert exc.value.code == 4401


# ------------------------------------------------------- the hello frame


def test_the_first_frame_tells_the_client_to_refresh(events_app):
    """`events.hello` is the whole reconnect contract: nothing replays, so
    the client's only sound recovery is to re-read the real endpoints."""
    from fastapi.testclient import TestClient

    client = TestClient(events_app)
    with client.websocket_connect(
        "/ws/events", subprotocols=["cloude.jwt.v1", _mint_token()]
    ) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "events.hello"
        assert hello["client_id"]


def test_a_published_notice_reaches_a_connected_client(events_app):
    """Case 1: a change about ANY session reaches a browser that holds no
    terminal socket for it at all."""
    from fastapi.testclient import TestClient

    client = TestClient(events_app)
    with client.websocket_connect(
        "/ws/events", subprotocols=["cloude.jwt.v1", _mint_token()]
    ) as ws:
        ws.receive_json()  # hello
        hub = events_app.state.event_hub
        hub.publish(
            session_change_notice.build_status_notice(
                session_id="ses_b", activity_status="question", unread=True
            )
        )
        frame = ws.receive_json()
    assert frame["type"] == "session.status"
    assert frame["session_id"] == "ses_b"
    assert frame["activity_status"] == "question"
    assert frame["unread"] is True


# ------------------------------------------------------- the bound


def test_a_stream_inside_its_bound_keeps_every_item():
    """THE NEGATIVE CONTROL. A bound that fired on everything would pass
    the overflow test below and make the channel useless."""
    stream = BoundedStream(max_items=4, max_bytes=1024)
    for i in range(4):
        assert stream.offer(f"frame-{i}", 8) == OFFER_ACCEPTED
    assert stream.closed is False
    assert stream.overflowed is False
    assert stream.queued_items == 4


def test_crossing_the_item_bound_overflows_and_latches():
    stream = BoundedStream(max_items=2, max_bytes=1 << 20)
    assert stream.offer("a", 1) == OFFER_ACCEPTED
    assert stream.offer("b", 1) == OFFER_ACCEPTED
    assert stream.offer("c", 1) == OFFER_OVERFLOWED
    # Latched: nothing more is admitted, so the bound stays a number a
    # reader can reason from rather than one the queue drifts past.
    assert stream.offer("d", 1) == OFFER_CLOSED
    assert stream.overflowed is True
    assert stream.reason == REASON_OVERFLOW


def test_crossing_the_byte_bound_overflows_even_under_the_item_bound():
    """Both bounds are real. For terminal output the item count fires
    first; for a channel carrying a few large frames the byte budget does,
    and a design that only enforced one of them would miss that case."""
    stream = BoundedStream(max_items=1000, max_bytes=100)
    assert stream.offer("small", 60) == OFFER_ACCEPTED
    assert stream.offer("big", 60) == OFFER_OVERFLOWED
    assert stream.overflowed is True


def test_an_ordinary_close_cannot_overwrite_a_recorded_overflow():
    """The teardown always runs after the overflow, so a last-writer-wins
    reason would erase the one fact worth reporting to the client."""
    stream = BoundedStream(max_items=1, max_bytes=1 << 20)
    stream.offer("a", 1)
    assert stream.offer("b", 1) == OFFER_OVERFLOWED
    stream.close(REASON_DONE)
    assert stream.reason == REASON_OVERFLOW
    assert stream.overflowed is True


def test_a_reader_drains_what_was_admitted_before_it_learns_of_closure():
    """Items already inside the bound belong to the consumer. Reporting
    closure before handing them over would drop frames the client was
    entitled to and that nothing forced us to lose."""

    async def scenario():
        stream = BoundedStream(max_items=4, max_bytes=1 << 20)
        stream.offer("one", 3)
        stream.offer("two", 3)
        stream.close(REASON_DONE)
        assert await stream.get() == "one"
        assert await stream.get() == "two"
        assert await stream.get() is None

    asyncio.run(scenario())


def test_the_offer_path_is_synchronous_so_a_producer_never_awaits():
    """THE WHOLE POINT OF THE BOUND'S SHAPE. A bounded `asyncio.Queue`
    would have been the obvious change and would have been wrong: `await
    queue.put` on a full queue is exactly the backpressure into the
    producer that this exists to prevent."""
    assert not asyncio.iscoroutinefunction(BoundedStream.offer)
    assert not asyncio.iscoroutinefunction(EventHub.publish)


# --------------------------------------------------- one slow client


def test_a_stalled_client_never_delays_a_healthy_one():
    """Case 3, STRUCTURALLY. The slow client here can only be drained by
    this test, so "the fast one was served while the slow one was not" is
    a property of the code rather than a race the test won. On a hub that
    awaited a socket, or that shared one queue, the fast client could not
    be ahead of the slow one at all."""
    hub = EventHub(max_items=4, max_bytes=1 << 20)
    fast = hub.register()
    slow = hub.register()

    async def scenario():
        # The slow client reads NOTHING for the whole run.
        for i in range(3):
            assert hub.publish({"type": "sessions.changed", "reason": str(i)}) == 2
            # The fast client is drained immediately, every round.
            frame = await asyncio.wait_for(fast.stream.get(), timeout=1.0)
            assert json.loads(frame)["reason"] == str(i)

        # Full rate for the fast client: nothing was ever held back
        # waiting for the slow one.
        assert fast.stream.queued_items == 0
        assert slow.stream.queued_items == 3
        assert slow.stream.overflowed is False

    asyncio.run(scenario())
    assert hub.client_count == 2


def test_an_overflowing_client_is_dropped_and_the_other_is_untouched():
    """Case 3's second half: the bound disconnects the client that caused
    it and nothing else. A hub that tore down the pass, or that closed
    every client on a bad one, would fail here."""
    hub = EventHub(max_items=2, max_bytes=1 << 20)
    fast = hub.register()
    slow = hub.register()

    async def scenario():
        for i in range(4):
            hub.publish({"type": "sessions.changed", "reason": str(i)})
            if not fast.stream.closed:
                await asyncio.wait_for(fast.stream.get(), timeout=1.0)

        assert slow.stream.overflowed is True
        assert fast.stream.overflowed is False
        assert fast.stream.closed is False
        # The overflowed client left the registry, so it is never offered
        # a second frame and the overflow is one event, not a storm.
        assert hub.client_count == 1

    asyncio.run(scenario())


def test_an_overflowing_client_is_closed_with_a_distinguishable_code(events_app):
    """An APPLICATION code, not 1013, so the client can tell "you fell
    behind, reconnect and re-read" apart from "the server went away" and
    skip its reconnect banner for the first. The recovery is meant to be
    invisible."""
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    events_app.state.event_hub = EventHub(max_items=1, max_bytes=1 << 20)
    client = TestClient(events_app)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            "/ws/events", subprotocols=["cloude.jwt.v1", _mint_token()]
        ) as ws:
            ws.receive_json()  # hello, drains the one slot
            hub = events_app.state.event_hub
            # Two frames against a one-slot bound: the second overflows.
            hub.publish({"type": "sessions.changed", "reason": "a"})
            hub.publish({"type": "sessions.changed", "reason": "b"})
            for _ in range(4):
                ws.receive_text()
    assert exc.value.code == EVENTS_OVERFLOW_CLOSE_CODE


# --------------------------------------------- one writer per viewer


def test_the_endpoint_has_exactly_one_coroutine_that_sends(events_app):
    """ONE WRITER, asserted against the shipped source rather than trusted
    to a comment. Two coroutines awaiting `send` on one socket interleave
    frames, and the failure is a corrupted stream rather than an
    exception, so nothing else in the system would report it."""
    import inspect

    from src.api import events_routes

    source = inspect.getsource(events_routes)
    senders = [
        name
        for name, fn in vars(events_routes).items()
        if inspect.iscoroutinefunction(fn)
        and "websocket.send_" in inspect.getsource(fn)
    ]
    assert senders == ["_drain_to_socket"], senders
    # And the reader answers a ping through the stream, never directly:
    # a pong sent from the read task is the second writer.
    reader_src = inspect.getsource(events_routes._read_from_socket)
    assert "websocket.send" not in reader_src
    assert "stream.offer" in reader_src
    # The whole module sends in exactly the places we expect: the writer,
    # plus the two closes, which cannot run concurrently with it.
    assert source.count("await websocket.send_text(") == 1


def test_a_ping_is_answered_through_the_one_writer(events_app):
    """Behavioural half of the claim above: the pong really does come
    back, and it comes back in the stream's order."""
    from fastapi.testclient import TestClient

    client = TestClient(events_app)
    with client.websocket_connect(
        "/ws/events", subprotocols=["cloude.jwt.v1", _mint_token()]
    ) as ws:
        ws.receive_json()  # hello
        ws.send_text(json.dumps({"type": "ping"}))
        assert ws.receive_json()["type"] == "pong"


def test_an_unrecognised_client_frame_does_not_close_the_socket(events_app):
    """A newer client sending something this server does not know must not
    have its channel torn down - it would lose the optimisation over a
    frame that cost nothing to ignore."""
    from fastapi.testclient import TestClient

    client = TestClient(events_app)
    with client.websocket_connect(
        "/ws/events", subprotocols=["cloude.jwt.v1", _mint_token()]
    ) as ws:
        ws.receive_json()
        ws.send_text(json.dumps({"type": "something.new"}))
        ws.send_text("not json at all")
        ws.send_text(json.dumps({"type": "ping"}))
        assert ws.receive_json()["type"] == "pong"


# ------------------------------------------------------ the notices


def test_a_status_notice_omits_what_was_not_measured():
    """ABSENT IS NOT A DEFAULT. A null would tell the client "this is now
    false"; an omitted field tells it "keep what you hold", which is the
    only honest thing to say about a value nobody read."""
    frame = session_change_notice.build_status_notice(session_id="ses_1")
    assert frame == {"type": "session.status", "session_id": "ses_1"}
    assert "unread" not in frame
    assert "startup_gate" not in frame


def test_a_status_notice_carries_only_compact_fields():
    """Compact is the design, not an optimisation: a notice carrying a
    whole SessionInfo becomes a second serialization of /sessions/list
    with its own bugs, and the two drift."""
    frame = session_change_notice.build_status_notice(
        session_id="ses_1",
        tmux_session="cloude_x",
        epoch=1700000000,
        activity_status="working",
        unread=False,
        startup_gate="ready",
    )
    assert set(frame) == {
        "type",
        "session_id",
        "tmux_session",
        "epoch",
        "activity_status",
        "unread",
        "startup_gate",
    }


def test_the_structural_notice_carries_no_data():
    """It says re-read, and a notice that says re-read cannot go stale."""
    frame = session_change_notice.build_structural_notice("created")
    assert frame == {"type": "sessions.changed", "reason": "created"}


def test_creating_and_destroying_a_session_publish_the_structural_notice():
    """A helper nothing calls is not a feature, it is dead code that
    passes its own tests. Asserted against the shipped route source
    because the alternative is standing a whole SessionManager up to
    watch two one-line calls."""
    import inspect

    # THE HANDLERS LIVE IN THE SIBLING THAT OWNS THE RESOURCE on this
    # line; src/api/routes.py is the assembly and the registration order
    # and re-exports nothing but ``router``, deliberately.
    from src.api import session_crud_routes as routes

    create_src = inspect.getsource(routes.create_session)
    destroy_src = inspect.getsource(routes.destroy_session)
    assert 'build_structural_notice("created")' in create_src
    assert 'build_structural_notice("destroyed")' in destroy_src
    # And on the SUCCESS path in each, not in an error branch: the notice
    # must not fire for a create that raised.
    assert create_src.index("build_structural_notice") < create_src.index(
        "except HTTPException:"
    )


def test_publishing_without_a_hub_is_a_no_op():
    """Every publish site is fail-soft. An app built without the channel
    must behave exactly as it did before this existed."""
    assert session_change_notice.publish(SimpleNamespace(), {"type": "x"}) == 0
    assert get_hub(SimpleNamespace()) is None


def test_an_unencodable_frame_is_refused_rather_than_delivered_broken():
    """A frame this process built and cannot encode is a defect in the
    caller. Publishing nothing is correct - every client converges on its
    next poll - and it must not take the hub down with it."""
    hub = EventHub()
    client = hub.register()
    assert hub.publish({"type": "x", "bad": object()}) == 0
    assert client.stream.closed is False
    assert hub.client_count == 1


def test_the_published_bounds_are_the_ones_the_plan_named():
    """1 MiB or 256 events per client, from the plan's Interfaces section.
    Pinned so a later tuning pass has to argue with a test."""
    assert MAX_EVENT_QUEUE_ITEMS == 256
    assert MAX_EVENT_QUEUE_BYTES == 1 * 1024 * 1024


def test_the_frame_types_live_in_the_one_message_enum():
    """One vocabulary. A loose string beside the enum is how a second one
    starts, and the two then disagree about a value nobody diffed."""
    assert WSMessageType.EVENTS_HELLO.value == "events.hello"
    assert WSMessageType.SESSION_STATUS_CHANGED.value == "session.status"
    assert WSMessageType.SESSIONS_CHANGED.value == "sessions.changed"
    assert WSMessageType.PREFERENCES_CHANGED.value == "preferences.changed"

    from src.api.preferences_routes import PREFERENCES_CHANGED_EVENT

    assert PREFERENCES_CHANGED_EVENT == WSMessageType.PREFERENCES_CHANGED.value


def test_the_status_notice_is_not_gated_by_the_notification_mute():
    """That looks like a hole and is not. A mute suppresses the
    INTERRUPTION - the toast, the push - and changes nothing about what a
    row is allowed to say. A muted session's light updates on the poll
    today, so a channel that refused to report it would make the row
    visibly staler than before the channel existed."""
    import inspect

    source = inspect.getsource(session_change_notice.publish_hook_status)
    assert "policy" not in source
    assert "mute" not in source
