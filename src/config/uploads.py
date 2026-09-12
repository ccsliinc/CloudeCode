"""The uploads block, governing the browser-paste image upload feature.

Carved out of the flat ``src/config.py`` by slice S5. Body byte-exact."""

from pydantic import BaseModel, Field


class UploadsConfig(BaseModel):
    """Browser-paste image upload configuration.

    - ``enabled``: master switch for the upload endpoint and the periodic
      sweeper task. False = the route still mounts but rejects calls,
      and the sweeper exits its loop immediately on startup.
    - ``ttl_seconds``: files in any session's ``.cloude_uploads/`` bucket
      whose mtime is older than this are pruned by the sweeper. Default
      24h gives the user a full working day to reference an image again
      without it disappearing mid-session.
    - ``sweep_interval_seconds``: how often the background sweeper wakes
      to walk every configured project's ``.cloude_uploads/`` bucket and
      delete TTL-expired files. Default 1h is the safety-net cadence;
      destroy-on-kill and lifespan-startup sweeps cover the common cases.
    - ``max_size_mb``: per-upload size cap for IMAGE uploads. Claude API
      tops out at 30 MB after base64 expansion, so 10 MB raw leaves headroom
      and rejects pathologically large pastes before any disk write.
    - ``max_file_size_mb``: per-upload size cap for NON-IMAGE uploads. A
      separate, larger knob because a pdf, log or zip that Claude reads off
      disk never goes through base64 expansion, so the image ceiling does
      not apply. 50 MB is generous for the documents this is for and still
      bounds what a single request can cost in disk; the existing TTL
      sweeper reclaims it within ``ttl_seconds`` regardless.
    """
    enabled: bool = True
    ttl_seconds: int = Field(default=86400, ge=1)
    sweep_interval_seconds: int = Field(default=3600, ge=1)
    max_size_mb: int = Field(default=10, ge=1)
    max_file_size_mb: int = Field(default=50, ge=1)
