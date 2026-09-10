"""The ``.cc.theme`` file format: where it lives, how it is read and written.

Slice S2 of the ``session_manager`` decomposition. Split out of
``theme_store`` because it holds NO STATE: three functions over one
single-line file. Keeping it stateless is what lets ``ThemeStore`` stay a
class about the mutable pin map, and it keeps both modules under the
package's 500-line rule.

``<working_dir>/.cc.theme`` is the v0.7.0+ source of truth for a
project's theme, superseding the per-tmux-name ``pinned_themes.json``
map. It is keyed by DIRECTORY, which is the whole point: two browsers on
two machines pointed at the same checkout converge on the same theme
without round-tripping a per-machine cache. The file is one line, the
theme id plus a trailing newline.

**THE WRITE RAISES AND THE PIN-MAP WRITE DOES NOT, DELIBERATELY.** This
one is reached from a user action that has a response to fail, so a write
that did not happen must not report success. ``ThemeStore.save`` is
reached from destroy and rename cleanup, where raising would break a path
the user is waiting on to do something else.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import structlog

logger = structlog.get_logger()

#: The single file name this module owns. Named once so a caller cannot
#: spell it a second way.
DOTFILE_NAME = ".cc.theme"


def project_theme_path(working_dir) -> Optional[Path]:
    """Resolve the ``.cc.theme`` path under a working directory.

    Description: tilde expansion and absolute resolution happen here so
      caller paths stay simple. Returns None rather than raising when the
      directory is empty or unresolvable, so callers can short-circuit
      without try/except gymnastics.
    Inputs: working_dir (str | Path | None).
    Output: Path | None.
    Example: project_theme_path("~/proj")  # PosixPath('/Users/x/proj/.cc.theme')
    """
    if not working_dir:
        return None
    try:
        return Path(str(working_dir)).expanduser().resolve() / DOTFILE_NAME
    except (OSError, RuntimeError):
        return None


def read_project_theme(working_dir) -> Optional[str]:
    """Read the theme id out of ``<working_dir>/.cc.theme``.

    Description: THE DOTFILE ONLY. It performs no fallback to the legacy
      per-tmux-name map, because that is keyed by a name this function is
      not given; ``ThemeStore.resolve_project_theme`` is the combined
      lookup.
    Inputs: working_dir (str | Path | None).
    Output: str | None - the theme id, None when the directory is
      unresolvable, the file is absent, unreadable, or empty.
    Example: read_project_theme(project)  # 'metal'
    """
    path = project_theme_path(working_dir)
    if path is None or not path.exists():
        return None
    try:
        content = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        logger.warning(
            "project_theme_read_failed",
            path=str(path),
            error=str(exc),
        )
        return None
    return content or None


def write_project_theme(working_dir, theme_id: Optional[str]) -> None:
    """Atomically write or clear ``<working_dir>/.cc.theme``.

    Description: an empty or None ``theme_id`` deletes the dotfile.
      Otherwise writes ``<theme_id>\\n`` at mode 0o644 through
      temp-then-``os.replace``, so a crash mid-write can never leave a
      half-written file at the canonical path.
    Inputs: working_dir (str | Path) - must exist and be a directory.
      theme_id (str | None) - the theme, None or empty to clear.
    Output: None.
    Raises: ValueError when ``working_dir`` is unresolvable,
      FileNotFoundError when it does not exist, NotADirectoryError when
      it is not a directory, OSError when the write or the unlink fails.
    Example: write_project_theme(project, "metal")
    """
    path = project_theme_path(working_dir)
    if path is None:
        raise ValueError(f"Invalid working_dir: {working_dir!r}")

    parent = path.parent
    if not parent.exists():
        raise FileNotFoundError(f"working_dir does not exist: {parent}")
    if not parent.is_dir():
        raise NotADirectoryError(f"working_dir is not a directory: {parent}")

    # Clear branch - delete the dotfile if present.
    if not theme_id:
        if path.exists():
            try:
                path.unlink()
                logger.info("project_theme_cleared", path=str(path))
            except OSError as exc:
                logger.error(
                    "project_theme_clear_failed",
                    path=str(path),
                    error=str(exc),
                )
                raise
        return

    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            f.write(f"{theme_id}\n")
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        try:
            os.chmod(str(tmp), 0o644)
        except OSError:
            # chmod failure on the tmp shouldn't abort the write - the
            # final replace will still publish the file. Log only.
            logger.debug("project_theme_chmod_failed", path=str(tmp))
        os.replace(str(tmp), str(path))
        logger.info("project_theme_set", path=str(path), theme_id=theme_id)
    except OSError:
        # Best-effort cleanup of the tmp on failure so we don't leave
        # turds in user projects.
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
