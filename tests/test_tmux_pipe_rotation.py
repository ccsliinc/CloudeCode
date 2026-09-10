"""A pipe rotation must reclaim the file tmux is writing to, and never
interrupt the stream while doing it.

WHY THIS NEEDS REAL TMUX. The whole question is which INODE the writer
holds. ``pipe-pane`` runs ``cat >> <path>`` in a shell, and that
redirection opens the path exactly ONCE, at pipe-pane time, then holds
the descriptor for the life of the pipe. Nothing in Python can stand in
for that: a double would append to whatever path the test told it to,
which is precisely the belief under test. So the writer here is a real
``pipe-pane`` on a real throwaway socket, and the assertions are about
where its bytes actually land.

WHAT WAS MEASURED, 2026-09-10, and why it is not what the defect report
said. A real pane was piped to ``pipe.log``, the file was renamed to
``pipe.log.1`` and a fresh empty ``pipe.log`` created beside it, exactly
as the rotation does. The post-rename output went to ``pipe.log.1``,
which grew from 47 to 106 bytes, and the new ``pipe.log`` stayed at
ZERO. tmux never reopened the path, because ``>>`` in a shell is one
``open(2)`` with ``O_APPEND`` and not one per write.

Two consequences follow, and they pull in OPPOSITE directions:

* The READER IS FINE. It holds a descriptor on the same inode the writer
  is still appending to, so a rename underneath both of them is
  invisible to the stream. The terminal does not go silent.
* THE ROTATION RECLAIMS NOTHING. The file the writer is growing is now
  called ``.1``, and the file the rotation left at the managed path is a
  0-byte decoy nothing will ever write to. ``_maybe_rotate`` then stats
  that decoy, so ``st.st_size > MAX_LOG_BYTES`` is false forever and the
  size trigger is permanently disarmed. Worse, the NEXT rotation unlinks
  ``.1`` - the file the writer still holds open - so the bytes keep
  accumulating on an inode with no directory entry, invisible to ``ls``
  and unreclaimable until the pane dies.

THE NEGATIVE CONTROL IS THE LOAD-BEARING HALF. ``test_stream_survives``
passes on the broken tree, and it is here to fail against the OTHER
plausible fix: re-pointing the reader at the freshly created path. That
would move the reader onto the 0-byte decoy nothing writes to and make
the terminal go permanently silent, which is the failure this file
exists to make unshippable. A test suite that only asserted reclamation
would accept that fix.

SAFETY. ``tests.socket_guard``'s derived per-test socket. The production
``cloude`` socket is unreachable from this file.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import List

import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_rot_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_rot_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core import tmux_backend as tmux_backend_module
from src.core.tmux_backend import TmuxBackend
from tests.socket_guard import derive_test_socket

pytestmark = pytest.mark.skipif(
    shutil.which("tmux") is None, reason="real tmux binary not available"
)

#: Rotation threshold for these tests. Small enough that a handful of
#: echoed lines crosses it, large enough that the first marker is not
#: itself sitting on the boundary.
SMALL_LOG_BYTES = 512

#: How long to wait for bytes to travel pane -> pipe-pane -> file ->
#: tail loop -> on_output. Generous: a loaded box is slow and a flaky
#: latency test would be worse than no test.
STREAM_TIMEOUT = 10.0


def _tmux(socket: str, *args: str) -> subprocess.CompletedProcess:
    """Run one tmux command on the given test socket.

    Inputs: socket (str) - always from ``derive_test_socket``.
        *args (str) - the tmux argv after ``-L <socket>``.
    Output: subprocess.CompletedProcess with text stdout and stderr.
    Example: _tmux(sock, "kill-server")
    """
    return subprocess.run(
        ["tmux", "-L", socket, *args],
        capture_output=True,
        text=True,
        timeout=15,
    )


async def _await_text(chunks: List[bytes], needle: str, timeout: float) -> bool:
    """Wait until ``needle`` appears in the concatenated collected output.

    Inputs: chunks (List[bytes]) - the list ``on_output`` appends to.
        needle (str) - the marker to look for.
        timeout (float) - seconds to wait before giving up.
    Output: bool - True if the marker arrived inside the window.
    Example: await _await_text(seen, "MARKER_A", 10.0)
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if needle.encode() in b"".join(chunks):
            return True
        await asyncio.sleep(0.05)
    return False


