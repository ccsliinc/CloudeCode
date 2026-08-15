"""Configuration management using pydantic-settings.

Sub-blocks on ``AuthConfig`` mirror the JSON top-level keys 1:1:
``session``, ``tunnel``, ``auth_rate_limits``, ``notifications``,
``agents``, ``uploads``. Each block is optional in ``config.json`` —
missing keys deserialize as defaults so existing installs keep working.
The ``uploads`` block governs the browser-paste image upload feature
(endpoint, sweeper cadence, TTL, per-upload size cap).
"""

from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path
import os
import json
import shlex
import socket

from src.models import is_valid_model_id, MODEL_ID_PATTERN
from src.core.agent_wrappers import (
    AgentWrapper,
    default_wrapper as _default_wrapper,
    find_wrapper as _find_wrapper,
    render_wrapper_invocation,
    wrapper_scripts_dir,
)
from src.core.terminal_commands import (
    TERMINAL_COMMANDS_KEY,
    TerminalCommand,
    default_terminal_commands,
    find_terminal_command as _find_terminal_command,
    replace_terminal_commands as _replace_terminal_commands,
)


class ProjectConfig(BaseModel):
    """Configuration for a predefined project.

    Phase 6 — agent-type labeling. ``agent_type`` is the default agent CLI
    used when sessions for this project are created without an explicit
    override. Defaults to ``"claude"`` so existing config.json files (which
    have no agent_type field) continue to deserialize and behave exactly
    as before. Per-project override; the explicit ``agent_type`` on the
    create-session request still takes precedence.
    """
    name: str
    path: str
    description: Optional[str] = None
    agent_type: Literal["claude", "codex", "hermes", "openclaw"] = "claude"


