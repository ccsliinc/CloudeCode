"""One bounded outbox per terminal viewer, drained by exactly one writer.

WHAT WAS WRONG. `SessionManager._make_output_handler` did
`await queue.put(encoded)` into an `asyncio.Queue()` with no `maxsize`, once
per subscriber. A queue with no maxsize never blocks on put, so a browser
that stopped reading applied no backpressure - it simply GREW, and this
process held every byte that browser had not read for as long as it did not
read them. On a throttled tab or a phone that went to sleep mid-build that
is unbounded memory, and the failure lands on the whole server rather than
on the one client that caused it.

YOU CANNOT FIX A SLOW VIEWER BY DROPPING BYTES. Escape sequences span chunk
boundaries, so a terminal handed half a sequence renders garbage and STAYS
wrong until something resets it - it is not one bad cell, it is a VT parser
left in the wrong state. So the only safe response to a full queue is to
stop that viewer and have it recapture the pane from scratch, which is a
complete recovery and one the client already knows how to perform.

ONE WRITER PER VIEWER, AND IT IS A CORRECTNESS CLAIM. Two coroutines
awaiting `send` on one websocket interleave frames, and the result is a
corrupted stream rather than an exception - nothing in the system reports
it. The terminal socket used to have FOUR concurrent senders: the pty
stream, the log stream, the local-server stream and the receive loop's own
pong and error replies, plus `ConnectionManager.broadcast_to_session`
reaching in from a toast, a rename or a resize. They all feed this one
outbox now, and the writer task is the only thing that touches the socket.

A VIEWER'S SLOWNESS IS BOUNDED BY ITS OWN QUEUE AND IS INVISIBLE TO EVERY
OTHER VIEWER AND TO THE SOURCE. That is the invariant, stated because
nothing stated it before. `offer` never awaits, so the tmux tail loop hands
a chunk to every viewer and carries straight on to the next read.
"""

from __future__ import annotations

from typing import Any, NamedTuple

from src.core.bounded_stream import (
    OVERFLOW_CLOSE_CODE,
    BoundedStream,
)

# The bound, from the plan's Interfaces section: 4 MiB or 256 chunks per
# viewer. MEASURED, so the reader knows which one actually fires: the tail
# loop reads at most 8192 bytes per `os.read` (`tmux_backend._tail_loop`),
# which base64 inflates to about 10,924 characters, so 256 chunks is about
# 2.8 MiB and the CHUNK COUNT is the binding constraint today. The byte
# budget is the backstop that keeps the promise true if that read size ever
# grows, and it is the same 4 MiB the client-side write queue uses - one
# number in the system beats two separately tuned ones.
MAX_VIEWER_QUEUE_CHUNKS = 256
MAX_VIEWER_QUEUE_BYTES = 4 * 1024 * 1024

# Re-exported so a reader of this file does not have to know the event
# channel exists to find the number. One declaration, in bounded_stream.
VIEWER_OVERFLOW_CLOSE_CODE = OVERFLOW_CLOSE_CODE

# What kind of thing a frame is. The writer needs to know because a pty
# chunk goes out as a BINARY frame and everything else as text, and
# because only the pty path runs pattern detection on its way past.
FRAME_PTY = "pty"
FRAME_TEXT = "text"


class ViewerFrame(NamedTuple):
    """One thing to send to one viewer.

    Attributes:
      kind: FRAME_PTY or FRAME_TEXT.
      payload: for FRAME_PTY, the base64 string the fan-out produced; for
        FRAME_TEXT, the JSON string to send verbatim.
    """

    kind: str
    payload: str


def new_viewer_stream(label: str) -> BoundedStream:
    """Build one viewer's outbox at the standard bound.

    Description: the ONE place a viewer queue is constructed, so every
      viewer in the app carries the same bound and a later tuning pass
      changes one number rather than hunting for constructors.
    Inputs: label (str) - what this viewer is, for log lines only.
    Output: BoundedStream.
    Example: stream = new_viewer_stream("ses_1234")
    """
    return BoundedStream(
        max_items=MAX_VIEWER_QUEUE_CHUNKS,
        max_bytes=MAX_VIEWER_QUEUE_BYTES,
        label=f"viewer {label}",
    )


def offer_pty(stream: BoundedStream, encoded: str) -> str:
    """Offer one chunk of pane output. Never awaits.

    Inputs: stream (BoundedStream) - a viewer's outbox; encoded (str) -
      the base64 of the raw chunk.
    Output: str - the offer outcome, from `bounded_stream`.
    Example: offer_pty(stream, base64.b64encode(chunk).decode())
    """
    return stream.offer(ViewerFrame(FRAME_PTY, encoded), len(encoded))


def offer_text(stream: BoundedStream, text: str) -> str:
    """Offer one text frame (a log line, a toast, a control message).

    Description: these share the viewer's ONE budget rather than getting a
      lane of their own, on purpose. A viewer that is not reading is not
      reading any of it, and a second unbounded lane beside a bounded one
      would leave the bound saying nothing about the memory actually held.
    Inputs: stream (BoundedStream); text (str) - the JSON to send.
    Output: str - the offer outcome.
    Example: offer_text(stream, json.dumps({"type": "pong"}))
    """
    return stream.offer(ViewerFrame(FRAME_TEXT, text), len(text))


def is_viewer_stream(candidate: Any) -> bool:
    """True when this object is a viewer outbox rather than a bare queue.

    Description: `ConnectionManager` is handed a stream for every socket
      it registers, and a test double or an older caller may hand it
      something else. Asking rather than assuming is what lets the
      broadcast paths fall back honestly instead of raising inside a
      fan-out that must not fail.

      STRUCTURAL, NOT `isinstance`, AND THAT IS NOT FUSSINESS. It was
      `isinstance(candidate, BoundedStream)` and that is an identity
      test on a class object imported BY VALUE, so it answers False the
      moment this process holds two class objects for one module - which
      is not hypothetical: the test suite reproduces it, a `BoundedStream`
      built from one binding measured against another under the same
      `__module__` name. When it fails it fails SILENTLY and in the worst
      direction: `_close_viewer_stream` stops closing, so every writer
      task stays parked in `get()` until its socket dies, and a broadcast
      reports every viewer undeliverable. The three attributes below are
      exactly what the callers use, an `asyncio.Queue` has none of them,
      and no module identity is involved.
    Inputs: candidate (Any).
    Output: bool.
    Example: if is_viewer_stream(stream): offer_text(stream, frame)
    """
    return (
        hasattr(candidate, "offer")
        and hasattr(candidate, "close")
        and hasattr(candidate, "overflowed")
    )


def close_viewer_stream(candidate: Any) -> None:
    """Close a viewer outbox, tolerating anything that is not one.

    Description: the subscriber list has always been able to hold a bare
      queue handed in by a test double or an older shim, and a teardown
      that raised on one of those would turn an ordinary disconnect into
      a 500. So this ASKS whether the object is a viewer stream rather
      than assuming, and does nothing when it is not. It lives here
      beside :func:`is_viewer_stream` because the two answer one
      question.
    Inputs: candidate (Any) - whatever the caller was handed.
    Output: None.
    Example: close_viewer_stream(stream)
    """
    if is_viewer_stream(candidate):
        candidate.close()
