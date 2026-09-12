"""What shell string actually launches an agent, and how it is quoted.

Carved out of the flat ``src/config.py`` by slice S5 of
``.claude/notes/backend-decomposition-plan.md``. The ladder is byte-exact;
what changed is that the two things it used to reach through ``self`` for
are now CALLABLES, so this module has no opinion about where an agents
block or a scripts directory comes from.

**THE TWO CALLABLES ARE NOT STYLE, THEY PRESERVE LAZINESS.**
``resolve_state_dir`` can RAISE ``StateDirUnavailableError``, and in the
original it was only ever reached inside the wrapper branch; resolving it
eagerly would fail a static-command launch on a box whose state directory
is unwritable, which used to work. ``disable_alternate_screen`` reads the
auth config a SECOND time, deliberately at LAUNCH time rather than at
import, so a user who turns the setting off gets the fullscreen renderer
on the next launch with no server restart. Passing values instead of
callables would quietly change both.

**WHY THE ``~/.zshrc``-SOURCING WRAPPER.** tmux's spawned pane shell does
NOT source ``~/.zshrc`` - it is neither interactive nor a login shell -
so a bare ``cld`` would be "command not found". Verified empirically
against a real detached tmux session on a scratch socket;
``zsh -c 'source ~/.zshrc ...; <cmd>'`` was chosen over ``zsh -ic``.

**QUOTING IS DEFENCE IN DEPTH, NOT THE ONLY GUARD.** The model is
shlex-quoted at every boundary it crosses, verified against ``; rm -rf
/``, backticks, ``$(...)`` and a leading ``~``. ``CreateSessionRequest``
and the provider-add endpoint already restrict model ids before anything
here is called.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, List, Optional

from src.config.agents import AgentsConfig
from src.core.agent_families import (
    render_static_command,
    resolve_agent_type,
    wrappers_for_family,
)
from src.core.agent_wrappers import (
    default_wrapper as _default_wrapper,
    render_wrapper_invocation,
    wrapper_scripts_dir,
)


def claude_cli_path(configured: Optional[str]) -> str:
    """Locate the Claude CLI binary, with auto-detection fallback.

    Description: LEGACY. Nothing on the launch path calls this any more -
      a launch goes through the configured wrappers instead - so
      ``CLAUDE_CLI_PATH`` is a silent no-op as far as sessions are
      concerned. Kept for external callers. Order: the explicit setting,
      then ``which claude``, then ``~/.claude/local/claude``, then the
      bare name on the trust of ``PATH``.
    Inputs: configured (str | None) - the ``CLAUDE_CLI_PATH`` value.
    Output: str - a path, or the bare name ``"claude"``.
    Example: claude_cli_path(None)
    """
    import shutil

    # 1. Check if explicitly set
    if configured:
        return configured

    # 2. Try `which claude`
    claude_in_path = shutil.which("claude")
    if claude_in_path:
        return claude_in_path

    # 3. Check ~/.claude/local/claude
    home_path = Path.home() / ".claude" / "local" / "claude"
    if home_path.exists():
        return str(home_path)

    # 4. Fallback to just "claude" and trust PATH
    return "claude"


def agent_command(
    agent_type: Optional[str],
    *,
    agents: AgentsConfig,
    resolve_state_dir: Callable[[], str],
    disable_alternate_screen: Callable[[], bool],
    model: Optional[str] = None,
    extra_args: Optional[List[str]] = None,
) -> str:
    """Resolve the shell command string that launches one agent type.

    Description: ``codex`` / ``hermes`` / ``openclaw`` / ``shell`` are
      RESERVED and are always their fixed single command. Everything else
      is the claude family and resolves in this order:

        1. ``agent_type`` matches a configured wrapper's ``id`` - launch
           through THAT wrapper. The wrapper id doubles as the agent_type
           value, so which wrapper launched a session is recorded the way
           agent_type always has been, with no second field.
        2. ``"claude"``, empty, or any string that is NOT a wrapper id
           (an unknown type falls back to the family) AND at least one
           wrapper is configured - use that family's DEFAULT wrapper.
        3. No wrappers configured at all - ``agents.<family>_command`` if
           set to a non-empty string.
        4. Neither - the original hardcoded ``cld`` / ``cldor <model>``
           fallback, unchanged from every prior release.

      Steps 3 and 4 are UNREACHABLE the moment any wrapper exists, and
      that is intentional: a wrapper list is a strictly additive, opt-in
      superset of the old two-step fallback, never a partial mix of the
      two for one launch.

      A family that CANNOT launch without a model is REFUSED here rather
      than downgraded. ``cldl`` addresses one model on the LM Studio
      server and has no meaningful default, so a bare launch would open a
      pane that errors or quietly runs something the user did not choose,
      and the session would be recorded as if it had worked. This is the
      single choke point every launch path goes through, create AND
      respawn, so a respawn cannot reintroduce the bare form later.
    Inputs: agent_type (str | None) - a wrapper id, a family name, or
      nothing; agents (AgentsConfig) - the loaded agents block;
      resolve_state_dir (Callable[[], str]) - the state directory, called
      ONLY in the wrapper branch, see the module docstring;
      disable_alternate_screen (Callable[[], bool]) - read at launch
      time, same reason; model (str | None); extra_args (list[str] | None)
      - further arguments to the agent CLI, which is how the FORK path
      passes ``--resume <uuid> --fork-session``.
    Output: str - one shell string, handed straight to tmux's
      ``new-session ... <cmd>``.
    Raises:
        ValueError: the resolved family needs a model and none was given.
    Example: agent_command("claude-chrome", agents=cfg.agents, ...)
    """
    # Disambiguate agent_type into (family, explicitly-named wrapper).
    # ALL of the ordering subtlety lives in resolve_agent_type - read
    # its docstring before changing anything here, especially the
    # reason 'shell' resolves as a family while 'claude' does not.
    family, explicit = resolve_agent_type(agent_type, agents.wrappers)

    if family.needs_model and not (model and str(model).strip()):
        raise ValueError(
            f"the '{family.name}' agent needs a model and none was given; "
            "pick one from the launch modal rather than launching bare"
        )

    # A family's own wrappers, in list order; the default one wins when
    # the caller did not name a specific wrapper. Filtering by family
    # is what makes a codex wrapper unreachable from a claude launch.
    chosen = explicit if explicit is not None else _default_wrapper(
        wrappers_for_family(agents.wrappers, family.name)
    )
    if chosen is not None:
        scripts_dir = wrapper_scripts_dir(resolve_state_dir())
        # A wrapper that does not consume a model id must NEVER be
        # handed one: it forwards "$@" to the CLI, so the model would
        # arrive as a prompt argument and Claude would answer the
        # string "anthropic/claude-opus-4" instead of launching
        # routed. The picker already declines to offer models for
        # such a wrapper (client/js/providers.js); this is the
        # server-side half of the same rule, so a stale client or a
        # hand-rolled API call cannot reintroduce the bug.
        effective_model = model if chosen.accepts_model else None
        # extra_args is NOT gated on accepts_model. That flag is about
        # whether the wrapper consumes an OpenRouter MODEL ID; a fork's
        # --resume/--fork-session are arguments to the agent CLI itself
        # and every wrapper forwards "$@" to it. Gating them would make
        # a fork through a modelless wrapper silently launch a fresh
        # conversation instead of the forked one - a wrong session, with
        # no error.
        return render_wrapper_invocation(
            chosen,
            scripts_dir,
            model=effective_model,
            extra_args=extra_args,
            disable_alternate_screen=disable_alternate_screen(),
        )

    # No wrapper for this family: fall back to its static
    # ``agents.<family>_command`` string, rendered per the family's own
    # rules (every family that launches a user-installed CLI sources
    # ~/.zshrc, because the tmux pane shell reads no rc and a
    # version-managed binary would not be on PATH; claude also has a
    # cld/cldor last resort. Only 'shell' renders raw, because
    # '$SHELL -i' sources the rc itself). See
    # src/core/agent_families.render_static_command.
    # A needs_model family takes its model as a positional ARGUMENT
    # (``cldl <model>``); render_static_command only consults ``model``
    # on the claude last-resort path, so it is passed as an arg here
    # rather than relying on a parameter that this branch ignores.
    static_args = list(extra_args or [])
    if family.needs_model and model:
        static_args = [model] + static_args
    return render_static_command(
        family,
        getattr(agents, family.command_field, "") or "",
        model=model,
        extra_args=static_args,
    )
