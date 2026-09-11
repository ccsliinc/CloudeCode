"""claude's idle nudge is not a summons, and the gate for it is separate.

claude fires an idle ``Notification`` about 60s after a turn that already
ended cleanly, with NO sub-agent involved at all - measured live
2026-09-10 on ``ses_63beb976``: twelve consecutive Stop-then-Notification
pairs, each at plus 60.1s, each rendered as a light-blue "wants your
attention" toast over a session that had nothing to ask. The owner's
complaint, verbatim: "i was just shown a notification that cloudecode
needed my input... and you dont."

This is the sub-agent gate's false-urgency shape one layer broader: that
gate (``tests/test_hook_toast_subagent_suppression.py``) only covers a
trailing Notification while sub-agents are (or were recently) running.
This file covers the same trailing Notification with NO sub-agent in the
picture at all - the gate in ``routes.claude_hook_event`` reads
``SessionManager.should_suppress_idle_notification`` (backed by the pure
``session_activity.idle_notification_should_suppress``) and skips the
toast when a ``Stop`` was positively seen, nothing has reopened the turn
since (``turn_open``), and no permission is open.

Three properties this file exists to hold down, mirroring the sub-agent
gate's own three:

1. ``PermissionRequest`` IS NEVER SUPPRESSED by this gate. It is never
   even routed through it (the route only checks this signal for
   ``Notification``), and the pure function refuses it too if asked.
2. IT FAILS TOWARD NOTIFYING. An unknown session, one that never saw a
   ``Stop``, one whose turn was reopened, one with a permission open, or a
   read that throws - all leave the toast raised exactly as before.
3. IT DOES NOT TOUCH THE STATE MACHINE. The event is still recorded above
   the gate; only the interruption is skipped.

Run with:
    venv/bin/python3 -m pytest tests/test_hook_toast_idle_nudge_suppression.py -v
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

# ---- minimal env bootstrap so `src.config` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_itn_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_itn_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
import sys

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.api.routes as routes_mod
from src.api.auth import require_auth
from src.core.session_activity import (
    IDLE_NOTIFICATION_SUPPRESSION_REASON,
    SessionActivityTracker,
    idle_notification_should_suppress,
)
from src.core.session_manager import SessionManager
from src.models import Session, SessionStatus


class _StubSettings:
    """Just enough of ``Settings`` for SessionManager.__init__."""

    def __init__(self, pin_path: Path, log_dir: Path, port: int = 5001):
        self._pin_path = pin_path
        self._log_dir = log_dir
        self.port = port

    def get_pinned_themes_path(self) -> Path:
        return self._pin_path

    def get_unread_state_path(self) -> Path:
        return self._pin_path.parent / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._log_dir)

    def get_session_metadata_path(self) -> Path:
        return self._log_dir / "session_metadata.json"


class _FakeBackend:
    """Bare enough of a SessionBackend for tmux_session lookups."""

    def __init__(self, tmux_session: str):
        self.tmux_session = tmux_session

    def is_alive(self) -> bool:
        return True


def _build_hook_app(monkeypatch, tmp_path):
    """A SessionManager with one registered session, wired to a test app.

    Mirrors ``tests/test_hook_toast_subagent_suppression.py::_build_hook_app``
    so both files describe the hook endpoint the same way.
    """
    stub = _StubSettings(
        pin_path=tmp_path / "pinned_themes.json",
        log_dir=tmp_path / "logs",
    )
    (tmp_path / "logs").mkdir(exist_ok=True)
    monkeypatch.setattr("src.core.session_manager.settings", stub)
    mgr = SessionManager()

    work = tmp_path / "hook_proj"
    work.mkdir()
    mgr.sessions["ses_hook"] = Session(
        id="ses_hook",
        pty_pid=None,
        working_dir=str(work),
        status=SessionStatus.RUNNING,
        tmux_session="cloude_hook_proj",
    )
    mgr.backends["ses_hook"] = _FakeBackend("cloude_hook_proj")
    mgr._subscribers.setdefault("ses_hook", [])
    mgr._mint_hook_token("ses_hook")

    app = FastAPI()
    app.state.session_manager = mgr
    app.include_router(routes_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return app, mgr


def _post_event(app, mgr, event: str):
    """POST one hook event as the loopback hook subprocess would.

    Returns ``(response, broadcast_mock)`` so a caller can assert on both
    the toast row and the websocket fan-out - a suppressed toast must do
    neither.
    """
    client = TestClient(app, client=("127.0.0.1", 12345))
    with patch.object(
        routes_mod.connection_manager,
        "broadcast_to_session",
        new=AsyncMock(return_value=None),
    ) as mock_bcast:
        resp = client.post(
            "/api/v1/hooks/claude-event",
            headers={
                "X-Cloudecode-Session": "ses_hook",
                "X-Cloudecode-Token": mgr.get_hook_token("ses_hook"),
                "X-Cloudecode-Event": event,
                "Content-Type": "application/json",
            },
            json={},
        )
    return resp, mock_bcast


# =========================================================================== #
# 1. The pure function in isolation                                          #
# =========================================================================== #


def test_pure_function_suppresses_only_when_all_three_hold():
    assert (
        idle_notification_should_suppress(
            permission_open=False, turn_open=False, stop_seen=True
        )
        is True
    )


@pytest.mark.parametrize(
    "kwargs",
    [
        dict(permission_open=True, turn_open=False, stop_seen=True),
        dict(permission_open=False, turn_open=True, stop_seen=True),
        dict(permission_open=False, turn_open=False, stop_seen=False),
    ],
)
def test_pure_function_refuses_when_any_one_condition_fails(kwargs):
    assert idle_notification_should_suppress(**kwargs) is False


def test_tracker_accessor_matches_the_pure_function(monkeypatch, tmp_path):
    tracker = SessionActivityTracker()
    assert tracker.should_suppress_idle_notification("never-seen") is False

    tracker.record_event("s1", "UserPromptSubmit")
    tracker.record_event("s1", "Stop")
    assert tracker.should_suppress_idle_notification("s1") is True

    tracker.record_event("s1", "PreToolUse")
    assert tracker.should_suppress_idle_notification("s1") is False


# =========================================================================== #
# 2. Suppressed: the measured case                                           #
# =========================================================================== #


def test_notification_after_a_clean_stop_is_suppressed(monkeypatch, tmp_path):
    """THE BUG. ses_63beb976's twelve-times-in-a-row measured incident."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)

    stop_resp, _ = _post_event(app, mgr, "Stop")
    assert "toast_id" in stop_resp.json()

    resp, mock_bcast = _post_event(app, mgr, "Notification")

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "toast_id" not in payload
    assert payload["toast_suppressed"] == IDLE_NOTIFICATION_SUPPRESSION_REASON
    assert payload["toast_suppressed"] == "turn_closed"
    # Only the SECOND toast (the Notification) is suppressed - the Stop
    # itself raised normally, matching "only the interruption is skipped".
    assert len(mgr.get_toasts("ses_hook")) == 1
    mock_bcast.assert_not_called()


