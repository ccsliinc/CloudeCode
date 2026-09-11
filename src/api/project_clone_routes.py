"""Clone a GitHub repository into a new project.

Unlike "start empty", this flow has collected a PARENT DIRECTORY since it
shipped, so it never had the defect where a project was created at a
path nobody chose. ``_extract_repo_name`` is what turns a clone URL into
the folder name, and it lives here because it is only ever used by this
one route.
"""

import asyncio
import structlog
from fastapi import APIRouter, Depends, HTTPException
from pathlib import Path
from src.api import projects_service
from src.config import settings
from src.models import CloneProjectRequest, ProjectResponse
from typing import Optional

from src.api.auth import require_auth

logger = structlog.get_logger()
router = APIRouter()


def _extract_repo_name(url: str) -> Optional[str]:
    """Extract the repo basename from a GitHub URL.

    Accepts the canonical GitHub URL shapes used by ``gh repo clone``:
      * ``https://github.com/owner/repo``
      * ``https://github.com/owner/repo.git``
      * ``git@github.com:owner/repo.git``
      * ``github.com/owner/repo``
      * ``owner/repo`` (gh CLI shorthand)

    Returns the final path segment (the repo name) or ``None`` if the URL
    can't be parsed into at least ``owner/repo`` shape. The returned name
    is what gh will use as the cloned-folder basename when no explicit
    target directory is supplied - we match that behavior here.
    """
    if not url:
        return None
    url = url.strip().rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]
    # ssh form: git@github.com:owner/repo
    if "@" in url and ":" in url and "://" not in url:
        url = url.split(":", 1)[1]
    # https / scheme-prefixed form
    if "://" in url:
        url = url.split("://", 1)[1]
    # strip github.com/ prefix (case-insensitive)
    if url.lower().startswith("github.com/"):
        url = url[len("github.com/"):]
    parts = [p for p in url.split("/") if p]
    if len(parts) < 2:
        return None
    name = parts[-1]
    # Defensive: reject anything with path-traversal or whitespace chars.
    if not name or any(ch in name for ch in ("..", "/", "\\", "\x00")) or name.strip() != name:
        return None
    return name


@router.post(
    "/projects/clone",
    response_model=ProjectResponse,
    status_code=201,
    dependencies=[Depends(require_auth)],
)
async def clone_project_from_github(body: CloneProjectRequest):
    """Clone a GitHub repo via ``gh repo clone`` and register it as a project.

    Steps:
      1. Verify the ``gh`` CLI is on PATH (else 503).
      2. Parse the repo basename from ``body.repo_url`` (else 400).
      3. Resolve target = ``<parent_dir>/<repo_name>``; refuse if it exists (409).
      4. Refuse if a project with the same display name already exists (409).
      5. Run ``gh repo clone <url> <target>`` with a 5-minute bounded timeout.
         No shell - args are passed as a vector to ``create_subprocess_exec``.
      6. Translate gh's exit/stderr into typed HTTP errors:
            auth/network → 401, not-found → 404, other → 500.
      7. Persist the new project (display name = body.project_name or repo basename).
    """
    # 1. Verify gh CLI is available.
    try:
        gh_check = await asyncio.create_subprocess_exec(
            "gh", "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await gh_check.communicate()
        if gh_check.returncode != 0:
            raise HTTPException(
                status_code=503,
                detail=(
                    "gh CLI not available on server. Install with "
                    "`brew install gh` and run `gh auth login`."
                ),
            )
    except FileNotFoundError:
        raise HTTPException(
            status_code=503,
            detail=(
                "gh CLI not found on server. Install with `brew install gh` "
                "and run `gh auth login`."
            ),
        )

    # 2. Parse repo name from URL.
    repo_name = _extract_repo_name(body.repo_url)
    if not repo_name:
        raise HTTPException(
            status_code=400,
            detail=f"Could not extract repository name from URL: {body.repo_url}",
        )
    project_name = body.project_name or repo_name

    # 3. Resolve target path. expanduser handles ~; resolve normalizes.
    try:
        parent = Path(body.parent_dir).expanduser().resolve()
    except (OSError, RuntimeError) as e:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid parent_dir: {body.parent_dir} ({e})",
        )
    target = parent / repo_name

    # 4. Refuse if target dir already exists.
    if target.exists():
        raise HTTPException(
            status_code=409,
            detail=f"Target directory already exists: {target}",
        )

    # 5. Refuse if a project with the same display name already exists.
    #    feat/db-is-authoritative: asks the authoritative source, not
    #    config.json. A name that exists only in a stale config.json is
    #    not a conflict, and a name that exists only in the database
    #    would have been missed by the old check and then failed at the
    #    write with a 500 instead of this 409.
    _clone_view = projects_service.guard_writable(settings)
    if any(p["name"] == project_name for p in _clone_view.projects):
        raise HTTPException(
            status_code=409,
            detail=f"A project named '{project_name}' already exists",
        )

    # 6. Ensure parent dir exists.
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create parent directory {parent}: {e}",
        )

    # 7. Run gh clone - bounded timeout, no shell interpolation.
    try:
        proc = await asyncio.create_subprocess_exec(
            "gh", "repo", "clone", body.repo_url, str(target),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="gh CLI not found")

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
    except asyncio.TimeoutError:
        try:
            proc.kill()
            await proc.wait()
        except ProcessLookupError:
            pass
        logger.warning("gh_clone_timeout", repo_url=body.repo_url)
        raise HTTPException(status_code=504, detail="git clone timed out after 5 minutes")

    if proc.returncode != 0:
        err = (stderr or b"").decode("utf-8", errors="replace").strip()
        lower = err.lower()
        logger.warning(
            "gh_clone_failed",
            repo_url=body.repo_url,
            returncode=proc.returncode,
            stderr=err[:500],
        )
        # Auth / network classes - gh exits non-zero with these messages.
        if (
            "authentication" in lower
            or "permission denied" in lower
            or "could not resolve host" in lower
            or "denied" in lower
            or "ssh: " in lower
        ):
            raise HTTPException(
                status_code=401,
                detail=f"gh clone failed (auth/network): {err[:500]}",
            )
        if "not found" in lower or "could not find" in lower or "repository not found" in lower:
            raise HTTPException(
                status_code=404,
                detail=f"Repository not found: {body.repo_url}",
            )
        raise HTTPException(
            status_code=500,
            detail=f"gh clone failed: {err[:500]}",
        )

    # 8. Register as a project in the AUTHORITATIVE table, then refresh
    # the config.json rollback snapshot. The cloned dir stays on disk
    # even if registration fails - the user can retry via "open project
    # from folder".
    from contextlib import closing as _closing

    from src.core.project_writes import (
        ProjectNameConflict as _NameConflict,
        ProjectRootConflict as _RootConflict,
        create_project as _db_create_project,
    )

    try:
        with _closing(projects_service.open_db_or_503(settings)) as _conn:
            row = _db_create_project(
                _conn,
                name=project_name,
                path=str(target),
                description=body.description,
            )
    except (_NameConflict, _RootConflict) as e:
        # Defensive - step 5 already checked the name, but a race could
        # squeeze in, and only the database can catch a ROOT collision.
        logger.warning(
            "project_save_collision_after_clone", name=project_name, error=str(e)
        )
        raise HTTPException(status_code=409, detail=str(e))


    logger.info(
        "project_cloned_from_github",
        name=row["display_name"],
        path=row["raw_path"],
        repo_url=body.repo_url,
    )

    return ProjectResponse(
        id=row["id"],
        name=row["display_name"],
        path=row["raw_path"],
        description=row["description"],
        root=row["root"],
    )
