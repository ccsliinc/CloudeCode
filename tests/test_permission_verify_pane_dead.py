"""A permission flag stuck at the moment its pane died must be retirable.

THE FAILURE MODE. ``should_capture_permission_tail`` refused to capture a
tail whenever ``pane_alive is not True`` - which is correct for the COST
GATE (there is nothing to capture-pane on a dead pane, and a genuinely
unreadable pane is not evidence either way) but wrong for the FLAG: a
permission claim left open at the instant its pane died could never be
retired by any reachable event, because no capture could ever run against
it again. The session showed "needs your input" forever. This is GOTCHA
10's stuck-bit shape, for a pane that is simply gone rather than one
split across two ids.

THE FIX, under test here, lives in
``session_permission_verify_apply.verify_open_permission``: a pane
MEASURED dead (``pane_alive is False``, a real reading, never confused
with ``None`` which means no reading happened at all) clears an open
claim directly, with no tail capture, because a dead pane cannot show a
dialog.

THE NEGATIVE CONTROL IS THE WHOLE POINT (test 2 below). This project's
hardest rule is that a reading that did not happen is not a reading of
nothing: ``pane_alive=None`` (liveness could not be measured) must KEEP
the flag exactly as before. Collapsing ``False`` and ``None`` onto one
branch - the exact anti-pattern the fix exists to avoid - would dismiss a
real permission request nobody ever answered.

VERIFIED BY MUTATION: temporarily widening the new branch's guard from
``pane_alive is False`` to ``pane_alive is not True`` (i.e. treating
"unknown" the same as "measured dead") was run against this file and
made test 2 fail (the flag was cleared under an unmeasured pane) while
test 1 still passed. That mutation is exactly the bug this suite exists
to catch, and it went red - see the session report for confirmation this
was actually executed, not assumed.
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_pvd_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_pvd_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from src.core import session_permission_verify_apply as verify_apply
from src.core.session_activity import EVENT_PERMISSION_REQUEST, SessionActivityTracker
from src.core.session_permission_verify import (
    PERMISSION_CLEARED_PANE_DEAD,
    PERMISSION_NOT_CHECKED,
)


class _FakeManager:
    """Description: just enough of ``SessionManager`` for
    ``verify_open_permission`` - an activity tracker to read/clear, and
    weak-referenceable (a plain instance is) so ``ledger_for`` can key on
    it.
    Inputs: tracker (SessionActivityTracker). Output: object.
    """

    def __init__(self, tracker: SessionActivityTracker):
        self._activity_tracker = tracker


class _FakeBackend:
    """Description: a stand-in backend. Never read on the
    ``pane_alive is False`` path (no capture is attempted), so it carries
    no ``socket_name`` at all - if the code under test ever touched it,
    this would raise ``AttributeError`` and be caught as a test failure
    via the real exception rather than silently returning a stub value.
    """


# --------------------------------------------------------------------- #
# 1. A pane MEASURED dead clears an open claim.                          #
# --------------------------------------------------------------------- #


def test_measured_dead_pane_clears_the_open_permission_flag():
    tracker = SessionActivityTracker()
    t0 = datetime(2026, 9, 10, 12, 0, 0)
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=t0)
    assert tracker.permission_open_since("ses_1") == t0, "sanity: claim is open"

    manager = _FakeManager(tracker)
    verdict = verify_apply.verify_open_permission(
        manager,
        session_id="ses_1",
        backend=_FakeBackend(),
        tmux_name="cloude_ses_1",
        pane_alive=False,
        now=t0 + timedelta(seconds=5),
    )

    assert verdict == PERMISSION_CLEARED_PANE_DEAD
    assert tracker.permission_open_since("ses_1") is None, (
        "the flag must actually be cleared, not merely reported cleared"
    )


def test_measured_dead_pane_with_no_open_claim_is_a_no_op():
    """Nothing to clear is not an error and not a fabricated verdict."""
    tracker = SessionActivityTracker()
    manager = _FakeManager(tracker)

    verdict = verify_apply.verify_open_permission(
        manager,
        session_id="ses_2",
        backend=_FakeBackend(),
        tmux_name="cloude_ses_2",
        pane_alive=False,
    )

    assert verdict == PERMISSION_NOT_CHECKED


# --------------------------------------------------------------------- #
# 2. NEGATIVE CONTROL (load-bearing) - unknown liveness KEEPS the flag.   #
# --------------------------------------------------------------------- #


def test_unmeasured_pane_liveness_keeps_the_open_permission_flag():
    """``pane_alive=None`` must never be treated as "measured dead". Not
    having measured liveness is not evidence the dialog is gone - clearing
    here would silently dismiss a real permission request."""
    tracker = SessionActivityTracker()
    t0 = datetime(2026, 9, 10, 12, 0, 0)
    tracker.record_event("ses_3", EVENT_PERMISSION_REQUEST, now=t0)

    manager = _FakeManager(tracker)
    verdict = verify_apply.verify_open_permission(
        manager,
        session_id="ses_3",
        backend=_FakeBackend(),
        tmux_name="cloude_ses_3",
        pane_alive=None,
        now=t0 + timedelta(seconds=5),
    )

    assert verdict == PERMISSION_NOT_CHECKED
    assert tracker.permission_open_since("ses_3") == t0, (
        "an unmeasured pane must never clear an open permission claim - "
        "only a POSITIVE measurement of death may"
    )


# --------------------------------------------------------------------- #
# 3. THE CALLER'S CHOICE. Which liveness reading reaches the seam at all. #
# --------------------------------------------------------------------- #
#
# The two tests above prove the SEAM honours the False/None distinction.
# They cannot prove the caller ever makes it, and for a while it did not:
# ``_session_info_for``'s ``LIVENESS_GONE`` branch passed a flat
# ``pane_alive=False``, and ``resolve_listing_liveness`` answers ``gone``
# by TWO roads that are not the same evidence.
#
#   * a COMPLETE listing from THIS BACKEND'S OWN SOCKET named the session
#     and reported ``#{pane_dead}`` dead. That is a measurement.
#   * ``exists`` was falsy - and for tmux that came from ``has-session``,
#     which returns the same False for "no such session" as for "tmux is
#     missing, timed out, or errored". That is not a measurement of
#     anything.
#
# Down the second road a session sitting on a GENUINE permission dialog
# lost its flag to one failed probe, and nothing short of a brand new
# ``PermissionRequest`` reopens it. The row being dropped beside it
# self-heals on the very next poll; this clear did not.
#
# These tests drive the real ``_session_info_for`` and read the tracker
# afterwards, so they assert the OUTCOME rather than which argument was
# spelled - a spy on the seam would keep passing if the seam's own
# contract changed underneath it.

from src.core.session_manager import SessionManager  # noqa: E402
from src.core.session_status import STATUS_DEAD, STATUS_IDLE  # noqa: E402
from src.core.session_status_map import StatusMap  # noqa: E402
from src.models import Session, SessionStatus  # noqa: E402

#: The socket both the backend and the listing claim in these tests. A
#: literal shared by both sides on purpose: the point of the fix is that
#: they must MATCH, so two spellings would make every case refuse and the
#: suite would pass for the wrong reason.
TEST_SOCKET = "cloude_pvd_test"


class _StubSettings:
    """Description: the few settings paths ``SessionManager`` reads at
    construction and during a listing pass, pointed at a tmp dir so no
    test can reach the owner's real state.
    Inputs: pin_path (Path), log_dir (Path). Output: object.
    """

    def __init__(self, pin_path: Path, log_dir: Path):
        self._pin_path = pin_path
        self._log_dir = log_dir
        self.port = 5001

    def get_pinned_themes_path(self) -> Path:
        return self._pin_path

    def get_unread_state_path(self) -> Path:
        return self._pin_path.parent / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._log_dir)

    def get_session_metadata_path(self) -> Path:
        return self._log_dir / "session_metadata.json"


class _SocketBackend:
    """Description: a tmux-shaped backend that states its socket, which is
    what lets a listing vouch for it. ``is_alive`` is ``has-session``:
    EXISTENCE only, and its False carries no reason.
    Inputs: tmux_session (str), exists (bool). Output: object.
    """

    def __init__(self, tmux_session: str, exists: bool = True):
        self.tmux_session = tmux_session
        self.socket_name = TEST_SOCKET
        self._exists = exists
        self.pid = 4321

    def is_alive(self) -> bool:
        return self._exists


@pytest.fixture()
def mgr(monkeypatch, tmp_path):
    """A SessionManager with no durable writes and no real settings."""
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr(
        "src.core.session_manager.settings",
        _StubSettings(tmp_path / "pinned_themes.json", tmp_path / "logs"),
    )
    manager = SessionManager()
    monkeypatch.setattr(
        manager, "_persist_settled_activity_state", lambda *a, **k: None
    )
    monkeypatch.setattr(manager, "_restored_activity_state", lambda *a, **k: None)
    return manager


def _register_with_open_permission(
    manager: SessionManager,
    sid: str,
    tmux_name: str,
    wd: Path,
    *,
    exists: bool = True,
) -> datetime:
    """Register one live session holding an OPEN permission claim.

    Inputs: manager (SessionManager), sid (str), tmux_name (str),
      wd (Path) - a working directory, exists (bool) - what the backend's
      ``has-session`` will answer.
    Output: datetime - the instant the claim was opened, for the assert.
    Example: _register_with_open_permission(m, 'ses_1', 'cloude_a', tmp)
    """
    manager.sessions[sid] = Session(
        id=sid,
        pty_pid=None,
        working_dir=str(wd),
        status=SessionStatus.RUNNING,
        tmux_session=tmux_name,
    )
    manager.backends[sid] = _SocketBackend(tmux_name, exists=exists)
    manager._subscribers.setdefault(sid, [])
    opened_at = datetime(2026, 9, 11, 12, 0, 0)
    manager._activity_tracker.record_event(
        sid, EVENT_PERMISSION_REQUEST, now=opened_at
    )
    assert manager._activity_tracker.permission_open_since(sid) == opened_at
    return opened_at


def _listing(name: str, status: str, *, socket: str = TEST_SOCKET) -> StatusMap:
    """A COMPLETE bulk pane listing, from a stated socket, carrying one row.

    Inputs: name (str) - the tmux session name. status (str) - a
      ``resolve_pane_status`` value. socket (str) - the socket the listing
      claims to have been taken from.
    Output: StatusMap.
    Example: _listing('cloude_a', STATUS_DEAD)
    """
    return StatusMap(
        {
            name: {
                "name": name,
                "status": status,
                "pid": 4321,
                "pane_dead": "1" if status == STATUS_DEAD else "0",
                "pane_current_command": "zsh",
                "created_at_epoch": 1755000000,
            }
        },
        complete=True,
        socket=socket,
    )


def test_a_measured_dead_pane_still_clears_the_flag_through_the_listing_pass(
    mgr, tmp_path
):
    """THE BEHAVIOUR THAT IS KEPT. A complete listing from this backend's
    own socket reports this pane dead, so the claim is retired on that
    measurement alone and the stuck bit never forms."""
    _register_with_open_permission(mgr, "ses_dead", "cloude_dead", tmp_path)

    info = mgr._session_info_for(
        "ses_dead", status_map=_listing("cloude_dead", STATUS_DEAD)
    )

    assert info is None, "sanity: a dead husk still drops off the running list"
    assert mgr._activity_tracker.permission_open_since("ses_dead") is None, (
        "a POSITIVELY measured dead pane cannot be showing a dialog, so the "
        "claim must be retired here or it is stuck forever"
    )


def test_a_failed_liveness_probe_keeps_the_open_permission_flag(mgr, tmp_path):
    """THE NEGATIVE CONTROL, AND THE WHOLE POINT OF THIS SECTION.

    Here nothing measured the pane at all. The listing is complete and
    simply does not name this session, and ``has-session`` answered False
    - which is the SAME False it returns when tmux is missing, when the
    call timed out, or when it errored. The row is dropped, as it always
    was, and that drop self-heals on the next poll.

    The flag must NOT be. Clearing it here silently dismisses a permission
    request the user never answered, on evidence that says nothing about
    the pane's screen.

    MUTATION TO RUN IF YOU TOUCH THE BRANCH: in
    ``SessionManager._session_info_for``'s ``LIVENESS_GONE`` arm, pass a
    flat ``pane_alive=False`` instead of the guarded value. This test goes
    red and the one above stays green. That was executed before this file
    was committed.
    """
    opened_at = _register_with_open_permission(
        mgr, "ses_murky", "cloude_murky", tmp_path, exists=False
    )

    info = mgr._session_info_for(
        "ses_murky",
        status_map=StatusMap({}, complete=True, socket=TEST_SOCKET),
    )

    assert info is None, "a session the backend says is absent is still dropped"
    assert mgr._activity_tracker.permission_open_since("ses_murky") == opened_at, (
        "an unmeasured pane must never clear an open permission claim - "
        "has-session cannot tell absence from a failed call"
    )


def test_a_dead_reading_from_an_unstated_socket_keeps_the_flag(mgr, tmp_path):
    """A tmux session NAME is not unique across sockets, so a listing that
    will not say where it came from cannot vouch for this backend's pane.
    The row still drops (that is the pre-existing, self-healing half); the
    flag is kept, because refusing costs nothing and a cross-socket clear
    would dismiss a live dialog."""
    opened_at = _register_with_open_permission(
        mgr, "ses_xsock", "cloude_xsock", tmp_path
    )

    info = mgr._session_info_for(
        "ses_xsock", status_map=_listing("cloude_xsock", STATUS_DEAD, socket="")
    )

    assert info is None
    assert mgr._activity_tracker.permission_open_since("ses_xsock") == opened_at, (
        "a listing with no stated socket proves nothing about this pane"
    )


def test_a_live_pane_is_untouched_by_any_of_this(mgr, tmp_path):
    """THE POSITIVE CONTROL. A fix that refused everything, or one that
    cleared everything, would pass one of the tests above and fail here.
    A live pane keeps its row AND keeps its claim - the seam's cost gate
    owns what happens next, and inside the grace window it does nothing."""
    opened_at = _register_with_open_permission(
        mgr, "ses_live", "cloude_live", tmp_path
    )

    info = mgr._session_info_for(
        "ses_live", status_map=_listing("cloude_live", STATUS_IDLE)
    )

    assert info is not None, "a live pane must stay in the running list"
    assert mgr._activity_tracker.permission_open_since("ses_live") == opened_at
