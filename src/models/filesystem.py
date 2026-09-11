"""Browsing a directory, making one, and uploading an image."""

from typing import Optional, List
from pydantic import BaseModel, Field


class DirectoryEntry(BaseModel):
    """A single directory entry returned by the filesystem browser."""
    name: str = Field(..., description="Directory name (basename)")
    path: str = Field(..., description="Absolute directory path")


class BrowseResponse(BaseModel):
    """Response model for the filesystem browse endpoint."""
    path: str = Field(..., description="Absolute path of the directory being listed")
    parent: Optional[str] = Field(None, description="Absolute path of the parent directory, or null if at filesystem root")
    entries: List[DirectoryEntry] = Field(default_factory=list, description="Subdirectories inside the listed path")


class MkdirRequest(BaseModel):
    """Request body for ``POST /filesystem/mkdir``.

    ``path`` may contain ``~`` (expanded server-side). The directory is created
    with ``mkdir -p`` semantics (parents created, idempotent if it already
    exists), then listed back as a :class:`BrowseResponse` so the folder picker
    can navigate into it in a single round-trip.
    """
    path: str = Field(..., description="Directory path to create (mkdir -p). '~' is expanded server-side.")


class UploadImageResponse(BaseModel):
    """Response model for ``POST /sessions/upload-file`` (and its alias).

    Returned after a validated upload has been persisted into the active
    session's ``.cloude_uploads/`` bucket. ``path`` is the absolute on-disk
    location the client injects into the terminal: Claude Code's CLI
    auto-attaches an absolute image path, and reads any other absolute path
    with its own file tools. ``filename`` is the saved
    ``<uuid8>-<safe_name>`` basename for display in the client's status
    pill; ``size`` lets the client surface a friendly "uploaded N KB"
    confirmation without re-reading the file.

    Name retained (rather than ``UploadFileResponse``) because the shape is
    unchanged and it is referenced by the retained ``/upload-image`` alias.
    """
    path: str = Field(..., description="Absolute path to the saved file")
    filename: str = Field(..., description="Saved filename (basename only)")
    size: int = Field(..., description="Saved file size in bytes")
