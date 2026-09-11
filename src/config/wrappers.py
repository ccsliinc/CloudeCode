"""The launch-wrapper list in ``config.json``, and the writes around it.

Carved out of the flat ``src/config.py`` by slice S5 of
``.claude/notes/backend-decomposition-plan.md``.

**THE LIST RULES ARE NOT HERE AND MUST NOT MOVE HERE.** Family-scoped
defaults, reserved ids and sibling promotion live in
:mod:`src.core.wrapper_store` as pure functions over a list. This module
supplies only the persistence around them: read, apply, re-validate,
write. Keeping the two apart is what lets the rules be tested without a
file on disk.

**THE MERGED BLOCK IS RE-VALIDATED BEFORE IT REACHES DISK.** The mutation
returns a list; ``AgentsConfig(**agents_data)`` is run over the whole
merged block afterwards, so a mutation that produced something the model
refuses fails BEFORE the write rather than after it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, List

from src.config.agents import AgentsConfig
from src.config.config_file import read_config, read_config_text, write_config_atomic

#: The structlog event a failed pre-write backup is reported under.
BACKUP_FAILED_EVENT = "wrapper_write_backup_failed"


def write_wrappers(config_path: Path, agents_data: dict) -> None:
    """Persist an updated ``agents`` block back to config.json.

    Description: backs up the pre-write bytes and writes atomically, the
      same one-generation convention every writer in this package uses.
    Inputs: config_path (Path); agents_data (dict) - the full new
      ``agents`` block, already re-validated by the caller.
    Output: None.
    Raises:
        FileNotFoundError: config.json does not exist.
        ValueError: config.json is not valid JSON.
    Example: write_wrappers(path, {"wrappers": []})
    """
    raw, data = read_config_text(config_path)
    data["agents"] = agents_data
    write_config_atomic(
        config_path, data, previous=raw, event=BACKUP_FAILED_EVENT
    )


def mutate(
    config_path: Path, mutation: Callable[[List[dict]], List[dict]]
) -> List[dict]:
    """Read config.json, apply a pure wrapper-list mutation, write back.

    Description: the one read-validate-write path shared by all four
      wrapper mutators.
    Inputs: config_path (Path); mutation (Callable[[list[dict]],
      list[dict]]) - takes the current wrapper list, returns the new one.
    Output: list[dict] - the updated wrapper list.
    Raises:
        FileNotFoundError: config.json does not exist.
        ValueError: from the mutation, or invalid JSON in config.json.
    Example: mutate(path, lambda ws: wrapper_store.delete(ws, "cld"))
    """
    data = read_config(config_path)
    agents_data = dict(data.get("agents") or {})
    agents_data["wrappers"] = mutation(list(agents_data.get("wrappers") or []))

    AgentsConfig(**agents_data)  # re-validate merged block before disk
    write_wrappers(config_path, agents_data)
    return agents_data["wrappers"]