def test_a_repeated_stop_notification_cycle_stays_suppressed(
    monkeypatch, tmp_path
):
    """The measured shape was twelve consecutive pairs, not one."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _post_event(app, mgr, "Stop")

    for _ in range(12):
        resp, mock_bcast = _post_event(app, mgr, "Notification")
        assert resp.json()["toast_suppressed"] == "turn_closed"
        mock_bcast.assert_not_called()


def test_suppressed_case_still_updates_the_state_machine(monkeypatch, tmp_path):
    """Only the interruption is skipped, never the record.

    The Notification event is still applied above the gate: ``notice_open``
    still flips, so a poll or a view still sees the session asking for
    attention. A gate that also skipped ``record_hook_event`` would leave
    the row's own light stale, which is the failure this proves did not
    happen.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _post_event(app, mgr, "Stop")

    resp, _ = _post_event(app, mgr, "Notification")
    assert resp.json()["toast_suppressed"] == "turn_closed"

    signal = mgr._activity_tracker._signals["ses_hook"]
    assert signal.notice_open is True
    assert signal.hook_seen is True
    assert mgr._activity_tracker.hooks_seen("ses_hook") is True


# =========================================================================== #
# 3. Never suppressed: the negative controls                                 #
# =========================================================================== #


def test_permission_request_always_raises_even_after_a_clean_stop(
    monkeypatch, tmp_path
):
    """NEGATIVE CONTROL, the load-bearing one.

    A hard block stays true regardless of how quiet the session got. The
    route only reads this signal for ``event_kind == "Notification"``, so a
    PermissionRequest can never be routed through this gate at all - this
    proves the OUTCOME, not just the wiring.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _post_event(app, mgr, "Stop")
    assert mgr.should_suppress_idle_notification("ses_hook") is True

    resp, mock_bcast = _post_event(app, mgr, "PermissionRequest")

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "toast_id" in payload
    assert "toast_suppressed" not in payload
    mock_bcast.assert_called_once()


def test_notification_with_no_stop_ever_seen_still_raises(monkeypatch, tmp_path):
    """NEGATIVE CONTROL: not having seen a Stop is not evidence one happened."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    assert mgr.should_suppress_idle_notification("ses_hook") is False

    resp, mock_bcast = _post_event(app, mgr, "Notification")

    assert "toast_id" in resp.json()
    assert "toast_suppressed" not in resp.json()
    mock_bcast.assert_called_once()


