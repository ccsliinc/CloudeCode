"""``/api/v1/settings/import`` - offer this browser's settings, once.

ITS OWN MODULE, like ``preferences_routes.py`` beside it, because
``src/api/routes.py`` is far past this project's line budget and is not
the default landing spot for anything.

THREE ENDPOINTS, AND ONLY ONE OF THEM WRITES.

``GET /settings/import/state`` says whether this install has already been
imported and what it currently holds. A client reads it BEFORE collecting
anything, so a browser on an already-imported install never even builds a
payload.

``POST /settings/import/preview`` plans the import and writes nothing. It
is the safety control, so it reports the same ``status`` a commit would
answer right now - including ``already_imported``, which is a preview
being honest about being unable to proceed rather than a button that
fails when pressed.

``POST /settings/import`` performs it. The plan is rebuilt inside the
write lock by the SAME function the preview called, so the commit cannot
do something the preview did not describe.

NOTHING IS UPLOADED WITHOUT A PRESS, ON ANY PATH. There is no
import-on-load, no import-on-reconnect and no import inside hydration.
That is the whole design: an automatic migration means the LAST browser
to connect wins, and a machine nobody has opened in three months would
silently revert every setting changed since.

NO TOKEN CAN REACH THIS ENDPOINT'S STORAGE. The importable set is
``ui_preferences.known_fields()`` minus a refused list, and neither auth
token is a preference field, so there is no path on which one could be
stored even if a client sent it. A sent one lands in the plan as
``refused`` and is reported back by NAME ONLY - the value is never echoed,
because a refusal that quotes what it refused is a leak wearing a
warning.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from src.api.auth import require_auth
from src.core import settings_import, settings_import_store

logger = structlog.get_logger()

router = APIRouter(tags=["settings-import"])

MAX_CANDIDATE_FIELDS = 64
"""A browser offering more fields than this server has ever had is not a
browser. Bounded here as well as in the preference block, so a
pathological body is refused before any of it is validated."""


class ImportRequest(BaseModel):
    """One browser's offered settings, and what it chose to overwrite.

    Attributes:
      candidates (dict): field name to the value this browser holds.
        ONLY fields named in ``ui_preferences`` are importable; anything
        else is reported back as refused rather than silently dropped,
        so a client that sent something it should not have finds out.
      selections (list[str]): the fields the user explicitly selected in
        the preview to replace an existing server value. A field not in
        here loses to whatever the server already holds. Defaults to
        empty, which is the safe direction: server values win.
      expected_revision (int|None): the preference revision the client
        last read. ``null`` DECLINES the check rather than passing it.
    """

    model_config = ConfigDict(extra="forbid")

    candidates: Dict[str, Any] = Field(default_factory=dict)
    selections: List[str] = Field(default_factory=list)
    expected_revision: Optional[int] = Field(default=None, ge=0)


def _store(request: Request) -> settings_import_store.SettingsImportStore:
    """Return the process's import store.

    Description: resolved off ``app.state``, where ``main.py`` mounts it.
      A request arriving before the mount is a genuine server error: an
      empty answer would read as "nothing has been imported", which is
      the one answer that could invite a stale browser to reseed.
    Inputs: request (Request).
    Output: SettingsImportStore.
    Raises: HTTPException 503 when the store is not mounted.
    """
    store = getattr(request.app.state, "settings_import_store", None)
    if store is None:
        raise HTTPException(
            status_code=503, detail="the settings import is not available yet"
        )
    return store


def _refuse_oversized(body: ImportRequest) -> None:
    """Bound the request before anything in it is validated.

    Inputs: body (ImportRequest).
    Output: None.
    Raises: HTTPException 400.
    """
    if len(body.candidates) > MAX_CANDIDATE_FIELDS:
        raise HTTPException(
            status_code=400,
            detail=f"at most {MAX_CANDIDATE_FIELDS} settings may be offered at once",
        )
    if len(body.selections) > MAX_CANDIDATE_FIELDS:
        raise HTTPException(
            status_code=400,
            detail=f"at most {MAX_CANDIDATE_FIELDS} settings may be selected at once",
        )


@router.get("/settings/import/state", dependencies=[Depends(require_auth)])
async def get_import_state(request: Request) -> Dict[str, Any]:
    """Has this install been imported, and what does it hold?

    Description: read FIRST by any client offering the control, so a
      browser on an already-imported install never collects a payload at
      all. ``importable`` and ``refused`` are returned so the client does
      not carry a second copy of the allowlist that could drift from the
      server's.
    Inputs: request (Request).
    Output: dict - ``{"completed", "completed_at", "imported_fields",
      "revision", "values", "importable", "refused"}``.
    """
    return _store(request).state()


@router.post("/settings/import/preview", dependencies=[Depends(require_auth)])
async def preview_import(request: Request, body: ImportRequest) -> Dict[str, Any]:
    """Plan the import and write nothing.

    Description: returns one entry per offered field naming what would
      happen to it - imported, identical, a conflict kept, a conflict
      the user chose to override, an invalid value, or a refused field -
      plus the value the server currently holds so the user can compare
      them. THE COMMIT REBUILDS THIS SAME PLAN with the same function, so
      what is shown is what is done.
    Inputs: request (Request); body (ImportRequest).
    Output: dict - the plan, and the status a commit would answer now.

    Example:
        POST {"candidates": {"theme": "matrix"}, "selections": []}
    """
    _refuse_oversized(body)
    result = _store(request).preview(body.candidates, body.selections)
    return result.as_payload()


@router.post("/settings/import", dependencies=[Depends(require_auth)])
async def commit_import(request: Request, body: ImportRequest) -> Dict[str, Any]:
    """Import this browser's settings, once, and record that it happened.

    Description: writes the selected values and the completion marker in
      ONE commit, so the install can never end up with the settings and
      no marker (re-offering the import to the next stale browser) or the
      marker and no settings (closing the offer having changed nothing).
    Inputs: request (Request); body (ImportRequest).
    Output: dict - the plan that ran, the fields that moved, and the new
      revision, so the client confirms persistence from the response.
    Raises:
      HTTPException 400: the body is oversized.
      HTTPException 409: already imported, or the expected revision is
        stale. The body carries the current state to reconcile against.
      HTTPException 500: config.json is missing or unreadable.

    Example:
        POST {"candidates": {"theme": "matrix"}, "selections": ["theme"],
              "expected_revision": 4}
    """
    _refuse_oversized(body)
    store = _store(request)

    try:
        result = store.commit(body.candidates, body.selections, body.expected_revision)
    except FileNotFoundError as exc:
        logger.error("settings_import_config_missing", error=str(exc))
        raise HTTPException(
            status_code=500, detail="Configuration not found. Run setup_auth.py first."
        )
    except ValueError as exc:
        logger.error("settings_import_config_unparseable", error=str(exc))
        raise HTTPException(
            status_code=500, detail="Configuration could not be read."
        )

    if result.status in (
        settings_import.ALREADY_IMPORTED,
        settings_import.STALE_REVISION,
    ):
        # 409 with the whole current state attached, the same shape the
        # preferences endpoint uses for a conflict. A bare 409 would
        # leave the client able to say only "that failed".
        raise HTTPException(status_code=409, detail=result.as_payload())

    return result.as_payload()
