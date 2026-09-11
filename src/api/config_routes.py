"""The stored command lists the client offers.

``/config/common-commands`` is the favourites list, and
``/config/slash-commands`` reads the slash commands available in a
project. Neither endpoint RUNS anything: a stored command reaches a shell
only by being typed into a console session the user is watching.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pathlib import Path
from src.config import settings
from src.core import slash_favorites
from src.core.slash_command_discovery import (
    build_command_groups,
    command_groups_to_dict,
)
from src.models import ToggleFavoriteCommandRequest
from typing import Optional

from src.api.auth import require_auth

logger = structlog.get_logger()
router = APIRouter()


def _config_path() -> Path:
    """The config.json path the favorites routes read and write.

    Description: favorites are read from the FILE rather than through
      ``Settings.load_auth_config`` because the parsed model cannot tell
      an absent ``common_slash_commands`` key from an empty one, and
      those two states mean opposite things. See
      ``src/core/slash_favorites.py``.
    Inputs: none.
    Output: Path - expanded path to config.json.
    """
    return Path(settings.auth_config_file).expanduser()


@router.get("/config/common-commands", dependencies=[Depends(require_auth)])
async def get_common_commands():
    """
    Get the user's starred slash commands, with short descriptions.

    Response shape:
        ``commands``         - flat list of command strings. UNCHANGED
                               from the original response, so any client
                               written against the old shape keeps working.
        ``command_details``  - parallel list of
                               ``{"command", "description"}`` objects,
                               added for the mobile chip labels.
        ``defaulted``        - True when the user has never starred
                               anything and these are the built-in
                               defaults. Lets the UI say so instead of
                               implying the user picked them.

    Config entries may be bare strings (historical form) or objects with
    a user-authored ``description``; see
    ``src/core/slash_command_labels.py``.

    Raises:
        HTTPException: If config loading fails
    """
    try:
        body = slash_favorites.payload(_config_path())
        logger.debug(
            "common_commands_retrieved",
            count=len(body["commands"]), defaulted=body["defaulted"],
        )
        return body

    except FileNotFoundError as e:
        logger.error("auth_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Configuration not found. Run setup_auth.py first."
        )
    except Exception as e:
        logger.error("common_commands_retrieval_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve common commands: {str(e)}"
        )


@router.post("/config/common-commands/favorite", dependencies=[Depends(require_auth)])
async def toggle_favorite_command(body: ToggleFavoriteCommandRequest):
    """
    Star or unstar one slash command, and return the new chip row.

    Replaces the hand-picked ``common_slash_commands`` notion with a
    user-chosen one: the SAME config key, written by a star in the
    palette instead of by hand-editing JSON. Every existing entry is
    preserved in its original form (bare string or
    ``{"command", "description"}`` object); a newly starred command is
    appended as a bare string, which is the historical form.

    Starring the first time on a config that never declared the key
    MATERIALIZES the built-in defaults first, so unstarring one of them
    actually removes it rather than writing a list that still contains
    it. An empty result is kept as an empty DECLARED list, never
    re-seeded - the user unstarred everything on purpose.

    Returns the same body as ``GET /config/common-commands`` so the
    client repaints from the authoritative post-write state rather than
    guessing what it just did.

    Raises:
        HTTPException: 400 on a blank command or past the favorites cap,
            500 if config.json is missing or unreadable.
    """
    try:
        path = _config_path()
        raw, declared = slash_favorites.read_raw(path)
        entries = slash_favorites.toggle(raw, declared, body.command, body.favorite)
        slash_favorites.write(path, entries)
        # The cache holds a parsed AuthConfig carrying the OLD list; any
        # other reader of common_slash_commands would otherwise serve a
        # stale row until the process restarts.
        settings._auth_config_cache = None
        result = slash_favorites.payload(path)
        logger.info(
            "common_command_favorite_toggled",
            command=body.command, favorite=body.favorite,
            count=len(result["commands"]),
        )
        return result
    except slash_favorites.FavoritesError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        logger.error("auth_config_missing", error=str(e))
        raise HTTPException(
            status_code=500,
            detail="Configuration not found. Run setup_auth.py first."
        )
    except ValueError as e:
        logger.error("common_command_favorite_config_invalid", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/config/slash-commands", dependencies=[Depends(require_auth)])
async def get_slash_commands(project_path: Optional[str] = None):
    """
    Get the full slash-command palette: built-in/skill/workflow commands
    scraped from the official docs at release time, merged with commands
    and skills discovered on THIS machine at request time (user scope,
    installed plugins, and - when `project_path` is given - that
    project's own `.claude/commands` and `.claude/skills`).

    A separate endpoint from `/config/common-commands` (Task 2's decision,
    see project docs): common-commands is a small hand-curated "favorites"
    row shown at the top of the palette and its response shape (a bare
    list of command strings) stays exactly as-is for existing consumers.
    This endpoint serves the full palette body underneath it, grouped for
    direct rendering - a different shape for a different purpose, not a
    breaking change to the old one.

    Args:
        project_path: absolute path to the currently active project's
            working directory, used for project-scope discovery. Omit to
            skip project-scope entirely (e.g. before any session is open).

    Returns:
        {"groups": [{"id", "label", "commands": [{"command", "args",
        "description", "type", "alias_of"}, ...]}, ...]} in a fixed
        group order - see `build_command_groups()`.

    Raises:
        HTTPException: on unexpected discovery failure. Missing/partial
            data sources (no plugins installed, no project scope, a
            stale/absent scraped JSON) are NOT errors - they just yield
            fewer groups.
    """
    try:
        groups = build_command_groups(project_path=project_path)
        payload = command_groups_to_dict(groups)
        logger.debug(
            "slash_commands_retrieved",
            group_count=len(payload),
            command_count=sum(len(g["commands"]) for g in payload),
            project_scoped=bool(project_path),
        )
        return {"groups": payload}
    except Exception as e:
        logger.error("slash_commands_retrieval_error", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve slash commands: {str(e)}"
        )
