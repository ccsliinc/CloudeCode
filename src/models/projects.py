"""Creating, reading, updating and cloning a project."""

from typing import Optional
from pydantic import BaseModel, Field


class CreateProjectRequest(BaseModel):
    """Request model for creating a new project."""
    name: str = Field(..., description="Project display name")
    path: str = Field(..., description="Project directory path")
    description: Optional[str] = Field(None, description="Project description")


class ProjectResponse(BaseModel):
    """Response model for a project.

    ``id`` and ``root`` were added by feat/db-is-authoritative. ``id`` is
    the ``projects`` table row id, which the launcher uses to attach a
    project's child sessions - previously it had to look that id up in a
    SECOND request (GET /projects/presence) keyed by raw path, and two
    config entries sharing a path therefore resolved to the same id and
    drew the same children twice.

    Both are Optional because the degraded config.json fallback has
    neither: a config entry has no row and therefore no id. ``None`` there
    is the honest answer and is rendered as "this project has no children
    we can prove", never as row 0.
    """
    id: Optional[int] = Field(None, description="projects table row id, null in config fallback")
    name: str = Field(..., description="Project display name")
    path: str = Field(..., description="Project directory path")
    description: Optional[str] = Field(None, description="Project description")
    root: Optional[str] = Field(None, description="Normalised project root, the identity key")
    work_at: Optional[str] = Field(
        None,
        description=(
            "MAX(sessions.last_work_at) across this project's sessions - "
            "the key GET /projects is ordered by. None means NO WORK HAS "
            "BEEN RECORDED, which is a third outcome and not a zero: such "
            "a project sorts below every project that has a value and is "
            "labelled as unrecorded rather than blended in with them. "
            "Never derived from last_opened_at - opening is not working"
        ),
    )
    archived_at: Optional[str] = Field(
        None,
        description=(
            "ISO-8601 stamp of when this project was ARCHIVED (retired "
            "from the default list), or None when it is live. Carried on "
            "every row so a client rendering an include_archived=true "
            "list can tell the two apart per row - the flag it sent says "
            "what it asked for, not what any given row is. Archiving a "
            "project never touches its sessions: a session of an "
            "archived project still appears in RUNNING and RECENT"
        ),
    )


class UpdateProjectRequest(BaseModel):
    """Request model for updating a project's display name and/or description.

    Both fields are optional - clients send only what they want to change.
    Display name only - the folder on disk is never touched.
    """
    new_name: Optional[str] = Field(None, description="New display name (omit to keep current)")
    description: Optional[str] = Field(None, description="New description (omit to keep current; empty string clears)")


class CloneProjectRequest(BaseModel):
    """Request model for cloning a GitHub repo into a new project.

    The server runs ``gh repo clone <repo_url> <parent_dir>/<repo_name>``,
    then registers the result as a project (display name = ``project_name``
    if supplied, else the repo basename). The parent directory is created
    if it doesn't exist; the target ``<parent_dir>/<repo_name>`` must NOT
    exist (server returns 409 otherwise).
    """
    repo_url: str = Field(
        ...,
        description=(
            "GitHub repo URL - accepts https://github.com/owner/repo, "
            "https://github.com/owner/repo.git, git@github.com:owner/repo.git, "
            "github.com/owner/repo, or owner/repo (gh CLI shorthand)."
        ),
    )
    parent_dir: str = Field(
        default="~/projects",
        description="Directory on the server in which the cloned folder will be created.",
    )
    description: Optional[str] = Field(None, description="Project description")
    project_name: Optional[str] = Field(
        None,
        description="Override auto-detected repo name as the project display name.",
    )
