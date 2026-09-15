"""The claim store the attention seam still reads, and the tmux fallback.

THIS MODULE USED TO BE THE HOOK-DRIVEN STATE MACHINE. It is not any more.
Claude Code was made to POST every lifecycle event to a loopback endpoint,
and this file turned that stream into a display state: a sub-agent depth
counter, a heartbeat timestamp, a turn-open boolean, a suppression latch.
All of it is deleted. ``CLOUDECODE_SESSION_ID`` is a PANE-WIDE environment
variable, so the parent agent and every background agent it spawned posted
under one session id, and measured over 50.8 hours of the live log the
counter called 410 of 459 turn-ends finished while the transcript's own
record said background agents were still pending. The INPUT was mislabeled
at the source, so no amount of ordering work could move the number.

What answers that question now is :mod:`src.core.attention`, which reads
what the harness already writes to disk and needs nothing posted to it.

THREE THINGS SURVIVED, AND EACH HAS A LIVE CALLER OUTSIDE THE HOOK PATH.

**The event-kind vocabulary.** The ``EVENT_*`` strings are the one place
these names are spelled. :mod:`src.core.attention.raise_gate`,
:mod:`src.core.attention.watcher` and
:mod:`src.core.attention.side_effects` all import them, so a typo is a
failed import rather than a silent no-op in production.

**:func:`map_tmux_fallback`.** The graceful-degradation path for a session
with no evidence at all beyond what tmux can see.

**The permission and notice claim store.** ``SessionActivityTracker`` now
holds exactly two claims per session and the stamp that dates one of them.
Its READERS are live and outside this module:
:mod:`src.core.session_view_clears` retires both when the user looks at a
session, and :func:`src.core.session_permission_verify_apply
.verify_open_permission` reads the stamp to decide whether a session is
worth one ``capture-pane`` - a verdict the listing pass turns into the
attention resolver's pane tier.

**IT HAS NO WRITER TODAY, AND THAT IS A KNOWN GAP RATHER THAN AN
OVERSIGHT.** ``record_event`` was the only thing that ever opened a claim,
and it went with the hooks. Until a passive source supplies the
opened-at - the open question Appendix B item 7 of the attention plan
records - every read here answers "no claim", and every caller above
already handles that as its documented absent case. The store is kept
rather than deleted because deleting it would turn two explicit
``is not None`` guards into two reads of a name that no longer exists,
which is the falsy-not-raising failure this codebase numbers as gotcha 12.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import structlog

from src.core.session_status import (
    STATUS_DEAD,
    STATUS_IDLE,
    STATUS_RUNNING,
    STATUS_UNKNOWN,
    derive_read_state,
)

# ---------------------------------------------------------------------------
# Event kind strings. THE VOCABULARY BRIDGE, and the reason this block
# outlived the state machine that used to consume it: the attention
# package names the same three kinds when it decides what a toast is,
# and one table beats three spellings.
# ---------------------------------------------------------------------------

EVENT_STOP = "Stop"
EVENT_NOTIFICATION = "Notification"
EVENT_PERMISSION_REQUEST = "PermissionRequest"
EVENT_USER_PROMPT_SUBMIT = "UserPromptSubmit"
EVENT_PRE_TOOL_USE = "PreToolUse"
EVENT_POST_TOOL_USE = "PostToolUse"
EVENT_SUBAGENT_START = "SubagentStart"
EVENT_SUBAGENT_STOP = "SubagentStop"

#: How long a working claim is trusted before it stops meaning "working".
#:
#: Reasoning for 120s: it has to be LONGER than the gap between two
#: consecutive tool calls during normal heavy agentic work - a single call
#: (a large file write, a slow web fetch, a long test suite) can
#: legitimately run for a minute or more with nothing in between - or the
#: light flickers back to idle mid-turn, which is worse than a state going
#: stale for a bit. It has to be SHORT enough that a genuinely dead
#: process does not leave the session showing "working" for the rest of
#: the day. 120s sits comfortably above realistic single-tool-call latency
#: and comfortably below "the user will notice something is off".
#:
#: KEPT HERE, WITH THREE IMPORTERS, because the same window has to govern
#: the durable row and the transcript read as governs the live one:
#: ``activity_persist``, ``session_transcript_status`` and
#: ``alert_state_contract`` all read this exact name.
WORKING_HEARTBEAT_TIMEOUT_SECONDS: int = 120

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
    """One session's open attention claims. Ephemeral, never persisted.

    Description: a server restart legitimately forgets these - the process
      they describe may itself be gone - and every session then falls back
      to what the attention resolver can read off disk. The one piece of
      this information that DOES need to survive a restart, the unread
      flag, is deliberately NOT stored here; see
      ``config.get_unread_state_path``.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    #: True while a ``PermissionRequest`` is believed unresolved. THE
    #: AGENT IS STOPPED while this is set - it cannot proceed until the
    #: user answers. Two things retire it: the user viewing the session
    #: (``clear_permission`` via ``session_view_clears``), and the pane
    #: being read and found to hold no dialog
    #: (``session_permission_verify_apply``).
    permission_open: bool = False
    #: When ``permission_open`` last went False -> True, or None while it
    #: is clear. It exists because a permission claim is a CLAIM that
    #: something is on screen, and the pane is the only thing that can
    #: confirm it - see ``src/core/session_permission_verify.py``. Stamped
    #: ONLY on the transition, never refreshed by a duplicate: a duplicate
    #: means "still blocked", and letting it re-stamp would push the
    #: verification grace window out for as long as the duplicates kept
    #: arriving, which is exactly when verification is most needed.
    #: Cleared to None everywhere the flag clears, so a stale stamp can
    #: never outlive the claim it dates.
    permission_opened_at: Optional[datetime] = None
    #: True while claude wants attention and is NOT blocked. A second
    #: boolean rather than a second writer of the first one: a notice
    #: raised while a permission prompt is open must not be able to
    #: downgrade the claim when the permission is later cleared.
    notice_open: bool = False


class SessionActivityTracker:
    """Owns the open attention claims for every live session.

    Description: pure in-memory state and pure functions - no I/O, no
      persistence. ``SessionManager`` owns one instance.

      IT HAS NO WRITER TODAY. See the module docstring: the hook stream
      that opened these claims is deleted, and until a passive source
      supplies an opened-at every method here answers its absent case.
      The readers are real and are outside this module.
    Inputs: n/a.
    Output: n/a.
    Example: SessionActivityTracker().permission_open_since("s1") is None
    """

    def __init__(self) -> None:
        """Start with no claims and no I/O of any kind.

        Inputs: none.
        Output: None.
        Example: SessionActivityTracker()
        """
        self._signals: dict[str, SessionActivitySignal] = {}

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
            >>> SessionActivityTracker().clear_notice("s1")
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
            >>> SessionActivityTracker().clear_permission("s1")
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

    def forget(self, session_id: str) -> None:
        """Drop every open claim for ``session_id``. Idempotent.

        Description: called by ``SessionManager._wipe_session_state`` on
          detach or destroy. A new attach, even to the same tmux session,
          gets a fresh ``session_id`` and starts from a clean slate, which
          is correct: the OLD process's open claims are gone the moment
          its session id stops being live.
        Inputs: session_id (str) - unknown ids are a no-op.
        Output: None.
        Example: SessionActivityTracker().forget("ses_1")
        """
        self._signals.pop(session_id, None)
