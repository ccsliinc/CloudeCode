"""The reads behind the hookless transcript ladder, and the seam that applies it.

``session_transcript_status`` decides what the evidence MEANS; this module
does the I/O that decision needs and owns the one piece of mutable state
it rests on. Same split ``session_status_seed`` keeps from
``session_status_seed_read``, and ``session_startup_gate`` from its
ledger.

TWO READS, BOTH BOUNDED, BOTH REFUSING RATHER THAN GUESSING:

  1. THE TRANSCRIPT'S MTIME, one ``stat`` on a path resolved through
     ``session_transcript_presence.conversation_presence`` - the single
     source of truth for how a uuid maps to a file, so no slug is
     re-derived here.
  2. THE TRANSCRIPT'S TAIL, through ``claude_title_sync.read_tail_records``
     - the one bounded reader this codebase has, 64 KB, 0.274 ms median
     against a 244 MB file.

Both come off ONE presence resolution, which is why this module owns the
combined read and ``session_status_seed_read.read_transcript_rest``
delegates to it rather than resolving the path a second time.

NEITHER READ MAY RAISE. This runs on the listing path that paints the
sidebar and the launchpad, and a status is telemetry: every failure
becomes a named outcome the caller may log and ignore.

WHY THE GATE IS ``hooks_seen``, AND WHY IT IS NOT THE HOOK TOKEN STORE.
The rule is that hooks are a hooked session's truth, and the seam that
reaches this module already enforces exactly that: it runs only while
``SessionActivityTracker.hooks_seen`` is False, and the first hook event
of the process retires the whole seed for good. Membership in the hook
TOKEN store looks like a stronger gate and is not one. MEASURED on live
2026-09-09: ``hook_tokens.json`` holds 33 entries against 19 live tmux
sessions, and every externally adopted pane is in it - because an adopt
mints a token for a pane it never spawned into, which is the exact
hazard CLAUDE.md records. A token proves this app minted one; it does
not prove a hook can ever arrive. Gating on it would have refused the
ladder to every session it was built for.

THE LEDGER IS KEYED ON THE INSTANCE, not on the session id. A session id
dies on detach and a tmux name is reused, so the key is
``<tmux_name>@<created_epoch>`` - composed by ``UnreadStore.compose_key``,
imported rather than re-spelled, so the turn ledger and the unread flag
it writes can never disagree about which pane they are talking about.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from weakref import WeakKeyDictionary

import structlog

from src.core.session_status_seed_records import (
    TAIL_ABSENT,
    TAIL_UNREADABLE,
    TranscriptRest,
    classify_tail_records,
)
from src.core.session_transcript_status import (
    RUNG_TURN_END_NEW,
    RUNG_TURN_END_SEEN,
    TranscriptStatus,
    resolve_transcript_status,
)
from src.core.unread_store import UnreadStore

#: The rungs whose ``at`` is a TURN BOUNDARY rather than a file mtime, and
#: therefore the only two that may move the turn ledger's baseline.
_TURN_END_RUNGS: frozenset[str] = frozenset(
    {RUNG_TURN_END_NEW, RUNG_TURN_END_SEEN}
)

logger = structlog.get_logger(__name__)

#: Every error the reads and the writes in this module can raise, named
#: rather than caught blanket. ``OSError`` covers the stat and the tail
#: read, ``sqlite3.Error`` the presence probe's own lookups, and
#: ``ValueError``/``KeyError`` a malformed record surfacing on the way
#: through. Anything outside this set is a defect and must propagate.
_READ_ERRORS: Tuple[type, ...] = (sqlite3.Error, OSError, ValueError, KeyError)


@dataclass(frozen=True)
class TranscriptReading:
    """One transcript, read once: when it was last written, and what it says.

    Description: the return of :func:`read_transcript_signal`. Both
      halves come off a SINGLE presence resolution, which is the whole
      reason this type exists rather than two functions - resolving the
      path twice per poll would double the only I/O on this path.

      - ``mtime``: the file's modification time, timezone-aware, or None
        when there is no file or it could not be stat'ed.
      - ``tail``: what the last decidable record says, never None.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    mtime: Optional[datetime]
    tail: TranscriptRest


