"""The authentication rate-limit knobs.

Carved out of the flat ``src/config.py`` by slice S5. Body byte-exact."""

from pydantic import BaseModel, Field


class AuthRateLimits(BaseModel):
    """Rate-limit knobs for authentication endpoints.

    - ``totp_verify_per_minute`` / ``totp_verify_per_hour``: dual-window
      limits applied to the TOTP verify endpoint. Both must be satisfied;
      the per-minute bucket stops rapid brute-force bursts, the per-hour
      bucket caps sustained hammering.
    - ``trust_proxy_headers``: when True, the rate-limit key comes from the
      first value of ``X-Forwarded-For``; otherwise the direct peer
      ``request.client.host`` is used. MUST stay False when the app is
      reachable directly (LAN bind). Flip to True only when terminating
      TLS behind a trusted reverse proxy (Cloudflare tunnel, nginx, ALB).
    """
    totp_verify_per_minute: int = Field(default=5, ge=1)
    totp_verify_per_hour: int = Field(default=20, ge=1)
    trust_proxy_headers: bool = False
