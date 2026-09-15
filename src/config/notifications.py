"""The notifications block.

Carved out of the flat ``src/config.py`` by slice S5. Body byte-exact."""

from typing import List, Optional

from pydantic import BaseModel, Field


class NotificationsConfig(BaseModel):
    """Push notification configuration (Item 6).

    - ``enabled``: master flag. False = the router is wired but every
      ``emit()`` is a no-op. No background traffic, no warnings.
    - ``ntfy_base_url``: the ntfy server. Default is the public
      sh.ntfy.sh; self-hosted users override.
    - ``ntfy_topic``: the secret topic name. EMPTY by default -
      ``setup_auth.py`` generates a 32-hex value on first run. Treat
      as a credential: anyone with the topic name can read your
      notifications.
    - ``public_base_url``: e.g. ``"http://mac.lan:8000"``. When set,
      notifications include a Click deep link back to the session.
      When unset, notifications fire without a Click header.
    - ``idle_threshold_seconds``: RETAINED, READ BY NOBODY. It set the
      seconds of pane silence after which the per-session idle watcher
      fired TASK_COMPLETE, and that watcher was deleted with the hook
      subsystem on 2026-09-13. The field stays so a config.json written
      by an older build round-trips through a downgrade unchanged.
    - ``pushover_token`` / ``pushover_user_key``: Pushover push backend.
      Both are EMPTY by default and both must be set for the channel to
      activate - see ``NotificationRouter.emit``'s ``has_pushover`` gate.
    """
    enabled: bool = False
    ntfy_base_url: str = Field(default="https://ntfy.sh")
    ntfy_topic: str = Field(default="")
    public_base_url: str = Field(default="")
    idle_threshold_seconds: float = Field(default=30.0, ge=1.0)
    # Plan v3.1 Item 8 - rate limiter knobs (single global bucket + per-kind dedup).
    # ``rate_limit_global_cap`` / ``rate_limit_window_seconds``: rolling-window
    # cap on total notifications dispatched (default 10 per 60s). Guards against
    # pattern-match storms.
    # ``rate_limit_per_kind_cooldown_seconds``: minimum seconds between two
    # emits of the same EventType (default 10s). Deduplicates bursts like
    # repeated "Error:" pattern matches in test output.
    rate_limit_global_cap: int = Field(default=10, ge=1)
    rate_limit_window_seconds: float = Field(default=60.0, ge=1.0)
    rate_limit_per_kind_cooldown_seconds: float = Field(default=10.0, ge=0.0)
    # v0.7.0 Part 4 - Slack incoming-webhook fanout. When non-empty, every
    # NotificationEvent dispatched by the router also POSTs a chat message
    # to this webhook URL. Single-channel, no OAuth. Empty default = the
    # Slack channel is silently disabled.
    # Format: ``https://hooks.slack.com/services/T.../B.../...`` - treat
    # as a credential.
    slack_webhook_url: str = Field(default="")
    # Pushover push backend. Both fields are required together - the
    # router's ``has_pushover`` guard treats a partial config (only one
    # of the two set) as unconfigured. Empty defaults = the Pushover
    # channel is silently disabled.
    # ``pushover_token``: the application/API token created at
    # pushover.net/apps/build. Treat as a credential.
    pushover_token: str = Field(default="")
    # ``pushover_user_key``: the user or group key from the Pushover
    # dashboard. Treat as a credential.
    pushover_user_key: str = Field(default="")
