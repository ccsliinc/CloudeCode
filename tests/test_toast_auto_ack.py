"""A prompt from ANY client answers the session's toasts.

THE OWNER'S ASK, verbatim: "on the toasts, if its waiting on me and i
type into this browser or a remote control session, the toasts should be
removed, we can tell because i think when a new prompt is sent it should
trip a hook." He is right about the hook. ``UserPromptSubmit`` fires
whenever a prompt is submitted, whoever typed it and wherever - the
browser terminal, a remote control session, or the keyboard on the Mac -
so it is a fact about the USER SHOWING UP, and a notification asking the
user to show up is answered the moment they do.

WHAT THIS SUITE IS REALLY GUARDING, because the positive cases are the
easy half and would all pass against a dangerously broad implementation:

  * A rule that acked EVERYTHING on EVERY event would satisfy every
    "the toast is gone" assertion in this file. So each rule is measured
    with its NEGATIVE CONTROL beside it: PreToolUse must leave a
    Notification alone, and no ``Stop`` may ever clear a "your turn".
  * A ``Stop`` both RAISES a toast and ANSWERS others, so the obvious
    defect is a Stop eating the card it just created. It is tested at
    both levels - the pure rule, and end to end through the real hook
    endpoint, where the toast genuinely exists by the time anything
    could eat it.
  * Hook events are unordered, duplicated and droppable (CLAUDE.md), so
    "it works when the events arrive in the nice order" is not a result.
    Duplicates and a late redelivery each get their own test.

THE ORDERING GUARD IS THE SUBTLE ONE. The pure resolver compares a
toast's own ``created_at`` against the instant the EVENT arrived, never
against the instant the ack code happens to run. A prompt redelivered
late must not clear a notification about something that happened after
the user typed - that would destroy a record the user never saw, which
is the one failure mode worse than a card that lingers.
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
# Mirrors tests/test_toast_cross_session.py: the pydantic Settings loader
# sys.exit(1)s if these are missing, so they are set BEFORE any src import.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_taa_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_taa_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.api.routes as routes_mod
import src.api.toast_routes as toast_routes_mod
from src.core.composition import build_services

from src.api.auth import require_auth
from src.core import toast_auto_ack, toast_history
from src.core.session_manager import SessionManager
from src.models import Session, SessionStatus, Toast

ANSWERED = toast_auto_ack.ACK_REASON_ANSWERED
DISMISSED = toast_auto_ack.ACK_REASON_DISMISSED


# --------------------------------------------------------------------- #
# helpers                                                                #
# --------------------------------------------------------------------- #


class _StubSettings:
    """Just enough of ``Settings`` for ``SessionManager.__init__`` to load."""

    def __init__(self, pin_path: Path, log_dir: Path):
        self._pin_path = pin_path
        self._log_dir = log_dir

    def get_pinned_themes_path(self) -> Path:
        return self._pin_path

    def get_unread_state_path(self) -> Path:
        return self._pin_path.parent / "unread_state.json"

    @property
    def log_directory(self) -> str:
        return str(self._log_dir)

    def get_session_metadata_path(self) -> Path:
        return self._log_dir / "session_metadata.json"


def _manager(monkeypatch, tmp_path: Path) -> SessionManager:
    """Description: a SessionManager with no tmux side effects.
    Inputs: monkeypatch, tmp_path. Output: SessionManager.
    """
    (tmp_path / "logs").mkdir(exist_ok=True)
    stub = _StubSettings(tmp_path / "pinned_themes.json", tmp_path / "logs")
    monkeypatch.setattr("src.core.session_manager.settings", stub)
    return SessionManager()


def _session(mgr: SessionManager, sid: str, work: Path) -> Session:
    """Description: register a minimal Session so record_toast accepts the id."""
    work.mkdir(exist_ok=True, parents=True)
    sess = Session(
        id=sid,
        pty_pid=None,
        working_dir=str(work),
        status=SessionStatus.RUNNING,
        tmux_session=f"cloude_{sid}",
    )
    mgr.sessions[sid] = sess
    mgr._subscribers.setdefault(sid, [])
    return sess


def _toast(kind: str, toast_id: str, *, created_at: datetime, acked: bool = False):
    """Description: a bare record for the PURE tests, built without a manager.
    Inputs: kind, toast_id, created_at, acked. Output: Toast.
    """
    return Toast(
        id=toast_id,
        session_id="ses_x",
        kind=kind,
        title=f"{kind} title",
        created_at=created_at,
        acknowledged=acked,
        ack_reason=DISMISSED if acked else None,
    )


def _one_of_each(now: datetime):
    """Description: one open record of every toast kind, all raised at ``now``.
    Output: (records, {kind: id}).
    """
    kinds = ["Stop", "PermissionRequest", "Notification", "StartupPrompt"]
    records = [_toast(k, f"id_{k}", created_at=now) for k in kinds]
    return records, {k: f"id_{k}" for k in kinds}


# --------------------------------------------------------------------- #
# 1. The pure rules, one test per event kind, each with its control.     #
# --------------------------------------------------------------------- #


def test_a_prompt_answers_every_kind_of_toast():
    """The owner's case: he typed, so nothing is still waiting on him."""
    now = datetime.utcnow()
    records, ids = _one_of_each(now)
    acked = toast_auto_ack.resolve_auto_acks(
        records, "UserPromptSubmit", cutoff=now + timedelta(seconds=1)
    )
    assert set(acked) == set(ids.values()), (
        "a submitted prompt answers the permission he approved in the pane, "
        "the notice he read on the way past, the startup prompt he cleared "
        "to be able to type at all, and the turn he has plainly taken"
    )


