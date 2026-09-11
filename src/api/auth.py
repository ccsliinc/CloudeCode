"""The authentication AUTHORITY: tokens, the rate limiter, require_auth.

This module used to be 1,674 lines and carried the auth endpoints, the
launcher projects, the clone flow, the stored command lists and the whole
workspace settings write. Decomposition slice S6 moved every route out to
a sibling and left the credential machinery here.

**IT DECLARES NO ROUTER, AND THAT IS THE POINT.** 83 call sites import
``require_auth`` from here, which means every route module on this side
depends on this one. A router living here would have to import those
modules back, and the cycle would only resolve by ordering imports at the
bottom of the file - which works, and hides a dependency arrow pointing
the wrong way. The auth-side router is assembled in
``src/api/auth_routes.py`` instead: authority knows nothing about routes.

What remains: the TOTP rate limiter and its replay cache, the access and
refresh token mint and decoders, and ``require_auth`` itself.

``_totp_seen_cache`` is a SHARED OBJECT, not a copy. ``auth_routes`` binds
the same dict, and the suite clears it through this module's name; both
see every mutation because there is exactly one of it.
"""

import asyncio
import base64
import io
import os
import secrets
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import jwt
import pyotp
import qrcode
import structlog
from cachetools import TTLCache
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address

from src.config import settings, ProjectConfig
from src.api import projects_service
from src.models import (
    VerifyTOTPRequest,
    AuthTokenResponse,
    ProjectResponse,
    CreateProjectRequest,
    UpdateProjectRequest,
    CloneProjectRequest,
    SuccessResponse,
    ConfigSettingsUpdateRequest,
    ToggleFavoriteCommandRequest,
)
from src.core.workspace_settings import (
    WorkspaceValidationError,
    validate_bind_host,
    validate_development_root,
    validate_editor,
    validate_env_map,
    validate_shell,
)
from src.core.slash_command_discovery import build_command_groups, command_groups_to_dict
from src.core import slash_command_labels, slash_favorites
def _totp_paired_sentinel_path() -> Path:
    """
    Path to the TOTP-pairing sentinel file.

    Anchored to the same directory as ``config.json`` so it follows the
    user's actual config location (``~/.config/cloudecode/`` when launched
    from the Electron bundle, ``./`` in dev) instead of inventing a new
    convention. The sentinel is a marker only - its presence (not contents)
    signals that TOTP has been paired at least once, gating ``/auth/qr``
    from re-serving the secret.
    """
    return Path(settings.auth_config_file).expanduser().parent / ".totp_paired"

logger = structlog.get_logger()

security = HTTPBearer(auto_error=False)


def _rate_limit_key(request: Request) -> str:
    """
    Resolve the client identity used for rate-limit bucketing.

    When ``auth_rate_limits.trust_proxy_headers`` is True we honor the first
    value of ``X-Forwarded-For`` (standard reverse-proxy convention - the
    left-most entry is the original client). When False we fall back to the
    direct peer address via ``get_remote_address``, which defends against
    spoofed XFF headers when the app is reachable directly.

    A misconfigured auth layer (can't load settings) must not bypass the
    limiter - in that case we fall back to the direct peer address rather
    than raising, which would otherwise 500 every auth request.
    """
    try:
        trust_proxy = settings.load_auth_config().auth_rate_limits.trust_proxy_headers
    except Exception:
        trust_proxy = False

    if trust_proxy:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            # Take the leftmost (original client) IP. Strip surrounding
            # whitespace - some proxies emit ", " separators.
            first = xff.split(",")[0].strip()
            if first:
                return first
    return get_remote_address(request)


# Module-level Limiter. Wired into the FastAPI app in src/main.py via
# `app.state.limiter = limiter` + SlowAPIMiddleware + RateLimitExceeded
# handler. Default storage is memory:// which is fine for the single-process
# MVP; swap to Redis if we ever run multiple workers.
#
# headers_enabled=True makes slowapi inject X-RateLimit-Limit/Remaining/Reset
# AND the canonical Retry-After header on 429 responses. Retry-After is the
# signal clients (and compliant bots) use to back off cleanly - without it
# the 429 is just a wall with no hint when to try again.
limiter = Limiter(key_func=_rate_limit_key, headers_enabled=True)


