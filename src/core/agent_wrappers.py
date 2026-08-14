"""User-defined launch wrappers for the "claude" agent family.

feat/launch-wrappers — replaces the hardcoded ``cld`` / ``cldor`` zsh
functions in ``Settings.get_agent_command()`` with a user-editable list of
named wrappers stored in ``config.json`` (``agents.wrappers``). A wrapper's
``script`` is arbitrary multi-line shell text — anything from a single
command (``"claude --dangerously-skip-permissions"``) up to a full function
definition copy-pasted verbatim, including the author's real ``cld``:

    cld() (
        local claude_token
        claude_token="$(security find-generic-password ...)" || { ... }
        export CLAUDE_CODE_OAUTH_TOKEN="$claude_token"
        ...
        command claude --dangerously-skip-permissions "$@"
    )

Representation choice: ``script`` is stored as a single JSON string with
embedded ``\\n`` (not an array of lines). Every other multi-line-shaped
value already in this codebase (``AgentsConfig.*_command``,
``ProvidersConfig.models`` entries) is a plain string, and a script written
via the settings-panel textarea round-trips through ``json.dump(..., indent=2)``
with zero extra logic. An array-of-lines shape would read slightly better
in a hand-edited config.json but forces a join/split step at every read and
write site for a benefit that only matters if someone is hand-editing
30-line shell functions directly in JSON — the UI textarea is the intended
editing surface, and it preserves whitespace/indentation exactly either way.

Execution model (see ``render_wrapper_invocation``):
  1. The script's exact bytes are written to a stable per-wrapper file
     (never embedded into a shell-quoted string — sidesteps every quoting
     hazard a pasted function might contain: single quotes, ``$(...)``,
     ``||`` blocks, nested double quotes).
  2. That file is ``source``-d from inside the same ``zsh -c`` wrapper the
     legacy ``claude_command`` / ``cld`` path already uses (so ``~/.zshrc``
     is loaded first — same reason a bare ``cld`` would otherwise be
     "command not found" under tmux's non-interactive pane shell).
  3. If the script is a bare runnable command/one-liner (``entry`` unset),
     sourcing it is enough — this is the migrated-``claude_command`` case
     and the thin ``cld "$@"`` / ``cldor "$@"`` migration-seeded wrappers
     (see ``src/core/config_migration.py``), which merely invoke the
     function the user's own ``~/.zshrc`` already defines.
  4. If the script instead *defines* a function (``entry`` set to that
     function's name, e.g. ``"cld"``), it's invoked explicitly after the
     source step: ``source <file> "$@"; <entry> "$@"``.
  ``model`` (the OpenRouter model id, when set) is forwarded as the OUTER
  zsh -c's own positional parameter ``$1`` (``zsh -c '<script>' _ <model>``),
  which both the ``source <file> "$@"`` step and the ``<entry> "$@"`` step
  re-forward unchanged — exactly mirroring how the real ``cldor`` consumes
  ``$1`` as its model argument and forwards the rest via ``"$@"``. This
  requires no placeholder syntax inside the script at all.
  The ``( ... )`` subshell form the author's real functions use is
  preserved verbatim in the sourced file, so env exports/unsets inside a
  wrapper (``CLAUDE_CODE_OAUTH_TOKEN``, ``ANTHROPIC_BASE_URL``, ...) never
  leak into the ``zsh -c`` shell that invoked it — sourcing only *defines*
  the function; the subshell isolation happens when it's *called*.
"""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator

# Filesystem-safe, stable identifier: used both as the wrapper's dict key
# and as the on-disk script filename (``<id>.zsh``). Lowercase start avoids
# any ambiguity with shell option-like leading characters.
WRAPPER_ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,63}$"
_WRAPPER_ID_RE = re.compile(WRAPPER_ID_PATTERN)


def is_valid_wrapper_id(v: str) -> bool:
    """Single source of truth for wrapper-id validation.

    Inputs: v (str) - candidate wrapper id.
    Output: bool - True if v matches WRAPPER_ID_PATTERN exactly.
    """
    return bool(_WRAPPER_ID_RE.fullmatch(v))


