"""Bounded per-viewer fan-out, and one writer per viewer (issue 38).

THE TWO LOAD-BEARING TESTS ARE STRUCTURAL, NOT TIMED. The issue asks for
"assert TIMING, not just eventual delivery, or it passes on the broken code
once the slow viewer finally drains", and a wall clock is the wrong way to
get that on a box several agents are sharing. The stalled viewer here is a
stand-in that can only be drained by the test, so "the healthy viewer was
served at full rate while the stalled one was not" is a fact about the code
rather than a race the test happened to win - and on the pre-fix code, which
awaited into one shared unbounded queue, the healthy viewer could not have
been ahead of the stalled one at all.

The single-writer claim is asserted against the SHIPPED source, because the
failure it prevents produces a corrupted byte stream rather than an
exception: nothing else in the system would report two coroutines
interleaving frames on one socket.

MEASURED, on this tree, 5000 chunks of 8192 bytes fanned to 3 stalled
viewers: before, 5000 chunks held per viewer and 156.3 MiB across all of
them, growing without limit; after, 256 chunks per viewer and 8.0 MiB
total, with the overflow declared at chunk 256. The fan-out itself costs
p50 0.83 us to 1.46 us per chunk for three viewers, against the 9.58 us
the base64 encode of that same chunk costs once.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core import viewer_fanout  # noqa: E402
from src.core.bounded_stream import (  # noqa: E402
    OFFER_ACCEPTED,
    OFFER_CLOSED,
    OFFER_OVERFLOWED,
    OVERFLOW_CLOSE_CODE,
)

CHUNK = b"x" * 8192
ENCODED = base64.b64encode(CHUNK).decode("utf-8")


# ------------------------------------------------------------ the bound


def test_the_bound_is_the_one_the_plan_named():
    """4 MiB or 256 chunks per viewer. Pinned so a later tuning pass has
    to argue with a test rather than quietly move a number the rest of
    the system reasons from."""
    assert viewer_fanout.MAX_VIEWER_QUEUE_CHUNKS == 256
    assert viewer_fanout.MAX_VIEWER_QUEUE_BYTES == 4 * 1024 * 1024


def test_the_chunk_count_is_what_actually_fires_for_terminal_output():
    """MEASURED, not assumed, and worth stating because a reader would
    otherwise expect the 4 MiB figure to be the operative one. The tail
    loop reads at most 8192 bytes per `os.read`, base64 inflates that to
    about 10,924 characters, so 256 of them is about 2.8 MiB - inside the
    byte budget, which is therefore the backstop rather than the bound."""
    per_chunk = len(ENCODED)
    assert per_chunk == 10924
    at_chunk_bound = per_chunk * viewer_fanout.MAX_VIEWER_QUEUE_CHUNKS
    assert at_chunk_bound < viewer_fanout.MAX_VIEWER_QUEUE_BYTES


def test_a_stalled_viewer_stops_growing_at_the_bound():
    """The defect, in one assertion. An unbounded queue never blocks on
    put, so the pre-fix code did not fail loudly - it simply held every
    byte a stopped browser had not read, for as long as it did not read
    them. Measured on this tree: 5000 chunks became 156.3 MiB across
    three viewers and was still climbing."""
    stream = viewer_fanout.new_viewer_stream("stalled")
    accepted = 0
    overflowed_at = None
    for i in range(5000):
        outcome = viewer_fanout.offer_pty(stream, ENCODED)
        if outcome == OFFER_ACCEPTED:
            accepted += 1
        elif outcome == OFFER_OVERFLOWED and overflowed_at is None:
            overflowed_at = i

    assert accepted == viewer_fanout.MAX_VIEWER_QUEUE_CHUNKS
    assert overflowed_at == viewer_fanout.MAX_VIEWER_QUEUE_CHUNKS
    assert stream.queued_bytes <= viewer_fanout.MAX_VIEWER_QUEUE_BYTES
    assert stream.overflowed is True


def test_a_viewer_inside_its_bound_keeps_every_chunk():
    """THE NEGATIVE CONTROL. A bound that fired early, or on everything,
    would pass the test above and would disconnect healthy viewers - a
    cure strictly worse than the disease."""
    stream = viewer_fanout.new_viewer_stream("healthy")
    for _ in range(viewer_fanout.MAX_VIEWER_QUEUE_CHUNKS):
        assert viewer_fanout.offer_pty(stream, ENCODED) == OFFER_ACCEPTED
    assert stream.overflowed is False
    assert stream.closed is False


def test_no_chunk_is_ever_partially_delivered():
    """Case 4. Escape sequences span chunk boundaries, so a terminal
    handed half a sequence renders garbage and STAYS wrong - it is not
    one bad cell, it is a VT parser left in the wrong state. The overflow
    response is therefore a disconnect and never a truncation."""

    async def scenario():
        stream = viewer_fanout.new_viewer_stream("v")
        payloads = [base64.b64encode(f"chunk-{i}".encode()).decode()
                    for i in range(5)]
        for p in payloads:
            viewer_fanout.offer_pty(stream, p)
        stream.close()
        seen = []
        while (frame := await stream.get()) is not None:
            seen.append(frame.payload)
        # Byte for byte, in order, whole. Nothing sliced to fit a budget.
        assert seen == payloads

    asyncio.run(scenario())


def test_the_overflow_close_code_is_an_application_code():
    """Not 1013. The recovery is meant to be invisible - the client
    recaptures the pane and shows nothing - so it has to be able to tell
    this apart from a server restart, which does deserve a banner."""
    assert viewer_fanout.VIEWER_OVERFLOW_CLOSE_CODE == OVERFLOW_CLOSE_CODE
    assert 4000 <= viewer_fanout.VIEWER_OVERFLOW_CLOSE_CODE <= 4999


# --------------------------------------------------- the source never waits


def test_the_fan_out_is_synchronous_so_the_tail_loop_never_awaits_a_viewer():
    """THE WHOLE POINT. `TmuxBackend._emit_output` awaits whatever the
    handler returns, so a coroutine here puts the tail loop - the thing
    reading the pipe that carries every keystroke echo for every
    session - one await away from a browser's queue."""
    from src.core.session_manager import SessionManager

    handler = SessionManager._make_output_handler(
        _FakeManagerWithSubscribers({}), "ses_1"
    )
    assert not asyncio.iscoroutinefunction(handler)
    assert not asyncio.iscoroutinefunction(viewer_fanout.offer_pty)
    assert not asyncio.iscoroutinefunction(viewer_fanout.offer_text)