def _totp_rate_limit() -> str:
    """
    Build the slowapi limit string from config so operators can tune the
    window without editing decorators. Evaluated on every request - the
    config is cached inside ``Settings``, so this is a dict lookup.

    slowapi accepts semicolon-separated limits where ALL must hold. A
    sensible default pair is "5/minute;20/hour":
      - the minute bucket kills brute-force bursts,
      - the hour bucket caps sustained hammering across 12 windows.
    """
    try:
        cfg = settings.load_auth_config().auth_rate_limits
        return f"{cfg.totp_verify_per_minute}/minute;{cfg.totp_verify_per_hour}/hour"
    except Exception:
        # Fail safe to tight defaults if config is temporarily unreadable.
        return "5/minute;20/hour"


# --- TOTP replay / reuse dedup cache -----------------------------------------
#
# RFC 6238 TOTP codes are valid for their 30-second step, and we verify with
# valid_window=1 (±1 step). That means a single captured code is accepted for
# up to 90 seconds from the attacker's perspective. slowapi blocks brute force
# of NEW codes, but does nothing against REPLAY of a single captured valid
# code under the attacker's count budget.
#
# We plug that hole with an in-process TTL cache keyed on the submitted code.
# TTL of 90s covers the full ±1-window pyotp accepts plus a small buffer; once
# an entry expires, that code is outside pyotp's window anyway and cannot
# reverify. maxsize=1000 absorbs very high submission rates without unbounded
# growth (slowapi caps real rate anyway).
#
# cachetools.TTLCache is NOT thread-safe for mixed reads/writes, and the
# verify handler is async. We serialize check-then-insert under an asyncio
# Lock so two concurrent submissions of the same freshly-valid code can't
# both succeed (TOCTOU on replay dedup).
#
# Threat model note: single-user system, so keying only on the code is safe.
# In multi-tenant systems this would need to be (user_id, code).
_TOTP_REPLAY_TTL = 90  # seconds; ±1 window of 30s + 30s buffer
_totp_seen_cache: TTLCache = TTLCache(maxsize=1000, ttl=_TOTP_REPLAY_TTL)
_totp_seen_lock = asyncio.Lock()


def _get_ttls() -> tuple[int, int, int]:
    """Pull (access_ttl, refresh_ttl, grace) from AuthConfig with defaults."""
    auth_config = settings.load_auth_config()
    access_ttl = int(getattr(auth_config, "access_token_ttl_seconds", 14400))
    refresh_ttl = int(getattr(auth_config, "refresh_token_ttl_seconds", 604800))
    grace = int(getattr(auth_config, "refresh_grace_seconds", 10))
    return access_ttl, refresh_ttl, grace


def create_access_token(user: str = "claudetunnel_user") -> tuple[str, int]:
    """Mint a short-lived access token (``typ: "access"``).

    Returns (jwt, ttl_seconds). The caller hands ``ttl_seconds`` back to the
    client as ``expires_in`` so they can schedule refresh just before expiry.
    """
    auth_config = settings.load_auth_config()
    access_ttl, _, _ = _get_ttls()
    now = datetime.utcnow()
    payload = {
        "exp": now + timedelta(seconds=access_ttl),
        "iat": now,
        "sub": user,
        "typ": "access",
    }
    token = jwt.encode(payload, auth_config.jwt_secret, algorithm="HS256")
    return token, access_ttl


def create_refresh_token(
    user: str = "claudetunnel_user",
) -> tuple[str, str, int]:
    """Mint a long-lived refresh token.

    Returns:
        (jwt, jti, exp_unix_ts). The jti is random (32 url-safe bytes) so
        even if the JWT secret is known an attacker still can't forge a
        jti that matches a persisted row. Caller persists (jti, user, exp)
        into the RefreshStore.
    """
    auth_config = settings.load_auth_config()
    _, refresh_ttl, _ = _get_ttls()
    jti = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    exp_dt = now + timedelta(seconds=refresh_ttl)
    payload = {
        "exp": exp_dt,
        "iat": now,
        "sub": user,
        "typ": "refresh",
        "jti": jti,
    }
    token = jwt.encode(payload, auth_config.jwt_secret, algorithm="HS256")
    # jwt.encode stores exp as int(utc_timestamp) internally; mirror that
    # for the store so comparisons stay aligned.
    return token, jti, int(exp_dt.timestamp())


