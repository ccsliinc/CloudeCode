"""THE ONE EPOCH SOURCE THE UNREAD FLAG KEYS ON.

``UnreadStore`` composes the key (``<tmux_name>@<epoch>``) and has done
since it shipped, so the COMPOSITION was never the problem. The epoch
handed to it was: the manual control resolved one by probing tmux for the
name, the ``Stop`` writer resolved one from ``_work_stamp_epoch`` (a
SESSION_ID-keyed memo, seeded on the create/adopt/boot paths from the
DATABASE ROW rather than from tmux), and ``_session_info_for`` read a
listing row's ``created_at_epoch`` and fell back to that same session_id
memo. Three derivations for one key. They agree while the row and tmux
agree, and the moment they do not, a clear lands on a key nobody set and
the flag is unclearable for the life of the session: the store says
unread, every layer between looks correct, and the user's click does
nothing.

THE MEASUREMENT IS TMUX AND ONLY TMUX. ``#{session_created}`` belongs to
the live tmux server, so the live listing is the only thing that can
answer what this pane's instance is. A database row records what the
epoch WAS when the row was written, which is a different question, and a
session_id-keyed memo answers a third one ("what did this process decide
when it first saw this handle"). Both are dropped here. The cache below
is a MEMO OF THE TMUX MEASUREMENT, not a second source: every value in
it was read out of a tmux listing, and every listing the manager
performs overwrites it (see ``remember``), so it tracks tmux within one
poll of the UI's own refresh.

Keyed by TMUX NAME rather than session_id, because the flag is: an
adopted session's id is minted per process while the name is what both
the store and the user's control speak, and a name-keyed memo cannot go
stale across a restart the way a session_id-keyed one silently does.

A ``None`` epoch is UNMEASURED, never "new". It composes to the bare
name, which is the legacy key shape, so an unresolvable epoch degrades
to the pre-instance-key behaviour instead of minting a second entry for
a session that already has one. See ``UnreadStore.compose_key``.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, MutableMapping, Optional

import structlog

logger = structlog.get_logger()

# The listing field carrying ``#{session_created}`` on a decorated row.
EPOCH_FIELD = "created_at_epoch"
# The listing field carrying the literal tmux session name.
NAME_FIELD = "name"

EpochCache = MutableMapping[str, int]
ListingProbe = Callable[[], Any]


def epoch_of_row(row: Optional[Mapping[str, Any]]) -> Optional[int]:
    """This listing row's ``#{session_created}``, or None if it has none.

    Description: the single place a raw listing row is turned into an
        epoch, so every unread call site coerces it identically. A row
        that carries the field as a string (tmux speaks text) is coerced
        to int here rather than at four call sites that could each pick a
        different rule; anything uncoercible is an unmeasured epoch, not
        a crash.
    Inputs:
        row: one decorated tmux listing row, or None.
    Output: int | None - the epoch, or None when absent/uncoercible.
    Example:
        >>> epoch_of_row({"name": "cloude_a", "created_at_epoch": 17})
        17
        >>> epoch_of_row(None) is None
        True
    """
    if not row:
        return None
    raw = row.get(EPOCH_FIELD)
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        # An uncoercible epoch is a CANNOT-DETERMINE, not a new instance.
        # Logged rather than swallowed: it would mean tmux changed the
        # shape of a field this key depends on.
        logger.debug("unread_epoch_uncoercible", value=repr(raw))
        return None


def remember(
    cache: EpochCache, tmux_name: Optional[str], epoch: Optional[int]
) -> Optional[int]:
    """Record a MEASURED epoch for a tmux name and hand it straight back.

    Description: the write half of the memo. Called from every path that
        already holds a listing row, so the cache is refreshed for free
        by the poll the UI runs anyway and a reused tmux name cannot keep
        its predecessor's epoch for longer than one poll. Returns its own
        input so a call site can both remember and use in one expression.

        A None epoch does NOT evict: not having measured an epoch on this
        pass is not evidence the one already measured is wrong, and
        evicting on it would drop the memo every time a single listing
        row came back short.
    Inputs:
        cache: the manager's name-keyed epoch memo.
        tmux_name: literal tmux session name. Falsy is a no-op.
        epoch: the measured ``#{session_created}``, or None.
    Output: int | None - ``epoch``, unchanged.
    Example:
        >>> c = {}
        >>> remember(c, "cloude_a", 17)
        17
        >>> c["cloude_a"]
        17
    """
    if tmux_name and epoch is not None:
        cache[tmux_name] = int(epoch)
    return epoch


def remember_listing(cache: EpochCache, listing: Any) -> int:
    """Refresh the memo from a whole tmux listing.

    Description: the bulk form of ``remember``. A listing that did not
        answer (``ok`` False) changes NOTHING - a failed probe is not
        evidence any session's epoch moved, and treating it as one would
        wipe the memo on every transient tmux hiccup.
    Inputs:
        cache: the manager's name-keyed epoch memo.
        listing: a ``TmuxListing``-shaped object (``.ok``, ``.sessions``).
    Output: int - how many names were refreshed.
    Example:
        >>> remember_listing({}, listing)
        19
    """
    if not getattr(listing, "ok", False):
        return 0
    seen = 0
    for row in getattr(listing, "sessions", None) or []:
        if remember(cache, row.get(NAME_FIELD), epoch_of_row(row)) is not None:
            seen += 1
    return seen


def resolve_epoch(
    cache: EpochCache,
    tmux_name: Optional[str],
    probe: Optional[ListingProbe] = None,
) -> Optional[int]:
    """The epoch the unread flag for this tmux name keys on.

    Description: THE function every unread set, clear and read goes
        through, so the three can never disagree about what instance they
        are talking about. Answers from the memo when it holds a measured
        value, and only otherwise spends a tmux listing - which is what
        keeps this callable from the hook path, where a subprocess per
        event is the cost this project already refused once (see
        ``_work_stamp_epoch``'s note on the activity-state path).

        NEVER PASS A PROBE THAT RE-ENTERS THE LISTING. The listing loop
        decorates each row with its unread flag, so a probe called from
        inside it recurses. That loop holds the row already and must call
        ``remember`` instead.
    Inputs:
        cache: the manager's name-keyed epoch memo.
        tmux_name: literal tmux session name, or None.
        probe: zero-arg callable returning a ``TmuxListing``, called only
            on a memo miss. None means memo-only.
    Output: int | None - the epoch, or None when it cannot be measured.
    Example:
        >>> resolve_epoch({"cloude_a": 17}, "cloude_a")
        17
    """
    if not tmux_name:
        return None
    cached = cache.get(tmux_name)
    if cached is not None:
        return cached
    if probe is None:
        return None
    try:
        listing = probe()
    except (OSError, ValueError, TypeError, KeyError) as exc:
        # A probe must never break the control it serves; an unresolvable
        # epoch degrades to the legacy bare-name key, it does not fail
        # the mark or the clear.
        logger.debug("unread_epoch_probe_failed", error=str(exc))
        return None
    remember_listing(cache, listing)
    return cache.get(tmux_name)


def forget(cache: EpochCache, tmux_name: Optional[str]) -> None:
    """Drop one name's memo, so the next resolve re-measures it.

    Description: used when a pane is known to have been replaced and the
        memo would otherwise answer for the session that is gone.
    Inputs: cache (EpochCache). tmux_name (str | None) - falsy is a no-op.
    Output: None.
    """
    if tmux_name:
        cache.pop(tmux_name, None)