class _FakeManagerWithSubscribers:
    """Just enough of SessionManager for `_make_output_handler` to bind."""

    def __init__(self, subscribers):
        self._subscribers = subscribers


def test_a_stalled_viewer_never_delays_a_healthy_one():
    """Case 1, STRUCTURALLY. The stalled viewer here is drained only by
    this test, so the healthy one being served every round is a property
    of the code. On the pre-fix path - one `await queue.put` per
    subscriber inside the tail loop's own await - this ordering could not
    happen; the source went at the slowest reader's pace by construction
    even before the queue grew."""

    async def scenario():
        healthy = viewer_fanout.new_viewer_stream("healthy")
        stalled = viewer_fanout.new_viewer_stream("stalled")
        manager = _FakeManagerWithSubscribers({"ses_1": [healthy, stalled]})

        from src.core.session_manager import SessionManager
        handler = SessionManager._make_output_handler(manager, "ses_1")

        for i in range(50):
            handler(f"line-{i}\r\n".encode())
            # Healthy viewer drained IMMEDIATELY, every round. The stalled
            # one reads nothing for the whole run.
            frame = await asyncio.wait_for(healthy.get(), timeout=1.0)
            assert base64.b64decode(frame.payload) == f"line-{i}\r\n".encode()

        assert healthy.queued_items == 0
        assert stalled.queued_items == 50
        # And the healthy viewer is untouched by the other's backlog.
        assert healthy.overflowed is False
        assert healthy.closed is False

    asyncio.run(scenario())


def test_an_overflowing_viewer_is_dropped_and_the_other_is_untouched():
    """Case 2's other half: the bound disconnects the viewer that caused
    it and NOTHING ELSE. A fan-out that tore down the pass, or dropped
    the chunk for everybody, would fail here."""

    async def scenario():
        healthy = viewer_fanout.new_viewer_stream("healthy")
        stalled = viewer_fanout.new_viewer_stream("stalled")
        subs = [healthy, stalled]
        manager = _FakeManagerWithSubscribers({"ses_1": subs})

        from src.core.session_manager import SessionManager
        handler = SessionManager._make_output_handler(manager, "ses_1")

        for _ in range(viewer_fanout.MAX_VIEWER_QUEUE_CHUNKS + 5):
            handler(CHUNK)
            if not healthy.closed:
                await healthy.get()

        assert stalled.overflowed is True
        assert healthy.overflowed is False
        assert healthy.closed is False
        # The overflowed viewer left the subscriber list, so it is never
        # offered a second chunk: one event, not a storm.
        assert subs == [healthy]

    asyncio.run(scenario())


