"""Read the import's state, and commit one import, through the one writer.

WHY THIS IS NOT ``UiPreferencesStore.update``. That method writes the
preference block and nothing else. An import has to write the block AND
the completion marker IN ONE COMMIT, because the two failure halves are
both bad and both silent: a commit that wrote the settings but not the
marker leaves the install offering the import again to the next stale
browser, and one that wrote the marker but not the settings closes the
offer having changed nothing the user asked for. ``config_writer.commit``
takes one mutator, so one mutator produces both.

IT IS STILL THE SAME WRITER. This adds no sixth independent writer of
config.json - it goes through ``config_writer.commit`` exactly as the
preference store does, takes the same path lock, gets the same atomic
replace and the same backup, and refreshes the preference projection for
free through the commit listener that store already registered.

EVERY REFUSAL IS CHECKED INSIDE THE LOCK, against the document the write
is actually going to merge into. Checking "has this install already been
imported" outside it would be the lost update wearing a check: two
browsers pressing import at the same moment would both read "no" and
both write.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

import structlog

from src.core import config_writer, settings_import, ui_preferences

logger = structlog.get_logger()


class ImportResult:
    """What one import attempt did, and what the plan said it would do.

    Attributes:
      status (str): ``COMMITTED`` / ``UNCHANGED`` / ``ALREADY_IMPORTED``
        / ``STALE_REVISION``.
      plans (list[FieldPlan]): the plan this ran, so the response can
        show the user the same list the preview showed them.
      revision (int): the CURRENT preference revision, whatever the
        status.
      values (dict): the block's values as they now stand.
      changed (dict): the fields this call actually moved, empty for any
        status but ``COMMITTED``.
      completed_at (str|None): the marker's timestamp, present once the
        install has been imported at all.
    """

    __slots__ = ("status", "plans", "revision", "values", "changed", "completed_at")

    def __init__(
        self,
        status: str,
        plans: Sequence[settings_import.FieldPlan],
        revision: int,
        values: Dict[str, Any],
        changed: Optional[Dict[str, Any]] = None,
        completed_at: Optional[str] = None,
    ) -> None:
        self.status = status
        self.plans = list(plans)
        self.revision = revision
        self.values = values
        self.changed = changed or {}
        self.completed_at = completed_at

    def as_payload(self) -> Dict[str, Any]:
        """The response body shape shared by the preview and the commit.

        Inputs: none.
        Output: dict.
        """
        return {
            "status": self.status,
            "schema_version": ui_preferences.SCHEMA_VERSION,
            "revision": self.revision,
            "values": self.values,
            "completed_at": self.completed_at,
            "summary": settings_import.summarise(self.plans),
            "fields": [plan.as_payload() for plan in self.plans],
            "changed": self.changed,
        }


class SettingsImportStore:
    """State and the one commit for the one-time settings import.

    Inputs to the constructor:
      config_path_provider (callable) - returns the current config.json
        Path, for the same reason ``UiPreferencesStore`` takes one.
    """

    def __init__(self, config_path_provider: Callable[[], Path]) -> None:
        self._path_provider = config_path_provider

    def _path(self) -> Path:
        return Path(self._path_provider()).expanduser()

    def _read_config(self) -> Dict[str, Any]:
        """The whole config document, or an empty one it can answer from.

        Description: a missing or hand-mangled config reads as an empty
          document rather than raising, so the import control can still
          render and say what it found. The COMMIT does not share that
          tolerance - it goes through ``config_writer.commit``, which
          raises on a file it cannot read, because writing settings into
          a document nobody could parse is how a config gets replaced
          wholesale.
        Inputs: none.
        Output: dict.
        """
        try:
            return config_writer.read_config(self._path())
        except (FileNotFoundError, ValueError) as exc:
            logger.warning(
                "settings_import_config_unreadable", path=str(self._path()), error=str(exc)
            )
            return {}

    def state(self) -> Dict[str, Any]:
        """Whether this install has been imported, and what it holds.

        Description: what the control reads before it offers anything.
          ``completed`` true means the offer is over for every browser,
          which is the defence against a three-month-old machine
          connecting and reseeding shared settings from its stale
          snapshot.
        Inputs: none.
        Output: dict - ``{"completed", "completed_at", "revision",
          "values", "importable", "refused"}``.
        """
        config = self._read_config()
        marker = settings_import.read_marker(config)
        block = ui_preferences.read_block(config)
        return {
            "completed": marker is not None,
            "completed_at": marker.get("completed_at") if marker else None,
            "imported_fields": marker.get("fields", []) if marker else [],
            "schema_version": ui_preferences.SCHEMA_VERSION,
            "revision": block["revision"],
            "values": block["values"],
            "importable": sorted(settings_import.importable_fields()),
            "refused": sorted(settings_import.REFUSED_FIELDS),
        }

    def preview(
        self, candidates: Dict[str, Any], selections: Optional[Sequence[str]] = None
    ) -> ImportResult:
        """Plan an import without writing anything.

        Description: reads the block, builds the plan, and returns it.
          The status is what a COMMIT of this plan would answer right
          now, so the button can be labelled from the preview rather
          than from a second guess - including ``ALREADY_IMPORTED``,
          which is a preview that is honest about being unable to
          proceed.
        Inputs:
          candidates (dict) - the values this browser is offering.
          selections (sequence[str]|None) - fields the user chose to
            overwrite the server with.
        Output: ImportResult. Nothing is written on any path.

        Example:
            result = store.preview({"theme": "matrix"})
        """
        config = self._read_config()
        block = ui_preferences.read_block(config)
        marker = settings_import.read_marker(config)
        plans = settings_import.build_plan(candidates, block["values"], selections)

        if marker is not None:
            status = settings_import.ALREADY_IMPORTED
        elif settings_import.changes_from(plans):
            status = settings_import.COMMITTED
        else:
            status = settings_import.UNCHANGED

        return ImportResult(
            status=status,
            plans=plans,
            revision=block["revision"],
            values=block["values"],
            completed_at=marker.get("completed_at") if marker else None,
        )

    def commit(
        self,
        candidates: Dict[str, Any],
        selections: Optional[Sequence[str]] = None,
        expected_revision: Optional[int] = None,
    ) -> ImportResult:
        """Perform the import, values and marker in one write.

        Description: THE PLAN IS REBUILT INSIDE THE LOCK, against the
          document this write is going to merge into, so the changes
          that land are computed from what is really on disk rather than
          from what the preview saw. That is also what makes the
          preview honest: the same function produced both, and if the
          server moved underneath, the revision check refuses instead of
          writing a plan that no longer applies.
        Inputs:
          candidates (dict) - the values this browser is offering.
          selections (sequence[str]|None) - fields the user chose to
            overwrite the server with.
          expected_revision (int|None) - the preference revision the
            caller believes is current. ``None`` declines the check.
        Output: ImportResult.
        Raises: FileNotFoundError - config.json is missing. ValueError -
          it is not valid JSON. Both are genuine server faults rather
          than outcomes a user can act on.

        Example:
            result = store.commit({"theme": "matrix"}, ["theme"], 4)
        """
        captured: Dict[str, Any] = {"plans": [], "changes": {}, "already": False}

        def precondition(config: Dict[str, Any]) -> Optional[str]:
            if expected_revision is None:
                return None
            if ui_preferences.revision_of(config) == expected_revision:
                return None
            return config_writer.STALE_REVISION

        def mutate(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            if settings_import.is_completed(config):
                captured["already"] = True
                return None
            block = ui_preferences.read_block(config)
            plans = settings_import.build_plan(candidates, block["values"], selections)
            changes = settings_import.changes_from(plans)
            captured["plans"] = plans
            captured["changes"] = changes
            new_config, _block, _moved = settings_import.apply_import(config, changes)
            return new_config

        outcome = config_writer.commit(self._path(), mutate, precondition=precondition)
        config = outcome.data
        block = ui_preferences.read_block(config)
        marker = settings_import.read_marker(config)
        completed_at = marker.get("completed_at") if marker else None
        plans: List[settings_import.FieldPlan] = captured["plans"]

        if outcome.status == config_writer.STALE_REVISION:
            logger.info(
                "settings_import_stale_revision",
                expected=expected_revision,
                current=block["revision"],
            )
            return ImportResult(
                status=settings_import.STALE_REVISION,
                plans=settings_import.build_plan(
                    candidates, block["values"], selections
                ),
                revision=block["revision"],
                values=block["values"],
                completed_at=completed_at,
            )

        if captured["already"]:
            logger.info("settings_import_already_completed", completed_at=completed_at)
            return ImportResult(
                status=settings_import.ALREADY_IMPORTED,
                plans=settings_import.build_plan(
                    candidates, block["values"], selections
                ),
                revision=block["revision"],
                values=block["values"],
                completed_at=completed_at,
            )

        changed = dict(captured["changes"])
        logger.info(
            "settings_import_committed",
            revision=block["revision"],
            fields=sorted(changed.keys()),
            offered=len(plans),
        )
        return ImportResult(
            status=settings_import.COMMITTED,
            plans=plans,
            revision=block["revision"],
            values=block["values"],
            changed=changed,
            completed_at=completed_at,
        )
