"""HTTP-facing glue between the project routes and the authority layer.

Kept out of src/api/auth.py so the routes stay thin and this logic - which
is where the authority inversion actually bites - is readable on its own.
Every function here does the same three things in the same order:

  1. resolve the current authority mode (``resolve_projects``),
  2. refuse the operation if that mode is not writable,
  3. mutate the database, then refresh the config.json snapshot.

Step 3 is never reordered. The snapshot is written AFTER the database
commit, because writing it first would leave config.json describing a
transaction that a rollback means never happened.

A FAILED SNAPSHOT DOES NOT FAIL THE REQUEST. The database is
authoritative and it recorded what the user asked for; telling them the
operation failed would be a lie that invites a destructive retry. The
failure is logged and returned in the response's ``snapshot`` block, so a
surface can warn that the rollback file is now stale without pretending
the change did not happen.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog
from fastapi import HTTPException

from src.core import project_authority as authority
from src.core.project_authority import (
    ProjectsReadOnlyError,
    ProjectsView,
    refresh_snapshot,
    require_writable,
    resolve_projects,
)

logger = structlog.get_logger()


def config_projects_for(settings: Any) -> List[Any]:
    """Load config.json's project entries, tolerating an absent file.

    Description: the authority layer needs the config list for two
      purposes - the diff, and the degraded fallback - and neither is
      worth failing a request over when config.json is missing. A missing
      config is reported as an empty list, which the diff then renders as
      every DB project being ``only_in_db``: visible, named, and true.
      It is never allowed to raise past this point, because a config
      problem must not be able to take down a database-backed read.
    Inputs: settings (Any) - the Settings singleton.
    Output: list - ProjectConfig objects, empty when config.json is
      missing or unparseable.
    Example: config_projects_for(settings) -> [ProjectConfig(...)]
    """
    try:
        return list(settings.load_auth_config().projects)
    except Exception as exc:  # noqa: BLE001 - a config fault is not a 500 here
        logger.warning("projects_config_unreadable", error=str(exc))
        return []


def config_path_for(settings: Any) -> Path:
    """Resolve the config.json path the snapshot writes to.

    Inputs: settings (Any) - the Settings singleton.
    Output: Path - ``settings.auth_config_file`` with ``~`` expanded.
    """
    return Path(settings.auth_config_file).expanduser()


def current_view(settings: Any) -> ProjectsView:
    """Resolve the project list and the authority mode it came from.

    Inputs: settings (Any) - the Settings singleton.
    Output: ProjectsView.
    Example: current_view(settings).mode -> "db"
    """
    return resolve_projects(settings.get_state_dir(), config_projects_for(settings))


def _snapshot_block(settings: Any) -> Dict[str, Any]:
    """Refresh config.json and render the result for a response body.

    Inputs: settings (Any) - the Settings singleton.
    Output: dict - ``{"ok", "reason", "detail"}``.
    """
    result = refresh_snapshot(settings.get_state_dir(), config_path_for(settings))
    if not result.ok:
        logger.warning(
            "project_rollback_snapshot_stale",
            reason=result.reason,
            detail=result.detail,
        )
    return {"ok": result.ok, "reason": result.reason, "detail": result.detail}


def readonly_http_error(exc: ProjectsReadOnlyError) -> HTTPException:
    """Translate a refused write into the HTTP response for it.

    Description: 503, not 500. The server is fine; the datastore it needs
      is not, and the condition is expected to clear. The body names the
      mode so a client can render "read-only rollback mode" rather than a
      generic outage.
    Inputs: exc (ProjectsReadOnlyError).
    Output: HTTPException - status 503.
    """
    return HTTPException(
        status_code=503,
        detail=(
            "cloude.db is unreachable, so project changes are refused. "
            "Projects are currently being served from config.json in "
            f"read-only rollback mode. ({exc.detail})"
        ),
    )


def open_db_or_503(settings: Any):
    """Open the authoritative database for a write, or raise 503.

    Description: the write path opens its own connection rather than
      reusing the one ``resolve_projects`` used and closed, because
      sqlite3 connections are thread-affine and the two calls can land on
      different worker threads.
    Inputs: settings (Any) - the Settings singleton.
    Output: sqlite3.Connection - caller must close it.
    Raises: HTTPException 503 - the database could not be opened.
    """
    from src.core.db import DatastoreUnreadableError, connect, db_path_for

    try:
        return connect(db_path_for(settings.get_state_dir()), create=False)
    except DatastoreUnreadableError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"cloude.db is unreachable, so the change was refused. ({exc})",
        )


def guard_writable(settings: Any) -> ProjectsView:
    """Resolve the authority mode and refuse the request if it is read-only.

    Inputs: settings (Any) - the Settings singleton.
    Output: ProjectsView - always writable when this returns.
    Raises: HTTPException 503 - the mode forbids writes.
    """
    view = current_view(settings)
    try:
        require_writable(view)
    except ProjectsReadOnlyError as exc:
        raise readonly_http_error(exc)
    return view


def finish_write(settings: Any) -> Dict[str, Any]:
    """Refresh the rollback snapshot after a committed mutation.

    Inputs: settings (Any) - the Settings singleton.
    Output: dict - the ``snapshot`` block for the response body.
    """
    return _snapshot_block(settings)


def authority_payload(settings: Any) -> Dict[str, Any]:
    """Render the full authority + disagreement report.

    Description: the body of GET /projects/authority. Carries the mode,
      whether writes are allowed, and the DB-versus-config diff. When the
      database is unreachable the diff is null rather than empty, so a
      client cannot read "could not compare" as "they agree".
    Inputs: settings (Any) - the Settings singleton.
    Output: dict.
    Example: authority_payload(settings)["mode"] -> "db"
    """
    view = current_view(settings)
    payload = view.to_dict()
    payload["config_path"] = str(config_path_for(settings))
    return payload


def views_to_responses(view: ProjectsView, response_cls: Any) -> List[Any]:
    """Render a ProjectsView's projects as the API's response models.

    Inputs: view (ProjectsView). response_cls (type) - ProjectResponse.
    Output: list - one response model per project, order preserved.
    """
    return [
        response_cls(
            id=item["id"],
            name=item["name"],
            path=item["path"],
            description=item["description"],
            root=item["root"],
        )
        for item in view.projects
    ]


def resolve_target(conn: Any, name: str) -> Dict[str, Any]:
    """Turn a display name from a URL path into exactly one project row.

    Description: translates the write layer's two distinct lookup
      failures into two distinct HTTP statuses. An ambiguous name is 409,
      not 404 and not a silent pick of the first row - the project the
      user meant does exist, the server just cannot tell which one, and
      that is a conflict the user has to resolve by renaming.
    Inputs: conn (sqlite3.Connection). name (str).
    Output: dict - the matching row.
    Raises: HTTPException 404 or 409.
    """
    from src.core.project_writes import (
        ProjectNameAmbiguous,
        ProjectNotFound,
        resolve_by_name,
    )

    try:
        return resolve_by_name(conn, name)
    except ProjectNotFound:
        raise HTTPException(status_code=404, detail=f"Project '{name}' not found")
    except ProjectNameAmbiguous as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{name}' does not identify one project: {exc}. "
                "Rename one of them before editing either."
            ),
        )


def touch_project_best_effort(settings: Any, working_dir: str) -> Optional[Dict]:
    """Mark a project most-recently-opened, and refresh the snapshot.

    Description: the replacement for ``Settings.move_project_to_top``,
      called when a session starts in a directory. Best-effort in the
      same way the original was - a session must never fail to start
      because the launcher's ordering could not be updated - but unlike
      the original it distinguishes "no project at that path" (a normal
      miss, returns None) from "the datastore could not be reached" (a
      warning in the log), rather than swallowing both in one bare
      ``except Exception``.
    Inputs: settings (Any) - the Settings singleton. working_dir (str).
    Output: dict | None - the touched row, or None if nothing matched or
      the update could not be attempted.
    """
    from contextlib import closing

    from src.core.project_writes import touch_project_by_path

    try:
        with closing(open_db_or_503(settings)) as conn:
            row = touch_project_by_path(conn, working_dir)
    except HTTPException as exc:
        logger.warning(
            "project_touch_datastore_unreachable",
            working_dir=working_dir,
            detail=exc.detail,
        )
        return None
    except Exception as exc:  # noqa: BLE001 - never breaks session creation
        logger.warning(
            "project_touch_failed", working_dir=working_dir, error=str(exc)
        )
        return None

    if row is None:
        return None
    _snapshot_block(settings)
    return row


def agent_type_for(settings: Any, project_name: str) -> Optional[str]:
    """Look up a project's default agent type from the authoritative source.

    Description: feat/db-is-authoritative. Reads ``projects``, falling
      back to config.json when the datastore is unreachable, so a session
      launched during a datastore outage still gets the right agent
      rather than silently dropping to the "claude" default. Returns None
      both when the project is unknown and when it has no default; the
      caller treats both the same way, so splitting them here would be a
      distinction with no consumer.
    Inputs: settings (Any) - the Settings singleton. project_name (str) -
      display name as sent with the create-session request.
    Output: str | None - the project's ``default_agent_type``.
    Example: agent_type_for(settings, "CloudeCode") -> "claude"
    """
    view = current_view(settings)
    for item in view.projects:
        if item["name"] == project_name:
            return item["agent_type"]
    return None


__all__ = [
    "agent_type_for",
    "authority_payload",
    "config_path_for",
    "config_projects_for",
    "current_view",
    "finish_write",
    "guard_writable",
    "open_db_or_503",
    "readonly_http_error",
    "resolve_target",
    "touch_project_best_effort",
    "views_to_responses",
    "authority",
]
