"""
API routes for the Claude-config file tree + editor (see
``src/core/config_files.py`` for the actual list/read/write logic and
the allowed-roots / hide-list constants — this module is deliberately
thin: request/response shape, auth, and error translation only).

Mounted under ``/api/v1`` from ``src/main.py`` alongside the other
routers. Every endpoint requires ``Depends(require_auth)`` — this is
config content, not public data.

Security note: request bodies/params are logged only at the field-name
level (never file content) — see the ``logger.info`` calls below and in
``config_files.write_file``.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
import structlog

from src.api.auth import require_auth
from src.core import config_files

logger = structlog.get_logger()

router = APIRouter(prefix="/config-files", tags=["config-files"])


class ConfigFileWriteRequest(BaseModel):
    """Body for POST /config-files/write.

    Inputs (fields):
      root (str) - "user" or "project".
      path (str) - rel_path from a tree listing.
      content (str) - new file contents.
      project_path (str|None) - required when root == "project".
      acknowledge_executable (bool) - must be True to write a file
        config_files.py classifies as executable; the client sets this
        only after ``App.showConfirmModal()`` returned true.
    """
    root: str
    path: str
    content: str
    project_path: Optional[str] = None
    acknowledge_executable: bool = False


class ConfigFileTreeResponse(BaseModel):
    root: str
    tree: list


class ConfigFileReadResponse(BaseModel):
    content: str
    is_executable: bool
    read_only: bool
    size: int


class ConfigFileWriteResponse(BaseModel):
    ok: bool = True
    backed_up: bool
    is_executable: bool


@router.get("/tree", response_model=ConfigFileTreeResponse, dependencies=[Depends(require_auth)])
async def get_config_file_tree(
    root: str = Query(..., description='"user" or "project"'),
    project_path: Optional[str] = Query(None),
):
    """
    Description: list the allow-listed, hide-list-filtered claude-config
      file tree for one root.
    Inputs: root (str, query) - "user" or "project"; project_path
      (str|None, query) - required for root == "project".
    Output: ConfigFileTreeResponse.
    Raises: HTTPException(400) - unknown/unavailable root (translated
      from config_files.ConfigFileError).
    """
    try:
        tree = config_files.list_tree(root, project_path)
    except config_files.ConfigFileError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ConfigFileTreeResponse(root=root, tree=tree)


@router.get("/read", response_model=ConfigFileReadResponse, dependencies=[Depends(require_auth)])
async def read_config_file(
    root: str = Query(...),
    path: str = Query(...),
    project_path: Optional[str] = Query(None),
):
    """
    Description: read one allow-listed config file's contents.
    Inputs: root (str, query); path (str, query) - rel_path from a tree
      listing; project_path (str|None, query).
    Output: ConfigFileReadResponse.
    Raises: HTTPException(400) - invalid path, hidden file, path
      traversal, oversized file, or binary/non-utf8 content (all
      translated from config_files.ConfigFileError - never a 500 for a
      client mistake).
    """
    try:
        result = config_files.read_file(root, path, project_path)
    except config_files.ConfigFileError as exc:
        logger.warning("config_files_read_rejected", root=root, path=path, error=str(exc))
        raise HTTPException(status_code=400, detail=str(exc))
    return ConfigFileReadResponse(**result)


@router.post("/write", response_model=ConfigFileWriteResponse, dependencies=[Depends(require_auth)])
async def write_config_file(body: ConfigFileWriteRequest):
    """
    Description: write one allow-listed config file. Always backs up the
      previous bytes first; validates JSON for .json files before
      writing; refuses executable files (hooks/, scripts/) without
      ``acknowledge_executable=True``; refuses anything under a
      read-only root (plugins/) or outside the allowed roots entirely.
      Never logs ``body.content``.
    Inputs: body (ConfigFileWriteRequest).
    Output: ConfigFileWriteResponse.
    Raises: HTTPException(400) - any rejection from
      config_files.write_file (bad path, malformed JSON, read-only,
      unacknowledged executable write) - translated from
      config_files.ConfigFileError.
    """
    logger.info(
        "config_files_write_request",
        root=body.root,
        path=body.path,
        acknowledge_executable=body.acknowledge_executable,
    )
    try:
        result = config_files.write_file(
            root_id=body.root,
            rel_path=body.path,
            content=body.content,
            project_path=body.project_path,
            acknowledge_executable=body.acknowledge_executable,
        )
    except config_files.ConfigFileError as exc:
        logger.warning("config_files_write_rejected", root=body.root, path=body.path, error=str(exc))
        raise HTTPException(status_code=400, detail=str(exc))
    return ConfigFileWriteResponse(**result)
