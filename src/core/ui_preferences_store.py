"""Read and write the ``ui_preferences`` block, and cache the read.

TWO THINGS LIVE HERE AND THEY ARE DELIBERATELY SEPARATE FROM THE RULES.
``ui_preferences.py`` is pure: it says what a preference is and what a
merge produces. This module is the seam that puts those rules on top of
``config_writer``'s lock and keeps the answer in memory.

A READ MUST NOT TOUCH THE DISK. Preferences are consulted while painting
a sidebar row and while switching sessions, so a read that opened a file
would put a filesystem call on paths that run many times a second. The
projection is loaded once and then answered from memory. It is kept
honest by ``config_writer.on_commit``: EVERY writer of config.json, not
only this one, hands the committed document straight to the cache, so a
wrapper edit or a boot migration refreshes the projection for free
rather than leaving it quietly stale. That is why the listener exists at
all - a cache invalidated only by its own writer is a cache that is
wrong whenever somebody else writes.

THE CONFLICT IS A NAMED OUTCOME. A partial update carrying an expected
revision that no longer matches is REFUSED and says so, with the current
revision and the current values attached, because the caller cannot
reconcile against a number it was not told. It is never a silent
overwrite, which would discard the other device's setting, and never a
silent refusal, which would leave the user looking at a control they
believe they changed.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import structlog

from src.core import config_writer, ui_preferences

logger = structlog.get_logger()

COMMITTED = "committed"
"""The change is on disk. ``revision`` is the new one."""

UNCHANGED = "unchanged"
"""Every field sent already held the value that was sent. Nothing was
written and the revision did NOT move, so other clients are not made to
refresh for a change that did not happen."""

STALE_REVISION = "stale_revision"
"""The caller's expected revision is not the current one, so somebody
else committed in between. Nothing was written. ``revision`` and
``values`` describe what is actually stored, which is what the caller
needs to reconcile against."""

REJECTED_INVALID = "rejected_invalid"
"""A field failed validation, or a name is reserved. Nothing was
written and ``detail`` is a plain sentence naming the field."""


class UpdateResult:
    """What one partial update did, and the block as it now reads.

    Attributes:
      status (str): ``COMMITTED`` / ``UNCHANGED`` / ``STALE_REVISION`` /
        ``REJECTED_INVALID``.
      revision (int): the CURRENT committed revision, whatever the
        status. On a refusal this is what the caller is racing against.
      values (dict): the block's values as they now stand, including
        fields this server does not recognise.
      changed (dict): the fields this call actually moved, empty for any
        status but ``COMMITTED``. This is what a ``preferences.changed``
        event carries; it is the fields that MOVED, not the fields that
        were sent, so re-sending a value nobody changed tells nobody
        anything.
      detail (str|None): why a refusal happened, safe to show a user.
    """

    __slots__ = ("status", "revision", "values", "changed", "detail")

    def __init__(
        self,
        status: str,
        revision: int,
        values: Dict[str, Any],
        changed: Optional[Dict[str, Any]] = None,
        detail: Optional[str] = None,
    ) -> None:
        self.status = status
        self.revision = revision
        self.values = values
        self.changed = changed or {}
        self.detail = detail

    def as_payload(self) -> Dict[str, Any]:
        """The response body shape shared by GET, PATCH and the event.

        Inputs: none.
        Output: dict.
        """
        body: Dict[str, Any] = {
            "status": self.status,
            "schema_version": ui_preferences.SCHEMA_VERSION,
            "revision": self.revision,
            "values": self.values,
        }
        if self.changed:
            body["changed"] = self.changed
        if self.detail:
            body["detail"] = self.detail
        return body


class UiPreferencesStore:
    """The in-memory projection of the block, and the one writer of it.

    Inputs to the constructor:
      config_path_provider (callable) - returns the current config.json
        Path. A callable rather than a Path because ``Settings`` resolves
        it from configuration that can be pointed elsewhere in tests, and
        binding the value at construction time would make the store read
        a file the rest of the app has stopped using.
    """

    def __init__(self, config_path_provider: Callable[[], Path]) -> None:
        self._path_provider = config_path_provider
        self._guard = threading.Lock()
        self._cached: Optional[Dict[str, Any]] = None
        self._cached_for: Optional[str] = None
        config_writer.on_commit(self._observe_commit)

    # ---- reads ---------------------------------------------------------

    def read(self) -> Dict[str, Any]:
        """The current block, from memory once it has been loaded once.

        Description: the first call reads config.json; every call after
          it answers from the projection, so a preference lookup on a
          render path costs nothing. A commit through ANY config writer
          refreshes the projection in place, so this never returns a
          value that has been superseded on disk by this process.
        Inputs: none.
        Output: dict - ``{"schema_version", "revision", "values"}``. An
          unreadable or absent block reads as the empty block, never as
          an error and never as an invented default.
        """
        path = self._resolved_path()
        with self._guard:
            if self._cached is not None and self._cached_for == str(path):
                return _copy_block(self._cached)

        block = self._load_from_disk(path)
        with self._guard:
            self._cached = block
            self._cached_for = str(path)
            return _copy_block(block)

    def revision(self) -> int:
        """The current committed revision.

        Inputs: none.
        Output: int - 0 when nothing has ever been committed.
        """
        return self.read()["revision"]

    def as_result(self) -> UpdateResult:
        """The block shaped like an update result, for ``GET``.

        Inputs: none.
        Output: UpdateResult with status ``UNCHANGED`` - a read moved
          nothing, and saying so with the same vocabulary keeps the GET
          and PATCH bodies one shape rather than two.
        """
        block = self.read()
        return UpdateResult(
            status=UNCHANGED, revision=block["revision"], values=block["values"]
        )

    # ---- the write -----------------------------------------------------

    def update(
        self, changes: Dict[str, Any], expected_revision: Optional[int] = None
    ) -> UpdateResult:
        """Apply one validated PARTIAL update under the write lock.

        Description: validates first, so a bad field is refused before
          any lock is taken and before any file is opened. The revision
          check then runs INSIDE ``config_writer.commit``, against the
          document that write is actually going to merge into - checking
          it out here would compare against a read that another writer
          can invalidate before the lock is acquired, which is the lost
          update wearing a check.
        Inputs:
          changes (dict) - field name to new value, ONLY what the user
            changed. A value of ``None`` unsets a field.
          expected_revision (int|None) - the revision the caller believes
            is current. ``None`` means "I have not read one", which is
            accepted for a first write and for a caller that genuinely
            has nothing to race - it is the caller declining the check,
            not the check passing.
        Output: UpdateResult.
        Raises: FileNotFoundError - config.json is missing. Every other
          failure is a named status rather than an exception, because a
          conflict is an outcome the caller has to act on and an
          exception is how it ends up being handled by nobody.

        Example:
            result = store.update({"theme": "matrix"}, expected_revision=4)
            if result.status == STALE_REVISION:
                ...  # show the user what the other device chose
        """
        try:
            validated = ui_preferences.validate_changes(changes)
        except ValueError as exc:
            block = self.read()
            return UpdateResult(
                status=REJECTED_INVALID,
                revision=block["revision"],
                values=block["values"],
                detail=str(exc),
            )

        committed: Dict[str, Any] = {}

        def precondition(config: Dict[str, Any]) -> Optional[str]:
            if expected_revision is None:
                return None
            if ui_preferences.revision_of(config) == expected_revision:
                return None
            return config_writer.STALE_REVISION

        def mutate(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            new_config, _block, moved = ui_preferences.apply_changes(config, validated)
            if not moved:
                return None
            committed.update(moved)
            return new_config

        outcome = config_writer.commit(
            self._resolved_path(), mutate, precondition=precondition
        )
        block = ui_preferences.read_block(outcome.data)

        if outcome.status == config_writer.STALE_REVISION:
            logger.info(
                "ui_preferences_stale_revision",
                expected=expected_revision,
                current=block["revision"],
                fields=sorted(validated.keys()),
            )
            return UpdateResult(
                status=STALE_REVISION,
                revision=block["revision"],
                values=block["values"],
                detail=(
                    "another device changed these preferences first; "
                    f"the current revision is {block['revision']}"
                ),
            )

        if outcome.status == config_writer.UNCHANGED:
            return UpdateResult(
                status=UNCHANGED, revision=block["revision"], values=block["values"]
            )

        logger.info(
            "ui_preferences_committed",
            revision=block["revision"],
            fields=sorted(committed.keys()),
        )
        return UpdateResult(
            status=COMMITTED,
            revision=block["revision"],
            values=block["values"],
            changed=committed,
        )

    # ---- cache plumbing -------------------------------------------------

    def _observe_commit(self, path: Path, data: Dict[str, Any]) -> None:
        """Refresh the projection from a document another writer committed.

        Inputs: path (Path) - what was written; data (dict) - the whole
          new document.
        Output: None.
        """
        if str(path) != self._cached_for and self._cached is not None:
            return
        block = ui_preferences.read_block(data)
        with self._guard:
            self._cached = block
            self._cached_for = str(path)

    def invalidate(self) -> None:
        """Drop the projection so the next read goes back to disk.

        Description: for a test, or for a caller that knows the file was
          replaced out from under the process (a restore from the
          ``.bak``, say). Ordinary writes do not need it - they refresh
          the projection through the commit listener.
        Inputs: none.
        Output: None.
        """
        with self._guard:
            self._cached = None
            self._cached_for = None

    def _resolved_path(self) -> Path:
        return Path(self._path_provider()).expanduser()

    def _load_from_disk(self, path: Path) -> Dict[str, Any]:
        """Read the block, treating an unreadable config as "nothing set".

        Description: hydration must not fail because config.json is
          missing or was hand-edited into invalid JSON - a failed read
          answers "no preferences are stored", which leaves every client
          on its own defaults. It must NEVER answer with a fabricated
          value, because a default that looks like a setting is what gets
          saved back over a real one.
        Inputs: path (Path).
        Output: dict - a block.
        """
        try:
            config = config_writer.read_config(path)
        except (FileNotFoundError, ValueError) as exc:
            logger.warning(
                "ui_preferences_read_failed", path=str(path), error=str(exc)
            )
            return ui_preferences.empty_block()
        return ui_preferences.read_block(config)


def _copy_block(block: Dict[str, Any]) -> Dict[str, Any]:
    """Hand out a copy so a caller cannot mutate the projection.

    Inputs: block (dict).
    Output: dict - a shallow copy with ``values`` copied too.
    """
    return {
        "schema_version": block["schema_version"],
        "revision": block["revision"],
        "values": dict(block["values"]),
    }