def read_transcript_signal(
    uuid: Optional[str],
    working_dir: Optional[str],
    *,
    session_id: Optional[str] = None,
) -> TranscriptReading:
    """Read one conversation's transcript mtime and tail verdict, once.

    Description: resolves the uuid to a file through
      ``conversation_presence`` and then takes BOTH measurements off that
      one path. THREE REFUSALS, kept apart: no uuid bound to the row, a
      MEASURED absent transcript, and a file that could not be read.
      None of them is evidence of rest, and only the middle one is
      evidence of anything. Never raises.
    Inputs: uuid (str | None) - ``sessions.claude_session_uuid``.
      working_dir (str | None) - used only for the fast-path slug.
      session_id (str | None) - for the failure log only.
    Output: TranscriptReading.
    Example: read_transcript_signal(uuid, '/Users/x/proj').tail.verdict
    """
    if not uuid:
        return TranscriptReading(
            mtime=None,
            tail=TranscriptRest(
                TAIL_ABSENT,
                detail=(
                    "no claude conversation is bound to this row, so there "
                    "is no transcript to read a status out of"
                ),
            ),
        )

    try:
        from src.core.session_transcript_presence import conversation_presence

        presence = conversation_presence(str(uuid), working_dir=working_dir)
    except _READ_ERRORS as exc:
        logger.warning(
            "transcript_status_presence_failed",
            session_id=session_id,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return TranscriptReading(
            mtime=None,
            tail=TranscriptRest(
                TAIL_UNREADABLE,
                detail=f"the transcript could not be located: {exc}",
            ),
        )

    if presence.path is None:
        return TranscriptReading(
            mtime=None,
            tail=TranscriptRest(
                TAIL_ABSENT if presence.missing else TAIL_UNREADABLE,
                detail=presence.detail,
            ),
        )

    mtime: Optional[datetime] = None
    try:
        stamp = presence.path.stat().st_mtime
        mtime = datetime.fromtimestamp(stamp, tz=timezone.utc)
    except _READ_ERRORS as exc:
        # A file that vanished between the presence probe and the stat is
        # ordinary; it costs the working rung and nothing else.
        logger.warning(
            "transcript_status_stat_failed",
            session_id=session_id,
            error=str(exc),
            error_type=type(exc).__name__,
        )

    from src.core.claude_title_sync import read_tail_records

    read = read_tail_records(str(presence.path))
    if not read.readable:
        return TranscriptReading(
            mtime=mtime,
            tail=TranscriptRest(TAIL_UNREADABLE, detail=read.detail),
        )
    return TranscriptReading(mtime=mtime, tail=classify_tail_records(read.records))


class TranscriptTurnLedger:
    """The newest turn end this ladder has recorded, per tmux INSTANCE.

    Description: a plain cache with ONE rule -
      :meth:`observe` records a first sighting and reports it as NOT new.
      That is what makes a server restart safe: the ledger is in memory,
      so on a fresh process every hookless session's transcript presents
      a turn end this object has never seen, and a first-sight claim
      would light the whole fleet unread including conversations that
      ended in July. FIRST SIGHT IS A BASELINE, NOT AN INSTRUCTION - the
      same rule ``claude_title_sync`` applies to a ``custom-title`` for
      the same reason.

      Idempotent by construction: observing the same timestamp twice
      answers True at most once, and an OLDER timestamp never answers
      True at all, so a duplicated pass and a rewound clock both converge
      on the same state.
    Inputs: n/a.
    Output: n/a.
    Example:
      led = TranscriptTurnLedger(); led.observe('cloude_x@1', t)  # False
    """

    def __init__(self) -> None:
        self._seen: Dict[str, datetime] = {}

    def newest_seen(self, key: str) -> Optional[datetime]:
        """The newest turn end recorded for one instance, or None.

        Description: a read with no side effect, so a caller can hand the
          value to the PURE ladder without the act of asking changing the
          answer.
        Inputs: key (str) - ``<tmux_name>@<epoch>``.
        Output: datetime | None.
        Example: ledger.newest_seen('cloude_x@1757000000')
        """
        return self._seen.get(key)

    def observe(self, key: str, at: Optional[datetime]) -> bool:
        """Record a turn end and say whether it was NEWER than what we held.

        Description: False on a first sighting (the baseline rule above),
          False for an older or equal timestamp, and False for a
          timestamp that could not be read - there is no key to make a
          claim idempotent on, so no claim is made. True ONLY for a
          strictly newer turn end on an instance already being watched.

          THE BASELINE ONLY EVER MOVES FORWARD. An older reading does
          not rewind it, because rewinding would let the next ordinary
          poll see the newer turn end again and claim it a second time -
          the duplicate this whole class exists to prevent. Readings can
          go backwards for real reasons: a tail window that a large tool
          result pushed the newer marker out of, or a transcript rolled
          over. Neither is evidence that a turn un-happened.
        Inputs: key (str) - ``<tmux_name>@<epoch>``. at (datetime | None)
          - the turn end's timestamp.
        Output: bool - True means the caller owes exactly one unread
          claim for this turn.
        Example: ledger.observe('cloude_x@1', later) -> True
        """
        if not key or at is None:
            return False
        previous = self._seen.get(key)
        if previous is None:
            self._seen[key] = at
            return False
        if at > previous:
            self._seen[key] = at
            return True
        return False

    def forget(self, key: str) -> None:
        """Drop one instance's record. Idempotent.

        Inputs: key (str).
        Output: None.
        Example: ledger.forget('cloude_x@1757000000')
        """
        self._seen.pop(key, None)


#: One turn ledger per SessionManager, keyed weakly for the same reason
#: ``session_status_seed_read._STORES`` is: the store dies with its
#: manager, ``session_manager.py`` is not edited to hold it, and a fresh
#: manager in a test starts genuinely empty.
_LEDGERS: "WeakKeyDictionary[Any, TranscriptTurnLedger]" = WeakKeyDictionary()


def ledger_for(manager: Any) -> TranscriptTurnLedger:
    """The turn ledger belonging to one SessionManager, created on demand.

    Description: idempotent. A manager that cannot be weakly referenced
      (a test double built on a builtin) gets a fresh throwaway ledger
      rather than an error - and a throwaway ledger only ever costs a
      claim, never invents one, because a first sighting never claims.
    Inputs: manager (SessionManager).
    Output: TranscriptTurnLedger.
    Example: ledger_for(mgr).newest_seen(key)
    """
    try:
        held = _LEDGERS.get(manager)
        if held is None:
            held = TranscriptTurnLedger()
            _LEDGERS[manager] = held
        return held
    except TypeError:
        return TranscriptTurnLedger()


def transcript_status_for(
    manager: Any,
    *,
    session_id: str,
    tmux_name: Optional[str],
    epoch: Optional[int],
    reading: Optional[TranscriptReading],
    unread: bool,
    now: datetime,
) -> TranscriptStatus:
    """Apply the hookless transcript ladder, and claim one unread if owed.

    Description: THE SEAM. Runs the PURE ladder against the reading, then
      does the one thing the ladder is not allowed to do - record the
      turn end and set the AUTO unread flag, exactly once per newly-seen
      turn, through the same ``UnreadStore`` the ``Stop`` hook writes.
      Never raises: a failed write costs an unread badge, and must never
      cost the listing.

      THE ORDER MATTERS. The ledger is consulted BEFORE it is updated,
      because the pure ladder needs to be told what was already known;
      updating first would make every turn end look already-seen and the
      unread claim would never fire at all.
    Inputs: manager (SessionManager) - for the unread store only.
      session_id (str) - for logs. tmux_name (str | None) and epoch
      (int | None) - the instance the ledger and the flag key on.
      reading (TranscriptReading | None). unread (bool) - the persisted
      flag as it stands. now (datetime) - tz-aware clock.
    Output: TranscriptStatus - ``answers`` is False when no rung
      answered.
    Example:
      transcript_status_for(mgr, session_id=sid, tmux_name=n, epoch=e,
                            reading=r, unread=False, now=now).state
    """
    key = UnreadStore.compose_key(tmux_name, epoch) if tmux_name else ""
    ledger = ledger_for(manager)
    status = resolve_transcript_status(
        mtime=reading.mtime if reading else None,
        tail=reading.tail if reading else None,
        last_turn_end_seen=ledger.newest_seen(key) if key else None,
        unread=unread,
        now=now,
    )

    # ONLY A TURN END FEEDS THE TURN LEDGER. Both turn-end rungs do,
    # new or not: rung 3 is what establishes the baseline a later rung 2
    # is judged against, so skipping it would leave a session
    # permanently unable to notice its next turn. Rung 1 is excluded
    # even though it carries a timestamp, because that timestamp is a
    # FILE MTIME and not a turn boundary - recording it would move the
    # baseline forward past turn ends that were never observed, and the
    # next real turn end would read as old.
    if key and status.rung in _TURN_END_RUNGS and status.at is not None:
        is_new = ledger.observe(key, status.at)
        if is_new and status.claim_turn_end_at is not None:
            _claim_unread(manager, session_id, tmux_name, epoch)
    return status


def _claim_unread(
    manager: Any,
    session_id: str,
    tmux_name: Optional[str],
    epoch: Optional[int],
) -> None:
    """Set the AUTO unread flag for one instance. Never raises.

    Description: the hookless stand-in for what a ``Stop`` hook does, and
      it writes through the SAME store and the SAME sub-flag, so the
      user's mark-read control and a WS bind clear it exactly as they
      clear a hook-set one. Nothing here writes ``manual``: that half
      belongs to the user alone.
    Inputs: manager (SessionManager). session_id (str) - log only.
      tmux_name (str | None). epoch (int | None).
    Output: None.
    Example: _claim_unread(mgr, sid, 'cloude_x', 1757000000)
    """
    if not tmux_name:
        return
    store = getattr(manager, "_unread_store", None)
    if store is None:
        return
    try:
        store.set_flag(tmux_name, "auto", True, epoch=epoch)
        logger.info(
            "transcript_turn_end_marked_unread",
            session_id=session_id,
            tmux_name=tmux_name,
        )
    except _READ_ERRORS as exc:
        logger.warning(
            "transcript_unread_claim_failed",
            session_id=session_id,
            tmux_name=tmux_name,
            error=str(exc),
            error_type=type(exc).__name__,
        )
