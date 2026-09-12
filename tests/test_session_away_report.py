"""Tests for the away report: the facts behind "what happened while you
were away" (punchlist item 1).

Two layers, both here because they are the same claim seen from two
sides: ``src/core/session_away_report.py`` is the pure rule set, and
``src/api/away_routes.py`` is the plumbing that gathers what it needs.

WHAT IS ACTUALLY AT RISK, and why each test is not a tautology:

  * COVERAGE IS NOT A COUNT. An in-memory toast bucket emptied by a
    server restart looks exactly like a session that was quiet. If
    coverage ever collapses into "complete", a wiped record renders as
    "nothing happened", which is this project's most repeated defect
    class pointed at a new field.
  * A REFUSAL IS NOT A FALSE. Three fields are three-valued on purpose.
    An unreadable activity signal must produce None, never False, and an
    unprobeable pane must produce ``unknown``, never ``scrollback``.
  * THE COUNT IS OF RECORDS. ``SessionManager.record_toast`` coalesces an
    unacked Stop in place, so the count is a floor. The kind is named in
    the payload so the client can say "at least"; a test pins that the
    name is actually shipped.
  * A ZONE-LESS ``since`` IS UTC, and a future one is an empty window
    rather than a 400. A phone whose clock runs a few seconds fast is a
    normal client.
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_away_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_away_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.api.away_routes as away_mod
from src.api.auth import require_auth
from src.core.sessions.registry import SessionRegistry
from src.core.session_away_report import (
    COVERAGE_COMPLETE,
    COVERAGE_PARTIAL_RESTART,
    COVERAGE_UNKNOWN,
    HISTORY_SCREEN_ONLY,
    HISTORY_SCROLLBACK,
    HISTORY_UNKNOWN,
    build_report,
    counts_since,
    coverage_for,
    history_mode,
)

NOW = datetime(2026, 9, 8, 12, 0, 0)
SINCE = NOW - timedelta(minutes=30)


def _toast(kind: str, created_at: datetime | None):
    """A toast stand-in carrying only what the counter reads."""
    return SimpleNamespace(kind=kind, created_at=created_at)


# --------------------------------------------------------------------------- #
# 1. Coverage: a wiped record must never read as a quiet session.
# --------------------------------------------------------------------------- #


def test_coverage_is_complete_only_when_the_process_predates_the_window():
    assert coverage_for(SINCE, SINCE - timedelta(seconds=1)) == COVERAGE_COMPLETE
    assert coverage_for(SINCE, SINCE) == COVERAGE_COMPLETE


def test_a_restart_inside_the_window_is_named_and_not_hidden():
    assert (
        coverage_for(SINCE, SINCE + timedelta(minutes=1))
        == COVERAGE_PARTIAL_RESTART
    )


def test_an_unknown_process_start_refuses_rather_than_claiming_complete():
    assert coverage_for(SINCE, None) == COVERAGE_UNKNOWN


# --------------------------------------------------------------------------- #
# 2. History mode: a pane that could not be probed is not a scrolling pane.
# --------------------------------------------------------------------------- #


def test_history_mode_is_three_valued():
    assert history_mode(True) == HISTORY_SCREEN_ONLY
    assert history_mode(False) == HISTORY_SCROLLBACK
    assert history_mode(None) == HISTORY_UNKNOWN


# --------------------------------------------------------------------------- #
# 3. Counting: only records measured inside the window, by kind.
# --------------------------------------------------------------------------- #


def test_counts_are_by_kind_and_bounded_by_the_window():
    toasts = [
        _toast("Stop", NOW - timedelta(minutes=1)),
        _toast("Stop", NOW - timedelta(minutes=2)),
        _toast("PermissionRequest", NOW - timedelta(minutes=3)),
        _toast("Notification", NOW - timedelta(minutes=4)),
        _toast("Stop", SINCE - timedelta(minutes=5)),  # before the window
        _toast("SomethingNew", NOW - timedelta(minutes=1)),
    ]
    counts = counts_since(toasts, SINCE)
    assert counts == {
        "stop": 2,
        "permission_request": 1,
        "notification": 1,
        "other": 1,
    }


def test_an_unreadable_timestamp_is_not_counted():
    """Not having a readable time is not evidence it landed in the window.

    The client renders the stop count as a floor, so inflating it with a
    record nobody could place would make the floor untrue in the one
    direction that matters.
    """
    counts = counts_since([_toast("Stop", None), _toast("Stop", "yesterday")], SINCE)
    assert counts["stop"] == 0


def test_every_count_key_is_always_present():
    assert set(counts_since([], SINCE)) == {
        "stop",
        "permission_request",
        "notification",
        "other",
    }


# --------------------------------------------------------------------------- #
# 4. The assembled report.
# --------------------------------------------------------------------------- #


def test_build_report_names_the_coalesced_kind_so_the_client_can_say_at_least():
    report = build_report(
        session_id="s1",
        since=SINCE,
        now=NOW,
        server_loaded_at=SINCE - timedelta(hours=1),
        toasts=[_toast("Stop", NOW)],
        permission_open=True,
        notice_open=False,
        last_activity_at=NOW - timedelta(minutes=2),
        alternate_screen=True,
        history_bound_lines=3000,
    )
    assert "Stop" in report["coalesced_kinds"], (
        "the client prints a coalesced count as a floor; it can only do that "
        "if the server names which kinds coalesce"
    )
    assert report["counts"]["stop"] == 1
    assert report["coverage"] == COVERAGE_COMPLETE
    assert report["permission_open"] is True
    assert report["notice_open"] is False
    assert report["history"] == {"mode": HISTORY_SCREEN_ONLY, "bound_lines": 3000}
    assert report["last_activity_at"] == (NOW - timedelta(minutes=2)).isoformat()


def test_build_report_keeps_nulls_as_nulls():
    report = build_report(
        session_id="s1",
        since=SINCE,
        now=NOW,
        server_loaded_at=None,
        toasts=[],
        permission_open=None,
        notice_open=None,
        last_activity_at=None,
        alternate_screen=None,
        history_bound_lines=3000,
    )
    assert report["permission_open"] is None
    assert report["notice_open"] is None
    assert report["last_activity_at"] is None
    assert report["coverage"] == COVERAGE_UNKNOWN
    assert report["history"]["mode"] == HISTORY_UNKNOWN


# --------------------------------------------------------------------------- #
# 5. ``since`` parsing.
# --------------------------------------------------------------------------- #


def test_since_accepts_the_javascript_z_suffix_and_lands_on_naive_utc():
    parsed = away_mod.parse_since("2026-09-08T11:30:00Z", NOW)
    assert parsed == SINCE
    assert parsed.tzinfo is None


def test_since_in_the_future_is_clamped_to_now_rather_than_refused():
    assert away_mod.parse_since("2027-01-01T00:00:00Z", NOW) == NOW


def test_since_that_is_not_a_timestamp_raises():
    with pytest.raises(ValueError):
        away_mod.parse_since("last tuesday", NOW)


# --------------------------------------------------------------------------- #
# 6. The tolerant reads: a missing signal is three Nones, not a False.
# --------------------------------------------------------------------------- #


def test_reading_a_signal_off_a_manager_that_has_none_refuses():
    assert away_mod.read_activity_signal(object(), "s1") == (None, None, None)


def test_reading_a_signal_returns_the_later_of_the_two_stamps():
    signal = SimpleNamespace(
        permission_open=True,
        notice_open=False,
        last_tool_event_ts=NOW - timedelta(minutes=9),
        last_stop_ts=NOW - timedelta(minutes=2),
    )
    sm = SimpleNamespace(_activity_tracker=SimpleNamespace(_signals={"s1": signal}))
    assert away_mod.read_activity_signal(sm, "s1") == (
        True,
        False,
        NOW - timedelta(minutes=2),
    )


def test_an_unprobeable_pane_is_unknown_and_never_scrollback():
    empty = SessionRegistry(log_cap=lambda: 1000)
    assert away_mod.read_alternate_screen(empty, "s1") is None
    no_probe = SimpleNamespace(get_backend=lambda sid: object())
    assert away_mod.read_alternate_screen(no_probe, "s1") is None


# --------------------------------------------------------------------------- #
# 7. The route.
# --------------------------------------------------------------------------- #


def _build_app(toasts=None, signal=None, alt_screen=None, session_id="s1"):
    """A FastAPI app carrying a SessionManager stocked for this route."""
    sm = MagicMock()
    sm._toast_inbox.get = MagicMock(return_value=list(toasts or []))
    sm._activity_tracker = SimpleNamespace(
        _signals={session_id: signal} if signal is not None else {}
    )
    backend = SimpleNamespace(pane_in_alternate_screen=lambda: alt_screen)
    registry = SessionRegistry(log_cap=lambda: 1000)
    registry.sessions[session_id] = object()
    if alt_screen is not None:
        registry.backends[session_id] = backend

    app = FastAPI()
    app.state.session_manager = sm
    # The route reads the toast inbox and the live session table off
    # ``app.state.services``, each from the collaborator that owns it.
    app.state.services = SimpleNamespace(
        toasts=sm._toast_inbox, registry=registry
    )
    app.include_router(away_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return app, sm


def test_route_reports_counts_and_flags_for_the_window():
    signal = SimpleNamespace(
        permission_open=True,
        notice_open=False,
        last_tool_event_ts=None,
        last_stop_ts=datetime.utcnow(),
    )
    app, _sm = _build_app(
        toasts=[
            _toast("Stop", datetime.utcnow()),
            _toast("Notification", datetime.utcnow()),
        ],
        signal=signal,
        alt_screen=True,
    )
    client = TestClient(app)
    since = (datetime.utcnow() - timedelta(minutes=10)).isoformat() + "Z"

    resp = client.get(f"/api/v1/sessions/away/summary?session_id=s1&since={since}")

    assert resp.status_code == 200
    body = resp.json()
    assert body["counts"]["stop"] == 1
    assert body["counts"]["notification"] == 1
    assert body["permission_open"] is True
    assert body["history"]["mode"] == HISTORY_SCREEN_ONLY
    assert body["history"]["bound_lines"] > 0


def test_route_404s_on_a_session_it_does_not_have():
    app, _sm = _build_app()
    client = TestClient(app)
    since = datetime.utcnow().isoformat() + "Z"
    resp = client.get(f"/api/v1/sessions/away/summary?session_id=nope&since={since}")
    assert resp.status_code == 404


def test_route_400s_on_an_unparseable_since():
    app, _sm = _build_app()
    client = TestClient(app)
    resp = client.get("/api/v1/sessions/away/summary?session_id=s1&since=nonsense")
    assert resp.status_code == 400


def test_route_reports_a_restart_it_lived_through_as_partial(monkeypatch):
    """The window opened before this process did, so part of it is gone.

    This is the negative control for the whole feature: without it, an
    empty bucket after a restart renders as a quiet session.
    """
    app, _sm = _build_app()
    monkeypatch.setattr(away_mod, "SERVER_LOADED_AT", datetime.utcnow())
    client = TestClient(app)
    since = (datetime.utcnow() - timedelta(hours=2)).isoformat() + "Z"

    body = client.get(
        f"/api/v1/sessions/away/summary?session_id=s1&since={since}"
    ).json()

    assert body["coverage"] == COVERAGE_PARTIAL_RESTART
