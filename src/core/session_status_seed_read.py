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

A CACHED REFUSAL IS NOT PERMANENT. MEASURED on live boot 2026-09-08: a
boot race left one session's epoch unset (see
``session_boot_readopt._record_epoch_for_already_registered``), so its
first seed attempt read "this session's exact tmux instance could not be
identified" and ``seed_live_sessions`` cached that refusal - correctly,
at the time. ``SessionStatusSeeds.due`` now keys its cache on the epoch
each reading was taken against, not only on age: a refusal cached with no
epoch is due again the instant a caller supplies one, rather than waiting
out a full ``SEED_REFRESH_INTERVAL_SECONDS`` on grounds that were never
the reason it failed. And every swallow in this module that used to log
at ``debug`` now logs at ``warning`` with the session id and the
exception's type name - this server emits no debug lines in production,
so a debug-only failure here was invisible by construction, which is
exactly how the boot-race refusal above went unnoticed until it was
traced by hand.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from weakref import WeakKeyDictionary

import structlog

from src.core.session_status_seed import (
    SEED_RUNG_NONE,
    StatusSeed,
    TranscriptRest,
    display_state,
    resolve_status_seed,
)
from src.core.session_status_seed_store import SessionStatusSeeds
from src.core.session_status_source import (
    STATUS_SOURCE_NONE,
    source_for_seed_rung,
)
from src.core.session_transcript_status_read import (
    read_transcript_signal,
    transcript_status_for,
)

logger = structlog.get_logger(__name__)

#: One seed store per SessionManager. See the module docstring for why it
#: is keyed weakly here rather than assigned in that class's ``__init__``.
_STORES: "WeakKeyDictionary[Any, SessionStatusSeeds]" = WeakKeyDictionary()

