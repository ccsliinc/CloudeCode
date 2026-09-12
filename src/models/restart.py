"""Respawning a pane, and the preview the restart picker reads before
anything is killed.
"""

from typing import Optional, List
from pydantic import BaseModel, Field


class RespawnSessionRequest(BaseModel):
    """Request body for ``POST /sessions/respawn``.

    STILL NO COMMAND CROSSES THIS BOUNDARY, and that distinction is the
    whole reason ``agent_type`` is safe to accept where a command is not.
    A command would let a client run anything - a create wearing a
    restart's clothes. An ``agent_type`` is an ID that must match a
    wrapper the user has already configured on this machine; the server
    resolves it to a command itself, and refuses an id it does not
    recognise rather than falling back to the default wrapper.

    Why it is accepted at all: moving a session onto another wrapper
    (``claude-chrome``, say) previously required hand-editing
    ``sessions.agent_type`` in cloude.db. See
    ``src/core/session_agent_choice.py``.
    """

    session_name: str = Field(
        ..., description="Literal tmux session name to restart in place"
    )
    agent_type: Optional[str] = Field(
        None,
        description=(
            "Id of a configured launch wrapper to restart this session "
            "with, replacing what it was launched with. Omit to keep the "
            "existing behaviour exactly. An unconfigured id returns 400; "
            "it is never resolved to the default wrapper"
        ),
    )
    confirm_restart_live: bool = Field(
        False,
        description=(
            "Replace what is RUNNING. True kills the pane's process and "
            "restarts it in place (tmux respawn-pane -k), keeping the "
            "same tmux name, the same row and the same conversation. "
            "DESTRUCTIVE and irreversible, so it must be an explicit act "
            "by the user: no prediction produces it and the server never "
            "infers it. Left false (the default) a live session still "
            "answers kind='not_dead' and nothing is destroyed"
        ),
    )


class RespawnSessionResponse(BaseModel):
    """Result of a restart attempt. Three outcomes, never two.

    ``kind`` and ``ok`` are separate on purpose. ``ok=false`` with
    ``kind='cannot_determine'`` means the pane could not be read; with
    ``kind='agent'`` it means we knew exactly what to run, ran it, and it
    exited again. Those need different words in front of the user, so the
    API does not collapse them into one boolean.
    """

    name: str = Field(..., description="tmux session name that was targeted")
    kind: str = Field(
        ...,
        description=(
            "Ladder verdict: 'agent' | 'replay' | 'shell' | 'not_dead' | "
            "'cannot_determine' (src/core/session_respawn.py)"
        ),
    )
    ok: bool = Field(
        ...,
        description=(
            "True only when a process was VERIFIED running in the pane "
            "afterwards. Never inferred from the respawn command's exit code"
        ),
    )
    detail: str = Field(
        "",
        description="One sentence fit to show the user verbatim, always present",
    )
    command: Optional[str] = Field(
        None,
        description=(
            "Command handed to respawn-pane, or null when tmux reused its "
            "own recorded start command"
        ),
    )
    chosen: bool = Field(
        False,
        description=(
            "True when that command came from a wrapper the caller picked "
            "in this request rather than from the session's stored record"
        ),
    )
    agent_type: Optional[str] = Field(
        None,
        description="The wrapper id that was picked, or null when none was",
    )
    agent_type_persisted: bool = Field(
        False,
        description=(
            "True when the picked wrapper was written to sessions.agent_type "
            "so the next restart remembers it. False alongside ok=true means "
            "the restart happened and the choice was NOT remembered - which "
            "is reported rather than hidden, because the next restart will "
            "then not repeat it"
        ),
    )
    session_id: Optional[str] = Field(
        None,
        description=(
            "In-app id of the session that was restarted, read back AFTER "
            "the restart so a client can reopen THIS session rather than "
            "search the list by name. Null for a session the app has no "
            "live backend for; the client then reopens through adopt"
        ),
    )
    session_uuid: Optional[str] = Field(
        None,
        description=(
            "Durable sessions.session_uuid of the row that was restarted. "
            "A respawn preserves the instance triple, so this is the same "
            "value the row carried before - which is what makes it usable "
            "as proof the reopened terminal is the SAME session"
        ),
    )
    killed_live_pane: bool = Field(
        False,
        description=(
            "True when this restart killed a process that was RUNNING "
            "rather than reviving a pane that was already empty. Stated "
            "rather than left to be inferred from kind, because 'we "
            "destroyed something' is not recoverable from a rung name"
        ),
    )
    identity_status: str = Field(
        "unchecked",
        description=(
            "Whether the row is still keyed on the tmux instance it "
            "belongs to: 'unchecked' (no live pane was killed, so the "
            "question was not asked) | 'unchanged' (both #{session_created} "
            "readings agreed, which is what tmux 3.7c does) | 'rekeyed' "
            "(the epoch moved and sessions.tmux_created_epoch was moved "
            "with it) | 'cannot_determine' (a reading did not answer). "
            "cannot_determine is NOT unchanged - see "
            "src/core/session_instance_rekey.py"
        ),
    )


