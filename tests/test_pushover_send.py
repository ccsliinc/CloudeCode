"""Tests for src.core.notifications.pushover — third backend (mirrors
test_slack_send.py's structure).

Covers:
- init / disabled (incomplete credentials) / send no-op paths
- payload shape (form-encoded token/user/message)
- success vs API-level failure (status != 1) vs HTTP failure (non-200)
- exception swallowing (timeout, request error, generic)
- router fanout gate: has_pushover requires BOTH token and user key

Run with:
    python3 -m pytest tests/test_pushover_send.py -v
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from dataclasses import dataclass
from unittest import mock

import pytest


# ---- env bootstrap (same pattern as the other test modules) ---------------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_pushover_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_pushover_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.notifications import ntfy, pushover, slack
from src.core.notifications.events import EventType, NotificationEvent
from src.core.notifications.router import NotificationRouter


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@dataclass
class _FakeNotificationsConfig:
    """Stand-in for AuthConfig.notifications — only the fields the
    router reads matter. Permissive rate-limit defaults so emits flow."""
    enabled: bool = True
    ntfy_topic: str = ""
    ntfy_base_url: str = "https://ntfy.sh"
    public_base_url: str = "http://lan.local:8000"
    slack_webhook_url: str = ""
    pushover_token: str = "app-token-abc"
    pushover_user_key: str = "user-key-xyz"
    rate_limit_global_cap: int = 10_000
    rate_limit_window_seconds: float = 60.0
    rate_limit_per_kind_cooldown_seconds: float = 0.0


def _make_event(
    kind: EventType = EventType.TASK_COMPLETE,
    slug: str = "test-slug",
    snippet: str = "internal snippet",
) -> NotificationEvent:
    return NotificationEvent(
        kind=kind,
        session_slug=slug,
        timestamp=0.0,
        snippet=snippet,
    )


def _fake_response(status_code: int = 200, json_body: dict | None = None):
    resp = mock.MagicMock()
    resp.status_code = status_code
    resp.json = mock.MagicMock(return_value=json_body if json_body is not None else {"status": 1})
    return resp


@pytest.fixture(autouse=True)
def _reset_pushover_module_state():
    """Each test starts and ends with pushover module state clean."""
    saved = (pushover._client, pushover._token, pushover._user_key)
    pushover._client = None
    pushover._token = ""
    pushover._user_key = ""
    yield
    pushover._client = saved[0]
    pushover._token = saved[1]
    pushover._user_key = saved[2]


@pytest.fixture(autouse=True)
def _reset_ntfy_and_slack_module_state():
    """Mirror the reset fixtures from the other backend test modules so
    the router-fanout test can stand up all three without state bleeding
    across the suite."""
    ntfy_saved = (ntfy._client, ntfy._base_url, ntfy._topic, ntfy._initialized)
    slack_saved = (slack._client, slack._webhook_url)
    ntfy._client = None
    ntfy._base_url = ""
    ntfy._topic = ""
    ntfy._initialized = False
    slack._client = None
    slack._webhook_url = ""
    yield
    ntfy._client, ntfy._base_url, ntfy._topic, ntfy._initialized = ntfy_saved
    slack._client, slack._webhook_url = slack_saved


# ---------------------------------------------------------------------------
# pushover.init — disabled / enabled paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pushover_init_both_empty_disables_channel():
    """init('', '') → no client built."""
    await pushover.init("", "")
    assert pushover._client is None
    assert pushover._token == ""
    assert pushover._user_key == ""


@pytest.mark.asyncio
async def test_pushover_init_token_only_disables_channel():
    """A token with no user key is an incomplete config — disabled."""
    await pushover.init("token-only", "")
    assert pushover._client is None


@pytest.mark.asyncio
async def test_pushover_init_user_key_only_disables_channel():
    """A user key with no token is an incomplete config — disabled."""
    await pushover.init("", "user-only")
    assert pushover._client is None


@pytest.mark.asyncio
async def test_pushover_init_both_set_builds_client():
    """Both token and user key present → client is built."""
    await pushover.init("app-token", "user-key")
    try:
        assert pushover._client is not None
        assert pushover._token == "app-token"
        assert pushover._user_key == "user-key"
    finally:
        await pushover.shutdown()


# ---------------------------------------------------------------------------
# pushover.send — no-op paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pushover_send_no_init_is_noop():
    """Never inited → send returns without raising or doing work."""
    await pushover.send(_make_event())  # must not raise


@pytest.mark.asyncio
async def test_pushover_send_incomplete_credentials_returns_silently():
    """init('', '') → send is a no-op; no httpx call attempted."""
    await pushover.init("", "")
    await pushover.send(_make_event())
    assert pushover._client is None


# ---------------------------------------------------------------------------
# pushover.send — payload shape + success path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pushover_send_posts_correct_url_and_form_fields():
    """init(token, user), send(event) → POST to the messages.json endpoint
    with token/user/message/title in the form body."""
    await pushover.init("app-token-abc", "user-key-xyz")
    try:
        captured = {}

        async def fake_post(url, data=None, **kwargs):
            captured["url"] = url
            captured["data"] = data
            return _fake_response(200, {"status": 1, "request": "req-id"})

        with mock.patch.object(pushover._client, "post", side_effect=fake_post):
            await pushover.send(
                _make_event(EventType.TASK_COMPLETE),
                public_base_url="http://lan.local:8000",
            )

        assert captured["url"] == "https://api.pushover.net/1/messages.json"
        data = captured["data"]
        assert data["token"] == "app-token-abc"
        assert data["user"] == "user-key-xyz"
        assert data["message"]
        assert data["title"]
        assert "url" in data  # deep link populated since public_base_url set
    finally:
        await pushover.shutdown()


@pytest.mark.asyncio
async def test_pushover_send_omits_url_when_no_public_base_url():
    """No public_base_url → no url/url_title params sent."""
    await pushover.init("app-token", "user-key")
    try:
        captured = {}

        async def fake_post(url, data=None, **kwargs):
            captured["data"] = data
            return _fake_response(200, {"status": 1})

        with mock.patch.object(pushover._client, "post", side_effect=fake_post):
            await pushover.send(_make_event(), public_base_url="")

        assert "url" not in captured["data"]
        assert "url_title" not in captured["data"]
    finally:
        await pushover.shutdown()


@pytest.mark.asyncio
async def test_pushover_send_title_message_never_contain_slug():
    """Privacy contract: title/message never carry session_slug."""
    await pushover.init("app-token", "user-key")
    try:
        captured = {}

        async def fake_post(url, data=None, **kwargs):
            captured["data"] = data
            return _fake_response(200, {"status": 1})

        event = _make_event(slug="super-secret-project-slug")
        with mock.patch.object(pushover._client, "post", side_effect=fake_post):
            await pushover.send(event, public_base_url="http://lan:8000")

        assert "super-secret-project-slug" not in captured["data"]["title"]
        assert "super-secret-project-slug" not in captured["data"]["message"]
    finally:
        await pushover.shutdown()


# ---------------------------------------------------------------------------
# pushover.send — failure paths, all swallowed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pushover_send_swallows_non_200():
    """Non-200 HTTP status is logged but never raised."""
    await pushover.init("app-token", "user-key")
    try:
        async def fake_post(url, data=None, **kwargs):
            return _fake_response(500)

        with mock.patch.object(pushover._client, "post", side_effect=fake_post):
            await pushover.send(_make_event())  # must not raise
    finally:
        await pushover.shutdown()


@pytest.mark.asyncio
async def test_pushover_send_swallows_status_not_1():
    """HTTP 200 but JSON status != 1 (e.g. invalid token) is logged, not raised."""
    await pushover.init("bad-token", "user-key")
    try:
        async def fake_post(url, data=None, **kwargs):
            return _fake_response(200, {"status": 0, "errors": ["application token is invalid"]})

        with mock.patch.object(pushover._client, "post", side_effect=fake_post):
            await pushover.send(_make_event())  # must not raise
    finally:
        await pushover.shutdown()


@pytest.mark.asyncio
async def test_pushover_send_swallows_non_json_200():
    """A 200 with a body that isn't JSON is logged, not raised."""
    await pushover.init("app-token", "user-key")
    try:
        async def fake_post(url, data=None, **kwargs):
            resp = mock.MagicMock()
            resp.status_code = 200
            resp.json = mock.MagicMock(side_effect=ValueError("not json"))
            return resp

        with mock.patch.object(pushover._client, "post", side_effect=fake_post):
            await pushover.send(_make_event())  # must not raise
    finally:
        await pushover.shutdown()