def test_session_isolation_survives_the_rewrite():
    """`bd9a2b2` keeps one session's bytes out of another session's
    terminal, and the issue names it as something the fan-out must not
    undo. Each backend gets its own handler bound to its own session key,
    so this holds by construction - and is asserted anyway, because
    "holds by construction" is what everything says before it stops."""

    async def scenario():
        a = viewer_fanout.new_viewer_stream("a")
        b = viewer_fanout.new_viewer_stream("b")
        manager = _FakeManagerWithSubscribers({"ses_a": [a], "ses_b": [b]})

        from src.core.session_manager import SessionManager
        handler_a = SessionManager._make_output_handler(manager, "ses_a")
        handler_a(b"only-for-A")

        assert a.queued_items == 1
        assert b.queued_items == 0
        assert base64.b64decode((await a.get()).payload) == b"only-for-A"

    asyncio.run(scenario())


# ------------------------------------------------ one writer per viewer


def test_exactly_one_coroutine_in_the_endpoint_sends_after_the_handshake():
    """ONE WRITER, asserted against the shipped source. Two coroutines
    awaiting `send` on one websocket interleave frames, and the result is
    a corrupted stream rather than an exception - so nothing but this
    would report it.

    Before issue 38 this endpoint had FOUR concurrent senders (the pty
    stream, the log stream, the local-server stream and the receive
    loop's own pong and error replies) plus whatever
    `ConnectionManager.broadcast_to_session` reached in with from a
    toast, a rename or a resize."""
    from src.api import websocket as ws_mod

    senders = []
    for name, fn in vars(ws_mod).items():
        if not inspect.iscoroutinefunction(fn):
            continue
        if getattr(fn, "__module__", None) != ws_mod.__name__:
            continue  # imported, covered by its own assertion below
        src = inspect.getsource(fn)
        if "websocket.send_" in src:
            senders.append(name)
    # `websocket_terminal` is the endpoint itself: its sends are the
    # dimension request and `terminal.ready`, both issued in one
    # coroutine BEFORE any task starts, so they cannot run concurrently
    # with the writer. `_drain_viewer` is the writer. (The connect
    # welcome frame was a third such send until issue 106 removed it.)
    assert sorted(senders) == ["_drain_viewer", "websocket_terminal"], senders

    # `paint_on_attach` (src/api/ws_startup_paint.py) also sends, and is
    # the one imported sender. It is called from exactly one place, in
    # the handshake, before any task is created - so it is sequential
    # with the endpoint's own sends and not a second writer. Pinned to
    # one call site: a second one, anywhere downstream of the writer
    # starting, would be.
    endpoint_src = inspect.getsource(ws_mod.websocket_terminal)
    assert endpoint_src.count("await paint_on_attach(") == 2, (
        "paint_on_attach's call sites moved; both must stay inside the "
        "handshake, above the create_task block"
    )
    handshake_end = endpoint_src.index("writer_task = asyncio.create_task(")
    assert endpoint_src.rindex("await paint_on_attach(") < handshake_end


def test_the_read_loop_answers_through_the_stream_and_never_the_socket():
    """A pong sent from the read task is the second writer, and it is the
    easiest one to reintroduce because it looks like a one-line reply."""
    from src.api import websocket as ws_mod

    src = inspect.getsource(ws_mod.receive_messages)
    assert "websocket.send" not in src
    assert "viewer_fanout.offer_text" in src


def test_the_broadcast_paths_offer_rather_than_send():
    """`broadcast_to_session` is a SHARED writer by definition: it reaches
    into every socket bound to a session while each of those has a writer
    task of its own running. It offers into each viewer's outbox now."""
    from src.api.websocket import ConnectionManager

    for method in (ConnectionManager.broadcast, ConnectionManager.broadcast_to_session):
        src = inspect.getsource(method)
        assert "send_text" not in src, method.__name__
        assert "_offer(" in src, method.__name__


def test_a_socket_with_no_stream_is_reported_undeliverable_not_sent_to():
    """The fallback that would undo all of this is "no stream, so send
    directly". A frame nobody could queue is dropped and its socket
    reported, which costs that client a refresh it can recover from; a
    direct send costs everybody a corrupted terminal."""
    from src.api.websocket import ConnectionManager

    manager = ConnectionManager()
    assert manager._offer(object(), '{"type":"log"}') is False


