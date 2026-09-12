"""A session waiting on its own sub-agents is not waiting on the user.

RETARGETED AT THE 1.4.0 INTEGRATION. This line's SessionManager does not
own the live tables or the toast bucket: the registry owns sessions,
backends and the per-viewer subscriber lists, ToastInbox owns the
records, and HookTokenAuthority owns the tokens and the tmux-name map.
The BEHAVIOUR asserted below is unchanged.


claude fires ``Stop`` when the MAIN turn ends, whether or not the
background agents it launched are still running, and it fires
``Notification`` asking to be looked at in that same state. Both raised a
toast summoning the user to a pane that literally read "Waiting for 2
background agents to finish". The gate in ``routes.claude_hook_event``
skips those two toasts while ``subagent_depth`` is POSITIVE.

Three properties this file exists to hold down:

1. ``PermissionRequest`` IS NEVER SUPPRESSED, at any depth. It is a hard
   block - claude has stopped and cannot continue until a human answers -
   so it is the one ask that stays true while the session is otherwise
   busy with itself.
2. IT FAILS TOWARD NOTIFYING. A dropped ``SubagentStart`` (hooks are
   droppable), an unknown session, or a depth read that throws all leave
   the count at 0 and the toast is raised exactly as before. A missed
   "your turn" is a worse failure than a spurious one.
3. IT READS THE DEPTH AS IT STOOD AT THE EVENT. ``Stop`` itself resets
   the count to 0, and claude fires a ``SubagentStop`` about 1.5s AFTER
   the ``Stop`` on a turn with no subagent in it - so a gate built on
   either the post-Stop count or on a later event would be reading
   evidence that does not exist yet.

Run with:
    venv/bin/python3 -m pytest tests/test_hook_toast_subagent_suppression.py -v
"""

from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

# ---- minimal env bootstrap so `src.config` import succeeds --------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_hts_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_hts_logs_"))
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
import src.api.hook_event_routes as hook_routes_mod
from src.api.auth import require_auth
from src.core.session_activity import (
    SUBAGENT_WAIT_LATCH_SECONDS,
    SessionActivityTracker,
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

    Mirrors ``tests/test_hook_driven_status.py::_build_hook_app`` so both
    files describe the hook endpoint the same way.
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
    mgr._registry.sessions["ses_hook"] = Session(
        id="ses_hook",
        pty_pid=None,
        working_dir=str(work),
        status=SessionStatus.RUNNING,
        tmux_session="cloude_hook_proj",
    )
    mgr._registry.backends["ses_hook"] = _FakeBackend("cloude_hook_proj")
    mgr._registry.subscribers.setdefault("ses_hook", [])
    mgr.hook_tokens.mint("ses_hook")

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
        hook_routes_mod.connection_manager,
        "broadcast_to_session",
        new=AsyncMock(return_value=None),
    ) as mock_bcast:
        resp = client.post(
            "/api/v1/hooks/claude-event",
            headers={
                "X-Cloudecode-Session": "ses_hook",
                "X-Cloudecode-Token": mgr.hook_tokens.get("ses_hook"),
                "X-Cloudecode-Event": event,
                "Content-Type": "application/json",
            },
            json={},
        )
    return resp, mock_bcast


def _start_subagents(mgr: SessionManager, count: int) -> None:
    """Put ``count`` unmatched SubagentStart events into the tracker."""
    for _ in range(count):
        mgr.record_hook_event("ses_hook", "SubagentStart", {})
    assert mgr.subagent_depth("ses_hook") == count


def _latch_stamp(mgr: SessionManager):
    """The raw ``subagent_wait_since`` value, or None. Read-only."""
    return mgr._activity_tracker._signals["ses_hook"].subagent_wait_since


def _age_the_latch(mgr: SessionManager, seconds: float) -> None:
    """Backdate the latch stamp so it reads ``seconds`` old.

    The endpoint reads the wall clock, so moving the stamp is how a test
    advances time without patching ``datetime`` out from under the whole
    request path.
    """
    state = mgr._activity_tracker._signals["ses_hook"]
    assert state.subagent_wait_since is not None, "nothing latched to age"
    state.subagent_wait_since = state.subagent_wait_since - timedelta(
        seconds=seconds
    )


