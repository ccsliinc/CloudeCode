"""The attach handshake's settle gate, and the refusals that keep it honest.

WHAT IS BEING PROVED. ``src/api/websocket.py`` used to pause 150 ms on
every attach so a ``SIGWINCH`` raised by the handshake resize could reach
the pane. It now pauses only when a resize actually needed to happen. The
interesting half is not the fast path, it is the THREE refusals: an
unreadable pane, a pane at a different size, and a resize that failed all
still settle, exactly as before.

WHY A REAL BACKEND AND NOT A DOUBLE. The issue this closes says it in one
line: "Prove this against a real backend whose probe raises, not against a
mock returning None, because a mock will agree with whatever the code
does." So the probe is measured against real tmux on a real throwaway
socket - a live pane answers its real geometry, and the SAME backend
object, after its session is killed, answers None. A double asked to
return None proves only that someone wrote ``return None``.

THE TIMING ASSERTIONS ARE STRUCTURAL, NOT WALL-CLOCK. This box has been
measured at load average 14 to 33 with a dozen concurrent pytest
processes, where a coroutine that sleeps zero can still take 150 ms to be
scheduled. So the fast path is proved by RECORDING the sleeps
``settle_if_needed`` takes rather than by timing them. A wall clock here
would either flake or be too loose to prove anything.

SAFETY. Every tmux call goes to ``tests.socket_guard``'s
``TEST_SOCKET_NAME``, unique per pytest process. The production
``cloude`` socket is unreachable from this file.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_ass_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_ass_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.api import attach_settle
from src.api.attach_settle import (
    NO_RESIZE_ATTEMPTED,
    REASON_CHANGED,
    REASON_CONFIRMED_UNCHANGED,
    REASON_NO_CLIENT_GEOMETRY,
    REASON_RESIZE_FAILED,
    REASON_UNMEASURED,
    ResizeOutcome,
    SETTLE_SECONDS,
    SettleVerdict,
    decide_settle,
    read_pane_geometry,
    settle_if_needed,
)
from src.api.resize_negotiation import apply_negotiated_resize
from src.core.tmux_backend import TmuxBackend
from tests.socket_guard import TEST_SOCKET_NAME

requires_tmux = pytest.mark.skipif(
    shutil.which("tmux") is None, reason="tmux not on PATH"
)


# --------------------------------------------------------------------- #
# the pure ladder - every rung, including the ones that refuse
# --------------------------------------------------------------------- #


def test_a_measured_matching_geometry_is_the_only_thing_that_skips():
    """The one fast path: the pane said it is already at the target."""
    verdict = decide_settle((100, 40), ResizeOutcome((100, 40), False, False))
    assert verdict == SettleVerdict(False, REASON_CONFIRMED_UNCHANGED)


def test_a_measured_different_geometry_still_settles():
    """A real resize went out, so there is a real SIGWINCH to wait for."""
    verdict = decide_settle((80, 24), ResizeOutcome((100, 40), True, False))
    assert verdict.settle is True
    assert verdict.reason == REASON_CHANGED


def test_an_unmeasured_geometry_settles_and_is_not_read_as_unchanged():
    """The refusal that matters. None is not evidence nothing moved.

    A ladder that treated an unreadable probe as "unchanged" would skip
    the settle on every transient tmux hiccup, leaving the pane's grid
    disagreeing with the browser until the user typed.
    """
    verdict = decide_settle(None, ResizeOutcome((100, 40), True, False))
    assert verdict.settle is True
    assert verdict.reason == REASON_UNMEASURED


def test_a_failed_resize_settles_even_when_the_reading_matched():
    """A resize that raised leaves the geometry unknown, matched or not."""
    verdict = decide_settle((100, 40), ResizeOutcome((100, 40), True, True))
    assert verdict.settle is True
    assert verdict.reason == REASON_RESIZE_FAILED


def test_no_client_geometry_settles_which_is_the_fallback_branch():
    """The degraded branch can never take the fast path, by construction."""
    verdict = decide_settle(None, NO_RESIZE_ATTEMPTED)
    assert verdict.settle is True
    assert verdict.reason == REASON_NO_CLIENT_GEOMETRY


def test_an_issued_resize_settles_even_if_the_pre_read_matched_the_target():
    """Belt and braces: anything actually issued wins over the reading.

    ``issued`` and "the reading matched" are made to agree by the caller.
    If a future change breaks that agreement this gate closes rather than
    skipping a settle a real SIGWINCH needed.
    """
    verdict = decide_settle((100, 40), ResizeOutcome((100, 40), True, False))
    assert verdict.settle is True
    assert verdict.reason == REASON_CHANGED


# --------------------------------------------------------------------- #
# the pause itself, recorded rather than timed
# --------------------------------------------------------------------- #


def test_the_skip_verdict_takes_no_pause_at_all(monkeypatch):
    """Structural proof of the fast path: zero sleeps, not a short one."""
    slept = []

    async def record(seconds):
        slept.append(seconds)

    monkeypatch.setattr(attach_settle.asyncio, "sleep", record)
    asyncio.run(settle_if_needed(SettleVerdict(False, REASON_CONFIRMED_UNCHANGED)))
    assert slept == []


def test_the_settle_verdict_pauses_for_the_unchanged_duration(monkeypatch):
    """This change decides WHETHER the pause is paid, never how long."""
    slept = []

    async def record(seconds):
        slept.append(seconds)

    monkeypatch.setattr(attach_settle.asyncio, "sleep", record)
    asyncio.run(settle_if_needed(SettleVerdict(True, REASON_CHANGED)))
    assert slept == [SETTLE_SECONDS]
    assert SETTLE_SECONDS == 0.15


# --------------------------------------------------------------------- #
# read_pane_geometry, against backends that cannot answer
# --------------------------------------------------------------------- #


def test_a_backend_without_the_probe_reads_as_unmeasured():
    """The legacy PTY path keeps exactly the behaviour it always had."""
    class NoProbe:
        pass

    assert asyncio.run(read_pane_geometry(NoProbe())) is None
    assert asyncio.run(read_pane_geometry(None)) is None


def test_a_probe_that_raises_reads_as_unmeasured_not_as_zero():
    """A raising probe must refuse, never invent a geometry."""
    class Raises:
        async def pane_geometry(self):
            raise RuntimeError("tmux went away")

    assert asyncio.run(read_pane_geometry(Raises())) is None


def test_a_probe_answering_nonsense_reads_as_unmeasured():
    """An unparseable answer is not a reading."""
    class Nonsense:
        async def pane_geometry(self):
            return "not a pair"

    assert asyncio.run(read_pane_geometry(Nonsense())) is None


# --------------------------------------------------------------------- #
# REAL tmux: the probe, and the same backend after its pane is gone
# --------------------------------------------------------------------- #


def _tmux(*args: str) -> subprocess.CompletedProcess:
    """Run one tmux command against THIS run's throwaway socket."""
    return subprocess.run(
        ["tmux", "-L", TEST_SOCKET_NAME, *args],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture()
def live_pane(tmp_path):
    """A real detached tmux session at a known geometry, on a test socket.

    Yields (backend, name). The session is killed on teardown whether the
    test passed or not.
    """
    name = f"cloude_as_{uuid.uuid4().hex[:8]}"
    result = _tmux(
        "new-session", "-d",
        "-s", name,
        "-c", str(tmp_path),
        "-x", "111", "-y", "37",
    )
    assert result.returncode == 0, f"tmux new-session failed: {result.stderr}"
    # window-size manual is what makes the geometry ours rather than
    # tmux's idea of the newest attached client. Production sets it too.
    _tmux("set-option", "-t", name, "window-size", "manual")
    backend = TmuxBackend(
        session_id=name,
        working_dir=tmp_path,
        socket_name=TEST_SOCKET_NAME,
        session_name=name,
    )
    try:
        yield backend, name
    finally:
        _tmux("kill-session", "-t", name)


@requires_tmux
def test_a_real_pane_reports_its_real_geometry(live_pane):
    """The positive control. Without it a probe that always refused passes."""
    backend, _ = live_pane
    assert asyncio.run(backend.pane_geometry()) == (111, 37)


@requires_tmux
def test_a_real_pane_that_moved_is_reported_moved(live_pane):
    """The probe reads the PANE, so an external resize is visible to it.

    This is the case a negotiated cache cannot see: nothing in this app
    asked for the new size, and the pane is at it anyway.
    """
    backend, name = live_pane
    _tmux("resize-window", "-t", name, "-x", "90", "-y", "30")
    measured = asyncio.run(backend.pane_geometry())
    assert measured == (90, 30)
    verdict = decide_settle(measured, ResizeOutcome((111, 37), True, False))
    assert verdict.settle is True


@requires_tmux
def test_a_real_backend_whose_pane_is_gone_refuses_and_still_settles(live_pane):
    """THE TEST THE ISSUE ASKED FOR, and it uses no double.

    The same real ``TmuxBackend`` that answered (111, 37) a moment ago is
    asked again after its tmux session has been killed. It must answer
    None, and the ladder must settle on that None.
    """
    backend, name = live_pane
    assert asyncio.run(backend.pane_geometry()) == (111, 37)

    killed = _tmux("kill-session", "-t", name)
    assert killed.returncode == 0, killed.stderr

    measured = asyncio.run(read_pane_geometry(backend))
    assert measured is None, "a dead pane must refuse, not report a size"

    verdict = decide_settle(measured, ResizeOutcome((111, 37), True, False))
    assert verdict == SettleVerdict(True, REASON_UNMEASURED)


# --------------------------------------------------------------------- #
# the negotiation seam: a measured match must not issue a resize
# --------------------------------------------------------------------- #


class _RecordingManager:
    """Records every resize_terminal call. No tmux, no backend."""

    def __init__(self):
        self.resizes = []

    def resize_terminal(self, cols, rows, session_id=None):
        self.resizes.append((cols, rows, session_id))


class _NoBroadcast:
    async def broadcast_to_session(self, session_id, message):
        return None


def test_a_measured_match_issues_no_resize_and_reports_the_target():
    """The fast path also saves the resize pair, not only the pause.

    ``resize-window`` plus ``refresh-client`` are two BLOCKING subprocess
    calls on the event loop, measured p50 22.81 ms together. Sending them
    to move a pane to where it already is buys nothing.
    """
    manager = _RecordingManager()
    outcome = asyncio.run(apply_negotiated_resize(
        manager, "ses_x", object(), 100, 40, _NoBroadcast(),
        known_pane_size=(100, 40),
    ))
    assert manager.resizes == []
    assert outcome == ResizeOutcome(target=(100, 40), issued=False, failed=False)
    assert decide_settle((100, 40), outcome).settle is False


def test_an_unmeasured_pane_still_issues_the_resize_exactly_as_before():
    """None must never be read as "already there"."""
    manager = _RecordingManager()
    outcome = asyncio.run(apply_negotiated_resize(
        manager, "ses_x", object(), 100, 40, _NoBroadcast(),
        known_pane_size=None,
    ))
    assert manager.resizes == [(100, 40, "ses_x")]
    assert outcome.issued is True
    assert decide_settle(None, outcome).settle is True


def test_a_second_smaller_client_makes_the_target_the_negotiated_minimum():
    """The target is the SESSION's effective size, not this client's ask.

    With two browsers the pane is letterboxed to the element-wise
    minimum. Reporting this client's own request would compare the pane
    against a size it is deliberately not at, and settle forever.
    """
    manager = _RecordingManager()
    big, small = object(), object()
    asyncio.run(apply_negotiated_resize(
        manager, "ses_x", big, 200, 60, _NoBroadcast()))
    outcome = asyncio.run(apply_negotiated_resize(
        manager, "ses_x", small, 100, 40, _NoBroadcast()))
    assert outcome.target == (100, 40)

    # The big client re-attaching does not move the pane, and the pane is
    # measured at the minimum, so the settle is skipped.
    outcome = asyncio.run(apply_negotiated_resize(
        manager, "ses_x", big, 200, 60, _NoBroadcast(),
        known_pane_size=(100, 40),
    ))
    assert outcome == ResizeOutcome(target=(100, 40), issued=False, failed=False)
    assert decide_settle((100, 40), outcome).settle is False


def test_a_resize_that_raises_is_reported_failed_and_settles():
    """A backend that throws must not be able to produce a skip."""
    class Exploding:
        def resize_terminal(self, cols, rows, session_id=None):
            raise RuntimeError("tmux refused")

    outcome = asyncio.run(apply_negotiated_resize(
        Exploding(), "ses_x", object(), 100, 40, _NoBroadcast(),
        known_pane_size=(80, 24),
    ))
    assert outcome.failed is True
    assert decide_settle((80, 24), outcome) == SettleVerdict(
        True, REASON_RESIZE_FAILED
    )
