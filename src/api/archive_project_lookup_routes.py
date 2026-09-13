"""``GET /api/v1/archive/projects/for-cwd`` - one folder to one project.

ITS OWN MODULE, and its own router, for one reason worth stating: this
is the only archive route a NON-ARCHIVE screen calls. The terminal's
search panel asks it whether the session the user is looking at has any
archived conversations, and hides its "Deep dive" control when the
answer is no. Keeping it beside the message browser's read surface would
have put a terminal dependency inside the file whose header says every
handler there serves the browser.

IT OBEYS THE ARCHIVE'S FOUR STANDING PROMISES ANYWAY, because they are
the archive's, not that file's: ``response_model=None`` so FastAPI
cannot filter the envelope's ``meta`` and ``unevaluated`` blocks away,
``Depends(require_auth)`` because a project path is the owner's private
directory layout, the sqlite work inside ``asyncio.to_thread`` because a
blocking read here stalls every live terminal WebSocket in the process,
and the status mapping through the shared ``respond`` so this route
cannot answer 200 for something the others call a 400.

MOUNTED INSIDE ``MESSAGE_ARCHIVE.enabled``, like every sibling, so an
install that opted out of the archive 404s this path rather than serving
a lookup into a datastore it was told not to read.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from src.api.archive_support import respond, state_dir
from src.api.auth import require_auth
from src.core import archive_cwd_lookup
from src.core.archive_read import run_read

router = APIRouter()


@router.get("/archive/projects/for-cwd", response_model=None,
            dependencies=[Depends(require_auth)])
async def get_project_for_cwd(
    cwd: str = Query(..., min_length=1, max_length=4096),
) -> JSONResponse:
    """The archived project whose folder is this working directory.

    Description: answers the one question a live session can ask the
      archive - "is there history for where I am". The match is not a
      string comparison: ``~/Development`` is a symlink into iCloud on
      the owner's box, so one directory has several literal spellings and
      a transcript records whichever one was in force when it was
      written. See ``src.core.archive_cwd_lookup`` for the ladder.

      A MISS IS A 200 WITH A NULL RESULT, NOT A 404 AND NOT A REFUSAL.
      "no project holds this folder" is a complete answer to the
      question asked, and the caller acts on it by disabling a control.
      A ``cannot_determine`` envelope means something different and
      stays reachable underneath: the datastore would not open. Only the
      second is a fault, and a client that could not tell them apart
      would report a database problem every time the user opened a
      terminal in a brand new folder.

      ``max_length`` is a bound rather than a validation. macOS caps a
      path at 1024 bytes; 4096 accepts anything real and stops an
      unbounded query string reaching a filesystem call.
    Inputs: cwd (str) - the session's working directory, as the session
      records it. Output: JSONResponse carrying the three-outcome
      envelope; ``result`` is null or the node's ``project_id``,
      ``display_name``, ``full_path``, ``observed_cwd`` and
      ``matched_by``, and ``meta.matched_by`` repeats the rung so a
      caller can read it without unpacking a nullable result.
    Example: GET /api/v1/archive/projects/for-cwd?cwd=%2FUsers%2Fx%2FP
    """
    result = await asyncio.to_thread(
        run_read, state_dir(), archive_cwd_lookup.project_for_cwd, cwd,
        subject="cwd", unreadable_result=None,
    )
    # The cwd is the owner's private directory layout and the matched
    # node's path is the same thing again, so neither is logged. The rung
    # that answered is not sensitive and is the only field worth having
    # when this route is reported as picking the wrong project.
    return respond(
        result,
        route="project-for-cwd",
        matched_by=(result.get("meta") or {}).get("matched_by"),
    )
