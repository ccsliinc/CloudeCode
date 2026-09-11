"""The listing pass's expensive PURE READS, gathered off the event loop.

THE DEFECT THIS ADDRESSES. ``SessionManager.list_session_infos`` is an
``async def`` whose body is entirely SYNCHRONOUS, so for as long as it
runs the server does nothing else: it cannot read the tmux pipe carrying
terminal output, cannot spawn the ``send-keys`` that delivers a
keystroke, and cannot answer another request. Measured 2026-09-11 on the
owner's box with 14 live sessions, the app's ``/health`` read p50 74.8 ms
and p99 1262 ms while an idle asyncio server on the same box at the same
instants read p50 1.2 ms and p99 30.7 ms, so the loop is genuinely
blocked and contention is not the cause. ``/health`` measured 211 ms
INSIDE a listing window against 48 ms outside one.

``src/core/config_files_tree_request.py`` and the file drawer's shallow
read are the WORKED EXAMPLE of the fix: the walk moved to
``asyncio.to_thread`` and the loop stopped stalling for its duration.
This is that same move for the listing pass.

WHAT IS IN HERE AND WHAT IS DELIBERATELY NOT. Only PURE READS are
gathered - the one bulk ``tmux list-panes -a`` subprocess, the one
instance-index query, and THREE of the four name-keyed stored-row reads.

THE FOURTH, OWNERSHIP, IS NOT GATHERED, and the reason is a freshness
one rather than a thread-safety one. ``is_owned_tmux_name`` reads the
in-memory ``owned_tmux_sessions`` set and then the datastore, and an
ADOPTION moves ONLY the datastore rung - the adopt path never touches
that set, which is stated in ``adopt_external_session``'s own docstring.
Freeing the loop is what makes an adoption able to land WHILE the gather
runs, so a gathered datastore answer would drop ``created_by_cloude``
off a freshly adopted row for one poll cycle. It costs 4 of the pass's
17 datastore opens at 4 sessions and it stays on the loop.

Every WRITE the pass performs also stays ON THE LOOP, untouched, because
each of them is a read-modify-write against in-memory state the event
loop mutates concurrently from the hook route:

  - ``SessionActivityTracker`` signals (``permission_open`` beside
    ``permission_opened_at``, ``notice_open``, ``subagent_depth``,
    the heartbeat stamps). These are fields of a MUTABLE dataclass that
    the hook endpoint writes, and the set-order and clear-order of the
    permission pair are opposites, so a read taken from a thread can see
    half a transition. Nothing here reads or writes them.
  - ``_unread_epochs`` (``unread_identity.remember`` writes it).
  - the permission-verify and startup-gate ledgers, their
    ``capture-pane`` probes, and the once-per-instance toast claims.
  - the status seed's cache, and the durable
    ``_persist_settled_activity_state`` write.

Moving those needs an APPLY stage that re-validates against state as it
stands at write time, in the manner of ``config_writer.commit``'s fresh
read inside the lock. That is a real refactor of a 400-line function and
it is not attempted here. A PARTIAL, CORRECT IMPROVEMENT BEATS A
COMPLETE, RACY ONE.

THE ONE RULE. A SNAPSHOT IS TAKEN ON THE LOOP AND NOTHING IN THE THREAD
READS LIVE SHARED STATE. ``ListingSnapshot`` is built on the loop from
the live dictionaries; ``ListingReaders`` carries bound methods and
nothing else, so this module's own code cannot reach a live container.

THAT RULE IS A TEST, NOT AN AUDIT, AND THE DIFFERENCE MATTERS. A bound
method carries ``self``, so the signature narrows what THIS module can
reach and narrows nothing about what a reader's own body may grow into.
``tests/test_listing_off_the_loop.py`` therefore wraps the manager's
live containers - ``sessions``, ``backends``, ``_instance_epochs``,
``pinned_themes``, ``_hook_tmux_names`` and ``_activity_tracker`` - in
recorders and drives the REAL ``_listing_readers()`` bundle through
``asyncio.to_thread``, failing if any of them is touched off the main
thread. An audit of six function bodies rots the first time one is
edited; that test does not.

THE TWO SHARED READS THE AUDITED READER BODIES STILL MAKE, NAMED RATHER
THAN HIDDEN. ``_tmux_socket_name`` reads the ``_last_probe_socket``
attribute, and ``build_backend`` reads ``settings``' cached
``AuthConfig``. Both are SINGLE ATOMIC REFERENCE READS of an immutable
value under the GIL, so neither can be observed half-written; the worst
case is reading the previous socket name, which in production is the
same string, or re-parsing a config that was being re-cached. Neither is
a torn read and neither is a container being mutated under an iterator,
which is the hazard this split exists to avoid.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence, Tuple

import structlog

from src.core.listing_prefetch import ListingPrefetch, build_listing_prefetch

logger = structlog.get_logger()


@dataclass(frozen=True)
class ListingSnapshot:
    """Everything the gather needs from live state, copied on the loop.

    Description: taken BEFORE the thread starts, from the manager's live
      dictionaries, and immutable thereafter. A thread that reads a live
      dict while the loop mutates it is the defect this split removes, so
      the snapshot is the boundary: past this point the thread sees only
      tuples and strings.
    Inputs: socket (str) - the tmux socket the stored rows are keyed on.
      seed_candidate_names (tuple[str, ...]) - the names whose stored row
      the status seed could actually reach, already filtered by
      ``hooks_seen``; empty means no index connection is opened at all.
      decorated_names (tuple[str, ...]) - every tmux name this pass will
      decorate, which is a SUPERSET of the seed candidates.
    Output: an immutable snapshot.
    Example: ListingSnapshot(socket='cloude',
      seed_candidate_names=('cloude_a',), decorated_names=('cloude_a',))
    """

    socket: str
    seed_candidate_names: Tuple[str, ...] = ()
    decorated_names: Tuple[str, ...] = ()


@dataclass(frozen=True)
class ListingReaders:
    """The manager's pure readers, handed to the thread as bare callables.

    Description: the thread is given FUNCTIONS, never the manager, so the
      gather body has no route to a live container. Every one of these
      was audited as a pure read: it opens its own SQLite connection or
      spawns its own subprocess, uses it, closes it, and returns a value
      without touching shared mutable state.
    Inputs: build_status_map (callable) - one bulk ``list-panes -a``.
      build_instance_index (callable taking socket and names) - one
      triple-keyed query on one connection.
      label_for_name / identity_for_live_name / restored_activity_state
      (callables taking a tmux name) - the three name-keyed row reads.
      The ownership read is NOT here; see the module docstring for the
      adoption window that keeps it on the loop.
    Output: an immutable bundle.
    Example: ListingReaders(build_status_map=mgr._build_tmux_status_map,
      ...)
    """

    build_status_map: Callable[[], Any]
    build_instance_index: Callable[..., Any]
    label_for_name: Callable[[Optional[str]], Optional[str]]
    identity_for_live_name: Callable[[Optional[str]], Optional[dict]]
    restored_activity_state: Callable[[Optional[str]], Optional[str]]


@dataclass(frozen=True)
class ListingGather:
    """The gathered inputs one listing pass builds its rows from.

    Inputs: status_map - the bulk tmux listing, carrying its own
      ``complete`` flag and the socket it was taken from.
      instance_index - the triple-keyed stored-row index, carrying its
      own ``complete`` flag.
      prefetch (ListingPrefetch) - the name-keyed decorations.
      elapsed_ms (float) - how long the gather took, for the one log
      line; it is diagnostic only and nothing branches on it.
    Output: an immutable bundle consumed by the per-row loop.
    Example: gather.status_map.get('cloude_a')
    """

    status_map: Any
    instance_index: Any
    prefetch: ListingPrefetch
    elapsed_ms: float = 0.0


def gather_listing_inputs(
    readers: ListingReaders, snapshot: ListingSnapshot
) -> ListingGather:
    """Run every expensive pure read for one listing pass. THREAD BODY.

    Description: this is the function handed to ``asyncio.to_thread``. It
      reads ONLY its two arguments, so the "nothing in the thread reads
      live shared state" rule is a property of the signature rather than
      of remembering. The reads are sequential, not parallel: the goal is
      a FREE EVENT LOOP, not a faster pass, and one thread keeps the
      syscall count and the SQLite concurrency identical to what the
      synchronous pass already did.

      IT NEVER RAISES. Each reader already answers an honest empty value
      on failure - an unavailable tmux probe yields an empty
      ``StatusMap`` whose ``complete`` is False, an unopenable datastore
      yields an empty index and None decorations - and every one of those
      is exactly what the per-row caller saw before. A failure that got
      past them would propagate to ``await``, which is the same place the
      synchronous body would have raised from, so error handling is not
      changed by the move either.
    Inputs: readers (ListingReaders). snapshot (ListingSnapshot).
    Output: ListingGather.
    Example: gather_listing_inputs(mgr._listing_readers(), snap)
    """
    started = time.perf_counter()
    status_map = readers.build_status_map()
    instance_index = readers.build_instance_index(
        socket=snapshot.socket, names=list(snapshot.seed_candidate_names)
    )
    prefetch = build_listing_prefetch(
        names=snapshot.decorated_names,
        label_for_name=readers.label_for_name,
        identity_for_live_name=readers.identity_for_live_name,
        restored_activity_state=readers.restored_activity_state,
    )
    return ListingGather(
        status_map=status_map,
        instance_index=instance_index,
        prefetch=prefetch,
        elapsed_ms=(time.perf_counter() - started) * 1000.0,
    )


def log_gather(gather: ListingGather, names: Sequence[str]) -> None:
    """Record one line about a completed gather. Diagnostic only.

    Description: the cost of this pass has been re-measured four times in
      this project's history and each time the number had to be produced
      from scratch. This makes it readable from the logs instead. Nothing
      branches on it.
    Inputs: gather (ListingGather). names (sequence[str]) - the names the
      prefetch was built over, for the per-name cost.
    Output: None.
    Example: log_gather(gather, snapshot.decorated_names)
    """
    logger.debug(
        "listing_gather_complete",
        elapsed_ms=round(gather.elapsed_ms, 2),
        names=len(names),
        status_map_complete=bool(getattr(gather.status_map, "complete", False)),
        prefetched=len(gather.prefetch.by_name),
    )
