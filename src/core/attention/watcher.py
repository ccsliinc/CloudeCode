"""The one task that raises toasts, and the only thing that ever does.

ONE SERVER-OWNED ASYNCIO TASK. It lists the sessions worth watching,
reads their evidence off the loop, resolves each one through the pure
resolver, hands the answer to the ledger, and acts on whatever comes back
as an edge. The listing pass calls the SAME resolver for display and
raises nothing, which is how ``/sessions/list`` is stopped from ever
disagreeing with the toasts. A phone with no browser open still gets its
push, because the watcher raises, not a poll.

TESTABLE WITHOUT A SERVER, AND THAT IS A CONSTRAINT, NOT A CONVENIENCE.
Everything this class touches arrives through the constructor: the
target list, the evidence reader, the three actions, the ledger and the
clock. Nothing in ``src/core/attention/`` may import ``session_manager``,
so the watcher cannot reach for a session, a policy or a toast inbox
directly, and the replay suite drives years of recorded history through
it in milliseconds with no files and no sleeping.

THE LOOP MAY NOT DIE. A watcher that raises out of its own tick takes
every notification on the machine with it, silently, until the next
restart. So a failure reading ONE session is caught around that session
and the rest of the tick continues, and a failure anywhere else in the
tick is caught around the tick and the loop continues. Both are logged
with the event name first. ``asyncio.CancelledError`` is re-raised
before either, because shutdown is not a failure.

THE CADENCE IS A TICK WITH AN EARLY WAKE, NOT A POLL. The backstop tick
is :data:`DEFAULT_TICK_SECONDS`, and on top of it the EXISTING
``PipeWaiter`` (``src/core/pipe_wakeup.py``, kqueue on asyncio's own
selector, no thread spent) watches ``~/.claude/sessions/`` so a session
appearing or disappearing wakes the loop in microseconds rather than at
the end of the interval.

WHAT WAS VERIFIED ABOUT THAT DIRECTORY, because the plan asked, AND
HOW. Read out of the Claude Code 2.1.266 bundle: the registry updater
``Tn``, chained on ``pidFileWriteChain``, reads the existing
``<pid>.json``, merges the changed keys and writes the SAME PATH back,
and the storage-interface branch of that same function spells the
discipline out as ``publishDiscipline: "inPlace"``. The inode check that
would have confirmed it from the outside did NOT get a sample: across
about two and a half minutes of watching every file in the directory at
200 ms, no session changed status, so nothing was written at all. The
claim therefore rests on the binary, and it is stated that way rather
than as a measurement. A status change is an IN-PLACE REWRITE: the inode
does not change and the containing directory is not modified, which
means a directory watch does NOT see it. The directory watch therefore
covers registration and exit (create, unlink, rename) and THE TICK IS
WHAT COVERS A STATUS
CHANGE. That is the right trade for this loop: the tick is two seconds,
the toast it gates is a human-facing notification, and watching every
registry file individually would cost a kqueue descriptor per session to
buy less than two seconds on a notification a human reads at their own
pace. The plan's note that the tick is the backstop "either way" is why
this is a sizing decision and not a correctness one.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, List, Optional, Sequence, Set, Tuple

import structlog

from src.core.attention.evidence import (
    AttentionVerdict,
    Evidence,
    REASON_INPUT,
    STATE_BUSY,
    STATE_DONE_IDLE,
    STATE_NEEDS_USER,
)
from src.core.attention.ledger import AttentionLedger, Transition
from src.core.attention.raise_gate import resolve_raise
from src.core.attention.registry_read import default_registry_directory
from src.core.attention.resolve import resolve_attention
from src.core.pipe_wakeup import PipeWaiter
from src.core.session_activity import (
    EVENT_NOTIFICATION,
    EVENT_PERMISSION_REQUEST,
    EVENT_STOP,
)

logger = structlog.get_logger()

#: The backstop interval. Every session is read at least this often even
#: if no early wake ever fires.
DEFAULT_TICK_SECONDS: float = 2.0


@dataclass(frozen=True)
class WatchTarget:
    """One session the watcher is responsible for, named two ways.

    Description: deliberately the smallest thing that identifies a
      session to both halves of the system. The injected reader and the
      injected actions close over whatever else they need; putting a
      transcript path or a tmux name here would make the watcher care
      about facts it never reads.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    #: The row id, which is what a toast is filed against.
    session_id: str

    #: The INSTANCE key, ``UnreadStore.compose_key(tmux_name, epoch)``,
    #: which is what the ledger and the unread flag are keyed on. Not
    #: derivable from the session id: see gotchas 4b and 10.
    key: str


