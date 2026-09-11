"""The workspace and server-preference blocks.

Carved out of the flat ``src/config.py`` by slice S5. Bodies byte-exact."""

from typing import Dict, Optional

from pydantic import BaseModel, Field


class WorkspaceConfig(BaseModel):
    """Global preferences a NEW terminal is born with.

    Every field defaults to the empty string, which means "not
    configured" and reproduces exactly the behaviour that existed before
    this block did - a config.json with no ``workspace`` key is not
    missing anything, it is unconfigured. Validation of these values
    lives in ``src/core/workspace_settings.py`` and runs at the API
    boundary, not here: a pydantic validator that touched the filesystem
    would make merely LOADING a config depend on whether a directory
    still exists, so a removed development root would stop the server
    from starting instead of showing the user a message.

    Fields:
        development_root: Base directory for projects. Reaches a spawned
            terminal as ``CLOUDE_DEV_ROOT``.
        default_shell: Absolute path to the shell new terminals run.
            Reaches a spawned terminal as ``SHELL``.
        default_editor: Command line that opens a file.
        env: Arbitrary NAME=value pairs injected on spawn, layered UNDER
            the app's own control vars.
    """

    development_root: str = ""
    default_shell: str = ""
    default_editor: str = ""
    env: Dict[str, str] = Field(default_factory=dict)


class ServerPrefsConfig(BaseModel):
    """Bind address and TLS preference, remembered across restarts.

    A PREFERENCE, not a decision. ``bind_host`` travels to the Python
    process as the ``HOST`` environment variable and is then resolved -
    exactly once, in ``src/core/setup_state.resolve_exposure`` - into the
    address actually bound. That resolver pins loopback until setup is
    complete and refuses to return an unauthenticated wizard on a
    reachable socket, so nothing stored here can widen the exposure of an
    un-set-up instance. Writing a preference and having it clamped is the
    designed outcome, not a bug.

    ``tls_preferred`` is recorded and NOT in force: this server terminates
    plain HTTP and has no TLS path at all (see macOS/tls-status.js, which
    refuses to draw a padlock it did not measure). The settings screen
    says so on the row rather than showing a switch that quietly does
    nothing.

    Fields:
        bind_host: Remembered bind address, or "" for "app default".
        tls_preferred: Whether the user wants TLS once it exists.
    """

    bind_host: str = ""
    tls_preferred: bool = False
