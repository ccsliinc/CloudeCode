"""The two reads behind the seed ladder, and the seam that applies it.

``session_status_seed`` decides what durable evidence MEANS; this module
does the I/O that decision needs and nothing else, the same split
``session_boot_readopt`` keeps from ``session_boot_readopt_plan``. Two
reads, both bounded and both refusing rather than guessing:

  1. THE ROW, keyed on the FULL INSTANCE TRIPLE ``(tmux_socket,
     tmux_name, tmux_created_epoch)`` - the same triple
     ``activity_persist.write_state`` writes on, and byte-for-byte the
     same WHERE clause. That matters: a tmux name is reused the moment
     its owner dies, so two rows can carry one name at once (a stopped
     conversation and its live successor), and a name-scoped read picks
     whichever epoch sorts newest, which is a different question from
     "what does THIS pane's row say". A caller with no epoch has not
     identified an instance, so rung A is refused outright rather than
     falling back to a name-scoped SELECT - the same refusal
     ``write_state`` already makes on the write side.
  2. THE TRANSCRIPT, through ``session_transcript_presence`` for the
     path (the single source of truth for how a uuid maps to a file, so
     no slug is re-derived here) and ``claude_title_sync.read_tail_records``
     for the bytes (the one bounded reader). A MEASURED absence and an
     unreadable file are kept apart, because only the first is a
     measurement.

NEITHER READ MAY RAISE. This runs on the listing path, which paints the
sidebar and the launchpad, and a status is telemetry: every failure
becomes a named outcome the caller may log and ignore. That is the same
posture ``_persist_activity_state`` and ``sync_claude_title`` already
take on their own critical paths.

WHERE THE CACHE LIVES, and why it is not an attribute on SessionManager.
The seeds hang off a ``WeakKeyDictionary`` keyed on the manager, so a
manager gets its own store without this module editing that class's
``__init__`` - ``session_manager.py`` is already far past the size
guideline and is under concurrent edit. A weak key means the store dies
with the manager rather than pinning one alive, which a module-level
dict keyed by id would not, and a fresh manager in a test starts with a
genuinely empty store rather than inheriting another test's.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from weakref import WeakKeyDictionary

import structlog

from src.core.session_status_seed import (
    SEED_RUNG_NONE,
    TAIL_ABSENT,
    TAIL_UNREADABLE,
    StatusSeed,
    TranscriptRest,
    classify_tail_records,
    display_state,
    resolve_status_seed,
)
from src.core.session_status_seed_store import SessionStatusSeeds

logger = structlog.get_logger(__name__)

#: One seed store per SessionManager. See the module docstring for why it
#: is keyed weakly here rather than assigned in that class's ``__init__``.
_STORES: "WeakKeyDictionary[Any, SessionStatusSeeds]" = WeakKeyDictionary()


def seeds_for(manager: Any) -> SessionStatusSeeds:
    """The seed store belonging to one SessionManager, created on demand.

    Description: idempotent - the same manager always gets the same
      store, and a manager that is garbage collected takes its store with
      it. A manager that cannot be weakly referenced (a test double built
      on a builtin type) gets a fresh throwaway store rather than an
      error, because a status seed must never be able to break a listing.
    Inputs: manager (SessionManager) - the owner.
    Output: SessionStatusSeeds.
    Example: seeds_for(mgr).get('ses_5a756046')
    """
    try:
        store = _STORES.get(manager)
        if store is None:
            store = SessionStatusSeeds()
            _STORES[manager] = store
        return store
    except TypeError:
        # Not weakly referenceable. Losing the cache costs one extra
        # bounded read per poll; raising would cost the listing.
        return SessionStatusSeeds()


def read_transcript_rest(
    uuid: Optional[str], working_dir: Optional[str]
) -> TranscriptRest:
    """What the tail of a conversation's transcript says about rest.

    Description: resolves the uuid to a file through
      ``conversation_presence`` and classifies the last decidable record
      in the bounded tail window. THREE REFUSALS, kept apart: no uuid
      bound to the row, a MEASURED absent transcript, and a file that
      could not be read. None of them is evidence of rest, and only the
      middle one is evidence of anything.
    Inputs: uuid (str | None) - ``sessions.claude_session_uuid``.
      working_dir (str | None) - used only for the fast-path slug.
    Output: TranscriptRest.
    Example: read_transcript_rest(uuid, '/Users/x/proj').verdict
    """
    if not uuid:
        return TranscriptRest(
            TAIL_ABSENT,
            detail=(
                "no claude conversation is bound to this row, so there is "
                "no transcript to read a resting state out of"
            ),
        )

    try:
        from src.core.session_transcript_presence import conversation_presence

        presence = conversation_presence(str(uuid), working_dir=working_dir)
    except Exception as exc:  # noqa: BLE001 - a probe must not break a listing
        logger.debug("status_seed_presence_failed", error=str(exc))
        return TranscriptRest(
            TAIL_UNREADABLE,
            detail=f"the transcript could not be located: {exc}",
        )

    if presence.path is None:
        return TranscriptRest(
            TAIL_ABSENT if presence.missing else TAIL_UNREADABLE,
            detail=presence.detail,
        )

    from src.core.claude_title_sync import read_tail_records

    read = read_tail_records(str(presence.path))
    if not read.readable:
        return TranscriptRest(TAIL_UNREADABLE, detail=read.detail)
    return classify_tail_records(read.records)


def read_instance_row(
    manager: Any, tmux_name: Optional[str], epoch: Optional[int]
) -> Optional[Dict[str, Any]]:
    """The four columns the ladder needs, off ONE instance's row.

    Description: keyed on the full triple, never on the name alone - see
      the module docstring. Returns None for every cannot-determine: no
      name, no epoch, no datastore, no matching row, or a failed query.
      A None is not an empty row; the caller seeds nothing either way,
      but the reason is logged rather than invented.
    Inputs: manager (SessionManager). tmux_name (str | None). epoch
      (int | None) - ``#{session_created}`` for the exact instance.
    Output: dict | None - ``activity_state``, ``activity_state_at``,
      ``claude_session_uuid``, ``working_dir``.
    Example: read_instance_row(mgr, 'cloude_Mac', 1788463220)
    """
    if not tmux_name or epoch is None:
        return None
    conn = None
    try:
        conn = manager._writable_datastore_connection()
        if conn is None:
            return None
        row = conn.execute(
            "SELECT activity_state, activity_state_at, claude_session_uuid, "
            "working_dir FROM sessions WHERE tmux_socket = ? AND "
            "tmux_name = ? AND tmux_created_epoch = ?",
            (manager._tmux_socket_name(), tmux_name, int(epoch)),
        ).fetchone()
        if not row:
            return None
        return {
            "activity_state": row[0],
            "activity_state_at": row[1],
            "claude_session_uuid": row[2],
            "working_dir": row[3],
        }
    except Exception as exc:  # noqa: BLE001 - a read must not break a listing
        logger.debug("status_seed_row_read_failed", error=str(exc))
        return None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - closing a read handle
                pass


def derive_seed(
    manager: Any,
    session_id: str,
    tmux_name: Optional[str],
    *,
    epoch: Optional[int] = None,
    now: Optional[datetime] = None,
) -> StatusSeed:
    """Run the whole ladder for one session and return what it supports.

    Description: does the two reads and hands them to the PURE
      ``resolve_status_seed``. Never raises. A session whose instance row
      cannot be identified gets a refusal naming that, not a seed built
      on a row that might belong to a different pane of the same name.
    Inputs: manager (SessionManager). session_id (str). tmux_name
      (str | None). epoch (int | None) - defaults to the manager's
      recorded epoch for this session. now (datetime | None).
    Output: StatusSeed - ``seeds`` is False whenever no rung answered.
    Example: derive_seed(mgr, 'ses_5a756046', 'cloude_Punchlist').state
    """
    if epoch is None:
        epoch = (getattr(manager, "_instance_epochs", None) or {}).get(session_id)

    row = read_instance_row(manager, tmux_name, epoch)
    if row is None:
        return StatusSeed(
            rung=SEED_RUNG_NONE,
            detail=(
                "this session's exact tmux instance could not be "
                "identified, so no row and no transcript were consulted"
            ),
        )

    tail = read_transcript_rest(
        row.get("claude_session_uuid"), row.get("working_dir")
    )
    return resolve_status_seed(
        row_state=row.get("activity_state"),
        row_state_at=row.get("activity_state_at"),
        tail=tail,
        now=now,
    )


def seeded_status(
    manager: Any,
    session_id: str,
    tmux_name: Optional[str],
    *,
    epoch: Optional[int] = None,
    unread: bool = False,
    now: Optional[datetime] = None,
) -> Optional[str]:
    """The status a session's durable evidence supports, cached and refreshed.

    Description: THE SEAM. Returns the seeded status, or None when no
      rung answered - the caller keeps whatever it already had, which is
      ``unknown``, and that stays a real answer.

      Re-derives at most once per
      ``session_status_seed.SEED_REFRESH_INTERVAL_SECONDS`` per session,
      and serves the cached reading in between, so a listing that polls
      every few seconds costs one bounded tail read a minute per hookless
      session. It is the CALLER's job to have established that this
      session has no live hook signal; a hook outranks a seed and this
      function is never reached once one has landed.
    Inputs: manager (SessionManager). session_id (str). tmux_name
      (str | None). epoch (int | None). unread (bool) - read, never
      written; see ``session_status_seed.display_state``. now
      (datetime | None).
    Output: str | None - an activity status, or None for "nothing seeded".
    Example: seeded_status(mgr, sid, name, unread=False) -> 'idle'
    """
    try:
        store = seeds_for(manager)
        stamp = now or datetime.now(timezone.utc)
        if store.due(session_id, now=stamp):
            seed = derive_seed(
                manager, session_id, tmux_name, epoch=epoch, now=stamp
            )
            store.remember(session_id, seed, now=stamp)
        else:
            seed = store.get(session_id) or StatusSeed()
        return display_state(seed, unread=unread)
    except Exception as exc:  # noqa: BLE001 - a status must not break a listing
        logger.debug("status_seed_failed", session_id=session_id, error=str(exc))
        return None


def seed_live_sessions(manager: Any) -> Tuple[int, int]:
    """Warm the seed for every session the manager currently holds.

    Description: run at the end of the boot re-adopt and after an adopt,
      so the FIRST listing after a restart already carries a resting
      session's status instead of painting it ``unknown`` until the next
      poll fills the cache lazily. Purely a warm-up: it derives exactly
      what the seam would derive, so running it, not running it, or
      running it twice all reach the same place. Skips any session that
      already has live hook signal, because a hook outranks a seed.
      Never raises - the boot pass must not fail because a status did
      not warm.
    Inputs: manager (SessionManager) - holding the sessions to seed.
    Output: tuple[int, int] - (sessions that got a seed, sessions
      examined).
    Example: seed_live_sessions(manager) -> (11, 19)
    """
    seeded = 0
    examined = 0
    try:
        sessions = dict(getattr(manager, "sessions", {}) or {})
        store = seeds_for(manager)
        store.prune(sessions.keys())
        tracker = getattr(manager, "_activity_tracker", None)
        now = datetime.now(timezone.utc)
        for session_id, session in sessions.items():
            if tracker is not None and tracker.hooks_seen(session_id):
                continue
            examined += 1
            tmux_name = getattr(session, "tmux_session", None) or (
                getattr(manager, "_hook_tmux_names", None) or {}
            ).get(session_id)
            seed = derive_seed(manager, session_id, tmux_name, now=now)
            store.remember(session_id, seed, now=now)
            if seed.seeds:
                seeded += 1
    except Exception as exc:  # noqa: BLE001 - a warm-up must not break boot
        logger.debug("status_seed_warm_failed", error=str(exc))
    logger.info("status_seed_warm", seeded=seeded, examined=examined)
    return (seeded, examined)
