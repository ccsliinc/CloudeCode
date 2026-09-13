"""v0.7.0 — tests for the launchpad rejoin scrollback replay path.

Covers ``GET /api/v1/sessions?session_id=<id>&include_scrollback=1``:

- Without the flag, ``initial_scrollback_b64`` is None on the response
  (existing callers stay wire-identical — defense against regressions
  that would inflate every SessionInfo with capture bytes).
- With the flag, the field is populated with the base64-encoded bytes
  the backend's ``capture_scrollback`` returned.
- Capture failures are caught — the route still returns 200 with the
  field defaulted to None, and a structured warning is emitted.

The route's ``include_scrollback`` query parameter is exercised end-to-
end via a FastAPI ``TestClient`` against the real ``routes_mod.router``.
The session manager is patched at the method level so tests stay off
the real tmux/log-dir spin-up paths used by ``test_session_backend.py``.
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest


# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
# pydantic Settings loader sys.exit(1)s if these are missing. Set safe
# defaults BEFORE any ``src.*`` import.
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_rj_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_rj_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
from fastapi import FastAPI
from fastapi.testclient import TestClient

import src.api.routes as routes_mod
import src.api.session_rejoin_capture as rejoin_capture_mod
from src.api.auth import require_auth
from src.models import Session, SessionInfo, SessionStats, SessionStatus


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _build_session_info(session_id: str = "sess-1") -> SessionInfo:
    """A minimally-stocked SessionInfo for the route to return."""
    sess = Session(
        id=session_id,
        pty_pid=12345,
        working_dir="/tmp/rejoinproj",
        status=SessionStatus.RUNNING,
        tmux_session="rejoinproj",
    )
    return SessionInfo(
        session=sess,
        recent_logs=[],
        local_servers=[],
        stats=SessionStats(),
        session_backend="tmux",
        tmux_session="rejoinproj",
        agent_type=None,
        pinned_theme=None,
    )


def _build_app_with_capture(
    capture_return: bytes | None = b"",
    capture_raises: BaseException | None = None,
):
    """Build a FastAPI app whose SessionManager mock has the methods the
    route touches, plus a mocked ``capture_scrollback``.

    ``capture_return`` — bytes the mock returns from capture_scrollback.
        ``b""`` (default) simulates a no-op backend (e.g. PTYBackend); the
        route must leave ``initial_scrollback_b64`` as None in that case.
    ``capture_raises`` — when non-None, the mock raises this instead of
        returning. The route MUST catch and still return 200 with the
        field defaulted to None.
    """
    sm = MagicMock()
    info = _build_session_info()

    async def fake_get_info(session_id=None):
        return info

    sm.get_session_info = fake_get_info

    if capture_raises is not None:
        def _raise(*a, **kw):
            raise capture_raises
        sm.capture_scrollback = MagicMock(side_effect=_raise)
    else:
        sm.capture_scrollback = MagicMock(return_value=capture_return)

    app = FastAPI()
    app.state.session_manager = sm
    app.include_router(routes_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return app, sm, info


# --------------------------------------------------------------------------- #
# 1. Without the flag — scrollback field stays None.
# --------------------------------------------------------------------------- #


def test_get_session_without_flag_returns_no_scrollback():
    """``GET /sessions`` (no query) MUST NOT populate initial_scrollback_b64
    and MUST NOT even call capture_scrollback (no wasted tmux work for
    every poll)."""
    app, sm, _info = _build_app_with_capture(capture_return=b"should-not-be-used")
    client = TestClient(app)

    resp = client.get("/api/v1/sessions")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body.get("initial_scrollback_b64") is None
    sm.capture_scrollback.assert_not_called()


def test_get_session_with_flag_zero_does_not_populate():
    """include_scrollback=0 is the same as omitted — no capture, no field."""
    app, sm, _info = _build_app_with_capture(capture_return=b"hello")
    client = TestClient(app)

    resp = client.get("/api/v1/sessions?include_scrollback=0")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("initial_scrollback_b64") is None
    sm.capture_scrollback.assert_not_called()


# --------------------------------------------------------------------------- #
# 2. With the flag — captured bytes are surfaced as base64.
# --------------------------------------------------------------------------- #


def test_get_session_with_flag_returns_base64_scrollback():
    """With include_scrollback=1, the field is non-empty and base64-decodes
    back to the exact bytes the backend returned."""
    captured = b"hello\nworld\x1b[31mred\x1b[0m\n"
    app, sm, _info = _build_app_with_capture(capture_return=captured)
    client = TestClient(app)

    resp = client.get("/api/v1/sessions?include_scrollback=1")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    b64 = body.get("initial_scrollback_b64")
    assert isinstance(b64, str) and b64, "expected non-empty base64 string"
    assert base64.b64decode(b64) == captured

    # And it actually went through the manager.
    sm.capture_scrollback.assert_called_once()
    kwargs = sm.capture_scrollback.call_args.kwargs
    assert kwargs.get("session_id") == "sess-1"
    # Lines arg should come from settings.scrollback_lines, an int.
    assert isinstance(kwargs.get("lines"), int)


def test_get_session_with_flag_empty_capture_leaves_field_none():
    """Empty capture (PTYBackend, no live backend) MUST leave the field
    as None — clients distinguish None from empty-string explicitly."""
    app, sm, _info = _build_app_with_capture(capture_return=b"")
    client = TestClient(app)

    resp = client.get("/api/v1/sessions?include_scrollback=1")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body.get("initial_scrollback_b64") is None
    sm.capture_scrollback.assert_called_once()


# --------------------------------------------------------------------------- #
# 3. Capture exceptions are swallowed — 200 OK + None field + warn log.
# --------------------------------------------------------------------------- #


def test_get_session_with_flag_handles_capture_failure_gracefully(monkeypatch):
    """A raising capture_scrollback MUST NOT 500 the request; the route
    logs a warning and returns the SessionInfo with the field as None.

    We monkeypatch the CAPTURE MODULE's ``logger.warning`` - the work
    and its logging moved into ``src.api.session_rejoin_capture`` when it
    went off the event loop - so we don't have to deal with
    structlog's print-logger writing to a captured stream that pytest's
    capfd/capsys/caplog plumbing wraps inconsistently across runs.
    """
    app, sm, _info = _build_app_with_capture(
        capture_raises=RuntimeError("tmux capture-pane failed")
    )

    seen_events: list[tuple[str, dict]] = []

    def fake_warning(event, **kw):
        seen_events.append((event, kw))

    monkeypatch.setattr(rejoin_capture_mod.logger, "warning", fake_warning)

    client = TestClient(app)
    resp = client.get("/api/v1/sessions?include_scrollback=1")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("initial_scrollback_b64") is None
    # And we did try to capture — the mock was reached, then raised.
    sm.capture_scrollback.assert_called_once()

    # The route emitted exactly the expected structured warning.
    events = [e for e, _kw in seen_events]
    assert "rejoin_scrollback_capture_failed" in events, (
        f"expected event 'rejoin_scrollback_capture_failed', got: {events!r}"
    )


# --------------------------------------------------------------------------- #
# 4. Specific session id is forwarded into capture_scrollback.
# --------------------------------------------------------------------------- #


def test_get_session_with_explicit_id_forwards_to_capture():
    """When session_id is in the query, it's the resolved id we capture
    against — guards against a regression that would always capture the
    "current" session regardless of the URL."""
    app, sm, _info = _build_app_with_capture(capture_return=b"x")
    client = TestClient(app)

    resp = client.get(
        "/api/v1/sessions?session_id=sess-1&include_scrollback=1"
    )
    assert resp.status_code == 200, resp.text

    sm.capture_scrollback.assert_called_once()
    kwargs = sm.capture_scrollback.call_args.kwargs
    assert kwargs.get("session_id") == "sess-1"


# --------------------------------------------------------------------------- #
# 5. The tmux work runs OFF the event loop, resize before capture.
# --------------------------------------------------------------------------- #


def _build_app_recording_threads(capture_return: bytes = b"history"):
    """Build the app with mocks that record their thread and their order.

    Both halves matter and they are different claims. THE THREAD is the
    defect this exists for: ``resize_terminal`` and ``capture_scrollback``
    are synchronous tmux calls measured at 20 to 150 ms at the default
    depth, and while they ran on the event loop the server could not read
    a pane, deliver a keystroke or answer another request. THE ORDER is
    the reason they share one offload rather than two: ``capture-pane``
    snapshots at the pane's CURRENT width, so a capture that overtook its
    resize would emit the previous client's geometry - the exact reflow
    artifact the pre-resize exists to remove.

    Args:
        capture_return: bytes the capture mock returns.

    Returns:
        ``(app, sm, seen)`` where ``seen`` is a list of
        ``(call_name, thread_ident)`` in the order the mocks ran, and
        ``seen[0]`` is the LOOP's own thread, recorded by the async
        handler the route awaits first.

    Example:
        app, sm, seen = _build_app_recording_threads()
    """
    sm = MagicMock()
    info = _build_session_info()
    seen: list[tuple[str, int]] = []

    async def fake_get_info(session_id=None):
        # Recorded from inside a coroutine, so this IS the loop thread.
        seen.append(("loop", threading.get_ident()))
        return info

    def fake_resize(*a, **kw):
        seen.append(("resize", threading.get_ident()))

    def fake_capture(*a, **kw):
        seen.append(("capture", threading.get_ident()))
        return capture_return

    sm.get_session_info = fake_get_info
    sm.resize_terminal = MagicMock(side_effect=fake_resize)
    sm.capture_scrollback = MagicMock(side_effect=fake_capture)

    app = FastAPI()
    app.state.session_manager = sm
    app.include_router(routes_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return app, sm, seen


def test_resize_and_capture_run_off_the_event_loop():
    """Neither tmux call may run on the thread serving the request."""
    app, _sm, seen = _build_app_recording_threads()
    client = TestClient(app)

    resp = client.get(
        "/api/v1/sessions?include_scrollback=1&cols=100&rows=40"
    )
    assert resp.status_code == 200, resp.text

    by_name = dict(seen)
    assert "loop" in by_name, "the async handler never ran"
    assert "resize" in by_name and "capture" in by_name, (
        f"a tmux call never happened: {seen!r}"
    )
    assert by_name["resize"] != by_name["loop"], (
        "resize_terminal ran on the event loop thread; a 20-150 ms tmux "
        "call there stalls every live terminal in the process"
    )
    assert by_name["capture"] != by_name["loop"], (
        "capture_scrollback ran on the event loop thread"
    )


def test_resize_happens_before_the_capture():
    """One offload, in order: the capture must read the resized pane."""
    app, _sm, seen = _build_app_recording_threads()
    client = TestClient(app)

    resp = client.get(
        "/api/v1/sessions?include_scrollback=1&cols=100&rows=40"
    )
    assert resp.status_code == 200, resp.text

    order = [name for name, _ident in seen if name != "loop"]
    assert order == ["resize", "capture"], (
        f"expected the resize to land before the capture, got {order!r}"
    )


def test_both_tmux_calls_share_one_thread():
    """They are ONE offload, not two, which is what preserves the order.

    Two separate ``to_thread`` calls could also be written in order and
    would still be two schedulings; asserting they ran on one thread is
    the structural check that they were not split apart later.
    """
    app, _sm, seen = _build_app_recording_threads()
    client = TestClient(app)
    client.get("/api/v1/sessions?include_scrollback=1&cols=100&rows=40")

    idents = {ident for name, ident in seen if name != "loop"}
    assert len(idents) == 1, f"the two tmux calls ran on {len(idents)} threads"


def test_no_cols_and_rows_skips_the_resize_but_still_captures():
    """Without a client grid there is nothing to resize the pane to."""
    app, sm, seen = _build_app_recording_threads()
    client = TestClient(app)

    resp = client.get("/api/v1/sessions?include_scrollback=1")
    assert resp.status_code == 200, resp.text

    sm.resize_terminal.assert_not_called()
    assert [name for name, _i in seen if name != "loop"] == ["capture"]


# --------------------------------------------------------------------------- #
# 6. The cursor rides along with the capture, and never invents itself.
# --------------------------------------------------------------------------- #


def test_capture_carries_the_panes_own_cursor():
    """``capture-pane`` serialises cells and never cursor state.

    Without this the client's cursor lands wherever the last captured
    character was written, which is where the pane's cursor is only by
    coincidence - and on the normal screen, the shipped case, Claude's
    renderer emits pure relative motion and never recovers from it.
    """
    app, sm, _seen = _build_app_recording_threads(capture_return=b"body")
    backend = sm._registry.get_backend.return_value
    backend.pane_cursor_position.return_value = (5, 2)

    resp = TestClient(app).get("/api/v1/sessions?include_scrollback=1")
    assert resp.status_code == 200, resp.text

    raw = base64.b64decode(resp.json()["initial_scrollback_b64"])
    assert raw == b"body\x1b[3;6H", raw


def test_an_unreadable_cursor_appends_nothing():
    """A refusal leaves the client where the text ended, as before.

    THE NEGATIVE CONTROL. An invented ``(0, 0)`` would move every
    rejoined session to the top-left while looking like a working
    feature, so ``None`` must append no bytes at all.
    """
    app, sm, _seen = _build_app_recording_threads(capture_return=b"body")
    sm._registry.get_backend.return_value.pane_cursor_position.return_value = None

    resp = TestClient(app).get("/api/v1/sessions?include_scrollback=1")
    raw = base64.b64decode(resp.json()["initial_scrollback_b64"])
    assert raw == b"body", raw


def test_an_empty_capture_is_still_null_even_with_a_live_cursor():
    """A cursor cannot resurrect an empty capture into a paint of nothing.

    ``b""`` means "nothing was captured" to every caller, and the client
    distinguishes a null field from an empty string explicitly.
    """
    app, sm, _seen = _build_app_recording_threads(capture_return=b"")
    sm._registry.get_backend.return_value.pane_cursor_position.return_value = (1, 1)

    resp = TestClient(app).get("/api/v1/sessions?include_scrollback=1")
    assert resp.status_code == 200, resp.text
    assert resp.json().get("initial_scrollback_b64") is None


def test_a_backend_that_cannot_report_a_cursor_is_not_a_failure():
    """The legacy PTY backend has no ``pane_cursor_position`` at all."""
    app, sm, _seen = _build_app_recording_threads(capture_return=b"body")
    sm._registry.get_backend.return_value = object()

    resp = TestClient(app).get("/api/v1/sessions?include_scrollback=1")
    assert resp.status_code == 200, resp.text
    assert base64.b64decode(resp.json()["initial_scrollback_b64"]) == b"body"
