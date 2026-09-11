"""Configuration management using pydantic-settings.

``src/config.py`` was 2,112 lines holding 13 typed blocks, two module
constants and a 1,426-line ``Settings``. Slice S5 of
``.claude/notes/backend-decomposition-plan.md`` split it into this
package; this module re-exports every public name the flat module had, so
no importer changed in that commit.

Sub-blocks on ``AuthConfig`` mirror the JSON top-level keys 1:1 -
``session``, ``tunnel``, ``auth_rate_limits``, ``notifications``,
``agents``, ``uploads``. Each block is optional in ``config.json``;
a missing key deserializes as defaults so existing installs keep working.

| what you want | where it lives |
|---|---|
| one typed block of config.json | the module named after it |
| the whole document, typed | ``auth.py`` |
| reading config.json into that | ``auth_loader.py`` |
| the env-backed fields, and the two caches | ``settings.py`` |
| where durable state lives | ``state_paths.py`` |
| what shell string launches an agent | ``agent_command.py`` |
| reading and atomically writing config.json | ``config_file.py`` |
| merging a partial settings update | ``config_writes.py`` |
| the settings-screen payload and its masking | ``summary.py`` |
| the wrapper list's persistence | ``wrappers.py`` |
| the provider model list | ``provider_models.py`` |
| building the singleton, or exiting | ``bootstrap.py`` |
"""

from src.config.agents import AgentsConfig, RESERVED_AGENT_TYPES
from src.config.auth import AuthConfig
from src.config.errors import StateDirUnavailableError
from src.config.message_archive import MessageArchiveConfig
from src.config.notifications import NotificationsConfig
from src.config.project import ProjectConfig
from src.config.providers import (
    _DEFAULT_PROVIDER_MODELS,
    _warn_bad_local_host,
    ProvidersConfig,
)
from src.config.rate_limits import AuthRateLimits
from src.config.session import SessionConfig
from src.config.settings import Settings
from src.config.ui import UI_KEY, UIConfig
from src.config.uploads import UploadsConfig
from src.config.workspace import ServerPrefsConfig, WorkspaceConfig
from src.config.bootstrap import build_settings

#: The one process-wide settings object. Constructed at import, because
#: 111 modules do ``from src.config import settings`` and a lazy handle
#: would change every one of them.
settings = build_settings()

__all__ = [
    "AgentsConfig",
    "AuthConfig",
    "AuthRateLimits",
    "MessageArchiveConfig",
    "NotificationsConfig",
    "ProjectConfig",
    "ProvidersConfig",
    "RESERVED_AGENT_TYPES",
    "ServerPrefsConfig",
    "SessionConfig",
    "Settings",
    "StateDirUnavailableError",
    "UI_KEY",
    "UIConfig",
    "UploadsConfig",
    "WorkspaceConfig",
    "build_settings",
    "settings",
]
