"""Read and write the workspace settings block.

``PATCH /config/settings`` is the one route that writes the user's whole
configuration, so it inherits the rule the rest of this repo copies:
``Settings.update_settings_config`` writes the ``.bak`` of the pre-write
bytes FIRST, then a temp file, then ``fsync``, then ``os.replace``. A
half-written ``config.json`` costs the user their entire setup, so there
is no "just dump the JSON" shortcut here or anywhere.

``_AGENT_COMMAND_NO_FALLBACK_FIELDS`` names the fields that must not fall
back to a default when they are absent, because for those a silent
default is a different behaviour wearing the same name.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException
from src.config import settings
from src.core.workspace_settings import (
    WorkspaceValidationError,
    validate_bind_host,
    validate_development_root,
    validate_editor,
    validate_env_map,
    validate_shell,
)
from src.models import ConfigSettingsUpdateRequest

from src.api.auth import require_auth

logger = structlog.get_logger()
router = APIRouter()


# ---------------------------------------------------------------------------
# Settings screen (feat/settings-screen) - the config write path.
#
# No config WRITE endpoint existed before this: every prior config.json
# mutation (add_provider_model, update_project, ...) had its own narrow
# route. This is the first general settings surface, so it gets its own
# strict validation instead of accepting an arbitrary merge - see
# ConfigSettingsUpdateRequest's docstring for the "extra=forbid" reasoning.
# ---------------------------------------------------------------------------

_AGENT_COMMAND_NO_FALLBACK_FIELDS = ("codex_command", "hermes_command", "openclaw_command")


@router.get("/config/settings", dependencies=[Depends(require_auth)])
async def get_settings():
    """
    Get the settings-screen payload: agent launch commands, notification
    channel config (secrets masked), and the server bind address
    (read-only - see ``Settings.get_settings_summary``).

    Returns:
        dict with keys ``agents``, ``notifications``, ``server``.

    Raises:
        HTTPException: 500 if config.json is missing or unreadable.
    """
    try:
        return settings.get_settings_summary()
    except FileNotFoundError as e:
        logger.error("settings_summary_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Configuration not found. Run setup_auth.py first."
        )
    except Exception as e:
        logger.error("settings_summary_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve settings: {str(e)}"
        )


@router.patch("/config/settings", dependencies=[Depends(require_auth)])
async def update_settings(body: ConfigSettingsUpdateRequest):
    """
    Apply a partial update to the ``agents`` and/or ``notifications``
    blocks of config.json.

    Only the fields the client actually SET are written (Pydantic's
    ``model_fields_set``, not "is not None") - this is what makes
    omitting a secret field mean "leave unchanged" while still allowing
    an explicit empty-string write to clear it. Unknown top-level or
    nested keys are already rejected by ``ConfigSettingsUpdateRequest``'s
    ``extra="forbid"`` before this handler runs (FastAPI returns 422).

    Args:
        body: partial settings update. Both ``agents`` and
            ``notifications`` are optional; a request with neither is
            a harmless no-op that returns the unchanged summary.

    Returns:
        The full post-write settings summary (same shape as GET).

    Raises:
        HTTPException: 400 on a value that fails validation (e.g. a
            blank codex/hermes/openclaw command - those have no
            fallback, unlike claude_command), 500 on a config.json I/O
            or JSON error.
    """
    agents_update: dict = {}
    if body.agents is not None:
        agents_update = body.agents.model_dump(
            include=body.agents.model_fields_set
        )
        blank_required = [
            field
            for field in _AGENT_COMMAND_NO_FALLBACK_FIELDS
            if field in agents_update and not (agents_update[field] or "").strip()
        ]
        if blank_required:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{', '.join(blank_required)} cannot be blank - only "
                    "claude_command has a built-in fallback"
                ),
            )

    notifications_update: dict = {}
    if body.notifications is not None:
        notifications_update = body.notifications.model_dump(
            include=body.notifications.model_fields_set
        )

    # feat/settings-gui. Validate BEFORE anything reaches disk, and let
    # each failure carry the message that names the specific problem -
    # "development root does not exist: /x", not "invalid settings". A
    # settings screen that accepts a bad value and breaks terminal
    # spawning an hour later is worse than one that refuses now.
    workspace_update: dict = {}
    env_warnings: list = []
    if body.workspace is not None:
        raw_workspace = body.workspace.model_dump(
            include=body.workspace.model_fields_set
        )
        try:
            if "development_root" in raw_workspace:
                workspace_update["development_root"] = validate_development_root(
                    raw_workspace["development_root"]
                )
            if "default_shell" in raw_workspace:
                workspace_update["default_shell"] = validate_shell(
                    raw_workspace["default_shell"]
                )
            if "default_editor" in raw_workspace:
                workspace_update["default_editor"] = validate_editor(
                    raw_workspace["default_editor"]
                )
            if "env" in raw_workspace:
                env_map, env_warnings = validate_env_map(raw_workspace["env"])
                workspace_update["env"] = env_map
        except WorkspaceValidationError as e:
            # Never log the request body: an env VALUE can be a secret.
            logger.info("workspace_settings_rejected", reason=str(e))
            raise HTTPException(status_code=400, detail=str(e))

    server_prefs_update: dict = {}
    if body.server_prefs is not None:
        raw_prefs = body.server_prefs.model_dump(
            include=body.server_prefs.model_fields_set
        )
        try:
            if "bind_host" in raw_prefs:
                server_prefs_update["bind_host"] = validate_bind_host(
                    raw_prefs["bind_host"]
                )
            if "tls_preferred" in raw_prefs:
                server_prefs_update["tls_preferred"] = bool(
                    raw_prefs["tls_preferred"]
                )
        except WorkspaceValidationError as e:
            logger.info("server_prefs_rejected", reason=str(e))
            raise HTTPException(status_code=400, detail=str(e))

    logger.info(
        "settings_update_requested",
        agents_fields=sorted(agents_update.keys()),
        # Never log notification VALUES (several are secrets) - only
        # which field names changed.
        notifications_fields=sorted(notifications_update.keys()),
        # NAMES only, for the same reason - an env value can be a secret,
        # and a structlog line is the last place one should land.
        workspace_fields=sorted(workspace_update.keys()),
        workspace_env_names=sorted((workspace_update.get("env") or {}).keys()),
        server_prefs_fields=sorted(server_prefs_update.keys()),
    )

    try:
        summary = settings.update_settings_config(
            agents_update=agents_update or None,
            notifications_update=notifications_update or None,
            workspace_update=workspace_update or None,
            server_prefs_update=server_prefs_update or None,
        )
        # Warnings ride back on the successful response rather than
        # becoming a fourth outcome. The write HAPPENED; the user needs to
        # see which names the policy flagged, not be told it failed.
        summary["workspace_warnings"] = env_warnings
        return summary
    except FileNotFoundError as e:
        logger.error("settings_update_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Configuration not found. Run setup_auth.py first."
        )
    except ValueError as e:
        logger.error("settings_update_validation_error", error=str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("settings_update_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to update settings: {str(e)}"
        )