def test_notification_after_the_turn_reopened_still_raises(monkeypatch, tmp_path):
    """NEGATIVE CONTROL: an opening event since the Stop means real work."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _post_event(app, mgr, "Stop")
    mgr.record_hook_event("ses_hook", "PreToolUse", {})
    assert mgr.should_suppress_idle_notification("ses_hook") is False

    resp, mock_bcast = _post_event(app, mgr, "Notification")

    assert "toast_id" in resp.json()
    assert "toast_suppressed" not in resp.json()
    mock_bcast.assert_called_once()


def test_notification_with_a_permission_open_still_raises(monkeypatch, tmp_path):
    """NEGATIVE CONTROL: a permission currently open blocks the suppression.

    A PermissionRequest never reopens ``turn_open`` (only UserPromptSubmit /
    PreToolUse / SubagentStart do), so this exercises the ``permission_open``
    leg of the rule on its own rather than by coincidence with the other.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _post_event(app, mgr, "Stop")

    perm_resp, _ = _post_event(app, mgr, "PermissionRequest")
    assert "toast_id" in perm_resp.json()
    assert mgr.should_suppress_idle_notification("ses_hook") is False

    resp, mock_bcast = _post_event(app, mgr, "Notification")

    assert "toast_id" in resp.json()
    assert "toast_suppressed" not in resp.json()
    mock_bcast.assert_called_once()


def test_an_unreadable_signal_still_notifies(monkeypatch, tmp_path):
    """Fail toward notifying applies to a read that throws too."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _post_event(app, mgr, "Stop")

    def _boom(_session_id: str) -> bool:
        raise RuntimeError("tracker unavailable")

    monkeypatch.setattr(mgr, "should_suppress_idle_notification", _boom)

    resp, mock_bcast = _post_event(app, mgr, "Notification")

    assert "toast_id" in resp.json()
    assert "toast_suppressed" not in resp.json()
    mock_bcast.assert_called_once()


def test_a_session_that_never_stopped_is_unaffected(monkeypatch, tmp_path):
    """No Stop, no suppression, no behaviour change of any kind."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)

    resp, mock_bcast = _post_event(app, mgr, "Notification")

    assert "toast_id" in resp.json()
    mock_bcast.assert_called_once()


# =========================================================================== #
# 4. Composition with the sub-agent gate: order does not double-suppress    #
# =========================================================================== #


def test_the_subagent_gate_still_wins_its_own_reason_string(monkeypatch, tmp_path):
    """A Notification trailing a sub-agent-suppressed Stop still reports
    ``subagents_running``, not ``turn_closed`` - the sub-agent gate is
    checked first and returns before this one is ever reached, so the two
    reasons cannot be confused for one another.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    mgr.record_hook_event("ses_hook", "SubagentStart", {})

    stop_resp, _ = _post_event(app, mgr, "Stop")
    assert stop_resp.json()["toast_suppressed"] == "subagents_running"

    resp, mock_bcast = _post_event(app, mgr, "Notification")

    assert resp.json()["toast_suppressed"] == "subagents_running"
    mock_bcast.assert_not_called()
