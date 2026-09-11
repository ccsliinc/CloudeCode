"""The live session: its status, its stored row, and the two-level
listing wrapper the sidebar reads.

``SessionInfo`` is the wrapper ``GET /sessions/list`` returns and its
fields sit on TWO levels: ``activity_status``, ``unread`` and the rest
of the wrapper's own fields on the outside, ``id``, ``pty_pid`` and
``working_dir`` on the nested ``.session``. Reading ``info.id`` gives
nothing back, silently, and looks exactly like a backend that sent
nothing, which is the single most repeated bug in this project. Both
levels live in one module deliberately, so the boundary between them
is readable on one screen instead of inferred across two files.
"""

from datetime import datetime
from enum import Enum
from typing import Optional, List
from pydantic import BaseModel, Field


class SessionStatus(str, Enum):
    """Session status enumeration."""
    CREATING = "creating"
    RUNNING = "running"
    STOPPED = "stopped"
    ERROR = "error"


# Plan v3.2 - replaces the old ``Tunnel`` model. Pure detection record:
# the server discovers a dev port by sniffing pane output, validates that
# something is actually listening, and surfaces the URL to the client.
# No process state, no public URL, no tunnel lifecycle.
class LocalServerInfo(BaseModel):
    """A dev-server port detected on the host, surfaced to the UI."""
    port: int = Field(..., description="TCP port the server is bound to (1024-65535)")
    url: str = Field(..., description="Clickable URL the web client should render")
    first_seen: datetime = Field(default_factory=datetime.utcnow)
    last_seen: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class Session(BaseModel):
    """Session model for Claude Code instance.

    Phase 6 - ``agent_type`` labels which agent CLI was launched in this
    session ("claude" / "codex" / "hermes" / "openclaw"). Optional + None
    default so legacy ``session_metadata.json`` files (written before the
    field existed) deserialize cleanly. The lifespan startup backfill in
    ``SessionManager.lifespan_startup`` populates None-valued agent_type
    on owned sessions to ``"claude"`` (the only agent type pre-Phase-6
    sessions could have been). Adopted sessions stay None until Phase 7
    fingerprint detection back-fills them.
    """
    id: str = Field(..., description="Unique session identifier")
    pty_pid: Optional[int] = Field(None, description="PTY process PID")
    working_dir: str = Field(..., description="Working directory path")
    status: SessionStatus = SessionStatus.CREATING
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_activity: datetime = Field(default_factory=datetime.utcnow)
    agent_type: Optional[str] = Field(
        None,
        description="Agent CLI type: 'claude' | 'codex' | 'hermes' | 'openclaw' (None = unknown / pre-Phase-6 / not yet fingerprinted)",
    )
    # feat/agent-family-pills - True iff ``agent_type`` above was produced
    # by scrollback fingerprinting (src/core/agent_fingerprint.py) at
    # adopt time rather than an explicit launch/config choice. A
    # fingerprinted "codex" and a launched "codex" are textually
    # identical in ``agent_type``; this is the only place that
    # provenance survives, so ``resolve_family_for_display`` (see
    # src/core/agent_families.py) can render a guess differently from a
    # fact. Optional-with-default so legacy ``session_metadata.json``
    # files (written before this field existed) deserialize cleanly and
    # correctly read as "not a fingerprint guess" (they predate
    # fingerprinting entirely).
    agent_type_via_fingerprint: bool = Field(
        default=False,
        description="True iff agent_type came from scrollback fingerprinting, not an explicit choice",
    )
    # SESSION-IDENTITY-V2 - per-session pinned theme. None = no pin (the
    # global localStorage theme rules). Optional + None default so legacy
    # ``session_metadata.json`` files (written before the field existed)
    # deserialize cleanly. Set by PATCH /sessions/{name}/pinned-theme.
    pinned_theme: Optional[str] = Field(
        None,
        description="Theme id pinned to this session; None = follow global theme",
    )
    # PIN-FIX-EXECUTE - the bare tmux session name (e.g. "CoudeCode" - NOT
    # "adopted:CoudeCode" or "cloude_CoudeCode"). Carried on the inner
    # Session so WS event payloads and create-path responses give the
    # frontend a usable handle for the PATCH pinned-theme URL without
    # falling through to session.id (which is "adopted:<name>" for adopted
    # sessions and breaks server lookup). Optional + None default keeps
    # legacy session_metadata.json files deserializing cleanly.
    tmux_session: Optional[str] = Field(
        None,
        description="Bare tmux session name (canonical pin-key handle)",
    )
    # Provider-selector modal (v3.1). Persisted alongside ``agent_type`` so
    # the launch choice survives for the life of the session. None => this
    # session's Claude was launched directly via ``cld`` (or agent_type
    # isn't "claude" at all). Set => launched via ``cldor <model>``
    # (OpenRouter-routed). Same regex-validated shell-injection guard as
    # ``CreateSessionRequest.model``.
    model: Optional[str] = Field(
        None,
        description="OpenRouter model id this session was launched with (None = Claude direct via 'cld')",
    )

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class LogEntry(BaseModel):
    """Log entry model for terminal output."""
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    session_id: str
    content: str
    log_type: str = "stdout"  # "stdout", "stderr", "system"

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }


class SessionStats(BaseModel):
    """Session statistics."""
    total_commands: int = 0
    uptime_seconds: int = 0
    log_lines: int = 0
    local_servers: int = 0


class SessionInfo(BaseModel):
    """Complete session information including logs and detected local servers."""
    session: Session
    recent_logs: List[LogEntry] = Field(default_factory=list)
    local_servers: List[LocalServerInfo] = Field(default_factory=list)
    stats: SessionStats = Field(default_factory=SessionStats)
    session_backend: str = Field(
        default="none",
        description="Backend type driving this session: 'tmux', 'pty', or 'none'",
    )
    # Tmux session name (when backend is tmux). Surfaced to the web UI so
    # the active-session banner on the launchpad can display a human-
    # readable handle - especially useful for adopted sessions whose
    # ``session.id`` is prefixed with ``adopted:`` and thus not a clean
    # display string on its own. None when backend is non-tmux.
    tmux_session: Optional[str] = Field(
        default=None,
        description="tmux session name (tmux backend only; None otherwise)",
    )
    # THE USER-FACING NAME, which is NOT ``tmux_session``. A label is a
    # free-form display string stored in ``sessions.title``; the tmux
    # name is an internal handle derived from it once, at creation, and
    # never moved again. Renaming used to move the tmux name, which is
    # the field identity is keyed on, and that split one session into
    # two rows. None means the row carries no label yet and the client
    # should fall back to ``tmux_session`` - which is what every v1.0.4
    # client does anyway, so an older client is unaffected.
    # Same pair as AttachableSession, and declared for the same reason:
    # this is a response_model, which is a FILTER. A field it does not
    # name is deleted from every response even when the server had it.
    session_row_id: Optional[int] = Field(
        None,
        description="sessions.id for this instance; None when we have no row",
    )
    parent_session_id: Optional[int] = Field(
        None,
        description="sessions.id this one was forked from; None = not a fork",
    )
    label: Optional[str] = Field(
        default=None,
        description=(
            "User-facing session label (sessions.title). Free-form; may "
            "contain spaces and punctuation. Falls back to tmux_session "
            "when None."
        ),
    )
    # Phase 6 - surface the active session's agent_type to the client so the
    # launchpad / banner can show the right label and theme. Mirrors the
    # ``Session.agent_type`` value; redundant on the wire but keeps the UI
    # one .session_backend-style top-level field away.
    agent_type: Optional[str] = Field(
        default=None,
        description="Agent CLI type label (mirrors Session.agent_type)",
    )
    # feat/agent-family-pills - THREE-OUTCOME display of agent_type,
    # computed by ``resolve_family_for_display`` (src/core/agent_families.py)
    # at the moment this SessionInfo is built. NOT a mirror of
    # ``Session.agent_type``: that field is a launch-time value that
    # always has SOMETHING in it once a session is running; this pair can
    # legitimately be ``(None, "unknown")`` when agent_type no longer
    # resolves to any known wrapper or family (e.g. its wrapper was
    # deleted from config after the session launched). The client must
    # render "unknown family" for that case, never fall back to
    # agent_type's raw string.
    agent_family: Optional[str] = Field(
        default=None,
        description="Resolved family name for display ('claude'/'codex'/... ), or None if it could not be determined",
    )
    agent_family_source: Optional[str] = Field(
        default=None,
        description=(
            "Provenance of agent_family: 'wrapper' | 'reserved_name' | "
            "'fingerprint' | 'derived_deepest' | 'unknown'. See "
            "src.core.agent_families.resolve_family_for_display."
        ),
    )
    # The WRAPPER pill's text. A family says what KIND of agent is in the
    # pane; this says which configured script started it ("claude
    # (chrome)"). None means nothing can be named honestly - the value was
    # fingerprinted, or is a bare family name, or names a wrapper config
    # no longer carries - and the client renders NOTHING for None rather
    # than the raw agent_type, which is an internal id. Computed by
    # ``src.core.agent_wrapper_display.resolve_wrapper_for_display`` from
    # the same inputs as agent_family, so the two pills on one row can
    # never disagree about which wrapper matched.
    agent_wrapper_label: Optional[str] = Field(
        default=None,
        description="Configured label of the launch wrapper, or None if none can be named",
    )
    # SESSION-IDENTITY-V2 - surface the pinned theme at the top level so
    # the UI can paint identity (header icon + title swap) without diving
    # into ``.session``. Mirrors Session.pinned_theme.
    pinned_theme: Optional[str] = Field(
        default=None,
        description="Theme id pinned to this session (mirrors Session.pinned_theme)",
    )
    # v0.7.0 - launchpad rejoin scrollback replay. Populated ONLY when
    # ``GET /sessions?session_id=<id>&include_scrollback=1`` is requested
    # by the launchpad's "return to running session" path. Mirrors the
    # adopt-path's ``AdoptSessionResponse.initial_scrollback_b64`` - the
    # client base64-decodes and paints these bytes into xterm BEFORE the
    # WS opens so the rejoined terminal shows the same pre-existing
    # history the adopt path shows. None for every other caller (default-
    # off; existing GET /sessions consumers see no change on the wire).
    initial_scrollback_b64: Optional[str] = Field(
        default=None,
        description=(
            "Base64-encoded captured tmux scrollback bytes. Only populated "
            "when GET /sessions/{id}?include_scrollback=1, to support the "
            "launchpad rejoin path painting history before the WS opens."
        ),
    )
    # Session sidebar + status lights. Resolved by SessionManager from a
    # single bulk tmux pane query (src.core.session_status). Surfaced at
    # the top level (mirrors the .session-nested Session.status) so the
    # client never has to dig into ``.session`` to paint the dot.
    # feat/hook-driven-status - activity_status now carries the UNIFIED
    # hook + tmux vocabulary (src.core.session_status.ALL_ACTIVITY_STATUSES):
    # 'dead' | 'question' | 'notice' | 'working' | 'working_subagent' |
    # 'finished_unread' | 'idle' | 'unknown'. 'question' is a
    # PermissionRequest (the agent is blocked); 'notice' is a
    # Notification (it wants attention and is not). Resolved by
    # SessionManager._session_info_for() via SessionActivityTracker.resolve().
    activity_status: str = Field(
        default="unknown",
        description=(
            "Unified activity status: 'dead' | 'question' | 'notice' | "
            "'working' | 'working_subagent' | 'finished_unread' | 'idle' | "
            "'unknown'"
        ),
    )
    # feat/hook-driven-status - raw unread flag (auto-from-Stop OR manual
    # pin), surfaced alongside activity_status so the client can render an
    # unread badge even in a state that isn't literally 'finished_unread'
    # (e.g. a manually-pinned session that is currently 'working' again).
    unread: bool = Field(
        default=False,
        description="True if this session has an unread Stop or a manual unread pin",
    )
    # fix/session-ownership-source - the TMUX/EXTERNAL badge's ONLY source.
    #
    # WHAT THE BADGE MEANS: True iff THIS APP CREATED the tmux session (via
    # POST /sessions); False iff the app merely ADOPTED one that was started
    # outside it. It is a fact about the session's ORIGIN, so it must not
    # change when the user opens or closes the session, and it must survive
    # a server restart.
    #
    # WHY IT IS ON THE WIRE AT ALL: GET /sessions/attachable filters out
    # every tmux name bound to a live backend, so an OPEN session reaches
    # the client only through the GET /sessions + /sessions/list merge.
    # Without this field on SessionInfo the client had nothing to read and
    # invented an answer twice - first a hardcoded True (every open session
    # badged TMUX), then an ``adopted:``-id-prefix guess (every session
    # badged EXTERNAL after a restart, because restart re-attaches through
    # the adopt path and mints ``adopted:`` ids for sessions the server
    # still correctly owns). Neither guess is derivable client-side. The
    # server resolves it from ``sessions.origin`` (feat/sessions-table,
    # S4), falling back to the legacy in-memory ``owned_tmux_sessions``
    # set while the cutover settles. It is authoritative, survives
    # restart, and is what AttachableSession.created_by_cloude already
    # uses - so both payloads now answer the same question from the same
    # place. True covers BOTH ``origin='created'`` and
    # ``origin='adopted'`` (design 4.6: an adopted session becomes ours
    # for good); ``origin='observed'`` is the only external value.
    created_by_cloude: bool = Field(
        default=False,
        description=(
            "True iff this session is OURS - sessions.origin is 'created' "
            "or 'adopted'. False means 'observed': a session on our socket "
            "we have never claimed"
        ),
    )
    # punchlist 19 - IS THIS SESSION BLOCKED ON A STARTUP PROMPT IT HAS
    # NOT BEEN ANSWERED? A claude parked on its folder-trust dialog is a
    # live pane running a real process that has fired NO hook, so every
    # other field on this model reads healthy and the row painted a green
    # dot over a session waiting for a keypress.
    #
    # DELIBERATELY NOT A SIXTH ``activity_status``. That vocabulary
    # describes what a RUNNING agent is doing; this says whether it
    # started. Three outcomes, resolved by
    # ``src.core.session_startup_gate.resolve_startup_gate``:
    # 'ready' (measured no - a hook fired for this instance, or the pane
    # is gone, or the scrollback was read and carries no prompt),
    # 'awaiting_startup_prompt' (measured yes), 'unknown' (could not
    # determine - liveness, age or the scrollback did not answer). The
    # client renders an indicator ONLY for 'awaiting_startup_prompt';
    # 'unknown' must never be painted as either of the other two.
    startup_gate: str = Field(
        default="unknown",
        description=(
            "Startup-prompt gate: 'ready' | 'awaiting_startup_prompt' | "
            "'unknown'. See src.core.session_startup_gate."
        ),
    )
    # THE SESSION ACTION MENU'S "mute notifications", read off the durable
    # row (``sessions.notifications_muted``, schema v26). ON THE WRAPPER,
    # not on ``.session``, because it is a fact about the stored RECORD
    # rather than about the live process - the same reason ``unread`` and
    # ``created_by_cloude`` sit here. Reading ``info.session.
    # notifications_muted`` gives you ``undefined`` silently, which is the
    # single most repeated bug in this project (CLAUDE.md, "The
    # /sessions/list shape").
    #
    # IT IS THE DISPLAY ANSWER, NOT THE SUPPRESSION ANSWER, and the two are
    # deliberately different. It is True only when the row was READ and
    # says muted. A policy that could not be read at all is not a fact
    # about the row, so it paints as unmuted here while still suppressing
    # every alert - see ``PolicyVerdict.muted`` versus
    # ``PolicyVerdict.suppresses`` in src/core/session_notification_policy.py.
    # A toggle that painted "muted" on an unreadable database would be
    # claiming the user's setting is in force when nobody has looked at it.
    notifications_muted: bool = Field(
        default=False,
        description=(
            "True when this session's stored row records that its "
            "notifications are muted. Defaults False, which is also what a "
            "session with no stored row reports"
        ),
    )

    # WHERE ``activity_status`` CAME FROM. Provenance, not state: a
    # ``working`` fed by a live hook stream and an ``idle`` inferred from
    # a file on disk used to render as the same word with the same
    # confidence, which is this project's recurring false-green shape.
    # Five values, defined in src.core.session_status_source, in
    # descending strength of evidence: 'hook' (the agent's own lifecycle
    # hooks), 'transcript' (a measurement of the conversation file),
    # 'seed_row' (restored from sessions.activity_state), 'tmux' (the
    # pane classification alone), 'none' (nothing answered).
    #
    # THE CLIENT RENDERS IT IN THE TOOLTIP ONLY. It must never change a
    # color: one status with two appearances would undo the single
    # vocabulary the light rests on.
    status_source: str = Field(
        default="none",
        description=(
            "Provenance of activity_status: 'hook' | 'transcript' | "
            "'seed_row' | 'tmux' | 'none'. See "
            "src.core.session_status_source."
        ),
    )
