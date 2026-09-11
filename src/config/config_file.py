"""Reading and writing ``config.json``, and the one atomic write pattern.

Carved out of the flat ``src/config.py`` by slice S5 of
``.claude/notes/backend-decomposition-plan.md``. Four methods raised the
same "run setup_auth.py" ``FileNotFoundError`` and four wrapped the same
``json.JSONDecodeError`` into the same ``ValueError``; those are one copy
each now.

**THE ATOMIC WRITE IS WHY THIS MODULE EXISTS SEPARATELY.** A half-written
``config.json`` costs the user their whole setup, so every writer here
does the same four things in the same order: back up the PRE-WRITE bytes
to ``config.json.bak``, write a temp file beside the target, ``fsync``
it, then ``os.replace``. The rename is atomic on the same filesystem, so
no crash mid-write can leave a truncated config behind. The backup is
ONE generation and is best-effort - a backup that cannot be written must
not block the write it was protecting.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

import structlog

logger = structlog.get_logger()

#: Suffix appended to ``config.json`` for the one-generation backup.
BACKUP_SUFFIX = ".bak"
#: Suffix for the temp file the atomic write renames from.
TEMP_SUFFIX = ".tmp"


def require_config_file(config_path: Path) -> None:
    """Refuse early, and by name, when ``config.json`` is not there.

    Description: one copy of a message four call sites used to spell out
      identically. It names the path AND the command that creates it,
      because the reader of this error is usually someone who has never
      run setup.
    Inputs: config_path (Path).
    Output: None.
    Raises:
        FileNotFoundError: the file does not exist.
    Example: require_config_file(Path("~/config.json").expanduser())
    """
    if not config_path.exists():
        raise FileNotFoundError(
            f"Auth config file not found: {config_path}\n"
            f"Run ./setup_auth.py to create it."
        )


def read_config(config_path: Path) -> Dict[str, Any]:
    """Read and parse ``config.json``.

    Description: a decode failure becomes a ``ValueError`` naming the
      file, because every caller of this is answering an API request and
      a raw ``JSONDecodeError`` says nothing about WHICH file is broken.
    Inputs: config_path (Path).
    Output: dict - the parsed document.
    Raises:
        FileNotFoundError: the file does not exist.
        ValueError: the file is not valid JSON.
    Example: read_config(path)["agents"]
    """
    require_config_file(config_path)
    try:
        with open(config_path) as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Invalid JSON in auth config file: {e}\n"
            f"Check {config_path}"
        )


def read_config_text(config_path: Path) -> tuple[str, Dict[str, Any]]:
    """Read ``config.json`` as BOTH its raw bytes and its parsed form.

    Description: a writer needs the raw text to back up verbatim and the
      parsed document to merge into. Re-reading the file for the second
      one would open a window in which the two disagree.
    Inputs: config_path (Path).
    Output: tuple[str, dict] - the file's text, and the parsed document.
    Raises:
        FileNotFoundError: the file does not exist.
        ValueError: the file is not valid JSON.
    Example: raw, data = read_config_text(path)
    """
    require_config_file(config_path)
    with open(config_path) as f:
        raw = f.read()
    try:
        return raw, json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Invalid JSON in auth config file: {e}\n"
            f"Check {config_path}"
        )


def write_config_atomic(
    config_path: Path, data: Dict[str, Any], *, previous: str, event: str
) -> None:
    """Replace ``config.json`` without ever leaving it half written.

    Description: backs up ``previous`` to ``config.json.bak`` first, then
      writes a temp file, ``fsync``s it, and ``os.replace``s it over the
      target. Ordering is the whole claim: the backup has to land BEFORE
      the file it is a backup of is touched, and the rename has to be the
      last thing that happens. The backup is best-effort and a failure is
      logged rather than raised, because a missing backup must not block
      the write it was protecting.
    Inputs: config_path (Path); data (dict) - the complete new document;
      previous (str) - the file's pre-write text, backed up verbatim;
      event (str) - the structlog event for a failed backup, so a reader
      can tell which writer could not make one.
    Output: None.
    Example: write_config_atomic(p, data, previous=raw, event="config_settings_backup_failed")
    """
    try:
        backup_path = config_path.with_suffix(config_path.suffix + BACKUP_SUFFIX)
        backup_path.write_text(previous)
    except OSError as e:
        logger.warning(event, error=str(e))

    tmp_path = config_path.with_suffix(config_path.suffix + TEMP_SUFFIX)
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, config_path)