# =========================================================================== #
# 1. The accessor itself                                                      #
# =========================================================================== #


def test_subagent_depth_counts_unmatched_starts():
    tracker = SessionActivityTracker()
    assert tracker.subagent_depth("s1") == 0
    tracker.record_event("s1", "SubagentStart")
    tracker.record_event("s1", "SubagentStart")
    assert tracker.subagent_depth("s1") == 2
    tracker.record_event("s1", "SubagentStop")
    assert tracker.subagent_depth("s1") == 1


def test_subagent_depth_of_an_unknown_session_is_zero_not_none():
    """An unknown session is NOT evidence sub-agents are running.

    The one caller reads a POSITIVE count as licence to stay quiet, so the
    absence of a record has to be the loud answer, not a None that would
    have to be special-cased at every call site.
    """
    tracker = SessionActivityTracker()
    assert tracker.subagent_depth("never-seen") == 0


def test_subagent_depth_is_floored_at_zero_by_a_stray_stop():
    """A duplicated / out-of-order SubagentStop cannot drive it negative.

    A negative depth would read as "no sub-agents" here but would also
    permanently swallow the next legitimate Start.
    """
    tracker = SessionActivityTracker()
    tracker.record_event("s1", "SubagentStop")
    tracker.record_event("s1", "SubagentStop")
    assert tracker.subagent_depth("s1") == 0


def test_session_manager_passthrough_matches_the_tracker(monkeypatch, tmp_path):
    _, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 2)
    assert mgr.subagent_depth("ses_hook") == 2
    assert mgr.subagent_depth("ghost") == 0


# =========================================================================== #
# 2. Suppressed while sub-agents are running                                  #
# =========================================================================== #


@pytest.mark.parametrize("event", ["Stop", "Notification"])
def test_toast_is_suppressed_while_subagents_are_running(
    monkeypatch, tmp_path, event
):
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)

    resp, mock_bcast = _post_event(app, mgr, event)

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["ok"] is True
    assert "toast_id" not in payload
    assert payload["toast_suppressed"] == "subagents_running"
    assert mgr._toast_inbox.get("ses_hook") == []
    mock_bcast.assert_not_called()


def test_suppression_holds_at_a_depth_greater_than_one(monkeypatch, tmp_path):
    """The reported case was "Waiting for 2 background agents to finish"."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 2)

    resp, _ = _post_event(app, mgr, "Notification")

    assert resp.json()["toast_suppressed"] == "subagents_running"
    assert mgr._toast_inbox.get("ses_hook") == []


def test_a_suppressed_stop_still_records_its_activity(monkeypatch, tmp_path):
    """Only the interruption is skipped, never the state machine.

    The session still took its Stop: the unread flag flips, the tracker
    saw the event. A gate that also dropped the activity update would make
    a finished session look like it never finished.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)

    _post_event(app, mgr, "Stop")

    assert mgr._is_unread("cloude_hook_proj") is True
    assert mgr._activity_tracker.hooks_seen("ses_hook") is True
    # Stop resets the depth, which is exactly why the gate reads it BEFORE
    # the event is applied rather than after.
    assert mgr.subagent_depth("ses_hook") == 0


# =========================================================================== #
# 3. Raised when nothing is running - the regression guard                    #
# =========================================================================== #


@pytest.mark.parametrize("event", ["Stop", "Notification"])
def test_toast_still_raised_when_no_subagents_are_running(
    monkeypatch, tmp_path, event
):
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    assert mgr.subagent_depth("ses_hook") == 0

    resp, mock_bcast = _post_event(app, mgr, event)

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "toast_id" in payload
    assert "toast_suppressed" not in payload
    assert len(mgr._toast_inbox.get("ses_hook")) == 1
    mock_bcast.assert_called_once()


