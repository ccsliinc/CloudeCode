"""Live tmux sessions in one working directory, for the launcher.

``GET /sessions/background`` answers "is something already running
here" for a project card, so the launcher can offer ATTACH rather than
silently creating a second session beside the one the user is already
in. It reads the live listing and nothing stored.
"""

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from src.api.auth import require_auth
from typing import Optional

router = APIRouter()


@router.get(
    "/sessions/background",
    dependencies=[Depends(require_auth)],
)
async def list_background_sessions(request: Request, cwd: Optional[str] = None):
    """Claude background sessions - the ones with no tmux session.

    Description: `/fork` inside a session creates a real Claude session
      that runs without a terminal of its own. CloudeCode records it with
      a NULL creation epoch, which by its own listing predicate means not
      listed - so until now a user who forked had created work the GUI
      would never show them.

      ALWAYS 200 on a reachable server. Branch on ``measured``, never on
      an empty ``sessions`` list: "the query failed" and "there are none"
      are different facts, and rendering the first as the second tells
      the user nothing is running while an agent burns tokens. The same
      rule the local-models endpoint already follows.
    Inputs: cwd (str | None) - restrict to sessions started under a path.
    Output: ``{measured, status, detail, sessions[]}``.
    """
    from src.core.background_agents import list_background_agents

    result = await run_in_threadpool(list_background_agents, cwd=cwd)
    return {
        "measured": result.measured,
        "status": result.status,
        "detail": result.detail,
        "sessions": [
            {
                "session_id": a.session_id,
                "short_id": a.short_id,
                "name": a.name,
                "cwd": a.cwd,
                "status": a.status,
                "state": a.state,
                "pid": a.pid,
                "started_at_ms": a.started_at_ms,
            }
            for a in result.agents
        ],
    }
