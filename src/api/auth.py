"""Authentication endpoints and utilities for TOTP-based auth."""

import jwt
import pyotp
import qrcode
import io
import base64
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Request, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import structlog

from src.config import settings
from src.models import VerifyTOTPRequest, AuthTokenResponse, ProjectResponse, SuccessResponse

logger = structlog.get_logger()

router = APIRouter()
security = HTTPBearer(auto_error=False)


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
async def verify_totp(body: VerifyTOTPRequest):
    """
    Verify TOTP code and return JWT token.

    Args:
        body: Request with TOTP code

    Returns:
        JWT token and expiry time

    Raises:
        HTTPException: If verification fails
    """
    try:
        auth_config = settings.load_auth_config()

        # Create TOTP instance
        totp = pyotp.TOTP(auth_config.totp_secret)

        # Verify code (allows 1 period before and after for clock drift)
        if not totp.verify(body.code, valid_window=1):
            logger.warning("totp_verification_failed", code=body.code[:2] + "****")
            raise HTTPException(
                status_code=401,
                detail="Invalid authentication code"
            )

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
