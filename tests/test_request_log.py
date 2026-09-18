"""RequestLogMiddleware (src/api/request_log.py).

Hermetic: builds a small standalone FastAPI app (same idiom as
tests/test_agent_wrappers_api.py) rather than importing the whole
src.main app, so nothing here touches a real database or session manager.

structlog's own filtering bound logger (configured in src/main.py, gated
on settings.log_level) is a separate axis from anything this middleware
decides - it is what suppresses DEBUG output in production. This module's
job is only choosing WHICH structlog method to call, so every test here
runs under a permissive filtering level and asserts on the `log_level`
key `structlog.testing.capture_logs` stamps onto each captured entry,
which records the method name (`debug` / `info`) regardless of whether
that level would be suppressed at runtime.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest
import structlog
from fastapi import FastAPI, Request, WebSocket
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.api.request_log import RequestLogMiddleware  # noqa: E402


@pytest.fixture(autouse=True)
def _permissive_structlog_level():
    """Let every level through for the duration of a test, then restore.

    Without this, a debug-level `http_request` call is silently dropped
    by the filtering bound logger before `capture_logs` ever sees it,
    whenever the ambient level (set process-wide, once, by whichever test
    module happened to import src.main first) is INFO or above.
    """
    original = structlog.get_config()["wrapper_class"]
    structlog.configure(wrapper_class=structlog.make_filtering_bound_logger(logging.DEBUG))
    yield
    structlog.configure(wrapper_class=original)


def _build_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(RequestLogMiddleware)

    @app.get("/api/thing")
    async def ok_route(request: Request):
        return {"ok": True}

    @app.get("/boom")
    async def boom_route():
        raise RuntimeError("handler blew up")

    @app.get("/static/app.js")
    async def static_route():
        return {"asset": True}

    @app.websocket("/ws")
    async def ws_route(websocket: WebSocket):
        await websocket.accept()
        text = await websocket.receive_text()
        await websocket.send_text(f"echo:{text}")
        await websocket.close()

    return app


def _client() -> TestClient:
    return TestClient(_build_app())


def _only_http_request_events(logs: list[dict]) -> list[dict]:
    return [e for e in logs if e.get("event") == "http_request"]


def test_successful_request_logs_all_five_fields():
    client = _client()
    with structlog.testing.capture_logs() as logs:
        resp = client.get("/api/thing")
    assert resp.status_code == 200

    events = _only_http_request_events(logs)
    assert len(events) == 1
    entry = events[0]
    assert entry["method"] == "GET"
    assert entry["path"] == "/api/thing"
    assert entry["status"] == 200
    assert entry["client_ip"] == "testclient"
    assert isinstance(entry["duration_ms"], (int, float))
    assert entry["duration_ms"] >= 0
    assert entry["log_level"] == "info"


def test_raised_handler_logs_status_500_and_still_raises():
    client = _client()
    with structlog.testing.capture_logs() as logs:
        with pytest.raises(RuntimeError, match="handler blew up"):
            client.get("/boom")

    events = _only_http_request_events(logs)
    assert len(events) == 1
    assert events[0]["status"] == 500
    assert events[0]["path"] == "/boom"


def test_query_string_never_appears_in_the_logged_path_or_anywhere_else():
    client = _client()
    with structlog.testing.capture_logs() as logs:
        resp = client.get("/api/thing?token=abc123secret")
    assert resp.status_code == 200

    events = _only_http_request_events(logs)
    assert len(events) == 1
    assert events[0]["path"] == "/api/thing"
    assert "?" not in events[0]["path"]

    # Negative control: the secret must not leak into ANY captured event,
    # under any key, on any log line raised during this request.
    serialized = repr(logs)
    assert "abc123secret" not in serialized


def test_websocket_route_is_not_logged_and_still_works():
    client = _client()
    with structlog.testing.capture_logs() as logs:
        with client.websocket_connect("/ws") as ws:
            ws.send_text("hello")
            reply = ws.receive_text()

    assert reply == "echo:hello"
    assert _only_http_request_events(logs) == []


def test_static_path_logs_at_debug_level():
    client = _client()
    with structlog.testing.capture_logs() as logs:
        resp = client.get("/static/app.js")
    assert resp.status_code == 200

    events = _only_http_request_events(logs)
    assert len(events) == 1
    assert events[0]["log_level"] == "debug"


def test_api_path_logs_at_info_level():
    client = _client()
    with structlog.testing.capture_logs() as logs:
        client.get("/api/thing")

    events = _only_http_request_events(logs)
    assert len(events) == 1
    assert events[0]["log_level"] == "info"
