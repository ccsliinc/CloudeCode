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

**AND THE MUTATION RUNS INSIDE THE WRITE LOCK, SINCE 1.4.0.** It used to
read the wrapper list, derive the new one, and write in a second step, so
two wrapper edits arriving together each derived from the same list and
the second silently dropped the first one's wrapper - atomically, with
the file never once corrupt. :func:`src.core.config_writer.commit` reads
FRESH inside the lock and hands that document to the mutator, which is
what makes the two survive. The separate ``write_wrappers`` seam is gone
with it: a caller holding a block it assembled outside the lock is the
stale base this boundary exists to make unrepresentable.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, List

from src.config.agents import AgentsConfig
from src.core import config_writer


def mutate(
    config_path: Path, mutation: Callable[[List[dict]], List[dict]]
) -> List[dict]:
    """Apply a pure wrapper-list mutation to config.json, under the lock.

    Description: the one read-validate-write path shared by all four
      wrapper mutators. The mutation runs inside
      :func:`src.core.config_writer.commit`, against the document read
      after the lock was taken, so a concurrent settings PATCH or config
      migration cannot have its block dropped by this write and this
      write cannot lose its own wrapper to theirs.
    Inputs: config_path (Path); mutation (Callable[[list[dict]],
      list[dict]]) - takes the current wrapper list, returns the new one.
    Output: list[dict] - the updated wrapper list, as it was written.
    Raises:
        FileNotFoundError: config.json does not exist.
        ValueError: from the mutation, from ``AgentsConfig`` refusing the
          merged block, or from invalid JSON in config.json.
    Example: mutate(path, lambda ws: wrapper_store.delete(ws, "cld"))
    """
    # Filled by the mutator, which is the only thing that sees the list
    # the write actually committed. Returning what the CALLER derived
    # would be reporting a value the lock was never held for.
    written: List[dict] = []

    def merge(data: dict) -> dict:
        """Replace the wrapper list in the freshly-read document.

        Inputs: data (dict) - the in-lock read.
        Output: dict - the document to write.
        Raises:
            ValueError: ``AgentsConfig`` refused the merged block.
        """
        data = dict(data)
        agents_data = dict(data.get("agents") or {})
        agents_data["wrappers"] = mutation(list(agents_data.get("wrappers") or []))
        AgentsConfig(**agents_data)  # re-validate merged block before disk
        data["agents"] = agents_data
        written.clear()
        written.extend(agents_data["wrappers"])
        return data

    config_writer.commit(config_path, merge)
    return written