async def _await_rotation(backend: TmuxBackend, before: float, timeout: float) -> bool:
    """Wait until the backend records that a rotation completed.

    ``_maybe_rotate`` stamps ``_rotation_started_at`` only on a rotation
    it carried out, so a moved stamp is the one implementation-neutral
    signal that a rotation actually happened. Asserting on a ``.1`` file
    would bake one particular mechanism into the test.

    Inputs: backend (TmuxBackend) - the backend running the tail loop.
        before (float) - the stamp read before any rotation was possible.
        timeout (float) - seconds to wait.
    Output: bool - True if the stamp moved inside the window.
    Example: await _await_rotation(backend, stamp, 15.0)
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if backend._rotation_started_at != before:
            return True
        await asyncio.sleep(0.05)
    return False


class _Harness:
    """A real pane, a real pipe-pane, and a real tail loop reading it.

    Inputs: none at construction; :meth:`start` does the work.
    Outputs: ``seen`` collects every chunk handed to ``on_output``.
    Example: h = _Harness(); await h.start(); h.send("echo hi")
    """

    def __init__(self) -> None:
        self.socket = derive_test_socket("rotate")
        self.tmpdir = Path(tempfile.mkdtemp(prefix="cc_rot_"))
        self.pipe_path = self.tmpdir / "pipe.log"
        self.seen: List[bytes] = []
        self.backend: TmuxBackend
        self.task: asyncio.Task

    async def start(self) -> None:
        """Create the pane, start pipe-pane, and run the tail loop."""
        made = _tmux(
            self.socket, "new-session", "-d", "-s", "probe",
            "-x", "80", "-y", "24", "sh",
        )
        assert made.returncode == 0, f"new-session failed: {made.stderr}"

        self.pipe_path.touch()
        piped = _tmux(
            self.socket, "pipe-pane", "-t", "probe",
            f"cat >> {self.pipe_path}",
        )
        assert piped.returncode == 0, f"pipe-pane failed: {piped.stderr}"

        self.backend = TmuxBackend(
            session_id="rotateprobe",
            working_dir=self.tmpdir,
            on_output=self.seen.append,
            socket_name=self.socket,
            session_name="probe",
        )
        self.backend._pipe_path = self.pipe_path
        self.backend._running = True
        self.task = asyncio.create_task(self.backend._tail_loop())
        # Let the loop reach its open and its seek before anything is sent,
        # or the first marker races the SEEK_END and is legitimately missed.
        await asyncio.sleep(0.6)

    def send(self, line: str) -> None:
        """Type one line into the pane so tmux pipes its echo out."""
        _tmux(self.socket, "send-keys", "-t", "probe", line, "Enter")

    async def stop(self) -> None:
        """Stop the tail loop and destroy the throwaway tmux server."""
        self.backend._running = False
        self.task.cancel()
        try:
            await self.task
        except asyncio.CancelledError:
            pass
        _tmux(self.socket, "kill-server")
        shutil.rmtree(self.tmpdir, ignore_errors=True)


@pytest_asyncio.fixture
async def harness():
    """Provide a started :class:`_Harness` and tear it down after."""
    h = _Harness()
    await h.start()
    try:
        yield h
    finally:
        await h.stop()


async def _drive_past_threshold(h: _Harness) -> float:
    """Emit enough output to cross the rotation threshold and rotate.

    Inputs: h (_Harness) - a started harness.
    Output: float - the ``_rotation_started_at`` stamp taken BEFORE the
        rotation, for comparison by the caller.
    Example: before = await _drive_past_threshold(h)
    """
    before = h.backend._rotation_started_at
    for i in range(12):
        h.send(f"echo FILLER_LINE_{i}_ppppppppppppppppppppppppppppppppppppppp")
        await asyncio.sleep(0.05)
    return before


@pytest.mark.asyncio
async def test_stream_survives_a_rotation(harness, monkeypatch):
    """Output keeps reaching on_output across a rotation.

    THE NEGATIVE CONTROL. This passes on the unfixed tree, because the
    reader and the writer are on the same inode and a rename is
    invisible to both. It is here so that a fix which re-points the
    reader at the freshly created path - which nothing writes to - fails
    loudly instead of shipping a permanently silent terminal.
    """
    monkeypatch.setattr(tmux_backend_module, "MAX_LOG_BYTES", SMALL_LOG_BYTES)
    h = harness

    h.send("echo MARKER_BEFORE_ROT")
    assert await _await_text(h.seen, "MARKER_BEFORE_ROT", STREAM_TIMEOUT), (
        "the tail loop never delivered output before any rotation, so the "
        "harness itself is broken and nothing below would mean anything"
    )

    before = await _drive_past_threshold(h)
    assert await _await_rotation(h.backend, before, STREAM_TIMEOUT), (
        "no rotation happened, so this test measured nothing"
    )

    h.send("echo MARKER_AFTER_ROT")
    assert await _await_text(h.seen, "MARKER_AFTER_ROT", STREAM_TIMEOUT), (
        "the terminal went SILENT after a rotation: the reader is no longer "
        "on the inode tmux is appending to"
    )


@pytest.mark.asyncio
async def test_rotation_reclaims_the_file_tmux_writes_to(harness, monkeypatch):
    """After a rotation, new output still lands at the managed path.

    This is the defect. ``pipe-pane`` opens the path once and holds it,
    so renaming the file moves the writer's inode out of the way instead
    of freeing it: the rotation leaves a 0-byte decoy at the managed
    path, stats THAT on every later check, and so disarms its own size
    trigger for good while the real file grows without bound under
    another name.
    """
    monkeypatch.setattr(tmux_backend_module, "MAX_LOG_BYTES", SMALL_LOG_BYTES)
    h = harness

    before = await _drive_past_threshold(h)
    assert await _await_rotation(h.backend, before, STREAM_TIMEOUT), (
        "no rotation happened, so this test measured nothing"
    )

    h.send("echo MARKER_POST_ROTATION_ON_DISK")
    assert await _await_text(h.seen, "MARKER_POST_ROTATION_ON_DISK", STREAM_TIMEOUT)
    # The stream arriving proves the writer is alive; give the same bytes
    # a moment to be visible through a fresh open of the managed path.
    await asyncio.sleep(0.3)

    on_disk = h.pipe_path.read_bytes()
    assert b"MARKER_POST_ROTATION_ON_DISK" in on_disk, (
        "post-rotation output did not land at the managed pipe path. tmux is "
        "still writing to the inode the rotation renamed away, so the "
        "rotation reclaimed nothing and its size trigger now stats a decoy"
    )


@pytest.mark.asyncio
async def test_rotation_keeps_the_managed_file_bounded(harness, monkeypatch):
    """Repeated rotations keep the managed file near the threshold.

    A rotation that renames the live file leaves the managed path at
    zero forever, which looks bounded while the real file grows without
    limit. Asserting the managed path CONTAINS the recent output (above)
    and stays small (here) can only both hold if the file being trimmed
    is the file being written.
    """
    monkeypatch.setattr(tmux_backend_module, "MAX_LOG_BYTES", SMALL_LOG_BYTES)
    h = harness

    for _ in range(3):
        before = await _drive_past_threshold(h)
        assert await _await_rotation(h.backend, before, STREAM_TIMEOUT), (
            "no rotation happened, so this test measured nothing"
        )

    h.send("echo MARKER_BOUNDED_TAIL")
    assert await _await_text(h.seen, "MARKER_BOUNDED_TAIL", STREAM_TIMEOUT)
    await asyncio.sleep(0.3)

    sizes = {p.name: p.stat().st_size for p in h.tmpdir.iterdir()}
    total = sum(sizes.values())
    assert total < SMALL_LOG_BYTES * 8, (
        f"the pipe files kept growing across rotations: {sizes}. A renamed "
        f"live file is still held open by tmux and still accumulating"
    )
