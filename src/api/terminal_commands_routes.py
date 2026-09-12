"""The settings panel's stored terminal command list.

Two endpoints only: read the list, and replace it wholesale, which
covers add, edit, delete and reorder.

SECURITY: neither endpoint runs anything. There is deliberately NO
"execute this command" route. A stored command reaches a shell only by
being typed into a console session the user is watching, addressed by
``CreateSessionRequest.terminal_command_id``.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException
from src.api.auth import require_auth
from src.config import settings
from src.models import (
    ReplaceTerminalCommandsRequest,
    TerminalCommandListResponse,
)

logger = structlog.get_logger()
router = APIRouter()


# ---- terminal commands (feat/settings-tabs-and-commands) ------------------
#
# The settings panel's "terminal" tab. Two endpoints only: read the list,
# and replace it wholesale (which covers add / edit / delete / reorder).
#
# SECURITY: neither endpoint runs anything. There is deliberately NO
# "execute this command" route. A stored command reaches a shell only by
# being typed into a console session the user is watching, addressed by
# ``CreateSessionRequest.terminal_command_id`` - see
# src/core/terminal_commands.py's module docstring before adding anything
# to this section.


@router.get(
    "/terminal/commands",
    response_model=TerminalCommandListResponse,
    dependencies=[Depends(require_auth)],
)
async def list_terminal_commands():
    """List the configured terminal commands, in display order."""
    return TerminalCommandListResponse(
        commands=[c.model_dump() for c in settings.get_terminal_commands()]
    )


@router.put(
    "/terminal/commands",
    response_model=TerminalCommandListResponse,
    dependencies=[Depends(require_auth)],
)
async def replace_terminal_commands(body: ReplaceTerminalCommandsRequest):
    """Replace the whole terminal-command list (add/edit/delete/reorder).

    Raises:
        HTTPException(400): a malformed entry, a bad id, a duplicate id,
            or more entries than the configured cap.
    """
    try:
        commands = settings.replace_terminal_commands(body.commands)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    logger.info("terminal_commands_updated", count=len(commands))
    return TerminalCommandListResponse(commands=commands)
