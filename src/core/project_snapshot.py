"""Write config.json's ``projects`` array from the authoritative DB rows.

WHAT CHANGED, AND WHY. Before feat/db-is-authoritative, config.json was
the source of truth for projects and the ``projects`` table was a shadow
imported from it once. That is now inverted: the table is authoritative
for every read and every write, and config.json is a ROLLBACK ARTIFACT -
a coherent, always-current snapshot a user can fall back to by deleting
cloude.db, exactly as they could before the datastore existed.

The point of the inversion is that the revert path must not depend on the
migration trail working. If the trail is what you have to replay to get
your projects back, then a corrupt trail loses your projects. A plain
JSON file that the pre-datastore code already knows how to read loses
nothing.

WRITE STRATEGY: WRITE-THROUGH, SYNCHRONOUS, AFTER COMMIT. Every mutation
that changes project state writes the whole snapshot immediately, in the
same request, once the database transaction has committed. Not debounced,
not deferred to shutdown.

  - The event rate is human-scale. Creating, renaming, deleting or
    reordering a project happens a handful of times a day, not per
    keystroke. There is no hot path to protect and nothing measurable to
    win by batching.
  - A shutdown-time flush is worthless precisely when it is needed. The
    scenarios that make a user reach for the rollback file - a crash, a
    kill -9, a power cut, a corrupted database - are the same scenarios
    in which an at-exit hook does not run. A snapshot that is stale at
    the moment you need it is not a rollback artifact, it is a decoy.
  - After commit, never before. Writing the file first would make
    config.json describe a database state that a rolled-back transaction
    means never existed.

A SNAPSHOT FAILURE IS ITS OWN OUTCOME. If the DB write succeeds and the
config write fails (read-only filesystem, full disk, a directory that has
been renamed out from under us), the mutation is NOT rolled back - the
database is authoritative and it correctly recorded what the user asked
for. But the caller is told, by ``SnapshotResult.ok == False`` with a
named reason, so the surface can say "your change was saved but your
rollback file is now stale" rather than reporting unqualified success.
Silently swallowing it would leave the user believing in a fallback that
has quietly stopped tracking reality - the same false-green class this
whole subsystem exists to kill.

DUPLICATES ARE NOT RESURRECTED. His live config.json holds 13 entries
that collapse onto 9 unique roots. The snapshot writes the 9. See
``build_projects_array`` for the full argument.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import structlog

from src.core.config_files_io import atomic_write

logger = structlog.get_logger()

# Reasons a snapshot did not happen. Each is a distinct outcome; none of
# them is ever reported as a successful write.
SNAPSHOT_OK = "ok"
SNAPSHOT_CONFIG_MISSING = "config_missing"
SNAPSHOT_CONFIG_UNPARSEABLE = "config_unparseable"
SNAPSHOT_WRITE_FAILED = "write_failed"

# The keys of one entry in config.json's ``projects`` array, in the order
# the pre-datastore writer emitted them. Held to deliberately: a rollback
# artifact is only useful if the code you are rolling back TO can read it,
# so the shape must not drift ahead of the reader.
_ENTRY_KEYS = ("name", "path", "description")


@dataclass(frozen=True)
class SnapshotResult:
    """The outcome of one attempt to refresh the rollback artifact.

    Description: three-outcome by construction - ``ok`` True means the
      file on disk now matches the database; ``ok`` False always carries
      a named ``reason`` and a human-readable ``detail``. There is no
      state in which a caller can read this object and be unable to tell
      which happened.
    Inputs (constructor): ok (bool), reason (str - one of the SNAPSHOT_*
      constants), written (int - project entries in the file after the
      write, 0 when nothing was written), detail (str | None),
      path (str | None - the config file targeted).
    Output: a SnapshotResult instance.
    """

    ok: bool
    reason: str
    written: int = 0
    detail: Optional[str] = None
    path: Optional[str] = None


def build_projects_array(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Render authoritative project rows into config.json's array shape.

    Description: one entry per DB row, which is one row per UNIQUE ROOT,
      because ``projects.root`` carries a UNIQUE constraint. The
      duplicate entries that the original config.json carried are NOT
      written back.

      That is a deliberate choice, and the argument for it is that a
      rollback artifact must describe REALITY, not history. His config
      held "test pause", "ses_ec5bf2a3" and "qqwe" all pointing at
      ``/Users/jsugamele/Development/ses_ec5bf2a3``; the launcher drew
      three project nodes that each expanded to the same two child
      sessions, so the same work appeared three times on screen. Writing
      those rows back would mean that reverting to config.json restores
      the bug the user is reverting to escape.

      The dropped names are not lost. ``import_from_config`` recorded
      every one it refused in ``meta.imported_from_json_result``, that
      record survives in the database, and
      ``project_diff.diff_projects`` reports any config entry with no DB
      row as ``only_in_config`` so it is visible rather than silently
      absent. The information is kept; only the duplication is dropped.

      Archived rows are the caller's business - pass the list you want
      written. ``description`` is emitted even when null so the entry
      shape is stable across snapshots and a diff of the file shows real
      changes rather than key churn.
    Inputs: rows (Iterable[dict]) - ``projects`` table rows, each with at
      least ``display_name``, ``raw_path`` and ``description``. Order is
      preserved exactly as given; the caller decides the ordering that
      matters (most-recently-used first, as the launcher shows it).
    Output: list[dict] - each ``{"name", "path", "description"}``.
    Example: build_projects_array([{"display_name": "app",
      "raw_path": "~/app", "description": None}])
      -> [{"name": "app", "path": "~/app", "description": None}]
    """
    entries: List[Dict[str, Any]] = []
    for row in rows:
        entries.append(
            {
                "name": row["display_name"],
                "path": row["raw_path"],
                "description": row.get("description"),
            }
        )
    return entries