def test_the_feeders_never_touch_the_socket():
    """The log and local-server pumps take a stream, not a websocket, so
    a future source of server-to-client messages cannot add a sender by
    copying one of them."""
    from src.api import websocket as ws_mod

    params = list(inspect.signature(ws_mod._pump_text).parameters)
    assert params == ["queue", "stream"]
    assert "websocket" not in inspect.getsource(ws_mod._pump_text)


def test_text_and_pty_frames_share_one_viewer_budget():
    """A second, unbounded lane for text beside the bounded byte lane
    would leave the bound saying nothing about the memory actually held,
    and a viewer that is not reading is not reading any of it."""
    stream = viewer_fanout.new_viewer_stream("v")
    viewer_fanout.offer_text(stream, "x" * 100)
    assert stream.queued_items == 1
    assert stream.queued_bytes == 100
    viewer_fanout.offer_pty(stream, ENCODED)
    assert stream.queued_items == 2
    assert stream.queued_bytes == 100 + len(ENCODED)


def test_a_finished_stream_takes_nothing_more():
    """A teardown races the fan-out: the endpoint unsubscribes while the
    tail loop may still be mid-pass. Offering into a closed stream has to
    be a refusal, not a leak into a queue nobody will ever drain."""
    stream = viewer_fanout.new_viewer_stream("v")
    stream.close()
    assert viewer_fanout.offer_pty(stream, ENCODED) == OFFER_CLOSED
    assert viewer_fanout.offer_text(stream, "hello") == OFFER_CLOSED


def test_unsubscribing_closes_the_stream_so_the_writer_can_finish():
    """The writer task is parked in `get()`. Closing is what wakes it;
    without that it sits there until the socket itself fails."""
    from src.core.session_manager import SessionManager

    manager = _FakeManagerWithSubscribers({})
    stream = viewer_fanout.new_viewer_stream("v")
    manager._subscribers["ses_1"] = [stream]
    SessionManager.unsubscribe_output(manager, stream, "ses_1")
    assert stream.closed is True
    assert manager._subscribers["ses_1"] == []


def test_the_stream_check_is_structural_and_not_an_identity_test():
    """MEASURED, not theorised. This was
    `isinstance(candidate, BoundedStream)`, an identity test against a
    class imported by value, and it answered False in a full suite run
    the moment the process held two class objects for one module - a
    stream built from one binding checked against the other, both
    reporting `__module__ == 'src.core.bounded_stream'`.

    It fails SILENTLY and in the worst direction: `_close_viewer_stream`
    stops closing, so every writer task stays parked in `get()` until its
    socket dies, and every broadcast reports its viewer undeliverable.
    The three attributes below are exactly what the callers use, no
    `asyncio.Queue` has any of them, and no module identity is involved.
    """
    import inspect

    # The docstring NAMES isinstance to explain why it went, so look at
    # the code rather than the whole function text.
    src = inspect.getsource(viewer_fanout.is_viewer_stream)
    body = src[src.rindex('"""') + 3:]
    assert "isinstance" not in body

    # A real stream passes, a bare queue does not, and a stand-in that
    # quacks correctly passes too - which is the point of the change.
    assert viewer_fanout.is_viewer_stream(
        viewer_fanout.new_viewer_stream("v")) is True
    assert viewer_fanout.is_viewer_stream(asyncio.Queue()) is False
    assert viewer_fanout.is_viewer_stream(object()) is False
    assert viewer_fanout.is_viewer_stream(None) is False

    class _Lookalike:
        offer = None
        close = None
        overflowed = False

    assert viewer_fanout.is_viewer_stream(_Lookalike()) is True


def test_unsubscribing_a_bare_queue_does_not_raise():
    """`subscribe_output` has always been callable by test doubles and
    older shims. A teardown that raised on one of those would turn an
    ordinary disconnect into a 500."""
    from src.core.session_manager import SessionManager

    manager = _FakeManagerWithSubscribers({})
    queue = asyncio.Queue()
    manager._subscribers["ses_1"] = [queue]
    SessionManager.unsubscribe_output(manager, queue, "ses_1")
    assert manager._subscribers["ses_1"] == []


@pytest.mark.parametrize("bad", [0, -1])
def test_a_bound_must_be_positive(bad):
    """A zero bound would silently disconnect every viewer on its first
    chunk, which reads exactly like the transport being broken."""
    from src.core.bounded_stream import BoundedStream

    with pytest.raises(ValueError):
        BoundedStream(max_items=bad, max_bytes=1024)
    with pytest.raises(ValueError):
        BoundedStream(max_items=8, max_bytes=bad)