# --- Legacy shims (to be removed in v3.2) ------------------------------------
#
# Old callers (and existing tests) imported ``create_jwt_token`` /
# ``verify_jwt_token``. Keep both as thin wrappers so we don't have to
# refactor the world in one PR. New code should use create_access_token /
# decode_access_token directly.


def create_jwt_token(expiry_minutes: Optional[int] = None) -> tuple[str, int]:
    """Legacy - delegates to ``create_access_token``.

    The ``expiry_minutes`` arg is ignored (access TTL now comes from config).
    Preserved only so pre-Item-5 call sites keep compiling.
    """
    token, ttl_seconds = create_access_token()
    return token, ttl_seconds


def verify_jwt_token(token: str) -> bool:
    """Legacy - prefer ``decode_access_token``.

    Returns True if the token is a valid access token. Unlike
    ``decode_access_token`` this swallows all errors and returns a bool so
    existing call sites (WS subprotocol path, integration smoke) don't
    need to be refactored in the same PR.
    """
    try:
        decode_access_token(token)
        return True
    except HTTPException:
        return False
    except Exception as e:  # pragma: no cover - defensive
        logger.error("token_verification_error", error=str(e))
        return False


def _decode_with_typ(token: str, expected_typ: str) -> dict:
    """Shared JWT decode helper.

    Why a private helper:
      - Keeps the ``algorithms=["HS256"]`` guard in one place so a future
        refactor can't accidentally drop it (RFC 8725 §3.1 - the #1
        JWT footgun).
      - Centralizes the ``typ`` enforcement so an access token can't be
        used as a refresh token and vice versa (token-substitution attack).
      - Translates pyjwt exceptions to HTTPException(401) once, rather
        than in every endpoint.
    """
    try:
        auth_config = settings.load_auth_config()
    except Exception as e:
        logger.error("auth_config_load_failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Authentication not configured.",
        )

    try:
        # EXPLICIT algorithms list - do NOT remove. Passing algorithms=None
        # (or omitting the arg) allows "alg": "none" tokens, which is a
        # well-known JWT bypass (RFC 8725 §3.2). Also pins to HS256 so a
        # future key rotation to RS256 is an intentional, reviewed change.
        claims = jwt.decode(
            token,
            auth_config.jwt_secret,
            algorithms=["HS256"],
        )
    except jwt.ExpiredSignatureError:
        logger.debug("token_expired", typ=expected_typ)
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        logger.debug("token_invalid", error=str(e), typ=expected_typ)
        raise HTTPException(status_code=401, detail="Invalid token")

    if claims.get("typ") != expected_typ:
        logger.warning(
            "token_wrong_typ",
            got=claims.get("typ"),
            expected=expected_typ,
        )
        raise HTTPException(status_code=401, detail="Invalid token type")

    return claims


def decode_access_token(token: str) -> dict:
    """Decode + verify an access token. Raises HTTPException(401) on failure."""
    return _decode_with_typ(token, "access")


def decode_refresh_token(token: str) -> dict:
    """Decode + verify a refresh token. Raises HTTPException(401) on failure."""
    return _decode_with_typ(token, "refresh")


async def require_auth(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> bool:
    """
    Dependency to require authentication for protected routes.

    Enforces ``typ == "access"`` so a refresh token (or any other typed
    token) cannot be smuggled into a Bearer Authorization header.

    Args:
        credentials: Bearer token from Authorization header

    Raises:
        HTTPException: If authentication fails

    Returns:
        True if authenticated
    """
    if not credentials:
        raise HTTPException(
            status_code=401,
            detail="Authentication required. Please log in with your TOTP code.",
            headers={"WWW-Authenticate": "Bearer"}
        )

    # decode_access_token raises 401 with a terse detail on any failure.
    # We re-raise via a wrapper so we can attach the WWW-Authenticate
    # header that RFC 6750 §3 expects on Bearer 401s.
    try:
        decode_access_token(credentials.credentials)
    except HTTPException as e:
        raise HTTPException(
            status_code=401,
            detail=e.detail if isinstance(e.detail, str) else "Invalid or expired authentication token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return True
