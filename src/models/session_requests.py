"""Creating, commanding, forking and renaming a session, and the
unread flag the owner sets by hand.
"""

from typing import Optional
from pydantic import BaseModel, Field, field_validator
from .model_ids import describe_model_id_rejection, is_valid_model_id


# API Request Models

class CreateSessionRequest(BaseModel):
    """Request model for creating a new session."""
    working_dir: Optional[str] = Field(
        None,
        description="Override working directory (defaults to configured path)"
    )
    auto_start_claude: bool = Field(
        True,
        description="Auto-launch claude-code CLI"
    )
    copy_templates: bool = Field(
        False,
        description="Copy template files to working directory"
    )
    project_name: Optional[str] = Field(
        None,
        description="Optional human-readable project display name"
    )
    # THE NAME THE SESSION IS BORN WITH, on both sides at once.
    #
    # Every other path that creates a session already passes a label -
    # fork (routes.py fork endpoint) and restart-of-stopped both do - and
    # ``SessionManager.create_session`` turns a non-empty one into
    # ``--name <label>`` on the launch command via
    # ``claude_rename.launch_name_args_for_agent_type``. The plain create
    # endpoint was the ONE creator that passed none, so a session started
    # from the launchpad got a row title and a claude that had never
    # heard of it: measured, a project named "Punchlist Test" launched
    # claude with no ``--name`` at all and the TUI status line showed the
    # directory.
    #
    # ``--name`` AT BIRTH IS THE RISK-FREE HALF OF NAME SYNCING. It is
    # set before anything is running, so it interrupts nothing and needs
    # none of the gating the after-the-fact ``/rename`` push needs. An
    # empty or absent label leaves the launch exactly as it was.
    #
    # DELIBERATELY SEPARATE FROM ``project_name``. A project is a folder
    # and many sessions share one; a label names THIS session and the
    # user renames it freely afterwards. The launchpad happens to seed
    # the label from the project name, which is a client decision, not a
    # rule the server should bake in.
    label: Optional[str] = Field(
        None,
        description="Name for the new session; also passed to claude as --name"
    )
    # The PARENT folder a brand-new project is created inside. Sent only
    # by the "start empty" flow, which had no folder step at all and so
    # let every project land at ``<projects root>/ses_<hex>``. When set,
    # the server composes ``<realpath(parent)>/<project_name>``, validates
    # it (src/core/project_directory.py) and uses it as working_dir.
    #
    # DELIBERATELY NOT ``working_dir``. Three shipped flows already post
    # that field with folders from anywhere on disk - "open an existing
    # folder", the new-console FAB (it posts "~") and clone - so putting a
    # root restriction on it would refuse folders they have always
    # accepted. A restriction on a field nothing used to send cannot
    # regress any of them.
    project_parent_dir: Optional[str] = Field(
        None,
        description="Parent folder for a new project; composed with project_name"
    )
    # Optional client-measured terminal dims. When supplied, the backend
    # births the pane at these dims instead of the INITIAL_COLS/INITIAL_ROWS
    # defaults - closing the "80x24 or 132x40 birth" gap before the first
    # WS resize frame arrives. Omitted by clients that don't know their
    # dims at creation time; the WS resize handshake still reshapes later.
    cols: Optional[int] = Field(
        None,
        description="Client-measured terminal columns (xterm cell grid width)"
    )
    rows: Optional[int] = Field(
        None,
        description="Client-measured terminal rows (xterm cell grid height)"
    )
    # Phase 6 - explicit per-request agent override. When omitted, the
    # session inherits the project's configured ``agent_type`` (from
    # ProjectConfig); when supplied, it wins outright. None / missing
    # is the common case for pre-Phase-6 clients.
    # feat/launch-wrappers - also accepts the ``id`` of a configured
    # launch wrapper (e.g. "cld", "cldor", or any custom wrapper id) to
    # launch through that specific wrapper. See
    # ``Settings.get_agent_command``'s resolution order. No format
    # restriction here beyond str: an unrecognized value safely falls
    # back to the claude family (never a validation error), and a
    # wrapper id is validated at wrapper-create time
    # (``agent_wrappers.WRAPPER_ID_PATTERN``), not here.
    agent_type: Optional[str] = Field(
        None,
        description="Agent CLI to launch ('claude' | 'codex' | 'hermes' | 'openclaw' | a configured wrapper id); overrides project default",
    )
    # Provider-selector modal (v3.1). Only meaningful when the resolved
    # agent_type is "claude" (see Settings.get_agent_command). None =>
    # Claude direct via `cld`. Set => OpenRouter-routed via `cldor <model>`.
    model: Optional[str] = Field(
        None,
        description="OpenRouter model id; None launches Claude directly via 'cld'",
    )
    # feat/settings-tabs-and-commands - id of a configured terminal
    # command (config.json ``terminal_commands``) to type into the new
    # console pane once it is up. Only meaningful with
    # ``agent_type="shell"``.
    #
    # SECURITY: this is an ID, never a command string. The server looks
    # the id up in the user's own config and writes the stored text into
    # the visible tmux pane via the existing SessionBackend.write()
    # (send-keys). A client cannot supply arbitrary text to run - see
    # src/core/terminal_commands.py's module docstring. An unknown id is
    # silently ignored (plain console), never an error.
    terminal_command_id: Optional[str] = Field(
        None,
        description="Id of a configured terminal command to run in a new console session",
    )

    @field_validator("model")
    @classmethod
    def _validate_model_id(cls, v: Optional[str]) -> Optional[str]:
        """Shell-injection guard - enforced regardless of client-side checks.

        ``Settings.get_agent_command()`` interpolates this value into a
        shell command string; anything outside the allowed shape is
        rejected here, before it ever reaches ``session_manager`` or a
        shell. See ``MODEL_ID_PATTERN`` above. The error message names the
        specific reason (``describe_model_id_rejection``) rather than a
        single generic "invalid" for every cause - see that function's
        docstring for why.
        """
        if v is None:
            return v
        if not is_valid_model_id(v):
            raise ValueError(describe_model_id_rejection(v))
        return v


