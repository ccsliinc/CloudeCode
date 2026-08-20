"""Re-read config.json's projects against the table, on EVERY start.

THE DEFECT THIS REPLACES, measured by executing an upgrade / downgrade /
re-upgrade round trip rather than by reading the migration's promises:

    config: 6 projects   db: 5 rows   served_mode: "db"   degraded: false
    in_config_but_not_in_db: ["roundtrip-probe-after-downgrade"]

A project the OLD version created while the user was downgraded never
reached the projects table, because the config-projects import ran behind
``meta.imported_from_json_at`` - a latch stamped exactly once per install,
ever. Nothing warned. Every three-outcome check in ``project_authority``
reported healthy, correctly, because the database ANSWERED - it just
answered with the wrong row set, which is the one failure shape a
three-outcome check cannot see. Then the first project write called
``snapshot_projects``, which rebuilds config.json's ``projects`` key
wholesale from the table, and the entry left the file as well. At that
point it is unrecoverable.

WHY THE LATCH WAS RIGHT FOR SESSIONS AND WRONG FOR PROJECTS. The sessions
import reads a LIVE TMUX PROCESS TABLE - an input that is gone by
tomorrow, which is why re-running it could destroy history and why
``session_import`` guards it so carefully. The projects import reads
config.json, a durable file that says the same thing every time it is
read. Re-reading it costs nothing and can only ever add rows the table
has never seen. So the sessions latch stays exactly as it is and the
projects stage moves out from behind it.

THE QUESTION THIS MODULE HAS TO ANSWER HONESTLY
-----------------------------------------------
A root is in config.json and not in ``projects``. There are three causes,
not two, and the third is the whole reason this file is careful:

  NEVER IMPORTED      the old version wrote it during a downgrade, or the
                      first-run import has not run. -> IMPORT it.

  DELETED ON PURPOSE  the user removed it through the new version.
                      -> LEAVE IT DELETED. Resurrecting it is a silent
                      data defect of its own, and a worse one: the user
                      made a decision and the app quietly reversed it.
                      ``project_tombstones`` is what makes this knowable.

  CANNOT EVALUATE     the deletion, if it was one, happened before the
                      tombstone table existed, so no evidence survives
                      either way. -> NAMED, COUNTED, REPORTED. Not
                      imported, because that would undo a deletion on a
                      guess; not skipped quietly, because that would hide
                      exactly the loss this module exists to catch.

THE THIRD STATE IS BOUNDED AND FINITE, which is what keeps it from
becoming permanent furniture. It can only contain roots that were already
unexplained at the moment tracking began - captured ONCE, on the first
reconcile after the v4 -> v5 migration, into
``meta.project_reconcile_undetermined_roots``. Every root that appears
after that instant is covered by tombstones and classifies cleanly. So a
fresh install has an empty undetermined set forever, and an upgraded
install has one bounded list to resolve rather than a recurring question.

ORDERING AND THE KEEP-THE-FIRST RULE are ``import_from_config``'s, not
this module's. Reconcile delegates the actual insert to it precisely so
that ``project_attribution``, ``project_snapshot``, ``project_authority``
and ``project_diff`` keep depending on ONE implementation of "one row per
unique root, first config entry wins".
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

import structlog

from src.core.db import get_meta, set_meta, table_exists
from src.core.db_models import (
    META_PROJECT_RECONCILE_LAST,
    META_PROJECT_RECONCILE_UNDETERMINED,
)
from src.core.project_store import (
    PROJECTS_TABLE,
    ProjectConfigLike,
    import_from_config,
    normalize_root,
)
from src.core.project_tombstones import TOMBSTONES_TABLE, legacy_gap
from src.core.trail_entry import utc_now

logger = structlog.get_logger()

#: The four things that can happen to one config.json entry. Named
#: constants rather than bare strings so the summary keys, the log fields
#: and the tests cannot drift apart.
RECONCILE_IMPORTED = "imported"
RECONCILE_ALREADY_PRESENT = "already_present"
RECONCILE_SKIPPED_DELETED = "skipped_deleted"
RECONCILE_UNDETERMINED = "undetermined"

#: Every outcome, in report order. RECONCILE_UNDETERMINED is LAST on
#: purpose: it is the one a reader must not stop before reaching.
RECONCILE_OUTCOMES = (
    RECONCILE_IMPORTED,
    RECONCILE_ALREADY_PRESENT,
    RECONCILE_SKIPPED_DELETED,
    RECONCILE_UNDETERMINED,
)


@dataclass(frozen=True)
class ReconcileResult:
    """What one reconcile pass did, and what it could not decide.

    Description: three-outcome by construction. ``undetermined`` is a
      list, never a count folded into either neighbour, so a caller
      cannot render a reconcile as clean without first noticing that
      something could not be evaluated.
    Inputs (constructor): imported (list[dict]) - entries newly inserted,
      each ``{"root", "name"}``. already_present (int) - config entries
      whose root already had a row. skipped_deleted (list[dict]) -
      entries left out because the user deleted them, each carrying the
      tombstone's ``deleted_at`` where known. undetermined (list[dict]) -
      entries whose absence CANNOT be explained. duplicates_dropped
      (list[dict]) - later config entries for a root an earlier entry
      already claimed, from ``import_from_config``'s keep-the-first rule.
    Output: a ReconcileResult instance.
    """

    imported: List[Dict[str, Any]] = field(default_factory=list)
    already_present: int = 0
    skipped_deleted: List[Dict[str, Any]] = field(default_factory=list)
    undetermined: List[Dict[str, Any]] = field(default_factory=list)
    duplicates_dropped: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        """Whether this pass altered the table.

        Inputs: none.
        Output: bool.
        """
        return bool(self.imported)

    @property
    def cannot_determine(self) -> bool:
        """Whether anything in this pass could not be evaluated.

        Description: the flag a caller must consult before treating a
          reconcile as a clean result. True does NOT mean something is
          broken; it means a question was asked and no evidence exists to
          answer it.
        Inputs: none.
        Output: bool.
        """
        return bool(self.undetermined)

    def notice(self) -> Optional[str]:
        """One sentence for the user, or None when there is nothing to say.

        Description: the presence of a notice means "something happened
          to your projects". A reconcile that imported nothing and could
          evaluate everything returns None, so a silent start is a
          measured silence rather than an unreported one.
        Inputs: none.
        Output: str | None.
        Example:
          ReconcileResult(imported=[{"root": "/a", "name": "a"}]).notice()
        """
        parts: List[str] = []
        if self.imported:
            names = ", ".join(e["name"] for e in self.imported)
            parts.append(
                f"{len(self.imported)} project(s) in config.json were not in "
                f"the database and have been restored: {names}."
            )
        if self.skipped_deleted:
            parts.append(
                f"{len(self.skipped_deleted)} project(s) in config.json stay "
                "removed because you deleted them here."
            )
        if self.undetermined:
            roots = ", ".join(e["root"] for e in self.undetermined)
            parts.append(
                f"{len(self.undetermined)} project(s) in config.json are not "
                "in the database and this install predates deletion "
                "tracking, so it CANNOT BE DETERMINED whether they were "
                "never imported or you deleted them. They have been left "
                f"alone rather than guessed at: {roots}."
            )
        return " ".join(parts) if parts else None

    def to_dict(self) -> Dict[str, Any]:
        """Render the pass for storage and for GET /projects/authority.

        Description: ``cannot_determine`` travels with the counts so a
          client cannot read the outcome tallies without also being told
          whether the tallies are complete.
        Inputs: none.
        Output: dict.
        """
        return {
            "at": utc_now(),
            "outcomes": {
                RECONCILE_IMPORTED: len(self.imported),
                RECONCILE_ALREADY_PRESENT: self.already_present,
                RECONCILE_SKIPPED_DELETED: len(self.skipped_deleted),
                RECONCILE_UNDETERMINED: len(self.undetermined),
            },
            "imported": self.imported,
            "skipped_deleted": self.skipped_deleted,
            "undetermined": self.undetermined,
            "duplicates_dropped": self.duplicates_dropped,
            "cannot_determine": self.cannot_determine,
            "notice": self.notice(),
        }


def _stored_undetermined(conn: sqlite3.Connection) -> Optional[List[str]]:
    """Read the captured undetermined root list.

    Description: returns None when the capture has never happened, which
      is a different fact from an empty capture - the first means "this
      install has not been assessed yet", the second means "it was
      assessed and nothing was ambiguous". Collapsing them would re-open
      the assessment on every start and let a root that was resolved slip
      back into the unknown pile.
    Inputs: conn (sqlite3.Connection).
    Output: list[str] | None.
    """
    raw = get_meta(conn, META_PROJECT_RECONCILE_UNDETERMINED)
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        logger.error(
            "project_reconcile_undetermined_unreadable",
            raw=str(raw)[:200],
            note=(
                "the captured ambiguous-root list cannot be read, so every "
                "unexplained absence is treated as undetermined rather "
                "than imported on the strength of a record nobody could "
                "parse"
            ),
        )
        return []
    return [str(r) for r in parsed] if isinstance(parsed, list) else []


def reconcile_projects(
    conn: sqlite3.Connection,
    projects: Iterable[ProjectConfigLike],
    *,
    now: Optional[str] = None,
) -> ReconcileResult:
    """Import every config project the table has never seen. Idempotent.

    Description: runs on EVERY start, not once per install. Classifies
      each config.json entry into one of ``RECONCILE_OUTCOMES`` and acts
      only on ``imported``; the insert itself is delegated to
      ``project_store.import_from_config`` so the keep-the-first
      duplicate rule has exactly one implementation.

      SAFE TO RUN REPEATEDLY BY CONSTRUCTION: an entry whose root already
      has a row is ``already_present`` and no statement is executed for
      it, so a second pass over the same config changes nothing and
      touches no ``updated_at``.

      THE FIRST PASS ON AN UPGRADED INSTALL also captures the bounded set
      of roots it cannot explain (see the module docstring). That capture
      happens once and is what keeps CANNOT EVALUATE from being asked
      afresh, and answered differently, on every later start.
    Inputs: conn (sqlite3.Connection) - caller owns the transaction.
      projects (Iterable[ProjectConfigLike]) - ``AuthConfig.projects``.
      now (str | None) - fixed clock for tests.
    Output: ReconcileResult.
    Example: reconcile_projects(conn, auth_config.projects).imported
    """
    stamp = now or utc_now()
    if not table_exists(conn, PROJECTS_TABLE):
        return ReconcileResult()

    existing = {
        row[0] for row in conn.execute("SELECT root FROM projects").fetchall()
    }
    entries = list(projects)

    # NO TOMBSTONE TABLE MEANS NO EVIDENCE, so nothing here can be
    # classified and NOTHING may be imported. A database below schema v5
    # cannot distinguish a project that was never imported from one the
    # user deleted, so importing on that basis would undo deletions
    # blindly. Report every unexplained root as undetermined and,
    # critically, do NOT write the capture record: capturing a verdict
    # from a schema that cannot hold the evidence would freeze a guess in
    # place and stop the real assessment ever running after the migration.
    if not table_exists(conn, TOMBSTONES_TABLE):
        blocked = ReconcileResult(
            already_present=sum(
                1 for c in entries if normalize_root(c.path) in existing
            ),
            undetermined=[
                {
                    "root": normalize_root(c.path),
                    "name": c.name,
                    "reason": "deletion_tracking_unavailable",
                }
                for c in entries
                if normalize_root(c.path) not in existing
            ],
        )
        set_meta(
            conn, META_PROJECT_RECONCILE_LAST, json.dumps(blocked.to_dict())
        )
        logger.warning(
            "project_reconcile_unavailable",
            undetermined=len(blocked.undetermined),
            note=(
                "schema is below v5 so project_tombstones does not exist; "
                "nothing was imported because a deliberate deletion cannot "
                "be told from a project that was never imported"
            ),
        )
        return blocked

    tombstones = {
        row[0]: row[1]
        for row in conn.execute(
            "SELECT root, deleted_at FROM project_tombstones"
        ).fetchall()
    }
    unexplained = [
        cfg
        for cfg in entries
        if normalize_root(cfg.path) not in existing
        and normalize_root(cfg.path) not in tombstones
    ]

    # THE CAPTURE, once per install. Everything unexplained at the moment
    # tracking began is ambiguous forever; everything that appears later
    # is not, because a deletion after this point leaves a tombstone.
    captured = _stored_undetermined(conn)
    if captured is None:
        captured = (
            sorted({normalize_root(c.path) for c in unexplained})
            if legacy_gap(conn)
            else []
        )
        set_meta(
            conn, META_PROJECT_RECONCILE_UNDETERMINED, json.dumps(captured)
        )
        if captured:
            logger.warning(
                "project_reconcile_ambiguous_roots_captured",
                roots=captured,
                note=(
                    "this database held project history before deletion "
                    "tracking existed, so these roots CANNOT BE CLASSIFIED "
                    "as never-imported or deliberately-deleted; they are "
                    "left untouched and reported rather than guessed at"
                ),
            )
    ambiguous = set(captured)

    result_imported: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    undetermined: List[Dict[str, Any]] = []
    already = 0
    to_import: List[ProjectConfigLike] = []

    for cfg in entries:
        root = normalize_root(cfg.path)
        if root in existing:
            already += 1
        elif root in tombstones:
            skipped.append(
                {
                    "root": root,
                    "name": cfg.name,
                    "deleted_at": tombstones[root],
                }
            )
        elif root in ambiguous:
            undetermined.append(
                {
                    "root": root,
                    "name": cfg.name,
                    "reason": "predates_deletion_tracking",
                }
            )
        else:
            to_import.append(cfg)

    duplicates: List[Dict[str, Any]] = []
    if to_import:
        outcome = import_from_config(conn, to_import, now=stamp)
        duplicates = list(outcome.dropped)
        dropped_roots = {d["root"] for d in duplicates}
        result_imported = [
            {"root": normalize_root(c.path), "name": c.name}
            for c in to_import
            if normalize_root(c.path) not in dropped_roots
        ]

    # The keep-the-first rule also applies WITHIN the already-present
    # group: two config entries for one root produce one row, and the
    # second is a duplicate whether or not this pass inserted anything.
    seen: set = set()
    for cfg in entries:
        root = normalize_root(cfg.path)
        if root in seen:
            duplicates.append(
                {
                    "name": cfg.name,
                    "raw_path": cfg.path,
                    "root": root,
                    "reason": "duplicate_root",
                }
            )
        seen.add(root)
    # import_from_config already reported the duplicates it refused; the
    # sweep above re-derives the same set from the config list, so collapse
    # them on root rather than reporting a root twice.
    deduped: Dict[str, Dict[str, Any]] = {}
    for entry in duplicates:
        deduped.setdefault(entry["root"], entry)

    result = ReconcileResult(
        imported=result_imported,
        already_present=already,
        skipped_deleted=skipped,
        undetermined=undetermined,
        duplicates_dropped=list(deduped.values()),
    )

    set_meta(
        conn, META_PROJECT_RECONCILE_LAST, json.dumps(result.to_dict())
    )
    log = logger.warning if result.cannot_determine else logger.info
    log(
        "project_reconcile",
        imported=len(result.imported),
        already_present=result.already_present,
        skipped_deleted=len(result.skipped_deleted),
        undetermined=len(result.undetermined),
        cannot_determine=result.cannot_determine,
    )
    return result


def reconcile_summary(conn: sqlite3.Connection) -> Dict[str, Any]:
    """What the last reconcile did, for the wizard and /projects/authority.

    Description: the repair must be VISIBLE. A reconcile that silently
      restores projects leaves the user with what he had before - a
      correct-looking screen and no account of what happened to his data.

      NEVER RUN means never run. A database with no stored record returns
      ``state: "never_run"`` rather than a zeroed tally, because a
      fabricated all-clear is the exact defect this whole subsystem keeps
      having to undo.
    Inputs: conn (sqlite3.Connection).
    Output: dict - the stored ``ReconcileResult.to_dict``, or a
      ``{"state": "never_run", ...}`` marker.
    Example: reconcile_summary(conn)["outcomes"]["imported"]
    """
    raw = get_meta(conn, META_PROJECT_RECONCILE_LAST)
    if not raw:
        return {
            "state": "never_run",
            "at": None,
            "outcomes": None,
            "cannot_determine": None,
            "notice": None,
        }
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError) as exc:
        return {
            "state": "unreadable",
            "at": None,
            "outcomes": None,
            "cannot_determine": None,
            "notice": (
                "the project reconcile record exists but cannot be read "
                f"({exc}), so what the last reconcile did CANNOT BE "
                "DETERMINED"
            ),
        }
    parsed["state"] = "ok"
    return parsed
