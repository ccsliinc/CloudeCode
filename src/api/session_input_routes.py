"""Send a command into a pane, and upload a file or an image to it.

The two ways a client puts something INTO a session that are not the
terminal socket. Both are validated before anything reaches disk or the
pane; see ``src/api/uploads.py`` for the upload rules.
"""

import structlog
from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Request,
    UploadFile,
)
from src.api.auth import require_auth
from src.api.uploads import save_upload_to_session_dir, validate_upload
from src.config import settings
from src.models import CommandRequest, SuccessResponse, UploadImageResponse
from typing import Optional

logger = structlog.get_logger()
router = APIRouter()


@router.post("/sessions/command", response_model=SuccessResponse, dependencies=[Depends(require_auth)])
async def send_command(request: Request, body: CommandRequest):
    """
    Send a command to the active session.

    Args:
        body: Command to send

    Returns:
        Success response

    Raises:
        HTTPException: If command sending fails
    """
    session_manager = request.app.state.session_manager

    try:
        logger.info("api_send_command", command=body.command[:50])

        await session_manager.send_command(body.command)

        return SuccessResponse(message="Command sent successfully")

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("send_command_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to send command: {str(e)}")


@router.post(
    "/sessions/upload-file",
    response_model=UploadImageResponse,
    status_code=201,
    dependencies=[Depends(require_auth)],
)
@router.post(
    "/sessions/upload-image",
    response_model=UploadImageResponse,
    status_code=201,
    dependencies=[Depends(require_auth)],
    include_in_schema=False,
)
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    session_id: Optional[str] = None,
):
    """Persist an uploaded file into a session's upload bucket.

    Accepts ANY file, not only images: the point of the feature is to hand
    Claude a path to something it can read for itself. Images keep the
    stricter contract (magic-byte cross-check, tighter size cap); everything
    else is size-capped and name-sanitised but its bytes are never parsed.
    See ``src/api/uploads.py`` for the full validation contract.

    The validated file is written to
    ``<working_dir>/.cloude_uploads/<uuid8>-<safe_name>`` with mode 0o600
    (directory 0o700), via ``O_EXCL`` so nothing is silently overwritten. The
    client then injects the returned absolute ``path`` into the terminal.

    TWO PATHS, ONE HANDLER. ``/sessions/upload-file`` is the canonical route.
    ``/sessions/upload-image`` is retained (and hidden from the schema)
    because this is a PWA: a browser holding a cached older ``api.js`` would
    otherwise 404 on every paste until its service worker updated.

    ``session_id`` (query, optional) picks which session's working dir to
    write into; omitted uses the current session. The terminal tab that's
    pasting passes its own session id so the file lands in the right project.

    Raises:
        HTTPException: 409 if no matching session, 400 on validation failure
            (oversize, empty, or an image failing its magic-byte check), 500
            on disk error.
    """
    session_manager = request.app.state.session_manager

    registry = request.app.state.services.registry
    session = registry.get_session(session_id) if session_id else None
    if session is None:
        # Back-compat: fall back to "the" session.
        if not session_manager.has_active_session():
            raise HTTPException(status_code=409, detail="No active session to upload into")
        session = registry.current_session()
    if session is None or not session.working_dir:
        raise HTTPException(status_code=409, detail="Active session has no working directory")

    declared_filename = file.filename or ""
    data = await file.read()

    logger.info(
        "api_upload_file_request",
        declared_filename=declared_filename,
        size=len(data),
        # Logged for diagnostics only. The client's content-type is NOT
        # trusted and never has been; type is inferred from the sanitised
        # extension inside validate_upload().
        content_type=file.content_type,
    )

    uploads_cfg = settings.load_auth_config().uploads
    validated_bytes, safe_name = validate_upload(
        data,
        declared_filename,
        uploads_cfg.max_size_mb,
        uploads_cfg.max_file_size_mb,
    )

    try:
        target_path = save_upload_to_session_dir(
            validated_bytes, safe_name, session.working_dir
        )
    except HTTPException:
        raise
    except OSError as e:
        logger.error("upload_file_save_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")

    logger.info(
        "api_upload_file_saved",
        path=str(target_path),
        size=len(validated_bytes),
    )

    return UploadImageResponse(
        path=str(target_path),
        filename=target_path.name,
        size=len(validated_bytes),
    )
