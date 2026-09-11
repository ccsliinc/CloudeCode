"""The seed cache, and the clock that says when to derive a new one.

Split out of ``session_status_seed`` so the LADDER stays a page of pure
rules with no mutable state next to it, the same way
``session_startup_gate_ledger`` sits beside ``session_startup_gate``.

A SEED IS A READING, NOT AN EVENT, and that is why this file is a plain
cache rather than a state machine. Applying the same hook event twice can
wedge a state machine, which is why every consumer in
``session_activity`` had to be made idempotent by hand. Storing the same
READING twice leaves the same state by construction: there is no ordering
to get wrong and nothing to accumulate, so repeated boot, adopt and
listing passes over one session all converge on the same answer.

IT HOLDS NO POLICY. :meth:`SessionStatusSeeds.due` answers exactly one
question - has the interval elapsed - and says nothing about whether a
session is eligible to be seeded at all. That gate belongs to the seam,
which refuses any session with live hook signal, because a hook outranks
a seed and this cache must never be able to argue with one.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, Iterable, Optional, Tuple

from src.core.session_status_seed import (
    SEED_REFRESH_INTERVAL_SECONDS,
    StatusSeed,
)

#: One held reading: the seed, when it was derived, and the epoch it was
#: keyed on (``None`` when the instance was not known at derive time).
_Held = Tuple[StatusSeed, datetime, Optional[int]]


class SessionStatusSeeds:
    """Per-session seeds and the clock that says when to re-derive one.

    Description: a plain cache, not a state machine. A seed is a READING
      of durable evidence, so storing the same one twice is the same
      state and there is no ordering to get wrong - which is what makes
      seeding idempotent under repeated boot, adopt and listing passes.

      It holds no policy: ``due`` answers only "has the interval
      elapsed", and the seam is what decides whether a session is
      eligible to be seeded at all (it is not, once a hook has landed).
    Inputs: n/a.
    Output: n/a.
    Example:
      seeds = SessionStatusSeeds(); seeds.remember('s1', seed)
    """

    def __init__(self) -> None:
        self._seeds: Dict[str, _Held] = {}

    def remember(
        self,
        session_id: str,
        seed: StatusSeed,
        now: Optional[datetime] = None,
        *,
        epoch: Optional[int] = None,
    ) -> StatusSeed:
        """Store one session's seed and stamp when it was derived.

        Description: idempotent - the same seed stored twice leaves the
          same state, and a different one simply replaces it, because a
          later reading of the same evidence is the better one.
        Inputs: session_id (str). seed (StatusSeed). now (datetime | None).
          epoch (int | None) - the instance epoch this seed was derived
          against, so a later ``due`` call can tell a genuinely fresh
          reading from one taken before the instance was identifiable.
        Output: StatusSeed - the seed that was stored, for chaining.
        Example: seeds.remember('s1', seed).state
        """
        stamped = now or datetime.now(timezone.utc)
        self._seeds[session_id] = (seed, stamped, epoch)
        return seed

    def get(self, session_id: str) -> Optional[StatusSeed]:
        """The seed held for a session, or None if it has never been derived.

        Description: a read, with no side effect and no expiry - staleness
          is ``due``'s question, and a caller that wants the last answer
          while it waits for the next one gets it here.
        Inputs: session_id (str).
        Output: StatusSeed | None.
        Example: seeds.get('s1')
        """
        held = self._seeds.get(session_id)
        return held[0] if held else None

    def due(
        self,
        session_id: str,
        *,
        now: Optional[datetime] = None,
        interval_seconds: int = SEED_REFRESH_INTERVAL_SECONDS,
        epoch: Optional[int] = None,
    ) -> bool:
        """Whether this session's seed should be re-derived now.

        Description: True for a session never seeded, for one whose seed
          is older than ``interval_seconds``, and - regardless of age -
          for one whose instance epoch was unknown when it was cached and
          is known now. That last rule is what stops a refusal cached as
          "this session's exact tmux instance could not be identified"
          from being permanent: an epoch that arrives late (a boot race
          that resolved it after the first seed attempt) makes the cached
          reading immediately due rather than making it wait out a full
          refresh interval on stale grounds. A clock that appears to run
          backwards (a system time change) also reads due, because
          re-deriving costs one bounded file read and never re-deriving is
          the failure that matters.
        Inputs: session_id (str). now (datetime | None). interval_seconds
          (int) - defaults to :data:`SEED_REFRESH_INTERVAL_SECONDS`.
          epoch (int | None) - the caller's current best epoch for this
          session, or None when it still has none to offer.
        Output: bool.
        Example: seeds.due('s1')
        """
        held = self._seeds.get(session_id)
        if held is None:
            return True
        _, stamped, cached_epoch = held
        if cached_epoch is None and epoch is not None:
            return True
        age = (now or datetime.now(timezone.utc)) - stamped
        return age.total_seconds() >= interval_seconds or age.total_seconds() < 0

    def forget(self, session_id: str) -> None:
        """Drop one session's seed. Idempotent.

        Description: called when a session stops being live, so a seed
          cannot outlive the pane it describes.
        Inputs: session_id (str).
        Output: None.
        Example: seeds.forget('s1')
        """
        self._seeds.pop(session_id, None)

    def prune(self, live_ids: Iterable[str]) -> int:
        """Drop every seed whose session is no longer live.

        Description: keeps the cache bounded by the live population
          rather than by everything the process has ever seen.
        Inputs: live_ids (Iterable[str]) - the ids to keep.
        Output: int - how many seeds were dropped.
        Example: seeds.prune(registry.sessions)
        """
        keep = set(live_ids or ())
        stale = [sid for sid in self._seeds if sid not in keep]
        for sid in stale:
            self._seeds.pop(sid, None)
        return len(stale)
