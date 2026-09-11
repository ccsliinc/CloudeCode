"""The authentication endpoints, and the auth-side router assembly.

``/auth/verify`` pairs a TOTP code for an access and a refresh token,
``/auth/refresh`` rotates them, ``/auth/logout`` revokes, ``/auth/qr``
hands back the pairing QR and ``/auth/status`` answers whether the caller
is authenticated at all.

**THIS MODULE ASSEMBLES THE AUTH-SIDE ROUTER, AND src/api/auth.py
DELIBERATELY DOES NOT.** ``auth.py`` is the AUTHORITY: the token mint,
the decoders, the rate limiter and ``require_auth``, which 83 call sites
import. Every route module on this side imports ``require_auth`` FROM
there, so a router living in ``auth.py`` would have to import those
modules back and the cycle would only resolve by ordering the imports at
the bottom of the file. The arrow points one way instead: authority
knows nothing about routes, routes depend on authority, and this module
is where they meet.

The include order below is the order these routes were declared in the
flat 1,674-line ``auth.py``, so the assembled table is unchanged.
"""

import base64
import io
import os
import pyotp
import qrcode
import structlog
import time
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from src.config import settings
from src.models import AuthTokenResponse, SuccessResponse, VerifyTOTPRequest

from src.api import config_routes
from src.api import project_clone_routes
from src.api import projects_routes
from src.api import workspace_settings_routes
from src.api.auth import _get_ttls, _totp_paired_sentinel_path, _totp_rate_limit, _totp_seen_cache, _totp_seen_lock, create_access_token, create_refresh_token, decode_refresh_token, limiter, require_auth

logger = structlog.get_logger()
#: The pairing, refresh, logout and QR routes, which registered FIRST in
#: the flat module.
pairing_router = APIRouter()

#: ``GET /auth/status`` alone, because in the flat module it registered
#: BETWEEN the clone route and the stored command lists. FastAPI matches
#: first-wins, so the assembled table has to keep its position rather
#: than drift to wherever its source now sits.
status_router = APIRouter()

router = APIRouter()

# The include order is the order these routes were declared in the flat
# 1,674-line auth.py, so the assembled table is unchanged, route for
# route and position for position. It is not to be tidied alphabetically.
router.include_router(pairing_router)
router.include_router(projects_routes.router)
router.include_router(project_clone_routes.router)
router.include_router(status_router)
router.include_router(config_routes.router)
router.include_router(workspace_settings_routes.router)


