"""The seven jobs the hook route secretly owned, rehomed onto the watcher.

WHAT THIS IS FOR. ``POST /hooks/claude-event`` and
``SessionManager.record_hook_event`` are about to be deleted, and between
them they carry work that has nothing to do with toasts and no second
caller. Each one would die silently: no test names it, no route answers
for it, and the symptom would surface days later as a session list in the
wrong order or a startup light that never goes out. This module gives
every one of them a PASSIVE trigger, driven by evidence the attention
package already reads, so the jobs survive the deletion.

THE SEVEN JOBS AND THE TRIGGER EACH ONE NOW HAS:

===========================================  ==============================
job                                          passive trigger
===========================================  ==============================
``StartupGateLedger.record_hook``            a registry record exists
``apply_agent_inference``                    a registry record, or a
                                             transcript that grew
the ``Stop`` auto-unread flag                the edge into ``done_idle``
the durable activity-state write             every reading
``sessions.last_work_at``                    a new user prompt, or the
                                             edge into ``busy``
``auto_ack_toasts``                          a new user prompt, or the
                                             edge into ``busy``
``sync_claude_title`` (``/rename``)          a transcript that grew
===========================================  ==============================

NOT ONE OF THEM IS A NEW FUNCTION. Every job below calls the same
function the hook path called; only the CALLER moved. That is deliberate:
a rewrite would have to re-earn the throttles, the instance scoping and
the refusals those functions already carry, all of which were written
against measured defects.

THIS MODULE TAKES THE MANAGER, IT DOES NOT IMPORT IT. Nothing in
``src/core/attention/`` may import ``session_manager`` (a package rule
with a test behind it), so the manager arrives as a constructor argument
and is typed ``Any``. That is also what keeps the whole thing testable:
a recording double with six attributes drives every path here.

THE BROADCASTS ARE INJECTED AND SYNCHRONOUS. Two of these jobs used to
end in an ``await connection_manager.broadcast_to_session(...)``. The
watcher calls its actions synchronously on the event loop, so this module
takes plain callables and the composition site is what decides how a
frame is put on the wire. Passing neither is a working configuration: the
database still changes, only the live push is missing, which is what a
build with no socket layer attached has today.

BOTH PATHS ARE LIVE AT ONCE FOR THIS COMMIT, ON PURPOSE, and each of the
seven was checked for it rather than assumed. ``record_hook`` is
first-write-wins; ``apply_agent_inference`` is memoised per pane per
process; ``set_flag`` is documented idempotent; the activity-state and
``last_work_at`` writes are plain column updates, so last write wins; the
auto-ack refuses a second acknowledgement of the same record; and the
title sync's steady state is a measured ``unchanged`` that writes
nothing. Running the hook and the watcher together therefore changes no
outcome, which is what lets the deletion land as its own step.

WHERE THE WRITES RUN. On the event loop, because that is where the
watcher calls its actions and because these are read-modify-writes
against state other loop callbacks mutate. It is the same posture the
listing pass takes and the same one the hook route took, and CLAUDE.md
states the reason: a partial, correct improvement beats a complete, racy
one.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, Optional, Tuple

import structlog

from src.core import claude_title_sync_apply, session_agent_infer_apply
from src.core.attention.display import to_display
from src.core.attention.ledger import Transition
from src.core.attention.watcher import Observation, WatchTarget
from src.core.session_activity import EVENT_PRE_TOOL_USE, EVENT_USER_PROMPT_SUBMIT
from src.core.session_status import STATUS_UNKNOWN

logger = structlog.get_logger()


def _naive_utc(at: Optional[datetime]) -> Optional[datetime]:
    """One timestamp as the naive UTC the toast records are stored in.

    Description: PURE. ``Toast.created_at`` is naive UTC and every
      timestamp in the attention package is aware UTC, so the auto-ack
      cutoff has to cross that line exactly once, here. Crossing it is
      not cosmetic: ``toast_auto_ack`` treats a comparison it cannot make
      as "not after", which silently drops the ordering guard and lets a
      late reading dismiss a notification raised after the user typed.
    Inputs: at (datetime | None) - aware or naive.
    Output: datetime | None - naive, in UTC.
    Example: _naive_utc(None) is None -> True
    """
    if at is None:
        return None
    if at.tzinfo is None:
        return at
    return at.astimezone(timezone.utc).replace(tzinfo=None)


class AttentionSideEffects:
    """The watcher's non-toast actions, bound to one session manager.

    Description: build one at the composition site and hand its three
      bound methods to :class:`~src.core.attention.watcher.AttentionWatcher`
      as ``set_unread``, ``on_busy_edge`` and ``on_observation``. It holds
      no state: every fact is re-resolved from the manager per call, the
      same way the hook route re-resolved it per event.
    Inputs: see :meth:`__init__`.
    Output: three callables with the watcher's action signatures.
    Example:
        effects = AttentionSideEffects(session_manager)
        watcher = AttentionWatcher(
            ..., set_unread=effects.set_unread,
            on_busy_edge=effects.on_busy_edge,
            on_observation=effects.on_observation,
        )
    """

    def __init__(
        self,
        manager: Any,
        *,
        broadcast_toast_ack: Optional[Callable[[str, str], None]] = None,
        broadcast_rename: Optional[Callable[[str, str], None]] = None,
    ) -> None:
        """Bind the actions to a manager and an optional fan-out.

        Inputs:
          manager: the live ``SessionManager``. Typed ``Any`` because
            this package may not import it; see the module docstring.
          broadcast_toast_ack: called with (session id, toast id) for
            every toast this layer acknowledges, so an attached terminal
            drops the card at once. None sends no frame.
          broadcast_rename: called with (session id, new name) when a
            ``/rename`` typed inside claude reaches the row. None sends
            no frame.
        Output: None.
        Example: AttentionSideEffects(mgr)
        """
        self._manager = manager
        self._broadcast_toast_ack = broadcast_toast_ack
        self._broadcast_rename = broadcast_rename

    # -----------------------------------------------------------------
    # Identity, resolved exactly the way the hook path resolved it
    # -----------------------------------------------------------------

    def _instance(self, session_id: str) -> Tuple[Optional[str], Optional[int]]:
        """This session's tmux name and instance epoch, or None for each.

        Description: THE SAME TWO-RUNG LOOKUP ``record_hook_event`` USED,
          copied rather than improved. The live backend knows the name
          while the process that created it is running; after a restart
          the id is not in ``backends`` yet and the persisted hook-token
          map still holds it, which is the reason a surviving session
          keeps being recorded instead of silently stopping.

          A name with no epoch is not an error. It is the legacy key
          shape, and every consumer below is documented to treat a None
          epoch as "unmeasured" rather than as a new instance.
        Inputs: session_id (str) - the cloudecode row id.
        Output: (tmux name | None, epoch | None).
        Example: effects._instance("ses_1") -> ("cloude_x", 1757000000)
        """
        backend = self._manager._registry.backends.get(session_id)
        tmux_name = getattr(backend, "tmux_session", None) if backend else None
        if not tmux_name:
            tmux_name = self._manager.hook_tokens.name_for(session_id)
        epoch = self._manager._instance_epochs.get(session_id)
        return (tmux_name or None), epoch

    # -----------------------------------------------------------------
    # The edge actions
    # -----------------------------------------------------------------

    def set_unread(self, target: WatchTarget) -> None:
        """Flag a finished session unread. The ``Stop`` hook's last job.

        Description: what ``record_hook_event`` did on ``EVENT_STOP``,
          now driven by the edge into ``done_idle``, which is the same
          moment measured from the transcript and the registry instead of
          announced by a hook. ONE FLAG, ONE KEY: the epoch comes from
          ``_unread_epoch`` exactly as the manual control and the
          viewed-clear do, so the three cannot file one pane under two
          keys.
        Inputs: target (WatchTarget).
        Output: None.
        Example: effects.set_unread(target)
        """
        tmux_name, _epoch = self._instance(target.session_id)
        if not tmux_name:
            return
        self._manager._unread_store.set_flag(
            tmux_name,
            "auto",
            True,
            epoch=self._manager._unread_epoch(tmux_name),
        )

    def on_busy_edge(self, target: WatchTarget, transition: Transition) -> None:
        """A session started working: stamp the sort key, ack a permission.

        Description: two jobs, and both of them used to ride on
          ``PreToolUse``. A session that is measurably working is a
          session doing work, so ``sessions.last_work_at`` moves; and a
          tool that is RUNNING is proof the permission it needed was
          granted, so a permission-kind toast is answered. Nothing is
          raised here.

          ``EVENT_PRE_TOOL_USE`` is passed to the auto-ack as a RULE
          SELECTOR, not as a claim that a hook fired. It names the one
          rule set in ``toast_auto_ack`` that answers permissions and
          nothing else, which is exactly the rule the plan's transition
          table asks for, and respelling that set here would give the
          project two copies of it.
        Inputs: target (WatchTarget), transition (Transition).
        Output: None.
        Example: effects.on_busy_edge(target, transition)
        """
        session_id = target.session_id
        tmux_name, _epoch = self._instance(session_id)
        self._guard(
            "attention_work_stamp_failed",
            session_id,
            self._stamp_work,
            session_id,
            tmux_name,
        )
        self._guard(
            "attention_auto_ack_failed",
            session_id,
            self._auto_ack,
            session_id,
            EVENT_PRE_TOOL_USE,
            transition.at,
        )

    # -----------------------------------------------------------------
    # The per-reading actions
    # -----------------------------------------------------------------

    def on_observation(
        self, target: WatchTarget, observation: Observation
    ) -> None:
        """Run every job that a reading, rather than an edge, calls for.

        Description: the five remaining jobs, each gated on the narrowest
          evidence that stands in for the hook it replaces. Each step is
          isolated, because one failing job must not cost the others
          their tick and none of them is worth a missed notification.
        Inputs: target (WatchTarget), observation (Observation).
        Output: None.
        Example: effects.on_observation(target, observation)
        """
        session_id = target.session_id
        tmux_name, epoch = self._instance(session_id)
        registry_present = observation.evidence.registry.known

        self._guard(
            "attention_startup_gate_failed",
            session_id,
            self._record_started,
            tmux_name,
            epoch,
            registry_present,
        )
        self._guard(
            "attention_agent_inference_failed",
            session_id,
            self._infer_agent,
            session_id,
            tmux_name,
            registry_present or observation.transcript_appended,
        )
        self._guard(
            "attention_activity_state_failed",
            session_id,
            self._persist_state,
            observation,
            tmux_name,
            epoch,
        )
        if observation.new_user_prompt_at is not None:
            # THE USER TURNED UP. A real user prompt in the transcript is
            # the passive ``UserPromptSubmit``, and it answers both of
            # that hook's jobs: the session is being worked in, and
            # everything it was asking of the human has been asked no
            # longer. The cutoff is the PROMPT'S OWN INSTANT, not this
            # tick's, so a reading that arrives late cannot dismiss a
            # notification raised after the user typed.
            self._guard(
                "attention_work_stamp_failed",
                session_id,
                self._stamp_work,
                session_id,
                tmux_name,
            )
            self._guard(
                "attention_auto_ack_failed",
                session_id,
                self._auto_ack,
                session_id,
                EVENT_USER_PROMPT_SUBMIT,
                observation.new_user_prompt_at,
            )
        if observation.transcript_appended:
            self._guard(
                "attention_title_sync_failed", session_id, self._sync_title, session_id
            )

    # -----------------------------------------------------------------
    # One job each
    # -----------------------------------------------------------------

    def _record_started(
        self, tmux_name: Optional[str], epoch: Optional[int], present: bool
    ) -> None:
        """Note that this session has started at all. Startup-gate rung 1.

        Description: THE LADDER IS UNCHANGED, ITS INPUT IS REPLACED.
          ``resolve_startup_gate`` still asks "did anything prove this
          instance is past its launch", and rung 1 still reads
          ``StartupGateLedger.first_hook_at``. What fed that field was
          "any hook landed"; what feeds it now is "claude has registered
          itself", which is strictly better evidence: the folder-trust
          dialog runs BEFORE registration, so a pane sitting on it has no
          record and correctly stays gated.

          First-write-wins inside the ledger, so calling this on every
          tick of a long-running session is free and leaves the recorded
          instant where it was.
        Inputs: tmux_name (str | None), epoch (int | None), present
          (bool) - whether a registry record was actually read.
        Output: None.
        Example: effects._record_started("cloude_x", 1, True)
        """
        if not present or not tmux_name:
            return
        self._manager._startup_gate_ledger.record_hook(tmux_name, epoch=epoch)

    def _infer_agent(
        self, session_id: str, tmux_name: Optional[str], triggered: bool
    ) -> None:
        """Infer which agent is in this pane, at most once per instance.

        Description: A TRIGGER IS NOT EVIDENCE. The inference reads the
          process table; what it needs from us is a reason to look, and
          the reason used to be "a hook arrived, and only claude fires
          hooks". Registration and a growing transcript are the passive
          versions of that same statement, and either will do.

          ``apply_agent_inference`` memoises per (socket, name, epoch)
          and its row gate ends the pass for a session that already
          records an agent, so the steady-state cost is a set lookup.
        Inputs: session_id (str), tmux_name (str | None), triggered
          (bool) - whether anything said claude is running here.
        Output: None.
        Example: effects._infer_agent("ses_1", "cloude_x", True)
        """
        if not triggered or not tmux_name:
            return
        session_agent_infer_apply.apply_agent_inference(
            self._manager, session_id, tmux_name
        )

    def _persist_state(
        self,
        observation: Observation,
        tmux_name: Optional[str],
        epoch: Optional[int],
    ) -> None:
        """Make the resolved status durable on the session row.

        Description: without this the state lives only in memory and a
          restart forgets what every session was doing, which does not
          degrade to ``unknown`` but to a confident ``idle``. The hook
          path wrote a HOOK-DERIVED state here; this writes the state the
          four tiers just resolved, which is the better value and the one
          ``/sessions/list`` will paint.

          IT GOES THROUGH THE SETTLED WRITER, NOT THE HOOK-TIME ONE. The
          hook-time writer exists only to re-resolve the tracker that is
          being deleted, while the settled writer takes a state that has
          already been computed, refuses ``unknown``, collapses the
          read-state pair so the column holds the base state, and writes
          ONLY ON CHANGE. On a two-second tick that last property is what
          keeps this from being a database write per session per tick.

          ``unread=False`` is not a claim about the flag. The writer
          re-derives the read state with the flag off anyway, precisely
          so the projection never reaches the column.
        Inputs: observation (Observation), tmux_name (str | None), epoch
          (int | None) - the instance epoch, where None refuses the write.
        Output: None.
        Example: effects._persist_state(obs, "cloude_x", 1757000000)
        """
        if not tmux_name:
            return
        state = to_display(
            observation.verdict, unread=False, tmux_status=STATUS_UNKNOWN
        )
        self._manager._persist_settled_activity_state(tmux_name, state, epoch)

    def _stamp_work(self, session_id: str, tmux_name: Optional[str]) -> None:
        """Move ``sessions.last_work_at``, the session and project sort key.

        Description: THE ONLY WRITER OF THAT COLUMN, which is why it has
          its own test: a regression here silently reorders the user's
          whole session list and nothing else goes wrong, so nobody
          reports it as a bug.

          The kind argument is None, which the manager reads as "the
          caller has already established this was work". The hook path
          passed an event name so the work/lifecycle split could be made
          there; a passive caller has measured the work directly and has
          no event name to offer, and inventing one would be a claim
          about provenance that is not true.
        Inputs: session_id (str), tmux_name (str | None).
        Output: None.
        Example: effects._stamp_work("ses_1", "cloude_x")
        """
        if not tmux_name:
            return
        self._manager._persist_work_stamp(session_id, tmux_name, None)

    def _auto_ack(
        self, session_id: str, event_kind: str, cutoff: Optional[datetime]
    ) -> None:
        """Clear the toasts this reading has ANSWERED, and say so on the wire.

        Description: the rules are untouched and still live in
          ``toast_auto_ack``: a user prompt answers everything the
          session was asking of the human, a running tool answers a
          permission and nothing else. All that changed is where the
          statement comes from.

          THE EXACT BUG CLASS THIS WHOLE CHANGE EXISTS TO KILL IS A
          COMPLETION NOTICE READ AS A HUMAN. The transcript reader
          already refuses to count a ``task-notification`` record as a
          user prompt, so a background agent finishing cannot reach this
          function, and the test that proves it is the point of the
          exercise.
        Inputs: session_id (str), event_kind (str) - which rule set
          applies. cutoff (datetime | None) - the instant the thing being
          reported actually happened, aware or naive.
        Output: None.
        Example: effects._auto_ack("ses_1", "UserPromptSubmit", None)
        """
        acked = self._manager.auto_ack_toasts(
            session_id, event_kind, _naive_utc(cutoff)
        )
        send = self._broadcast_toast_ack
        if send is None:
            return
        for toast_id in acked or ():
            send(session_id, toast_id)

    def _sync_title(self, session_id: str) -> None:
        """Pull a ``/rename`` typed inside claude onto the row.

        Description: THE ONLY WAY THE APP CAN LEARN ABOUT THAT RENAME. No
          event carries it, because claude intercepts slash commands
          before they become prompts, so the name is readable only out of
          the transcript. The hook route was where that pull hung; with
          the route gone it hangs on a transcript that grew, which is a
          strictly tighter trigger than "any hook arrived" and is
          guaranteed to include the rename itself, because the rename IS
          a record in that file.

          Cheap enough to sit on this cadence: one SELECT plus a bounded
          64 KB tail read, measured at 0.274 ms against a 244 MB
          transcript, and no write at all unless a name actually changed.
        Inputs: session_id (str).
        Output: None.
        Example: effects._sync_title("ses_1")
        """
        result = claude_title_sync_apply.sync_claude_title(
            self._manager, session_id
        )
        # READ DIRECTLY, NOT THROUGH ``getattr`` WITH A DEFAULT. Gotcha
        # 12: a name that has moved answers falsy through ``getattr``
        # and the feature dies with every test still green, so this
        # reaches for the field and lets an AttributeError be logged.
        title = result.broadcast_title
        send = self._broadcast_rename
        if title and send is not None:
            send(session_id, title)

    # -----------------------------------------------------------------
    # Failure containment
    # -----------------------------------------------------------------

    def _guard(
        self, event: str, session_id: str, job: Callable, *args: Any
    ) -> None:
        """Run one job, logging rather than raising on failure.

        Description: DELIBERATE BREADTH, and the reason is the same one
          the watcher's own loop gives: every notification on this
          machine is raised from inside that tick, and none of the jobs
          here is worth silencing it. Each is caught on its own rather
          than as a group, so one broken job does not cost the other
          five their tick, and the failure is logged with its type
          because an ``AttributeError`` from a moved name is precisely
          the failure this package is most exposed to.
        Inputs: event (str) - the structlog event name. session_id (str).
          job (callable). args - passed through.
        Output: None.
        Example: effects._guard("x_failed", "ses_1", fn, 1)
        """
        try:
            job(*args)
        except Exception as exc:
            logger.warning(
                event,
                session_id=session_id,
                error=str(exc),
                error_type=type(exc).__name__,
            )
