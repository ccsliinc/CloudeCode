"""``AuthConfig``, the whole of ``config.json`` as one typed object.

Carved out of the flat ``src/config.py`` by slice S5. Body byte-exact.
Its sub-blocks mirror the JSON top-level keys 1:1 and each one now lives
in its own module beside this one; nothing about the mapping changed."""

from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field

from src.core import auth_defaults
from src.core.terminal_commands import TerminalCommand, default_terminal_commands

from src.config.agents import AgentsConfig
from src.config.message_archive import MessageArchiveConfig
from src.config.notifications import NotificationsConfig
from src.config.providers import ProvidersConfig
from src.config.rate_limits import AuthRateLimits
from src.config.session import SessionConfig
from src.config.ui import UIConfig
from src.config.uploads import UploadsConfig
from src.config.workspace import ServerPrefsConfig, WorkspaceConfig


class AuthConfig(BaseModel):
    """Authentication configuration loaded from JSON and .env."""
    # feat/launch-wrappers - schema/migration marker. Absent from every
    # config.json written before this feature; treated as 0 (see
    # src/core/config_migration.py). Not itself consulted by
    # get_agent_command - purely a migration bookkeeping field.
    config_version: int = auth_defaults.CONFIG_VERSION
    totp_secret: Optional[str] = None  # Populated from Settings (.env)
    jwt_secret: Optional[str] = None   # Populated from Settings (.env)
    jwt_expiry_minutes: int = auth_defaults.JWT_EXPIRY_MINUTES  # Legacy - used only if access TTL unset.
    # Item 5: access/refresh token pair. Access is short-lived (15m default)
    # so a leaked token has a tight blast radius; refresh is long-lived
    # (7d default) but stored server-side with rotation + reuse detection.
    access_token_ttl_seconds: int = auth_defaults.ACCESS_TOKEN_TTL_SECONDS  # 4 hours
    refresh_token_ttl_seconds: int = auth_defaults.REFRESH_TOKEN_TTL_SECONDS  # 7 days
    # Grace window during which a just-rotated refresh token can still be
    # used. Tolerates near-simultaneous requests (client fires two refreshes
    # at once) without tripping reuse-detection.
    refresh_grace_seconds: int = auth_defaults.REFRESH_GRACE_SECONDS
    template_path: Optional[str] = None
    # PROJECTS ARE NOT HERE. They live in cloude.db's ``projects``
    # table and nowhere else. A legacy ``projects`` key in config.json
    # is IGNORED on read - see src/core/projects_config_migration.py,
    # which moves any entry the table has never seen into the table
    # once and then removes the key. Reintroducing this field would
    # recreate the second source of truth whose divergence reporter
    # shipped two contradictory banners.
    # Entries are EITHER a bare command string ("/clear", the historical
    # form, still fully supported) OR an object carrying a user-authored
    # short description ({"command": "/clear", "description": "wipe it"}).
    # Both forms may be mixed in one list. Normalization and the built-in
    # description table live in src/core/slash_command_labels.py; nothing
    # here interprets the entries, so an old config.json loads unchanged.
    common_slash_commands: List[Union[str, Dict[str, Any]]] = []
    session: SessionConfig = Field(default_factory=SessionConfig)
    auth_rate_limits: AuthRateLimits = Field(default_factory=AuthRateLimits)
    notifications: NotificationsConfig = Field(default_factory=NotificationsConfig)
    agents: AgentsConfig = Field(default_factory=AgentsConfig)
    uploads: UploadsConfig = Field(default_factory=UploadsConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    # feat/message-archive-flag - the master switch for the message
    # archive. ADDITIVE and off by default, so a config.json predating it
    # loads unchanged and the subsystem stays absent. See
    # MessageArchiveConfig's docstring for why the authoritative read is
    # src.core.message_archive_flag.resolve() and not this field.
    message_archive: MessageArchiveConfig = Field(
        default_factory=MessageArchiveConfig
    )
    # feat/settings-tabs-and-commands - user-editable common shell
    # commands, each runnable in a console session (see
    # src/core/terminal_commands.py, especially its security model: these
    # are NEVER executed server-side). Top-level, not under ``agents``:
    # they run in a plain shell and have nothing to do with any agent CLI.
    # The default_factory means a config.json with no such key (v0/v1, or
    # hand-trimmed) still presents the seed list rather than an empty tab;
    # the v1->v2 migration additionally persists it so it is editable.
    terminal_commands: List[TerminalCommand] = Field(
        default_factory=lambda: [TerminalCommand(**c) for c in default_terminal_commands()]
    )
    # feat/settings-gui - global workspace preferences and the remembered
    # server bind/TLS choice. Both ADDITIVE top-level keys with
    # all-default sub-models, so a config.json predating them loads
    # unchanged, and (because Settings declares extra="ignore") a config
    # carrying them still loads on an older build. See
    # src/core/workspace_settings.py's docstring for the full
    # downgrade-safety argument and why no config_version bump goes with
    # this.
    workspace: WorkspaceConfig = Field(default_factory=WorkspaceConfig)
    server_prefs: ServerPrefsConfig = Field(default_factory=ServerPrefsConfig)
    # Client-side surfaces the owner can switch off. Same additive,
    # all-default shape as the two above, for the same downgrade-safety
    # reason: a config.json predating it loads unchanged, and one
    # carrying it still loads on an older build because Settings
    # declares extra="ignore".
    ui: UIConfig = Field(default_factory=UIConfig)
