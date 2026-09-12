"""The main REST API router, assembled from one sibling module per resource.

This file used to BE the API: 4,397 lines and 51 routes in one module.
Decomposition slice S6 moved every handler to a sibling next door, one per
resource, following the pattern ``src/api/`` already used for archive,
toasts, status, restart, recreate, groups, away, corpus, imported restart,
config files and version. What is left here is the assembly.

**ORDER IS THE CONTRACT, and it is why this list is not alphabetical.**
FastAPI matches a request against routes in REGISTRATION order, first one
wins. The includes below are in exactly the order the 51 routes were
declared in the flat file, so the assembled table is identical to the one
this replaced - route for route, position for position. A sibling whose
routes were NOT contiguous in the original keeps a second router rather
than being moved: ``provider_models_routes`` exports
``local_models_router`` for the one route that registered second, so the
model catalog can live in one module without any route changing position.
Add a new route by adding it to the sibling that owns its resource, and
put the include where the route belongs, not at the end.

**NOTHING IS RE-EXPORTED FROM HERE BUT ``router``, deliberately.** The
suite patches handler helpers by module - ``monkeypatch.setattr(mod,
"_bundled_themes_root", ...)`` and friends - and a name rebound on THIS
module would not be seen by the sibling that actually reads it. The patch
would go green over nothing, which is the silent direction of failure. So
a test reaches for the module that owns the name.

``src/api/auth.py`` is the other router and is mounted separately in
``src/main.py``; it registers BEFORE this one.
"""

from fastapi import APIRouter

from src.api import agent_wrappers_routes
from src.api import filesystem_routes
from src.api import health_routes
from src.api import hook_event_routes
from src.api import projects_presence_routes
from src.api import provider_models_routes
from src.api import server_control_routes
from src.api import session_attach_routes
from src.api import session_attribution_routes
from src.api import session_crud_routes
from src.api import session_discovery_routes
from src.api import session_fork_routes
from src.api import session_import_status_routes
from src.api import session_input_routes
from src.api import session_logs_routes
from src.api import session_recent_routes
from src.api import session_records_routes
from src.api import session_rename_routes
from src.api import session_restart_apply_routes
from src.api import session_theme_routes
from src.api import session_toast_routes
from src.api import terminal_commands_routes
from src.api import themes_routes
from src.core.version import freeze_startup_version

# PIN THE VERSION NOW, AT IMPORT, WHICH IS SERVER STARTUP.
#
# This module is imported while the server is coming up, so this is the
# earliest moment the running process can honestly answer "which code am I".
# It must happen before anything can rewrite the VERSION file underneath us:
# macOS/bootstrap.js stamps that file on every packaged launch, so an upgraded
# bundle landing while an older server is still running would otherwise make
# the OLD process report the NEW version. That false match is exactly what
# lets an upgrade silently adopt a stale server. See
# src/core/version.py::freeze_startup_version for the full account.
#
# Idempotent, and cheap: in production the answer comes from the
# CLOUDE_APP_VERSION env var that Electron injects at spawn.
#
# IT STAYS HERE, ON THE AGGREGATOR. src/main.py imports this module while
# it boots, so this is still the first moment; moving it onto a sibling
# would tie the pin to whichever sibling happened to be imported first.
freeze_startup_version()

router = APIRouter()

# The order below is the original declaration order of the flat module.
# See the module docstring: it is the route table's matching order and it
# is not to be tidied into alphabetical.
router.include_router(session_discovery_routes.router)
router.include_router(provider_models_routes.local_models_router)
router.include_router(session_fork_routes.router)
router.include_router(session_restart_apply_routes.router)
router.include_router(session_crud_routes.router)
router.include_router(session_attach_routes.router)
router.include_router(session_theme_routes.router)
router.include_router(session_rename_routes.router)
router.include_router(session_input_routes.router)
router.include_router(session_toast_routes.router)
router.include_router(hook_event_routes.router)
router.include_router(session_logs_routes.router)
router.include_router(filesystem_routes.router)
router.include_router(terminal_commands_routes.router)
router.include_router(provider_models_routes.router)
router.include_router(agent_wrappers_routes.router)
router.include_router(health_routes.router)
router.include_router(themes_routes.router)
router.include_router(server_control_routes.router)
router.include_router(projects_presence_routes.router)
router.include_router(session_records_routes.router)
router.include_router(session_recent_routes.router)
router.include_router(session_attribution_routes.router)
router.include_router(session_import_status_routes.router)
