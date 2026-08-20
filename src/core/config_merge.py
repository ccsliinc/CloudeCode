"""Upgrade-aware three-way merge for ``config.json``.

WHY THIS MODULE EXISTS

``config.json`` is authoritative for agent wrappers and slash commands. There
is no wrapper table in the datastore, so this file IS the configuration. On
upgrade the user wants two things that pull against each other: new default
wrappers and settings should arrive, and anything he has customised must
survive. Copying the new example over the top does the first and destroys the
second. Leaving his file alone does the second and silently withholds every
new default, which is why a fresh install and an upgraded one drift apart.

THE THREE CASES ARE GENUINELY DIFFERENT AND ARE NEVER COLLAPSED

A three-way merge needs three inputs, not two:

    BASE   - the defaults that shipped with the version he currently has
    MINE   - his live config.json
    THEIRS - the defaults shipping with the new version

With those, a field falls into exactly one case:

    he never touched it (MINE == BASE)      -> take THEIRS, the new default
                                               arrives
    he changed it, default did not          -> keep MINE, untouched
    he changed it AND the default changed   -> CONFLICT. Keep MINE, and SAY
                                               SO. Never auto-merge; never
                                               pick a winner behind his back.

WITHOUT A BASE, TWO OF THOSE CASES ARE INDISTINGUISHABLE

This is the part that matters most, and it is the reason this module records a
base on every apply. If no BASE was ever recorded, then a field where MINE
differs from THEIRS could equally be "he customised it" or "the default moved
underneath him". There is no evidence in the file to tell those apart.

Guessing would be the false green this codebase exists to avoid, so a missing
base produces ``CANNOT_DETERMINE`` for every differing field: his value is
kept, nothing is overwritten, and every one of them is reported for him to
look at. It is deliberately noisy exactly once, and quiet forever after,
because applying the merge writes the base for next time.

LISTS ARE MERGED ATOMICALLY, AND THAT IS DELIBERATE

``common_slash_commands`` and ``projects`` are lists. Merging lists
element-wise means guessing identity and ordering, which is precisely where a
merge starts eating customisations. So a list is treated as one value.

That alone would withhold new default commands from anyone who has edited the
list, so the report separately computes which ITEMS are new upstream and
offers them as an explicit, additive import. Adding is safe and reversible;
reordering and rewriting somebody's list is not.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

#: The field is identical everywhere. Nothing to report or do.
UNCHANGED = "unchanged"

#: He never touched it and the default moved. The new default is adopted.
UPDATED_DEFAULT = "updated_default"

#: He customised it and the default did not move. His value is kept.
KEPT_CUSTOM = "kept_custom"

#: Brand new field upstream. Adopted, because he cannot have an opinion yet.
ADDED = "added"

#: He customised it AND the default moved. His value is kept and it is
#: REPORTED. This is the case that must never be resolved silently.
CONFLICT = "conflict"

#: Present in his config and gone from the new defaults. Kept, and reported,
#: because deleting configuration on his behalf is not a merge, it is a loss.
REMOVED_UPSTREAM = "removed_upstream"

#: No base was recorded, so "he changed it" and "the default changed" cannot
#: be told apart. His value is kept and the field is reported. Never a pass.
CANNOT_DETERMINE = "cannot_determine"

#: Outcomes that require the user to look at something.
NEEDS_ATTENTION = frozenset({CONFLICT, REMOVED_UPSTREAM, CANNOT_DETERMINE})

#: Outcomes where the merged file gains something new.
APPLIED_CHANGES = frozenset({UPDATED_DEFAULT, ADDED})

#: Sentinel for "this key was not present at all", distinct from a real None.
MISSING = object()


@dataclass
class Decision:
    """One field's merge outcome.

    Attributes:
        path: Dotted path of the field, for example "agents.codex_command".
        outcome: One of the module-level outcome constants.
        mine: The user's value, or None when the key was absent.
        theirs: The new default value, or None when the key was absent.
        base: The old default value, or None when unknown or absent.
        chosen: The value written to the merged config.
        note: Human-readable explanation, always populated for anything in
            NEEDS_ATTENTION.
    """

    path: str
    outcome: str
    mine: Any = None
    theirs: Any = None
    base: Any = None
    chosen: Any = None
    note: str = ""


@dataclass
class MergeResult:
    """The merged configuration plus a full account of how it was reached.

    Attributes:
        merged: The resulting configuration mapping.
        decisions: One Decision per field examined.
        had_base: Whether a recorded base was available. False means every
            differing field is CANNOT_DETERMINE rather than classified.
        importable: Mapping of dotted list path to the items present in the
            new defaults but absent from the user's list. Never applied
            automatically.
    """

    merged: dict
    decisions: list[Decision] = field(default_factory=list)
    had_base: bool = True
    importable: dict[str, list] = field(default_factory=dict)

    def needing_attention(self) -> list[Decision]:
        """Decisions the user has to look at.

        Returns:
            Every decision whose outcome is a conflict, an upstream removal,
            or an undeterminable field.
        """
        return [d for d in self.decisions if d.outcome in NEEDS_ATTENTION]

    def changes(self) -> list[Decision]:
        """Decisions that actually alter the file.

        Returns:
            Every decision that adopts a new or updated default.
        """
        return [d for d in self.decisions if d.outcome in APPLIED_CHANGES]


def _is_comment_key(key: str) -> bool:
    """Whether a key is one of the file's ``_comment_*`` documentation keys.

    Args:
        key: Mapping key to test.

    Returns:
        True when the key carries prose rather than configuration. Those
        always track the new defaults; treating a doc string as a user
        customisation would pin stale documentation forever.
    """
    return key.startswith("_comment")


def _classify(
    path: str,
    base: Any,
    mine: Any,
    theirs: Any,
    had_base: bool,
) -> Decision:
    """Classify one leaf field into exactly one outcome.

    Args:
        path: Dotted path, used only for reporting.
        base: Old default, or MISSING.
        mine: User value, or MISSING.
        theirs: New default, or MISSING.
        had_base: Whether a base document was supplied at all.

    Returns:
        The Decision for this field, including the value to write.
    """
    mine_present = mine is not MISSING
    theirs_present = theirs is not MISSING

    if not theirs_present:
        return Decision(
            path=path,
            outcome=REMOVED_UPSTREAM,
            mine=mine,
            theirs=None,
            base=None if base is MISSING else base,
            chosen=mine,
            note=(
                "This setting is no longer in the shipped defaults. Your value "
                "was kept; nothing was deleted on your behalf."
            ),
        )

    if not mine_present:
        return Decision(
            path=path,
            outcome=ADDED,
            mine=None,
            theirs=theirs,
            base=None if base is MISSING else base,
            chosen=theirs,
            note="New setting in this version.",
        )

    if mine == theirs:
        return Decision(
            path=path,
            outcome=UNCHANGED,
            mine=mine,
            theirs=theirs,
            base=None if base is MISSING else base,
            chosen=theirs,
        )

    if not had_base or base is MISSING:
        return Decision(
            path=path,
            outcome=CANNOT_DETERMINE,
            mine=mine,
            theirs=theirs,
            base=None,
            chosen=mine,
            note=(
                "Your value differs from the new default, and no record of the "
                "previous default exists, so it cannot be determined whether "
                "you changed this or the default did. Your value was kept."
            ),
        )

    user_changed = mine != base
    default_changed = theirs != base

    if not user_changed and default_changed:
        return Decision(
            path=path,
            outcome=UPDATED_DEFAULT,
            mine=mine,
            theirs=theirs,
            base=base,
            chosen=theirs,
            note="You had the old default, so the new default was adopted.",
        )

    if user_changed and not default_changed:
        return Decision(
            path=path,
            outcome=KEPT_CUSTOM,
            mine=mine,
            theirs=theirs,
            base=base,
            chosen=mine,
        )

    return Decision(
        path=path,
        outcome=CONFLICT,
        mine=mine,
        theirs=theirs,
        base=base,
        chosen=mine,
        note=(
            "You changed this AND the shipped default changed. Your value was "
            "kept and nothing was merged automatically. Decide which you want."
        ),
    )


def _walk(
    base: Any,
    mine: Any,
    theirs: Any,
    had_base: bool,
    prefix: str,
    decisions: list[Decision],
    importable: dict[str, list],
) -> Any:
    """Recursively merge one level of the configuration.

    Nested mappings recurse. Everything else, including lists, is treated as
    a single atomic value; see the module docstring for why lists are not
    merged element-wise.

    Args:
        base: Old defaults subtree, or MISSING.
        mine: User subtree, or MISSING.
        theirs: New defaults subtree, or MISSING.
        had_base: Whether a base document was supplied.
        prefix: Dotted path prefix for reporting.
        decisions: Accumulator, appended to in place.
        importable: Accumulator for additive list imports, filled in place.

    Returns:
        The merged value for this subtree.
    """
    both_maps = isinstance(mine, dict) and isinstance(theirs, dict)
    if not both_maps:
        decision = _classify(prefix, base, mine, theirs, had_base)
        decisions.append(decision)

        if isinstance(mine, list) and isinstance(theirs, list) and mine != theirs:
            new_items = [item for item in theirs if item not in mine]
            if new_items:
                importable[prefix] = new_items

        return decision.chosen

    merged: dict = {}
    keys: list[str] = list(theirs.keys())
    for key in mine.keys():
        if key not in merged and key not in keys:
            keys.append(key)

    for key in keys:
        child_path = f"{prefix}.{key}" if prefix else key
        child_base = (base or {}).get(key, MISSING) if isinstance(base, dict) else MISSING
        child_mine = mine.get(key, MISSING)
        child_theirs = theirs.get(key, MISSING)

        # Documentation keys always follow the new defaults. Pinning a stale
        # explanation because the user's file has an older copy of the prose
        # would be worse than useless.
        if _is_comment_key(key):
            if child_theirs is not MISSING:
                merged[key] = child_theirs
            continue

        merged[key] = _walk(
            child_base,
            child_mine,
            child_theirs,
            had_base,
            child_path,
            decisions,
            importable,
        )

    return merged


def merge_config(
    mine: dict,
    theirs: dict,
    base: Optional[dict] = None,
) -> MergeResult:
    """Three-way merge the user's config against new shipped defaults.

    Args:
        mine: The user's live configuration.
        theirs: The defaults shipping with the new version.
        base: The defaults that shipped with the user's current version. None
            means no base was recorded, which makes every differing field
            CANNOT_DETERMINE rather than a guess.

    Returns:
        A MergeResult holding the merged mapping, one Decision per field, and
        any additive list imports that were NOT applied.

    Example:
        >>> result = merge_config({"a": 1}, {"a": 2}, base={"a": 1})
        >>> result.merged["a"]
        2
    """
    decisions: list[Decision] = []
    importable: dict[str, list] = {}
    had_base = base is not None

    merged = _walk(
        copy.deepcopy(base) if had_base else MISSING,
        copy.deepcopy(mine),
        copy.deepcopy(theirs),
        had_base,
        "",
        decisions,
        importable,
    )

    return MergeResult(
        merged=merged,
        decisions=decisions,
        had_base=had_base,
        importable=importable,
    )


def load_json(path: Path) -> Optional[dict]:
    """Read a JSON object from disk.

    Args:
        path: File to read.

    Returns:
        The parsed mapping, or None when the file is absent. A file that
        exists but does not parse raises, because silently treating corrupt
        configuration as "not present" would let a merge quietly discard it.

    Raises:
        json.JSONDecodeError: The file exists and is not valid JSON.
    """
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def apply_import(merged: dict, dotted_path: str, items: list) -> dict:
    """Append importable items to a list field, in place on a copy.

    Only ever appends, and only items that are not already present. Order of
    the user's existing entries is preserved, because reordering somebody's
    command list is a change they did not ask for.

    Args:
        merged: The merged configuration.
        dotted_path: Dotted path of the list field.
        items: Items to append.

    Returns:
        A new configuration mapping with the items appended.

    Raises:
        KeyError: The path does not resolve to a list in the configuration.
    """
    result = copy.deepcopy(merged)
    parts = dotted_path.split(".")
    cursor: Any = result
    for part in parts[:-1]:
        cursor = cursor[part]

    target = cursor.get(parts[-1])
    if not isinstance(target, list):
        raise KeyError(f"{dotted_path} is not a list in this configuration")

    for item in items:
        if item not in target:
            target.append(item)

    return result
