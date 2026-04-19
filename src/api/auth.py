"""Authentication endpoints and utilities for TOTP-based auth."""

import asyncio
import base64
import io
import time
from datetime import datetime, timedelta
from typing import Optional

import jwt
import pyotp
import qrcode
import structlog
from cachetools import TTLCache
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from slowapi import Limiter
from slowapi.util import get_remote_address

from src.config import settings, ProjectConfig
from src.models import VerifyTOTPRequest, AuthTokenResponse, ProjectResponse, CreateProjectRequest, SuccessResponse

logger = structlog.get_logger()

router = APIRouter()
security = HTTPBearer(auto_error=False)


def _rate_limit_key(request: Request) -> str:
    """
    Resolve the client identity used for rate-limit bucketing.

    When ``auth_rate_limits.trust_proxy_headers`` is True we honor the first
    value of ``X-Forwarded-For`` (standard reverse-proxy convention — the
    left-most entry is the original client). When False we fall back to the
    direct peer address via ``get_remote_address``, which defends against
    spoofed XFF headers when the app is reachable directly.

    A misconfigured auth layer (can't load settings) must not bypass the
    limiter — in that case we fall back to the direct peer address rather
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
            # whitespace — some proxies emit ", " separators.
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
# signal clients (and compliant bots) use to back off cleanly — without it
# the 429 is just a wall with no hint when to try again.
limiter = Limiter(key_func=_rate_limit_key, headers_enabled=True)


def _totp_rate_limit() -> str:
    """
    Build the slowapi limit string from config so operators can tune the
    window without editing decorators. Evaluated on every request — the
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


def create_jwt_token(expiry_minutes: Optional[int] = None) -> tuple[str, int]:
    """
    Create a JWT token for authentication.

    Args:
        expiry_minutes: Token expiry time (defaults to config value)

    Returns:
        Tuple of (token, expiry_seconds)
    """
    try:
        auth_config = settings.load_auth_config()
        expiry = expiry_minutes or auth_config.jwt_expiry_minutes

        payload = {
            "exp": datetime.utcnow() + timedelta(minutes=expiry),
            "iat": datetime.utcnow(),
            "sub": "claudetunnel_user"
        }

        token = jwt.encode(payload, auth_config.jwt_secret, algorithm="HS256")
        return token, expiry * 60

    except Exception as e:
        logger.error("jwt_creation_failed", error=str(e))
        raise


def verify_jwt_token(token: str) -> bool:
    """
    Verify a JWT token.

    Args:
        token: JWT token string

    Returns:
        True if valid, False otherwise
    """
    try:
        auth_config = settings.load_auth_config()
        jwt.decode(token, auth_config.jwt_secret, algorithms=["HS256"])
        return True
    except jwt.ExpiredSignatureError:
        logger.debug("token_expired")
        return False
    except jwt.InvalidTokenError as e:
        logger.debug("token_invalid", error=str(e))
        return False
    except Exception as e:
        logger.error("token_verification_error", error=str(e))
        return False


