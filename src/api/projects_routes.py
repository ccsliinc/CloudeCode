"""The launcher projects: list, create, rename, delete, archive.

A PROJECT'S DIRECTORY IS PERMANENT. The row carries it, the launcher
lists it, and the archive derives a transcript directory from it, so this
is one of the two places that can poison every downstream reader. Paths
are canonicalised with ``os.path.realpath`` rather than
``Path.expanduser``, which expands ``~`` and STOPS: a short symlinked
spelling is how one directory becomes two projects, two transcript
directories and two session rows.

A NAME IS REFUSED, NEVER REWRITTEN. Spaces are legal and stay verbatim.
A sanitiser that turned ``a/b`` into ``a-b`` would silently make a folder
the user did not ask for and cannot find.

``create_project`` also adopts the project-less live rows already under
its new root, which is the other half of the "every session belongs to a
project" invariant; the ladder itself is in
``src/core/session_project_binding.py``.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from src.api import projects_service
from src.config import settings
from src.models import (
    CreateProjectRequest,
    ProjectResponse,
    SuccessResponse,
    UpdateProjectRequest,
)

from src.api.auth import require_auth

logger = structlog.get_logger()
router = APIRouter()


@router.get("/projects", response_model=list[ProjectResponse], dependencies=[Depends(require_auth)])
async def get_projects(
    include_archived: bool = Query(
        False,
        description=(
            "Include ARCHIVED projects alongside the live ones. Defaults "
            "false, so a client that predates archiving sees exactly the "
            "list it saw before. Archived rows are not a separate list "
            "and there is no separate endpoint for them: they arrive "
            "mixed in, each carrying its own archived_at, so the client "
            "distinguishes them per row rather than by remembering which "
            "request it made."
        ),
    ),
):
    """
    Get the project list from the AUTHORITATIVE source.

    feat/db-is-authoritative. This route used to read config.json. It now
    reads the ``projects`` table, which is keyed ``UNIQUE(root)`` and
    therefore returns ONE entry per unique folder - the fix for the
    launcher drawing three nodes for
    ``/Users/jsugamele/Development/ses_ec5bf2a3`` and expanding the same
    two child sessions under each of them.

    Each row now carries its ``id``, so the launcher attaches child
    sessions by row id straight from this response instead of looking the
    id up in a second request keyed by raw path - the lookup that made
    duplicate-path entries share children in the first place.

    THREE OUTCOMES, and this route never collapses them:
      - the database answered: rows served, authoritative;
      - the database is unreachable: config.json's entries are served,
        deduplicated by root, and GET /projects/authority reports
        ``mode: config_fallback`` with writes refused;
      - the database is readable but empty while config.json is not:
        the list is EMPTY and the mode says ``db_unreadable``, so an
        empty list is never rendered as "you have no projects" when it
        actually means "nothing could be read".

    A client that needs to know WHICH of those it is calls
    GET /projects/authority. This route always returns a list, because a
    launcher that cannot draw anything is a worse failure than one that
    draws the user's projects with a banner over them.

    Returns:
        list[ProjectResponse] - never raises for a datastore fault.
    """
    view = projects_service.current_view(
        settings, include_archived=include_archived
    )

    if view.degraded:
        logger.warning(
            "projects_served_degraded",
            mode=view.mode,
            detail=view.detail,
            count=len(view.projects),
        )
    else:
        logger.debug("projects_retrieved", count=len(view.projects))

    return projects_service.views_to_responses(view, ProjectResponse)


@router.get("/projects/authority", dependencies=[Depends(require_auth)])
async def get_projects_authority() -> dict:
    """
    Report where the project list came from, and whether writes work.

    Projects live in cloude.db and nowhere else, so this route no longer
    reports a disagreement between two sources - there is only one.
    ``mode`` is one of:

      ``db``             the normal case. The list is the table's and
                         writes are allowed. An empty list here is a
                         real, measured empty list.
      ``db_unreadable``  cloude.db could not be read. The list is EMPTY
                         because nothing could be read, NOT because
                         nothing is there, and ``message`` says so in
                         words. Writes are refused until it clears.

    ``reconcile`` reports what the last startup pass did to the table,
    so a repair the user did not ask for is still something the user can
    see.

    Returns:
        dict - ``{"mode", "writable", "degraded", "message", "detail",
        "project_count", "reconcile"}``.
    """
    return projects_service.authority_payload(settings)


@router.post("/projects", response_model=ProjectResponse, status_code=201, dependencies=[Depends(require_auth)])
async def create_project(body: CreateProjectRequest):
    """
    Add a new project.

    Writes the ``projects`` table, which is the only place projects
    live. There is no second store to keep in step.

    Args:
        body: Project creation parameters.

    Returns:
        Created project object.

    Raises:
        HTTPException 400: a project with that display name already exists.
        HTTPException 409: a project already exists at that folder. This
            is the refusal that keeps the launcher showing one node per
            folder; it is 409 rather than 400 because the request is
            well-formed and the conflict is with existing state.
        HTTPException 503: cloude.db is unreachable, so the write is
            refused rather than being applied to config.json alone.
    """
    from contextlib import closing

    from src.core.project_writes import (
        ProjectNameConflict,
        ProjectRootConflict,
        create_project as db_create_project,
    )

    projects_service.guard_writable(settings)

    try:
        with closing(projects_service.open_db_or_503(settings)) as conn:
            row = db_create_project(
                conn,
                name=body.name,
                path=body.path,
                description=body.description,
            )
    except ProjectRootConflict as e:
        logger.warning("project_creation_root_conflict", path=body.path, error=str(e))
        raise HTTPException(status_code=409, detail=str(e))
    except ProjectNameConflict as e:
        logger.warning("project_creation_failed_validation", error=str(e))
        raise HTTPException(status_code=400, detail=str(e))

    logger.info("project_created", name=row["display_name"], path=row["raw_path"])

    return ProjectResponse(
        id=row["id"],
        name=row["display_name"],
        path=row["raw_path"],
        description=row["description"],
        root=row["root"],
    )


@router.delete("/projects/{project_name}", response_model=SuccessResponse, dependencies=[Depends(require_auth)])
async def delete_project(project_name: str):
    """
    Remove a project from the launcher.

    feat/db-is-authoritative. Deletes the ``projects`` row, then
    refreshes config.json. The folder on disk is never touched.

    Args:
        project_name: Display name of the project to remove.

    Returns:
        Success response.

    Raises:
        HTTPException 404: no project carries that display name.
        HTTPException 409: more than one does, so the name does not
            identify a single project. Never resolved by deleting the
            first match.
        HTTPException 503: cloude.db is unreachable.
    """
    from contextlib import closing

    from src.core.project_writes import delete_project as db_delete_project

    projects_service.guard_writable(settings)

    with closing(projects_service.open_db_or_503(settings)) as conn:
        target = projects_service.resolve_target(conn, project_name)
        db_delete_project(conn, target["id"])

    logger.info("project_deleted", name=project_name, root=target["root"])

    return SuccessResponse(message=f"Project '{project_name}' deleted successfully")


@router.patch(
    "/projects/{project_name}",
    response_model=ProjectResponse,
    dependencies=[Depends(require_auth)],
)
async def update_project(project_name: str, body: UpdateProjectRequest):
    """
    Update a project's display name and/or description.

    feat/db-is-authoritative. Writes the ``projects`` row, then refreshes
    config.json. Display name only - the folder on disk is never touched,
    and ``projects.root`` is never rewritten, so a rename cannot move a
    project onto another project's identity. After a rename, subsequent
    calls must use the NEW name (the URL path identifier changes).

    Args:
        project_name: Current display name (URL path).
        body: Fields to update. Both ``new_name`` and ``description`` are
            optional; sending neither yields 400.

    Returns:
        The updated project (canonical form, post-mutation).

    Raises:
        HTTPException 400: if no fields are supplied.
        HTTPException 404: if no project named ``project_name`` exists.
        HTTPException 409: if ``new_name`` collides with another project,
            or if ``project_name`` matches more than one project.
        HTTPException 503: cloude.db is unreachable.
    """
    from contextlib import closing

    from src.core.project_writes import (
        ProjectNameConflict,
        update_project as db_update_project,
    )

    if body.new_name is None and body.description is None:
        raise HTTPException(status_code=400, detail="No fields to update")

    projects_service.guard_writable(settings)

    try:
        with closing(projects_service.open_db_or_503(settings)) as conn:
            target = projects_service.resolve_target(conn, project_name)
            row = db_update_project(
                conn,
                target["id"],
                new_name=body.new_name,
                description=body.description,
            )
    except ProjectNameConflict:
        logger.warning(
            "project_update_name_conflict",
            old_name=project_name,
            new_name=body.new_name,
        )
        raise HTTPException(
            status_code=409,
            detail=f"A project named '{body.new_name}' already exists",
        )

    logger.info(
        "project_updated",
        old_name=project_name,
        new_name=row["display_name"],
        description_changed=body.description is not None,
    )

    return ProjectResponse(
        id=row["id"],
        name=row["display_name"],
        path=row["raw_path"],
        description=row["description"],
        root=row["root"],
    )


def _project_archive_response(row: dict) -> ProjectResponse:
    """Render a post-archive/unarchive project row for the wire.

    Description: carries ``archived_at`` so the caller reads the
      RESULTING STATE off the row rather than assuming the state it
      asked for. An endpoint that returned 200 and nothing else would
      make "archived just now" and "was already archived" identical to
      the client, which is the collapse this codebase spends its whole
      project surface avoiding.
    Inputs: row (dict) - a ``projects`` table row, post-mutation.
    Output: ProjectResponse.
    Example: _project_archive_response(row).archived_at
    """
    return ProjectResponse(
        id=row["id"],
        name=row["display_name"],
        path=row["raw_path"],
        description=row["description"],
        root=row["root"],
        archived_at=row["archived_at"],
    )


@router.post(
    "/projects/{project_name}/archive",
    response_model=ProjectResponse,
    dependencies=[Depends(require_auth)],
)
async def archive_project_route(project_name: str):
    """Retire a project from the default list, keeping it and its work.

    THIS IS NOT DELETE. ``DELETE /projects/{name}`` removes the row and
    writes a tombstone so the reconcile cannot re-import it. This sets
    ``archived_at`` and nothing else: the project stays in the database,
    stays addressable by this exact name (``resolve_by_name`` does not
    filter on archived state, deliberately, or an archived project would
    be unreachable by the endpoint that restores it), and comes back with
    one call to ``/unarchive``.

    IT DOES NOT TOUCH THE PROJECT'S SESSIONS. A session carries its own
    ``archived_at``, written only by the session delete path, and this
    writes none of them. A dormant project with a live session stays
    fully usable and that session keeps appearing in RUNNING and RECENT.
    See ``src/core/project_archive.py`` for why cascading was rejected.

    IDEMPOTENT. Archiving an already-archived project is a 200, not a
    409 - the user asked for a state and that state holds. The response's
    ``archived_at`` is the original stamp, because the first stamp wins;
    the log line says which of the two happened.

    Args:
        project_name: Display name of the project to archive.

    Returns:
        The project post-mutation, carrying ``archived_at``.

    Raises:
        HTTPException 404: no project carries that display name.
        HTTPException 409: more than one does.
        HTTPException 503: cloude.db is unreachable, so the change is
            refused rather than applied to a second store (there is none).
    """
    from contextlib import closing

    from src.core.project_archive import archive_project as db_archive_project

    projects_service.guard_writable(settings)

    with closing(projects_service.open_db_or_503(settings)) as conn:
        target = projects_service.resolve_target(conn, project_name)
        changed = db_archive_project(conn, target["id"])
        row = dict(
            conn.execute(
                "SELECT * FROM projects WHERE id = ?", (target["id"],)
            ).fetchone()
        )

    logger.info(
        "project_archive_requested",
        name=project_name,
        root=row["root"],
        changed=changed,
        archived_at=row["archived_at"],
    )

    return _project_archive_response(row)


@router.post(
    "/projects/{project_name}/unarchive",
    response_model=ProjectResponse,
    dependencies=[Depends(require_auth)],
)
async def unarchive_project_route(project_name: str):
    """Bring an archived project back into the default list.

    The reverse of ``/archive``, and it exists because an archive without
    one is a delete wearing a softer word. Clears ``archived_at``; writes
    nothing else, and unarchives no sessions, because archiving archived
    none.

    IDEMPOTENT in the same shape: unarchiving a live project is a 200
    whose ``archived_at`` is null, which is the state the caller asked
    for.

    Args:
        project_name: Display name of the project to restore.

    Returns:
        The project post-mutation, with ``archived_at`` null.

    Raises:
        HTTPException 404: no project carries that display name.
        HTTPException 409: more than one does.
        HTTPException 503: cloude.db is unreachable.
    """
    from contextlib import closing

    from src.core.project_archive import (
        unarchive_project as db_unarchive_project,
    )

    projects_service.guard_writable(settings)

    with closing(projects_service.open_db_or_503(settings)) as conn:
        target = projects_service.resolve_target(conn, project_name)
        changed = db_unarchive_project(conn, target["id"])
        row = dict(
            conn.execute(
                "SELECT * FROM projects WHERE id = ?", (target["id"],)
            ).fetchone()
        )

    logger.info(
        "project_unarchive_requested",
        name=project_name,
        root=row["root"],
        changed=changed,
    )

    return _project_archive_response(row)