#: Every error this module's reads and its two callers can raise, named
#: rather than caught blanket - see code-standards.md's ban on bare
#: ``except Exception``. ``sqlite3.Error`` and ``OSError`` cover the two
#: I/O boundaries (the instance row query, the transcript scan and tail
#: read); ``ValueError``/``KeyError`` cover a malformed row or tail record
#: surfacing while it is turned into a seed. Anything outside this set is
#: a real defect and must be allowed to propagate, not be swallowed
#: alongside the reads this module is actually built to tolerate.
_SEED_READ_ERRORS: Tuple[type, ...] = (sqlite3.Error, OSError, ValueError, KeyError)


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
    uuid: Optional[str],
    working_dir: Optional[str],
    *,
    session_id: Optional[str] = None,
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
      session_id (str | None) - for the failure log only; this function
      never uses it to look anything up.
    Output: TranscriptRest.
    Example: read_transcript_rest(uuid, '/Users/x/proj').verdict
    """
    return read_transcript_signal(
        uuid, working_dir, session_id=session_id
    ).tail


def read_instance_row(
    manager: Any,
    tmux_name: Optional[str],
    epoch: Optional[int],
    *,
    session_id: Optional[str] = None,
    index: Optional[Any] = None,
) -> Optional[Dict[str, Any]]:
    """The four columns the ladder needs, off ONE instance's row.

    Description: keyed on the full triple, never on the name alone - see
      the module docstring. Returns None for every cannot-determine: no
      name, no epoch, no datastore, no matching row, or a failed query.
      A None is not an empty row; the caller seeds nothing either way,
      but the reason is logged rather than invented. A ``None`` returned
      because ``epoch`` was ``None`` is NOT logged - that is the normal,
      frequent shape of "this session's instance is not known yet", not a
      failure, and it would drown the warning below in noise.
    Inputs: manager (SessionManager). tmux_name (str | None). epoch
      (int | None) - ``#{session_created}`` for the exact instance.
      session_id (str | None) - for the failure log only. index
      (InstanceIndex | None) - the pass's bulk read, used ONLY when it
      reports ``complete``; otherwise this falls through to the per-row
      connection below, which is what every caller had before it existed.
    Output: dict | None - ``activity_state``, ``activity_state_at``,
      ``claude_session_uuid``, ``working_dir``.
    Example: read_instance_row(mgr, 'cloude_Mac', 1788463220)
    """
    if not tmux_name or epoch is None:
        return None
    # THE BULK READ, WHEN THE CALLER TOOK ONE, and only when it reports
    # ``complete`` - a False there means nothing was LOOKED AT, and a
    # None off a reading that never ran would refuse the seed for the
    # whole pass. See ``session_instance_index``'s module docstring.
    if index is not None and getattr(index, "complete", False):
        return index.seed_row(tmux_name, epoch)
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
    except _SEED_READ_ERRORS as exc:
        # A read must not break a listing, but a repeated failure here
        # was previously invisible (debug-only, and this server emits no
        # debug lines) - see the module docstring's cache section.
        logger.warning(
            "status_seed_row_read_failed",
            session_id=session_id,
            tmux_name=tmux_name,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001 - closing a read handle
                pass


def _resolve_epoch(
    manager: Any, session_id: str, epoch: Optional[int]
) -> Optional[int]:
    """The epoch to key one session's instance reads on.

    Description: shared by every function in this module that needs an
      epoch, so an explicit caller-supplied value and the manager's own
      cache can never be resolved two different ways in two different
      places. An explicit value always wins - it was measured at the
      moment of this call (typically a fresh tmux listing) - and
      ``_instance_epochs`` is consulted only when the caller has none to
      offer.
    Inputs: manager (SessionManager). session_id (str). epoch
      (int | None) - an already-known epoch, or None to look one up.
    Output: int | None.
    Example: _resolve_epoch(mgr, 'ses_1', None)
    """
    if epoch is not None:
        return epoch
    return (getattr(manager, "_instance_epochs", None) or {}).get(session_id)


def derive_seed(
    manager: Any,
    session_id: str,
    tmux_name: Optional[str],
    *,
    epoch: Optional[int] = None,
    unread: bool = False,
    now: Optional[datetime] = None,
    index: Optional[Any] = None,
) -> StatusSeed:
    """Run the whole ladder for one session and return what it supports.

    Description: does the reads and hands them to the PURE
      ``resolve_status_seed``. Never raises. A session whose instance row
      cannot be identified gets a refusal naming that, not a seed built
      on a row that might belong to a different pane of the same name.

      ONE PRESENCE RESOLUTION, TWO MEASUREMENTS. The transcript is
      located once and both its mtime and its tail come off that path
      (``read_transcript_signal``), because resolving a uuid to a file is
      the only real cost on this path and doing it twice per poll would
      double it for nothing.

      The mtime and the tail then go through
      ``session_transcript_status`` as rung 0 - the only rung that
      measures the present, the only one that may claim ``working``, and
      the only one that may set an unread flag. It is reached ONLY here,
      which is to say only for a session with no live hook signal,
      because the seam that calls this refuses any session whose hooks
      have spoken.
    Inputs: manager (SessionManager). session_id (str). tmux_name
      (str | None). epoch (int | None) - defaults to the manager's
      recorded epoch for this session. unread (bool) - the session's
      persisted flag, read by rung 0 and written only when a NEW turn
      end is measured. now (datetime | None). index (InstanceIndex |
      None) - the pass's bulk row read, used only when ``complete``.
    Output: StatusSeed - ``seeds`` is False whenever no rung answered.
    Example: derive_seed(mgr, 'ses_5a756046', 'cloude_Punchlist').state
    """
    epoch = _resolve_epoch(manager, session_id, epoch)
    stamp = now or datetime.now(timezone.utc)

    row = read_instance_row(
        manager, tmux_name, epoch, session_id=session_id, index=index
    )
    if row is None:
        return StatusSeed(
            rung=SEED_RUNG_NONE,
            detail=(
                "this session's exact tmux instance could not be "
                "identified, so no row and no transcript were consulted"
            ),
        )

    reading = read_transcript_signal(
        row.get("claude_session_uuid"),
        row.get("working_dir"),
        session_id=session_id,
    )
    live = transcript_status_for(
        manager,
        session_id=session_id,
        tmux_name=tmux_name,
        epoch=epoch,
        reading=reading,
        unread=unread,
        now=stamp,
    )
    return resolve_status_seed(
        row_state=row.get("activity_state"),
        row_state_at=row.get("activity_state_at"),
        tail=reading.tail,
        live=live,
        now=stamp,
    )


def seeded_status(
    manager: Any,
    session_id: str,
    tmux_name: Optional[str],
    *,
    epoch: Optional[int] = None,
    unread: bool = False,
    now: Optional[datetime] = None,
    index: Optional[Any] = None,
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
      (str | None). epoch (int | None). unread (bool) - the persisted
      flag; read by the display and by rung 0, which is the ONLY thing
      here that may write one. now. index - the pass's bulk row read.
    Output: str | None - an activity status, or None for "nothing seeded".
    Example: seeded_status(mgr, sid, name, unread=False) -> 'idle'
    """
    return seeded_display(
        manager,
        session_id,
        tmux_name,
        epoch=epoch,
        unread=unread,
        now=now,
        index=index,
    )[0]