def test_pre_tool_use_answers_a_permission_and_nothing_else():
    """A tool is about to run, so a permission was granted. That is ALL it
    proves - and the control is the whole test."""
    now = datetime.utcnow()
    records, ids = _one_of_each(now)
    acked = toast_auto_ack.resolve_auto_acks(
        records, "PreToolUse", cutoff=now + timedelta(seconds=1)
    )
    assert acked == [ids["PermissionRequest"]]

    # NEGATIVE CONTROL. A notice cleared by a tool call the user never saw
    # is a notification silently destroyed - the exact failure this whole
    # feature must not introduce while removing cards.
    assert ids["Notification"] not in acked
    assert ids["Stop"] not in acked
    assert ids["StartupPrompt"] not in acked


def test_stop_answers_a_permission_and_a_notice_but_never_a_your_turn():
    """An agent cannot end a turn while blocked, so an open permission was
    answered. But a Stop must never clear a 'your turn'."""
    now = datetime.utcnow()
    records, ids = _one_of_each(now)
    acked = toast_auto_ack.resolve_auto_acks(
        records, "Stop", cutoff=now + timedelta(seconds=1)
    )
    assert set(acked) == {
        ids["PermissionRequest"],
        ids["Notification"],
        ids["StartupPrompt"],
    }
    assert ids["Stop"] not in acked, (
        "the card a Stop raises says the user's turn has come; only the user "
        "turning up may clear it"
    )


def test_a_stop_cannot_clear_an_older_stop_toast_either():
    """THE GUARANTEE IS BY KIND, NOT BY POSITION, and this is what proves
    it. Excluding a Stop's own toast by relying on 'we ack before we
    record' would hold for a first delivery and fail for a duplicate,
    whose predecessor's card is a real unacked record by then."""
    now = datetime.utcnow()
    older = _toast("Stop", "id_older_stop", created_at=now - timedelta(minutes=5))
    acked = toast_auto_ack.resolve_auto_acks([older], "Stop", cutoff=now)
    assert acked == []


def test_an_event_that_answers_nothing_returns_nothing():
    """The overwhelmingly common case: most hook events are not an answer
    to anything, and the resolver's first act should be to say so."""
    now = datetime.utcnow()
    records, _ = _one_of_each(now)
    for kind in ("PostToolUse", "SubagentStart", "SubagentStop", "SessionStart"):
        assert toast_auto_ack.resolve_auto_acks(records, kind, cutoff=now) == []
    assert toast_auto_ack.kinds_answered_by("PostToolUse") == frozenset()


# --------------------------------------------------------------------- #
# 2. Unordered, duplicated, droppable.                                   #
# --------------------------------------------------------------------- #


def test_an_already_answered_toast_is_never_returned_again():
    """Idempotence at the rule level: a duplicated prompt event finds
    nothing left to do rather than re-acking what it already acked."""
    now = datetime.utcnow()
    done = _toast("PermissionRequest", "id_done", created_at=now, acked=True)
    still_open = _toast("Notification", "id_open", created_at=now)
    acked = toast_auto_ack.resolve_auto_acks(
        [done, still_open], "UserPromptSubmit", cutoff=now
    )
    assert acked == ["id_open"]