class AgentsConfig(BaseModel):
    """Per-agent shell command strings used to launch each agent CLI.

    Phase 6 — agent-type labeling. Each command is a single shell-string
    that the tmux backend passes verbatim as ``new-session ... <command>``;
    tmux itself parses the string as a shell command (no shlex.split on
    our side — see ``TmuxBackend.start`` and the existing claude path
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
    # precedence). Empty string (the default) means "not configured" — the
    # command falls back to ``cld`` / ``cldor``, which is what the author's
    # own ``~/.zshrc``-based setup relies on and must keep working with zero
    # config change. Set this to a plain CLI invocation (e.g.
    # ``"claude --dangerously-skip-permissions"``, see config.example.json)
    # to run Claude Code directly on machines that don't have ``cld`` /
    # ``cldor`` defined.
    claude_command: str = ""
    codex_command: str = "codex"
    hermes_command: str = "hermes"
    openclaw_command: str = "openclaw tui"
    # Plain interactive shell — no agent CLI. Used by the "New console"
    # FAB action so users can spawn a bare tmux session in ~/ for quick
    # shell work. ``$SHELL -i`` ensures rc files (.zshrc/.bashrc) load.
    shell_command: str = "$SHELL -i"
    # feat/launch-wrappers — user-defined named launch wrappers for the
    # "claude" agent family (see src/core/agent_wrappers.py). Empty list
    # (the default) means "not configured" — get_agent_command falls
    # through to claude_command, then the hardcoded cld/cldor fallback,
    # EXACTLY as before this feature existed. A wrapper's own ``id`` can
    # also be passed as ``agent_type`` on session create to launch through
    # that specific wrapper (see get_agent_command's docstring).
    wrappers: List[AgentWrapper] = Field(default_factory=list)


# Provider-selector modal (v3.1) default catalog — shown alongside the
# implicit "Claude" option. Module-level so both ``ProvidersConfig``'s
# pydantic default AND the raw-JSON add/remove methods below (which must
# seed from the same defaults when config.json has no "providers" block
# yet) stay in sync.
_DEFAULT_PROVIDER_MODELS: List[str] = [
    "qwen/qwen3.8-max",
    "moonshotai/kimi-k3",
    "openai/gpt-5.6-sol",
]


class ProvidersConfig(BaseModel):
    """OpenRouter model catalog for the provider-selector modal.

    ``models`` is the add/remove-able list shown alongside the implicit
    "Claude" option (never stored here, never removable — the client
    always prepends it). A missing/absent "providers" block in
    config.json deserializes to the curated default trio via
    ``_DEFAULT_PROVIDER_MODELS``.
    """
    models: List[str] = Field(default_factory=lambda: list(_DEFAULT_PROVIDER_MODELS))

    @field_validator("models")
    @classmethod
    def _drop_invalid_model_ids(cls, v: List[str]) -> List[str]:
        """Defense-in-depth: ``add_provider_model`` / the POST route only
        guard entries added through the API. A hand-edited config.json
        bypasses that guard entirely, and this list is trusted downstream
        both server-side (``Settings.get_agent_command`` interpolates it
        into a shell command) and client-side (rendered into the provider
        modal's DOM, including the remove-confirm dialog). Validate here
        too, at load time, so a corrupted/tampered entry can't reach
        either surface unvalidated.

        Drop-with-a-warning-log rather than raise: this mirrors the
        fail-soft philosophy ``load_auth_config`` already applies to each
        malformed sub-block (session, auth_rate_limits, notifications,
        agents, uploads) — one bad entry should not hard-brick the whole
        app on startup or wipe out the rest of an otherwise-valid list.
        """
        valid: List[str] = []
        dropped: List[str] = []
        for m in v:
            if isinstance(m, str) and is_valid_model_id(m):
                valid.append(m)
            else:
                dropped.append(m)
        if dropped:
            import structlog
            structlog.get_logger().warning(
                "dropped_invalid_provider_model_ids",
                dropped=dropped,
                pattern=MODEL_ID_PATTERN,
            )
        return valid


class SessionConfig(BaseModel):
    """Session backend configuration.

    - ``backend``: ``"auto"`` (tmux if available, else pty), ``"tmux"``, or ``"pty"``.
    - ``tmux_socket_name``: name passed to ``tmux -L <name>``. Defaults to
      ``"cloude"`` so we never touch the user's default tmux server.
    - ``scrollback_lines``: how many lines the backend captures on re-attach
      for scrollback replay. Too high = slow reconnects; too low = lost
      context. 3000 lines is a reasonable middle ground.
    """
    backend: str = Field(
        default="auto",
        description="Session backend: 'auto' | 'tmux' | 'pty'",
    )
    tmux_socket_name: str = Field(
        default="cloude",
        description="Dedicated tmux socket name (tmux -L <name>)",
    )
    scrollback_lines: int = Field(
        default=10000,
        description="Lines of scrollback to capture on re-attach",
        ge=0,
    )


class NotificationsConfig(BaseModel):
    """Push notification configuration (Item 6).

    - ``enabled``: master flag. False = the router is wired but every
      ``emit()`` is a no-op. No background traffic, no warnings.
    - ``ntfy_base_url``: the ntfy server. Default is the public
      sh.ntfy.sh; self-hosted users override.
    - ``ntfy_topic``: the secret topic name. EMPTY by default —
      ``setup_auth.py`` generates a 32-hex value on first run. Treat
      as a credential: anyone with the topic name can read your
      notifications.
    - ``public_base_url``: e.g. ``"http://mac.lan:8000"``. When set,
      notifications include a Click deep link back to the session.
      When unset, notifications fire without a Click header.
    - ``idle_threshold_seconds``: Item 7 — seconds of PTY silence after
      which an IdleWatcher fires TASK_COMPLETE, provided the tail ends
      on a Claude Code prompt frame. 30s is the plan v3.1 default;
      operators may tune downward if false-positive rate is acceptable.
    - ``pushover_token`` / ``pushover_user_key``: Pushover push backend.
      Both are EMPTY by default and both must be set for the channel to
      activate — see ``NotificationRouter.emit``'s ``has_pushover`` gate.
    """
    enabled: bool = False
    ntfy_base_url: str = Field(default="https://ntfy.sh")
    ntfy_topic: str = Field(default="")
    public_base_url: str = Field(default="")
    idle_threshold_seconds: float = Field(default=30.0, ge=1.0)
    # Plan v3.1 Item 8 — rate limiter knobs (single global bucket + per-kind dedup).
    # ``rate_limit_global_cap`` / ``rate_limit_window_seconds``: rolling-window
    # cap on total notifications dispatched (default 10 per 60s). Guards against
    # pattern-match storms.
    # ``rate_limit_per_kind_cooldown_seconds``: minimum seconds between two
    # emits of the same EventType (default 10s). Deduplicates bursts like
    # repeated "Error:" pattern matches in test output.
    rate_limit_global_cap: int = Field(default=10, ge=1)
    rate_limit_window_seconds: float = Field(default=60.0, ge=1.0)
    rate_limit_per_kind_cooldown_seconds: float = Field(default=10.0, ge=0.0)
    # v0.7.0 Part 3 — opt out of the Claude Code lifecycle hook merger.
    # When True, ``ensure_hook_settings()`` is a no-op and ~/.claude/settings.json
    # is left entirely alone (no Stop/Notification/PermissionRequest hooks
    # are injected). Users who curate their own hook block can set this to
    # avoid surprise merges. Default False = hooks managed.
    disable_claude_hooks: bool = False
    # v0.7.0 Part 4 — Slack incoming-webhook fanout. When non-empty, every
    # NotificationEvent dispatched by the router also POSTs a chat message
    # to this webhook URL. Single-channel, no OAuth. Empty default = the
    # Slack channel is silently disabled.
    # Format: ``https://hooks.slack.com/services/T.../B.../...`` — treat
    # as a credential.
    slack_webhook_url: str = Field(default="")
    # Pushover push backend. Both fields are required together — the
    # router's ``has_pushover`` guard treats a partial config (only one
    # of the two set) as unconfigured. Empty defaults = the Pushover
    # channel is silently disabled.
    # ``pushover_token``: the application/API token created at
    # pushover.net/apps/build. Treat as a credential.
    pushover_token: str = Field(default="")
    # ``pushover_user_key``: the user or group key from the Pushover
    # dashboard. Treat as a credential.
    pushover_user_key: str = Field(default="")


class UploadsConfig(BaseModel):
    """Browser-paste image upload configuration.

    - ``enabled``: master switch for the upload endpoint and the periodic
      sweeper task. False = the route still mounts but rejects calls,
      and the sweeper exits its loop immediately on startup.
    - ``ttl_seconds``: files in any session's ``.cloude_uploads/`` bucket
      whose mtime is older than this are pruned by the sweeper. Default
      24h gives the user a full working day to reference an image again
      without it disappearing mid-session.
    - ``sweep_interval_seconds``: how often the background sweeper wakes
      to walk every configured project's ``.cloude_uploads/`` bucket and
      delete TTL-expired files. Default 1h is the safety-net cadence;
      destroy-on-kill and lifespan-startup sweeps cover the common cases.
    - ``max_size_mb``: per-upload size cap. Claude API tops out at 30 MB
      after base64 expansion, so 10 MB raw leaves headroom and rejects
      pathologically large pastes before any disk write.
    """
    enabled: bool = True
    ttl_seconds: int = Field(default=86400, ge=1)
    sweep_interval_seconds: int = Field(default=3600, ge=1)
    max_size_mb: int = Field(default=10, ge=1)


class AuthRateLimits(BaseModel):
    """Rate-limit knobs for authentication endpoints.

    - ``totp_verify_per_minute`` / ``totp_verify_per_hour``: dual-window
      limits applied to the TOTP verify endpoint. Both must be satisfied;
      the per-minute bucket stops rapid brute-force bursts, the per-hour
      bucket caps sustained hammering.
    - ``trust_proxy_headers``: when True, the rate-limit key comes from the
      first value of ``X-Forwarded-For``; otherwise the direct peer
      ``request.client.host`` is used. MUST stay False when the app is
      reachable directly (LAN bind). Flip to True only when terminating
      TLS behind a trusted reverse proxy (Cloudflare tunnel, nginx, ALB).
    """
    totp_verify_per_minute: int = Field(default=5, ge=1)
    totp_verify_per_hour: int = Field(default=20, ge=1)
    trust_proxy_headers: bool = False


class AuthConfig(BaseModel):
    """Authentication configuration loaded from JSON and .env."""
    # feat/launch-wrappers — schema/migration marker. Absent from every
    # config.json written before this feature; treated as 0 (see
    # src/core/config_migration.py). Not itself consulted by
    # get_agent_command — purely a migration bookkeeping field.
    config_version: int = 0
    totp_secret: Optional[str] = None  # Populated from Settings (.env)
    jwt_secret: Optional[str] = None   # Populated from Settings (.env)
    jwt_expiry_minutes: int = 30       # Legacy — used only if access TTL unset.
    # Item 5: access/refresh token pair. Access is short-lived (15m default)
    # so a leaked token has a tight blast radius; refresh is long-lived
    # (7d default) but stored server-side with rotation + reuse detection.
    access_token_ttl_seconds: int = 14400     # 4 hours
    refresh_token_ttl_seconds: int = 604800   # 7 days
    # Grace window during which a just-rotated refresh token can still be
    # used. Tolerates near-simultaneous requests (client fires two refreshes
    # at once) without tripping reuse-detection.
    refresh_grace_seconds: int = 10
    template_path: Optional[str] = None
    projects: List[ProjectConfig] = []
    common_slash_commands: List[str] = []
    session: SessionConfig = Field(default_factory=SessionConfig)
    auth_rate_limits: AuthRateLimits = Field(default_factory=AuthRateLimits)
    notifications: NotificationsConfig = Field(default_factory=NotificationsConfig)
    agents: AgentsConfig = Field(default_factory=AgentsConfig)
    uploads: UploadsConfig = Field(default_factory=UploadsConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    # feat/settings-tabs-and-commands — user-editable common shell
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


# Agent-type values with a fixed, single-command resolution — never
# eligible for wrapper lookup even if a wrapper happened to share the id.
# Module-level (not a class attribute) because Settings is a pydantic
# BaseSettings and an underscore-prefixed class attribute there becomes a
# ModelPrivateAttr descriptor, not a plain frozenset — see
# Settings.get_agent_command / Settings.add_wrapper for the two call sites.
RESERVED_AGENT_TYPES = frozenset({"codex", "hermes", "openclaw", "shell"})


class Settings(BaseSettings):
    """Application configuration settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )

    # Server Configuration
    host: str = "0.0.0.0"
    port: int = 8000

    # Session Configuration
    default_working_dir: str  # Required in .env
    session_timeout: int = 3600  # seconds (1 hour)

    # Logging Configuration
    log_buffer_size: int = 1000  # lines to keep in memory
    log_file_retention: int = 7  # days
    log_directory: str  # Required in .env

    # Security Configuration
    api_key: Optional[str] = None
    # CORS allowed origins. Default is computed from HOST/PORT + local
    # hostname variants (see ``_compute_default_allowed_origins``). The
    # default NEVER includes "*", because the CORS middleware is wired with
    # ``allow_credentials=True`` and the wildcard-with-credentials combo is
    # a well-known footgun that lets any LAN neighbor fire credentialed
    # XHRs at the API. To override (e.g. to add a tunnel hostname), set
    # the ``ALLOWED_ORIGINS`` env var to a comma-separated list — that
    # value is used verbatim and takes precedence over the computed
    # default (see ``allowed_origins`` property below).
    allowed_origins_override: Optional[str] = Field(
        default=None,
        alias="ALLOWED_ORIGINS",
        description=(
            "Comma-separated CORS origin override. When set, replaces the "
            "computed default wholesale. Leave unset to use the safe "
            "HOST/PORT + hostname-derived default."
        ),
    )

    # Authentication Secrets (from .env)
    totp_secret: Optional[str] = None
    jwt_secret: Optional[str] = None

    # Authentication Configuration
    auth_config_file: str = "./config.json"

    # Claude CLI Configuration
    # LEGACY (v3.1) — no longer consulted for agent_type == "claude" (see
    # get_agent_command / AgentsConfig.claude_command). Kept for .env
    # back-compat; setting CLAUDE_CLI_PATH is now a silent no-op.
    claude_cli_path: Optional[str] = None

    _auth_config_cache: Optional[AuthConfig] = None

    @property
    def allowed_origins(self) -> List[str]:
        """Compute the CORS allowed-origins list.

        Precedence:
        1. If ``ALLOWED_ORIGINS`` env var is set, split on ``,`` and return
           verbatim (trimmed). Operator override — trust the operator.
        2. Otherwise, build a safe allowlist from ``HOST`` + ``PORT`` plus
           loopback + mDNS hostname variants. NEVER includes ``"*"``,
           because CORS middleware is wired with ``allow_credentials=True``
           and the wildcard-with-credentials combo lets any LAN neighbor
           fire credentialed XHRs at the API.

        The computed list covers the three ways a user can hit the server:
        - ``http://<HOST>:<PORT>`` — literal bind address
        - ``http://localhost:<PORT>`` / ``http://127.0.0.1:<PORT>`` — loopback
        - ``http://<hostname>:<PORT>`` / ``http://<hostname>.local:<PORT>``
          — mDNS / Bonjour hostname (e.g. ``adoom`` → ``adoom.local``)

        When ``HOST == "0.0.0.0"`` (bind-all), we substitute localhost +
        127.0.0.1 + hostname + hostname.local instead of literally
        whitelisting ``0.0.0.0`` (which no browser would ever send as an
        Origin header anyway).
        """
        override = self.allowed_origins_override
        if override:
            parts = [p.strip() for p in override.split(",")]
            return [p for p in parts if p]

        port = self.port
        origins: List[str] = []

        # Best-effort hostname lookup. ``socket.gethostname()`` is cheap and
        # doesn't hit DNS; tolerate failure and just skip those entries.
        try:
            hostname = socket.gethostname()
        except Exception:
            hostname = ""
        # Strip any trailing ".local" so we can emit bare-host + .local
        # variants deterministically.
        hostname_bare = hostname[:-6] if hostname.endswith(".local") else hostname

        if self.host and self.host != "0.0.0.0":
            origins.append(f"http://{self.host}:{port}")

        origins.append(f"http://localhost:{port}")
        origins.append(f"http://127.0.0.1:{port}")

        if hostname_bare:
            origins.append(f"http://{hostname_bare}:{port}")
            origins.append(f"http://{hostname_bare}.local:{port}")

        # De-dupe while preserving order.
        seen = set()
        deduped: List[str] = []
        for o in origins:
            if o not in seen:
                seen.add(o)
                deduped.append(o)
        return deduped

    def get_working_dir(self) -> Path:
        """Get the absolute path for the working directory."""
        path = Path(self.default_working_dir).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        return path

    def get_log_dir(self) -> Path:
        """Get the absolute path for the log directory."""
        path = Path(self.log_directory).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        return path

    def get_session_metadata_path(self) -> Path:
        """Get the path for session metadata JSON file."""
        return Path(self.log_directory).expanduser() / "session_metadata.json"

    def get_pinned_themes_path(self) -> Path:
        """Path for the per-tmux-session pinned-theme map.

        SESSION-IDENTITY-V2 — kept in its OWN file, distinct from
        ``session_metadata.json``. The active-session metadata file is
        unlinked on detach and overwritten on swap, so we cannot use it
        as durable per-name storage. This file is name-keyed and survives
        the full detach → swap → re-adopt round-trip; it is pruned only
        when a session is explicitly destroyed (X button) or its tmux
        session disappears at startup-reconciliation time.
        """
        return Path(self.log_directory).expanduser() / "pinned_themes.json"

    def get_unread_state_path(self) -> Path:
        """Path for the per-tmux-session read/unread map.

        Hook-driven status (feat/hook-driven-status) — mirrors
        ``get_pinned_themes_path()``'s pattern exactly: name-keyed (not
        session-id-keyed) so the flag survives detach -> swap -> re-adopt,
        and follows the user across browsers/devices since it lives on the
        server rather than in localStorage. Each entry is
        ``{"auto": bool, "manual": bool}`` - "auto" is set by a ``Stop``
        hook and cleared when a WS terminal binds to the session (the user
        looked at it); "manual" is set/cleared only by the user's explicit
        mark-unread control and is NOT cleared by viewing. Pruned the same
        way as pinned themes: on explicit destroy, or when the tmux session
        is gone at startup-reconciliation time.
        """
        return Path(self.log_directory).expanduser() / "unread_state.json"

    def get_claude_cli_path(self) -> str:
        """
        LEGACY (v3.1) — no longer called by ``get_agent_command()`` for
        ``agent_type == "claude"`` (the provider-selector modal always
        launches via the ``cld`` / ``cldor`` zsh functions instead). Kept
        for any external callers / back-compat; ``CLAUDE_CLI_PATH`` is now
        a silent no-op as far as session launch is concerned.

        Get the path to the Claude CLI binary with auto-detection fallback.

        Detection order:
        1. claude_cli_path setting (if explicitly set)
        2. `which claude` command (if found in PATH)
        3. ~/.claude/local/claude (if exists)
        4. Just "claude" (trust system PATH)

        Returns:
            Path to Claude CLI binary
        """
        import shutil
        import subprocess

        # 1. Check if explicitly set
        if self.claude_cli_path:
            return self.claude_cli_path

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

    def get_agent_command(
        self, agent_type: Optional[str], model: Optional[str] = None
    ) -> str:
        """Resolve the shell command string for a given agent_type.

        Phase 6 — agent-type labeling. Returns the shell-string command
        registered under ``AuthConfig.agents`` for the requested agent.
        Falls back to the AgentsConfig defaults if the auth config can't
        be loaded (e.g. unit-test paths that bypass setup_auth.py).

        ``codex`` / ``hermes`` / ``openclaw`` / ``shell`` are RESERVED —
        always their fixed single command, unaffected by anything below.

        Everything else (``"claude"``, ``None``/empty, or a custom string)
        is the "claude family" and resolves in this order:
          1. ``agent_type`` matches the ``id`` of a configured wrapper
             (``agents.wrappers``) — launch through THAT wrapper
             specifically (see ``src/core/agent_wrappers.py``). This is
             how a caller picks a non-default wrapper explicitly — the
             wrapper's own id doubles as its agent_type value. The
             resolved ``Session.agent_type`` ends up being that wrapper
             id, so which wrapper launched a session is recorded the same
             way agent_type always has been — no second field.
          2. ``agent_type`` is exactly ``"claude"``, ``None``/empty, or
             any string that ISN'T a configured wrapper id (unknown type
             → safe fallback to the claude family, unchanged from
             pre-wrappers behavior) — AND at least one wrapper is
             configured: use the DEFAULT wrapper
             (``agent_wrappers.default_wrapper``).
          3. No wrappers configured at all (the common case for every
             config.json written before this feature — wrappers defaults
             to ``[]``): ``agents.claude_command`` if explicitly set to a
             non-empty string, run verbatim through the same
             ``~/.zshrc``-sourcing wrapper.
          4. Neither wrappers nor claude_command configured: the
             ORIGINAL hardcoded ``cld`` / ``cldor <model>`` zsh-function
             fallback, byte-for-byte unchanged from every prior release.
        Steps 3-4 are UNREACHABLE the moment any wrapper exists in config
        (step 2 always finds at least the default wrapper first) — this is
        intentional: a wrapper list is a strictly additive, opt-in
        superset of the old two-step fallback, never a partial mix of the
        two for the same launch.
        ``CLAUDE_CLI_PATH`` remains LEGACY / a no-op for this type — see its
        field comment on ``Settings.claude_cli_path``.

        Why the ``~/.zshrc``-sourcing wrapper (steps 3-4, and internally
        inside wrapper resolution too): tmux's spawned pane shell does NOT
        source ``~/.zshrc`` (non-interactive, non-login — see
        TmuxBackend.start / tmux's own ``$SHELL -c <command>``
        invocation), so a bare ``cld`` would be "command not found".
        Empirically verified (real detached tmux session on a scratch
        ``-L`` socket, ``tmux capture-pane``) against two candidate
        wrappers; ``zsh -c 'source ~/.zshrc >/dev/null 2>&1; <cmd>'`` was
        chosen over ``zsh -ic`` — see git history for the full comparison
        this docstring used to carry.
        The model, when present, is shlex-quoted at every quoting
        boundary it crosses so it can never break out of or be
        reinterpreted by any layer (verified against ``; rm -rf /``,
        backticks, ``$(...)``, and a leading ``~``).
        ``CreateSessionRequest.model`` / the provider-add endpoint already
        restrict model ids to ``^[A-Za-z0-9._~/-]{1,120}$`` before this is
        ever called — this quoting is defense-in-depth, not the only guard.

        Returned shape: a single shell string, which the tmux backend
        hands directly to ``new-session ... <cmd>`` (tmux itself execs it
        via the pane's default shell, ``-c <string>`` — one level of shell
        parsing on our returned string, hence the quoting above).
        """
        # Resolve AgentsConfig — tolerate auth-config load failure so the
        # caller (create_session) doesn't blow up if config.json is missing
        # in a degraded environment.
        try:
            agents = self.load_auth_config().agents
        except Exception:
            agents = AgentsConfig()

        normalized = (agent_type or "claude").lower()

        if normalized in RESERVED_AGENT_TYPES:
            return {
                "codex": agents.codex_command,
                "hermes": agents.hermes_command,
                "openclaw": agents.openclaw_command,
                "shell": agents.shell_command,
            }[normalized]

        # claude family: explicit wrapper id, then default wrapper, then
        # legacy claude_command, then the original hardcoded fallback.
        explicit = _find_wrapper(agents.wrappers, normalized)
        chosen = explicit if explicit is not None else _default_wrapper(agents.wrappers)
        if chosen is not None:
            scripts_dir = wrapper_scripts_dir(self.log_directory)
            # A wrapper that does not consume a model id must NEVER be
            # handed one: it forwards "$@" to claude, so the model would
            # arrive as a prompt argument and Claude would answer the
            # string "anthropic/claude-opus-4" instead of launching
            # routed. The picker already declines to offer models for
            # such a wrapper (client/js/providers.js); this is the
            # server-side half of the same rule, so a stale client or a
            # hand-rolled API call cannot reintroduce the bug.
            effective_model = model if chosen.accepts_model else None
            return render_wrapper_invocation(chosen, scripts_dir, model=effective_model)

        # Step 3: an explicit, non-empty agents.claude_command wins outright,
        # regardless of ``model`` — a user who opted into a custom command
        # is opting out of the cld/cldor provider-selector path entirely.
        if agents.claude_command and agents.claude_command.strip():
            inner = f"source ~/.zshrc >/dev/null 2>&1; {agents.claude_command}"
            return f"zsh -c {shlex.quote(inner)}"
        # Step 4: unchanged cld/cldor fallback.
        if model:
            inner = f"source ~/.zshrc >/dev/null 2>&1; cldor {shlex.quote(model)}"
            return f"zsh -c {shlex.quote(inner)}"
        return "zsh -c 'source ~/.zshrc >/dev/null 2>&1; cld'"

    def load_auth_config(self) -> AuthConfig:
        """
        Load authentication configuration from JSON file + .env secrets.

        Secrets (totp_secret, jwt_secret) come from .env via Settings.
        Non-secrets (projects, template_path, etc) come from JSON file.

        Returns:
            AuthConfig object with TOTP secret, JWT config, and projects

        Raises:
            FileNotFoundError: If config file doesn't exist
            ValueError: If config file is invalid or secrets missing
        """
        if self._auth_config_cache is not None:
            return self._auth_config_cache

        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            with open(config_path) as f:
                data = json.load(f)

            # Convert projects from dict to ProjectConfig objects
            projects_data = data.get("projects", [])
            projects = [ProjectConfig(**p) for p in projects_data]

            # Build SessionConfig from optional "session" block; missing keys
            # fall back to SessionConfig defaults.
            session_data = data.get("session", {}) or {}
            try:
                session_config = SessionConfig(**session_data)
            except Exception:
                # Malformed session block — log + use defaults rather than
                # killing the whole config load.
                import structlog
                structlog.get_logger().warning(
                    "invalid_session_config_block",
                    raw=session_data,
                )
                session_config = SessionConfig()

            # Build AuthRateLimits from optional "auth_rate_limits" block;
            # same malformed-block tolerance as session.
            rate_limits_data = data.get("auth_rate_limits", {}) or {}
            try:
                rate_limits_config = AuthRateLimits(**rate_limits_data)
            except Exception:
                import structlog
                structlog.get_logger().warning(
                    "invalid_auth_rate_limits_block",
                    raw=rate_limits_data,
                )
                rate_limits_config = AuthRateLimits()

            # Build NotificationsConfig from optional "notifications" block;
            # same malformed-block tolerance as session/tunnel.
            notifications_data = data.get("notifications", {}) or {}
            try:
                notifications_config = NotificationsConfig(**notifications_data)
            except Exception:
                import structlog
                structlog.get_logger().warning(
                    "invalid_notifications_config_block",
                    raw=notifications_data,
                )
                notifications_config = NotificationsConfig()

            # Build AgentsConfig from optional "agents" block; same
            # malformed-block tolerance as session/tunnel/etc. Missing block
            # → defaults (claude_command, codex_command, hermes_command,
            # openclaw_command). Backward-compatible with pre-Phase-6
            # config.json files that have no "agents" key.
            agents_data = data.get("agents", {}) or {}
            try:
                agents_config = AgentsConfig(**agents_data)
            except Exception:
                import structlog
                structlog.get_logger().warning(
                    "invalid_agents_config_block",
                    raw=agents_data,
                )
                agents_config = AgentsConfig()

            # Build UploadsConfig from optional "uploads" block; same
            # malformed-block tolerance as session/tunnel/etc. Missing block
            # → defaults (enabled=True, ttl 24h, sweep 1h, max 10 MB).
            uploads_data = data.get("uploads", {}) or {}
            try:
                uploads_config = UploadsConfig(**uploads_data)
            except Exception:
                import structlog
                structlog.get_logger().warning(
                    "invalid_uploads_config_block",
                    raw=uploads_data,
                )
                uploads_config = UploadsConfig()

            # Build ProvidersConfig from optional "providers" block; same
            # malformed-block tolerance as session/tunnel/etc. Missing block
            # → defaults (the curated 3-model trio, _DEFAULT_PROVIDER_MODELS).
            providers_data = data.get("providers", {}) or {}
            try:
                providers_config = ProvidersConfig(**providers_data)
            except Exception:
                import structlog
                structlog.get_logger().warning(
                    "invalid_providers_config_block",
                    raw=providers_data,
                )
                providers_config = ProvidersConfig()

            # Build the terminal-command list from the optional top-level
            # block; same malformed-block tolerance as every sibling above.
            # A missing block falls back to the seed defaults so the
            # terminal tab is never empty on a pre-v2 config.
            terminal_commands_data = data.get(TERMINAL_COMMANDS_KEY) or []
            try:
                terminal_commands_config = [
                    TerminalCommand(**c) for c in terminal_commands_data
                ] or [TerminalCommand(**c) for c in default_terminal_commands()]
            except Exception:
                import structlog
                structlog.get_logger().warning(
                    "invalid_terminal_commands_block",
                    raw=terminal_commands_data,
                )
                terminal_commands_config = [
                    TerminalCommand(**c) for c in default_terminal_commands()
                ]

            # Build AuthConfig with secrets from .env (via Settings)
            # and configuration from JSON file
            config_version = data.get("config_version", 0)
            if not isinstance(config_version, int):
                config_version = 0

            auth_config = AuthConfig(
                config_version=config_version,
                totp_secret=self.totp_secret,  # From .env via Settings
                jwt_secret=self.jwt_secret,    # From .env via Settings
                jwt_expiry_minutes=data.get("jwt_expiry_minutes", 30),
                # Item 5 — optional JSON overrides for token lifetimes.
                # Defaults (900s / 604800s / 10s) are sensible for the
                # single-user LAN MVP; expose them so operators can tune
                # without editing source.
                access_token_ttl_seconds=int(
                    data.get("access_token_ttl_seconds", 14400)
                ),
                refresh_token_ttl_seconds=int(
                    data.get("refresh_token_ttl_seconds", 604800)
                ),
                refresh_grace_seconds=int(
                    data.get("refresh_grace_seconds", 10)
                ),
                template_path=data.get("template_path"),
                projects=projects,
                common_slash_commands=data.get("common_slash_commands", []),
                session=session_config,
                auth_rate_limits=rate_limits_config,
                notifications=notifications_config,
                agents=agents_config,
                uploads=uploads_config,
                providers=providers_config,
                terminal_commands=terminal_commands_config,
            )

            # Validate secrets are set
            if not auth_config.totp_secret or not auth_config.jwt_secret:
                raise ValueError(
                    "Missing authentication secrets in .env file.\n"
                    "Required: TOTP_SECRET and JWT_SECRET\n"
                    "Run ./setup_auth.py to generate them."
                )

            # Cache it
            self._auth_config_cache = auth_config
            return auth_config

        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )

    def get_project(self, name: str) -> Optional[ProjectConfig]:
        """Look up a project by display name. Returns None if not found."""
        auth_config = self.load_auth_config()
        for p in auth_config.projects:
            if p.name == name:
                return p
        return None

    def save_project(self, project: ProjectConfig) -> None:
        """
        Add a new project to the configuration file.

        Args:
            project: ProjectConfig object to add

        Raises:
            FileNotFoundError: If config file doesn't exist
            ValueError: If config file is invalid or project already exists
        """
        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            # Read current config
            with open(config_path) as f:
                data = json.load(f)

            # Check if project with same name already exists
            projects_data = data.get("projects", [])
            if any(p.get("name") == project.name for p in projects_data):
                raise ValueError(f"Project with name '{project.name}' already exists")

            # Add new project at the top (index 0)
            projects_data.insert(0, {
                "name": project.name,
                "path": project.path,
                "description": project.description
            })

            # Update data
            data["projects"] = projects_data

            # Write back to file
            with open(config_path, 'w') as f:
                json.dump(data, f, indent=2)

            # Clear cache to force reload
            self._auth_config_cache = None

        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )

    def delete_project(self, project_name: str) -> None:
        """
        Delete a project from the configuration file.

        Args:
            project_name: Name of the project to delete

        Raises:
            FileNotFoundError: If config file doesn't exist
            ValueError: If config file is invalid or project doesn't exist
        """
        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            # Read current config
            with open(config_path) as f:
                data = json.load(f)

            # Find and remove project
            projects_data = data.get("projects", [])
            original_length = len(projects_data)
            projects_data = [p for p in projects_data if p.get("name") != project_name]

            if len(projects_data) == original_length:
                raise ValueError(f"Project '{project_name}' not found")

            # Update data
            data["projects"] = projects_data

            # Write back to file
            with open(config_path, 'w') as f:
                json.dump(data, f, indent=2)

            # Clear cache to force reload
            self._auth_config_cache = None

        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )

    def update_project(
        self,
        old_name: str,
        new_name: Optional[str],
        description: Optional[str],
    ) -> ProjectConfig:
        """
        Update a project's display name and/or description.

        Display name only — the folder on disk is never touched.

        Args:
            old_name: Current display name (used as the lookup key)
            new_name: New display name. ``None`` = leave unchanged. If equal to
                ``old_name`` it's treated as a no-op for the name field.
            description: New description. ``None`` = leave unchanged. An empty
                string is honored as an intentional clear.

        Returns:
            The updated ``ProjectConfig`` (reflecting the new name/description).

        Raises:
            FileNotFoundError: If config file doesn't exist.
            KeyError: If no project named ``old_name`` exists.
            ValueError: ``"name conflict"`` if renaming to a name another
                project already has, or for invalid JSON in the config file.
        """
        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            # Read current config
            with open(config_path) as f:
                data = json.load(f)

            projects_data = data.get("projects", [])

            # Locate the target project (case-sensitive exact match)
            target_index = None
            for i, p in enumerate(projects_data):
                if p.get("name") == old_name:
                    target_index = i
                    break

            if target_index is None:
                raise KeyError(old_name)

            # Apply name change (with collision check)
            if new_name is not None and new_name != old_name:
                # Collision: any OTHER project (different index) with new_name
                for i, p in enumerate(projects_data):
                    if i != target_index and p.get("name") == new_name:
                        raise ValueError("name conflict")
                projects_data[target_index]["name"] = new_name

            # Apply description change (None = no-op; "" = intentional clear)
            if description is not None:
                projects_data[target_index]["description"] = description

            # Update data and persist atomically:
            # write to .tmp → fsync → os.replace() (atomic on same filesystem).
            data["projects"] = projects_data

            tmp_path = config_path.with_suffix(config_path.suffix + ".tmp")
            with open(tmp_path, "w") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, config_path)

            # Clear cache to force reload
            self._auth_config_cache = None

            updated = projects_data[target_index]
            return ProjectConfig(
                name=updated["name"],
                path=updated.get("path", ""),
                description=updated.get("description"),
            )

        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )

    def move_project_to_top(self, working_dir: str) -> None:
        """
        Move a project to the top of the projects list (most recently used).

        Args:
            working_dir: Path of the working directory to match against projects

        Note:
            Fails silently if no matching project found (user might use custom paths)
        """
        try:
            config_path = Path(self.auth_config_file).expanduser()

            if not config_path.exists():
                return  # Fail silently

            # Read current config
            with open(config_path) as f:
                data = json.load(f)

            projects_data = data.get("projects", [])
            if not projects_data:
                return  # No projects to reorder

            # Normalize the working_dir path for comparison
            working_path = Path(working_dir).expanduser().resolve()

            # Find matching project
            matching_project = None
            matching_index = None

            for i, project in enumerate(projects_data):
                project_path = Path(project.get("path", "")).expanduser().resolve()
                if project_path == working_path:
                    matching_project = project
                    matching_index = i
                    break

            # If no match found, fail silently (user using custom path)
            if matching_project is None or matching_index is None:
                return

            # If already at top, no need to reorder
            if matching_index == 0:
                return

            # Move to top
            projects_data.pop(matching_index)
            projects_data.insert(0, matching_project)

            # Update data
            data["projects"] = projects_data

            # Write back to file
            with open(config_path, 'w') as f:
                json.dump(data, f, indent=2)

            # Clear cache to force reload
            self._auth_config_cache = None

        except Exception as e:
            # Fail silently - don't want to break session creation if reordering fails
            import structlog
            logger = structlog.get_logger()
            logger.warning("failed_to_reorder_projects", error=str(e), working_dir=working_dir)

    # ---- provider-selector modal (v3.1) ----------------------------------

    def get_provider_models(self) -> List[str]:
        """Return the persisted list of add/remove-able OpenRouter model ids.

        "Claude" is implicit and never included — callers that need the
        full picker list prepend it themselves. Missing "providers" block
        in config.json yields ``_DEFAULT_PROVIDER_MODELS`` (via
        ``ProvidersConfig``'s pydantic default).
        """
        return list(self.load_auth_config().providers.models)

    def add_provider_model(self, model: str) -> List[str]:
        """
        Add an OpenRouter model id to config.json's ``providers.models`` list.

        Format validation (the shell-injection guard) is the CALLER's
        responsibility — see ``MODEL_ID_PATTERN`` in ``src/models.py`` and
        the route handler for ``POST /api/v1/providers/models``, which
        validates before calling this. This method only enforces
        uniqueness, matching ``save_project``'s duplicate-name guard.

        Args:
            model: Model id to add.

        Returns:
            The updated models list (does NOT include "Claude").

        Raises:
            FileNotFoundError: If config file doesn't exist.
            ValueError: If the model is already present, or the config
                file is invalid JSON.
        """
        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            with open(config_path) as f:
                data = json.load(f)

            providers_data = data.get("providers") or {}
            # ``.get("models", _DEFAULT...)`` mirrors ProvidersConfig's
            # pydantic default_factory semantics: only fall back to the
            # curated trio when the key is ABSENT, not when it's present
            # but empty (an explicit `"models": []` is honored verbatim).
            models = list(providers_data.get("models", _DEFAULT_PROVIDER_MODELS))

            if model in models:
                raise ValueError(f"Model '{model}' already exists")

            models.append(model)
            providers_data["models"] = models
            data["providers"] = providers_data

            with open(config_path, 'w') as f:
                json.dump(data, f, indent=2)

            # Clear cache to force reload
            self._auth_config_cache = None
            return models

        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )

    def remove_provider_model(self, model: str) -> List[str]:
        """
        Remove an OpenRouter model id from config.json's ``providers.models``.

        Args:
            model: Model id to remove.

        Returns:
            The updated models list (does NOT include "Claude").

        Raises:
            FileNotFoundError: If config file doesn't exist.
            ValueError: If the model isn't present, or the config file is
                invalid JSON.
        """
        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            with open(config_path) as f:
                data = json.load(f)

            providers_data = data.get("providers") or {}
            models = list(providers_data.get("models", _DEFAULT_PROVIDER_MODELS))

            if model not in models:
                raise ValueError(f"Model '{model}' not found")

            models.remove(model)
            providers_data["models"] = models
            data["providers"] = providers_data

            with open(config_path, 'w') as f:
                json.dump(data, f, indent=2)

            # Clear cache to force reload
            self._auth_config_cache = None
            return models

        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )

    # ---- settings screen (feat/settings-screen) ---------------------------

    @staticmethod
    def _mask_secret(value: str) -> dict:
        """Reduce a secret string to a UI-safe presence flag.

        Description: never returns any fragment of ``value`` — the
          settings screen's contract is "never render an existing value
          in plain text", and a partial reveal (e.g. last 4 chars) is
          still a plain-text leak of real secret material. A boolean is
          enough for the UI to say "configured" vs "not set" and offer
          a "leave unchanged" no-op save.
        Inputs: value (str) - the raw secret from config.json, "" if unset.
        Output: dict - ``{"configured": bool}``.
        """
        return {"configured": bool(value)}

    def get_settings_summary(self) -> dict:
        """Build the payload for ``GET /api/v1/config/settings``.

        Description: assembles the three settings-screen sections from
          the currently loaded auth config plus the live server bind
          address. Secret-shaped notification fields are masked (see
          ``_mask_secret``) — this method is the ONLY place that reads
          those fields for the settings screen, so the masking can't be
          skipped by a call site forgetting to apply it.
        Inputs: none.
        Output: dict with keys ``agents``, ``notifications``, ``server``.
          ``agents.effective_claude_command`` is the literal shell string
          ``get_agent_command("claude")`` would return right now, so the
          UI can show exactly what will run when ``claude_command`` is
          empty (the cld/cldor fallback) without re-deriving that logic
          client-side.
        Raises:
          FileNotFoundError: if config.json is missing.
        """
        cfg = self.load_auth_config()
        agents = cfg.agents
        notif = cfg.notifications

        wildcard_bind = self.host in ("0.0.0.0", "", None)
        return {
            "agents": {
                "claude_command": agents.claude_command,
                "codex_command": agents.codex_command,
                "hermes_command": agents.hermes_command,
                "openclaw_command": agents.openclaw_command,
                "effective_claude_command": self.get_agent_command("claude"),
                # feat/launch-wrappers — full wrapper objects (script
                # included; never a secret, see AgentWrapper's docstring)
                # so the settings-panel editor can list/edit/reload them
                # in one round trip.
                "wrappers": [w.model_dump() for w in agents.wrappers],
            },
            "notifications": {
                "enabled": notif.enabled,
                "ntfy_base_url": notif.ntfy_base_url,
                "ntfy_topic": self._mask_secret(notif.ntfy_topic),
                "slack_webhook_url": self._mask_secret(notif.slack_webhook_url),
                "pushover_token": self._mask_secret(notif.pushover_token),
                "pushover_user_key": self._mask_secret(notif.pushover_user_key),
                "restart_required": True,
            },
            "server": {
                "host": self.host,
                "port": self.port,
                "wildcard_bind": wildcard_bind,
                "editable": False,
            },
            # feat/settings-tabs-and-commands — the terminal tab's list,
            # included here so opening settings is one round trip.
            "terminal_commands": [c.model_dump() for c in cfg.terminal_commands],
        }

    def update_settings_config(
        self,
        agents_update: Optional[dict] = None,
        notifications_update: Optional[dict] = None,
    ) -> dict:
        """
        Merge partial ``agents`` / ``notifications`` updates into config.json.

        Description: reads config.json, backs up the pre-write bytes to
          ``config.json.bak`` (overwritten each call — one generation of
          history, matching the granularity of the atomic writes already
          used elsewhere in this file), applies ONLY the keys present in
          the given dicts (an absent key is left untouched — "leave
          unchanged" semantics), re-validates the merged sub-blocks
          through their pydantic models so a bad merge can't reach disk,
          then writes via the same tmp-file + fsync + os.replace pattern
          as ``update_project`` (atomic on the same filesystem — no
          crash-mid-write can corrupt config.json).
        Inputs:
          agents_update (dict|None) - keys already filtered by the route
            handler to only those the client actually set (via
            ``model_fields_set``); values are the new strings.
          notifications_update (dict|None) - same shape, for the
            ``notifications`` block.
        Output: dict - ``get_settings_summary()`` computed AFTER the
          write, so the caller/UI can repaint from the authoritative
          post-write state in one round trip.
        Raises:
          FileNotFoundError: if config.json is missing.
          ValueError: invalid JSON, or a merged sub-block fails pydantic
            validation (caller already did field-level checks; this is
            defense-in-depth against a hand-edited config.json having
            put the file in a state a valid partial update can't fix).
        Security: never logs a value from ``notifications_update`` — only
          the list of changed key names, at the call site in the route
          handler.
        """
        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            with open(config_path) as f:
                raw = f.read()
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )

        if agents_update:
            agents_data = dict(data.get("agents") or {})
            agents_data.update(agents_update)
            # Re-validate the merged block — raises on garbage before
            # anything touches disk.
            AgentsConfig(**agents_data)
            data["agents"] = agents_data

        if notifications_update:
            notifications_data = dict(data.get("notifications") or {})
            notifications_data.update(notifications_update)
            NotificationsConfig(**notifications_data)
            data["notifications"] = notifications_data

        # Backup the pre-write bytes. Best-effort: a backup failure must
        # not block the write itself (matches the fail-soft posture the
        # rest of this file uses for non-critical side effects).
        try:
            backup_path = config_path.with_suffix(config_path.suffix + ".bak")
            backup_path.write_text(raw)
        except OSError as e:
            import structlog
            structlog.get_logger().warning(
                "config_settings_backup_failed", error=str(e)
            )

        tmp_path = config_path.with_suffix(config_path.suffix + ".tmp")
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, config_path)

        self._auth_config_cache = None
        return self.get_settings_summary()

    # ---- launch wrappers (feat/launch-wrappers) ---------------------------

    def _read_config_dict(self, config_path: Path) -> dict:
        """Read+parse config.json. Shared by every wrapper CRUD method.

        Inputs: config_path (Path).
        Output: dict - parsed JSON.
        Raises: FileNotFoundError; ValueError on invalid JSON.
        """
        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )
        try:
            with open(config_path) as f:
                return json.load(f)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON in auth config file: {e}\nCheck {config_path}")

    def _write_wrappers(self, config_path: Path, agents_data: dict) -> None:
        """Persist an updated ``agents`` block back to config.json.

        Description: backs up the pre-write bytes to ``config.json.bak``
          (same one-generation convention as ``update_settings_config``),
          then writes atomically via tmp-file + fsync + os.replace.
        Inputs: config_path (Path); agents_data (dict) - the full new
          ``agents`` block (caller has already re-validated it via
          ``AgentsConfig(**agents_data)``).
        Output: None.
        """
        with open(config_path) as f:
            raw = f.read()
        data = json.loads(raw)
        data["agents"] = agents_data

        try:
            backup_path = config_path.with_suffix(config_path.suffix + ".bak")
            backup_path.write_text(raw)
        except OSError as e:
            import structlog
            structlog.get_logger().warning("wrapper_write_backup_failed", error=str(e))

        tmp_path = config_path.with_suffix(config_path.suffix + ".tmp")
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, config_path)

        self._auth_config_cache = None

    def add_wrapper(self, wrapper: AgentWrapper) -> List[dict]:
        """Add a new launch wrapper to config.json's ``agents.wrappers``.

        Description: rejects a duplicate id, and rejects an id that
          collides with a RESERVED agent_type (``codex``/``hermes``/
          ``openclaw``/``shell``) — those would never be reachable via
          ``get_agent_command``'s resolution order (reserved types are
          checked first), so accepting one here would silently create a
          wrapper that can never launch.
        Inputs: wrapper (AgentWrapper) - already field-validated by
          pydantic (id charset, non-blank script) before this is called.
        Output: list[dict] - the updated wrapper list.
        Raises: FileNotFoundError; ValueError (duplicate id, reserved id,
          or invalid JSON in config.json).
        """
        if wrapper.id in RESERVED_AGENT_TYPES:
            raise ValueError(f"'{wrapper.id}' is a reserved agent type, not usable as a wrapper id")

        config_path = Path(self.auth_config_file).expanduser()
        data = self._read_config_dict(config_path)
        agents_data = dict(data.get("agents") or {})
        wrappers = list(agents_data.get("wrappers") or [])

        if any(w.get("id") == wrapper.id for w in wrappers):
            raise ValueError(f"Wrapper '{wrapper.id}' already exists")

        new_wrapper = wrapper.model_dump()
        if new_wrapper["default"]:
            for w in wrappers:
                w["default"] = False
        wrappers.append(new_wrapper)
        agents_data["wrappers"] = wrappers

        AgentsConfig(**agents_data)  # re-validate merged block before disk
        self._write_wrappers(config_path, agents_data)
        return wrappers

    def update_wrapper(self, wrapper_id: str, wrapper: AgentWrapper) -> List[dict]:
        """Replace an existing wrapper's fields (id is immutable via this call).

        Inputs:
          wrapper_id (str) - id of the wrapper to replace.
          wrapper (AgentWrapper) - new field values. ``wrapper.id`` MUST
            equal ``wrapper_id`` — renaming a wrapper id is delete+add
            (its id is also its script filename and the value callers use
            as agent_type; silently changing it out from under a caller
            already in flight is worse than requiring an explicit rename).
        Output: list[dict] - the updated wrapper list.
        Raises: FileNotFoundError; ValueError (not found, id mismatch, or
          invalid JSON).
        """
        if wrapper.id != wrapper_id:
            raise ValueError("wrapper id cannot be changed via update; delete and re-add instead")

        config_path = Path(self.auth_config_file).expanduser()
        data = self._read_config_dict(config_path)
        agents_data = dict(data.get("agents") or {})
        wrappers = list(agents_data.get("wrappers") or [])

        idx = next((i for i, w in enumerate(wrappers) if w.get("id") == wrapper_id), None)
        if idx is None:
            raise ValueError(f"Wrapper '{wrapper_id}' not found")

        new_wrapper = wrapper.model_dump()
        if new_wrapper["default"]:
            for i, w in enumerate(wrappers):
                if i != idx:
                    w["default"] = False
        wrappers[idx] = new_wrapper
        agents_data["wrappers"] = wrappers

        AgentsConfig(**agents_data)
        self._write_wrappers(config_path, agents_data)
        return wrappers

    def delete_wrapper(self, wrapper_id: str) -> List[dict]:
        """Remove a wrapper from config.json's ``agents.wrappers``.

        Description: if the removed wrapper was the default and other
          wrappers remain, the first remaining wrapper becomes default
          (mirrors ``agent_wrappers.default_wrapper``'s own "first in
          list" fallback, applied eagerly so the persisted state always
          has an explicit default when the list is non-empty).
        Inputs: wrapper_id (str).
        Output: list[dict] - the updated wrapper list (may be empty).
        Raises: FileNotFoundError; ValueError (not found, or invalid JSON).
        """
        config_path = Path(self.auth_config_file).expanduser()
        data = self._read_config_dict(config_path)
        agents_data = dict(data.get("agents") or {})
        wrappers = list(agents_data.get("wrappers") or [])

        idx = next((i for i, w in enumerate(wrappers) if w.get("id") == wrapper_id), None)
        if idx is None:
            raise ValueError(f"Wrapper '{wrapper_id}' not found")

        removed = wrappers.pop(idx)
        if removed.get("default") and wrappers:
            wrappers[0]["default"] = True
        agents_data["wrappers"] = wrappers

        AgentsConfig(**agents_data)
        self._write_wrappers(config_path, agents_data)
        return wrappers

    def set_default_wrapper(self, wrapper_id: str) -> List[dict]:
        """Mark exactly one wrapper as default, clearing the flag on all others.

        Inputs: wrapper_id (str).
        Output: list[dict] - the updated wrapper list.
        Raises: FileNotFoundError; ValueError (not found, or invalid JSON).
        """
        config_path = Path(self.auth_config_file).expanduser()
        data = self._read_config_dict(config_path)
        agents_data = dict(data.get("agents") or {})
        wrappers = list(agents_data.get("wrappers") or [])

        if not any(w.get("id") == wrapper_id for w in wrappers):
            raise ValueError(f"Wrapper '{wrapper_id}' not found")

        for w in wrappers:
            w["default"] = (w.get("id") == wrapper_id)
        agents_data["wrappers"] = wrappers

        AgentsConfig(**agents_data)
        self._write_wrappers(config_path, agents_data)
        return wrappers

    # ---- terminal commands (feat/settings-tabs-and-commands) --------------
    #
    # Thin delegation: the schema, validation, seed list and atomic write all
    # live in src/core/terminal_commands.py, which also documents WHY none of
    # this ever runs a command server-side. Read that module's docstring
    # before adding anything here.

    def get_terminal_commands(self) -> List[TerminalCommand]:
        """List the configured terminal commands, in display order.

        Inputs: none.
        Output: list[TerminalCommand] - the seed defaults when config.json
          has no ``terminal_commands`` block (see AuthConfig's field).
        Raises: FileNotFoundError if config.json is missing.
        """
        return list(self.load_auth_config().terminal_commands)

    def get_terminal_command(self, command_id: Optional[str]) -> Optional[TerminalCommand]:
        """Resolve one terminal command by id, for a console launch.

        Description: the ONLY way a stored command string is ever read for
          execution. The caller supplies an id, never a command string, so
          nothing a client invents can reach a shell. An unknown id
          resolves to None, which callers must treat as "launch a plain
          console and run nothing" — a launch is never failed over a
          stale id (e.g. the user deleted the entry in another tab).
        Inputs: command_id (str | None) - id from the launch request.
        Output: TerminalCommand | None.
        """
        if not command_id:
            return None
        try:
            return _find_terminal_command(self.get_terminal_commands(), command_id)
        except (FileNotFoundError, ValueError):
            # Degraded config must not break console launches.
            return None

    def replace_terminal_commands(self, raw: List[dict]) -> List[dict]:
        """Persist a whole new terminal-command list (add/edit/delete/reorder).

        Inputs: raw (list[dict]) - complete new list in display order.
        Output: list[dict] - the validated, persisted list.
        Raises: FileNotFoundError; ValueError on a malformed entry.
        """
        config_path = Path(self.auth_config_file).expanduser()
        persisted = _replace_terminal_commands(config_path, raw)
        self._auth_config_cache = None
        return persisted