@pytest.mark.asyncio
async def test_pushover_send_swallows_timeout():
    """httpx.TimeoutException is caught + logged. No raise."""
    import httpx
    await pushover.init("app-token", "user-key")
    try:
        async def fake_post(url, data=None, **kwargs):
            raise httpx.TimeoutException("simulated timeout")

        with mock.patch.object(pushover._client, "post", side_effect=fake_post):
            await pushover.send(_make_event())
    finally:
        await pushover.shutdown()


@pytest.mark.asyncio
async def test_pushover_send_swallows_connection_error():
    """httpx.ConnectError (RequestError subclass) is caught + logged."""
    import httpx
    await pushover.init("app-token", "user-key")
    try:
        async def fake_post(url, data=None, **kwargs):
            raise httpx.ConnectError("simulated connection refused")

        with mock.patch.object(pushover._client, "post", side_effect=fake_post):
            await pushover.send(_make_event())
    finally:
        await pushover.shutdown()


@pytest.mark.asyncio
async def test_pushover_send_swallows_generic_exception():
    """Any other exception is caught + logged at WARN. No raise."""
    await pushover.init("app-token", "user-key")
    try:
        async def fake_post(url, data=None, **kwargs):
            raise RuntimeError("boom")

        with mock.patch.object(pushover._client, "post", side_effect=fake_post):
            await pushover.send(_make_event())
    finally:
        await pushover.shutdown()


