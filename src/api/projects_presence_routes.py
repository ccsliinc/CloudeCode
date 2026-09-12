"""Which launcher projects have a live session in them.

A read-only join between the launcher's projects and the live session
listing, so a project card can say "running" without the client fetching
both lists and guessing at the match.
"""

from fastapi import APIRouter, Depends
from src.api.auth import require_auth
from src.config import settings
from typing import List

# MODULE SCOPE, DELIBERATELY. run_in_threadpool was imported inside
# individual handlers, so any NEW handler in the same module that used
# it raised ``NameError: name 'run_in_threadpool' is not defined`` -
# which FastAPI turns into a bare 500 with no body. Two routes shipped
# that way and both failed with three digits and nothing to act on.
# tests/test_route_names_resolve.py fails the build if a module uses
# this name without binding it here.
from fastapi.concurrency import run_in_threadpool

router = APIRouter()


@router.get("/projects/presence", dependencies=[Depends(require_auth)])
async def get_projects_presence() -> dict:
    """Live-probe every DB-tracked project's filesystem presence.

    feat/projects-table (S3), design section 4.1. Re-stats every
    ``projects`` row's root right now - the stored ``presence`` column
    is a cache and this endpoint never trusts it stale - and reports one
    of four named states per row: ``present``, ``missing``,
    ``unreachable`` or ``unchecked``. ``missing`` and ``unreachable`` are
    never collapsed into each other: a project behind a permission wall
    or on a sleeping external volume reports ``unreachable`` with its
    errno named in ``presence_detail``, never ``missing``. This route
    only READS the shadow table; config.json is not touched here and
    stays authoritative for writes (see src/core/project_store.py).

    Returns:
        dict - ``{"status": "ok" | "unreachable", "projects": [...],
        "detail": str | None}``. ``status: "unreachable"`` means
        cloude.db itself could not be opened for this request at all -
        a distinct, database-level outcome from any individual
        project's own presence value.
    """
    from contextlib import closing


    from src.core import project_store
    from src.core.db import DatastoreUnreadableError, connect, db_path_for

    def _open_probe_and_close() -> List[dict]:
        """Connect, refresh presence, and close - all on ONE worker thread.

        Description: sqlite3 connections are thread-affine
          (check_same_thread defaults to True in src.core.db.connect), so
          connect/use/close must happen inside a single
          run_in_threadpool call rather than three separate ones - a
          connection opened on one pooled thread cannot be closed from
          another.
        Inputs: none (closes over db_path).
        Output: list[dict] - see project_store.refresh_and_list_presence.
        Raises: DatastoreUnreadableError - propagated to the caller.
        """
        with closing(connect(db_path, create=False)) as conn:
            return project_store.refresh_and_list_presence(conn)

    db_path = db_path_for(settings.get_state_dir())
    try:
        rows = await run_in_threadpool(_open_probe_and_close)
    except DatastoreUnreadableError as exc:
        return {"status": "unreachable", "projects": [], "detail": str(exc)}

    return {"status": "ok", "projects": rows, "detail": None}
