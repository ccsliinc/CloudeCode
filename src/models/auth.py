"""Authentication: the TOTP challenge and the token that answers it."""

from typing import Optional
from pydantic import BaseModel, Field


class VerifyTOTPRequest(BaseModel):
    """Request model for TOTP code verification."""
    code: str = Field(..., description="6-digit TOTP code", min_length=6, max_length=6)


class AuthTokenResponse(BaseModel):
    """Response with JWT authentication token pair.

    Item 5: the endpoint now returns BOTH an access token (short-lived,
    ~15 min) and a refresh token (long-lived, ~7d) so the client can
    silently rotate access tokens without prompting for TOTP.

    ``token`` is a deprecated alias for ``access_token`` - populated for
    one release (v3.1) so pre-Item-5 clients keep working, and will be
    removed in v3.2. New clients should read ``access_token``.
    """
    success: bool = True
    access_token: Optional[str] = Field(
        None, description="Short-lived JWT access token (~15 min)"
    )
    refresh_token: Optional[str] = Field(
        None, description="Long-lived JWT refresh token (~7 days)"
    )
    expires_in: Optional[int] = Field(
        None, description="Seconds until access token expires"
    )
    # DEPRECATED: alias for access_token - remove in v3.2.
    token: Optional[str] = Field(
        None,
        description="Deprecated alias for access_token (will be removed in v3.2)",
    )
