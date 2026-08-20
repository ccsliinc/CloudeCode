"""The one place that answers "where do projects come from right now".

THE INVERSION. Before this module, config.json was authoritative for
projects and the ``projects`` table was a shadow imported from it. That
is now reversed. The table is authoritative for every read and every
write; config.json is a rollback artifact, kept current by
``project_snapshot`` so a user can delete cloude.db and come back up on
the file, exactly as they could before the datastore existed.

Every project read and every project write in the application goes
through this module. That is not tidiness, it is the mechanism: the
moment two call sites each decide for themselves whether to trust the
database, the answer can differ between them and the user sees one screen
disagree with another.

THREE OUTCOMES, NOT TWO. "Read the projects" resolves to exactly one of:

  db                   cloude.db opened and answered. Authoritative.
                       Writes allowed.
  config_fallback      cloude.db could not be opened or could not be
                       read. The list is served FROM config.json, the
                       mode SAYS SO, and writes are REFUSED. This is the
                       degraded rollback mode. It is never rendered as
                       though the database agreed, and nothing is written
                       back to config.json while in it - a write in this
                       state would be an unwitnessed edit to the only
                       intact copy of the user's data.
  db_empty_config_has  the database opened, is readable, and holds no
                       projects, while config.json holds some. This is
                       NOT "you have no projects". It is its own outcome
                       because the two indistinguishable causes - a fresh
                       install whose import has not run, and a database
                       that lost its rows - have opposite correct
                       responses, and serving an empty list would pick
                       the wrong one silently.

WHY FALLBACK READS ARE ALLOWED BUT FALLBACK WRITES ARE NOT. A read from
config.json in degraded mode is the user's own data, correct as of the
last successful snapshot, clearly labelled. A write would be the app
mutating the rollback artifact while unable to see the thing that
artifact is supposed to be a copy of - it could not detect a conflict,
could not record the change anywhere durable, and would destroy the very
snapshot the user is about to need. So: read degraded, refuse to write,
and say which.
"""

from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

from src.core.db import DatastoreUnreadableError, connect, db_path_for
from src.core.project_diff import ProjectDiff, diff_projects
from src.core.project_reconcile import reconcile_summary
from src.core.project_snapshot import SnapshotResult, snapshot_projects
from src.core.project_writes import list_projects_ordered

logger = structlog.get_logger()

# The named modes. Each is a distinct outcome; none collapses into
# another, and none of them is a boolean in disguise.
MODE_DB = "db"
MODE_CONFIG_FALLBACK = "config_fallback"
MODE_DB_EMPTY_CONFIG_HAS = "db_empty_config_has"

# Modes in which a project write must be refused. Listed rather than
# derived from "not MODE_DB" so that adding a future mode forces an
# explicit decision about whether it may write.
READONLY_MODES = (MODE_CONFIG_FALLBACK,)


class ProjectsReadOnlyError(RuntimeError):
    """A project write was attempted while the datastore was unreachable.

    Description: carries the mode and the underlying detail so the HTTP
      layer can render the specific reason rather than a generic 503.
    Inputs (constructor): mode (str), detail (str).
    Output: a ProjectsReadOnlyError instance.
    """

    def __init__(self, mode: str, detail: str) -> None:
        super().__init__(detail)
        self.mode = mode
        self.detail = detail


