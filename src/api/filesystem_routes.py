"""Browse a directory, and create one.

The folder picker behind "open an existing folder" and the project
folder step. Both endpoints resolve with ``os.path.realpath`` before any
comparison, because ``expanduser`` expands ``~`` and STOPS: a short
symlinked spelling of a directory is how one directory becomes two
projects, two transcript directories and two session rows.
"""

from fastapi import APIRouter, Depends, HTTPException
from pathlib import Path
from src.api.auth import require_auth
from src.config import settings
from src.models import BrowseResponse, DirectoryEntry, MkdirRequest
from typing import List, Optional

router = APIRouter()


def _build_browse_response(resolved: Path) -> BrowseResponse:
    """Build a :class:`BrowseResponse` for an existing directory.

    Shared by the ``browse`` and ``mkdir`` endpoints so the directory-listing
    logic lives in exactly one place. ``resolved`` MUST already be an existing
    directory - callers own the existence/type checks (browse 404s, mkdir
    creates). Hidden (dot-prefixed) entries are skipped and individual
    unreadable children are silently ignored so one bad entry never fails the
    whole listing.

    Raises:
        HTTPException: 403 if the directory itself cannot be read, 500 on any
                       other OS error while iterating.
    """
    entries: List[DirectoryEntry] = []
    try:
        for child in sorted(resolved.iterdir(), key=lambda p: p.name.lower()):
            if child.name.startswith('.'):
                continue
            try:
                if child.is_dir():
                    entries.append(DirectoryEntry(name=child.name, path=str(child)))
            except (PermissionError, OSError):
                continue
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {resolved}")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to read directory: {e}")

    parent = str(resolved.parent) if resolved.parent != resolved else None

    return BrowseResponse(
        path=str(resolved),
        parent=parent,
        entries=entries,
    )


@router.get("/filesystem/browse", response_model=BrowseResponse, dependencies=[Depends(require_auth)])
async def browse_directory(path: Optional[str] = None):
    """
    List subdirectories of a given filesystem path for the project folder picker.

    Args:
        path: Directory path to list. Defaults to the configured default working dir,
              or the user's home directory if that is unavailable.

    Returns:
        BrowseResponse with the absolute path, its parent, and subdirectories.

    Raises:
        HTTPException: 404 if the path does not exist or is not a directory,
                       403 if permission denied. The frontend folder picker
                       relies on a clean 404 to decide whether to auto-create.
    """
    import os
    from pathlib import Path

    if path:
        target = Path(path).expanduser()
    else:
        try:
            target = settings.get_working_dir()
        except Exception:
            target = Path.home()

    try:
        resolved = target.resolve(strict=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid path: {e}")

    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {resolved}")

    if not resolved.is_dir():
        raise HTTPException(status_code=404, detail=f"Not a directory: {resolved}")

    return _build_browse_response(resolved)


@router.post("/filesystem/mkdir", response_model=BrowseResponse, dependencies=[Depends(require_auth)])
async def make_directory(body: MkdirRequest):
    """
    Create a directory (``mkdir -p``) and return its listing in one round-trip.

    Resolves the requested path (``~`` is expanded), creates it along with any
    missing parents, then lists it exactly like ``browse_directory`` so the
    folder picker can navigate straight into the new directory. ``mkdir -p``
    semantics make this idempotent - it succeeds if the directory already
    exists. Matches the browse endpoint's path handling (resolve, no root
    restriction).

    Raises:
        HTTPException: 400 on an invalid path or any OS error (e.g. permission
                       denied, a file already occupies the path), 403 if the
                       created directory cannot be read.
    """
    target = Path(body.path).expanduser()

    try:
        resolved = target.resolve(strict=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid path: {e}")

    try:
        resolved.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"Failed to create directory: {e}")

    return _build_browse_response(resolved)
