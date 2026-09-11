"""``/api/v1/preferences`` - read the block, and change part of it.

ITS OWN MODULE, like ``toast_routes.py`` and ``status_routes.py``,
because ``src/api/routes.py`` and ``src/api/auth.py`` are both far past
this project's line budget and neither is the default landing spot.

PARTIAL, NEVER A SNAPSHOT. A client that PATCHes its whole view of the
preferences overwrites every field it never displayed, which is the
failure this endpoint exists to prevent rather than perform. The body
carries only what the user changed.

THE REVISION CHECK IS THE SAME SHAPE THE REST OF THIS CODEBASE ALREADY
USES. ``if_version`` on a database document and the 409 the mute
endpoint returns when its expected instance does not match both refuse
and say what is current, rather than guessing. A stale write here gets
**409** with the current revision and the current values attached, so
the client can reconcile against a real number instead of retrying
blindly into the same conflict.

``preferences.changed`` IS AN OPTIMISATION, NOT THE SOURCE OF TRUTH.
Every frame carries the committed revision, and a client applies one
ONLY when that revision is HIGHER than the one it holds. That single
rule makes the consumer survive all three things hook events already
taught this project to expect: the same frame twice (equal revision, so
ignored), two frames out of order (the older one is lower, so ignored),
and a dropped frame (the next one is higher and carries the full field,
and a reconnect refresh closes the gap regardless). It is a monotonic
fold over a version number, not an increment, which is why it needs no
ordering guarantee from the transport.

**A CLIENT ON THE HOME SCREEN HOLDS NO SOCKET AND HEARS NOTHING**, and
that is a real limit rather than an oversight: this app's WebSocket is
session-scoped, so a browser sitting on the launchpad has no connection
to fan out to. Hydration on entering a screen is what covers it, which
is the same "reconnect performs an authoritative refresh" rule stated
from the other side.

NO SECRET IS EVER IN A RESPONSE OR AN EVENT. The block cannot hold one -
``ui_preferences.is_secret_name`` refuses the name at validation - so
there is nothing here to filter, which is a stronger guarantee than
filtering on the way out.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from src.api.auth import require_auth
from src.core import session_change_notice, ui_preferences, ui_preferences_store
from src.models import WSMessageType

logger = structlog.get_logger()

router = APIRouter(tags=["preferences"])

PREFERENCES_CHANGED_EVENT = WSMessageType.PREFERENCES_CHANGED.value
"""The WebSocket frame type other clients receive on a commit.