def _read_config(config_path: Path) -> Dict[str, Any]:
    """Load the existing config.json so a snapshot preserves every other key.

    Description: the snapshot rewrites ONLY the ``projects`` key.
      Notifications, agents, uploads, terminal_commands, config_version
      and everything else is read back and written out untouched. A
      snapshot that dropped them would turn the rollback artifact into a
      different kind of data loss.
    Inputs: config_path (Path) - the config.json to read.
    Output: dict - the parsed document.
    Raises: FileNotFoundError - the file does not exist.
      json.JSONDecodeError - the file is not parseable JSON.
    """
    with open(config_path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise json.JSONDecodeError("config root is not an object", "", 0)
    return data


def snapshot_projects(
    config_path: Path, rows: Iterable[Dict[str, Any]]
) -> SnapshotResult:
    """Refresh config.json's ``projects`` array from authoritative DB rows.

    Description: read the whole document, replace exactly the
      ``projects`` key, write it back atomically (tmp, flush, fsync,
      ``os.replace``) so a crash mid-write can never leave a truncated
      rollback artifact - a half-written fallback file is worse than a
      stale one, because a stale one still parses.

      Never raises. Every failure is returned as a SnapshotResult with
      ``ok`` False and a named reason, because the caller has already
      committed the authoritative write and must not be handed an
      exception that makes a succeeded mutation look failed.

      A MISSING config.json is a real outcome, not an invitation to
      create one. The file carries auth material and a config_version;
      manufacturing a fresh one here would write a document whose other
      keys are all defaults, which is a worse rollback target than no
      file at all. Reported as ``config_missing``.
    Inputs: config_path (Path) - destination, typically
      ``settings.auth_config_file`` expanded. rows (Iterable[dict]) -
      authoritative project rows in the order they should appear.
    Output: SnapshotResult.
    Example: snapshot_projects(Path("config.json"), db_rows).ok -> True
    """
    entries = build_projects_array(rows)
    path_str = str(config_path)

    try:
        data = _read_config(config_path)
    except FileNotFoundError:
        logger.warning("project_snapshot_config_missing", path=path_str)
        return SnapshotResult(
            ok=False,
            reason=SNAPSHOT_CONFIG_MISSING,
            detail=(
                "config.json does not exist, so the rollback snapshot could "
                "not be written. The database change was saved."
            ),
            path=path_str,
        )
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        logger.warning(
            "project_snapshot_config_unreadable", path=path_str, error=str(exc)
        )
        return SnapshotResult(
            ok=False,
            reason=SNAPSHOT_CONFIG_UNPARSEABLE,
            detail=(
                f"config.json could not be parsed ({exc}), so it was left "
                "untouched rather than overwritten. The database change was "
                "saved, but the rollback snapshot is now stale."
            ),
            path=path_str,
        )

    data["projects"] = entries

    try:
        atomic_write(config_path, json.dumps(data, indent=2) + "\n")
    except OSError as exc:
        logger.warning(
            "project_snapshot_write_failed", path=path_str, error=str(exc)
        )
        return SnapshotResult(
            ok=False,
            reason=SNAPSHOT_WRITE_FAILED,
            detail=(
                f"config.json could not be written ({exc}). The database "
                "change was saved, but the rollback snapshot is now stale."
            ),
            path=path_str,
        )

    logger.info("project_snapshot_written", path=path_str, count=len(entries))
    return SnapshotResult(
        ok=True, reason=SNAPSHOT_OK, written=len(entries), path=path_str
    )
