"""Reading ``config.json``, and the errors four call sites used to spell out.

Carved out of the flat ``src/config.py`` by slice S5 of
``.claude/notes/backend-decomposition-plan.md``. Four methods raised the
same "run setup_auth.py" ``FileNotFoundError`` and four wrapped the same
``json.JSONDecodeError`` into the same ``ValueError``; those are one copy
each now.

**THIS MODULE NO LONGER WRITES, AND THAT IS THE POINT OF THE 1.4.0
INTEGRATION.** It used to own ``write_config_atomic``, which was atomic
and was NOT serialized: two writers of different blocks each merged into
the base they had already read, and the second replace threw the first
one's block away. The file was never corrupt and the update was still
lost. :mod:`src.core.config_writer` is the one boundary now - it takes
the lock, reads FRESH inside it, and hands the caller that document, so a
caller cannot supply a stale base because it never supplies one.
``tests/test_one_config_writer.py`` fails the build if a second writer of
this file reappears, here included.

The read helpers stay, because reading is not the racing half.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict


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