# ---------------------------------------------------------------------------
# pushover — unmapped EventType fallback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pushover_send_unmapped_kind_uses_fallback_presentation():
    """A kind missing from the presentation table still sends a generic
    notification rather than dropping the event."""
    await pushover.init("app-token", "user-key")
    try:
        saved = pushover._EVENT_PRESENTATION.pop(EventType.ERROR, None)
        captured = {}

        async def fake_post(url, data=None, **kwargs):
            captured["data"] = data
            return _fake_response(200, {"status": 1})

        try:
            with mock.patch.object(pushover._client, "post", side_effect=fake_post):
                await pushover.send(_make_event(EventType.ERROR))
            assert captured["data"]["title"] == "Cloude: notification"
        finally:
            if saved is not None:
                pushover._EVENT_PRESENTATION[EventType.ERROR] = saved
    finally:
        await pushover.shutdown()


# ---------------------------------------------------------------------------
# Router fanout gate — has_pushover requires BOTH fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_router_emits_to_pushover_when_fully_configured():
    """ntfy/slack unconfigured, pushover fully configured → emit still
    flows and pushover.send fires."""
    await ntfy.init("https://ntfy.sh", "")
    await slack.init("")
    await pushover.init("app-token", "user-key")
    try:
        cfg = _FakeNotificationsConfig()
        router = NotificationRouter(cfg, asyncio.get_running_loop())
        await router.start()
        try:
            pushover_calls = []

            async def fake_pushover_send(event, public_base_url=None):
                pushover_calls.append(event)

            with mock.patch.object(pushover, "send", side_effect=fake_pushover_send):
                router.emit(_make_event())
                await asyncio.wait_for(router._queue.join(), timeout=2.0)

            assert len(pushover_calls) == 1
        finally:
            await router.stop()
    finally:
        await pushover.shutdown()
        await slack.shutdown()
        await ntfy.shutdown()


@pytest.mark.asyncio
async def test_router_drops_emit_when_pushover_only_token_set():
    """pushover_token set but pushover_user_key empty (and no other
    channel configured) → emit is a no-op — has_pushover requires both."""
    await ntfy.init("https://ntfy.sh", "")
    await slack.init("")
    await pushover.init("", "")  # module itself uninitialized too
    try:
        cfg = _FakeNotificationsConfig(
            pushover_token="token-only",
            pushover_user_key="",
        )
        router = NotificationRouter(cfg, asyncio.get_running_loop())
        await router.start()
        try:
            with mock.patch.object(ntfy, "send") as mock_ntfy, \
                 mock.patch.object(slack, "send") as mock_slack, \
                 mock.patch.object(pushover, "send") as mock_pushover:
                router.emit(_make_event())
                await asyncio.sleep(0.05)
                assert mock_ntfy.call_count == 0
                assert mock_slack.call_count == 0
                assert mock_pushover.call_count == 0
        finally:
            await router.stop()
    finally:
        await pushover.shutdown()
        await slack.shutdown()
        await ntfy.shutdown()


@pytest.mark.asyncio
async def test_router_drops_emit_when_all_three_channels_unconfigured():
    """ntfy_topic, slack_webhook_url, and pushover both fields empty →
    emit is a no-op."""
    await ntfy.init("https://ntfy.sh", "")
    await slack.init("")
    await pushover.init("", "")
    try:
        cfg = _FakeNotificationsConfig(
            ntfy_topic="",
            slack_webhook_url="",
            pushover_token="",
            pushover_user_key="",
        )
        router = NotificationRouter(cfg, asyncio.get_running_loop())
        await router.start()
        try:
            with mock.patch.object(ntfy, "send") as mock_ntfy, \
                 mock.patch.object(slack, "send") as mock_slack, \
                 mock.patch.object(pushover, "send") as mock_pushover:
                router.emit(_make_event())
                await asyncio.sleep(0.05)
                assert mock_ntfy.call_count == 0
                assert mock_slack.call_count == 0
                assert mock_pushover.call_count == 0
        finally:
            await router.stop()
    finally:
        await pushover.shutdown()
        await slack.shutdown()
        await ntfy.shutdown()
