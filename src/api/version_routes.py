"""Version and release self-check routes.

Exposes the installed release tag and the cached result of the background
update check. Both are cheap reads: the update endpoint NEVER performs a
network call in the request path, it returns whatever the background thread
last stored, with its timestamp, so a stale answer is visibly stale.

CONSUMER CONTRACT. ``GET /api/v1/version`` returns exactly this shape, and it
is the documented feed for the home bottom bar's version chip and for the
server-status panel that renders the detail:

    {
      "version": "0.8.1",          # installed tag, "" if it did not resolve
      "update": {
        "status": "current" | "update_available" | "unknown",
        "current_version": "0.8.1",
        "latest_version": "0.9.0", # "" unless status is update_available
        "remote": "https://github.com/...",
        "checked_at": 1755000000.0,  # unix seconds; 0 means never checked
        "reason": "",              # non-empty ONLY when status is unknown
        "upgrade_command": "open https://github.com/.../releases/latest"
      }
    }

THE PATH IS ``/api/v1/version`` AND THERE IS NO SECOND ONE. The server-status
panel was originally written against a hypothetical ``/api/v1/server/release``
with a tri-valued ``update_available`` boolean; that client was changed to
this path and this shape, because an explicit three-value ``status`` string
cannot be accidentally collapsed to two the way ``null`` versus ``false`` can.
``client/js/api.js`` ``getReleaseStatus()`` and
``client/js/server-status-format.js`` ``renderRelease()`` are the only two
consumers.

THE COPY, all three states, lowercase to match the rest of the ui:

    current           "up to date (v0.8.1)"
    update_available  "update available: v0.9.0 - run: <upgrade_command>"
    unknown           "could not check for updates - <reason>"

``unknown`` must render as its own thing. It is NOT "up to date". Anything
that collapses it into the current state is a false green.

Each line is suffixed with the age of ``checked_at``, for example
"checked 2 hours ago", so nobody reads a week-old answer as fresh.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends

from src.api.auth import require_auth
from src.core.update_check import UpdateChecker
from src.core.version import resolve_version

router = APIRouter()

# Set once at app startup by src/main.py. None means the checker was not
# constructed, in which case the update block reports "unknown" rather than
# pretending the install is current.
_checker: Optional[UpdateChecker] = None


def set_update_checker(checker: Optional[UpdateChecker]) -> None:
    """Install the process-wide update checker.

    Args:
        checker: the checker instance, or None to clear it (used by tests).
    """
    global _checker
    _checker = checker


@router.get("/version", dependencies=[Depends(require_auth)])
async def get_version() -> dict:
    """Return the installed version and the cached update-check result.

    Returns:
        The shape documented in this module's docstring. Never blocks on a
        network call.
    """
    if _checker is None:
        return {
            "version": resolve_version(),
            "update": {
                "status": "unknown",
                "current_version": resolve_version(),
                "latest_version": "",
                "remote": "",
                "checked_at": 0.0,
                "reason": "the update checker is not running",
                "upgrade_command": "",
            },
        }
    status = _checker.status()
    return {"version": resolve_version(), "update": status.to_dict()}