def test_a_toast_raised_after_the_event_is_never_answered_by_it():
    """THE REORDER CASE. A prompt redelivered late, or simply processed
    behind a burst, must not clear a notification about something that
    happened AFTER the user typed. The comparison is the toast's own
    timestamp against the EVENT's, not against the clock at ack time."""
    typed_at = datetime.utcnow()
    older = _toast(
        "PermissionRequest", "id_before", created_at=typed_at - timedelta(seconds=30)
    )
    newer = _toast(
        "Notification", "id_after", created_at=typed_at + timedelta(seconds=30)
    )
    acked = toast_auto_ack.resolve_auto_acks(
        [older, newer], "UserPromptSubmit", cutoff=typed_at
    )
    assert acked == ["id_before"]
    assert "id_after" not in acked, (
        "a record raised after the user acted describes something the act "
        "cannot have answered; eating it would destroy a notice never seen"
    )


def test_a_stop_toast_already_recorded_survives_that_stops_own_ack_pass():
    """THE REORDER THE ROUTE ACTUALLY RISKS: the Stop's toast exists by the
    time the ack pass runs. Both guards are exercised - the record is
    newer than the cutoff AND its kind is one Stop never answers - and
    either alone must be enough."""
    stop_at = datetime.utcnow()
    own = _toast("Stop", "id_own", created_at=stop_at + timedelta(milliseconds=5))
    older_perm = _toast(
        "PermissionRequest", "id_perm", created_at=stop_at - timedelta(minutes=2)
    )
    acked = toast_auto_ack.resolve_auto_acks(
        [own, older_perm], "Stop", cutoff=stop_at
    )
    assert acked == ["id_perm"]

    # And with NO cutoff at all, the kind rule alone still spares it.
    assert toast_auto_ack.resolve_auto_acks([own, older_perm], "Stop") == ["id_perm"]


# --------------------------------------------------------------------- #
# 3. The manager seam - the reason gets written, and only once.          #
# --------------------------------------------------------------------- #


