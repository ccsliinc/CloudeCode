"""The recent sessions list, built from stored rows.

Recent is where a session goes when its pane dies, so this list carries
rows that no live listing will ever show. It excludes ``kind='automated'``
by default: only a fact the machinery itself wrote may say automated, and
NULL or ``unknown`` both list, because not having looked is not evidence
of automation.
"""

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from src.api.auth import require_auth
from src.config import settings
from src.models import RecentSessionsResponse

from src.api.session_record_payload import _session_record_payload

# MODULE SCOPE, DELIBERATELY. run_in_threadpool was imported inside
# individual handlers, so any NEW handler in the same module that used
# it raised ``NameError: name 'run_in_threadpool' is not defined`` -
# which FastAPI turns into a bare 500 with no body. Two routes shipped
# that way and both failed with three digits and nothing to act on.
# tests/test_route_names_resolve.py fails the build if a module uses
# this name without binding it here.
from fastapi.concurrency import run_in_threadpool

logger = structlog.get_logger()
router = APIRouter()


@router.get(
    "/sessions/recent",
    response_model=RecentSessionsResponse,
    dependencies=[Depends(require_auth)],
)
async def list_recent_sessions(
    request: Request,
    include_archived: bool = Query(
        False,
        description=(
            "Include DELETED (archived) session records alongside the "
            "live ones. Defaults false, which is the pre-existing "
            "behaviour exactly. Archived rows arrive mixed in, each "
            "carrying its own archived_at, so the client distinguishes "
            "them per row. NOTE the vocabulary difference from projects: "
            "a session's archive is a soft DELETE ('take this off my "
            "screen'), a project's archive is a SHELF ('done with this "
            "for now'). Same column shape, different meaning."
        ),
    ),
    include_automated: bool = Query(
        False,
        description=(
            "Include rows classified kind='automated' - a scheduler run "
            "or a headless `claude -p` probe. DEFAULTS FALSE, and it is "
            "ORTHOGONAL to include_archived: both filters apply, so "
            "include_archived=true still hides automated rows unless "
            "this is set too. Rows with kind NULL or 'unknown' are "
            "returned EITHER WAY. No UI sets this."
        ),
    ),
):
    """RECENT (S9): stored ``stopped`` sessions, datastore-backed.

    Description: the query is exactly ``lifecycle='stopped' AND
      archived_at IS NULL`` (unless ``include_archived`` drops the
      second clause) via ``session_store.list_sessions`` - no
      timer, no retention window, the first launcher surface backed by
      the datastore rather than a live probe.

      THREE-OUTCOME GATE ON PROBE HEALTH. The stored rows are only
      returned when ``session_manager.last_probe_health().ok`` is
      True - i.e. the most recent tmux listing (normally the home
      screen's own ``GET /sessions/attachable`` poll) succeeded. A
      failed or never-run probe returns ``state != 'ok'`` and an EMPTY
      ``sessions`` list instead of the stored rows: RESTART safety
      depends on a 'stopped' row being trustworthy right now, and a
      probe we could not just confirm cannot make that promise. This
      never re-probes tmux itself - it reads whatever health the last
      probe (run by any caller) left behind, so viewing RECENT adds no
      tmux load beyond what the launcher already pays.

      DEFENSE IN DEPTH: even though the SQL already filters to
      ``lifecycle='stopped'``, any row that somehow is not exactly
      'stopped' is dropped again here before it reaches the wire. A
      guarantee is only as good as the layer that enforces it, and this
      route is closer to the wire than the query.
    Inputs: request (Request) - unused beyond auth; carries
      ``request.app.state.session_manager``.
    Output: RecentSessionsResponse.
    Raises: HTTPException 503 - the datastore exists but is unreadable.
    """
    from contextlib import closing


    from src.core import session_store
    from src.core.db import DatastoreUnreadableError, connect, db_path_for
    from src.core.db_models import (
        SESSION_LIFECYCLE_RUNNING,
        SESSION_LIFECYCLE_STOPPED,
    )

    session_manager = request.app.state.session_manager
    health = request.app.state.services.probe_health.health

    if health.ok is not True:
        state = "never_probed" if health.ok is None else "probe_unavailable"
        notice = (
            "Recent sessions CANNOT BE DETERMINED: no tmux probe has "
            "run yet this session."
            if state == "never_probed"
            else "Recent sessions CANNOT BE DETERMINED: the last tmux "
            f"probe failed (reason: {health.reason or 'unknown'}). "
            "Stored history is not shown as fact until a probe succeeds."
        )
        return RecentSessionsResponse(state=state, sessions=[], notice=notice)

    db_path = db_path_for(settings.get_state_dir())
    if not db_path.exists():
        return RecentSessionsResponse(state="ok", sessions=[])

    def _read() -> list:
        """Open, read and close on ONE pooled thread.

        Inputs: none (closes over db_path).
        Output: list[dict] - raw session rows already filtered to
          ``lifecycle='stopped'``, and to ``archived_at IS NULL`` unless
          the caller asked for archived rows too.
        """
        with closing(connect(db_path, create=False)) as conn:
            rows = session_store.list_sessions(
                conn,
                lifecycle=SESSION_LIFECYCLE_STOPPED,
                include_archived=include_archived,
                include_automated=include_automated,
            )
            # A SESSION APPEARS IN EXACTLY ONE LIST, and this is the half
            # the client cannot do for itself.
            #
            # Restarts made BEFORE row reuse landed left an abandoned row
            # behind and started a new one pointing back at it. The
            # abandoned row is stopped, so it lands in RECENT, while its
            # successor is running and lands in RUNNING - the same
            # session, twice, which is exactly the duplication the owner
            # sees. The client cannot filter these by name: the two rows
            # legitimately carry DIFFERENT tmux names
            # ("Media_Compression" and "cloude_Media_Compression"), so a
            # name comparison misses them entirely.
            #
            # ``parent_session_id`` is not a heuristic and needs no
            # classifier - it is a stored fact saying this row was
            # replaced by that one. When the successor is running, this
            # row is ALREADY on screen as that successor, so listing it
            # again is a duplicate rather than history.
            #
            # This is legacy cleanup, not a mechanism. A restart no
            # longer creates a parent link at all (see
            # session_restart.rebind_instance), so nothing new can ever
            # enter this set.
            # FAIL OPEN. If this read cannot be made, we do not know
            # whether anything is represented elsewhere - and the two
            # errors are not symmetrical. Showing a duplicate is untidy;
            # HIDING a session the user can no longer reach from this
            # screen is the failure a list filter must never produce. So
            # an unevaluable read excludes nothing.
            try:
                replaced = {
                    int(r["parent_session_id"])
                    for r in conn.execute(
                        "SELECT parent_session_id FROM sessions"
                        " WHERE lifecycle = ?"
                        " AND parent_session_id IS NOT NULL",
                        (SESSION_LIFECYCLE_RUNNING,),
                    ).fetchall()
                }
            except Exception as exc:  # noqa: BLE001 - see FAIL OPEN above
                logger.warning(
                    "recent_replaced_scan_unavailable",
                    error=str(exc),
                    error_type=type(exc).__name__,
                    note=(
                        "could not read which rows a running session "
                        "replaced; nothing excluded, so a duplicate may "
                        "show rather than a session going missing"
                    ),
                )
                return rows
            if not replaced:
                return rows
            return [
                row for row in rows
                if row.get("id") not in replaced
            ]

    try:
        rows = await run_in_threadpool(_read)
    except DatastoreUnreadableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    # Defense in depth - see docstring. Never trust the SQL filter alone
    # to be the only place this invariant is enforced.
    stopped_rows = [
        row for row in rows if row.get("lifecycle") == SESSION_LIFECYCLE_STOPPED
    ]
    return RecentSessionsResponse(
        state="ok",
        sessions=[_session_record_payload(row) for row in stopped_rows],
    )