@dataclass(frozen=True)
class ProjectsView:
    """The resolved answer to one project read, with its provenance.

    Description: the list and the reason the list is what it is travel
      together, always. A caller cannot obtain the projects without also
      obtaining the mode they came from, which is what makes it
      impossible to render degraded data as healthy by forgetting a
      second lookup.
    Inputs (constructor): mode (str - one of the MODE_* constants),
      projects (list[dict] - each ``{"id", "name", "path", "description",
      "root", "agent_type"}``; ``id`` is None in config_fallback because
      a config entry has no row), message (str - one sentence for a
      user), detail (str | None - the underlying error, when there is
      one), diff (ProjectDiff | None - None when the comparison could not
      be made, never an empty diff standing in for "agreed"),
      reconcile (dict | None - what the last startup project reconcile
      did; None only when the database could not be read, since a
      reconcile record is written on every start).
    Output: a ProjectsView instance.
    """

    mode: str
    projects: List[Dict[str, Any]] = field(default_factory=list)
    message: str = ""
    detail: Optional[str] = None
    diff: Optional[ProjectDiff] = None
    reconcile: Optional[Dict[str, Any]] = None

    @property
    def writable(self) -> bool:
        """Whether a project mutation may proceed in this mode.

        Inputs: none.
        Output: bool - False for every READONLY_MODES member.
        """
        return self.mode not in READONLY_MODES

    @property
    def degraded(self) -> bool:
        """Whether this read came from anywhere other than the database.

        Inputs: none.
        Output: bool.
        """
        return self.mode != MODE_DB

    def to_dict(self) -> Dict[str, Any]:
        """Render the authority block for GET /projects/authority.

        Description: ``diff`` renders as null rather than as an
          agreed-looking empty object when the comparison could not be
          made, so a client cannot read "could not compare" as "they
          agree". ``diff_state`` names which of the two it is without the
          client having to type-sniff, matching what db_state.py does for
          its version fields.
        Inputs: none.
        Output: dict.
        """
        return {
            "mode": self.mode,
            "writable": self.writable,
            "degraded": self.degraded,
            "message": self.message,
            "detail": self.detail,
            "project_count": len(self.projects),
            "diff": self.diff.to_dict() if self.diff is not None else None,
            "diff_state": "known" if self.diff is not None else "cannot_determine",
            # WHAT THE LAST STARTUP RECONCILE DID. A repair the user
            # cannot see is the same shape as the defect it fixes: a
            # correct-looking screen and no account of what happened to
            # his projects. Carries its own "state" and
            # "cannot_determine", so a client can tell "nothing needed
            # doing" from "this has never run" from "some projects could
            # not be classified" without inferring any of the three.
            "reconcile": self.reconcile,
        }


def _row_to_view(row: Dict[str, Any]) -> Dict[str, Any]:
    """Project one authoritative table row into the API's project shape.

    Inputs: row (dict) - a ``projects`` table row.
    Output: dict - ``{"id", "name", "path", "description", "root",
      "agent_type"}``.
    """
    return {
        "id": row["id"],
        "name": row["display_name"],
        "path": row["raw_path"],
        "description": row["description"],
        "root": row["root"],
        "agent_type": row["default_agent_type"],
    }


def _config_to_view(cfg: Any) -> Dict[str, Any]:
    """Project one config.json entry into the API's project shape.

    Description: ``id`` is None, deliberately and visibly. A config entry
      has no database row, so inventing an id would let the launcher key
      child sessions off a number that means nothing - which is a quieter
      version of the exact duplication bug this change fixes.
    Inputs: cfg (ProjectConfig-like) - has ``name``, ``path``,
      ``description``, optionally ``agent_type``.
    Output: dict.
    """
    from src.core.project_diff import normalize_root

    return {
        "id": None,
        "name": cfg.name,
        "path": cfg.path,
        "description": getattr(cfg, "description", None),
        "root": normalize_root(cfg.path),
        "agent_type": getattr(cfg, "agent_type", None),
    }


def _dedupe_config_views(config_projects: Any) -> List[Dict[str, Any]]:
    """Render config entries as project views, one per unique root.

    Description: the fallback path deduplicates too. If it did not, the
      degraded mode would show his three ``ses_ec5bf2a3`` nodes again -
      so the moment the database went unreachable, the bug this change
      exists to fix would come straight back, and it would look like a
      regression rather than a fallback. Keeps the FIRST entry for a
      root, which is the same rule ``import_from_config`` applies, so the
      fallback list matches what the database would have held.
    Inputs: config_projects (Iterable) - ProjectConfig-like objects.
    Output: list[dict] - project views in config array order.
    """
    seen: set[str] = set()
    views: List[Dict[str, Any]] = []
    for cfg in config_projects:
        view = _config_to_view(cfg)
        if view["root"] in seen:
            continue
        seen.add(view["root"])
        views.append(view)
    return views


