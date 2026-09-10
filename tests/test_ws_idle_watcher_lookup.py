"""The websocket output path finds the session's idle watcher.

Slice S1 of ``.claude/notes/backend-decomposition-plan.md``.

**THIS FILE EXISTS BECAUSE A MUTATION CAME BACK GREEN.** Replacing the
watcher lookup in ``send_pty_output`` with a literal ``None`` broke
nothing in a 5,900-test suite. That lookup used to be
``getattr(sm, "idle_watchers", {}).get(session_id)``, and the whole
hazard of a tolerant accessor is that losing it costs you a feature
silently - no watcher, on every session, forever, raising nowhere. So
the one path that would have failed quietly had no test, which is the
worst possible combination and exactly the pairing CLAUDE.md calls the
characteristic failure of this refactor.

``send_pty_output`` is driven directly rather than through a real
socket: it is a plain coroutine over a queue, so a fake websocket and a
one-item queue exercise the real branch with no transport involved.
"""

from __future__ import annotations

import asyncio
import base64
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_wsw_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_wsw_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.api.websocket import send_pty_output  # noqa: E402
from src.core.sessions.sidecars import AttachmentSidecars  # noqa: E402


class _RecordingWatcher:
    """An idle watcher that only remembers what it was fed."""

    def __init__(self) -> None:
        """Inputs: none. Output: None."""
        self.chunks: list[bytes] = []

    async def handle_chunk(self, raw: bytes) -> None:
        """Record one chunk of terminal output."""
        self.chunks.append(raw)


class _FakeSocket:
    """The two attributes ``send_pty_output`` touches on a websocket."""

    def __init__(self, app) -> None:
        """Inputs: app - the object carrying ``.state``."""
        self.app = app
        self.sent: list[bytes] = []

    async def send_bytes(self, raw: bytes) -> None:
        """Record one outgoing binary frame."""
        self.sent.append(raw)


async def _pump(sidecars: AttachmentSidecars, session_id: str, payload: bytes):
    """Run one chunk through the real ``send_pty_output`` branch.

    Description: builds the ``app.state`` shape the function reads - a
      manager exposing ``get_backend``, and ``services.sidecars`` - then
      drives exactly one queue item and cancels.
    Inputs: sidecars (AttachmentSidecars), session_id (str),
      payload (bytes) - the raw terminal output to deliver.
    Output: the fake socket, so a caller can assert on what was sent.
    Example: await _pump(AttachmentSidecars(), 'ses_1', b'hi')
    """
    manager = SimpleNamespace(get_backend=lambda sid: None)
    state = SimpleNamespace(
        session_manager=manager,
        services=SimpleNamespace(sidecars=sidecars),
    )
    socket = _FakeSocket(SimpleNamespace(state=state))

    queue: asyncio.Queue = asyncio.Queue()
    await queue.put(base64.b64encode(payload).decode())

    task = asyncio.create_task(
        send_pty_output(socket, queue, log_monitor=None, session_id=session_id)
    )
    # One item, then stand down. The coroutine loops forever on an empty
    # queue, so it is cancelled rather than awaited to completion.
    for _ in range(50):
        await asyncio.sleep(0)
        if socket.sent:
            break
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    return socket


@pytest.mark.asyncio
async def test_the_session_s_own_watcher_receives_the_output():
    """THE MUTATION TARGET. Replace the lookup with None and this goes red."""
    sidecars = AttachmentSidecars()
    watcher = _RecordingWatcher()
    sidecars.set_watcher("ses_1", watcher)

    socket = await _pump(sidecars, "ses_1", b"hello pane")

    assert watcher.chunks == [b"hello pane"], (
        "the idle watcher was never fed, so notifications are dead on "
        "this session and nothing raised to say so"
    )
    assert socket.sent == [b"hello pane"]


@pytest.mark.asyncio
async def test_another_session_s_watcher_is_not_fed():
    """NEGATIVE CONTROL. The lookup is scoped to THIS session.

    Description: a lookup that returned "any watcher" would pass the test
      above perfectly. Output routed to the wrong session's watcher would
      fire that session's notifications on someone else's activity, which
      is worse than firing none.
    """
    sidecars = AttachmentSidecars()
    other = _RecordingWatcher()
    sidecars.set_watcher("ses_other", other)

    socket = await _pump(sidecars, "ses_1", b"hello pane")

    assert other.chunks == []
    assert socket.sent == [b"hello pane"]


@pytest.mark.asyncio
async def test_a_session_with_no_watcher_still_streams():
    """Terminal streaming is load-bearing; notifications are not.

    Description: the absence of a watcher must not cost the user their
      terminal. This is the half the old tolerant ``getattr`` got right,
      and it stays right.
    """
    socket = await _pump(AttachmentSidecars(), "ses_1", b"still streaming")

    assert socket.sent == [b"still streaming"]
