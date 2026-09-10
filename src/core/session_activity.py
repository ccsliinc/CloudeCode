"""Hook-driven session activity state machine (feat/hook-driven-status).

Replaces "poll tmux and guess" with "listen to what Claude Code's own
lifecycle hooks tell us, and only claim what they actually tell us".

Why this exists: ``src.core.session_status.resolve_pane_status()`` can only
see a pane's foreground process name. It cannot tell "the agent is
thinking" from "the agent is blocked on a permission prompt" - both look
like "a non-shell command is running" to tmux. Claude Code's lifecycle
hooks (``Notification`` / ``PermissionRequest`` / ``Stop`` / tool-use /
subagent events) are the only HONEST source for that distinction, so this
module is the one place hook events turn into a display state.

TWO KINDS OF WAITING, AND THEY ARE NOT THE SAME CLAIM (split 2026-09-08).
``PermissionRequest`` means the agent is STOPPED until the user answers a
yes/no; ``Notification`` means claude wants attention while nothing is
blocked. They used to share one ``question`` state and one boolean, which
made a chatty notification light identical to a genuinely parked turn.
They now set two independent booleans and resolve to ``question`` and
``notice`` respectively, permission first. Two flags rather than one
tri-state value is what keeps the pair order-tolerant: neither event kind
can overwrite the other's claim, so a Notification arriving before, after
or twice around a PermissionRequest converges on the same answer.

Every state string is defined in ``session_status.py`` (single source of
truth for the vocabulary); this module owns only the state MACHINE.

Tolerance to unreliable hook delivery (dropped / duplicated / out-of-order
events - hooks POST over loopback HTTP with a 3s timeout, backgrounded, and
Claude Code gives no delivery guarantee):
  - Every field update is idempotent last-write-wins on a boolean or a
    floored counter - applying the same event twice, or applying two
    events in the "wrong" order, converges to the same state a correctly-
    ordered stream would reach. See ``record_event`` for the field-by-field
    reasoning.
  - A CLOSING EVENT IS NEVER A HEARTBEAT ON ITS OWN, and ``SubagentStop``
    only ever floors ``subagent_depth`` at 0 rather than going negative.
    See the section below: between them these are what stop a finished
    turn painting ``working`` for two minutes after it ended.
  - A missing ``Stop`` (the process died mid-turn, no clean shutdown) is
    handled by the HEARTBEAT TIMEOUT below, not by trying to detect the
    death from the hook stream (hooks cannot see a dead process either -
    only tmux can, which is why ``resolve()`` still takes tmux's dead check
    as the one authoritative override).

A CLOSING EVENT IS NOT A HEARTBEAT (measured 2026-09-08, punchlist item
4). ``tests/test_led_real_hooks.py`` put a real claude 2.1.265 in a real
pane and watched what it POSTs: on a turn with NO SUBAGENT ANYWHERE IN
IT, ``SubagentStop`` arrives about 1.5s AFTER ``Stop``, reproduced twice.
``Stop`` had just set ``last_tool_event_ts`` to None precisely to say the
turn was over, and ``SubagentStop`` stamped it again, so the heartbeat
re-armed and ``resolve`` reported ``working`` for the full 120s on a
session sitting at an empty prompt. ``finished_unread`` lasted a second
and a half and ``idle`` was UNREACHABLE in between.

THE RULE: ``SubagentStop`` NEVER STAMPS THE HEARTBEAT. It reports that
work ENDED, so the only thing it may move is ``subagent_depth``, and it
moves that with the floor at 0.

It first shipped gated on ``subagent_depth > 0`` instead - stamp only
when a subagent was open to close - and THE GATE IS NOT THE CLAIM IT
STANDS FOR. A DUPLICATED ``SubagentStart`` delivered after ``Stop``
raises the depth off the floor by itself, and the duplicated
``SubagentStop`` behind it then passes the gate and stamps. A guard keyed
on a number the very stream it distrusts can move is not a guard.
Refusing outright loses nothing: a subagent FINISHING is not work
happening now, so if the turn really is still running the parent's next
``PreToolUse`` / ``PostToolUse`` re-arms the heartbeat within one tool
call, and under-claiming ``working`` is this module's safe direction.

``PostToolUse`` cannot take the same blanket refusal - it is the only
event some legitimate turns emit late - so it keys on ``turn_open``, and
the refusal is NARROW: refused ONLY when a ``Stop`` has POSITIVELY been
seen for this session and no opening event has landed since. Never having
seen a ``Stop`` (a fresh session, a server restarted mid-turn) is not
evidence the turn is over, so that case still stamps. The remaining hole
- a turn whose ``UserPromptSubmit`` AND ``PreToolUse`` were both dropped,
leaving only a ``PostToolUse`` - costs one under-claimed ``working``,
corrected by the next opening event.

OPENING events still stamp unconditionally: nothing to be late for.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import structlog

from src.core.session_status import (
    STATUS_DEAD,
    STATUS_FINISHED_UNREAD,
    STATUS_IDLE,
    STATUS_NOTICE,
    STATUS_QUESTION,
    STATUS_RUNNING,
    STATUS_UNKNOWN,
    STATUS_WORKING,
    STATUS_WORKING_SUBAGENT,
    derive_read_state,
)

# ---------------------------------------------------------------------------
# Hook event kind strings. Mirrors the header value the hook endpoint
# receives (``X-Cloudecode-Event``) and the events claude_hooks.py installs
# into ~/.claude/settings.json. Centralized here (not re-spelled per
# caller) so a typo in one place fails a test instead of silently
# no-op'ing in production.
# ---------------------------------------------------------------------------

EVENT_STOP = "Stop"
EVENT_NOTIFICATION = "Notification"
EVENT_PERMISSION_REQUEST = "PermissionRequest"
EVENT_USER_PROMPT_SUBMIT = "UserPromptSubmit"
EVENT_PRE_TOOL_USE = "PreToolUse"
EVENT_POST_TOOL_USE = "PostToolUse"
EVENT_SUBAGENT_START = "SubagentStart"
EVENT_SUBAGENT_STOP = "SubagentStop"

#: Events this tracker changes state for. Anything else (a future Claude
#: Code hook kind we don't know about yet) is ignored defensively in
#: ``record_event`` rather than raising - a forward-compat hook the user's
#: Claude Code version adds must never crash the activity tracker.
KNOWN_EVENTS: frozenset[str] = frozenset(
    {
        EVENT_STOP,
        EVENT_NOTIFICATION,
        EVENT_PERMISSION_REQUEST,
        EVENT_USER_PROMPT_SUBMIT,
        EVENT_PRE_TOOL_USE,
        EVENT_POST_TOOL_USE,
        EVENT_SUBAGENT_START,
        EVENT_SUBAGENT_STOP,
    }
)

#: How long a tool-use heartbeat (PreToolUse/PostToolUse/SubagentStart/
#: SubagentStop) is trusted before we stop calling the session "working".
#:
#: Reasoning for 120s: this is the safety net for a dropped ``Stop`` (the
#: agent process dies mid-tool-call without a clean shutdown hook firing).
#: It has to be LONGER than the gap between two consecutive tool calls
#: during normal heavy agentic work - a single tool call (a large file
#: write, a slow web fetch, a long-running test suite) can legitimately
#: run for a minute or more with no intermediate hook - or the dot would
#: flicker back to idle/finished_unread mid-turn, which is worse than a
#: state going stale for a bit. It has to be SHORT enough that a genuinely
#: dead process doesn't leave the session stuck showing "working" for the
#: rest of the day. 120s sits comfortably above realistic single-tool-call
#: latency and comfortably below "the user will notice something is off".
WORKING_HEARTBEAT_TIMEOUT_SECONDS: int = 120

_HEARTBEAT_TIMEOUT = timedelta(seconds=WORKING_HEARTBEAT_TIMEOUT_SECONDS)

#: How long a ``Stop`` that was suppressed for sub-agent reasons keeps
#: suppressing the events that trail it.
#:
#: WHY A LATCH IS NEEDED AT ALL. ``Stop`` resets ``subagent_depth`` to 0
#: (it must - see the field comment), so the toast gate correctly
#: suppresses that first ``Stop`` at a positive depth and is then blind
#: for the rest of the same wait. Measured live 2026-09-10 on
#: ``ses_63beb976``, three times in twelve minutes: an idle
#: ``Notification`` RAISED about 60s after a suppressed ``Stop`` (plus
#: 60.09s, plus 60.12s, plus 60.03s), once with a second ``Stop`` raised
#: at plus 19.22s as well. Each summoned the user to a pane reading
#: "Waiting for N background agents to finish".
#:
#: Reasoning for 180s. It has to be LONGER than the whole trailing burst
#: claude emits during one background wait, and the longest gap measured
#: between a suppressed ``Stop`` and a trailing event is about 85s, so
#: anything under about 120s reintroduces the bug on the slower waits. It
#: also has to clear ``WORKING_HEARTBEAT_TIMEOUT_SECONDS`` (120s), because
#: while that window is open the session can still be painting ``working``
#: from the pre-Stop heartbeat and a toast landing inside it is the same
#: false summons. 180s is a bit over twice the longest measured gap and
#: half again the heartbeat window.
#:
#: It has to be FINITE, and that is the safety property, not a
#: convenience: with a TTL an over-long background wait degrades to a
#: DELAYED notification, never a lost one. A latch with no expiry is an
#: unbounded mute, and a missed "your turn" is a worse failure than a
#: spurious one. Silence is only ever bought with evidence, and this
#: latch is evidence with a shelf life.
SUBAGENT_WAIT_LATCH_SECONDS: int = 180

_SUBAGENT_WAIT_LATCH = timedelta(seconds=SUBAGENT_WAIT_LATCH_SECONDS)

logger = structlog.get_logger(__name__)


def map_tmux_fallback(tmux_status: str, unread: bool = False) -> str:
    """Translate a raw tmux-only status into the unified vocabulary.

    Description: The graceful-degradation path for a session with NO hook
        signal at all - either the user's Claude Code has no hooks
        configured, or hooks are configured but this particular session
        hasn't fired one yet (e.g. it was just created). Never fabricates
        a hook-driven state (question/notice/working_subagent) since there
        is no signal to base one on; only maps what tmux itself can see.
    Inputs:
        tmux_status: one of session_status.STATUS_RUNNING / STATUS_IDLE /
            STATUS_DEAD / STATUS_UNKNOWN (the raw ``resolve_pane_status()``
            output).
        unread: whether this session's persisted unread flag is set. Only
            consulted when tmux reports ``idle`` - an idle-and-unread
            session becomes ``finished_unread`` even without a hook Stop,
            e.g. a session the user manually pinned unread and then the
            server restarted (losing the ephemeral hook state but not the
            persisted flag).
    Output:
        str: one of ALL_ACTIVITY_STATUSES.
    Example:
        >>> map_tmux_fallback(STATUS_RUNNING)
        'unknown'
        >>> map_tmux_fallback(STATUS_IDLE, unread=True)
        'finished_unread'
    """
    if tmux_status == STATUS_DEAD:
        return STATUS_DEAD
    if tmux_status == STATUS_RUNNING:
        # MEASURED 2026-09-08, AND IT CHANGED THE ANSWER HERE.
        #
        # This used to return STATUS_WORKING, and that was a claim tmux
        # cannot support. ``running`` means only "the pane's foreground
        # process is not a bare shell". It is TRUE of an agent mid-tool-
        # call and equally true of one sitting at an empty prompt waiting
        # for a human, and this module's whole reason for existing is that
        # tmux cannot tell those apart.
        #
        # What made it visible: the caveat in ``session_status.py`` says
        # every pane under this app's launch path reports ``zsh``, so this
        # branch was thought unreachable. It is not, any more. Re-measured
        # over all 19 live sessions on the reference box, 15 report a
        # claude VERSION STRING as ``pane_current_command`` (``2.1.259``,
        # ``2.1.261``, ``2.1.263`` - the binary renames its own process)
        # and only 4 report ``zsh``. So this branch is now the COMMON one,
        # and every one of those 15 sessions was being reported as
        # ``working`` on no evidence, permanently: unlike the hook tier
        # below, the fallback carries no timestamp, so nothing could ever
        # expire the claim. That is the stale ``working`` the punchlist
        # recorded as lasting minutes after a resume; it did not last
        # minutes, it lasted until a hook arrived to overrule it.
        #
        # THREE OUTCOMES. "A process is alive here" is not "the agent is
        # working" and is not "the agent is at rest". It is the absence of
        # a measurement of activity, and this codebase has a word for that
        # which is not either of the other two.
        return STATUS_UNKNOWN
    if tmux_status == STATUS_IDLE:
        # ONE DERIVATION, shared with the hook path and both seeds. See
        # ``session_status.derive_read_state``: the read/unread half of
        # this vocabulary is a projection of the flag, never a value a
        # source gets to decide for itself.
        return derive_read_state(STATUS_IDLE, unread=unread)
    return STATUS_UNKNOWN


@dataclass
class SessionActivitySignal:
    """Ephemeral, per-session hook-derived signal state.

    Never persisted to disk - a server restart legitimately forgets this
    (the process the hooks describe may itself be gone), and on restart
    every session falls back to ``map_tmux_fallback`` until fresh hook
    events re-establish signal. The one piece of hook-derived information
    that DOES need to survive a restart (the unread flag) is intentionally
    NOT stored here - see ``SessionManager.unread_state`` / the module
    docstring of ``config.get_unread_state_path``.
    """

    #: True once at least one event has ever landed for this session.
    #: Distinguishes "hooks are installed and simply quiet right now" from
    #: "hooks are not installed / haven't fired yet" - only the latter
    #: falls back to ``map_tmux_fallback``.
    hook_seen: bool = False
    #: True while a ``PermissionRequest`` is believed unresolved. THE
    #: AGENT IS STOPPED while this is set - it cannot proceed until the
    #: user answers. THREE THINGS RETIRE IT, and it needs all three: the
    #: next UserPromptSubmit / PreToolUse / Stop (the answer being given,
    #: and the fastest route WHEN the events reach this same key), the
    #: user viewing the session (``clear_permission`` via
    #: ``session_view_clears``), and the pane being read and found to hold
    #: no dialog (``session_permission_verify``). The last two exist
    #: because the first is a closed loop only while every event lands on
    #: this key, and on live 2026-09-09 one session's did not.
    permission_open: bool = False
    #: When ``permission_open`` last went False -> True, or None while it
    #: is clear. It exists because a PermissionRequest is a CLAIM that
    #: something is on screen, and the pane is the only thing that can
    #: confirm it - see ``src/core/session_permission_verify.py``. Stamped
    #: ONLY on the transition, never refreshed by a duplicate: a duplicated
    #: PermissionRequest means "still blocked", and letting it re-stamp
    #: would push the verification grace window out for as long as the
    #: duplicates kept arriving, which is exactly when verification is
    #: most needed. Cleared to None everywhere the flag clears, so a
    #: stale stamp can never outlive the claim it dates.
    permission_opened_at: Optional[datetime] = None
    #: True between an unresolved ``Notification`` and the next
    #: UserPromptSubmit or PreToolUse event. Claude wants attention and is
    #: NOT blocked, which is why it is a second boolean rather than a
    #: second writer of the first one: a Notification arriving while a
    #: permission prompt is open must not be able to downgrade the claim
    #: when the permission is later cleared on its own.
    notice_open: bool = False
    #: Wall-clock time of the most recent PreToolUse/PostToolUse/
    #: SubagentStart/SubagentStop event, or None if no heartbeat is live
    #: (fresh session, or a Stop cleared it).
    last_tool_event_ts: Optional[datetime] = None
    #: Count of SubagentStart events not yet matched by a SubagentStop.
    #: Floored at 0 (see module docstring) so a duplicate/out-of-order
    #: SubagentStop can never make this negative.
    subagent_depth: int = 0
    #: True while the hook stream shows a turn IN PROGRESS. Set by every
    #: OPENING event (UserPromptSubmit / PreToolUse / SubagentStart),
    #: cleared by ``Stop``. It exists so a late ``PostToolUse`` can be told
    #: from one belonging to the turn running right now. A boolean rather
    #: than a counter deliberately: parallel tool calls and a droppable
    #: ``PreToolUse`` would make a counter drift, and a drifting counter is
    #: a worse lie than a coarse one. Read TOGETHER WITH ``last_stop_ts``.
    turn_open: bool = False
    #: Wall-clock time of the most recent Stop. Consulted by
    #: ``record_event`` (a Stop we have POSITIVELY seen is what licenses
    #: refusing a late ``PostToolUse``); not consulted by ``resolve`` -
    #: the persisted unread flag is the durable record of "a Stop happened
    #: and nobody's looked".
    last_stop_ts: Optional[datetime] = None
    #: When a ``Stop`` was last SUPPRESSED for sub-agent reasons, or None.
    #: Stamped by the ``Stop`` branch from the depth as it stood BEFORE
    #: that branch's own reset, because the reset is what destroys the
    #: evidence the toast gate needs for the rest of the wait. Read
    #: through ``subagent_wait_active``, which is where the TTL lives.
    #:
    #: THE STAMP IS THE TRANSITION, NOT THE EVENT, the same discipline
    #: ``permission_opened_at`` uses. A duplicate ``Stop`` arrives with
    #: the depth already 0, so it finds nothing to stamp from and leaves
    #: the original stamp alone; a repeating hook therefore cannot push
    #: the mute out indefinitely.
    #:
    #: RETIRED BY AN OPENING EVENT OR BY THE TTL, NEVER BY COUNTING DOWN.
    #: After a ``Stop`` the depth is already 0, so a later
    #: ``SubagentStop`` hits the floor branch and decrements nothing - any
    #: retire-by-counting-down design would never retire at all.
    subagent_wait_since: Optional[datetime] = None


class SessionActivityTracker:
    """Owns the ephemeral hook-derived signal for every live session.

    Pure in-memory state + pure functions - no I/O, no persistence, easily
    unit-testable in isolation (mirrors the style of
    ``session_status.resolve_pane_status``, just with mutable state since
    a hook stream, unlike a single tmux query, is genuinely stateful).
    ``SessionManager`` owns one instance and is responsible for feeding it
    events and for the durable (disk-backed) unread flag.
    """

    def __init__(self) -> None:
        self._signals: dict[str, SessionActivitySignal] = {}

    def record_event(
        self, session_id: str, kind: str, now: Optional[datetime] = None
    ) -> None:
        """Apply one hook event to ``session_id``'s signal state.

        Description: Idempotent, order-tolerant field updates - see the
            module docstring for why duplicate/out-of-order/missing events
            can never wedge the state machine. Unknown ``kind`` values are
            ignored (forward-compat with a Claude Code hook this app
            doesn't know about yet).
        Inputs:
            session_id: cloudecode session id (the hook endpoint's
                ``X-Cloudecode-Session`` header value, already validated).
            kind: one of the ``EVENT_*`` constants (or any string - unknown
                values are a documented no-op, not an error).
            now: injectable clock for tests. Defaults to
                ``datetime.utcnow()``.
        Output: None (mutates internal state).
        Example:
            >>> t = SessionActivityTracker()
            >>> t.record_event("s1", EVENT_NOTIFICATION)
            >>> t.record_event("s1", EVENT_USER_PROMPT_SUBMIT)
        """
        if kind not in KNOWN_EVENTS:
            return
        now = now or datetime.utcnow()
        state = self._signals.setdefault(session_id, SessionActivitySignal())
        state.hook_seen = True

        if kind == EVENT_PERMISSION_REQUEST:
            # Idempotent: setting True when already True is a no-op. A
            # duplicate, or a second distinct permission prompt before the
            # first resolved, both just mean "still blocked" - correct
            # either way.
            #
            # THE STAMP IS THE TRANSITION, NOT THE EVENT. Only a
            # False -> True move dates the claim; a duplicate leaves the
            # original stamp alone so the pane verification's grace window
            # cannot be pushed out indefinitely by a repeating hook. See
            # the field comment on ``permission_opened_at``.
            if not state.permission_open:
                state.permission_opened_at = now
            state.permission_open = True
        elif kind == EVENT_NOTIFICATION:
            # Deliberately does NOT touch permission_open. The two flags
            # are independent because the events are: hooks arrive
            # unordered, so a Notification landing after the
            # PermissionRequest it accompanies must leave the blocking
            # claim exactly as it found it.
            state.notice_open = True
        elif kind == EVENT_USER_PROMPT_SUBMIT:
            state.permission_open = False
            state.permission_opened_at = None
            state.notice_open = False
            # An OPENING event retires the sub-agent wait latch: a new
            # turn beginning is positive proof the previous wait is over.
            state.subagent_wait_since = None
            # An OPENING event: a prompt was submitted, so a turn is live
            # again even though this event stamps no heartbeat of its own
            # (a turn that calls no tool never paints ``working``, which
            # is correct - nothing is running that the user cannot see).
            state.turn_open = True
        elif kind == EVENT_PRE_TOOL_USE:
            # Tool activity starting implies the user answered yes (or no
            # permission was needed) and has plainly seen the session -
            # covers the common case where Claude Code emits no distinct
            # "permission answered" event at all. It clears BOTH for the
            # same reason: the user showing up is what resolves either.
            state.permission_open = False
            state.permission_opened_at = None
            state.notice_open = False
            state.turn_open = True
            state.last_tool_event_ts = now
            # An OPENING event: see EVENT_USER_PROMPT_SUBMIT above.
            state.subagent_wait_since = None
        elif kind == EVENT_POST_TOOL_USE:
            # A CLOSING event. It is a heartbeat only while a turn is
            # open, or while we have never seen a Stop for this session
            # at all - not having looked is not evidence the turn ended,
            # so a fresh session and a server restarted mid-turn both
            # still stamp. Refused, it moves NOTHING: no timestamp, no
            # flag, so applying it twice is the same no-op as applying it
            # once, and it cannot reorder anything.
            if state.turn_open or state.last_stop_ts is None:
                state.last_tool_event_ts = now
            else:
                logger.debug(
                    "tool_result_after_stop",
                    session_id=session_id,
                    last_stop_ts=state.last_stop_ts.isoformat(),
                )
        elif kind == EVENT_SUBAGENT_START:
            state.subagent_depth += 1
            state.turn_open = True
            state.last_tool_event_ts = now
            # An OPENING event, and it also raises the depth - so the gate
            # is covered by the live count from here until the next Stop
            # and needs no latch in between. Clearing it is the
            # fail-toward-notifying direction: a straggler SubagentStart
            # delivered after a Stop costs at most one spurious toast,
            # where leaving the latch standing would cost a missed one.
            state.subagent_wait_since = None
        elif kind == EVENT_SUBAGENT_STOP:
            # A SubagentStop NEVER STAMPS THE HEARTBEAT. It reports that
            # work ENDED, so the only thing it may move is the depth, and
            # it moves that with the floor (a negative depth would
            # permanently hide a later legitimate Start). See the module
            # docstring: gating the stamp on ``subagent_depth > 0``, as
            # this did until it was tightened, gates it on a number a
            # DUPLICATED SubagentStart delivered after ``Stop`` can raise
            # off the floor by itself, so the straggler pair Start-then-
            # Stop re-armed ``working`` on a finished turn through the
            # very guard meant to stop it.
            if state.subagent_depth > 0:
                state.subagent_depth -= 1
            else:
                logger.debug(
                    "subagent_stop_without_start",
                    session_id=session_id,
                    turn_open=state.turn_open,
                )
        elif kind == EVENT_STOP:
            # Turn ended cleanly: nothing blocking, nothing asking for
            # attention, no in-flight tool work, no in-flight subagent. A
            # duplicate Stop re-applies the exact same reset - harmless.
            #
            # THE DEPTH IS CAPTURED BEFORE THE RESET, and the reset below
            # is deliberately unchanged. Letting SubagentStop decrement it
            # naturally instead would mean one DROPPED SubagentStop pins
            # the depth above zero forever and silences that session
            # permanently, which fails toward SILENCE. So the depth still
            # resets and the fact that a wait was in progress is latched
            # separately, with a TTL. See ``subagent_wait_since``.
            depth_before_stop = state.subagent_depth
            state.permission_open = False
            state.permission_opened_at = None
            state.notice_open = False
            state.subagent_depth = 0
            state.last_tool_event_ts = None
            state.turn_open = False
            state.last_stop_ts = now
            if depth_before_stop > 0:
                state.subagent_wait_since = now

    def resolve(
        self,
        session_id: str,
        tmux_status: str,
        unread: bool = False,
        now: Optional[datetime] = None,
    ) -> str:
        """Compute the unified display status for one session.

        Description: ``tmux_status`` (dead-check) always wins first - hooks
            cannot see a process die, only tmux can (see CLAUDE.md hazard
            list). After that, if no hook has EVER fired for this session,
            degrade gracefully to ``map_tmux_fallback`` rather than
            claiming a hook-driven state we have no signal for. Otherwise
            apply the priority order the user specified: an open
            permission prompt beats an open notification beats a fresh
            heartbeat beats "finished and unread" beats idle.
        Inputs:
            session_id: cloudecode session id.
            tmux_status: raw ``resolve_pane_status()`` output for this
                session's pane (``STATUS_RUNNING``/``IDLE``/``DEAD``/
                ``UNKNOWN``). The ONLY thing that can report ``dead``.
            unread: this session's persisted unread flag (auto-from-Stop
                OR manual), supplied by the caller - this module has no
                persistence of its own.
            now: injectable clock for tests. Defaults to
                ``datetime.utcnow()``.
        Output:
            str: one of ``session_status.ALL_ACTIVITY_STATUSES``.
        Example:
            >>> t = SessionActivityTracker()
            >>> t.resolve("unseen", STATUS_RUNNING)
            'working'
            >>> t.record_event("s1", EVENT_NOTIFICATION)
            >>> t.resolve("s1", STATUS_RUNNING)
            'notice'
            >>> t.record_event("s1", EVENT_PERMISSION_REQUEST)
            >>> t.resolve("s1", STATUS_RUNNING)
            'question'
        """
        if tmux_status == STATUS_DEAD:
            return STATUS_DEAD

        state = self._signals.get(session_id)
        if state is None or not state.hook_seen:
            return map_tmux_fallback(tmux_status, unread=unread)

        now = now or datetime.utcnow()

        # PERMISSION OUTRANKS NOTICE, and both outrank a live heartbeat.
        # A session that is stopped waiting for a yes/no is the most
        # actionable thing on the screen; one that has merely asked to be
        # looked at is next; work that proceeds without the user is after
        # both. Duplicated or out-of-order events cannot reorder this:
        # each flag is set independently and read in a fixed order, so a
        # Notification landing either side of a PermissionRequest resolves
        # to ``question`` both times.
        if state.permission_open:
            return STATUS_QUESTION

        if state.notice_open:
            return STATUS_NOTICE

        heartbeat_fresh = (
            state.last_tool_event_ts is not None
            and (now - state.last_tool_event_ts) <= _HEARTBEAT_TIMEOUT
        )
        if heartbeat_fresh:
            return (
                STATUS_WORKING_SUBAGENT
                if state.subagent_depth > 0
                else STATUS_WORKING
            )

        # AT REST. Which of the two resting states this is, is not a
        # decision this state machine makes - it is the unread flag,
        # applied by the one function every other source applies too.
        # ``unknown`` is untouched by it deliberately: not having
        # measured a session is not a claim that it is resting, so an
        # unread flag may not turn it into one.
        if tmux_status == STATUS_UNKNOWN and not unread:
            return STATUS_UNKNOWN

        return derive_read_state(STATUS_IDLE, unread=unread)

    def clear_notice(self, session_id: str) -> bool:
        """Clear an open ``Notification`` because the user LOOKED. Idempotent.

        Description: the ONE thing outside the hook stream that may move
            this state machine, and it may move exactly one field.
            ``notice`` means "claude wants you to look"; a WebSocket
            terminal binding to the session, or the user's explicit
            mark-read control, is the user looking. Nothing in the hook
            stream carries that fact - the three events that clear
            ``notice_open`` today (``UserPromptSubmit`` / ``PreToolUse``
            / ``Stop``) are all the AGENT acting, which is why a
            notification survived a 46-minute visit on live 2026-09-09.

            IT DOES NOT TOUCH ``permission_open``, and that is a
            division of labour rather than a policy: the permission has
            its own clear next door (``clear_permission``), which the
            same view path calls, and which the pane check also calls.
            One field per method keeps a caller that wants only one of
            them from having to want both.

            Idempotent and order-tolerant like every other update here:
            clearing a notice that is not open is a no-op, and a
            ``Notification`` arriving after this call simply re-opens
            one, which is correct - that is a NEW request for attention.
        Inputs:
            session_id: cloudecode session id.
        Output:
            bool: True when a notice was actually open and has been
            cleared, False when there was nothing to clear. Returned so a
            caller can log the difference rather than guess at it; no
            caller is required to act on it.
        Example:
            >>> t = SessionActivityTracker()
            >>> t.record_event("s1", EVENT_NOTIFICATION)
            >>> t.clear_notice("s1")
            True
            >>> t.clear_notice("s1")
            False
        """
        state = self._signals.get(session_id)
        if state is None or not state.notice_open:
            return False
        state.notice_open = False
        logger.debug("notice_cleared_by_view", session_id=session_id)
        return True

    def clear_permission(self, session_id: str) -> bool:
        """Clear an open ``PermissionRequest``. Idempotent.

        Description: the second thing outside the hook stream that may
            move this state machine, and like ``clear_notice`` it may
            move exactly one claim (the flag and the stamp that dates it,
            which are one fact in two fields).

            IT HAS TWO CALLERS AND THEY ANSWER THE SAME QUESTION FROM
            OPPOSITE ENDS. ``session_view_clears`` calls it because the
            OWNER showed up - his rule, verbatim: "when clicking a tab,
            the session is marked read. if i want it unread i click
            unread." ``session_permission_verify_apply`` calls it because
            the PANE was read and holds no dialog, which is the only
            evidence that can retire a flag whose agent can no longer be
            reached by a clearing hook.

            WHY THE VIEW MAY NOW CLEAR IT, having deliberately not done
            so before. The old reasoning was that looking at a permission
            prompt does not answer it, so a view clearing it would paint
            false green. Measured on live 2026-09-09 that argument
            protected the wrong thing: ``cloude_Media_Compression`` held
            ``question`` with NO dialog on its pane at all, because the
            hooks that clear the flag arrived under a DIFFERENT session
            id than the one the flag was set on, and no event reachable
            from that pane could ever retire it. A claim no observation
            can retire is not a safe claim, it is a stuck one. The pane
            check next door is the honest retirement path; the view is
            the user's own override of it, consistent with every other
            attention state on this screen.

            Order-tolerant: a ``PermissionRequest`` arriving after this
            call simply re-opens the flag with a FRESH stamp, which is
            correct - that is a new prompt, and it gets its own grace
            window before the pane is asked about it.
        Inputs:
            session_id: cloudecode session id.
        Output:
            bool: True when a permission was actually open and has been
            cleared, False when there was nothing to clear.
        Example:
            >>> t = SessionActivityTracker()
            >>> t.record_event("s1", EVENT_PERMISSION_REQUEST)
            >>> t.clear_permission("s1")
            True
            >>> t.clear_permission("s1")
            False
        """
        state = self._signals.get(session_id)
        if state is None or not state.permission_open:
            return False
        state.permission_open = False
        state.permission_opened_at = None
        return True

    def permission_open_since(self, session_id: str) -> Optional[datetime]:
        """When this session's open permission claim was first raised.

        Description: the accessor the pane-verification seam reads, so
            nothing outside this module has to reach into ``_signals``.
            Returns None both when no permission is open and when the
            session is unknown - the caller treats either as "nothing to
            verify", which is the same action for both.
        Inputs:
            session_id: cloudecode session id.
        Output:
            datetime | None - naive UTC stamp of the False -> True move.
        Example:
            >>> SessionActivityTracker().permission_open_since("s1") is None
            True
        """
        state = self._signals.get(session_id)
        if state is None or not state.permission_open:
            return None
        return state.permission_opened_at

    def hooks_seen(self, session_id: str) -> bool:
        """True iff at least one hook event has ever landed for this session.

        Used by callers (and tests) that want to distinguish "we are in
        the graceful tmux-fallback path" from "hooks are live" without
        duplicating ``resolve()``'s internal logic.
        """
        state = self._signals.get(session_id)
        return state is not None and state.hook_seen

    def subagent_depth(self, session_id: str) -> int:
        """How many ``SubagentStart`` events are still unmatched for a session.

        Description: Read-only view of ``SessionActivitySignal.subagent_depth``
            for callers outside this module, in the same spirit as
            ``hooks_seen``. A session this tracker has never seen answers
            0, which is deliberate: an unknown session is NOT evidence that
            subagents are running, and every caller of this treats a
            positive count as licence to stay quiet. Note the value is
            whatever the LAST event applied left behind - ``Stop`` resets
            it to 0, so a caller that wants the depth as it stood DURING
            the turn has to read it before it feeds the ``Stop`` in.
        Inputs:
            session_id: cloudecode session id.
        Output: int, 0 or greater. Never negative (``record_event`` floors
            it) and never None.
        Example:
            >>> tracker.record_event("ses_1", "SubagentStart")
            >>> tracker.subagent_depth("ses_1")
            1
        """
        state = self._signals.get(session_id)
        return state.subagent_depth if state is not None else 0

    def subagent_wait_active(
        self, session_id: str, now: Optional[datetime] = None
    ) -> bool:
        """True while a recent ``Stop`` was suppressed for sub-agent reasons.

        Description: The second half of the sub-agent evidence the toast
            gate reads, and the half that survives ``Stop``'s own reset of
            ``subagent_depth``. A ``Stop`` that landed at a positive depth
            stamps ``subagent_wait_since``; this answers True until an
            OPENING event clears the stamp or
            ``SUBAGENT_WAIT_LATCH_SECONDS`` elapses, whichever comes
            first.

            FAIL TOWARD NOTIFYING, exactly as ``subagent_depth`` does. A
            session this tracker has never seen, one with no stamp, and
            one whose stamp has expired all answer False, so the toast is
            raised. Only a stamp inside its window buys silence, and it
            buys a BOUNDED amount of it: an over-long background wait
            degrades to a DELAYED notification, never a lost one.
        Inputs:
            session_id: cloudecode session id.
            now: injectable clock for tests. Defaults to
                ``datetime.utcnow()``, matching ``record_event``.
        Output: bool. True only when a stamp exists and is younger than
            ``SUBAGENT_WAIT_LATCH_SECONDS``.
        Example:
            >>> tracker.record_event("ses_1", EVENT_SUBAGENT_START)
            >>> tracker.record_event("ses_1", EVENT_STOP)
            >>> tracker.subagent_wait_active("ses_1")
            True
        """
        state = self._signals.get(session_id)
        if state is None or state.subagent_wait_since is None:
            return False
        now = now or datetime.utcnow()
        return (now - state.subagent_wait_since) < _SUBAGENT_WAIT_LATCH

    def forget(self, session_id: str) -> None:
        """Drop all ephemeral state for ``session_id``. Idempotent.

        Called by ``SessionManager._wipe_session_state`` on detach/destroy
        - a new attach (even to the same tmux session) gets a fresh
        ``session_id`` and starts this tracker from a clean slate, which is
        correct: the OLD process's in-flight tool/subagent state is gone
        the moment its session_id stops being live.
        """
        self._signals.pop(session_id, None)