def test_toast_returns_after_the_last_subagent_finishes(monkeypatch, tmp_path):
    """A matched Start/Stop pair leaves the session loud again."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)
    mgr.record_hook_event("ses_hook", "SubagentStop", {})
    assert mgr.subagent_depth("ses_hook") == 0

    resp, _ = _post_event(app, mgr, "Stop")

    assert "toast_id" in resp.json()
    assert len(mgr._toast_inbox.get("ses_hook")) == 1


# =========================================================================== #
# 4. PermissionRequest is never suppressed - the load-bearing exception       #
# =========================================================================== #


@pytest.mark.parametrize("depth", [0, 1, 3])
def test_permission_request_always_raises_a_toast(monkeypatch, tmp_path, depth):
    """A hard block stays true however busy the session is with itself.

    This is the negative control for the whole gate. A suppression rule
    that quietly grew to cover PermissionRequest would pass every test in
    section 2 and would strand claude mid-turn behind a yes/no nobody was
    told about.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    if depth:
        _start_subagents(mgr, depth)

    resp, mock_bcast = _post_event(app, mgr, "PermissionRequest")

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "toast_id" in payload
    assert "toast_suppressed" not in payload
    assert len(mgr._toast_inbox.get("ses_hook")) == 1
    mock_bcast.assert_called_once()


# =========================================================================== #
# 5. Fail toward notifying                                                    #
# =========================================================================== #


def test_an_unreadable_depth_still_notifies(monkeypatch, tmp_path):
    """If the count cannot be read, the toast is raised exactly as before.

    A missed "your turn" is worse than a spurious one, so the gate buys
    silence only with a POSITIVE reading. Anything that throws is not one.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)

    def _boom(_session_id: str) -> int:
        raise RuntimeError("tracker unavailable")

    monkeypatch.setattr(mgr, "subagent_depth", _boom)

    resp, mock_bcast = _post_event(app, mgr, "Stop")

    assert resp.status_code == 200, resp.text
    assert "toast_id" in resp.json()
    assert len(mgr._toast_inbox.get("ses_hook")) == 1
    mock_bcast.assert_called_once()


def test_a_dropped_subagent_start_still_notifies(monkeypatch, tmp_path):
    """Hooks are droppable, so the count can be wrong in the quiet direction.

    A sub-agent really is running but its ``SubagentStart`` never arrived,
    so the depth reads 0. The toast fires. That is the designed failure
    mode, not an oversight: the gate only ever suppresses on evidence it
    actually has.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    # SubagentStart deliberately NOT recorded - this is the dropped event.
    assert mgr.subagent_depth("ses_hook") == 0

    resp, _ = _post_event(app, mgr, "Stop")

    assert "toast_id" in resp.json()


# =========================================================================== #
# 6. The documented ordering trap                                             #
# =========================================================================== #


def test_a_subagent_stop_arriving_after_stop_does_not_suppress_it(
    monkeypatch, tmp_path
):
    """The measured trap: on a turn with NO subagent, claude fires a
    ``SubagentStop`` about 1.5s AFTER the ``Stop`` (CLAUDE.md).

    The gate must not be reading that straggler, in either direction. The
    Stop toasts on the evidence available when it lands, and the late
    SubagentStop cannot retroactively unmake it.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)

    resp, _ = _post_event(app, mgr, "Stop")
    assert "toast_id" in resp.json()

    # The straggler lands afterwards and changes nothing already decided.
    mgr.record_hook_event("ses_hook", "SubagentStop", {})
    assert len(mgr._toast_inbox.get("ses_hook")) == 1
    assert mgr.subagent_depth("ses_hook") == 0


def test_depth_is_read_before_the_stop_resets_it(monkeypatch, tmp_path):
    """``Stop`` zeroes ``subagent_depth``, so a gate reading it afterwards
    would answer 0 every time and could never fire.

    This asserts the ordering by OUTCOME rather than by call sequence: the
    toast is suppressed, which is only possible if the positive count was
    observed before the reset.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)

    resp, _ = _post_event(app, mgr, "Stop")

    assert resp.json()["toast_suppressed"] == "subagents_running"
    assert mgr.subagent_depth("ses_hook") == 0  # the reset did happen


