"""Name-keyed stored-row decorations, read once per listing pass.

WHY THIS EXISTS. ``SessionManager._session_info_for`` decorates every row
with three reads off the ``sessions`` table, and each of them opens its
OWN SQLite connection. Measured with 4 live sessions that is ``3N``
connections on a pass that ran SYNCHRONOUSLY inside
``async def list_session_infos``, so every one of them was paid as
terminal latency - the event loop cannot read the tmux pipe carrying
terminal output, cannot deliver a keystroke and cannot answer another
request for as long as the pass runs.

CLAUDE.md records why those three were NOT folded into ``InstanceIndex``:
they are NAME-KEYED with a recency rule ("the newest instance of this
name") while the index is keyed on the full instance triple, so answering
them from it would be a silent behaviour change in the duplicate-name
case nobody looks at. THIS MODULE DOES NOT FOLD THEM IN. It calls the
SAME three readers, with the SAME queries and the SAME selection rules,
once per name, off the event loop. It is a change of WHERE the work runs
and never of WHAT it answers.

OWNERSHIP IS THE FOURTH NAME-KEYED READER AND IT IS DELIBERATELY NOT
HERE. ``is_owned_tmux_name`` is a two-rung ladder, the in-memory
``owned_tmux_sessions`` set then the datastore, and an ADOPTION moves
ONLY the datastore rung - ``adopt_external_session`` says so in its own
docstring, and the only three ``owned_tmux_sessions.add`` sites are the
boot backfill, create and rename. So the datastore is exactly the rung an
adoption lands on, and prefetching it opens a window: a free loop can
accept an adoption while the gather thread runs, after which the
prefetched answer says the name is not owned and ``created_by_cloude``
drops off a freshly adopted row for one poll cycle. The reader stays on
the loop, read per row, exactly as it was. It cost 4 of the pass's 17
datastore opens at 4 sessions, so the other three readers carry the
clear majority of the saving and this buys the staleness question being
GONE rather than documented.

ABSENT IS NOT AN ANSWER. A name this prefetch was not built over is
reported as absent, and the caller falls through to the live per-row read
it always made. That is the same ``complete`` discipline
``StatusMap`` and ``InstanceIndex`` already carry, and it is what keeps
single-session callers (``get_session_info``, which passes no prefetch)
byte-identical.

THE READS ARE A MOMENT, NOT A LEASE, and nothing here is ever written
back. Each value is a decoration derived from a stored row, exactly as it
was when it was read per row; taking it a few milliseconds earlier can
change which moment a label reflects and can never make one wrong. There
is therefore no apply stage and no staleness rule to enforce - see
``src/core/listing_gather.py`` for the writes that were deliberately
LEFT on the loop precisely because they would need one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, Mapping, Optional


@dataclass(frozen=True)
class NameReads:
    """The three name-keyed stored-row decorations for one tmux name.

    Inputs: label (str | None) - the row's user-facing title.
      identity (dict | None) - ``id`` / ``parent_session_id`` /
      ``agent_type`` / ``agent_family_source`` off the newest row.
      restored_activity_state (str | None) - the durable activity state,
      already judged for age by ``activity_persist.restore_state``.
    Output: an immutable record; every field's None is the SAME None the
      per-row reader returns for "no row, no value, or unreadable", so a
      consumer cannot tell this apart from the read it replaces.
    Example: NameReads(label='work', identity=None,
      restored_activity_state='idle')
    """

    label: Optional[str] = None
    identity: Optional[dict] = None
    restored_activity_state: Optional[str] = None


@dataclass(frozen=True)
class ListingPrefetch:
    """Every name-keyed read this pass needs, taken off the event loop.

    Description: a lookup table whose membership is the flag that keeps
      "not read" apart from "read and the answer was nothing". A reading
      that did not happen is not a reading of nothing, which is this
      project's standing rule and the only thing that makes falling back
      correct.
    Inputs: by_name (Mapping[str, NameReads]) - one entry per tmux name
      the gather actually read.
    Output: an immutable prefetch. The empty default is a complete and
      correct value: every lookup reports absent and every caller falls
      back to the live read.
    Example: ListingPrefetch(by_name={'cloude_a': NameReads(label='a')})
    """

    by_name: Mapping[str, NameReads] = field(default_factory=dict)

    def has(self, tmux_name: Optional[str]) -> bool:
        """True iff this prefetch actually read the given tmux name.

        Inputs: tmux_name (str | None).
        Output: bool - False for None, for an empty name, and for any
          name the gather did not cover.
        Example: prefetch.has('cloude_a') -> True
        """
        return bool(tmux_name) and tmux_name in self.by_name

    def label_for(self, tmux_name: Optional[str]) -> Optional[str]:
        """The prefetched label for a name, or None.

        Inputs: tmux_name (str | None).
        Output: str | None. Callers must gate on :meth:`has` first; a
          bare None here cannot be told from "no label".
        Example: prefetch.label_for('cloude_a') -> 'work'
        """
        entry = self.by_name.get(tmux_name or "")
        return entry.label if entry is not None else None

    def identity_for(self, tmux_name: Optional[str]) -> Optional[dict]:
        """The prefetched row identity for a name, or None.

        Inputs: tmux_name (str | None).
        Output: dict | None - the same shape
          ``session_store.identity_for_live_name`` returns.
        Example: prefetch.identity_for('cloude_a') -> {'id': 7, ...}
        """
        entry = self.by_name.get(tmux_name or "")
        return entry.identity if entry is not None else None

    def restored_state_for(self, tmux_name: Optional[str]) -> Optional[str]:
        """The prefetched durable activity state for a name, or None.

        Inputs: tmux_name (str | None).
        Output: str | None - already age-judged, so None covers absent,
          stale, unparseable and ``dead`` exactly as the live read does.
        Example: prefetch.restored_state_for('cloude_a') -> 'idle'
        """
        entry = self.by_name.get(tmux_name or "")
        return entry.restored_activity_state if entry is not None else None


def build_listing_prefetch(
    *,
    names: Iterable[Optional[str]],
    label_for_name: Callable[[Optional[str]], Optional[str]],
    identity_for_live_name: Callable[[Optional[str]], Optional[dict]],
    restored_activity_state: Callable[[Optional[str]], Optional[str]],
) -> ListingPrefetch:
    """Run every name-keyed stored-row read for a listing pass.

    Description: the callables are the manager's own readers, handed in
      rather than reached through ``self``, so this function cannot touch
      live shared state even by accident - it is the body that runs in a
      worker thread and the narrow surface is the guarantee. Each reader
      already swallows its own failures and answers None, so nothing here
      needs a second layer of that.

      NAMES ARE DEDUPLICATED AND ORDER IS PRESERVED, so two sessions
      sharing one tmux name cost one set of reads and get the identical
      answer they would have got from two.
    Inputs: names (iterable[str | None]) - the tmux names this pass will
      decorate; falsy entries are skipped, since every reader answers
      None for one without opening anything.
      label_for_name / identity_for_live_name / restored_activity_state
      (callables taking a name) - the manager's existing per-row readers,
      unchanged.
    Output: ListingPrefetch - never None, never raises.
    Example: build_listing_prefetch(names=['cloude_a'], ...)
    """
    by_name: Dict[str, NameReads] = {}
    for name in names:
        if not name or name in by_name:
            continue
        by_name[name] = NameReads(
            label=label_for_name(name),
            identity=identity_for_live_name(name),
            restored_activity_state=restored_activity_state(name),
        )
    return ListingPrefetch(by_name=by_name)