class AgentWrapper(BaseModel):
    """One user-defined launch wrapper for the "claude" agent family.

    - ``id``: stable identifier. Doubles as the ``agent_type`` value a
      caller passes to launch through this specific wrapper (see
      ``Settings.get_agent_command``) and as the on-disk script filename.
    - ``label``: human-readable name shown in the UI.
    - ``script``: the full shell source — a plain command, or a complete
      function definition. Never validated for shell syntax (arbitrary
      user shell, same trust level as the pre-existing ``claude_command``
      field); written verbatim to disk, never interpolated into a quoted
      string.
    - ``entry``: function name to invoke after sourcing ``script``. Unset
      (None/empty) means ``script`` is directly runnable on its own — the
      common case for a migrated single command or a thin
      ``cld "$@"``-style forwarder to a function the user's own
      ``~/.zshrc`` defines. Set it when ``script`` is a function
      definition that needs an explicit call, e.g. ``entry="cld"`` for a
      pasted ``cld() ( ... )`` body.
    - ``description``: optional free-text note shown in the editor.
    - ``default``: at most one wrapper should carry this; the resolver
      falls back to the first wrapper in list order if none (or more than
      one, from a hand-edited config.json) is marked default.

    SECURITY: there is deliberately no "secret" field. A wrapper is a
    shell command — secrets must never be pasted into ``script`` or
    ``description``. The correct pattern, which the author's own ``cld``
    demonstrates, is to read from the macOS Keychain at *run time* inside
    the script (``security find-generic-password ...``), so no credential
    ever passes through this app or lands in config.json.
    """

    id: str = Field(..., description="Stable id; also the on-disk script filename and the agent_type value")
    label: str = Field(..., description="Human-readable name shown in the UI")
    script: str = Field(..., description="Full shell source: a command or a function definition")
    entry: Optional[str] = Field(
        None,
        description="Function name to call after sourcing script; unset = script is directly runnable",
    )
    description: Optional[str] = Field(None, description="Optional free-text note")
    default: bool = Field(False, description="Preferred wrapper when none is explicitly selected")

    @field_validator("id")
    @classmethod
    def _validate_id(cls, v: str) -> str:
        if not is_valid_wrapper_id(v):
            raise ValueError(f"wrapper id must match {WRAPPER_ID_PATTERN}")
        return v

    @field_validator("script")
    @classmethod
    def _validate_script_nonblank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("wrapper script must not be blank")
        return v


def find_wrapper(wrappers: List[AgentWrapper], wrapper_id: str) -> Optional[AgentWrapper]:
    """Look up a wrapper by id.

    Inputs: wrappers (list[AgentWrapper]); wrapper_id (str).
    Output: AgentWrapper | None.
    """
    for w in wrappers:
        if w.id == wrapper_id:
            return w
    return None


def default_wrapper(wrappers: List[AgentWrapper]) -> Optional[AgentWrapper]:
    """Resolve the preferred wrapper when none is explicitly selected.

    Description: the wrapper with ``default=True`` wins; if none (or, from
      a hand-edited config.json, more than one) is marked default, the
      first wrapper in list order is used. Empty list -> None.
    Inputs: wrappers (list[AgentWrapper]).
    Output: AgentWrapper | None.
    Example: default_wrapper([w_claude, w_cld]) -> w_claude (if
      w_claude.default is True).
    """
    if not wrappers:
        return None
    for w in wrappers:
        if w.default:
            return w
    return wrappers[0]


def wrapper_scripts_dir(log_directory: str) -> Path:
    """Directory the resolved wrapper script files live in.

    Description: co-located under the app's own log directory (already a
      writable, per-install path — see ``Settings.get_log_dir``) rather
      than a shared /tmp, so two installs never collide and cleanup is
      implicit (small text files, never grow, never need sweeping).
    Inputs: log_directory (str) - Settings.log_directory (pre-expansion OK).
    Output: Path - directory (not guaranteed to exist yet).
    """
    return Path(log_directory).expanduser() / "agent_wrapper_scripts"


def _write_script_file(wrapper: AgentWrapper, scripts_dir: Path) -> Path:
    """Write ``wrapper.script`` verbatim to its stable on-disk path.

    Description: rewritten on every resolution call (cheap — a few KB at
      most) so an edited-but-not-yet-restarted config always sources the
      current script text. Bytes are written EXACTLY as stored — no
      escaping, no line-ending normalization — so a round trip through
      config.json -> disk is byte-for-byte faithful to what the user
      pasted, indentation included.
    Inputs: wrapper (AgentWrapper); scripts_dir (Path).
    Output: Path - the file path written.
    """
    scripts_dir.mkdir(parents=True, exist_ok=True)
    path = scripts_dir / f"{wrapper.id}.zsh"
    path.write_text(wrapper.script)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass  # best-effort; not a secret file, just tidy permissions
    return path


def render_wrapper_invocation(
    wrapper: AgentWrapper, scripts_dir: Path, model: Optional[str] = None
) -> str:
    """Build the single shell-string command for launching this wrapper.

    Description: see the module docstring's "Execution model" section for
      the full reasoning. Returns exactly one flat string — the shape
      every other branch of ``Settings.get_agent_command`` already
      returns, handed straight to the tmux backend's
      ``new-session ... <command>``.
    Inputs:
      wrapper (AgentWrapper) - the wrapper to launch.
      scripts_dir (Path) - directory to write the resolved script file
        into (see ``wrapper_scripts_dir``).
      model (str | None) - forwarded as $1 to the sourced script / entry
        call; None means no model argument at all (matches plain ``cld``
        with no args).
    Output: str - e.g.
      ``zsh -c 'source ~/.zshrc >/dev/null 2>&1; source '"'"'/path/cld.zsh'"'"' "$@"; cld "$@"' _ some-model``
    Example: render_wrapper_invocation(cld_wrapper, dir, None) ->
      a zsh -c string that sources the cld.zsh file and calls cld with no args.
    """
    path = _write_script_file(wrapper, scripts_dir)
    inner = f"source ~/.zshrc >/dev/null 2>&1; source {shlex.quote(str(path))} \"$@\""
    if wrapper.entry and wrapper.entry.strip():
        inner += f"; {shlex.quote(wrapper.entry.strip())} \"$@\""
    outer = f"zsh -c {shlex.quote(inner)}"
    if model:
        # `_` is a throwaway $0; the model becomes $1, forwarded through
        # every "$@" in `inner` above (source's own arg-forwarding, then
        # the entry call) — see module docstring point 3.
        outer += f" _ {shlex.quote(model)}"
    return outer


