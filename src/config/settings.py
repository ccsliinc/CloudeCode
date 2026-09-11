"""``Settings``: the loader, and the typed readers over it.

Carved out of the flat ``src/config.py`` by slice S5 of
``.claude/notes/backend-decomposition-plan.md``. The class is what plan
v2 section 2 calls "a settings blob": 19 env-backed fields plus 1,270
lines of method body. The FIELDS and the two caches stayed; every method
body moved to a sibling module that names exactly the configuration it
depends on, and what is left here is a typed entry point per name.

**EVERY PUBLIC NAME AND EVERY SIGNATURE IS UNCHANGED, AND THAT IS A HARD
CONSTRAINT RATHER THAN POLITENESS.** 111 modules import from this
package, and the suite patches these members on the CLASS - 23 sites do
``monkeypatch.setattr(settings, "state_dir_override", ...)``, eight do
``monkeypatch.setattr(type(sm.settings), "get_state_dir", ...)``. A
method that stopped resolving here would be invisible to every one of
them.

**THE TWO CACHES LIVE HERE BECAUSE THE CONFIGURATION THAT KEYS THEM DOES.**
``_auth_config_cache`` is invalidated by every writer in this package,
which is why the writers are called from here rather than reached
directly: a caller that wrote config.json through
:mod:`src.config.config_writes` without coming past this object would
leave a stale parse in memory. ``_state_file_pins`` is keyed on the
CONFIGURED directories, so repointing one re-asks the question while a
file appearing or disappearing does not.

**LAZINESS IS PRESERVED WHERE IT WAS LOAD-BEARING.**
:func:`~src.config.agent_command.agent_command` takes CALLABLES for the
state directory and the alternate-screen setting rather than values,
because resolving the first can raise and reading the second must happen
at launch time. See that module's docstring.
"""

from pathlib import Path
from typing import Callable, Dict, List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