# Global settings instance
# Wrap in try/catch to provide helpful error messages if .env is misconfigured
try:
    settings = Settings()
except Exception as e:
    import sys
    from pathlib import Path

    error_msg = f"""
========================================
CLOUDE CODE - CONFIGURATION ERROR
========================================

Failed to load configuration from .env file.

Error: {str(e)}

This usually means:
1. Required fields are missing from .env (DEFAULT_WORKING_DIR, LOG_DIRECTORY)
2. Required auth fields are empty (TOTP_SECRET, JWT_SECRET)
3. .env file is malformed or has invalid values

To fix:
1. Run setup_auth.py to regenerate .env with all required fields
2. Or manually edit .env and ensure all required fields are present

Required fields:
- DEFAULT_WORKING_DIR (path to projects directory)
- LOG_DIRECTORY (path to logs directory)
- TOTP_SECRET (generated by setup_auth.py)
- JWT_SECRET (generated by setup_auth.py)

========================================
"""

    # Write to stderr (will be captured by Electron app logs)
    print(error_msg, file=sys.stderr)

    # Also write to temp file for debugging
    error_log = Path("/tmp/cloude-code-startup-error.log")
    try:
        with open(error_log, "w") as f:
            f.write(error_msg)
        print(f"\nError details written to: {error_log}", file=sys.stderr)
    except:
        pass

    # Exit with error code
    sys.exit(1)