# ---------------------------------------------------------------------------
# Offered example wrappers — NOT auto-installed anywhere. Served only via
# GET /api/v1/agents/wrappers/examples for a user to explicitly import into
# their own config.json (see the settings-panel "import example" action).
# EXAMPLE_WRAPPER_CLD is the author's REAL, VERBATIM ``cld`` function body,
# as supplied for this feature. EXAMPLE_WRAPPER_CLDOR is a reconstruction
# from its DESCRIBED behavior (model as $1 then shift, CLAUDE_CONFIG_DIR
# isolation, OpenRouter env vars, deliberately blank ANTHROPIC_API_KEY,
# absolute-path claude invocation) — the literal body was never supplied,
# so treat cldor's exact lines as illustrative, not a byte-for-byte capture
# of the real function. A user importing it should review/adjust before
# relying on it; cld's body needs no such caveat.
# ---------------------------------------------------------------------------

EXAMPLE_WRAPPER_CLD = """cld() (
    local claude_token
    claude_token="$(security find-generic-password -a "$USER" -s "claude-cld-oauth" -w 2>/dev/null)" || {
        echo "Claude OAuth token not found in macOS Keychain."
        echo "Run: claude setup-token"
        return 1
    }
    unset CLAUDE_CONFIG_DIR
    export CLAUDE_CODE_OAUTH_TOKEN="$claude_token"
    unset OPENROUTER_API_KEY
    unset ANTHROPIC_BASE_URL
    unset ANTHROPIC_AUTH_TOKEN
    unset ANTHROPIC_API_KEY
    unset CLAUDE_CODE_USE_BEDROCK
    unset CLAUDE_CODE_USE_VERTEX
    unset CLAUDE_CODE_USE_FOUNDRY
    unset ANTHROPIC_MODEL
    unset ANTHROPIC_DEFAULT_OPUS_MODEL
    unset ANTHROPIC_DEFAULT_SONNET_MODEL
    unset ANTHROPIC_DEFAULT_HAIKU_MODEL
    unset CLAUDE_CODE_SUBAGENT_MODEL
    command claude --dangerously-skip-permissions "$@"
)"""

EXAMPLE_WRAPPER_CLDOR = """cldor() (
    local model="$1"
    if [[ -n "$model" ]]; then
        shift
    fi
    local claude_token
    claude_token="$(security find-generic-password -a "$USER" -s "claude-cldor-openrouter" -w 2>/dev/null)" || {
        echo "OpenRouter token not found in macOS Keychain."
        echo "Run: security add-generic-password -a \\"$USER\\" -s claude-cldor-openrouter -w"
        return 1
    }
    export CLAUDE_CONFIG_DIR="$HOME/.claude-cldor"
    unset CLAUDE_CODE_OAUTH_TOKEN
    export OPENROUTER_API_KEY="$claude_token"
    export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
    export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
    export ANTHROPIC_API_KEY=""
    if [[ -n "$model" ]]; then
        export ANTHROPIC_MODEL="$model"
    fi
    "$HOME/.local/bin/claude" --dangerously-skip-permissions "$@"
)"""

EXAMPLE_WRAPPERS: List[dict] = [
    {
        "id": "cld",
        "label": "cld (subscription, keychain-backed)",
        "script": EXAMPLE_WRAPPER_CLD,
        "entry": "cld",
        "description": (
            "example — reads a Claude subscription OAuth token from the "
            "macOS Keychain at run time (entry 'claude setup-token' first) "
            "and clears every OpenRouter/Bedrock/Vertex env var so it can't "
            "accidentally inherit routing from a prior shell."
        ),
        "default": False,
    },
    {
        "id": "cldor",
        "label": "cldor (openrouter, keychain-backed)",
        "script": EXAMPLE_WRAPPER_CLDOR,
        "entry": "cldor",
        "description": (
            "example — takes a model id as its first argument, reads an "
            "OpenRouter API key from the macOS Keychain, and runs Claude "
            "Code isolated in its own CLAUDE_CONFIG_DIR so it never shares "
            "session/auth state with a subscription-mode launch."
        ),
        "default": False,
    },
]