@dataclass(frozen=True)
class Observation:
    """One reading of one session, as the side-effect layer sees it.

    Description: THE SEVEN JOBS THAT ARE NOT TOASTS. Deleting the hook
      route removes the only caller of a startup-gate stamp, an agent
      inference, a durable status write, the ``last_work_at`` sort key,
      a toast auto-ack and the ``/rename`` title pull. None of those is
      an edge: they are things to do because a session was READ, so they
      are handed out once per target per tick rather than out of the
      transition table, and the two evidence edges they key on are
      computed once here rather than by every consumer.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    #: What the pure resolver just answered for this session.
    verdict: AttentionVerdict

    #: The bundle the verdict was derived from, so a consumer can read a
    #: tier directly (the startup gate wants "is there a registry record
    #: at all", which no verdict field carries).
    evidence: Evidence

    #: The timestamp of a real user prompt NEWER than the one this
    #: session was last shown, else None. THE PASSIVE
    #: ``UserPromptSubmit``: it is the instant the human turned up, and
    #: it doubles as the auto-ack cutoff, so a prompt that is read late
    #: still cannot dismiss a toast raised after the user typed.
    new_user_prompt_at: Optional[datetime]

    #: True when the transcript has grown since the last reading, or
    #: this is the first reading of the session. The cadence for the
    #: pulls that are cheap and idempotent.
    transcript_appended: bool


def _toast_kind_for(transition: Transition) -> Optional[str]:
    """Which toast kind, if any, one edge raises.

    Description: PURE. The plan's transition table, and the whole table:
      a state or reason this does not name raises NOTHING rather than
      guessing a kind, because an unrecognised edge is a bug and a toast
      of the wrong kind is a bug the user has to read.
    Inputs: transition (Transition).
    Output: str | None - a toast kind, or None to raise nothing.
    Example: _toast_kind_for(t) -> 'Stop'
    """
    if transition.state == STATE_DONE_IDLE:
        return EVENT_STOP
    if transition.state == STATE_NEEDS_USER:
        # question, permission and plan_approval are all one ask: claude
        # has stopped and cannot continue until a human answers. ``input``
        # is the softer family (an elicitation, a sandbox or worker
        # request, an open dialog) and keeps its own kind so the two
        # render as different lights.
        if transition.reason == REASON_INPUT:
            return EVENT_NOTIFICATION
        return EVENT_PERMISSION_REQUEST
    return None


class AttentionWatcher:
    """The server-owned loop that turns evidence into notifications.

    Description: construct it with the collaborators, create the task
      with ``asyncio.create_task(watcher.run())``, and cancel that task
      on shutdown. Holds no state of its own beyond the ledger, the poke
      set and the directory watch.
    Inputs: see :meth:`__init__`.
    Output: an awaitable :meth:`run` and a synchronous :meth:`poke`.
    Example:
        watcher = AttentionWatcher(
            list_targets=targets, read_evidence=read, raise_toast=toast,
            set_unread=unread, on_busy_edge=worked, ledger=ledger,
        )
        task = asyncio.create_task(watcher.run())
    """

    def __init__(
        self,
        *,
        list_targets: Callable[[], Sequence[WatchTarget]],
        read_evidence: Callable[[WatchTarget, datetime], Optional[Evidence]],
        raise_toast: Callable[[WatchTarget, str, Transition], None],
        set_unread: Callable[[WatchTarget], None],
        on_busy_edge: Callable[[WatchTarget, Transition], None],
        ledger: AttentionLedger,
        on_observation: Optional[Callable[[WatchTarget, "Observation"], None]] = None,
        read_policy: Optional[Callable[[WatchTarget], Tuple[bool, Any]]] = None,
        now: Optional[Callable[[], datetime]] = None,
        tick_seconds: float = DEFAULT_TICK_SECONDS,
        registry_directory: Optional[str] = None,
    ) -> None:
        """Wire the watcher to its collaborators. Opens nothing yet.

        Inputs:
          list_targets: returns the sessions to read this tick. Called on
            the event loop, so it must be a cheap in-memory read.
          read_evidence: returns one session's four tiers, or None when
            there was nothing to read. Called in a WORKER THREAD with the
            tick's instant, so it may do file I/O and must not touch
            loop-owned state. ONE CLOCK THREADS THROUGH THE WHOLE BUNDLE:
            the reader stamps ``Evidence.now`` with what it is handed, so
            every tier in one reading is dated from the same instant and
            a test drives the lot without a wall clock.
          raise_toast: called with (target, toast kind, transition) for
            an edge that survived the mute gate. The caller owns the
            title, the body and the fan-out.
          set_unread: called with the target immediately BEFORE the
            ``done_idle`` toast, so the flag is set whether or not the
            toast is then suppressed. Suppressing is not acknowledging.
          on_busy_edge: called with (target, transition) when a session
            starts working. Raises nothing; this is where the caller
            stamps the work time and acks a permission that has since
            been answered.
          ledger: the :class:`AttentionLedger` holding the edges.
          on_observation: called with (target, :class:`Observation`) once
            per target per tick, EDGE OR NO EDGE, for the jobs that are
            not notifications: the startup-gate stamp, the agent
            inference, the durable status write, the work stamp, the
            auto-ack and the title pull. None leaves every one of them
            unwired, which is what a build with no composition site has
            and what the replay suite drives.
          read_policy: returns (policy_store_attached, policy) for one
            target. None means NO STORE IS ATTACHED, which skips the mute
            gate entirely and behaves exactly as a build without the
            feature does.
          now: the clock. Defaults to timezone-aware UTC; injected by
            tests so no test ever sleeps.
          tick_seconds: the backstop interval.
          registry_directory: the directory to watch for early wakes.
            Defaults to ``~/.claude/sessions``.
        Output: None.
        Example: AttentionWatcher(..., tick_seconds=0.0)
        """
        self._list_targets = list_targets
        self._read_evidence = read_evidence
        self._raise_toast = raise_toast
        self._set_unread = set_unread
        self._on_busy_edge = on_busy_edge
        self._on_observation = on_observation
        self._read_policy = read_policy
        self._ledger = ledger
        self._now = now if now is not None else _utc_now
        self.tick_seconds = tick_seconds
        self._registry_directory = (
            registry_directory
            if registry_directory is not None
            else default_registry_directory()
        )
        self._poked: Set[str] = set()
        self._poke_event = asyncio.Event()
        self._dir_fd: Optional[int] = None
        self._waiter: Optional[PipeWaiter] = None

    # -----------------------------------------------------------------
    # The loop
    # -----------------------------------------------------------------

    async def run(self) -> None:
        """Tick until cancelled, never dying of anything else.

        Description: sets up the early wake, then alternates one pass
          over every target with one bounded wait. A failure inside a
          pass is logged and the loop continues, because a watcher that
          stops is a machine that has gone quiet without saying so.
        Inputs: none beyond ``self``.
        Output: None. Returns only by re-raising ``CancelledError``.
        Example: await watcher.run()
        """
        self._open_watch()
        logger.info(
            "attention_watcher_started",
            tick_seconds=self.tick_seconds,
            registry_directory=self._registry_directory,
            early_wake=bool(self._waiter is not None and self._waiter.watching),
        )
        try:
            while True:
                try:
                    await self.tick_once()
                    await self._wait_for_work()
                except asyncio.CancelledError:
                    logger.info("attention_watcher_stopping")
                    raise
                except Exception as exc:
                    # DELIBERATE BREADTH, AND THE REASON IS THE WHOLE
                    # MODULE DOCSTRING: every notification on this
                    # machine is raised from inside this loop, so an
                    # error that escapes it silences the product. The
                    # per-target reads are already caught one by one
                    # below; anything reaching here is the loop's own
                    # plumbing, it is logged with its type, and the next
                    # tick runs.
                    logger.warning(
                        "attention_watcher_tick_failed",
                        error=str(exc),
                        error_type=type(exc).__name__,
                    )
                    await asyncio.sleep(self.tick_seconds)
        finally:
            self._close_watch()

    async def tick_once(self) -> int:
        """Read every target once and act on every edge. One pass.

        Description: the unit of work, exposed so a test can drive
          exactly one pass with no loop and no waiting. Listing happens
          on the event loop; READING HAPPENS OFF IT, in one worker-thread
          hop for the whole batch rather than one per session, because
          the reads are file I/O and the actions are read-modify-writes
          against loop-owned state.
        Inputs: none beyond ``self``.
        Output: int - how many transitions were acted on.
        Example: await watcher.tick_once() -> 1
        """
        self._poked.clear()
        self._poke_event.clear()
        try:
            targets = list(self._list_targets())
        except Exception as exc:
            # Without a target list there is nothing to do this tick.
            # Logged and skipped rather than raised: see the loop's own
            # comment. A listing that throws is a bug in the caller, and
            # it must not take the notifications with it.
            logger.warning(
                "attention_targets_unreadable",
                error=str(exc),
                error_type=type(exc).__name__,
            )
            return 0
        if not targets:
            return 0
        readings = await asyncio.to_thread(self._read_all, targets, self._now())
        acted = 0
        for target, evidence in readings:
            if evidence is None:
                continue
            if self._apply(target, evidence):
                acted += 1
        return acted

    def _read_all(
        self, targets: Sequence[WatchTarget], now: datetime
    ) -> List[Tuple[WatchTarget, Optional[Evidence]]]:
        """Read every target's evidence. Runs in a worker thread.

        Description: one reader failing must not cost the others their
          tick, so each read is caught on its own and answers None,
          which the caller skips. NOT a default: None here means "we did
          not read this session", and skipping is what a resolver would
          have been told anyway.
        Inputs: targets (sequence of WatchTarget). now (datetime) - the
          tick's instant, handed to every reader so one clock dates the
          whole pass.
        Output: list of (target, Evidence | None), in the input order.
        Example: watcher._read_all([target], now) -> [(target, evidence)]
        """
        readings: List[Tuple[WatchTarget, Optional[Evidence]]] = []
        for target in targets:
            try:
                readings.append((target, self._read_evidence(target, now)))
            except Exception as exc:
                # One unreadable session, not a failed tick. Warned with
                # the key so a support question names a session.
                logger.warning(
                    "attention_evidence_unreadable",
                    key=target.key,
                    error=str(exc),
                    error_type=type(exc).__name__,
                )
                readings.append((target, None))
        return readings

    # -----------------------------------------------------------------
    # One session
    # -----------------------------------------------------------------

    def _apply(self, target: WatchTarget, evidence: Evidence) -> bool:
        """Resolve one session, observe it, and act on any edge.

        Description: runs on the event loop, because the actions are
          read-modify-writes against state other loop callbacks mutate.
          A PARTIAL, CORRECT IMPROVEMENT BEATS A COMPLETE, RACY ONE.
        Inputs: target (WatchTarget), evidence (Evidence).
        Output: bool - True when a transition was acted on.
        Example: watcher._apply(target, evidence) -> True
        """
        verdict = resolve_attention(evidence)
        # THE OBSERVATION COMES FIRST, AND THE ORDER IS LOAD BEARING. A
        # user prompt read in this tick means the human turned up, which
        # auto-acks what was waiting on them; doing that BEFORE the
        # transition table means a toast this same tick raises is not in
        # the bucket yet and cannot be dismissed by the prompt that
        # preceded it.
        if self._on_observation is not None:
            new_prompt_at, appended = self._ledger.note_transcript(
                target.key,
                user_prompt_at=evidence.transcript.newest_user_prompt_at,
                append_at=evidence.transcript.newest_append_at,
            )
            self._call(
                "attention_observation_failed",
                target,
                self._on_observation,
                target,
                Observation(
                    verdict=verdict,
                    evidence=evidence,
                    new_user_prompt_at=new_prompt_at,
                    transcript_appended=appended,
                ),
            )
        transition = self._ledger.observe(
            target.key,
            verdict,
            evidence.now,
            last_append_at=evidence.transcript.newest_append_at,
        )
        if transition is None:
            return False
        self._act(target, transition)
        return True

    def _act(self, target: WatchTarget, transition: Transition) -> None:
        """Do what one edge calls for, per the plan's transition table.

        Description: ``done_idle`` sets the auto unread flag and then
          raises ONE ``Stop``; a blocking ``needs_user`` raises ONE
          ``PermissionRequest``; a soft ``needs_user`` raises ONE
          ``Notification``; ``busy`` raises nothing and fires the busy
          edge. ``unknown`` never reaches here, because the ledger does
          not emit it.

          THE UNREAD FLAG IS SET BEFORE THE MUTE IS ASKED, deliberately.
          Suppressing is not acknowledging: a muted session that finishes
          is still finished, and its light must still say so.
        Inputs: target (WatchTarget), transition (Transition).
        Output: None.
        Example: watcher._act(target, transition)
        """
        if transition.state == STATE_BUSY:
            self._call(
                "attention_busy_edge_failed",
                target,
                self._on_busy_edge,
                target,
                transition,
            )
            return
        if transition.state == STATE_DONE_IDLE:
            self._call(
                "attention_set_unread_failed", target, self._set_unread, target
            )
        kind = _toast_kind_for(transition)
        if kind is None:
            return
        gate = resolve_raise(
            kind,
            policy_store_attached=self._policy_attached(target),
            policy=self._policy_for(target),
        )
        if not gate.raises_toast:
            logger.info(
                gate.log_event or "attention_toast_suppressed",
                session_id=target.session_id,
                key=target.key,
                **gate.log_fields,
            )
            return
        logger.info(
            "attention_transition",
            session_id=target.session_id,
            key=target.key,
            state=transition.state,
            reason=transition.reason,
            previous_state=transition.previous_state,
            tier=transition.verdict.tier,
            toast_kind=kind,
        )
        self._call(
            "attention_raise_toast_failed",
            target,
            self._raise_toast,
            target,
            kind,
            transition,
        )

    def _call(
        self, event: str, target: WatchTarget, action: Callable, *args: Any
    ) -> None:
        """Run one injected action, logging rather than raising on error.

        Description: the actions belong to the caller and can fail for
          reasons this module cannot enumerate. One that throws must not
          cost the rest of the tick its notifications.
        Inputs: event (str) - the structlog event name for a failure.
          target (WatchTarget). action (callable). args - passed through.
        Output: None.
        Example: watcher._call("x_failed", target, fn, target)
        """
        try:
            action(*args)
        except Exception as exc:
            logger.warning(
                event,
                session_id=target.session_id,
                key=target.key,
                error=str(exc),
                error_type=type(exc).__name__,
            )

    def _policy_attached(self, target: WatchTarget) -> bool:
        """Is a notification policy store wired up for this target?

        Inputs: target (WatchTarget).
        Output: bool - False when no reader was injected at all.
        Example: watcher._policy_attached(target) -> False
        """
        return self._read_policy is not None

    def _policy_for(self, target: WatchTarget) -> Any:
        """This target's resolved mute policy, or None.

        Description: None is what the gate reads as "could not be
          determined", and an unreadable policy SUPPRESSES, so a reader
          that throws returns None rather than being allowed to escape.
        Inputs: target (WatchTarget).
        Output: the policy object, or None.
        Example: watcher._policy_for(target) is None -> True
        """
        reader = self._read_policy
        if reader is None:
            return None
        try:
            attached, policy = reader(target)
        except Exception as exc:
            logger.warning(
                "attention_policy_unreadable",
                key=target.key,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            return None
        return policy if attached else None

    # -----------------------------------------------------------------
    # Waking up
    # -----------------------------------------------------------------

    def poke(self, key: str) -> None:
        """Ask for a pass now rather than at the end of the interval.

        Description: synchronous and safe from any loop callback. The
          key is advisory, because a pass reads every target anyway; it
          is recorded so a log line can say what woke the loop. A poke
          that arrives while a pass is already running is not lost: the
          event stays set until the NEXT pass clears it.
        Inputs: key (str) - the instance key that changed.
        Output: None.
        Example: watcher.poke("cloude_a@1757000000")
        """
        self._poked.add(key)
        self._poke_event.set()

    def _open_watch(self) -> None:
        """Start watching the sessions directory. Never raises.

        Description: a directory that does not exist yet is the normal
          state on a machine where claude has never run, and a failure
          to watch costs latency, not correctness: the tick is the
          backstop. So every failure leaves the watcher on the plain
          interval and says so at debug.
        Inputs: none beyond ``self``.
        Output: None.
        Example: watcher._open_watch()
        """
        try:
            self._dir_fd = os.open(self._registry_directory, os.O_RDONLY)
        except OSError as exc:
            logger.debug(
                "attention_watch_directory_unavailable",
                directory=self._registry_directory,
                error=str(exc),
            )
            self._dir_fd = None
            return
        self._waiter = PipeWaiter(self._dir_fd)

    def _close_watch(self) -> None:
        """Release the directory watch and its descriptor. Idempotent.

        Description: runs from the loop's ``finally``, which can execute
          during loop teardown, so each step is guarded on its own. A
          leaked kqueue or directory descriptor would outlive the task.
        Inputs: none beyond ``self``.
        Output: None.
        Example: watcher._close_watch()
        """
        waiter, fd = self._waiter, self._dir_fd
        self._waiter = None
        self._dir_fd = None
        if waiter is not None:
            waiter.close()
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    async def _wait_for_work(self) -> str:
        """Wait for the next tick, an early wake, or a poke.

        Description: bounded by ``tick_seconds`` in every case, so a
          missed notification costs the interval and never a stall. A
          poke that is already pending returns at once without creating
          anything.
        Inputs: none beyond ``self``.
        Output: str - ``poke``, ``append`` or ``tick``, for tests and
          for measurement rather than for control flow.
        Example: await watcher._wait_for_work() -> 'tick'
        """
        if self._poke_event.is_set():
            return "poke"
        poke_task = asyncio.ensure_future(self._poke_event.wait())
        backstop = asyncio.ensure_future(self._backstop())
        try:
            done, pending = await asyncio.wait(
                {poke_task, backstop}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for task in (poke_task, backstop):
                if not task.done():
                    task.cancel()
        if poke_task in done:
            return "poke"
        return "append" if backstop.result() else "tick"

    async def _backstop(self) -> bool:
        """Sleep one interval, returning early if the directory changed.

        Inputs: none beyond ``self``.
        Output: bool - True when an append or a directory change woke us.
        Example: await watcher._backstop() -> False
        """
        waiter = self._waiter
        if waiter is None:
            await asyncio.sleep(self.tick_seconds)
            return False
        return await waiter.wait(self.tick_seconds)


def _utc_now() -> datetime:
    """The current time, timezone-aware UTC. The default clock.

    Description: a module-level function rather than a lambda so the
      default is nameable in a log line and replaceable in a test.
    Inputs: none.
    Output: datetime - aware, UTC.
    Example: _utc_now().tzinfo is not None -> True
    """
    return datetime.now(timezone.utc)