class RestartPreviewOption(BaseModel):
    """One wrapper, and what restarting with it would do.

    ``kind`` is the respawn ladder's own verdict, produced by the SAME
    function the action runs (``src/core/session_respawn.py``), so a
    preview cannot promise an agent and then deliver a shell.
    """

    agent_type: str = Field(..., description="Configured wrapper id")
    label: str = Field(..., description="Display name, falls back to the id")
    is_current: bool = Field(
        ..., description="True when the session's row already records this id"
    )
    resolvable: bool = Field(
        ...,
        description=(
            "True when this wrapper turned into a command. A fact about "
            "the WRAPPER. False ones stay in the list with a reason in "
            "detail - a choice that vanishes reads as one never configured"
        ),
    )
    actionable_now: bool = Field(
        ...,
        description=(
            "True when a respawn would act on this option right now. A "
            "fact about the PANE: false for every option on a live "
            "session however well configured the wrapper is. Kept apart "
            "from resolvable so a client can say WHY it greyed a row out"
        ),
    )
    kind: str = Field(
        ...,
        description=(
            "Ladder verdict for picking this RIGHT NOW: 'agent' | "
            "'replay' | 'shell' | 'not_dead' | 'cannot_determine'"
        ),
    )
    detail: str = Field(..., description="One sentence fit to show verbatim")
    conversation: str = Field(
        "unknown",
        description=(
            "'resumed' | 'none_recorded' | 'unknown' - what this does to the "
            "session's CONVERSATION. A restart means resume, so this says "
            "whether it actually will. 'none_recorded' means the row names "
            "no conversation and the session comes back WITHOUT its "
            "history; 'unknown' means the row could not be read. Rendering "
            "the three identically presents a blank session as a continued "
            "one, which is the defect this field exists to prevent"
        ),
    )
    projected_kind: str = Field(
        "",
        description=(
            "The rung this option WOULD land on if the pane were "
            "restartable, liveness ignored. Never 'not_dead'. This is "
            "what answers 'what would this session come back as' for a "
            "session that is still running - a prediction, not a permission"
        ),
    )
    projected_detail: str = Field(
        "", description="One sentence about projected_kind, fit to show verbatim"
    )
    command: Optional[str] = Field(
        None, description="What would be run, or null when nothing could be"
    )


class RestartPlanPreview(BaseModel):
    """The predicted outcome of a restart, with nothing picked.

    READ ``actionable`` IN CONTEXT. It means "this verdict is one of the
    three real rungs (agent/replay/shell)" rather than one of the two
    that are answers (not_dead/cannot_determine). On the ``unchanged``
    plan that coincides with "you may restart now". On the ``projected``
    plan it does NOT: a live session can project an actionable rung while
    being entirely un-restartable, which is the normal case this endpoint
    exists to describe. Whether anything may actually be done is
    ``pane_state`` plus ``unchanged.actionable``, never this field on
    ``projected``.
    """

    kind: str = Field(
        ...,
        description=(
            "'agent' | 'replay' | 'shell' | 'not_dead' | 'cannot_determine'"
        ),
    )
    detail: str = Field(..., description="One sentence fit to show verbatim")
    command: Optional[str] = Field(None, description="What would be run, or null")
    actionable: bool = Field(
        ...,
        description=(
            "True only for agent/replay/shell. 'not_dead' and "
            "'cannot_determine' are answers, not instructions"
        ),
    )
    conversation: str = Field(
        "unknown",
        description=(
            "'resumed' | 'none_recorded' | 'unknown' - what this does to the "
            "session's CONVERSATION. A restart means resume, so this says "
            "whether it actually will. 'none_recorded' means the row names "
            "no conversation and the session comes back WITHOUT its "
            "history; 'unknown' means the row could not be read. Rendering "
            "the three identically presents a blank session as a continued "
            "one, which is the defect this field exists to prevent"
        ),
    )


