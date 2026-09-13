"""The composition site for the attention watcher: where it is actually built.

WHY THIS FILE EXISTS AT ALL. Everything under ``src/core/attention/`` is
deliberately unable to reach the application: the package may not import
``session_manager``, so the watcher takes its target list, its evidence
reader and its three actions as constructor arguments and can be driven
by the replay suite with no server, no files and no clock. That is the
right shape for the logic and it leaves exactly one thing undone, which
is the thing this module does: SOMEBODY HAS TO PASS THE REAL ONES IN. A
watcher nothing constructs is a class with a docstring, and until this
module was called from ``lifespan`` the seven jobs the deleted hook route
used to carry had no trigger in a running server.

THE READERS ARE THE LISTING'S OWN, NOT A SECOND SET. ``/sessions/list``
and the watcher must never disagree about one session, and the only way
to guarantee that is for both to read the same evidence and hand it to
the same pure resolver. So the two file-backed tiers come from
``SessionManager._attention_reads_for``, which is the same live
fall-through the listing takes for a single-session caller, and tmux
liveness is resolved by ``resolve_listing_liveness`` from the same bulk
``list-panes -a`` map the listing builds. Nothing here parses a registry
file or a transcript itself.

ONE SUBPROCESS PER TICK, NOT ONE PER SESSION. The bulk tmux listing is
memoised on the tick's own instant, which the watcher hands to every
reader in a pass, so a pass of fourteen sessions costs one ``list-panes``
and not fourteen. Keying it on the instant rather than on a timer is
exact: a new instant IS a new pass, and two passes can never share a map.

THE PANE TIER IS NEVER FILLED IN HERE, AND THAT IS DELIBERATE. Reading
pane text means ``capture-pane``, a subprocess per session per tick, and
the resolver's contract says ``pane=None`` means WE DID NOT LOOK rather
than THE SCREEN WAS CLEAR. The listing pass fills it in for the rare
session whose permission claim is being re-verified, which is a capture
it was already paying for; the watcher pays for none.

THE AGENT FAMILY IS ``None`` FOR THE SAME REASON. This pass reads no
family, and ``None`` is the resolver's word for "not determined", which
rule (e) sends down the full ladder because a registry record joined by
tmux name and cwd is itself proof a claude registered the pane. Passing a
guess would be a claim about provenance that was never measured.

RAISING IS THIS SIDE OF THE HOUSE, DISPLAY IS THE LISTING'S. Both call
``resolve_attention``; only the watcher owns an
:class:`~src.core.attention.ledger.AttentionLedger`, and an edge exists
only where a ledger records one. The listing resolves for paint and holds
no ledger at all, so a transition cannot be raised twice by the two of
them, and ONE watcher is built per process so it cannot be raised twice
by two ledgers either.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, Awaitable, Callable, List, Optional, Sequence, Tuple

import structlog

from src.core import session_change_notice
from src.core.attention.display import to_display
from src.core.attention.evidence import Evidence
from src.core.attention.ledger import AttentionLedger, Transition
from src.core.attention.side_effects import AttentionSideEffects
from src.core.attention.watcher import (
    DEFAULT_TICK_SECONDS,
    AttentionWatcher,
    WatchTarget,
)
from src.core.hook_event_presentation import hook_event_presentation
from src.core.session_status import STATUS_UNKNOWN, resolve_listing_liveness
from src.core.session_status_map import listing_proves_alive
from src.core.unread_store import UnreadStore
from src.models import SessionRenamedMessage, ToastAckMessage, ToastNewMessage

logger = structlog.get_logger()


class AttentionEvidenceReader:
    """One session's four tiers, read off the event loop. NEVER RAISES here.

    Description: the watcher's ``read_evidence`` in production. It is a
      class rather than a closure for one reason: the bulk tmux listing
      has to be taken ONCE per pass and shared by every target in it, and
      that needs somewhere to put the memo. The key is the pass's own
      instant, which the watcher hands to every reader in a pass, so a
      new instant is a new pass by construction.

      A failure is still the watcher's to log: ``_read_all`` catches per
      target and answers None, which the caller skips. This returns None
      itself only when there is no tmux name to read anything about,
      which is a session that cannot be looked up rather than a failure.
    Inputs: see :meth:`__init__`.
    Output: a callable with the watcher's ``read_evidence`` signature.
    Example:
        reader = AttentionEvidenceReader(manager, effects.instance_for)
        evidence = reader(target, now)
    """

    def __init__(
        self,
        manager: Any,
        instance_for: Callable[[str], Tuple[Optional[str], Optional[int]]],
    ) -> None:
        """Bind the reader to a manager and the one instance lookup.

        Inputs:
          manager: the live ``SessionManager``. Typed ``Any`` so this
            module imports nothing from it and cannot close a cycle.
          instance_for: resolves a session id to (tmux name, epoch). The
            side-effect layer's own lookup, passed in rather than
            re-spelled, so the watcher and the side effects can never
            file one pane under two identities.
        Output: None.
        Example: AttentionEvidenceReader(mgr, effects.instance_for)
        """
        self._manager = manager
        self._instance_for = instance_for
        self._pass_at: Optional[datetime] = None
        self._status_map: Any = None

    def __call__(
        self, target: WatchTarget, now: datetime
    ) -> Optional[Evidence]:
        """Assemble one session's evidence bundle. RUNS IN A WORKER THREAD.

        Description: the two file tiers come from the listing's own live
          reader; tmux liveness comes from the pass's bulk listing; the
          pane tier and the agent family are left unstated, which the
          resolver reads as "we did not look" rather than as an answer.
        Inputs: target (WatchTarget), now (datetime) - the pass's instant,
          aware UTC, which also keys the bulk-listing memo.
        Output: Evidence | None - None when this session has no tmux name.
        Example: reader(target, now).registry.known -> True
        """
        tmux_name, epoch = self._instance_for(target.session_id)
        if not tmux_name:
            return None
        registry, transcript = self._manager._attention_reads_for(
            session_id=target.session_id,
            tmux_name=tmux_name,
            epoch=epoch,
        )
        return Evidence(
            tmux_liveness=self._liveness(target.session_id, tmux_name, now),
            agent_family=None,
            registry=registry,
            transcript=transcript,
            pane=None,
            now=now,
        )

    def _liveness(
        self, session_id: str, tmux_name: str, now: datetime
    ) -> str:
        """This pane's ``LIVENESS_*`` verdict, off the pass's bulk listing.

        Description: THE LISTING'S NEGATIVE IS NOT TRUSTED, which is the
          rule ``listing_proves_alive`` carries: a name the map does not
          prove is "this listing does not establish it" and never "it is
          gone", so ``exists`` is True or None and never False. The one
          road to ``gone`` here is therefore the measured one - a
          complete listing from this backend's own socket that NAMES the
          session and reports its pane dead.
        Inputs: session_id (str), tmux_name (str), now (datetime) - the
          pass instant, which keys the memo.
        Output: str - a ``LIVENESS_*`` value.
        Example: reader._liveness('ses_1', 'cloude_a', now) -> 'live'
        """
        status_map = self._status_map_for(now)
        backend = self._manager._registry.backends.get(session_id)
        proved = listing_proves_alive(
            status_map,
            tmux_name,
            backend_socket=getattr(backend, "socket_name", None),
        )
        row = status_map.get(tmux_name) if hasattr(status_map, "get") else None
        return resolve_listing_liveness(
            exists=True if proved else None,
            pane_status=row["status"] if row else None,
        )

    def _status_map_for(self, now: datetime) -> Any:
        """The bulk tmux listing for this pass, taken at most once.

        Description: ONE ``list-panes -a`` PER TICK. ``_build_tmux_status_map``
          degrades to an empty, incomplete map rather than raising, and an
          incomplete map proves nothing, so a tmux that could not be
          reached costs every session an ``unknown`` liveness and never a
          false answer in either direction.
        Inputs: now (datetime) - the pass instant.
        Output: the ``StatusMap`` for this pass.
        Example: reader._status_map_for(now).complete -> True
        """
        if self._status_map is None or self._pass_at != now:
            self._status_map = self._manager._build_tmux_status_map()
            self._pass_at = now
        return self._status_map


def build_attention_watcher(
    manager: Any,
    *,
    app_state: Any = None,
    broadcast: Optional[Callable[[str, str], Awaitable[Any]]] = None,
    tick_seconds: float = DEFAULT_TICK_SECONDS,
) -> AttentionWatcher:
    """Build the one watcher this process runs, fully wired. Starts nothing.

    Description: constructs the ledger, the side-effect adapter and the
      four injected callables, and hands them to
      :class:`~src.core.attention.watcher.AttentionWatcher`. The caller
      creates the task, which keeps "what exists" and "what is running"
      separate and lets a test build a production-shaped watcher and
      drive exactly one tick.

      THE SIDE EFFECTS ARE WIRED HERE OR THEY ARE NOT WIRED AT ALL.
      ``on_observation`` is optional on the watcher because the replay
      suite drives it unpassed; leaving it unpassed in a server would
      silently orphan five of the seven jobs the hook route used to
      carry, ``sessions.last_work_at`` among them, and nothing would
      report it.
    Inputs:
      manager: the live ``SessionManager``.
      app_state: ``app.state``, for the ``/ws/events`` fan-out. None
        publishes no notice, which costs a browser its early update and
        never costs correctness: the five second poll is untouched.
      broadcast: ``connection_manager.broadcast_to_session``, an async
        (session id, payload) sender. None sends no frame; the database
        still changes.
      tick_seconds: the backstop interval.
    Output: AttentionWatcher - built, not running.
    Example:
        watcher = build_attention_watcher(mgr, app_state=app.state)
        task = asyncio.create_task(watcher.run())
    """
    send = _sync_sender(broadcast)

    effects = AttentionSideEffects(
        manager,
        broadcast_toast_ack=lambda session_id, toast_id: send(
            session_id, ToastAckMessage(toast_id=toast_id).model_dump_json()
        ),
        broadcast_rename=lambda session_id, new_name: send(
            session_id,
            SessionRenamedMessage(
                session_id=session_id, new_name=new_name
            ).model_dump_json(),
        ),
    )
    read_evidence = AttentionEvidenceReader(manager, effects.instance_for)

    def list_targets() -> Sequence[WatchTarget]:
        """Every live session, named by row id and by instance key.

        Description: runs ON THE EVENT LOOP, so it is dict reads and
          nothing else. A session with no resolvable tmux name is skipped
          rather than given a key built out of a None, because the key IS
          the instance and an invented one files a flag under a pane that
          does not exist (gotchas 4b and 10).
        Inputs: none.
        Output: sequence of WatchTarget.
        Example: list_targets() -> [WatchTarget('ses_1', 'cloude_a@1')]
        """
        targets: List[WatchTarget] = []
        for session_id in list(manager._registry.sessions.keys()):
            tmux_name, epoch = effects.instance_for(session_id)
            if not tmux_name:
                continue
            targets.append(
                WatchTarget(
                    session_id=session_id,
                    key=UnreadStore.compose_key(tmux_name, epoch),
                )
            )
        return targets

    def raise_toast(
        target: WatchTarget, kind: str, transition: Transition
    ) -> None:
        """Record one toast and put it on both wires. The ONLY raise site.

        Description: the copy comes from ``hook_event_presentation``, the
          same pure function the deleted route used, so the words the
          user reads did not change when the trigger did. The payload is
          empty because there is no hook payload any more, and the body
          falls through to the verdict's own sentence, which names the
          rung that decided - strictly more than the generic copy it
          replaces.

          A ``record_toast`` that refuses is a session that went away
          between the tick's listing and its write. It raises
          ``ValueError``, the watcher's ``_call`` logs it, and the next
          tick has a shorter target list.
        Inputs: target (WatchTarget), kind (str) - a toast kind,
          transition (Transition).
        Output: None.
        Example: raise_toast(target, 'Stop', transition)
        """
        title, body = hook_event_presentation(kind, {})
        toast = manager.record_toast(
            session_id=target.session_id,
            kind=kind,
            title=title,
            body=body or transition.verdict.detail or None,
        )
        payload = ToastNewMessage(toast=toast).model_dump_json()
        send(target.session_id, payload)
        # AND THE SAME CARD ONTO THE PER-BROWSER CHANNEL, so a client
        # holding no terminal socket for this session still sees it. Same
        # frame shape, so the client keeps one handler and not two.
        session_change_notice.publish(app_state, json.loads(payload))
        # THE LIGHT MOVED, SO SAY SO WITHOUT WAITING FOR THE POLL. The
        # status is projected from the verdict that just raised, not
        # re-resolved, which is what keeps this notice and the next
        # /sessions/list row from describing one session two ways.
        session_change_notice.publish_attention_status(
            app_state,
            manager,
            target.session_id,
            activity_status=to_display(
                transition.verdict, unread=False, tmux_status=STATUS_UNKNOWN
            ),
        )

    # THE MUTE GATE IS SWITCHED ON BY THE PRESENCE OF A READER, NOT BY
    # WHAT THE READER SAYS, and getting that backwards silences the
    # product. ``AttentionWatcher._policy_attached`` answers "is a store
    # attached" with "was a read_policy injected", and an attached gate
    # with nothing to read SUPPRESSES, because the user who asked for
    # silence must not be overruled by a failed read. So a manager with
    # no policy store is passed NO READER AT ALL, which is the documented
    # "build without the feature" shape and raises everything; passing a
    # reader that politely reports "no store" would mute every session on
    # the machine, permanently, with only an info line to show for it.
    #
    # In ``lifespan`` the store is attached well before this is called,
    # so the production path always takes the reader.
    policy_store = getattr(manager, "_notification_policy_store", None)

    def read_policy(target: WatchTarget) -> Tuple[bool, Any]:
        """This session's resolved mute policy.

        Description: the store is known to be attached (see above), so
          the pair's first element is True and a None policy means the
          read did not answer - which the gate suppresses on, by the
          rule that silence asked for in advance is not overturned by a
          failure to confirm it.
        Inputs: target (WatchTarget).
        Output: (True, policy | None).
        Example: read_policy(target) -> (True, verdict)
        """
        return (True, manager.notification_policy_stamp(target.session_id))

    return AttentionWatcher(
        list_targets=list_targets,
        read_evidence=read_evidence,
        raise_toast=raise_toast,
        set_unread=effects.set_unread,
        on_busy_edge=effects.on_busy_edge,
        on_observation=effects.on_observation,
        read_policy=read_policy if policy_store is not None else None,
        ledger=AttentionLedger(),
        tick_seconds=tick_seconds,
    )


def _sync_sender(
    broadcast: Optional[Callable[[str, str], Awaitable[Any]]],
) -> Callable[[str, str], None]:
    """Wrap an async broadcaster as the synchronous call the watcher makes.

    Description: the watcher calls its actions synchronously on the event
      loop, so the fan-out is scheduled rather than awaited. THE TASK IS
      HELD, because asyncio keeps only a weak reference to a bare task
      and a garbage collected one cancels mid-send. Its failure is logged
      rather than left as an unretrieved exception on loop teardown.

      A missing loop is not an error worth a toast. This is also called
      from tests and from any context with no loop running, where the
      frame is dropped with a debug line and the record still stands.
    Inputs: broadcast (async callable | None) - None sends nothing.
    Output: a synchronous (session id, payload) callable.
    Example: _sync_sender(None)('ses_1', '{}')
    """
    pending: set = set()

    def settle(task: "asyncio.Task") -> None:
        pending.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.warning(
                "attention_broadcast_failed",
                error=str(exc),
                error_type=type(exc).__name__,
            )

    def send(session_id: str, payload: str) -> None:
        if broadcast is None:
            return
        try:
            task = asyncio.ensure_future(broadcast(session_id, payload))
        except RuntimeError as exc:
            logger.debug(
                "attention_broadcast_unscheduled",
                session_id=session_id,
                error=str(exc),
            )
            return
        pending.add(task)
        task.add_done_callback(settle)

    return send
