"""The user-defined launch wrappers.

Replaces the hardcoded cld/cldor zsh functions with named wrappers; see
``src/core/agent_wrappers.py`` for the schema and the resolution model. A
wrapper's own ``id`` is also a valid ``agent_type`` for ``POST
/sessions``, so launching through a specific wrapper needs no extra
field.

AN ``agent_type`` IS AN ID, NEVER A COMMAND, and an unconfigured id is a
400 rather than a silent fall back to the default wrapper: a user who
asks for ``claude-chrome`` and quietly gets ``claude-skip-permissions``
has been lied to.
"""

from fastapi import APIRouter, Depends, HTTPException
from src.api.auth import require_auth
from src.config import settings
from src.core.agent_wrappers import AgentWrapper, EXAMPLE_WRAPPERS
from src.models import WrapperExamplesResponse, WrapperListResponse

router = APIRouter()


# ---- launch wrappers (feat/launch-wrappers) -------------------------------
#
# Replaces the hardcoded cld/cldor zsh functions with user-defined, named
# wrappers (see src/core/agent_wrappers.py for the schema and resolution
# model). A wrapper's own ``id`` is also a valid ``agent_type`` value for
# ``POST /sessions`` - launching through a specific wrapper needs no
# separate field, see CreateSessionRequest.agent_type's docstring.


def _wrapper_response(wrappers) -> WrapperListResponse:
    """Build the shared wrapper-endpoint response.

    Description: every wrapper endpoint returns the full list PLUS the
      family registry, so one round trip is enough to re-render the
      settings screen's per-family groups after any mutation. Family
      state (``wrapper_count`` / ``in_use``) is derived server-side by
      ``Settings._family_summaries`` so the client never re-implements the
      wrapper-beats-static-command precedence rule.
    Inputs: wrappers (list) - AgentWrapper objects or already-dumped dicts.
    Output: WrapperListResponse.
    """
    dumped = [w if isinstance(w, dict) else w.model_dump() for w in wrappers]
    try:
        families = settings._family_summaries(settings.load_auth_config().agents)
    except Exception:
        # A degraded config must not fail a wrapper read; the UI falls
        # back to rendering groups from the wrappers themselves.
        families = []
    return WrapperListResponse(wrappers=dumped, families=families)


@router.get(
    "/agents/wrappers",
    response_model=WrapperListResponse,
    dependencies=[Depends(require_auth)],
)
async def list_wrappers():
    """List every configured launch wrapper, full script included."""
    try:
        agents = settings.load_auth_config().agents
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load config: {e}")
    return _wrapper_response(agents.wrappers)


@router.get(
    "/agents/wrappers/examples",
    response_model=WrapperExamplesResponse,
    dependencies=[Depends(require_auth)],
)
async def list_wrapper_examples():
    """Offer known-good example wrappers (the author's real cld/cldor
    functions) for a user to import. Never auto-installed - see
    ``src.core.agent_wrappers.EXAMPLE_WRAPPERS``."""
    return WrapperExamplesResponse(wrappers=list(EXAMPLE_WRAPPERS))


@router.post(
    "/agents/wrappers",
    response_model=WrapperListResponse,
    dependencies=[Depends(require_auth)],
)
async def add_wrapper(body: AgentWrapper):
    """Add a new launch wrapper.

    Raises:
        HTTPException(409): id already exists, or id collides with a
            reserved agent_type (codex/hermes/openclaw/shell).
    """
    try:
        wrappers = settings.add_wrapper(body)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return _wrapper_response(wrappers)


@router.patch(
    "/agents/wrappers/{wrapper_id}",
    response_model=WrapperListResponse,
    dependencies=[Depends(require_auth)],
)
async def update_wrapper(wrapper_id: str, body: AgentWrapper):
    """Replace an existing wrapper's fields. ``body.id`` must equal ``wrapper_id``.

    Raises:
        HTTPException(404): wrapper not found.
        HTTPException(400): body.id doesn't match wrapper_id in the URL.
    """
    try:
        wrappers = settings.update_wrapper(wrapper_id, body)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except ValueError as e:
        detail = str(e)
        status = 400 if "cannot be changed" in detail else 404
        raise HTTPException(status_code=status, detail=detail)
    return _wrapper_response(wrappers)


@router.delete(
    "/agents/wrappers/{wrapper_id}",
    response_model=WrapperListResponse,
    dependencies=[Depends(require_auth)],
)
async def delete_wrapper(wrapper_id: str):
    """Remove a launch wrapper.

    Raises:
        HTTPException(404): wrapper not found.
    """
    try:
        wrappers = settings.delete_wrapper(wrapper_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _wrapper_response(wrappers)


@router.post(
    "/agents/wrappers/{wrapper_id}/default",
    response_model=WrapperListResponse,
    dependencies=[Depends(require_auth)],
)
async def set_default_wrapper(wrapper_id: str):
    """Mark a wrapper as the default (clears the flag on every other one).

    Raises:
        HTTPException(404): wrapper not found.
    """
    try:
        wrappers = settings.set_default_wrapper(wrapper_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _wrapper_response(wrappers)