@pairing_router.post("/auth/verify", response_model=AuthTokenResponse)
@limiter.limit(_totp_rate_limit)
async def verify_totp(request: Request, response: Response, body: VerifyTOTPRequest):
    """
    Verify TOTP code and return JWT token.

    Defense layers, outermost first:
      1. slowapi rate limit (5/min;20/hour by default) - caps brute-force
         attempts per client IP. Returns 429 with Retry-After.
      2. Replay dedup (TTLCache keyed on code, 90s TTL) - a single captured
         valid code cannot be replayed within pyotp's ±1-step window.
         Returns 401 with ``reason: code_reused``.
      3. ``pyotp.TOTP.verify`` with valid_window=1 - the actual OTP check.

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
                # client-side UX ("that code was already used - wait for the
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

            # Valid - mark the code as consumed. Even if downstream JWT
            # creation blows up, we still want to ban replay of this code.
            _totp_seen_cache[body.code] = time.monotonic()

        # Item 5: mint access + refresh pair. The access token is short-
        # lived so every stolen token has a narrow window; the refresh
        # token is long-lived but stored server-side with rotation +
        # reuse-detection, so a stolen refresh is detectable.
        access_token, expires_in = create_access_token()
        refresh_token, refresh_jti, refresh_exp = create_refresh_token()

        # Persist the jti IF the app has a refresh store wired up. In
        # production main.py installs this at lifespan startup; unit tests
        # that exercise the TOTP path without a store still work (they just
        # won't be able to call /auth/refresh, which is what they want).
        store = getattr(request.app.state, "refresh_store", None)
        if store is not None:
            try:
                await store.issue(refresh_jti, "claudetunnel_user", refresh_exp)
            except Exception as e:
                logger.error("refresh_store_issue_failed", error=str(e))
                raise HTTPException(
                    status_code=500,
                    detail="Failed to persist refresh token",
                )

        logger.info("totp_verification_success")

        # Fix 4b - mark TOTP as paired. Idempotent: touch() with exist_ok=True
        # is safe if the sentinel already exists (all subsequent verifies).
        # Best-effort: a filesystem hiccup here must NOT fail the auth flow,
        # but we log loudly because a persistently unwritable config dir
        # means /auth/qr will keep serving the secret unguarded.
        try:
            sentinel = _totp_paired_sentinel_path()
            sentinel.parent.mkdir(parents=True, exist_ok=True)
            sentinel.touch(exist_ok=True)
        except Exception as e:
            logger.error("totp_paired_sentinel_write_failed", error=str(e))

        # Populate BOTH `access_token` and the deprecated `token` alias
        # so clients on the old contract (pre-Item-5) keep working for
        # one release. Clients should migrate to `access_token`.
        return AuthTokenResponse(
            success=True,
            access_token=access_token,
            refresh_token=refresh_token,
            token=access_token,  # deprecated alias - remove in v3.2
            expires_in=expires_in,
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


class RefreshTokenRequest(BaseModel):
    """Body for /auth/refresh and /auth/logout."""
    refresh_token: str = Field(..., description="Opaque refresh JWT issued by /auth/verify")


@pairing_router.post("/auth/refresh", response_model=AuthTokenResponse)
@limiter.limit("10/minute")
async def refresh_tokens(request: Request, response: Response, body: RefreshTokenRequest):
    """
    Rotate a refresh token into a new access+refresh pair.

    Security properties:
      * JWT is decoded with ``algorithms=["HS256"]`` and ``typ == "refresh"``
        enforced - no access-token smuggling into this endpoint.
      * The jti must be present in the RefreshStore AND pass ``is_valid``
        (not revoked, not expired, either not superseded OR within the
        grace window).
      * If we detect the jti has already been superseded past the grace
        window, we treat this as a stolen-token event: walk the chain
        via ``superseded_by`` forward from this jti and revoke every
        descendant. Both parties (legitimate user + attacker) must
        re-authenticate via TOTP.
      * Rotation itself is atomic inside ``RefreshStore.rotate``.
      * Rate-limited at 10/minute to cap abusive retry storms - legitimate
        clients refresh roughly once per ~14min (15min access TTL minus a
        safety margin), so 10/min is ample headroom while throttling
        brute-force campaigns hard.
    """
    store = getattr(request.app.state, "refresh_store", None)
    if store is None:
        logger.error("refresh_store_not_available")
        raise HTTPException(
            status_code=503,
            detail="Refresh service not available",
        )

    # 1. Decode + verify signature + typ. decode_refresh_token raises 401.
    claims = decode_refresh_token(body.refresh_token)
    old_jti = claims.get("jti")
    user = claims.get("sub", "claudetunnel_user")
    if not old_jti:
        raise HTTPException(status_code=401, detail="Malformed refresh token")

    _, _, grace = _get_ttls()

    # 2. Confirm the jti is still acceptable (includes grace window).
    if not await store.is_valid(old_jti, grace_seconds=grace):
        # Distinguish "just unknown/revoked" from "already superseded past
        # grace" - the latter is reuse detection and triggers chain
        # revocation as the defensive hammer.
        if await store.is_superseded(old_jti):
            logger.warning("refresh_reuse_detected", jti=old_jti[:8] + "…")
            await store.revoke_chain(old_jti)
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    # 3. Mint the new pair.
    new_access, expires_in = create_access_token(user=user)
    new_refresh, new_jti, new_exp = create_refresh_token(user=user)

    # 4. Atomically rotate. If rotate() returns False here there are two
    #    scenarios:
    #      (a) near-simultaneous refresh from the same client - the row was
    #          JUST superseded while we were minting the new pair. is_valid
    #          above still returned True because we're inside the grace
    #          window. This is benign: the other in-flight request already
    #          got a new pair for this client. We 401 WITHOUT burning the
    #          chain so the client simply retries with its freshly-stored
    #          descendant token.
    #      (b) true reuse-after-grace - is_valid should have caught it at
    #          step 2, so reaching here means something sketchier (clock
    #          skew, race with a purge, etc.). Still safer not to burn the
    #          chain here; the post-grace path at step 2 covers real theft.
    ok = await store.rotate(old_jti, new_jti, user, new_exp)
    if not ok:
        logger.warning(
            "refresh_rotate_lost_race_in_grace", jti=old_jti[:8] + "…"
        )
        raise HTTPException(
            status_code=401,
            detail="Refresh token already rotated; retry with latest token",
        )

    return AuthTokenResponse(
        success=True,
        access_token=new_access,
        refresh_token=new_refresh,
        token=new_access,  # deprecated alias
        expires_in=expires_in,
    )


@pairing_router.post("/auth/logout", response_model=SuccessResponse)
async def logout(request: Request, body: RefreshTokenRequest):
    """
    Revoke a refresh token.

    The access token is left alone - it expires on its own TTL (default
    15m) so a true logout requires either waiting out that window or
    telling the client to drop its access token too (which we do from
    the browser side by clearing localStorage).

    Returns 200 regardless of whether the refresh token was known, to
    avoid an enumeration oracle. We still log the distinction internally.
    """
    store = getattr(request.app.state, "refresh_store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="Refresh service not available")

    # Best-effort decode. If the token is malformed we still return 200
    # (no oracle); internally we log the failure.
    try:
        claims = decode_refresh_token(body.refresh_token)
        jti = claims.get("jti")
        if jti:
            await store.revoke(jti)
    except HTTPException:
        logger.info("logout_with_invalid_refresh")
    except Exception as e:  # pragma: no cover - defensive
        logger.error("logout_error", error=str(e))

    return SuccessResponse(success=True, message="Logged out")


@pairing_router.get("/auth/qr")
async def get_totp_qr():
    """
    Generate QR code for TOTP setup.

    Gated by a ``.totp_paired`` sentinel file (Fix 4b): on first-run the
    endpoint serves the QR freely so the user can pair an authenticator,
    but once ``/auth/verify`` has succeeded at least once it refuses to
    serve the secret again. Any LAN scanner hitting this endpoint after
    pairing would otherwise be able to re-pair their own authenticator.
    Escape hatch: set ``CLOUDE_ALLOW_QR_REPAIR=1`` and restart the server
    to temporarily reopen the endpoint for re-pairing.

    Returns:
        Base64-encoded PNG image of QR code

    Raises:
        HTTPException: 403 if already paired (and re-pair not enabled),
        500 if generation fails.
    """
    # Fix 4b - refuse to serve the secret once pairing is complete,
    # unless the operator has explicitly opened the re-pair window.
    if (
        _totp_paired_sentinel_path().exists()
        and os.getenv("CLOUDE_ALLOW_QR_REPAIR") != "1"
    ):
        logger.warning("qr_endpoint_blocked_already_paired")
        raise HTTPException(
            status_code=403,
            detail=(
                "TOTP already paired; set CLOUDE_ALLOW_QR_REPAIR=1 and "
                "restart to re-pair"
            ),
        )

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


@status_router.get("/auth/status", response_model=SuccessResponse, dependencies=[Depends(require_auth)])
async def check_auth_status():
    """
    Check if user is authenticated (used by frontend to verify token).

    Returns:
        Success response if authenticated

    Raises:
        HTTPException: If not authenticated
    """
    return SuccessResponse(message="Authenticated")