Read off ``WSMessageType`` rather than spelled again here: that enum is
the app's ONE message vocabulary, and a literal beside it is how a second
one starts. The value is unchanged, so nothing on the wire moved.
"""


class PreferencesUpdateRequest(BaseModel):
    """A partial preference update, with the revision it expects.

    Attributes:
      changes (dict): field name to new value, ONLY what the user
        changed. ``null`` for a known field unsets it, returning that
        preference to the client's own default.
      expected_revision (int|None): the revision the client last read.
        ``null`` DECLINES the check rather than passing it, which is
        correct for a first write and for a client with nothing to race;
        it is spelled as an explicit null so a client that means to check
        cannot omit the field by accident and get a silent overwrite.
      client_id (str|None): an opaque per-browser id echoed back in the
        broadcast, so the client that made the change can recognise its
        own event and not re-apply it. It is not identity and is not
        trusted for anything.
    """

    model_config = ConfigDict(extra="forbid")

    changes: Dict[str, Any]
    expected_revision: Optional[int] = Field(default=None, ge=0)
    client_id: Optional[str] = Field(default=None, max_length=64)


def _store(request: Request) -> ui_preferences_store.UiPreferencesStore:
    """Return the process's preference store.

    Description: resolved off ``app.state``, which is where ``main.py``
      mounts it at startup. A request arriving before the mount is a
      genuine server error rather than something to paper over with an
      empty block: answering "no preferences are stored" would invite a
      client to save its defaults over the user's real settings.
    Inputs: request (Request).
    Output: UiPreferencesStore.
    Raises: HTTPException 503 when the store is not mounted.
    """
    store = getattr(request.app.state, "ui_preferences_store", None)
    if store is None:
        raise HTTPException(
            status_code=503, detail="preferences are not available yet"
        )
    return store


@router.get("/preferences", dependencies=[Depends(require_auth)])
async def get_preferences(request: Request) -> Dict[str, Any]:
    """The whole block: schema version, revision and every stored value.

    Description: THE AUTHORITATIVE REFRESH. A client calls this on
      startup before it initialises any preference-dependent control,
      and again on reconnect, because events are an optimisation and the
      server is the source of truth.
    Inputs: request (Request).
    Output: dict - ``{"status", "schema_version", "revision", "values"}``.
      ``status`` reads ``unchanged`` because a read moved nothing; GET
      and PATCH share one body shape rather than two.
    """
    return _store(request).as_result().as_payload()


@router.patch("/preferences", dependencies=[Depends(require_auth)])
async def update_preferences(
    request: Request, body: PreferencesUpdateRequest
) -> Dict[str, Any]:
    """Apply a partial update, and tell every other client what moved.

    Description: validates, takes the config write lock, re-reads
      config.json inside it, checks the expected revision against THAT
      read, merges and commits. On success it broadcasts
      ``preferences.changed`` carrying the new revision and the fields
      that actually moved.
    Inputs: request (Request); body (PreferencesUpdateRequest).
    Output: dict - the committed values and the revision, so the client
      confirms persistence from the response rather than assuming it.
    Raises:
      HTTPException 400: a field failed validation. The detail is a
        plain sentence and never quotes a refused value.
      HTTPException 409: the expected revision is stale. The body
        carries the CURRENT revision and values to reconcile against.
      HTTPException 500: config.json is missing or unreadable.

    Example:
        PATCH {"changes": {"sidebar_density": "compact"},
               "expected_revision": 4}
    """
    store = _store(request)

    try:
        result = store.update(body.changes, body.expected_revision)
    except FileNotFoundError as exc:
        logger.error("preferences_config_missing", error=str(exc))
        raise HTTPException(
            status_code=500, detail="Configuration not found. Run setup_auth.py first."
        )

    if result.status == ui_preferences_store.REJECTED_INVALID:
        raise HTTPException(status_code=400, detail=result.detail)

    if result.status == ui_preferences_store.STALE_REVISION:
        # 409, with what is current in the body. A bare 409 would leave
        # the client able to say only "that failed", which is how a
        # retry loop against an unchanged conflict gets written.
        raise HTTPException(status_code=409, detail=result.as_payload())

    if result.status == ui_preferences_store.COMMITTED:
        await _broadcast_changed(request, result, body.client_id)

    return result.as_payload()


async def _broadcast_changed(
    request: Request,
    result: ui_preferences_store.UpdateResult,
    client_id: Optional[str],
) -> None:
    """Fan ``preferences.changed`` out to every connected client.

    Description: FAIL-SOFT. The change is already committed by the time
      this runs, so a broadcast failure must not turn a successful save
      into an error the user sees - the other clients simply learn about
      it on their next authoritative refresh, which is the fallback the
      design already relies on for a screen that holds no socket.
    Inputs: request (Request); result (UpdateResult) - a COMMITTED one;
      client_id (str|None) - echoed so the originator can skip its own
      event.
    Output: None.
    """
    manager = getattr(request.app.state, "connection_manager", None)
    if manager is None:
        return

    frame = {
        "type": PREFERENCES_CHANGED_EVENT,
        "schema_version": ui_preferences.SCHEMA_VERSION,
        "revision": result.revision,
        "changed": result.changed,
        "origin_client_id": client_id,
    }
    # ONTO THE PER-BROWSER CHANNEL FIRST, because that is the one that
    # reaches a client with no terminal open - the gap this function's
    # own docstring recorded when it shipped. It never awaits and never
    # raises.
    session_change_notice.publish(request.app.state, frame)

    # AND STILL OVER THE TERMINAL SOCKET, which is not a second mechanism
    # left running by accident. A browser holding both receives the frame
    # twice, and that is SAFE BY CONSTRUCTION rather than by luck:
    # ``Preferences.applyRemote`` applies a frame only when its revision
    # is strictly higher than the one it holds, so the duplicate is the
    # same no-op a redelivered frame has always been. Dropping this half
    # would break every already-loaded client that has no event socket
    # yet, for no gain.
    try:
        await manager.broadcast(json.dumps(frame))
    except (TypeError, ValueError) as exc:
        # A value the block accepted but json cannot encode would be a
        # defect in validation, not in the transport, so it is logged
        # loudly rather than swallowed silently.
        logger.error(
            "preferences_changed_broadcast_unencodable",
            revision=result.revision,
            fields=sorted(result.changed.keys()),
            error=str(exc),
        )
    except OSError as exc:
        logger.warning(
            "preferences_changed_broadcast_failed",
            revision=result.revision,
            error=str(exc),
        )
