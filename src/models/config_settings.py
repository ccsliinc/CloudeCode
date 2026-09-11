"""The ``PATCH /config/settings`` body and its four sub-blocks."""

from typing import Optional, Dict
from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# Settings screen (feat/settings-screen) - GET/PATCH /config/settings.
#
# Two update sub-models (AgentCommandsUpdate, NotificationSecretsUpdate)
# mirror the PATCH-semantics already established by UpdateProjectRequest:
# a field OMITTED from the request body means "leave unchanged"; a field
# explicitly SENT (including empty string) is applied verbatim. The route
# handler distinguishes the two cases via ``model_fields_set`` (Pydantic
# v2), not by treating None specially, since None/"" are both valid
# values for some of these fields (e.g. clearing ``claude_command`` back
# to the cld/cldor fallback is an explicit empty-string write).
#
# ``extra="forbid"`` on every one of these - a payload with an unknown
# key is a 422, not a silent no-op merge. This is the "strict payload,
# reject unknown keys" requirement from the settings-screen spec.
# --------------------------------------------------------------------------- #


class AgentCommandsUpdate(BaseModel):
    """PATCH body sub-block for ``AuthConfig.agents``.

    All four fields are optional and independently settable; omit a
    field to leave it unchanged. ``claude_command`` MAY be sent as an
    empty string to explicitly clear it back to the cld/cldor fallback
    (see ``Settings.get_agent_command``) - that is a legitimate, common
    settings-screen action, not an error. The other three commands have
    no such fallback (an empty command would just fail to launch), so
    the route handler rejects a blank value for them.
    """
    model_config = {"extra": "forbid"}

    claude_command: Optional[str] = Field(
        None, description="Empty string clears back to the cld/cldor fallback"
    )
    codex_command: Optional[str] = Field(None, description="Must be non-blank if provided")
    hermes_command: Optional[str] = Field(None, description="Must be non-blank if provided")
    openclaw_command: Optional[str] = Field(None, description="Must be non-blank if provided")


class NotificationSecretsUpdate(BaseModel):
    """PATCH body sub-block for ``AuthConfig.notifications``.

    Secret-shaped fields (``ntfy_topic``, ``slack_webhook_url``,
    ``pushover_token``, ``pushover_user_key``) are write-only from the
    client's perspective - the GET side of this endpoint never echoes
    them back in plain text (see ``Settings.get_settings_summary``'s
    masking). "Leave unchanged" is expressed by omitting the field
    entirely; sending an empty string is an explicit clear (disables
    that channel). Applies live to config.json on write, but the
    running ``NotificationRouter`` was constructed once at process
    startup with a snapshot of this block (see ``src/main.py`` lifespan)
    and does not hot-reload it - a restart is required, surfaced in the
    settings UI next to this section.
    """
    model_config = {"extra": "forbid"}

    enabled: Optional[bool] = None
    ntfy_base_url: Optional[str] = None
    ntfy_topic: Optional[str] = None
    slack_webhook_url: Optional[str] = None
    pushover_token: Optional[str] = None
    pushover_user_key: Optional[str] = None


class WorkspaceUpdate(BaseModel):
    """PATCH body sub-block for ``AuthConfig.workspace``.

    "Leave unchanged" is omission, as everywhere else on this endpoint;
    an explicit empty string clears a field back to "not configured",
    which is a meaningful state here (an unset development root means the
    app behaves exactly as it did before the setting existed).

    ``env`` is the exception to the omit/merge rule: it is sent WHOLE or
    not at all, because a key-wise merge has no way to express deleting a
    row. Values are validated in ``src/core/workspace_settings.py`` at
    the route boundary and are never logged.
    """

    model_config = {"extra": "forbid"}

    development_root: Optional[str] = None
    default_shell: Optional[str] = None
    default_editor: Optional[str] = None
    env: Optional[Dict[str, str]] = None


class ServerPrefsUpdate(BaseModel):
    """PATCH body sub-block for ``AuthConfig.server_prefs``.

    Writing ``bind_host`` records a PREFERENCE. It cannot widen an
    instance's exposure: the address actually bound is resolved once by
    ``src/core/setup_state.resolve_exposure``, downstream of this value,
    and that function pins loopback until setup is complete. Nor does it
    move a live socket - uvicorn binds once, so the change applies on the
    next restart and the UI must say so.
    """

    model_config = {"extra": "forbid"}

    bind_host: Optional[str] = None
    tls_preferred: Optional[bool] = None


class ConfigSettingsUpdateRequest(BaseModel):
    """Request body for ``PATCH /api/v1/config/settings``.

    Top-level keys are the only two writable blocks the settings screen
    exposes (``agents``, ``notifications``) - HOST/server bind is
    deliberately absent: it lives in ``.env``, not ``config.json``, has
    no atomic-write convention in this codebase, and a bad value can
    strand the server (the launchd wrapper refuses to boot on a
    wildcard bind). The settings screen shows HOST read-only instead of
    exposing it here. ``extra="forbid"`` rejects any other top-level key
    outright rather than silently ignoring it.
    """
    model_config = {"extra": "forbid"}

    agents: Optional[AgentCommandsUpdate] = None
    notifications: Optional[NotificationSecretsUpdate] = None
    # feat/settings-gui. Note that the docstring above says server bind is
    # "deliberately absent" - that remains true of the .env HOST value it
    # was written about. ``server_prefs.bind_host`` is a different thing:
    # a remembered PREFERENCE in config.json, written through the same
    # atomic tmp+fsync+replace path as every other block here, and clamped
    # by resolve_exposure before it can ever become a listening socket.
    workspace: Optional[WorkspaceUpdate] = None
    server_prefs: Optional[ServerPrefsUpdate] = None
