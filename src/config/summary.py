"""The payload ``GET /api/v1/config/settings`` renders, and its masking.

Carved out of the flat ``src/config.py`` by slice S5 of
``.claude/notes/backend-decomposition-plan.md``.

**THIS IS THE ONLY PLACE THE SECRET-SHAPED NOTIFICATION FIELDS ARE READ
FOR THE SETTINGS SCREEN**, which is what makes the masking impossible for
a call site to forget. :func:`mask_secret` never returns any fragment of
the value - not even the last four characters, because a partial reveal
is still a plain-text leak of real secret material. A boolean is enough
for the UI to say "configured" against "not set" and to offer a
leave-unchanged save.

**THE WORKSPACE BLOCK IS DELIBERATELY NOT MASKED.** A development root, a
shell and an editor are paths, and the env map is the user's own; masking
it would make the screen unable to show what it is about to inject. The
property that matters for the secrets some of those will hold is that
they are never LOGGED, which is enforced where they are logged, not here.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from src.config.agents import AgentsConfig
from src.config.auth import AuthConfig
from src.core.agent_families import build_family_summaries


def mask_secret(value: str) -> Dict[str, bool]:
    """Reduce a secret string to a UI-safe presence flag.

    Description: never returns any fragment of ``value``. See the module
      docstring for why a partial reveal is not an option.
    Inputs: value (str) - the raw secret from config.json, "" if unset.
    Output: dict - ``{"configured": bool}``.
    Example: mask_secret("")  # {'configured': False}
    """
    return {"configured": bool(value)}


def family_summaries(
    agents: AgentsConfig, agent_command: Callable[..., str]
) -> List[dict]:
    """Serialize the family registry with each family's live state.

    Description: thin delegation to
      ``agent_families.build_family_summaries``; the shape and the
      precedence reasoning live there, next to the registry itself. The
      command resolver is PASSED IN rather than imported there, which is
      what keeps the registry free of any dependency on settings.
    Inputs: agents (AgentsConfig) - the loaded agents block;
      agent_command (Callable) - resolves one agent type to its command.
    Output: list[dict] - one entry per family.
    Example: family_summaries(cfg.agents, settings.get_agent_command)
    """
    return build_family_summaries(agents, agent_command)


def settings_summary(
    config: AuthConfig,
    *,
    host: Optional[str],
    port: int,
    effective_claude_command: str,
    families: List[dict],
    bound_host: Optional[str],
) -> Dict[str, Any]:
    """Build the payload for ``GET /api/v1/config/settings``.

    Description: assembles the settings-screen sections from an already
      loaded auth config plus the live server bind address.
      ``effective_claude_command`` is the literal shell string a claude
      launch would produce RIGHT NOW, passed in rather than derived here
      so the UI can show exactly what will run when ``claude_command`` is
      empty without re-deriving that logic client-side.

      ``effective_bind_host`` is the address in force, read from the
      STARTUP RECORD and passed in as ``bound_host``. It used to be the
      CONFIGURED host, which made the screen render "in force: the server
      is on 0.0.0.0" for an install whose only socket was on loopback.
      None is a third state the client renders as such, never substituted
      with the preference.
    Inputs: config (AuthConfig) - the loaded document; host (str | None)
      and port (int) - the configured bind; effective_claude_command
      (str); families (list[dict]) - from :func:`family_summaries`;
      bound_host (str | None) - what actually bound at startup.
    Output: dict with ``agents``, ``notifications``, ``server``,
      ``terminal_commands``, ``workspace``, ``ui`` and ``server_prefs``.
    Example: settings_summary(cfg, host="0.0.0.0", port=8000, ...)
    """
    agents = config.agents
    notif = config.notifications
    wildcard_bind = host in ("0.0.0.0", "", None)
    return {
        "agents": {
            "claude_command": agents.claude_command,
            "codex_command": agents.codex_command,
            "hermes_command": agents.hermes_command,
            "openclaw_command": agents.openclaw_command,
            "effective_claude_command": effective_claude_command,
            # Full wrapper objects, script included - never a secret, see
            # AgentWrapper's docstring - so the settings-panel editor can
            # list, edit and reload them in one round trip.
            "wrappers": [w.model_dump() for w in agents.wrappers],
            # The family registry, serialized so the settings screen can
            # render one group per family WITHOUT hardcoding a family
            # list client-side. Adding a family to AGENT_FAMILIES
            # therefore reaches the UI with no JS edit.
            "families": families,
        },
        "notifications": {
            "enabled": notif.enabled,
            "ntfy_base_url": notif.ntfy_base_url,
            "ntfy_topic": mask_secret(notif.ntfy_topic),
            "slack_webhook_url": mask_secret(notif.slack_webhook_url),
            "pushover_token": mask_secret(notif.pushover_token),
            "pushover_user_key": mask_secret(notif.pushover_user_key),
            "restart_required": True,
        },
        "server": {
            "host": host,
            "port": port,
            "wildcard_bind": wildcard_bind,
            "editable": False,
        },
        # The terminal tab's list, included here so opening settings is
        # one round trip.
        "terminal_commands": [c.model_dump() for c in config.terminal_commands],
        # See the module docstring for why these values are NOT masked.
        "workspace": config.workspace.model_dump(),
        # Client-side surfaces the owner can switch off. Reported here so
        # the settings screen round-trips them, and ALSO on
        # GET /api/v1/features, which is what the client actually gates
        # rendering on: /config/settings is fetched only when the settings
        # screen opens, and a sidebar row has to know before then.
        "ui": config.ui.model_dump(),
        "server_prefs": {
            **config.server_prefs.model_dump(),
            "effective_bind_host": bound_host,
            # THREE outcomes for TLS, and this is the third: not on, not
            # off, but "this build cannot terminate TLS at all", so the
            # stored preference is recorded and not in force.
            "tls_available": False,
            "restart_required": True,
        },
    }
