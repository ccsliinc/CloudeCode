"""The model catalogs: the OpenRouter list, and the local one.

"Claude" is implicit and never appears in the stored list - it is the
client's always-present first option, never stored and never removable.
These endpoints manage only the add/remove-able catalog persisted at
``config.json``'s ``providers.models``.

THE MODEL ID FORMAT IS A SHELL-INJECTION GUARD, not a tidiness rule:
``Settings.get_agent_command`` interpolates the id into a command string,
so it is enforced here with an explicit 400 and again by
``CreateSessionRequest.model``'s validator on the session-create path.

``GET /providers/local/models`` is the separate local (LM Studio /
Ollama) probe, and it registers FIRST in the aggregated table, which is
why it carries its own router.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from src.api.auth import require_auth
from src.config import settings
from src.models import (
    AddProviderModelRequest,
    LocalModelsResponse,
    ProviderModelsResponse,
    describe_model_id_rejection,
    is_valid_model_id,
)

logger = structlog.get_logger()
local_models_router = APIRouter()
router = APIRouter()


@local_models_router.get(
    "/providers/local/models",
    response_model=LocalModelsResponse,
    dependencies=[Depends(require_auth)],
)
async def list_local_models():
    """List the chat models an LM Studio server is serving.

    Description: ALWAYS answers 200. A box that is off is a state the
      picker renders, not an API failure - see LocalModelsResponse.

      The address comes from ``providers.local_host`` in config.json and
      there is deliberately NO endpoint that sets it. This handler makes an
      outbound request to whatever that value names, so a setter would be
      an SSRF surface reachable with one authenticated POST. Editing
      config.json is already box-level access; a route is not.
    Output: LocalModelsResponse.
    """
    from src.core.local_models import fetch_local_models, to_payload

    try:
        host = settings.load_auth_config().providers.local_host
    except Exception as exc:  # noqa: BLE001 - a bad config is a STATE here
        logger.warning("local_models_config_unreadable", error=str(exc))
        return LocalModelsResponse(
            state="not-configured",
            detail=f"could not read the provider config: {exc}",
        )

    # The probe is blocking I/O with its own deadline; keep it off the
    # event loop so a slow box cannot stall every other request.
    result = await run_in_threadpool(fetch_local_models, host)
    return LocalModelsResponse(**to_payload(result))


# ---- provider-selector modal (v3.1) --------------------------------------
#
# "Claude" is implicit and never appears in this list - it's the client's
# always-present first option, never stored/removable. These endpoints
# manage ONLY the add/remove-able OpenRouter model catalog persisted at
# config.json's top-level "providers.models" (see ``Settings.get_provider_models``
# / ``add_provider_model`` / ``remove_provider_model`` in src/config.py).
# Model id format (the shell-injection guard - ``Settings.get_agent_command``
# interpolates the id into a shell command string) is enforced here with an
# explicit 400, matching ``CreateSessionRequest.model``'s pydantic validator
# (src/models.py) which guards the session-create path the same way.


@router.get(
    "/providers",
    response_model=ProviderModelsResponse,
    dependencies=[Depends(require_auth)],
)
async def list_provider_models():
    """List the persisted OpenRouter model catalog for the provider modal."""
    return ProviderModelsResponse(models=settings.get_provider_models())


@router.post(
    "/providers/models",
    response_model=ProviderModelsResponse,
    dependencies=[Depends(require_auth)],
)
async def add_provider_model(body: AddProviderModelRequest):
    """Add an OpenRouter model id to the provider catalog.

    Raises:
        HTTPException(400): model id doesn't match ``MODEL_ID_PATTERN`` - the
            detail names the specific reason, not a generic pattern dump.
        HTTPException(409): model id already present.
    """
    if not is_valid_model_id(body.model):
        raise HTTPException(
            status_code=400,
            detail=describe_model_id_rejection(body.model),
        )

    try:
        models = settings.add_provider_model(body.model)
    except ValueError as e:
        # add_provider_model only raises ValueError for a duplicate (format
        # was already checked above) - 409 Conflict is the right semantic.
        raise HTTPException(status_code=409, detail=str(e))

    return ProviderModelsResponse(models=models)


@router.delete(
    "/providers/models/{model:path}",
    response_model=ProviderModelsResponse,
    dependencies=[Depends(require_auth)],
)
async def remove_provider_model(model: str):
    """Remove an OpenRouter model id from the provider catalog.

    ``{model:path}`` (not the default ``{model}``) because model ids
    contain ``/`` (e.g. ``openai/gpt-5.6-sol``) - the plain converter
    would truncate at the first slash.

    Raises:
        HTTPException(404): model id isn't in the catalog.
    """
    try:
        models = settings.remove_provider_model(model)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    return ProviderModelsResponse(models=models)