def test_another_sessions_subagents_do_not_silence_this_one(
    monkeypatch, tmp_path
):
    """The depth is per session id, so a busy neighbour cannot mute a row."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    mgr.record_hook_event("ses_other", "SubagentStart", {})
    assert mgr.subagent_depth("ses_other") == 1
    assert mgr.subagent_depth("ses_hook") == 0

    resp, _ = _post_event(app, mgr, "Stop")

    assert "toast_id" in resp.json()


# =========================================================================== #
# 7. The latch: the depth alone only covers the FIRST event of a wait         #
# =========================================================================== #
#
# ``Stop`` resets ``subagent_depth`` to 0, so the gate suppresses that Stop
# correctly and is then blind for the rest of the same background wait.
# Measured live 2026-09-10 on ``ses_63beb976``: a Stop suppressed at depth 1
# at 20:38:53.879, then an idle ``Notification`` RAISED at 20:39:53.964,
# plus 60.09s. Reproduced twice more, once with a second ``Stop`` raised at
# plus 19.22s as well. Every one summoned the user to a pane reading
# "Waiting for N background agents to finish".


def test_the_notification_after_a_suppressed_stop_is_suppressed(
    monkeypatch, tmp_path
):
    """THE BUG. The trailing idle Notification must stay quiet too."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)

    first, _ = _post_event(app, mgr, "Stop")
    assert first.json()["toast_suppressed"] == "subagents_running"
    # The depth is gone. Only the latch can answer from here.
    assert mgr.subagent_depth("ses_hook") == 0

    resp, mock_bcast = _post_event(app, mgr, "Notification")

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "toast_id" not in payload
    assert payload["toast_suppressed"] == "subagents_running"
    assert mgr._toast_inbox.get("ses_hook") == []
    mock_bcast.assert_not_called()


def test_a_second_stop_after_a_suppressed_stop_is_suppressed(
    monkeypatch, tmp_path
):
    """The plus 19.22s second Stop from the third live reproduction."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 2)

    first, _ = _post_event(app, mgr, "Stop")
    assert first.json()["toast_suppressed"] == "subagents_running"

    resp, mock_bcast = _post_event(app, mgr, "Stop")

    assert resp.json()["toast_suppressed"] == "subagents_running"
    assert mgr._toast_inbox.get("ses_hook") == []
    mock_bcast.assert_not_called()


def test_the_latch_expires_and_the_notification_is_raised(
    monkeypatch, tmp_path
):
    """THE MUTE IS BOUNDED, and that is the safety property.

    An over-long background wait degrades to a DELAYED notification, never
    a lost one. A latch with no expiry would be an unbounded mute, and a
    missed "your turn" is a worse failure than a spurious one.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)
    _post_event(app, mgr, "Stop")

    _age_the_latch(mgr, SUBAGENT_WAIT_LATCH_SECONDS + 1)

    # The separate, unbounded idle-nudge gate (see
    # tests/test_hook_toast_idle_nudge_suppression.py) would ALSO suppress
    # this Notification on its own evidence (a clean Stop, nothing reopened
    # since) - correctly, but that is not what THIS test is about. Neutralize
    # it so this file keeps testing the sub-agent latch's own boundedness in
    # isolation.
    monkeypatch.setattr(mgr, "should_suppress_idle_notification", lambda sid: False)

    resp, mock_bcast = _post_event(app, mgr, "Notification")

    assert "toast_id" in resp.json()
    assert "toast_suppressed" not in resp.json()
    assert len(mgr._toast_inbox.get("ses_hook")) == 1
    mock_bcast.assert_called_once()


def test_the_latch_still_holds_just_inside_the_window(monkeypatch, tmp_path):
    """The boundary from the other side, so the expiry test proves a TTL
    rather than proving the latch never worked."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)
    _post_event(app, mgr, "Stop")

    _age_the_latch(mgr, SUBAGENT_WAIT_LATCH_SECONDS - 5)

    resp, _ = _post_event(app, mgr, "Notification")

    assert resp.json()["toast_suppressed"] == "subagents_running"


@pytest.mark.parametrize(
    "opening", ["UserPromptSubmit", "PreToolUse", "SubagentStart"]
)
def test_an_opening_event_clears_the_latch(monkeypatch, tmp_path, opening):
    """A new turn beginning is positive proof the previous wait is over.

    ``SubagentStart`` is in the list even though it also RAISES the depth:
    the gate is covered by the live count from there until the next Stop,
    and clearing is the fail-toward-notifying direction anyway.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)
    _post_event(app, mgr, "Stop")
    assert _latch_stamp(mgr) is not None

    mgr.record_hook_event("ses_hook", opening, {})
    assert _latch_stamp(mgr) is None

    if opening == "SubagentStart":
        # It raised the depth, so drain it: this test is about the latch,
        # and the live count would suppress on its own.
        mgr.record_hook_event("ses_hook", "SubagentStop", {})
    assert mgr.subagent_depth("ses_hook") == 0

    resp, mock_bcast = _post_event(app, mgr, "Stop")

    assert "toast_id" in resp.json()
    assert len(mgr._toast_inbox.get("ses_hook")) == 1
    mock_bcast.assert_called_once()


