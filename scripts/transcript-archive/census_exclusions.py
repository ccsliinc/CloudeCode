#!/usr/bin/env python3
"""Populations this archive deliberately does NOT hold, recorded as decisions.

WHY THIS IS A MODULE AND NOT A COMMENT. There are 195 OpenAI Codex CLI
conversations under ``~/.codex/sessions``. The owner's ruling, verbatim: "codex
is not in scope now. it may be in the future." Left unrecorded, that reads as an
oversight the next time anyone counts, and turning it on later becomes an
archaeology project. Recorded as a string glued onto a source NAME - which is
how it was carried before, as ``"openai codex CLI sessions (OUT OF SCOPE)"`` in
the census builder's ``MEASURED_ONCE`` tuple - it is worse than unrecorded,
because nothing can query it, the checker cannot report it as an exclusion, and
the fact lives in a label rather than in a field.

SO AN EXCLUSION IS DATA, WITH FOUR THINGS IN IT. The decision verbatim so nobody
has to reconstruct what was agreed, a ``in_scope`` boolean a reader can flip, a
COUNT, and the moment that count was taken. The count is what makes it read as a
decision rather than a shrug: "195 conversations, deliberately outside" is a
position; "codex, not in scope" is a note.

THE COUNT IS RE-TAKEN EVERY RUN WHEN THE SOURCE IS READABLE, and that is the
whole reason to have a module rather than a literal. A hardcoded 195 rots the
first time the owner opens Codex again, and a stale exclusion count is the same
class of defect as a stale doc: it tells the next reader something confidently
wrong. When the source is NOT readable the previously recorded count and its
timestamp stand, flagged ``reachable: false`` - never zero, because a directory
that could not be read holds an unknown number of conversations, not none.
"""
from __future__ import annotations

import os
import time
from typing import Dict, List, Optional

#: Where the Codex CLI writes its own conversation transcripts.
CODEX_SESSIONS_ROOT = os.path.expanduser("~/.codex/sessions")

#: Codex names each conversation ``rollout-<stamp>-<uuid>.jsonl``.
CODEX_PREFIX = "rollout-"

#: The owner's ruling, quoted rather than paraphrased. A paraphrase of a scope
#: decision is how scope decisions get reopened by accident.
CODEX_DECISION = "codex is not in scope now. it may be in the future."


def count_codex_conversations(root: str = CODEX_SESSIONS_ROOT) -> Optional[int]:
    """Count Codex CLI conversations on disk.

    Inputs:
      root: the Codex sessions directory.
    Outputs:
      int | None: the number of ``rollout-*.jsonl`` files, or None when the
        directory could not be read. None means "not measured", never zero.
    Example:
      >>> count_codex_conversations("/definitely/not/here") is None
      True
    """
    if not os.path.isdir(root):
        return None
    total = 0
    try:
        for _dirpath, _dirnames, filenames in os.walk(root):
            total += sum(1 for n in filenames
                         if n.startswith(CODEX_PREFIX) and n.endswith(".jsonl"))
    except OSError:
        return None
    return total


def build_exclusions(previous: Optional[List[dict]] = None) -> List[dict]:
    """Compose the census's exclusion records, re-counting what is readable.

    Description: an exclusion whose source cannot be read keeps the count and
      timestamp it already had, so a NAS outage or a missing directory can never
      turn 195 deliberately-excluded conversations into 0.
    Inputs:
      previous: the exclusions list from the existing census, if any.
    Outputs:
      list of dict: one record per excluded population.
    Example:
      >>> build_exclusions()[0]["id"]
      'openai_codex_cli'
    """
    prior = {entry.get("id"): entry for entry in (previous or [])}
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    record: Dict = {
        "id": "openai_codex_cli",
        "name": "OpenAI Codex CLI conversations",
        "in_scope": False,
        "kind": "different tool",
        "location": CODEX_SESSIONS_ROOT,
        "owner_decision": CODEX_DECISION,
        "reason": ("this archive's scope is Claude Code transcripts. these are "
                   "conversations with a different tool, held in a different "
                   "format, under a different root. excluded on purpose, "
                   "counted so the number is never mistaken for zero."),
        "how_to_include_later": ("set in_scope true and add a reader to "
                                 "build_conversation_census.py that walks "
                                 "rollout-*.jsonl under location. the count "
                                 "below is already maintained every run."),
    }
    counted = count_codex_conversations()
    if counted is None:
        old = prior.get(record["id"], {})
        record["conversations"] = old.get("conversations")
        record["counted_at"] = old.get("counted_at")
        record["reachable"] = False
    else:
        record["conversations"] = counted
        record["counted_at"] = now
        record["reachable"] = True
    return [record]


def render_exclusions(exclusions: List[dict]) -> List[str]:
    """Format exclusions for the checker's report.

    Inputs:
      exclusions: the census's exclusion records.
    Outputs:
      list of str: lines to print, empty when there are none.
    """
    if not exclusions:
        return []
    lines = [f"\nDELIBERATELY OUT OF SCOPE ({len(exclusions)}), "
             f"not counted above and not a gap:"]
    for entry in exclusions:
        count = entry.get("conversations")
        if count is None:
            shown = "count unknown, source unreadable"
        else:
            reach = "" if entry.get("reachable", True) else ", source unreadable now"
            shown = f"{count} conversations as of {entry.get('counted_at')}{reach}"
        lines.append(f"  {entry.get('name')}: {shown}")
        lines.append(f"      owner: \"{entry.get('owner_decision')}\"")
        lines.append(f"      at: {entry.get('location')}")
    return lines