from src.config import (
    agent_command as _agent_command,
    auth_loader as _auth_loader,
    config_writes as _config_writes,
    provider_models as _provider_models,
    state_paths as _state_paths,
    summary as _summary,
    wrappers as _wrappers,
)
from src.config.agents import AgentsConfig, RESERVED_AGENT_TYPES
from src.config.auth import AuthConfig
from src.core.agent_wrappers import AgentWrapper
from src.core import wrapper_store
from src.core.terminal_commands import (
    TerminalCommand,
    find_terminal_command as _find_terminal_command,
    replace_terminal_commands as _replace_terminal_commands,
)


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
    # Dev-only opt-in for uvicorn's file-watching auto-reload. MUST default
    # False: a file-watching reloader has no business running against a
    # deployed instance, since it re-execs the whole server on every write
    # under its watch root - including the writes a `git pull` makes. Set
    # CLOUDE_DEV_RELOAD=1 in .env for local development only. See
    # tests/test_no_reload_in_production.py, which fails the build if this
    # is ever wired to a hardcoded True instead of this setting again.
    dev_reload: bool = Field(default=False, alias="CLOUDE_DEV_RELOAD")

    # Session Configuration
    default_working_dir: str  # Required in .env
    session_timeout: int = 3600  # seconds (1 hour)

    # Logging Configuration
    log_buffer_size: int = 1000  # lines to keep in memory
    log_file_retention: int = 7  # days
    # Minimum structlog level printed to stdout/stderr (captured by launchd
    # into launchd.log under production - see cloude-code.sh). "INFO" is the
    # production default: per-poll-cycle debug events like
    # idle_watcher.poll_suppressed fire roughly once a second per open
    # session and are the dominant contributor to that file's growth.
    # Set LOG_LEVEL=DEBUG in .env for local troubleshooting.
    log_level: str = "INFO"
    # Opt-in verbose tracing for the paths that fail SILENTLY - a hook that
    # fires and delivers nothing, a spawn whose env is present but stale.
    # Separate from log_level on purpose: raising that to DEBUG also
    # unmutes every per-second poller into launchd.log, which is what made
    # that file unreadable. Writes to <state_dir>/debug/trace.jsonl.
    # See src/core/debug_trace.py and docs/debugging.md.
    cloude_debug: str = ""
    # LEGACY (feat/state-directory) - no longer the write target for
    # application state. See get_state_dir(). Optional now: a fresh
    # install never needs to set this. Kept ONLY as the "old location"
    # fallback for the three name-keyed JSON state files
    # (session_metadata.json / pinned_themes.json / unread_state.json)
    # so an existing pre-feat/state-directory install keeps working
    # without a manual migration step.
    log_directory: Optional[str] = None

    # State directory override (feat/state-directory). When set, this is
    # the ONE source of truth for where CloudeCode's durable state lives
    # (session/pinned-theme/unread JSON, refresh_tokens.db, and the
    # upcoming cloude.db) - see get_state_dir(). When unset, the default
    # is the macOS-native ``~/Library/Application Support/CloudeCode``.
    # Same env var name and identical precedence must be honored by
    # scripts/upgrade_lib/upgrade_rollback_common.sh's resolve_state_dir()
    # - see tests/test_state_dir_drift.py, the test that keeps the two
    # resolvers from drifting apart.
    state_dir_override: Optional[str] = Field(default=None, alias="CLOUDE_STATE_DIR")

    # Security Configuration
    api_key: Optional[str] = None
    # CORS allowed origins. Default is computed from HOST/PORT + local
    # hostname variants (see ``_compute_default_allowed_origins``). The
    # default NEVER includes "*", because the CORS middleware is wired with
    # ``allow_credentials=True`` and the wildcard-with-credentials combo is
    # a well-known footgun that lets any LAN neighbor fire credentialed
    # XHRs at the API. To override (e.g. to add a tunnel hostname), set
    # the ``ALLOWED_ORIGINS`` env var to a comma-separated list - that
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
    # LEGACY (v3.1) - no longer consulted for agent_type == "claude" (see
    # get_agent_command / AgentsConfig.claude_command). Kept for .env
    # back-compat; setting CLAUDE_CLI_PATH is now a silent no-op.
    claude_cli_path: Optional[str] = None

    _auth_config_cache: Optional[AuthConfig] = None

    # One decision per name-keyed state file, made ONCE and remembered.
    # See _resolve_state_file() for the full contract and for why a
    # per-call re-derivation was a bug rather than a style choice.
    # Keyed by (filename, state_dir_override, log_directory) so that
    # repointing either configured directory legitimately asks a new
    # question, while anything HAPPENING TO THE FILES does not.
    _state_file_pins: Optional[dict] = None

    # ---- CORS ------------------------------------------------------------

    @property
    def allowed_origins(self) -> List[str]:
        """The CORS allowed-origins list, override or computed.

        Inputs: none.
        Output: list[str] - never contains ``"*"``, see the resolver.
        """
        return _state_paths.allowed_origins(
            self.allowed_origins_override, self.host, self.port
        )

    # ---- directories and the name-keyed state files ----------------------

    def get_working_dir(self) -> Path:
        """The projects root, expanded and created if absent.

        Inputs: none.
        Output: Path - an existing directory.
        """
        return _state_paths.working_dir(self.default_working_dir)

    def get_state_dir(self) -> Path:
        """The durable state directory, resolved and ensured.

        Inputs: none (reads ``state_dir_override``).
        Output: Path - existing and writable.
        Raises:
            StateDirUnavailableError: it could not be created.
        """
        return _state_paths.state_dir(self.state_dir_override)

    def get_log_dir(self) -> Path:
        """LEGACY alias for :meth:`get_state_dir`, kept for its callers.

        Inputs: none.
        Output: Path.
        """
        return self.get_state_dir()

    def _state_file_pin(self, filename: str) -> tuple:
        """Decide ONCE where one name-keyed state file lives, then keep it.

        Description: this object owns the cache,
          :func:`src.config.state_paths.state_file_pin` owns the rule.
        Inputs: filename (str) - e.g. "pinned_themes.json".
        Output: tuple[Path, str] - the path and its location.
        """
        if self._state_file_pins is None:
            self._state_file_pins = {}
        return _state_paths.state_file_pin(
            filename,
            pins=self._state_file_pins,
            resolved_state_dir=self.get_state_dir(),
            state_dir_override=self.state_dir_override,
            log_directory=self.log_directory,
        )

    def get_state_file_location(self, filename: str) -> str:
        """Which of the two locations is AUTHORITATIVE for ``filename``.

        Description: lets a caller ask without re-running the precedence
          rules itself, which is how the relocation bug happened.
        Inputs: filename (str) - e.g. "session_metadata.json".
        Output: str - ``"state_dir"`` or ``"log_directory"``.
        """
        return self._state_file_pin(filename)[1]

    def _resolve_state_file(self, filename: str) -> Path:
        """The path a name-keyed state file is read from and written to.

        Inputs: filename (str).
        Output: Path.
        """
        return self._state_file_pin(filename)[0]

    def get_refresh_tokens_path(self) -> Path:
        """The refresh-token revocation database, through the pin.

        Description: the pin is what gives it the old ``log_directory``
          fallback. Without one, an install predating the state directory
          got a BRAND NEW EMPTY database on its next start and abandoned
          every issued refresh token. A file one directory over is not a
          file being gone.
        Inputs: none.
        Output: Path.
        """
        return self._resolve_state_file("refresh_tokens.db")

    def get_session_metadata_path(self) -> Path:
        """The session metadata JSON file, through the pin.

        Inputs: none.
        Output: Path.
        """
        return self._resolve_state_file("session_metadata.json")

    def get_pinned_themes_path(self) -> Path:
        """The pinned-themes JSON file, through the pin.

        Inputs: none.
        Output: Path.
        """
        return self._resolve_state_file("pinned_themes.json")

    def get_unread_state_path(self) -> Path:
        """The unread-state JSON file, through the pin.

        Inputs: none.
        Output: Path.
        """
        return self._resolve_state_file("unread_state.json")

    # ---- agent launch ----------------------------------------------------

    def get_claude_cli_path(self) -> str:
        """LEGACY. Locate the Claude CLI binary.

        Description: nothing on the launch path calls this, so
          ``CLAUDE_CLI_PATH`` is a silent no-op for sessions.
        Inputs: none.
        Output: str.
        """
        return _agent_command.claude_cli_path(self.claude_cli_path)

    def get_agent_command(
        self,
        agent_type: Optional[str],
        model: Optional[str] = None,
        extra_args: Optional[List[str]] = None,
    ) -> str:
        """The shell command string that launches one agent type.

        Description: the ladder is
          :func:`src.config.agent_command.agent_command`. This resolves
          the agents block, tolerating a load failure, and passes the two
          lazily-read inputs as callables.

          NOTE FOR CALLERS: this deliberately falls back to the default
          wrapper for an UNKNOWN ``agent_type``, which is right for a
          launch and wrong for a picker. Validate a user-supplied id
          through ``session_agent_choice.validate_agent_choice`` first.
        Inputs: agent_type (str | None); model (str | None); extra_args
          (list[str] | None).
        Output: str - one shell string for tmux's ``new-session``.
        Raises:
            ValueError: the resolved family needs a model and got none.
        Example: settings.get_agent_command("claude-chrome")
        """
        # Tolerate an auth-config load failure so a degraded environment
        # (config.json missing in a unit-test path) still launches.
        try:
            agents = self.load_auth_config().agents
        except Exception:  # noqa: BLE001 - deliberate fallback, see above
            agents = AgentsConfig()
        return _agent_command.agent_command(
            agent_type,
            agents=agents,
            resolve_state_dir=lambda: str(self.get_state_dir()),
            disable_alternate_screen=(
                lambda: self.load_auth_config().session.disable_alternate_screen
            ),
            model=model,
            extra_args=extra_args,
        )

    # ---- the auth config, and its cache ----------------------------------

    def load_auth_config(self) -> AuthConfig:
        """The whole of config.json plus the .env secrets, cached.

        Description: this object owns the cache,
          :mod:`src.config.auth_loader` does the parsing. Every writer is
          called from this class so the cache is invalidated in the same
          breath as the write.
        Inputs: none.
        Output: AuthConfig.
        Raises:
            FileNotFoundError: config.json does not exist.
            ValueError: invalid JSON, or a missing secret.
        """
        if self._auth_config_cache is not None:
            return self._auth_config_cache
        auth_config = _auth_loader.load(
            Path(self.auth_config_file).expanduser(),
            totp_secret=self.totp_secret,
            jwt_secret=self.jwt_secret,
        )
        self._auth_config_cache = auth_config
        return auth_config

    # ---- provider models -------------------------------------------------

    def get_provider_models(self) -> List[str]:
        """The persisted OpenRouter model ids, "Claude" never included.

        Inputs: none.
        Output: list[str].
        """
        return list(self.load_auth_config().providers.models)

    def add_provider_model(self, model: str) -> List[str]:
        """Add an OpenRouter model id, and drop the cached config.

        Inputs: model (str) - already format-validated by the route.
        Output: list[str] - the updated list.
        Raises:
            FileNotFoundError: config.json does not exist.
            ValueError: already present, or invalid JSON.
        """
        models = _provider_models.add(
            Path(self.auth_config_file).expanduser(), model
        )
        self._auth_config_cache = None
        return models

    def remove_provider_model(self, model: str) -> List[str]:
        """Remove an OpenRouter model id, and drop the cached config.

        Inputs: model (str).
        Output: list[str] - the updated list.
        Raises:
            FileNotFoundError: config.json does not exist.
            ValueError: not present, or invalid JSON.
        """
        models = _provider_models.remove(
            Path(self.auth_config_file).expanduser(), model
        )
        self._auth_config_cache = None
        return models

    # ---- the settings screen ---------------------------------------------

    @staticmethod
    def _mask_secret(value: str) -> dict:
        """Reduce a secret string to a UI-safe presence flag.

        Inputs: value (str) - "" if unset.
        Output: dict - ``{"configured": bool}``.
        """
        return _summary.mask_secret(value)

    def _family_summaries(self, agents: AgentsConfig) -> List[dict]:
        """The family registry with each family's live state.

        Inputs: agents (AgentsConfig) - the loaded agents block.
        Output: list[dict] - one entry per family.
        """
        return _summary.family_summaries(agents, self.get_agent_command)

    def get_settings_summary(self) -> dict:
        """The payload for ``GET /api/v1/config/settings``.

        Description: the shape is :mod:`src.config.summary`. The two
          things only this object can answer - the live bind address and
          what a claude launch resolves to right now - are passed in.
        Inputs: none.
        Output: dict.
        Raises:
            FileNotFoundError: config.json is missing.
        """
        # Imported here rather than at module scope: setup_state imports
        # settings from this package, so a top-level import is circular.
        from src.core.setup_state import recorded_bound_host  # noqa: PLC0415

        config = self.load_auth_config()
        return _summary.settings_summary(
            config,
            host=self.host,
            port=self.port,
            effective_claude_command=self.get_agent_command("claude"),
            families=self._family_summaries(config.agents),
            bound_host=recorded_bound_host(),
        )

    def update_settings_config(
        self,
        agents_update: Optional[dict] = None,
        notifications_update: Optional[dict] = None,
        workspace_update: Optional[dict] = None,
        server_prefs_update: Optional[dict] = None,
    ) -> dict:
        """Merge partial block updates into config.json and repaint.

        Description: :mod:`src.config.config_writes` does the merge, the
          validation and the atomic write. The cache is dropped BEFORE
          the summary is recomputed, so what comes back is the
          post-write state rather than the parse from before it.
        Inputs: agents_update, notifications_update, workspace_update,
          server_prefs_update (dict | None) - the keys the client set.
        Output: dict - the settings summary AFTER the write.
        Raises:
            FileNotFoundError: config.json is missing.
            ValueError: invalid JSON, or a merged block fails validation.
        Security: never logs a value from ``notifications_update``.
        """
        _config_writes.update_settings_config(
            Path(self.auth_config_file).expanduser(),
            agents_update=agents_update,
            notifications_update=notifications_update,
            workspace_update=workspace_update,
            server_prefs_update=server_prefs_update,
        )
        self._auth_config_cache = None
        return self.get_settings_summary()

    # ---- launch wrappers -------------------------------------------------

    def _read_config_dict(self, config_path: Path) -> dict:
        """Read and parse config.json.

        Inputs: config_path (Path).
        Output: dict.
        Raises:
            FileNotFoundError: it does not exist.
            ValueError: invalid JSON.
        """
        from src.config.config_file import read_config  # noqa: PLC0415

        return read_config(config_path)

    def _mutate_wrappers(
        self, mutation: Callable[[List[dict]], List[dict]]
    ) -> List[dict]:
        """Apply a pure wrapper-list mutation, persist, drop the cache.

        Inputs: mutation (Callable[[list[dict]], list[dict]]).
        Output: list[dict] - the updated wrapper list.
        Raises:
            FileNotFoundError: config.json does not exist.
            ValueError: from the mutation, or invalid JSON.
        """
        updated = _wrappers.mutate(
            Path(self.auth_config_file).expanduser(), mutation
        )
        self._auth_config_cache = None
        return updated

    def add_wrapper(self, wrapper: AgentWrapper) -> List[dict]:
        """Add a launch wrapper to ``agents.wrappers``.

        Description: a RESERVED id is rejected because those resolve as
          bare FAMILY names before any wrapper lookup, so such a wrapper
          could never launch.
        Inputs: wrapper (AgentWrapper) - already field-validated.
        Output: list[dict] - the updated wrapper list.
        Raises:
            FileNotFoundError: config.json does not exist.
            ValueError: duplicate id, reserved id, or invalid JSON.
        """
        return self._mutate_wrappers(
            lambda ws: wrapper_store.add(
                ws, wrapper.model_dump(), RESERVED_AGENT_TYPES
            )
        )

    def update_wrapper(self, wrapper_id: str, wrapper: AgentWrapper) -> List[dict]:
        """Replace an existing wrapper's fields. The id is immutable.

        Description: renaming is delete-plus-add, because the id is also
          the script filename and the value in ``Session.agent_type``.
        Inputs: wrapper_id (str); wrapper (AgentWrapper) - its ``id``
          MUST equal ``wrapper_id``.
        Output: list[dict] - the updated wrapper list.
        Raises:
            FileNotFoundError: config.json does not exist.
            ValueError: not found, id mismatch, or invalid JSON.
        """
        return self._mutate_wrappers(
            lambda ws: wrapper_store.update(ws, wrapper_id, wrapper.model_dump())
        )

    def delete_wrapper(self, wrapper_id: str) -> List[dict]:
        """Remove a wrapper from ``agents.wrappers``.

        Description: promotion of a replacement default never crosses a
          family boundary; see ``wrapper_store.delete``.
        Inputs: wrapper_id (str).
        Output: list[dict] - may be empty.
        Raises:
            FileNotFoundError: config.json does not exist.
            ValueError: not found, or invalid JSON.
        """
        return self._mutate_wrappers(lambda ws: wrapper_store.delete(ws, wrapper_id))

    def set_default_wrapper(self, wrapper_id: str) -> List[dict]:
        """Make one wrapper its FAMILY's default, clearing that family only.

        Description: clearing the flag list-wide would strip claude's
          default the moment a codex wrapper was made default.
        Inputs: wrapper_id (str).
        Output: list[dict] - the updated wrapper list.
        Raises:
            FileNotFoundError: config.json does not exist.
            ValueError: not found, or invalid JSON.
        """
        return self._mutate_wrappers(
            lambda ws: wrapper_store.set_default(ws, wrapper_id)
        )

    # ---- terminal commands -----------------------------------------------
    #
    # Thin delegation: the schema, validation, seed list and atomic write
    # all live in src/core/terminal_commands.py, which also documents WHY
    # none of this ever runs a command server-side. Read that module's
    # docstring before adding anything here.

    def get_terminal_commands(self) -> List[TerminalCommand]:
        """The configured terminal commands, in display order.

        Inputs: none.
        Output: list[TerminalCommand] - the seed defaults when config.json
          has no ``terminal_commands`` block.
        Raises:
            FileNotFoundError: config.json is missing.
        """
        return list(self.load_auth_config().terminal_commands)

    def get_terminal_command(
        self, command_id: Optional[str]
    ) -> Optional[TerminalCommand]:
        """Resolve one terminal command by id, for a console launch.

        Description: the ONLY way a stored command string is read for
          execution. The caller supplies an ID, never a command string,
          so nothing a client invents can reach a shell. An unknown id is
          None, which callers treat as "run nothing" rather than failing
          the launch over an entry deleted in another tab.
        Inputs: command_id (str | None) - from the launch request.
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
        """Persist a whole new terminal-command list, then drop the cache.

        Inputs: raw (list[dict]) - the complete new list, display order.
        Output: list[dict] - the validated, persisted list.
        Raises:
            FileNotFoundError: config.json is missing.
            ValueError: a malformed entry.
        """
        persisted = _replace_terminal_commands(
            Path(self.auth_config_file).expanduser(), raw
        )
        self._auth_config_cache = None
        return persisted