def resolve_projects(state_dir: Path, config_projects: Any) -> ProjectsView:
    """Read the project list from whichever source is answering right now.

    Description: the single read entry point. Opens cloude.db with
      ``create=False`` - never create=True, for the same reason
      db_health.py gives: opening with creation turns "your database is
      missing" into a brand-new empty file that renders as a healthy
      install containing none of your work.

      On success the returned view carries a ProjectDiff against
      config.json, so a caller that wants to surface disagreement has it
      without a second read. On failure the view carries the config
      entries, mode ``config_fallback``, and a message that says the
      database could not be reached - never an empty list, and never a
      list that looks authoritative.
    Inputs: state_dir (Path) - where cloude.db lives.
      config_projects (Iterable) - ``AuthConfig.projects``, already
      loaded by the caller. Passing it in rather than loading it here
      keeps this module free of the Settings machinery and makes the
      degraded path testable without a config file on disk.
    Output: ProjectsView.
    Example: resolve_projects(settings.get_state_dir(), cfg.projects).mode
    """
    config_list = list(config_projects)
    db_file = db_path_for(state_dir)

    try:
        with closing(connect(db_file, create=False)) as conn:
            rows = list_projects_ordered(conn)
            reconcile = reconcile_summary(conn)
    except DatastoreUnreadableError as exc:
        return _fallback(config_list, str(exc), db_file)
    except Exception as exc:  # noqa: BLE001 - a read surface must not 500
        return _fallback(config_list, f"{type(exc).__name__}: {exc}", db_file)

    diff = diff_projects(rows, config_list)

    if not rows and config_list:
        return ProjectsView(
            mode=MODE_DB_EMPTY_CONFIG_HAS,
            projects=_dedupe_config_views(config_list),
            message=(
                "cloude.db opened cleanly but holds no projects, while "
                f"config.json holds {len(config_list)}. Showing config.json's "
                "projects. This is NOT a claim that you have no projects - "
                "either the one-time import has not run yet, or the table "
                "lost its rows."
            ),
            detail=f"db_projects=0 config_projects={len(config_list)}",
            diff=diff,
            reconcile=reconcile,
        )

    return ProjectsView(
        mode=MODE_DB,
        projects=[_row_to_view(row) for row in rows],
        message="projects are served from cloude.db, which is authoritative.",
        diff=diff,
        reconcile=reconcile,
    )


def _fallback(
    config_list: List[Any], detail: str, db_file: Path
) -> ProjectsView:
    """Build the degraded read-only view served from config.json.

    Description: ``diff`` is None, not an empty ProjectDiff. There is
      nothing to compare against - the database could not be read - and
      an empty diff would render as "the two sources agree", which is a
      verdict nobody measured.
    Inputs: config_list (list) - ProjectConfig-like objects.
      detail (str) - the underlying failure. db_file (Path).
    Output: ProjectsView in MODE_CONFIG_FALLBACK.
    """
    logger.warning(
        "projects_config_fallback", db_path=str(db_file), error=detail
    )
    return ProjectsView(
        mode=MODE_CONFIG_FALLBACK,
        projects=_dedupe_config_views(config_list),
        message=(
            "cloude.db is UNREACHABLE. Projects are being served from "
            "config.json in read-only rollback mode - adding, renaming and "
            "removing projects is refused until the datastore is readable "
            "again, so the rollback file is not edited while the database "
            "cannot be seen."
        ),
        detail=detail,
        diff=None,
    )


def require_writable(view: ProjectsView) -> None:
    """Refuse a mutation unless the authoritative source is answering.

    Description: called at the top of every write path. Raises rather
      than returning a flag so a caller cannot proceed by forgetting to
      check the result.
    Inputs: view (ProjectsView) - from a fresh ``resolve_projects`` call.
    Output: None.
    Raises: ProjectsReadOnlyError - when ``view.writable`` is False.
    Example: require_writable(resolve_projects(d, cfg.projects))
    """
    if not view.writable:
        raise ProjectsReadOnlyError(view.mode, view.detail or view.message)


def refresh_snapshot(state_dir: Path, config_path: Path) -> SnapshotResult:
    """Rewrite config.json's projects from the authoritative table.

    Description: called after every successful mutation. Re-reads the
      table rather than accepting a caller-supplied list, so the snapshot
      is a picture of what the database actually holds after the commit
      and not of what the caller believed it wrote.

      A database that cannot be read here does NOT clobber config.json -
      it returns a failed SnapshotResult and leaves the file alone.
      Writing an empty projects array because the source could not be
      read is precisely how a rollback artifact turns into a
      data-destruction tool.
    Inputs: state_dir (Path) - where cloude.db lives. config_path (Path)
      - the config.json to refresh.
    Output: SnapshotResult - ``ok`` False with a named reason on any
      failure; never raises.
    Example: refresh_snapshot(d, Path("config.json")).ok -> True
    """
    from src.core.project_snapshot import SNAPSHOT_WRITE_FAILED

    db_file = db_path_for(state_dir)
    try:
        with closing(connect(db_file, create=False)) as conn:
            rows = list_projects_ordered(conn)
    except Exception as exc:  # noqa: BLE001 - never raises to the caller
        logger.warning(
            "project_snapshot_source_unreadable",
            db_path=str(db_file),
            error=str(exc),
        )
        return SnapshotResult(
            ok=False,
            reason=SNAPSHOT_WRITE_FAILED,
            detail=(
                f"cloude.db could not be read ({exc}), so config.json was "
                "left exactly as it was rather than being overwritten with "
                "a project list nobody could verify."
            ),
            path=str(config_path),
        )

    return snapshot_projects(config_path, rows)