def seeded_display(
    manager: Any,
    session_id: str,
    tmux_name: Optional[str],
    *,
    epoch: Optional[int] = None,
    unread: bool = False,
    now: Optional[datetime] = None,
    index: Optional[Any] = None,
) -> Tuple[Optional[str], str]:
    """The seeded status AND the provenance to report for it.

    Description: THE SEAM. Same work ``seeded_status`` describes; it
      returns the pair so a caller does not have to ask twice and cannot
      get a status from one call and a source from another that no longer
      agrees with it. THE SOURCE IS DERIVED FROM THE RUNG THAT ANSWERED,
      never from what the caller believed, so the two can only ever
      travel together.

      Re-derives at most once per
      ``session_status_seed.SEED_REFRESH_INTERVAL_SECONDS`` per session
      and serves the cached reading in between, so a listing that polls
      every few seconds costs one bounded tail read a minute per hookless
      session. It is the CALLER's job to have established that this
      session has no live hook signal; a hook outranks a seed and this
      function is never reached once one has landed.

      A seed that has EXPIRED renders as no answer, and its source is
      reported as ``none`` for the same reason: nothing currently
      supports a status, so nothing may be credited with supporting one.
    Inputs: as ``seeded_status``, ``index`` included: the ONE row read
      the pass took for every session in it, and what keeps this seam
      from opening a SQLite connection per session. Omitting it costs
      exactly what it cost before.
    Output: tuple[str | None, str] - the status (or None) and one of
      ``session_status_source.ALL_STATUS_SOURCES``.
    Example: seeded_display(mgr, sid, name) -> ('idle', 'transcript')
    """
    try:
        store = seeds_for(manager)
        stamp = now or datetime.now(timezone.utc)
        resolved_epoch = _resolve_epoch(manager, session_id, epoch)
        if store.due(session_id, now=stamp, epoch=resolved_epoch):
            seed = derive_seed(
                manager,
                session_id,
                tmux_name,
                epoch=resolved_epoch,
                unread=unread,
                now=stamp,
                index=index,
            )
            store.remember(session_id, seed, now=stamp, epoch=resolved_epoch)
        else:
            seed = store.get(session_id) or StatusSeed()
        state = display_state(seed, unread=unread, now=stamp)
        if state is None:
            return (None, STATUS_SOURCE_NONE)
        return (state, source_for_seed_rung(seed.rung))
    except _SEED_READ_ERRORS as exc:
        # A status must not break a listing, but a repeated failure here
        # was previously invisible (debug-only, and this server emits no
        # debug lines) - see the module docstring's cache section.
        logger.warning(
            "status_seed_failed",
            session_id=session_id,
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return (None, STATUS_SOURCE_NONE)


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
        sessions = dict(manager._registry.sessions)
        store = seeds_for(manager)
        store.prune(sessions.keys())
        tracker = getattr(manager, "_activity_tracker", None)
        now = datetime.now(timezone.utc)
    except _SEED_READ_ERRORS as exc:
        logger.warning(
            "status_seed_warm_setup_failed",
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return (0, 0)

    # ONE BAD SESSION MUST NOT COST THE WHOLE FLEET ITS WARM-UP. The
    # try/except above guards setup; this one is per session, so a read
    # that fails for session 3 of 19 still lets 4 through 19 seed.
    for session_id, session in sessions.items():
        try:
            if tracker is not None and tracker.hooks_seen(session_id):
                continue
            examined += 1
            tmux_name = getattr(session, "tmux_session", None) or (
                getattr(manager, "_hook_tmux_names", None) or {}
            ).get(session_id)
            resolved_epoch = _resolve_epoch(manager, session_id, None)
            seed = derive_seed(
                manager, session_id, tmux_name, epoch=resolved_epoch, now=now
            )
            store.remember(session_id, seed, now=now, epoch=resolved_epoch)
            if seed.seeds:
                seeded += 1
        except _SEED_READ_ERRORS as exc:
            # Debug-only visibility was the whole reason the PT-IMC
            # refusal went unnoticed - see the module docstring.
            logger.warning(
                "status_seed_warm_one_failed",
                session_id=session_id,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            continue
    logger.info("status_seed_warm", seeded=seeded, examined=examined)
    return (seeded, examined)
