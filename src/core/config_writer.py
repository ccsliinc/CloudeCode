"""The one serialization boundary every writer of config.json goes through.

WHY THIS EXISTS, AND WHY ATOMIC WAS NOT ENOUGH. Five separate functions
used to open config.json, parse it, mutate their own block, back the old
bytes up and swap a temp file into place. Every one of them was ATOMIC -
a crash mid-write could never leave a truncated config - and that is a
different property from SERIALIZED. Two of them arriving together each
read the same base, each merged its own block into that base, and the
second replace threw the first writer's block away. The file was never
corrupt and the update was still lost.

They also all used the SAME temp filename, ``config.json.tmp``. Under a
lock that is invisible; with any second process writing the same file it
is two writers streaming into one fd and one of them winning a partial
document. A unique temp name costs nothing and removes the question.

THE FRESH READ INSIDE THE LOCK IS THE FIX. A caller that reads config
before acquiring is merging into a stale base by the time it writes, so
the read is performed HERE, after the lock is held, and the caller is
handed that dict. A caller therefore cannot supply a stale base even by
accident: it never supplies a base at all.

The write sequence itself is unchanged from
``Settings.update_settings_config()`` and is not open to tidying: the
``.bak`` of the PRE-WRITE bytes is written FIRST, then a temp file in
the same directory, ``flush``, ``fsync``, ``os.replace``. A half-written
config.json costs the user their whole setup.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import structlog

logger = structlog.get_logger()

# The four things a commit attempt can end as. Every one of them is a
# named outcome the caller can branch on; none of them is a silent
# overwrite and none is a silent refusal.
COMMITTED = "committed"
"""The new document is on disk and the backup holds the previous bytes."""

UNCHANGED = "unchanged"
"""The mutator reported nothing to do. NEITHER config.json NOR the
backup was touched, which is the behaviour ``migrate_config_file`` has
always had for an already-current config and which callers rely on."""

STALE_REVISION = "stale_revision"
"""A precondition evaluated against the FRESH in-lock read refused the
write. Nothing was written. The caller gets the current document back so
it can tell the client what it is racing against."""

BACKUP_UNAVAILABLE = "backup_unavailable"
"""``backup_required=True`` and the pre-write bytes could not be saved,
so the write was abandoned rather than performed without a rollback
path. Only the config migration asks for this posture."""

# One lock per resolved config path. Keyed on the resolved string so two
# spellings of one file (a symlink, a relative path) cannot each get
# their own lock and serialize against nobody - the same
# canonicalise-before-comparing rule ``project_directory`` uses.
_locks: Dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()

# Re-entrancy is a defect, not a convenience. A mutator that called
# ``commit`` again would be handed a read of the document as it stands on
# DISK, which is the pre-mutation state, and would then merge into it -
# reintroducing the exact lost update this module exists to remove. The
# lock is re-entrant so this raises rather than deadlocking, because a
# hang tells the next reader nothing about what went wrong.
_depth = threading.local()

# Anything that wants to know when config.json changed. Registered by
# ``ui_preferences_store`` so its in-memory projection is refreshed from
# the document that was just committed - for free, with no disk read -
# no matter WHICH of the five writers made the change. Without this, a
# projection cached by one path would go stale the moment another path
# rewrote the file, and the staleness would be invisible.
_listeners: list = []


@dataclass(frozen=True)
class CommitOutcome:
    """What one commit attempt did, and the document as it now stands.

    Attributes:
      status (str): one of ``COMMITTED`` / ``UNCHANGED`` /
        ``STALE_REVISION`` / ``BACKUP_UNAVAILABLE``.
      data (dict): the config document. For ``COMMITTED`` this is what
        was written; for every other status it is the unmodified
        document read inside the lock, so a caller reporting a conflict
        is quoting what is really on disk rather than what it guessed.
      wrote (bool): True only for ``COMMITTED``. Present so a caller
        never has to compare status strings to answer "did the file
        change".
    """

    status: str
    data: Dict[str, Any]
    wrote: bool


def _lock_for(path: Path) -> threading.RLock:
    """Return the process-wide lock guarding one config path.

    Inputs: path (Path) - already resolved by the caller.
    Output: threading.RLock - the same object for every call with the
      same resolved path.
    """
    key = str(path)
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _locks[key] = lock
        return lock


def read_config(config_path: Path) -> Dict[str, Any]:
    """Read and parse config.json without taking the write lock.

    Description: the read every caller that only wants to LOOK should
      use. Reads are not serialized against each other and do not need
      to be: ``os.replace`` is atomic, so a reader either sees the whole
      old document or the whole new one, never a mixture.
    Inputs: config_path (Path) - path to config.json.
    Output: dict - the parsed document.
    Raises:
      FileNotFoundError: config_path does not exist.
      ValueError: the file is not valid JSON.
    """
    resolved = Path(config_path).expanduser()
    if not resolved.exists():
        raise FileNotFoundError(f"Auth config file not found: {resolved}")
    try:
        with open(resolved) as handle:
            return json.load(handle)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {resolved}: {exc}")


def commit(
    config_path: Path,
    mutate: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]],
    *,
    backup_required: bool = False,
    precondition: Optional[Callable[[Dict[str, Any]], Optional[str]]] = None,
) -> CommitOutcome:
    """Serialize one read-check-merge-backup-replace against config.json.

    Description: takes the path's lock, reads the file FRESH inside it,
      runs ``precondition`` against that fresh document, hands it to
      ``mutate``, and - only if the mutator returns a document - backs
      the pre-write bytes up to ``config.json.bak`` and replaces the file
      atomically through a UNIQUELY NAMED temp file in the same
      directory. Everything after the lock is acquired happens before it
      is released, which is what makes two concurrent writers of
      different blocks both survive.
    Inputs:
      config_path (Path) - path to config.json.
      mutate (callable) - takes the freshly-read document and returns the
        new one, or ``None`` to mean "nothing to do" (nothing is written
        and no backup is taken). It MUST NOT call ``commit`` again, and
        it may raise ``ValueError`` to abort the write, which propagates
        to the caller with the file untouched.
      backup_required (bool) - when True a backup that cannot be written
        abandons the commit (``BACKUP_UNAVAILABLE``) rather than
        proceeding without a rollback path. Default False keeps the
        best-effort posture the settings and wrapper writers have always
        had: a backup failure is logged and the user's actual save still
        lands.
      precondition (callable|None) - takes the freshly-read document and
        returns None to proceed or a status string (``STALE_REVISION``)
        to refuse. Evaluated INSIDE the lock against the real current
        bytes, which is the only place a revision check means anything.
    Output: CommitOutcome.
    Raises:
      FileNotFoundError: config_path does not exist.
      ValueError: the file is not valid JSON, or ``mutate`` rejected the
        merge.
      RuntimeError: ``commit`` was called from inside a ``mutate``.

    Example:
        outcome = commit(path, lambda data: {**data, "agents": merged})
        if outcome.wrote:
            ...
    """
    resolved = Path(config_path).expanduser()

    if getattr(_depth, "value", 0):
        raise RuntimeError(
            "config_writer.commit() was called from inside a mutator. The "
            "mutator is already holding the freshly-read document; a nested "
            "commit would re-read the pre-mutation state and lose the outer "
            "write."
        )

    with _lock_for(resolved):
        _depth.value = getattr(_depth, "value", 0) + 1
        try:
            if not resolved.exists():
                raise FileNotFoundError(
                    f"Auth config file not found: {resolved}\n"
                    f"Run ./setup_auth.py to create it."
                )
            with open(resolved) as handle:
                raw = handle.read()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON in auth config file: {exc}\nCheck {resolved}")

            if precondition is not None:
                refusal = precondition(data)
                if refusal is not None:
                    return CommitOutcome(status=refusal, data=data, wrote=False)

            new_data = mutate(data)
            if new_data is None:
                return CommitOutcome(status=UNCHANGED, data=data, wrote=False)

            backup_path = resolved.with_suffix(resolved.suffix + ".bak")
            try:
                backup_path.write_text(raw)
            except OSError as exc:
                logger.warning(
                    "config_write_backup_failed",
                    path=str(resolved),
                    error=str(exc),
                    required=backup_required,
                )
                if backup_required:
                    return CommitOutcome(
                        status=BACKUP_UNAVAILABLE, data=data, wrote=False
                    )

            _replace_atomically(resolved, new_data)
            _notify(resolved, new_data)
            return CommitOutcome(status=COMMITTED, data=new_data, wrote=True)
        finally:
            _depth.value -= 1


def _replace_atomically(path: Path, data: Dict[str, Any]) -> None:
    """Write ``data`` over ``path`` through a unique temp file and fsync.

    Description: the unchanged tail of the pattern from
      ``Settings.update_settings_config()``. The temp file carries the
      writing process's pid and a random suffix so two writers - in this
      process or in another one - can never stream into the same fd, and
      it lives in the SAME directory as the target so ``os.replace`` is
      a rename within one filesystem and therefore atomic. A failure
      anywhere removes the temp file rather than leaving litter beside
      the config the next reader has to guess about.
    Inputs: path (Path) - the config file; data (dict) - the document.
    Output: None.
    Raises: OSError from the write, after the temp file is cleaned up.
    """
    tmp_path = path.with_suffix(
        f"{path.suffix}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    )
    try:
        with open(tmp_path, "w") as handle:
            json.dump(data, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except OSError:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass
        raise


def on_commit(listener: Callable[[Path, Dict[str, Any]], None]) -> None:
    """Register a callback invoked after every successful commit.

    Description: the callback receives the resolved config path and the
      document that was just written, so a cached projection can be
      refreshed without going back to disk. Called while the write lock
      is still held, so a listener sees commits in the order they landed
      and can never observe two of them interleaved.
    Inputs: listener (callable) - takes (Path, dict), returns None. It
      must be cheap and must not write config.json.
    Output: None.
    """
    _listeners.append(listener)


def _notify(path: Path, data: Dict[str, Any]) -> None:
    """Run every commit listener, and never let one fail the write.

    Description: the bytes are already on disk by the time this runs, so
      raising here would report a failure for a save that succeeded and
      would leave the caller unable to tell which happened. The error is
      therefore logged with the listener named and swallowed
      DELIBERATELY - the write is the contract, the notification is a
      cache refresh, and the worst case of a failed one is a projection
      that re-reads from disk next time.
    Inputs: path (Path); data (dict) - the committed document.
    Output: None.
    """
    for listener in list(_listeners):
        try:
            listener(path, data)
        except Exception as exc:  # noqa: BLE001 - see docstring
            logger.warning(
                "config_commit_listener_failed",
                listener=getattr(listener, "__qualname__", repr(listener)),
                error=str(exc),
            )
