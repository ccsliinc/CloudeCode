"""Merging a partial settings update into ``config.json``.

Carved out of the flat ``src/config.py`` by slice S5 of
``.claude/notes/backend-decomposition-plan.md``. This is the write that
the whole repo's atomic-write convention was copied from, and a
half-written ``config.json`` costs the user their entire setup, so the
mechanics live in :mod:`src.config.config_file` and are shared rather
than spelled out again here.

**LEAVE-UNCHANGED IS THE SEMANTIC.** Only keys PRESENT in an update dict
are applied; an absent key is left exactly as it was. The route handler
has already filtered each dict down to what the client actually set, via
pydantic's ``model_fields_set``.

**``workspace.env`` IS THE ONE EXCEPTION AND IT IS DELIBERATE.** It is a
WHOLE MAP, so a key-wise merge would make a row impossible to DELETE -
there is no way to express "remove FOO" in a merge. The client therefore
sends the complete map or omits the key entirely.

**EVERY MERGED BLOCK IS RE-VALIDATED THROUGH ITS MODEL BEFORE THE WRITE.**
The caller already did field-level checks; this is defence in depth
against a hand-edited ``config.json`` having put the file in a state that
a perfectly valid partial update cannot fix.

**NEVER LOG A VALUE FROM ``notifications_update``.** Only the list of
changed key NAMES, and that happens at the route handler.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from src.config.agents import AgentsConfig
from src.config.config_file import read_config_text, write_config_atomic
from src.config.notifications import NotificationsConfig
from src.config.workspace import ServerPrefsConfig, WorkspaceConfig
from src.core.workspace_settings import SERVER_PREFS_KEY, WORKSPACE_KEY

#: The structlog event a failed pre-write backup is reported under.
BACKUP_FAILED_EVENT = "config_settings_backup_failed"


def _merge_block(
    data: Dict[str, Any], key: str, update: Optional[dict], model: type
) -> None:
    """Apply one partial block update in place, re-validating the result.

    Description: the one copy of the merge rule. A falsy ``update`` is a
      no-op, which is what makes "the client sent nothing for this block"
      and "leave this block alone" the same thing.
    Inputs: data (dict) - the whole document, MUTATED; key (str) - the
      top-level block name; update (dict | None) - the keys to apply;
      model (type[BaseModel]) - the block's model, used to re-validate.
    Output: None.
    Raises:
        ValueError: pydantic refused the merged block, via its own error.
    Example: _merge_block(data, "agents", {"claude_command": "cld"}, AgentsConfig)
    """
    if not update:
        return
    merged = dict(data.get(key) or {})
    merged.update(update)
    # Raises on garbage BEFORE anything touches disk.
    model(**merged)
    data[key] = merged


def update_settings_config(
    config_path: Path,
    *,
    agents_update: Optional[dict] = None,
    notifications_update: Optional[dict] = None,
    workspace_update: Optional[dict] = None,
    server_prefs_update: Optional[dict] = None,
) -> None:
    """Merge partial block updates into config.json, atomically.

    Inputs: config_path (Path) - the expanded config.json path;
      agents_update, notifications_update, workspace_update,
      server_prefs_update (dict | None) - the keys the client set, per
      block. See the module docstring for ``workspace.env``.
    Output: None. The caller recomputes the settings summary AFTER this
      returns, so what it reports is the authoritative post-write state.
    Raises:
        FileNotFoundError: config.json does not exist.
        ValueError: invalid JSON, or a merged block fails validation.
    Example: update_settings_config(path, agents_update={"claude_command": "cld"})
    """
    raw, data = read_config_text(config_path)

    _merge_block(data, "agents", agents_update, AgentsConfig)
    _merge_block(data, "notifications", notifications_update, NotificationsConfig)
    _merge_block(data, WORKSPACE_KEY, workspace_update, WorkspaceConfig)
    _merge_block(data, SERVER_PREFS_KEY, server_prefs_update, ServerPrefsConfig)

    write_config_atomic(
        config_path, data, previous=raw, event=BACKUP_FAILED_EVENT
    )
