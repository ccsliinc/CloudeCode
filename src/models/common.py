"""Envelope shapes every route may return, plus the health probe."""

from typing import Optional
from pydantic import BaseModel, Field


# API Response Models

class ErrorResponse(BaseModel):
    """Standard error response."""
    error: str = Field(..., description="Error code")
    message: str = Field(..., description="Human-readable error message")
    code: int = Field(..., description="HTTP status code")


class SuccessResponse(BaseModel):
    """Standard success response."""
    success: bool = True
    message: str = ""


class HealthResponse(BaseModel):
    """Health check response for menu bar app."""
    status: str = Field(..., description="Server status (running/stopped)")
    uptime: int = Field(..., description="Server uptime in seconds")
    session_name: Optional[str] = Field(None, description="Current session name/working dir")
    # Number of dev servers currently tracked across all sessions. Replaces
    # the legacy ``tunnel_count`` surface, which was deleted with the
    # Cloudflare tunnel system in plan v3.2. The menu-bar tray reads this
    # field to show "Local servers: N" in its dropdown - true since
    # 2026-08-26; before that the tray was still reading ``tunnel_count``,
    # a field this model does not declare and the response_model therefore
    # filters out, so the row rendered "Tunnels: 0" forever.
    local_server_count: int = Field(0, description="Number of detected local dev servers")
    # The version of the CODE THIS PROCESS IS RUNNING, frozen at startup.
    #
    # Declared here deliberately and not just returned from the endpoint: a
    # FastAPI response_model is a FILTER, not a passthrough. Any field the
    # model does not enumerate is silently DELETED from the response, which
    # this project has already been bitten by twice - a value correct on disk
    # and correct in memory, stripped at serialization, and read downstream as
    # "the server does not have it".
    #
    # The menu-bar app reads this to decide whether the server holding the
    # port is running ITS code before adopting it. Empty string means the
    # version did not resolve, which is CANNOT DETERMINE and must never be
    # treated as a match. See src/core/version.py::freeze_startup_version.
    version: str = Field(
        "", description="Version of the running server code, frozen at startup"
    )