def test_a_session_that_never_had_subagents_is_unaffected(
    monkeypatch, tmp_path
):
    """No sub-agent, no latch, no behaviour change of any kind - OF THIS
    GATE. The separate idle-nudge gate (see
    tests/test_hook_toast_idle_nudge_suppression.py) does now suppress a
    plain Notification following a clean Stop with nothing reopened since,
    which is the whole point of that gate - so it is neutralized here to
    keep this file testing the sub-agent-specific mechanism alone."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    monkeypatch.setattr(mgr, "should_suppress_idle_notification", lambda sid: False)

    first, _ = _post_event(app, mgr, "Stop")
    assert "toast_id" in first.json()
    assert _latch_stamp(mgr) is None

    second, _ = _post_event(app, mgr, "Notification")
    assert "toast_id" in second.json()

    third, _ = _post_event(app, mgr, "Stop")
    assert "toast_id" in third.json()

    # Every one of the three RAISED, which is the claim. The stored count
    # is 2, not 3: two Stops of the same kind supersede each other, which
    # is toast_supersede's job and nothing to do with this gate.
    assert _latch_stamp(mgr) is None
    assert all(
        "toast_suppressed" not in r.json() for r in (first, second, third)
    )


def test_permission_request_raises_with_the_latch_stamped(
    monkeypatch, tmp_path
):
    """NEGATIVE CONTROL, and it is the load-bearing one.

    A hard block stays true however the session got quiet. The latch is a
    new way to buy silence, so it needs the same exception the depth has:
    a suppression rule that quietly grew to cover PermissionRequest would
    pass every positive test above and strand claude mid-turn behind a
    yes/no nobody was told about.

    Both halves of the evidence are set here on purpose - the latch
    stamped AND the depth positive - so neither one can be the reason it
    passes.
    """
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)
    _post_event(app, mgr, "Stop")
    assert _latch_stamp(mgr) is not None
    _start_subagents(mgr, 1)
    assert mgr.subagent_depth("ses_hook") == 1

    resp, mock_bcast = _post_event(app, mgr, "PermissionRequest")

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "toast_id" in payload
    assert "toast_suppressed" not in payload
    assert len(mgr._toast_inbox.get("ses_hook")) == 1
    mock_bcast.assert_called_once()


def test_an_unreadable_latch_still_notifies(monkeypatch, tmp_path):
    """Fail toward notifying applies to the new reading too."""
    app, mgr = _build_hook_app(monkeypatch, tmp_path)
    _start_subagents(mgr, 1)
    _post_event(app, mgr, "Stop")

    def _boom(_session_id: str) -> bool:
        raise RuntimeError("tracker unavailable")

    monkeypatch.setattr(mgr, "subagent_wait_active", _boom)
    # Neutralize the separate idle-nudge gate, which would otherwise
    # suppress this same Notification on its own (unrelated) evidence - see
    # tests/test_hook_toast_idle_nudge_suppression.py for its own coverage.
    monkeypatch.setattr(mgr, "should_suppress_idle_notification", lambda sid: False)

    resp, _ = _post_event(app, mgr, "Notification")

    assert "toast_id" in resp.json()
    assert len(mgr._toast_inbox.get("ses_hook")) == 1


# =========================================================================== #
# 8. The latch under duplicated, dropped and out-of-order delivery            #
# =========================================================================== #


def test_a_plain_stop_never_stamps_the_latch():
    """Stamped from the depth as it stood BEFORE the reset, so a Stop with
    no sub-agent open latches nothing at all."""
    tracker = SessionActivityTracker()
    tracker.record_event("s1", "Stop")
    assert tracker.subagent_wait_active("s1") is False


def test_an_unknown_session_has_no_latch():
    """Absence of a record is not evidence a wait is in progress."""
    tracker = SessionActivityTracker()
    assert tracker.subagent_wait_active("never-seen") is False


def test_a_duplicate_stop_cannot_extend_the_latch():
    """THE STAMP IS THE TRANSITION, NOT THE EVENT.

    The same discipline ``permission_opened_at`` uses. A duplicate Stop
    arrives with the depth already reset to 0, so it finds nothing to
    stamp from and leaves the original stamp alone. Without this a
    repeating hook would push the mute out for as long as it kept
    arriving, which is exactly when a bounded mute matters most.
    """
    tracker = SessionActivityTracker()
    t0 = datetime(2026, 9, 10, 20, 38, 53)
    tracker.record_event("s1", "SubagentStart", now=t0)
    tracker.record_event("s1", "Stop", now=t0)

    late = t0 + timedelta(seconds=SUBAGENT_WAIT_LATCH_SECONDS - 10)
    tracker.record_event("s1", "Stop", now=late)

    past_ttl = t0 + timedelta(seconds=SUBAGENT_WAIT_LATCH_SECONDS + 1)
    assert tracker.subagent_wait_active("s1", now=past_ttl) is False


def test_a_duplicate_subagent_stop_cannot_retire_the_latch():
    """RETIRE BY COUNTING DOWN IS IMPOSSIBLE, so nothing tries.

    After a Stop the depth is already 0, so a later SubagentStop hits the
    floor branch and decrements nothing. A design that retired the latch
    that way would never retire at all.
    """
    tracker = SessionActivityTracker()
    tracker.record_event("s1", "SubagentStart")
    tracker.record_event("s1", "Stop")
    tracker.record_event("s1", "SubagentStop")
    tracker.record_event("s1", "SubagentStop")
    assert tracker.subagent_depth("s1") == 0
    assert tracker.subagent_wait_active("s1") is True


def test_a_straggler_subagent_start_after_stop_clears_the_latch():
    """Out of order, and it resolves in the loud direction.

    A duplicated SubagentStart delivered after the Stop raises the depth
    off the floor by itself. Clearing the latch there costs at most one
    spurious toast; leaving it standing could cost a missed one.
    """
    tracker = SessionActivityTracker()
    tracker.record_event("s1", "SubagentStart")
    tracker.record_event("s1", "Stop")
    assert tracker.subagent_wait_active("s1") is True

    tracker.record_event("s1", "SubagentStart")
    assert tracker.subagent_wait_active("s1") is False
    assert tracker.subagent_depth("s1") == 1


def test_replaying_the_whole_event_stream_twice_converges():
    """Idempotency: the same stream applied twice reaches the same state."""
    t0 = datetime(2026, 9, 10, 20, 38, 0)
    stream = [
        "UserPromptSubmit",
        "PreToolUse",
        "SubagentStart",
        "SubagentStart",
        "PostToolUse",
        "Stop",
    ]

    once = SessionActivityTracker()
    for kind in stream:
        once.record_event("s1", kind, now=t0)

    twice = SessionActivityTracker()
    for kind in stream:
        twice.record_event("s1", kind, now=t0)
        twice.record_event("s1", kind, now=t0)

    assert once.subagent_wait_active("s1", now=t0) is True
    assert twice.subagent_wait_active("s1", now=t0) is True
    assert once.subagent_depth("s1") == twice.subagent_depth("s1") == 0


def test_the_session_manager_latch_passthrough_matches_the_tracker(
    monkeypatch, tmp_path
):
    _, mgr = _build_hook_app(monkeypatch, tmp_path)
    assert mgr.subagent_wait_active("ses_hook") is False
    assert mgr.subagent_wait_active("ghost") is False

    _start_subagents(mgr, 1)
    mgr.record_hook_event("ses_hook", "Stop", {})

    assert mgr.subagent_wait_active("ses_hook") is True