async def require_auth(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> bool:
    """
    Dependency to require authentication for protected routes.

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

    if not verify_jwt_token(credentials.credentials):
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired authentication token",
            headers={"WWW-Authenticate": "Bearer"}
        )

    return True


@router.post("/auth/verify", response_model=AuthTokenResponse)
@limiter.limit(_totp_rate_limit)
async def verify_totp(request: Request, response: Response, body: VerifyTOTPRequest):
    """
    Verify TOTP code and return JWT token.

    Defense layers, outermost first:
      1. slowapi rate limit (5/min;20/hour by default) — caps brute-force
         attempts per client IP. Returns 429 with Retry-After.
      2. Replay dedup (TTLCache keyed on code, 90s TTL) — a single captured
         valid code cannot be replayed within pyotp's ±1-step window.
         Returns 401 with ``reason: code_reused``.
      3. ``pyotp.TOTP.verify`` with valid_window=1 — the actual OTP check.

    Args:
        request: Required by slowapi to extract the rate-limit key.
        response: Required by slowapi to inject X-RateLimit-* and Retry-After
            headers when ``headers_enabled=True`` on the Limiter.
        body: Request with TOTP code.

    Returns:
        JWT token and expiry time.

    Raises:
        HTTPException: If verification fails (401) or config missing (500).
    """
    try:
        auth_config = settings.load_auth_config()

        # Create TOTP instance
        totp = pyotp.TOTP(auth_config.totp_secret)

        # Serialize "have I seen this code? → verify → remember this code"
        # so concurrent submissions can't both slip through on a replay.
        async with _totp_seen_lock:
            if body.code in _totp_seen_cache:
                # The code was already accepted (or at least submitted through
                # this branch) within the TTL window. Reject without re-running
                # the TOTP check. Same 401 shape as invalid code to keep the
                # enumeration signal minimal, but with a distinct reason for
                # client-side UX ("that code was already used — wait for the
                # next 30-second tick").
                logger.warning("totp_code_reused", code=body.code[:2] + "****")
                raise HTTPException(
                    status_code=401,
                    detail={"success": False, "reason": "code_reused"},
                )

            # Verify code (allows 1 period before and after for clock drift)
            if not totp.verify(body.code, valid_window=1):
                logger.warning("totp_verification_failed", code=body.code[:2] + "****")
                raise HTTPException(
                    status_code=401,
                    detail="Invalid authentication code"
                )

            # Valid — mark the code as consumed. Even if downstream JWT
            # creation blows up, we still want to ban replay of this code.
            _totp_seen_cache[body.code] = time.monotonic()

        # Generate JWT token
        token, expiry_seconds = create_jwt_token()

        logger.info("totp_verification_success")

        return AuthTokenResponse(
            token=token,
            expires_in=expiry_seconds
        )

    except FileNotFoundError as e:
        logger.error("auth_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Authentication not configured. Run setup_auth.py first."
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("totp_verification_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Authentication error: {str(e)}"
        )


@router.get("/auth/qr")
async def get_totp_qr():
    """
    Generate QR code for TOTP setup.

    Returns:
        Base64-encoded PNG image of QR code

    Raises:
        HTTPException: If generation fails
    """
    try:
        auth_config = settings.load_auth_config()

        # Create TOTP URI
        totp = pyotp.TOTP(auth_config.totp_secret)
        uri = totp.provisioning_uri(
            name="Cloude Code",
            issuer_name="Cloude Code"
        )

        # Generate QR code
        qr = qrcode.QRCode(version=1, box_size=10, border=5)
        qr.add_data(uri)
        qr.make(fit=True)

        img = qr.make_image(fill_color="black", back_color="white")

        # Convert to base64
        buffer = io.BytesIO()
        img.save(buffer, format="PNG")
        buffer.seek(0)
        img_base64 = base64.b64encode(buffer.getvalue()).decode()

        logger.info("qr_code_generated")

        return {
            "qr_image": f"data:image/png;base64,{img_base64}",
            "secret": auth_config.totp_secret,
            "uri": uri
        }

    except FileNotFoundError as e:
        logger.error("auth_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Authentication not configured. Run setup_auth.py first."
        )
    except Exception as e:
        logger.error("qr_generation_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"QR code generation error: {str(e)}"
        )


@router.get("/projects", response_model=list[ProjectResponse], dependencies=[Depends(require_auth)])
async def get_projects():
    """
    Get list of configured projects.

    Returns:
        List of projects from config

    Raises:
        HTTPException: If config loading fails
    """
    try:
        auth_config = settings.load_auth_config()

        projects = [
            ProjectResponse(
                name=p.name,
                path=p.path,
                description=p.description
            )
            for p in auth_config.projects
        ]

        logger.debug("projects_retrieved", count=len(projects))

        return projects

    except FileNotFoundError as e:
        logger.error("auth_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Configuration not found. Run setup_auth.py first."
        )
    except Exception as e:
        logger.error("projects_retrieval_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve projects: {str(e)}"
        )


@router.post("/projects", response_model=ProjectResponse, status_code=201, dependencies=[Depends(require_auth)])
async def create_project(body: CreateProjectRequest):
    """
    Add a new project to the configuration.

    Args:
        body: Project creation parameters

    Returns:
        Created project object

    Raises:
        HTTPException: If project creation fails
    """
    try:
        # Create ProjectConfig object
        project = ProjectConfig(
            name=body.name,
            path=body.path,
            description=body.description
        )

        # Save to config file
        settings.save_project(project)

        logger.info("project_created", name=project.name, path=project.path)

        return ProjectResponse(
            name=project.name,
            path=project.path,
            description=project.description
        )

    except ValueError as e:
        logger.warning("project_creation_failed_validation", error=str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        logger.error("auth_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Configuration not found. Run setup_auth.py first."
        )
    except Exception as e:
        logger.error("project_creation_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create project: {str(e)}"
        )


@router.delete("/projects/{project_name}", response_model=SuccessResponse, dependencies=[Depends(require_auth)])
async def delete_project(project_name: str):
    """
    Delete a project from the configuration.

    Args:
        project_name: Name of the project to delete

    Returns:
        Success response

    Raises:
        HTTPException: If project deletion fails
    """
    try:
        # Delete from config file
        settings.delete_project(project_name)

        logger.info("project_deleted", name=project_name)

        return SuccessResponse(message=f"Project '{project_name}' deleted successfully")

    except ValueError as e:
        logger.warning("project_deletion_failed_validation", error=str(e))
        raise HTTPException(status_code=404, detail=str(e))
    except FileNotFoundError as e:
        logger.error("auth_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Configuration not found. Run setup_auth.py first."
        )
    except Exception as e:
        logger.error("project_deletion_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete project: {str(e)}"
        )


@router.get("/auth/status", response_model=SuccessResponse, dependencies=[Depends(require_auth)])
async def check_auth_status():
    """
    Check if user is authenticated (used by frontend to verify token).

    Returns:
        Success response if authenticated

    Raises:
        HTTPException: If not authenticated
    """
    return SuccessResponse(message="Authenticated")


@router.get("/config/common-commands", dependencies=[Depends(require_auth)])
async def get_common_commands():
    """
    Get list of common slash commands from config.

    Returns:
        List of common slash commands

    Raises:
        HTTPException: If config loading fails
    """
    try:
        auth_config = settings.load_auth_config()

        # Return common commands if defined, otherwise return default set
        commands = getattr(auth_config, 'common_slash_commands', [
            "/agents",
            "/clear",
            "/compact",
            "/context",
            "/hooks",
            "/mcp",
            "/resume",
            "/rewind",
            "/usage"
        ])

        logger.debug("common_commands_retrieved", count=len(commands))

        return {"commands": commands}

    except FileNotFoundError as e:
        logger.error("auth_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Configuration not found. Run setup_auth.py first."
        )
    except Exception as e:
        logger.error("common_commands_retrieval_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve common commands: {str(e)}"
        )
