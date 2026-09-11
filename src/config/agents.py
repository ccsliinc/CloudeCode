"""The agents block, and the family names a wrapper may never take.

Carved out of the flat ``src/config.py`` by slice S5. Bodies byte-exact."""

from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from src.core.agent_families import RESERVED_FAMILY_NAMES
from src.core.agent_wrappers import AgentWrapper


class AgentsConfig(BaseModel):
    """Per-agent shell command strings used to launch each agent CLI.

    Phase 6 - agent-type labeling. Each command is a single shell-string
    that the tmux backend passes verbatim as ``new-session ... <command>``;
    tmux itself parses the string as a shell command (no shlex.split on
    our side - see ``TmuxBackend.start`` and the existing claude path
    which builds the exact same shape: ``f"{claude_cli} --flag"``).

    Defaults match the corrected CLI invocations:
      - claude:   ``claude --dangerously-skip-permissions``
      - codex:    ``codex``
      - hermes:   ``hermes``        (NOT ``hermes-agent``)
      - openclaw: ``openclaw tui``  (NOT bare ``openclaw``)
    """
    # Optional override for ``agent_type == "claude"``, consulted by
    # ``Settings.get_agent_command()`` BEFORE the built-in ``cld`` / ``cldor``
    # zsh-function fallback (see get_agent_command's docstring for the full
    # precedence). Empty string (the default) means "not configured" - the
    # command falls back to ``cld`` / ``cldor``, which is what the author's
    # own ``~/.zshrc``-based setup relies on and must keep working with zero
    # config change. Set this to a plain CLI invocation (e.g.
    # ``"claude --dangerously-skip-permissions"``, see config.example.json)
    # to run Claude Code directly on machines that don't have ``cld`` /
    # ``cldor`` defined.
    claude_command: str = ""
    codex_command: str = "codex"
    # LM Studio via the cldl wrapper. The SERVER ADDRESS is not in this
    # string: it is injected as CLDL_HOST into the tmux spawn environment
    # (src/core/session_manager.py::get_env_for_spawn) rather than
    # interpolated into shell text, which removes the quoting question
    # entirely instead of answering it carefully.
    local_command: str = "cldl"
    hermes_command: str = "hermes"
    openclaw_command: str = "openclaw tui"
    # Plain interactive shell - no agent CLI. Used by the "New console"
    # FAB action so users can spawn a bare tmux session in ~/ for quick
    # shell work. ``$SHELL -i`` ensures rc files (.zshrc/.bashrc) load.
    shell_command: str = "$SHELL -i"
    # feat/launch-wrappers - user-defined named launch wrappers for the
    # "claude" agent family (see src/core/agent_wrappers.py). Empty list
    # (the default) means "not configured" - get_agent_command falls
    # through to claude_command, then the hardcoded cld/cldor fallback,
    # EXACTLY as before this feature existed. A wrapper's own ``id`` can
    # also be passed as ``agent_type`` on session create to launch through
    # that specific wrapper (see get_agent_command's docstring).
    wrappers: List[AgentWrapper] = Field(default_factory=list)


# Agent-type values resolved as a bare FAMILY name and never looked up as
# a wrapper id, so a wrapper can never shadow one. Derived from the family
# registry (src/core/agent_families.py) rather than restated here, so the
# two can no longer drift; membership is unchanged from when this was a
# literal frozenset (codex, hermes, openclaw, shell - deliberately NOT
# claude, see resolve_agent_type's docstring). Re-exported under the old
# name because it is the established import for this concept.
# Module-level (not a class attribute) because Settings is a pydantic
# BaseSettings and an underscore-prefixed class attribute there becomes a
# ModelPrivateAttr descriptor, not a plain frozenset - see
# Settings.get_agent_command / Settings.add_wrapper for the two call sites.
RESERVED_AGENT_TYPES = RESERVED_FAMILY_NAMES
