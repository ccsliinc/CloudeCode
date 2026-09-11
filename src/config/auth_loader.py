"""Read ``config.json`` into one typed :class:`AuthConfig`.

The loader half of ``Settings``, carved out by slice S5 of
``.claude/notes/backend-decomposition-plan.md``. ``Settings`` holds the
env-backed secrets and the cache; this module turns a path plus those two
secrets into the object, and holds no state of its own.

**A MALFORMED BLOCK MUST NOT STOP THE SERVER LOADING ITS CONFIG.** Every
optional block is parsed on its own and falls back to its model's
defaults with a named warning, so one hand-mangled key costs the user
that block and nothing else. Twelve copies of that four-line pattern used
to sit inline; :func:`parse_block` is the one copy now, and the event
name and the log payload travel as arguments because they genuinely
differ - a workspace block's VALUES can be secrets, so only its keys are
logged.

**AND THE FALLBACK DIRECTION IS A DECISION, NOT A DEFAULT.** A mangled
``message_archive`` block yields ``enabled=False``, which is the safe
direction and is what ``message_archive_flag.resolve()`` gates on for the
same input. A mangled ``ui`` block yields the ALL-DEFAULT object, which
SHOWS every control, because an unparseable block must not be able to
hide a capability. Those two point opposite ways on purpose.

**``AuthConfig`` IS ASSEMBLED FIELD BY FIELD, NEVER FROM ``**data``.** A
block absent from that call is silently unreachable no matter what the
model declares, which is how the first cut of the settings GUI wrote a
value to disk that never reached a terminal. Adding a block means adding
it here too.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Type, TypeVar

import structlog
from pydantic import BaseModel

from src.config.agents import AgentsConfig
from src.config.auth import AuthConfig
from src.config.message_archive import MessageArchiveConfig
from src.config.notifications import NotificationsConfig
from src.config.providers import ProvidersConfig
from src.config.rate_limits import AuthRateLimits
from src.config.session import SessionConfig
from src.config.ui import UI_KEY, UIConfig
from src.config.uploads import UploadsConfig
from src.config.workspace import ServerPrefsConfig, WorkspaceConfig
from src.core.message_archive_flag import CONFIG_KEY as MESSAGE_ARCHIVE_KEY
from src.core.terminal_commands import (
    TERMINAL_COMMANDS_KEY,
    TerminalCommand,
    default_terminal_commands,
)
from src.core.workspace_settings import SERVER_PREFS_KEY, WORKSPACE_KEY

logger = structlog.get_logger()

BlockT = TypeVar("BlockT", bound=BaseModel)

#: Defaults for the three token lifetimes, so the numbers live in one
#: place rather than twice in a 40-argument constructor call.
DEFAULT_JWT_EXPIRY_MINUTES = 30
DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 14400
DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 604800
DEFAULT_REFRESH_GRACE_SECONDS = 10


def _raw_payload(raw: Any) -> Dict[str, Any]:
    """Log a rejected block verbatim.

    Inputs: raw (Any) - whatever was under the key.
    Output: dict - structlog kwargs.
    """
    return {"raw": raw}


def _keys_only_payload(raw: Any) -> Dict[str, Any]:
    """Log a rejected block's KEY NAMES and never its values.

    Description: a workspace env value can be a secret, so the whole
      point of this variant is that it cannot echo one into a log line.
    Inputs: raw (Any) - whatever was under the key.
    Output: dict - structlog kwargs.
    """
    return {"keys": sorted(raw.keys()) if isinstance(raw, dict) else None}


def parse_block(
    model: Type[BlockT],
    raw: Any,
    *,
    event: str,
    payload: Callable[[Any], Dict[str, Any]] = _raw_payload,
) -> BlockT:
    """Build one optional config block, or its defaults with a warning.

    Description: the single copy of the malformed-block rule. A block
      that will not validate is logged under ``event`` and replaced by
      the model's own defaults; it never propagates, because one bad key
      must not cost the user every other block in the file.

      The catch is deliberately broad: ``raw`` is arbitrary JSON a human
      hand-edited, and every way pydantic can refuse it - a validation
      error, a wrong scalar type where a mapping was expected, a nested
      model raising on coercion - has the same right answer. It does not
      swallow; it names the block in the log.
    Inputs: model (type[BaseModel]) - the block's model; raw (Any) - the
      value found under the key, already ``or {}``-ed by the caller;
      event (str) - the structlog event name for a rejection; payload
      (Callable) - what to log about ``raw``, defaults to the value
      itself, pass :func:`_keys_only_payload` when a value can be secret.
    Output: an instance of ``model``.
    Example: parse_block(UIConfig, data.get("ui") or {}, event="invalid_ui_config_block")
    """
    try:
        return model(**raw)
    except Exception:  # noqa: BLE001 - see the docstring; the block is named in the log
        logger.warning(event, **payload(raw))
        return model()


def _terminal_commands(raw: Any) -> List[TerminalCommand]:
    """The terminal-command list, or the seed defaults with a warning.

    Description: not a ``BaseModel`` block, so it cannot go through
      :func:`parse_block`: it is a LIST of models, and an EMPTY list
      falls back to the seeds too, so the terminal tab is never empty on
      a config written before the feature existed.
    Inputs: raw (Any) - the value under ``terminal_commands``.
    Output: list[TerminalCommand].
    """
    try:
        return [TerminalCommand(**c) for c in raw] or [
            TerminalCommand(**c) for c in default_terminal_commands()
        ]
    except Exception:  # noqa: BLE001 - same rule as parse_block
        logger.warning("invalid_terminal_commands_block", raw=raw)
        return [TerminalCommand(**c) for c in default_terminal_commands()]


def load(
    config_path: Path, *, totp_secret: Optional[str], jwt_secret: Optional[str]
) -> AuthConfig:
    """Load authentication configuration from JSON plus the .env secrets.

    Description: non-secrets come from the JSON file, the two secrets
      come from the environment through ``Settings``. A legacy
      ``projects`` key is deliberately NOT read - projects live in
      ``cloude.db`` only.
    Inputs: config_path (Path) - the expanded ``config.json`` path;
      totp_secret (str | None) and jwt_secret (str | None) - from .env.
    Output: AuthConfig.
    Raises:
        FileNotFoundError: the file does not exist.
        ValueError: the file is not valid JSON, or a secret is missing.
    Example: load(Path("~/config.json").expanduser(), totp_secret=t, jwt_secret=j)
    """
    if not config_path.exists():
        raise FileNotFoundError(
            f"Auth config file not found: {config_path}\n"
            f"Run ./setup_auth.py to create it."
        )

    try:
        with open(config_path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Invalid JSON in auth config file: {e}\n"
            f"Check {config_path}"
        )

    config_version = data.get("config_version", 0)
    if not isinstance(config_version, int):
        config_version = 0

    auth_config = AuthConfig(
        config_version=config_version,
        totp_secret=totp_secret,   # From .env via Settings
        jwt_secret=jwt_secret,     # From .env via Settings
        jwt_expiry_minutes=data.get(
            "jwt_expiry_minutes", DEFAULT_JWT_EXPIRY_MINUTES
        ),
        # Optional JSON overrides for the token lifetimes. The defaults
        # are sensible for the single-user LAN case; they are exposed so
        # an operator can tune them without editing source.
        access_token_ttl_seconds=int(
            data.get("access_token_ttl_seconds", DEFAULT_ACCESS_TOKEN_TTL_SECONDS)
        ),
        refresh_token_ttl_seconds=int(
            data.get("refresh_token_ttl_seconds", DEFAULT_REFRESH_TOKEN_TTL_SECONDS)
        ),
        refresh_grace_seconds=int(
            data.get("refresh_grace_seconds", DEFAULT_REFRESH_GRACE_SECONDS)
        ),
        template_path=data.get("template_path"),
        common_slash_commands=data.get("common_slash_commands", []),
        session=parse_block(
            SessionConfig, data.get("session", {}) or {},
            event="invalid_session_config_block",
        ),
        auth_rate_limits=parse_block(
            AuthRateLimits, data.get("auth_rate_limits", {}) or {},
            event="invalid_auth_rate_limits_block",
        ),
        notifications=parse_block(
            NotificationsConfig, data.get("notifications", {}) or {},
            event="invalid_notifications_config_block",
        ),
        # Missing block -> defaults, which is backward compatible with
        # every config.json written before the agents feature existed.
        agents=parse_block(
            AgentsConfig, data.get("agents", {}) or {},
            event="invalid_agents_config_block",
        ),
        uploads=parse_block(
            UploadsConfig, data.get("uploads", {}) or {},
            event="invalid_uploads_config_block",
        ),
        providers=parse_block(
            ProvidersConfig, data.get("providers", {}) or {},
            event="invalid_providers_config_block",
        ),
        # The SAFE direction: a mangled block yields enabled=False, which
        # is also what message_archive_flag.resolve() gates on for the
        # same input. The two disagree only in how much they can SAY
        # about it, never in what runs.
        message_archive=parse_block(
            MessageArchiveConfig, data.get(MESSAGE_ARCHIVE_KEY, {}) or {},
            event="invalid_message_archive_config_block",
        ),
        terminal_commands=_terminal_commands(
            data.get(TERMINAL_COMMANDS_KEY) or []
        ),
        # Keys only in the log - a workspace env VALUE can be a secret.
        workspace=parse_block(
            WorkspaceConfig, data.get(WORKSPACE_KEY, {}) or {},
            event="invalid_workspace_config_block",
            payload=_keys_only_payload,
        ),
        server_prefs=parse_block(
            ServerPrefsConfig, data.get(SERVER_PREFS_KEY, {}) or {},
            event="invalid_server_prefs_config_block",
        ),
        # The ALL-DEFAULT object shows every control, because an
        # unparseable block must not be able to HIDE a capability. Note
        # this points the opposite way from message_archive above, and
        # both are deliberate.
        ui=parse_block(
            UIConfig, data.get(UI_KEY, {}) or {},
            event="invalid_ui_config_block",
        ),
    )

    if not auth_config.totp_secret or not auth_config.jwt_secret:
        raise ValueError(
            "Missing authentication secrets in .env file.\n"
            "Required: TOTP_SECRET and JWT_SECRET\n"
            "Run ./setup_auth.py to generate them."
        )

    return auth_config