class RestartPreviewResponse(BaseModel):
    """Result of ``GET /sessions/restart/preview``. Read-only, always 200.

    THE POINT OF THIS ENDPOINT is that ``POST /sessions/respawn`` mutates,
    so before it there was no way to ask which rung a session would land
    on. Without that answer the UI cannot warn honestly, and the rung
    that needs warning about is ``shell``: a pane whose
    ``#{pane_start_command}`` is empty silently comes back as a login
    shell instead of the agent.

    ``wrappers_status`` carries the third outcome for the LIST itself.
    'ok' with an empty ``options`` means this install configures no
    wrappers; 'unavailable' means the list could not be read. A client
    that renders the second as the first is stating something nobody
    measured.
    """

    name: str = Field(..., description="tmux session name previewed")
    current_agent_type: Optional[str] = Field(
        None,
        description=(
            "sessions.agent_type for this session, or null. Null is "
            "ambiguous by nature - it means both 'launched as a bare "
            "shell' and 'never recorded' - and must not be rendered as "
            "the name of an agent"
        ),
    )
    pane_state: str = Field(
        ...,
        description=(
            "'dead' | 'alive' | 'unknown'. Whether the pane can be "
            "respawned AT ALL, reported separately from every rung "
            "because they answer different questions. 'unknown' means "
            "the probe did not answer and must never render as either "
            "of the other two"
        ),
    )
    unchanged: RestartPlanPreview = Field(
        ...,
        description=(
            "What restarting WITHOUT picking anything would do RIGHT "
            "NOW. On a live pane this is 'not_dead' and not actionable, "
            "which is the answer a restart button must obey"
        ),
    )
    projected: RestartPlanPreview = Field(
        ...,
        description=(
            "The rung a restart WOULD land on with nothing picked, "
            "liveness ignored. Never 'not_dead'. For a LIVE session this "
            "is the only field that says anything useful, and it is what "
            "exposes the shell landmine on a session still running. A "
            "PREDICTION, NEVER A PERMISSION: acting is gated by "
            "pane_state and by unchanged, never by this"
        ),
    )
    options: List[RestartPreviewOption] = Field(
        default_factory=list,
        description="One predicted outcome per configured wrapper, config order",
    )
    wrappers_status: str = Field(
        ...,
        description="'ok' (options reflect the config) or 'unavailable'",
    )


class RestartSessionResponse(BaseModel):
    """Response for ``POST /sessions/{session_uuid}/restart``.

    THREE FIELDS THAT MUST NOT BE COLLAPSED INTO ``success``.

    ``conversation`` says whether the old conversation was actually
    resumed: ``'resumed'`` (a bare ``--resume <uuid>`` against the stored
    ``claude_session_uuid``), ``'none_recorded'`` (the row never learned a
    Claude session uuid, so this is a NEW conversation wearing the old
    name - stated, never implied), or ``'unknown'`` (the row itself could
    not be read). A client that renders all three identically has
    reintroduced the defect: a blank session presented as a continued one.

    ``row_reused`` says whether the restarted session kept its OWN record
    - the same ``sessions.id``, and with it its title, conversation link,
    group membership and history. That is the normal outcome and it is
    what stops a restart leaving an abandoned twin behind. It is separate
    from ``success`` because the session can be live and working while
    reuse was refused (another row already holds the new tmux instance, or
    the row was deleted mid-flight), and that is neither a failure nor an
    unqualified success: the user gets a working session that may show up
    as a second entry.

    ``title_carried`` reports the label the session came back with, so the
    caller can show what it actually got rather than what it asked for.
    """
    success: bool = True
    session: dict = Field(default_factory=dict)
    conversation: str = Field(
        ...,
        description="'resumed' | 'none_recorded' | 'unknown' - never collapse these",
    )
    replaced_session_id: Optional[int] = None
    row_reused: bool = False
    title_carried: Optional[str] = None
    detail: Optional[str] = None