def test_auto_ack_stamps_answered_and_is_a_no_op_on_replay(monkeypatch, tmp_path):
    mgr = _manager(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    perm = mgr.record_toast("ses_a", "PermissionRequest", "run rm -rf")

    changed = mgr.auto_ack_toasts("ses_a", "UserPromptSubmit", datetime.utcnow())
    assert changed == [perm.id]
    stored = mgr._toast_inbox.get("ses_a")[0]
    assert stored.acknowledged is True
    assert stored.ack_reason == ANSWERED

    # THE DUPLICATE. Hook events are duplicated by contract, so the second
    # delivery must report nothing changed - that is what stops a second
    # WebSocket frame and a second log line for one act.
    assert mgr.auto_ack_toasts("ses_a", "UserPromptSubmit", datetime.utcnow()) == []


def test_a_human_dismissal_still_records_dismissed(monkeypatch, tmp_path):
    """The default reason is what every pre-existing caller meant, and the
    two paths must stay distinguishable - that is the whole reason the
    field exists."""
    mgr = _manager(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    t = mgr.record_toast("ses_a", "Notification", "look at this")

    assert mgr._toast_inbox.ack("ses_a", t.id, toast_auto_ack.ACK_REASON_DISMISSED) is True
    assert mgr._toast_inbox.get("ses_a")[0].ack_reason == DISMISSED
    # Idempotent, and a replay may not rewrite the reason on a record the
    # user acted on.
    assert mgr._toast_inbox.ack("ses_a", t.id, reason=ANSWERED) is False
    assert mgr._toast_inbox.get("ses_a")[0].ack_reason == DISMISSED


def test_auto_ack_is_scoped_to_its_own_session(monkeypatch, tmp_path):
    """NEGATIVE CONTROL for the whole feature: typing into session A may
    not clear session B's notifications."""
    mgr = _manager(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    _session(mgr, "ses_b", tmp_path / "b")
    a = mgr.record_toast("ses_a", "PermissionRequest", "a's decision")
    b = mgr.record_toast("ses_b", "PermissionRequest", "b's decision")

    assert mgr.auto_ack_toasts("ses_a", "UserPromptSubmit", datetime.utcnow()) == [a.id]
    assert mgr._toast_inbox.get("ses_b")[0].id == b.id
    assert mgr._toast_inbox.get("ses_b")[0].acknowledged is False


def test_history_summary_reports_answered_beside_dismissed(monkeypatch, tmp_path):
    """``answered`` is a SUBSET of ``dismissed``, not a sibling: the older
    count keeps meaning 'no longer open' so a number already on screen
    does not silently change meaning."""
    mgr = _manager(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    clicked = mgr.record_toast("ses_a", "Notification", "clicked away")
    auto = mgr.record_toast("ses_a", "PermissionRequest", "answered in the pane")
    mgr.record_toast("ses_a", "Notification", "still open")
    mgr._toast_inbox.ack("ses_a", clicked.id, toast_auto_ack.ACK_REASON_DISMISSED)
    mgr.auto_ack_toasts("ses_a", "PreToolUse", datetime.utcnow())

    summary = toast_history.summarize(mgr._toast_inbox.get("ses_a"))
    assert summary["total"] == 3
    assert summary["open"] == 1
    assert summary["dismissed"] == 2
    assert summary["answered"] == 1
    assert mgr._toast_inbox.get("ses_a")
    assert any(t.id == auto.id and t.ack_reason == ANSWERED
               for t in mgr._toast_inbox.get("ses_a"))


def test_a_record_acked_without_a_reason_is_not_counted_as_answered():
    """Not having recorded WHICH act cleared a toast is not evidence it
    cleared itself. A pre-existing record carries None and counts only in
    the coarse total."""
    now = datetime.utcnow()
    legacy = Toast(
        id="legacy", session_id="s", kind="Stop", title="Your turn",
        created_at=now, acknowledged=True, ack_reason=None,
    )
    summary = toast_history.summarize([legacy])
    assert summary["dismissed"] == 1
    assert summary["answered"] == 0


# --------------------------------------------------------------------- #
# 4. End to end through the real hook endpoint and the real read route.  #
# --------------------------------------------------------------------- #


def _hook_app(monkeypatch, tmp_path):
    """Description: an app carrying the hook endpoint AND the cross-session
        read route, so a test can post a hook and then measure what a
        browser would actually be served.
    Output: (TestClient, SessionManager).
    """
    mgr = _manager(monkeypatch, tmp_path)
    _session(mgr, "ses_hook", tmp_path / "hook")
    _session(mgr, "ses_other", tmp_path / "other")
    mgr._mint_hook_token("ses_hook")

    app = FastAPI()
    app.state.session_manager = mgr
    app.state.services = build_services(session_manager=mgr)
    app.include_router(routes_mod.router, prefix="/api/v1")
    app.include_router(toast_routes_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return TestClient(app, client=("127.0.0.1", 12345)), mgr


def _post_hook(client, mgr, event: str, payload=None):
    """Description: fire one hook POST as the pane's subprocess would.
    Output: the response.
    """
    return client.post(
        "/api/v1/hooks/claude-event",
        headers={
            "X-Cloudecode-Session": "ses_hook",
            "X-Cloudecode-Token": mgr.get_hook_token("ses_hook"),
            "X-Cloudecode-Event": event,
            "Content-Type": "application/json",
        },
        json=payload or {},
    )


def _open_ids(client):
    """Description: what a browser polling for notifications would be told.
    Output: set[str] of toast ids the server still lists as open.
    """
    return {t["id"] for t in client.get("/api/v1/toasts").json()["toasts"]}


def test_a_prompt_hook_clears_the_sessions_toasts_from_the_read_route(
    monkeypatch, tmp_path
):
    """THE FEATURE, MEASURED WHERE THE USER MEETS IT. Not 'the manager's
    dict changed' - what ``GET /api/v1/toasts`` serves, which is what
    every toast surface in the browser renders from."""
    client, mgr = _hook_app(monkeypatch, tmp_path)
    waiting = mgr.record_toast("ses_hook", "PermissionRequest", "needs your permission")
    notice = mgr.record_toast("ses_hook", "Notification", "wants your attention")
    elsewhere = mgr.record_toast("ses_other", "Notification", "another session")

    before = _open_ids(client)
    assert {waiting.id, notice.id, elsewhere.id} <= before

    with patch.object(
        routes_mod.connection_manager, "broadcast_to_session",
        new=AsyncMock(return_value=None),
    ) as bcast:
        resp = _post_hook(client, mgr, "UserPromptSubmit", {"prompt": "say ok"})
    assert resp.status_code == 200, resp.text

    after = _open_ids(client)
    assert waiting.id not in after
    assert notice.id not in after

    # THE CONTROL. Another session's notification is untouched - typing
    # into one pane says nothing about what another pane is asking for.
    assert elsewhere.id in after

    # An ack frame per real transition, on the same fan-out a click uses,
    # so an attached terminal drops the card without waiting for a poll.
    acked_frames = [c for c in bcast.await_args_list if "toast.ack" in c.args[1]]
    assert len(acked_frames) == 2


def test_a_stop_hook_does_not_eat_the_toast_it_just_raised(monkeypatch, tmp_path):
    """END TO END, and this is the one the pure test cannot fully stand in
    for: here the Stop's toast genuinely exists in the bucket by the time
    anything could clear it."""
    client, mgr = _hook_app(monkeypatch, tmp_path)
    perm = mgr.record_toast("ses_hook", "PermissionRequest", "needs your permission")

    with patch.object(
        routes_mod.connection_manager, "broadcast_to_session",
        new=AsyncMock(return_value=None),
    ):
        resp = _post_hook(client, mgr, "Stop", {})
    assert resp.status_code == 200, resp.text
    raised = resp.json()["toast_id"]

    after = _open_ids(client)
    assert raised in after, "the 'your turn' card a Stop raises must survive it"
    assert perm.id not in after, "the permission it answered must not"


def test_two_stops_in_a_row_leave_one_open_your_turn(monkeypatch, tmp_path):
    """Duplicated delivery, end to end. Supersession keeps one record and
    the auto-ack must not turn the pair into an acked record plus a fresh
    one - which is what would happen if a Stop could ack a Stop."""
    client, mgr = _hook_app(monkeypatch, tmp_path)

    with patch.object(
        routes_mod.connection_manager, "broadcast_to_session",
        new=AsyncMock(return_value=None),
    ):
        first = _post_hook(client, mgr, "Stop", {}).json()["toast_id"]
        second = _post_hook(client, mgr, "Stop", {}).json()["toast_id"]

    assert first == second, "supersession keeps the id the browser is holding"
    open_stops = [t for t in mgr._toast_inbox.get("ses_hook") if not t.acknowledged]
    assert len(open_stops) == 1
    assert all(t.ack_reason is None for t in open_stops)


def test_a_tool_call_clears_a_permission_but_leaves_a_notice(monkeypatch, tmp_path):
    """The narrow rule, end to end, with its control. A tool running is
    proof a permission was granted and proof of nothing else."""
    client, mgr = _hook_app(monkeypatch, tmp_path)
    perm = mgr.record_toast("ses_hook", "PermissionRequest", "needs your permission")
    notice = mgr.record_toast("ses_hook", "Notification", "wants your attention")

    with patch.object(
        routes_mod.connection_manager, "broadcast_to_session",
        new=AsyncMock(return_value=None),
    ):
        assert _post_hook(client, mgr, "PreToolUse", {"tool_name": "Bash"}).status_code == 200

    after = _open_ids(client)
    assert perm.id not in after
    assert notice.id in after


@pytest.mark.parametrize("event", ["UserPromptSubmit", "PreToolUse", "Stop"])
def test_the_flags_behind_the_led_agree_with_the_toasts(monkeypatch, tmp_path, event):
    """THE LED AND THE CARD MUST NOT DISAGREE. ``session_activity`` already
    clears ``permission_open`` and ``notice_open`` on exactly these three
    events; this asserts it rather than trusting the reading, because a
    session showing a 'needs permission' light with no card is the same
    lie as a card with no light, pointing the other way."""
    client, mgr = _hook_app(monkeypatch, tmp_path)
    mgr.record_hook_event("ses_hook", "PermissionRequest", {})
    mgr.record_hook_event("ses_hook", "Notification", {})
    # Read through the PUBLIC resolver rather than the private flags: this
    # is the value the LED is painted from, and asserting the field a
    # layer below would pass even if the resolver stopped reading it.
    assert mgr._activity_tracker.resolve("ses_hook", "running") == "question"

    with patch.object(
        routes_mod.connection_manager, "broadcast_to_session",
        new=AsyncMock(return_value=None),
    ):
        assert _post_hook(client, mgr, event, {}).status_code == 200

    after = mgr._activity_tracker.resolve("ses_hook", "running")
    assert after not in ("question", "notice"), (
        f"{event} cleared the session's toasts, so the light must not still "
        f"say the session is waiting on the user; it read {after!r}"
    )