class CommandRequest(BaseModel):
    """Request model for sending a command."""
    command: str = Field(..., description="Command to execute in the session")


class SetUnreadRequest(BaseModel):
    """Request body for ``PATCH /sessions/{session_name}/unread``.

    feat/hook-driven-status - the manual "mark unread for followup"
    control. ``session_name`` in the URL is the literal tmux session name
    (same convention as ``/sessions/{session_name}/theme``), not a
    session_id, so it works for attachable-but-not-live sessions too.
    """
    unread: bool = Field(
        ..., description="True to mark unread for followup, False to clear"
    )


class ForkSessionResponse(BaseModel):
    """Response for ``POST /sessions/{session_name}/fork``.

    ``lineage_recorded`` is its own field rather than folded into
    ``success`` on purpose. The tmux session can be created successfully
    and the lineage stamp still fail to land - the fork EXISTS and works
    either way, it just is not linked to its parent in the tree. Reporting
    that as an outright failure would be wrong (the user has a working
    forked session) and reporting it as an unqualified success would hide
    a real gap. It is the third outcome, given its own field.
    """
    success: bool = True
    session: dict = Field(default_factory=dict)
    parent_session_id: Optional[int] = None
    lineage_recorded: bool = False
    detail: Optional[str] = None


class RenameSessionRequest(BaseModel):
    """Request body for ``PATCH /api/v1/sessions/{session_id}/name``.

    ``new_name`` is a LABEL, not a tmux session name. It is validated by
    ``session_label.validate_label``, which accepts anything printable -
    spaces, punctuation, mixed case, non-ASCII - and refuses only what
    cannot be rendered: empty, over 200 characters, or carrying a control
    character such as a newline.

    The strict ``[A-Za-z0-9_-]`` charset this used to carry existed
    because the value was handed straight to ``tmux rename-session``. It
    no longer is: the endpoint writes ``sessions.title`` and the tmux
    name never moves, which is what stops a rename from splitting one
    session into two rows.
    """
    new_name: str = Field(
        ...,
        description=(
            "New session label (1-200 chars, any printable text "
            "including spaces)"
        ),
    )
