"""Punchlist 7 and 8 - toasts raise GLOBALLY and dismiss PER SESSION.

WHAT WAS BROKEN, and it was two filters rather than one, which is why
fixing either alone would have left the bug in place. A toast reached
the browser two ways and both were scoped to the session on screen: the
``toast.new`` WebSocket frame is fanned out only to sockets bound to the
raising session, and ``client/js/terminal.js`` backfills the ATTACHED
session alone via ``GET /sessions/{id}/toasts``. So a session that
needed attention while the user was elsewhere was silent.

THE TWO AXES ARE INDEPENDENT AND THIS SUITE ASSERTS BOTH, because it
would be easy to fix one by breaking the other:

  RAISE  is now GLOBAL. ``GET /toasts`` returns every session's records.
  DISMISS stays PER SESSION. ``POST /toasts/{id}/ack`` takes a
         ``session_id`` and walks THAT session's bucket only.

NEGATIVE CONTROLS ARE MANDATORY HERE. Two of the assertions below would
pass against a broken implementation without them:

  * "the global list contains B's toast" proves nothing unless the
    per-session list for A is also measured NOT containing it - a route
    that returned every toast for every query would satisfy the first
    assertion perfectly while destroying the isolation the ack path
    depends on.
  * "acking works" proves nothing unless acking session B's toast id
    under session A's id is measured to FAIL. A global ack would pass
    every positive test in this file and silently make one user's
    dismissal clear another session's notification.
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
# Mirrors tests/test_toast_lifecycle.py: the pydantic Settings loader
# sys.exit(1)s if these are missing, so they are set BEFORE any src import.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_tcs_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_tcs_logs_"))
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
from src.core import toast_auto_ack
from src.core.composition import build_services

from src.api.auth import require_auth
from src.core import toast_history
from src.core.session_manager import SessionManager
from src.models import Session, SessionStatus, Toast


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


def _app(monkeypatch, tmp_path: Path):
    """Description: a FastAPI app carrying BOTH the existing per-session toast
        routes and the new cross-session ones, so a test can measure the two
        against each other in one client.
    Output: (TestClient, SessionManager).
    """
    mgr = _manager(monkeypatch, tmp_path)
    app = FastAPI()
    app.state.session_manager = mgr
    # The routes read their collaborator off ``app.state.services`` now.
    # ``build_services(session_manager=...)`` WRAPS this manager rather
    # than building a second one, so both entries name one application.
    app.state.services = build_services(session_manager=mgr)
    app.include_router(routes_mod.router, prefix="/api/v1")
    app.include_router(toast_routes_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return TestClient(app), mgr


# --------------------------------------------------------------------- #
# 1. Cross-session VISIBILITY - the raise axis.                          #
# --------------------------------------------------------------------- #


def test_global_list_returns_every_sessions_toasts(monkeypatch, tmp_path):
    """The whole point of item 7: A's browser can see B's notification."""
    client, mgr = _app(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    _session(mgr, "ses_b", tmp_path / "b")
    a = mgr.record_toast("ses_a", "Notification", "from a")
    b = mgr.record_toast("ses_b", "PermissionRequest", "from b")

    resp = client.get("/api/v1/toasts")
    assert resp.status_code == 200, resp.text
    ids = {t["id"] for t in resp.json()["toasts"]}
    assert {a.id, b.id} <= ids, "the global list must carry BOTH sessions"

    # NEGATIVE CONTROL. Without this the assertion above is also satisfied
    # by a server that ignores session scoping everywhere, which would
    # destroy the per-session ack the next section depends on.
    per_session = client.get("/api/v1/sessions/ses_a/toasts").json()
    per_ids = {t["id"] for t in per_session}
    assert a.id in per_ids
    assert b.id not in per_ids, (
        "the per-session route must STILL be scoped - it is what makes a "
        "dismissal per session"
    )


def test_global_list_defaults_to_unacked_and_can_include_acked(monkeypatch, tmp_path):
    """`unacked=true` is the default because this route answers 'what still
    wants attention', not 'what has ever happened'."""
    client, mgr = _app(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    open_toast = mgr.record_toast("ses_a", "PermissionRequest", "still open")
    done = mgr.record_toast("ses_a", "Notification", "already handled")
    assert mgr._toast_inbox.ack("ses_a", done.id, toast_auto_ack.ACK_REASON_DISMISSED) is True

    default_ids = {t["id"] for t in client.get("/api/v1/toasts").json()["toasts"]}
    assert open_toast.id in default_ids
    assert done.id not in default_ids

    all_ids = {
        t["id"] for t in client.get("/api/v1/toasts?unacked=false").json()["toasts"]
    }
    assert {open_toast.id, done.id} <= all_ids


def test_global_list_is_empty_not_an_error_with_no_sessions(monkeypatch, tmp_path):
    """An empty notification list is the correct answer for an idle server.
    A 500 here would take the client's poll loop down for a state that
    resolves itself."""
    client, _ = _app(monkeypatch, tmp_path)
    resp = client.get("/api/v1/toasts")
    assert resp.status_code == 200
    assert resp.json() == {"toasts": [], "total": 0, "unacked_only": True}


# --------------------------------------------------------------------- #
# 2. Per-session DISMISSAL - the axis that must NOT have widened.        #
# --------------------------------------------------------------------- #


def test_ack_is_scoped_to_the_toasts_own_session(monkeypatch, tmp_path):
    """THE LOAD-BEARING NEGATIVE CONTROL. Acking B's toast id while naming
    session A must not dismiss it. A global ack would pass every other
    test in this file."""
    client, mgr = _app(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    _session(mgr, "ses_b", tmp_path / "b")
    b = mgr.record_toast("ses_b", "PermissionRequest", "approve?")

    wrong = client.post(f"/api/v1/toasts/{b.id}/ack?session_id=ses_a")
    # THE STATE IS THE ASSERTION, NOT THE STATUS CODE. The route answers
    # 200 "No-op" for both "not in this session" and "already acked" -
    # it cannot distinguish them without a second walk and the client
    # does not care which it was. What matters is that B's record was
    # NOT touched by a request naming A.
    assert wrong.status_code == 200, wrong.text
    assert wrong.json()["message"] == "No-op"
    assert mgr._toast_inbox.get("ses_b")[0].acknowledged is False, (
        "a toast id that is not in the named session's bucket must not be "
        "acked from it"
    )
    # And it is still on the wire, so the user has not silently lost it.
    assert b.id in {x["id"] for x in client.get("/api/v1/toasts").json()["toasts"]}

    right = client.post(f"/api/v1/toasts/{b.id}/ack?session_id=ses_b")
    assert right.status_code == 200, right.text
    assert mgr._toast_inbox.get("ses_b")[0].acknowledged is True


def test_ack_is_idempotent_and_survives_the_same_click_twice(monkeypatch, tmp_path):
    """Double-clicking dismiss, or two tabs acking in lockstep, is one
    state change and never an error."""
    client, mgr = _app(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    t = mgr.record_toast("ses_a", "Stop", "Your turn")

    first = client.post(f"/api/v1/toasts/{t.id}/ack?session_id=ses_a")
    second = client.post(f"/api/v1/toasts/{t.id}/ack?session_id=ses_a")
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert [x.acknowledged for x in mgr._toast_inbox.get("ses_a")] == [True]


def test_dismissed_toast_does_not_come_back_on_the_next_poll(monkeypatch, tmp_path):
    """Dismiss, then re-fetch the GLOBAL list - the record must be gone.
    This is the server half of the poll-resurrection defect the client's
    ToastDismissedRing covers the other half of."""
    client, mgr = _app(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    t = mgr.record_toast("ses_a", "Notification", "look at me")

    before = {x["id"] for x in client.get("/api/v1/toasts").json()["toasts"]}
    assert t.id in before, "negative control: it must be there BEFORE the ack"

    client.post(f"/api/v1/toasts/{t.id}/ack?session_id=ses_a")
    after = {x["id"] for x in client.get("/api/v1/toasts").json()["toasts"]}
    assert t.id not in after


def test_duplicate_hook_event_yields_one_record_and_one_dismissal(
    monkeypatch, tmp_path
):
    """Hook events are duplicated and droppable (CLAUDE.md), so the same
    `Stop` arriving twice must not produce two cards, and dismissing must
    not leave a twin behind."""
    client, mgr = _app(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    first = mgr.record_toast("ses_a", "Stop", "Your turn", "tail one")
    again = mgr.record_toast("ses_a", "Stop", "Your turn", "tail two")

    # Supersession REPLACES IN PLACE keeping the id, so there is one record.
    assert again.id == first.id
    listed = client.get("/api/v1/toasts").json()["toasts"]
    assert len([x for x in listed if x["session_id"] == "ses_a"]) == 1

    client.post(f"/api/v1/toasts/{first.id}/ack?session_id=ses_a")
    assert client.get("/api/v1/toasts").json()["toasts"] == []


def test_acking_one_session_leaves_another_sessions_toast_alone(
    monkeypatch, tmp_path
):
    """The asymmetry IS the feature: A's card goes on A's dismissal and
    survives B's."""
    client, mgr = _app(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    _session(mgr, "ses_b", tmp_path / "b")
    a = mgr.record_toast("ses_a", "Notification", "a needs you")
    b = mgr.record_toast("ses_b", "Notification", "b needs you")

    client.post(f"/api/v1/toasts/{a.id}/ack?session_id=ses_a")
    remaining = {x["id"] for x in client.get("/api/v1/toasts").json()["toasts"]}
    assert remaining == {b.id}


# --------------------------------------------------------------------- #
# 3. The HISTORY view - punchlist 8.                                     #
# --------------------------------------------------------------------- #


def test_history_returns_dismissed_and_open_newest_first(monkeypatch, tmp_path):
    """The point of a history is finding what you MISSED, so a dismissed
    record must still be listed - with its outcome readable."""
    client, mgr = _app(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    _session(mgr, "ses_b", tmp_path / "b")
    old = mgr.record_toast("ses_a", "Notification", "older")
    new = mgr.record_toast("ses_b", "PermissionRequest", "newer")
    # Force a strict ordering rather than relying on clock resolution.
    old.created_at = datetime.utcnow() - timedelta(minutes=5)
    mgr._toast_inbox.ack("ses_a", old.id, toast_auto_ack.ACK_REASON_DISMISSED)

    body = client.get("/api/v1/toasts/history").json()
    ids = [t["id"] for t in body["toasts"]]
    assert ids == [new.id, old.id], "newest first, across sessions"
    by_id = {t["id"]: t for t in body["toasts"]}
    assert by_id[old.id]["acknowledged"] is True
    assert by_id[new.id]["acknowledged"] is False
    # ``answered`` is a SUBSET of ``dismissed``, not a sibling: the older
    # count still means "no longer open", so the number the history header
    # already showed did not change meaning when the hook-driven auto-ack
    # landed. Nothing here was auto-acked, so it is 0 - and asserting the
    # WHOLE dict is what would catch a future change that quietly
    # redefined ``dismissed`` instead of adding beside it.
    assert body["summary"] == {
        "total": 2,
        "open": 1,
        "dismissed": 1,
        "answered": 0,
        "by_kind": {"PermissionRequest": 1, "Notification": 1},
    }


def test_history_pages_and_reports_the_next_offset(monkeypatch, tmp_path):
    """`next_offset` is None on the last page so a client advances by
    reading a field rather than re-deriving the boundary arithmetic."""
    client, mgr = _app(monkeypatch, tmp_path)
    _session(mgr, "ses_a", tmp_path / "a")
    base = datetime.utcnow()
    made = []
    for i in range(5):
        t = mgr.record_toast("ses_a", "Notification", f"n{i}")
        t.created_at = base - timedelta(seconds=i)
        made.append(t)

    first = client.get("/api/v1/toasts/history?limit=2&offset=0").json()
    assert [t["title"] for t in first["toasts"]] == ["n0", "n1"]
    assert first["total"] == 5
    assert first["next_offset"] == 2

    second = client.get("/api/v1/toasts/history?limit=2&offset=2").json()
    assert [t["title"] for t in second["toasts"]] == ["n2", "n3"]
    assert second["next_offset"] == 4

    last = client.get("/api/v1/toasts/history?limit=2&offset=4").json()
    assert [t["title"] for t in last["toasts"]] == ["n4"]
    assert last["next_offset"] is None, "the last page must say it is the last"


def test_history_names_its_own_retention(monkeypatch, tmp_path):
    """An empty list after a server restart means 'the record was lost',
    not 'nothing ever happened'. The response has to carry that fact or
    the page cannot say it."""
    client, _ = _app(monkeypatch, tmp_path)
    body = client.get("/api/v1/toasts/history").json()
    assert body["storage"] == toast_routes_mod.STORAGE_IN_MEMORY
    assert body["toasts"] == []
    assert body["total"] == 0


def test_history_clamps_a_hostile_limit(monkeypatch, tmp_path):
    """The whole corpus lives in this process's memory; an unbounded page
    would serialise all of it into one body."""
    client, _ = _app(monkeypatch, tmp_path)
    body = client.get("/api/v1/toasts/history?limit=100000").json()
    assert body["limit"] == toast_history.MAX_HISTORY_LIMIT
    zero = client.get("/api/v1/toasts/history?limit=0").json()
    assert zero["limit"] == toast_history.DEFAULT_HISTORY_LIMIT, (
        "a missing or nonsense limit means 'use the default', never "
        "'return nothing' - the second reads as an empty history"
    )
    negative = client.get("/api/v1/toasts/history?offset=-5").json()
    assert negative["offset"] == 0


# --------------------------------------------------------------------- #
# 4. The pure pager, tested without a server.                            #
# --------------------------------------------------------------------- #


def _toast(tid: str, sid: str, at: datetime, acked: bool = False) -> Toast:
    """Description: a Toast with an exact timestamp, for ordering tests."""
    return Toast(
        id=tid, session_id=sid, kind="Notification", title=tid,
        created_at=at, acknowledged=acked,
    )


def test_collect_orders_ties_deterministically():
    """A tie with no tiebreak is how a paged list duplicates one row onto
    two pages and drops another. Same timestamp, three records, one total
    order."""
    at = datetime(2026, 9, 8, 12, 0, 0)
    buckets = {
        "s1": [_toast("a", "s1", at)],
        "s2": [_toast("c", "s2", at), _toast("b", "s2", at)],
    }
    once = [t.id for t in toast_history.collect_toasts(buckets)]
    twice = [t.id for t in toast_history.collect_toasts(buckets)]
    assert once == twice == ["c", "b", "a"]


def test_collect_filters_acked_when_asked():
    at = datetime(2026, 9, 8, 12, 0, 0)
    buckets = {"s1": [_toast("a", "s1", at, acked=True), _toast("b", "s1", at)]}
    assert [t.id for t in toast_history.collect_toasts(buckets, unacked_only=True)] == ["b"]
    assert len(toast_history.collect_toasts(buckets)) == 2


def test_buckets_from_inbox_tolerates_an_unmounted_inbox_and_nothing_else():
    """None is the only thing that renders as 'no toasts'.

    Description: a request arriving before the services are mounted must
      render as 'no toasts', never as a 500 that stops the client's poll
      loop. That much is unchanged.

      **WHAT CHANGED IS THE SECOND LEG, AND IT IS THE POINT OF S1.** The
      old reader answered ``{}`` for ANY object without the attribute, so
      deleting the facade's ``_pending_toasts`` would have emptied every
      toast history view while raising nowhere and failing no test. That
      tolerance is gone: a real object whose container is missing or
      renamed now raises here, at the one call site, loudly.
    """
    assert toast_history.buckets_from_inbox(None) == {}

    with pytest.raises(AttributeError):
        toast_history.buckets_from_inbox(object())


def test_page_reports_total_independently_of_the_slice():
    at = datetime(2026, 9, 8, 12, 0, 0)
    records = [_toast(str(i), "s", at) for i in range(7)]
    items, total, nxt = toast_history.page(records, limit=3, offset=6)
    assert len(items) == 1 and total == 7 and nxt is None
    empty, total2, nxt2 = toast_history.page(records, limit=3, offset=99)
    assert empty == [] and total2 == 7 and nxt2 is None


def test_summarize_counts_the_whole_set():
    at = datetime(2026, 9, 8, 12, 0, 0)
    records = [
        _toast("a", "s", at, acked=True),
        _toast("b", "s", at),
        _toast("c", "s", at),
    ]
    records[2].kind = "Stop"
    assert toast_history.summarize(records) == {
        "total": 3, "open": 2, "dismissed": 1, "answered": 0,
        "by_kind": {"Notification": 2, "Stop": 1},
    }
    assert toast_history.summarize([]) == {
        "total": 0, "open": 0, "dismissed": 0, "answered": 0, "by_kind": {},
    }
