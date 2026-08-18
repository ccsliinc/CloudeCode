"""Compare the authoritative ``projects`` table against config.json.

WHY A DIFF EXISTS AT ALL. Once the database is authoritative and
config.json is a snapshot of it, the two should agree at all times. They
will not always. A user can edit config.json by hand (which is the whole
reason the file is still there), a snapshot write can fail on a full
disk, a crash can land between the commit and the file write, or the app
can be downgraded to a build that still writes config directly.

The rule this module implements is that disagreement is a REPORTABLE
STATE, never something to resolve silently by picking a winner. The
database is authoritative and stays authoritative - that decision does
not get relitigated per request - but "the DB won" is not the same
sentence as "there was nothing to win", and a surface that only ever
prints the first has erased information the user needed.

THE THREE SHAPES OF DISAGREEMENT, each named separately because each has
a different cause and a different fix:

  only_in_db       a project the app knows about that the rollback file
                   does not. Reverting right now would lose it. Usually
                   means a snapshot write failed after a create.
  only_in_config   a project in the rollback file with no row. Either a
                   hand edit the app has not adopted, or one of the
                   duplicate-root entries the import deliberately did not
                   carry over (which is why ``duplicate_config_roots`` is
                   reported separately - a duplicate is an EXPECTED
                   absence and must not read as data loss).
  field_mismatches same root on both sides, different display name or
                   description. Nothing is missing; something is stale.

NOTHING IS EVER DROPPED FROM THE REPORT. A project present on exactly one
side appears in exactly one of these lists. There is no path through this
module where a project known to either side fails to appear in the
output.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


def normalize_root(raw_path: str) -> str:
    """Normalise a config path the same way ``projects.root`` stores it.

    Description: ``expanduser()`` only, deliberately matching
      ``project_store.normalize_root`` character for character. A diff
      that normalised differently from the table would manufacture
      disagreements that do not exist - the most expensive kind of false
      alarm, because it is indistinguishable from a real one. Symlinks
      are not collapsed and relative segments are not rewritten, for the
      reason project_store's docstring gives: a user's own path string is
      not ours to change.
    Inputs: raw_path (str) - a config.json project's ``path``.
    Output: str - the comparable root.
    Example: normalize_root("~/dev/app") -> "/Users/j/dev/app"
    """
    return str(Path(raw_path).expanduser())


@dataclass(frozen=True)
class ProjectDiff:
    """Every way the database and the rollback file currently disagree.

    Description: ``agree`` is computed from the other fields rather than
      set independently, so there is no way to construct an instance that
      claims agreement while carrying differences.
      ``duplicate_config_roots`` is reported alongside, not folded into,
      ``only_in_config``: a duplicate-root entry has no row BY DESIGN and
      calling that a discrepancy would train the reader to ignore the
      report.
    Inputs (constructor): only_in_db (list[dict] - ``{"root",
      "display_name", "raw_path"}``), only_in_config (list[dict] -
      ``{"root", "name", "path"}``), field_mismatches (list[dict] -
      ``{"root", "field", "db", "config"}``), duplicate_config_roots
      (list[dict] - ``{"root", "names"}`` for each root more than one
      config entry claims).
    Output: a ProjectDiff instance.
    """

    only_in_db: List[Dict[str, Any]] = field(default_factory=list)
    only_in_config: List[Dict[str, Any]] = field(default_factory=list)
    field_mismatches: List[Dict[str, Any]] = field(default_factory=list)
    duplicate_config_roots: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def agree(self) -> bool:
        """Whether the two sources describe exactly the same project set.

        Description: duplicate config roots do NOT break agreement. The
          snapshot writer is specified to collapse them, so a config with
          duplicates that otherwise matches the table is the expected
          steady state immediately after an import, not a fault.
        Inputs: none.
        Output: bool.
        """
        return not (
            self.only_in_db or self.only_in_config or self.field_mismatches
        )

    @property
    def difference_count(self) -> int:
        """Total number of individual discrepancies found.

        Inputs: none.
        Output: int - excludes duplicate_config_roots, matching ``agree``.
        """
        return (
            len(self.only_in_db)
            + len(self.only_in_config)
            + len(self.field_mismatches)
        )

    def to_dict(self) -> Dict[str, Any]:
        """Render the diff for the API surface.

        Description: always includes ``authoritative``, spelled out in
          the payload rather than left for the client to remember. When
          the two disagree the answer to "which one is being served" must
          travel with the disagreement, not somewhere else in the docs.
        Inputs: none.
        Output: dict.
        """
        return {
            "agree": self.agree,
            "authoritative": "db",
            "difference_count": self.difference_count,
            "only_in_db": list(self.only_in_db),
            "only_in_config": list(self.only_in_config),
            "field_mismatches": list(self.field_mismatches),
            "duplicate_config_roots": list(self.duplicate_config_roots),
        }


def _config_index(
    config_projects: Iterable[Any],
) -> tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    """Index config entries by normalised root, recording duplicate roots.

    Description: keeps the FIRST entry for a root, matching
      ``project_store.import_from_config``'s rule, so the diff's idea of
      "the config entry for this root" is the same one the import kept.
    Inputs: config_projects (Iterable) - objects with ``name``, ``path``
      and ``description`` attributes (ProjectConfig or any structural
      match).
    Output: tuple of (dict keyed by root -> ``{"name", "path",
      "description"}``, list of ``{"root", "names"}`` for duplicated
      roots).
    """
    index: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    duplicates: Dict[str, List[str]] = {}

    for cfg in config_projects:
        root = normalize_root(cfg.path)
        entry = {
            "name": cfg.name,
            "path": cfg.path,
            "description": getattr(cfg, "description", None),
        }
        if root in index:
            duplicates.setdefault(root, [index[root]["name"]]).append(cfg.name)
            continue
        index[root] = entry
        order.append(root)

    dup_list = [{"root": root, "names": names} for root, names in duplicates.items()]
    return index, dup_list


def diff_projects(
    db_rows: Iterable[Dict[str, Any]], config_projects: Iterable[Any]
) -> ProjectDiff:
    """Compare authoritative rows against the rollback file's entries.

    Description: joins on normalised root, which is the only identifier
      both sides share - display names are mutable on both sides and are
      therefore compared as a FIELD, never used as the join key. Compares
      ``display_name`` and ``description``; deliberately does not compare
      ``raw_path``, because two spellings of the same root (``~/dev/app``
      and ``/Users/j/dev/app``) are the same project and flagging them
      would be noise.
    Inputs: db_rows (Iterable[dict]) - ``projects`` table rows.
      config_projects (Iterable) - ProjectConfig-like objects.
    Output: ProjectDiff.
    Example: diff_projects(rows, cfg.projects).agree -> True
    """
    config_index, duplicates = _config_index(config_projects)
    seen_roots: set[str] = set()

    only_in_db: List[Dict[str, Any]] = []
    mismatches: List[Dict[str, Any]] = []

    for row in db_rows:
        root = row["root"]
        seen_roots.add(root)
        cfg_entry = config_index.get(root)
        if cfg_entry is None:
            only_in_db.append(
                {
                    "root": root,
                    "display_name": row["display_name"],
                    "raw_path": row["raw_path"],
                }
            )
            continue
        if row["display_name"] != cfg_entry["name"]:
            mismatches.append(
                {
                    "root": root,
                    "field": "name",
                    "db": row["display_name"],
                    "config": cfg_entry["name"],
                }
            )
        if _normalize_description(row.get("description")) != _normalize_description(
            cfg_entry["description"]
        ):
            mismatches.append(
                {
                    "root": root,
                    "field": "description",
                    "db": row.get("description"),
                    "config": cfg_entry["description"],
                }
            )

    only_in_config = [
        {"root": root, "name": entry["name"], "path": entry["path"]}
        for root, entry in config_index.items()
        if root not in seen_roots
    ]

    return ProjectDiff(
        only_in_db=only_in_db,
        only_in_config=only_in_config,
        field_mismatches=mismatches,
        duplicate_config_roots=duplicates,
    )


def _normalize_description(value: Optional[str]) -> Optional[str]:
    """Treat an absent description and an empty one as the same value.

    Description: config.json omits ``description`` for some entries and
      stores ``""`` for others; the table stores NULL for both. Without
      this, every such project would report a permanent description
      mismatch that no user action could clear - a check that never
      clears is furniture, not a monitor.
    Inputs: value (str | None).
    Output: str | None - None for both None and the empty string.
    """
    return value or None
