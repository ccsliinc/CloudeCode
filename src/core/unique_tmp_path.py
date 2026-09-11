"""One shared name generator for a durable writer's temp sibling file.

WHY THIS EXISTS: ATOMIC AND SERIALIZED ARE DIFFERENT PROPERTIES, and a
fixed ``<name>.tmp`` only ever had the first. ``os.replace`` guarantees a
reader sees whole old bytes or whole new bytes; it guarantees nothing
about two writers streaming into ONE shared temp file before either of
them renames it. Under a lock that is invisible - it only shows up the
moment a second writer (a second request, a second process) reaches the
same file while the first is still mid-write, and the failure is silent:
neither writer errors, one of them just loses its update or hands the
next reader a torn document.

Five call sites in this codebase compose a temp sibling this way -
``unread_store.py``, three writers in ``session_manager.py``
(``_write_metadata_atomic``, ``_save_pinned_themes``,
``set_project_theme``) and ``config_files_io.atomic_write`` - and every
one of them used to write ``path.with_suffix(path.suffix + ".tmp")``,
five copies of the same one-line defect. This module is the single
place that composes the name now, so a sixth writer imports it instead
of adding a sixth copy.

``config_writer.py``'s own ``_replace_atomically`` is NOT rewired to
this module. It is the one serialization boundary for config.json
specifically (a process-wide lock plus a fresh in-lock read), already
carries the identical pid-plus-random-suffix rule, and predates this
module - folding it in would touch the one file in this codebase that
is deliberately the sole writer of a shared document, for zero change
in behaviour. This module is for the writers that never got that
boundary and do not need one: each writes its own private file, so a
unique name is the whole fix.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path


def unique_tmp_path(path: Path) -> Path:
    """A temp sibling of ``path`` that no concurrent writer can also pick.

    Description: the temp file carries the calling process's pid and a
      random 8-hex-character suffix, so two writers - in this process or
      in another one - can never stream into the same fd. It lives in
      the SAME directory as ``path`` so the caller's rename into place
      stays within one filesystem and therefore atomic.

      The name is also why a caller must clean up after a failed write:
      a fixed name self-limits to one orphan on disk; a unique one left
      behind on every failure would litter the state directory with a
      fresh corpse each time.
    Inputs: path (Path) - the destination file, not required to exist yet.
    Output: Path - a sibling of ``path`` in the same directory.
    Example:
        >>> unique_tmp_path(Path("/s/state.json")).name
        'state.json.4321.9f0a1b2c.tmp'   # pid and suffix vary
    """
    return path.with_suffix(
        f"{path.suffix}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    )
