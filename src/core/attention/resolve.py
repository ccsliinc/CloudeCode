"""The precedence table: four tiers of evidence in, one verdict out.

PURE, TOTAL AND IT NEVER RAISES. No file is opened here, no clock is
read, no lock is taken. Everything it knows arrives on one
:class:`~src.core.attention.evidence.Evidence` bundle, so the watcher and
the listing pass can hand it the SAME bundle and get the SAME answer,
which is what stops ``/sessions/list`` from ever disagreeing with a toast.

THE RULE THE WHOLE TABLE IS BUILT AROUND: A GUESS MUST NEVER OUTRANK A
RECORD, AND AN ABSENCE IS NEVER A VALUE. Over 50.8 measured hours, 410 of
459 attributable "your session is done" toasts fired while the session's
own turn-end record said background agents were still running. Every one
of those came from a missing number being read as zero. So there is no
``or 0`` and no ``||`` default in this file: a count that was not written
is None, None does not satisfy any rung, and the session lands on
``unknown``, which raises nothing.

THE FOUR STATES AND WHY THE FOURTH IS NOT A FAILURE. ``done_idle``,
``needs_user``, ``busy``, ``unknown``. ``unknown`` is the answer a
resolver gives when the evidence refused, it is a first-class outcome
with its own named reasons, and it is never rendered as idle.

WHAT EACH TIER MAY AND MAY NOT SAY:

- tmux answers one question, is the pane alive, and it is the only tier
  that may say dead.
- the registry is claude's own statement about itself and is the only
  tier that may ORIGINATE ``done_idle``.
- the transcript is what claude wrote down. It may say busy, it may say a
  question is open, it may never say done on its own.
- the pane is what claude painted. IT MAY ONLY EVER PRODUCE
  ``needs_user``. There is no path in this file from a pane read to
  ``done_idle``, deliberately and permanently: a pane with no dialog on
  it is not a finished turn, it is a screen with nothing on it.

WHERE THIS FILE DEVIATES FROM THE PLAN, AND WHY. Five places, each
forced by the real signature of a reader that was already built:

1. Rung 0's "or the registry pid is not running" is not implemented as a
   dead-pane verdict. ``registry_read`` already folds a dead pid into
   :data:`~src.core.attention.registry_read.REG_STALE`, which is
   indistinguishable there from "this record is about a previous run".
   Such a session reaches rung 9 and answers ``unknown(registry_stale)``.
   That is also the more correct answer for the eight-state model: a live
   tmux pane whose claude exited is a shell prompt, not a dead pane, and
   painting it red would be a lie about tmux.
2. Rungs 5 and 5b ask for "EOF is any OTHER unanswered ``tool_use``".
   :class:`~src.core.attention.transcript_facts.TranscriptFacts` names
   the tool at EOF only for the two BLOCKING tools and reports every
   other unanswered call as prose in ``detail``. Parsing that prose would
   couple this file to a sentence. So the same fact is read from the
   shape the dataclass does expose: an assistant record NEWER than the
   last turn end means claude spoke or called a tool after the last turn
   boundary, which is an open turn at EOF. See :func:`_turn_open_at_eof`.
3. Rung 5c covers all FIVE values claude writes into ``waitingFor``, not
   the four the plan lists. ``permission prompt`` is the fifth and the
   plan expected rungs 5 and 5b to have caught it; when the pane could
   not be read AND the transcript is unreadable, they do not, and
   dropping that case to ``unknown`` would suppress a real permission
   prompt. Failing toward the human there is the standing rule, not a
   softening.
4. The plan put the unanswered-blocking-tool test at rung 4, inside the
   registry ``waiting`` group and BELOW the two background-agent rungs.
   It is rung 2 here, above both of them and gated on no registry status
   at all. A real AskUserQuestion tail was replayed and measured carrying
   ``pending_background_agents=1``, so under the plan's order a session
   blocked on a question while an agent ran answered ``busy(subagents)``
   and the question toast was never raised. Background agents do not
   unblock a human dialog. Everything else keeps its relative order, so
   the plan's rungs 5 onward still carry the numbers it gave them, and
   its rungs 2 and 3 are 3 and 4 here.
5. Rule (c) is NARROWED TO THE UNCORROBORATED CASE. The plan read an
   ``idle`` record older than 900s as doubt outright, so a session that
   was genuinely idle answered ``unknown`` forever. A stale idle the
   transcript corroborates now reaches ``done_idle``; one nothing
   corroborates still answers ``unknown(registry_stale)``, which is rule
   (c) preserved. The measurements are on the ``REG_IDLE`` branch.
"""

from __future__ import annotations

from datetime import datetime
from typing import Dict, Optional

from src.core.attention.evidence import (
    ALL_STATES,
    FAMILY_CLAUDE,
    REASON_AMBIGUOUS_PANE,
    REASON_EVIDENCE_DISAGREES,
    REASON_INPUT,
    REASON_NO_EVIDENCE,
    REASON_PANE_DEAD,
    REASON_PERMISSION,
    REASON_PLAN_APPROVAL,
    REASON_QUESTION,
    REASON_QUEUED_REINVOKE,
    REASON_REGISTRY_ABSENT,
    REASON_REGISTRY_STALE,
    REASON_REGISTRY_UNREADABLE,
    REASON_SHELL,
    REASON_STREAMING,
    REASON_SUBAGENTS,
    REASON_TOOL,
    REASON_TURN_ENDED,
    STATE_BUSY,
    STATE_DONE_IDLE,
    STATE_NEEDS_USER,
    STATE_UNKNOWN,
    TIER_NONE,
    TIER_PANE,
    TIER_REGISTRY,
    TIER_TMUX,
    TIER_TRANSCRIPT,
    AttentionVerdict,
    Evidence,
)
from src.core.attention.registry_read import (
    REG_ABSENT,
    REG_BUSY,
    REG_IDLE,
    REG_SHELL,
    REG_STALE,
    REG_WAITING,
    REGISTRY_STALE_AFTER_SECONDS,
)
from src.core.attention.transcript_facts import FACTS_FOUND
from src.core.session_status import LIVENESS_GONE

# ---------------------------------------------------------------------
# Timings. All three are about NOT BELIEVING A SINGLE READING.
# ---------------------------------------------------------------------

#: How far apart a pane-decided or EOF-decided verdict must be seen twice
#: before anything is raised on it. Read by the ledger, not by this file:
#: a verdict that needs it is flagged ``settle_required``. The number is
#: ccmanager's measured idle debounce, and both sources can be caught
#: mid-render, which is what it defends against.
SETTLE_SECONDS: float = 1.5

#: How long the transcript must have been quiet before a turn end counts
#: as the session being at rest. claude writes ``turn_duration`` 25 ms
#: before its own status settles, so a read taken at the boundary sees a
#: finished turn that is about to continue.
DONE_QUIET_SECONDS: int = 3

#: How recent an append has to be for a registry ``idle`` with no
#: turn-end record after the last assistant record to be read as claude
#: still generating rather than as a session at rest (rung 8b).
STREAMING_LOOKBACK_SECONDS: int = 120

# ---------------------------------------------------------------------
# The five values claude writes into ``waitingFor``, read out of the
# 2.1.266 binary: a queued elicitation and AskUserQuestion both write
# ``input needed``; every ``permission_*`` kind and ExitPlanMode default
# to ``permission prompt``; the other three name their own source.
# ---------------------------------------------------------------------

WAITING_INPUT_NEEDED: str = "input needed"
WAITING_PERMISSION_PROMPT: str = "permission prompt"
WAITING_SANDBOX_REQUEST: str = "sandbox request"
WAITING_WORKER_REQUEST: str = "worker request"
WAITING_DIALOG_OPEN: str = "dialog open"

#: Which ``needs_user`` reason each of them means. A value outside this
#: table is NOT mapped to a default: it falls to rung 5d and refuses,
#: because a waiting reason we do not recognise is not a reason we can
#: paint or write a toast about.
WAITING_REASONS: Dict[str, str] = {
    WAITING_INPUT_NEEDED: REASON_INPUT,
    WAITING_PERMISSION_PROMPT: REASON_PERMISSION,
    WAITING_SANDBOX_REQUEST: REASON_INPUT,
    WAITING_WORKER_REQUEST: REASON_INPUT,
    WAITING_DIALOG_OPEN: REASON_INPUT,
}

#: The head of the detail ``read_registry_index`` writes when two live
#: claude processes claim one tmux session. It is the only way that
#: condition is surfaced: the index collapses it into
#: :data:`~src.core.attention.registry_read.REG_UNREADABLE` alongside
#: torn files, and rung 1 has to tell them apart.
#: ``tests/test_attention_resolve.py`` builds the condition through the
#: REAL index reader, so this string cannot drift on either side without
#: a test going red.
AMBIGUOUS_PANE_DETAIL_MARKER: str = "two or more live registry records"

#: Which ``unknown`` reason each registry refusal becomes at rung 9.
_REGISTRY_REFUSAL_REASONS: Dict[str, str] = {
    REG_ABSENT: REASON_REGISTRY_ABSENT,
    REG_STALE: REASON_REGISTRY_STALE,
}


def _age_seconds(now: datetime, at: Optional[datetime]) -> Optional[float]:
    """How long ago was ``at``, from ``now``, or None if unmeasurable.

    Description: PURE. Returns None for a missing timestamp AND for a
      pair that cannot be subtracted (one aware, one naive), because a
      resolver that raises stops a watcher, and a session whose age is
      unmeasurable is a session whose age is unknown.
    Inputs: now (datetime), at (datetime | None).
    Output: float | None - seconds, negative if ``at`` is in the future.
    Example: _age_seconds(now, None) is None -> True
    """
    if at is None:
        return None
    try:
        return (now - at).total_seconds()
    except TypeError:
        # Mixed aware and naive datetimes. A measurement we cannot make.
        return None


def _turn_open_at_eof(evidence: Evidence) -> bool:
    """Did claude speak or call a tool after the last turn boundary?

    Description: PURE. The stand-in for "the window ends on an unanswered
      ``tool_use``", which TranscriptFacts does not expose for
      non-blocking tools (deviation 2 in the module docstring). An
      assistant record newer than the newest turn-end record means the
      current turn has produced output and has not ended, which is the
      shape a permission prompt leaves behind: claude emits the tool_use,
      then writes nothing at all until the human answers.

      A window with no turn-end record but with an assistant record
      counts as open, because the turn boundary is either behind the
      window or has not happened.
    Inputs: evidence (Evidence).
    Output: bool - False whenever the transcript could not be read.
    Example: _turn_open_at_eof(ev) -> True
    """
    facts = evidence.transcript
    if facts.newest_assistant_at is None:
        return False
    if facts.turn_end_at is None:
        return True
    return facts.newest_assistant_at > facts.turn_end_at


def _turn_at_rest(evidence: Evidence) -> bool:
    """Is the newest turn-end record the last word in the window?

    Description: PURE. The positive opposite of :func:`_turn_open_at_eof`,
      and not its negation: a transcript that could not be read is
      neither open nor at rest, and both answer False here.
    Inputs: evidence (Evidence).
    Output: bool.
    Example: _turn_at_rest(ev) -> True
    """
    facts = evidence.transcript
    if facts.verdict != FACTS_FOUND or facts.turn_end_at is None:
        return False
    if facts.newest_assistant_at is None:
        return True
    return facts.turn_end_at > facts.newest_assistant_at


def _pending_for_report(evidence: Evidence) -> Optional[int]:
    """The background-agent count, or None when it may not be believed.

    Description: PURE. The count is believable when the registry names a
      claude new enough to write it (``trusts_pending_count``), or when
      there is no usable registry at all, in which case there is no
      version to gate on and the number written on the turn-end record is
      the only thing anyone has. A registry we CAN read that is too old
      to write the field answers None: that is the exact case where a
      zero on screen would mean "this version never wrote one".
    Inputs: evidence (Evidence).
    Output: int | None - NEVER a substituted zero.
    Example: _pending_for_report(ev) is None -> True
    """
    count = evidence.transcript.pending_background_agents
    if count is None:
        return None
    if evidence.registry.trusts_pending_count:
        return count
    if not evidence.registry.known:
        return count
    return None


def _verdict(
    state: str,
    reason: str,
    tier: str,
    detail: str,
    *,
    evidence: Evidence,
    settle: bool = False,
) -> AttentionVerdict:
    """Assemble one verdict, with the pending count filled in once.

    Description: PURE. Exists so no rung has to remember to carry the
      count, and so ``settle_required`` is spelled at every call site
      rather than defaulted silently at some of them.
    Inputs: state, reason, tier, detail (str); evidence (Evidence);
      settle (bool) - True when the pane or the EOF shape decided the
      STATE.
    Output: AttentionVerdict.
    Example: _verdict(STATE_BUSY, REASON_TOOL, TIER_REGISTRY, "",
      evidence=ev).state -> 'busy'
    """
    return AttentionVerdict(
        state=state,
        reason=reason,
        tier=tier,
        pending_background_agents=_pending_for_report(evidence),
        settle_required=settle,
        detail=detail,
    )


def _blocked_tool_reason(tool: str) -> str:
    """Which ``needs_user`` reason an unanswered blocking tool means.

    Description: PURE. ``ExitPlanMode`` is a plan waiting for approval;
      everything else in ``BLOCKING_TOOL_NAMES`` is a question.
    Inputs: tool (str) - the tool named at EOF.
    Output: str - a ``REASON_*`` constant.
    Example: _blocked_tool_reason("ExitPlanMode") -> 'plan_approval'
    """
    if tool == "ExitPlanMode":
        return REASON_PLAN_APPROVAL
    return REASON_QUESTION


def resolve_attention(evidence: Evidence) -> AttentionVerdict:
    """What does this session need, and which tier said so?

    Description: PURE, TOTAL, AND IT NEVER RAISES. Walks the precedence
      table from rung 0; the first rung that answers wins and no later
      rung can overturn it. Every branch is commented with its rung
      number and the one-line reason that rung sits where it does.
    Inputs:
      evidence: the four tiers plus the caller's clock.
        ``evidence.registry`` and ``evidence.transcript`` are never None;
        each carries its own refusal verdict.
    Output:
      AttentionVerdict - ``state`` is always one of
      :data:`~src.core.attention.evidence.ALL_STATES`.
    Example:
      resolve_attention(evidence).state -> 'busy'
    """
    registry = evidence.registry
    facts = evidence.transcript
    pane = evidence.pane

    # RUNG 0. tmux measured the pane gone. Nothing any other tier says
    # about a pane that no longer exists can matter, and a stale record
    # left behind by a crashed claude would otherwise outrank the only
    # tier that can observe death at all.
    if evidence.tmux_liveness == LIVENESS_GONE:
        return _verdict(
            STATE_UNKNOWN,
            REASON_PANE_DEAD,
            TIER_TMUX,
            "tmux measured this pane as gone",
            evidence=evidence,
        )

    # RUNG 1. Two live claude processes claim one pane, so no record can
    # be attributed to this session. REFUSE AND RAISE NOTHING: picking
    # one of two records at random is how a session gets told about
    # another session's question.
    if AMBIGUOUS_PANE_DETAIL_MARKER in registry.detail:
        return _verdict(
            STATE_UNKNOWN,
            REASON_AMBIGUOUS_PANE,
            TIER_REGISTRY,
            registry.detail,
            evidence=evidence,
        )

    # RULE (e). The family gates which tiers apply. Only claude writes
    # the registry and this transcript shape; codex gets its own reader
    # in the next PR. A family we could not determine is NOT sent down
    # this branch, because a REG_OK record joined by tmux name and cwd is
    # itself proof that a claude registered this pane, and refusing it
    # would throw away the strongest evidence we have over a missing
    # label. A family positively named as something else gets the pane
    # and tmux only, and DONE_IDLE IS UNREACHABLE for it.
    family = evidence.agent_family
    if family is not None and family != FAMILY_CLAUDE:
        if pane is not None and pane.shows_dialog:
            reason = (
                REASON_PERMISSION
                if pane.permission_dialog is True
                else REASON_QUESTION
            )
            return _verdict(
                STATE_NEEDS_USER,
                reason,
                TIER_PANE,
                "agent family %s has no registry reader yet; %s"
                % (family, pane.detail),
                evidence=evidence,
                settle=True,
            )
        return _verdict(
            STATE_UNKNOWN,
            REASON_NO_EVIDENCE,
            TIER_NONE,
            "agent family %s has no registry or transcript reader in this "
            "cut, and the pane showed no dialog" % family,
            evidence=evidence,
        )

    # RUNG 2. THE WINDOW ENDS ON AN UNANSWERED AskUserQuestion OR
    # ExitPlanMode, WHICH IS A DIALOG ON SCREEN THAT ONLY THE HUMAN CAN
    # CLEAR. FIRST of the evidence rungs, above both background-agent
    # rungs below it, and that order is the whole point: a real
    # AskUserQuestion tail was measured carrying
    # ``pending_background_agents=1``, and while this sat under the
    # subagent rung such a session answered busy(subagents) and no
    # question toast was ever raised. Background agents do not unblock a
    # human dialog, so the direct evidence outranks the count, and a
    # permission-class notification is never suppressed.
    #
    # It is above the queued re-invoke rung for the same reason. WHEN
    # BOTH ARE PRESENT THE DIALOG STILL WINS: a queued task-notification
    # cannot be processed while the main loop is parked on the dialog, so
    # the queue is what happens AFTER the human answers, not what the
    # session is waiting on now.
    #
    # No registry status gates this rung, because the tool_use IS the
    # question: the registry is written on change and has been observed
    # days stale, while an unanswered blocking tool at the end of the
    # file is claude's own record of what it just asked. ``settle`` is
    # set because the EOF shape decided the state.
    if facts.blocked_on_tool is not None:
        return _verdict(
            STATE_NEEDS_USER,
            _blocked_tool_reason(facts.blocked_on_tool),
            TIER_TRANSCRIPT,
            facts.detail,
            evidence=evidence,
            settle=True,
        )

    # RUNG 3. A background agent's completion is queued and newer than
    # the last turn end, so claude is about to be re-invoked with nobody
    # asking it to. ABOVE the count, because this is the one signal that
    # survives a turn that has already ended: it is the exact moment the
    # old code raised "done".
    if facts.queued_reinvoke:
        return _verdict(
            STATE_BUSY,
            REASON_QUEUED_REINVOKE,
            TIER_TRANSCRIPT,
            facts.detail,
            evidence=evidence,
        )

    # RUNG 4. Background agents are still running. ABOVE every registry
    # rung, and BELOW rung 2, because this is the fact the registry
    # cannot be relied on to
    # carry at the turn boundary, and 410 of 459 false toasts were this
    # condition reported as done. The count is only consulted when the
    # registry names a claude new enough to write it (rule (d)); below
    # that floor the count is UNKNOWN, not zero, and the async ledger,
    # which is derived from records rather than from a field, answers
    # instead.
    trusted_count = (
        facts.pending_background_agents
        if registry.trusts_pending_count
        else None
    )
    if (trusted_count is not None and trusted_count > 0) or facts.open_async_agents > 0:
        return _verdict(
            STATE_BUSY,
            REASON_SUBAGENTS,
            TIER_TRANSCRIPT,
            facts.detail,
            evidence=evidence,
        )

    if registry.known and registry.status == REG_WAITING:
        # A transcript that NAMES the open question was already answered
        # at rung 2, whatever this record says, so the waiting group
        # starts at the pane. What is left here is a waiting claude whose
        # question the transcript could not name.
        #
        # RUNG 5. The pane shows a dialog. A rectangle of text on screen
        # is the strongest confirmation available that the session is
        # actually stopped, which is why this outranks the registry's own
        # waitingFor below it.
        if pane is not None and pane.shows_dialog:
            reason = (
                REASON_PERMISSION
                if pane.permission_dialog is True
                else REASON_QUESTION
            )
            return _verdict(
                STATE_NEEDS_USER,
                reason,
                TIER_PANE,
                pane.detail,
                evidence=evidence,
                settle=True,
            )

        # RUNG 5b. The pane could not be read and the turn is open at
        # EOF. FAIL TOWARD THE HUMAN, here and only here: a permission
        # prompt is never suppressed, so a session that claude says is
        # waiting, with an open turn behind it and no way to look at the
        # screen, is reported as needing the user. Getting this wrong
        # costs one extra toast; getting it wrong the other way loses the
        # prompt the user is actually blocked on.
        if (pane is None or pane.permission_dialog is None) and _turn_open_at_eof(
            evidence
        ):
            return _verdict(
                STATE_NEEDS_USER,
                REASON_PERMISSION,
                TIER_TRANSCRIPT,
                "claude reports waiting and the turn is open at the end of "
                "the transcript; the pane could not be read, so this fails "
                "toward the user",
                evidence=evidence,
                settle=True,
            )

        # RUNG 5c. claude named what it is waiting for. Believed unless
        # the pane was READ and measured both dialog families absent: a
        # dialog is a rectangle of text, and if it is not on screen the
        # agent is not blocked, whatever the record says. That veto is
        # the ruling session_permission_verify.py already ships, applied
        # to the registry instead of to a hook flag.
        reason = WAITING_REASONS.get(registry.waiting_for or "")
        vetoed = pane is not None and pane.shows_no_dialog
        if reason is not None and not vetoed:
            return _verdict(
                STATE_NEEDS_USER,
                reason,
                TIER_REGISTRY,
                "claude reports waiting for %s" % registry.waiting_for,
                evidence=evidence,
            )

        # RUNG 5d. A waiting status nothing corroborates: the pane was
        # read and is clear, or claude did not say what it is waiting
        # for. A waiting has been observed to outlive its own dialog by
        # nine minutes, so this REFUSES rather than picking a side.
        return _verdict(
            STATE_UNKNOWN,
            REASON_EVIDENCE_DISAGREES,
            TIER_REGISTRY,
            "claude reports waiting for %s and nothing corroborates it"
            % (registry.waiting_for or "an unnamed dialog"),
            evidence=evidence,
        )

    # RUNG 6. claude says it is working. Below the transcript rungs
    # because busy is also what it says while only background agents run,
    # and the user asked for those two to be told apart. The reason is
    # refined by the EOF shape, but the STATE came from the registry, so
    # this verdict is instant and needs no settle.
    if registry.known and registry.status == REG_BUSY:
        # RUNG 6a. The registry is written on change, so a ``busy`` can
        # be older than the turn end that has since been written. When
        # the transcript is at rest AND its turn-end record is NEWER than
        # the stamp on the registry record, the two tiers contradict each
        # other about the same moment. REFUSE: reporting busy would hold
        # a finished session green forever, and reporting done would take
        # the word of the tier that is not allowed to originate it.
        turn_end_newer = (
            facts.turn_end_at is not None
            and registry.status_updated_at is not None
            and facts.turn_end_at > registry.status_updated_at
        )
        if _turn_at_rest(evidence) and turn_end_newer:
            return _verdict(
                STATE_UNKNOWN,
                REASON_EVIDENCE_DISAGREES,
                TIER_REGISTRY,
                "claude reports busy but the transcript recorded the turn "
                "ending after that status was stamped",
                evidence=evidence,
            )

        streaming = not _turn_open_at_eof(evidence)
        return _verdict(
            STATE_BUSY,
            REASON_STREAMING if streaming else REASON_TOOL,
            TIER_REGISTRY,
            "claude reports busy and the transcript %s"
            % (
                "shows no output since the last turn end"
                if streaming
                else "shows an open turn at its end"
            ),
            evidence=evidence,
        )

    # RUNG 7. A shell command the user started is still running. Its own
    # rung rather than folded into busy because claude is idle underneath
    # it, and a later cut may want to say so.
    if registry.known and registry.status == REG_SHELL:
        return _verdict(
            STATE_BUSY,
            REASON_SHELL,
            TIER_REGISTRY,
            "claude reports a shell command still running",
            evidence=evidence,
        )

    if registry.known and registry.status == REG_IDLE:
        status_age = _age_seconds(evidence.now, registry.status_updated_at)
        # RULE (c), AS NARROWED. A statusUpdatedAt we cannot date, or one
        # older than the staleness window, is stale-but-true: on its own
        # it may SUSTAIN a verdict the ledger already holds and it may
        # NEVER ORIGINATE a rest claim. A 2.9-day-old record was observed
        # in the wild, which is why the horizon exists.
        #
        # WHAT AGE IS NOT: THIS FILE IS WRITTEN ON CHANGE, SO SILENCE IS
        # NOT DOUBT, IT IS THE ABSENCE OF ANY CHANGE TO RECORD. A session
        # that genuinely went idle two days ago carries a two-day-old
        # ``idle`` stamp PRECISELY BECAUSE NOTHING HAS HAPPENED SINCE. A
        # heartbeat that stops means the writer died; a write-on-change
        # record that stops means the writer had nothing to say. Reading
        # the second as the first makes this resolver LESS certain the
        # longer a session stays correctly at rest, and the light never
        # settles. Measured on this Mac over twelve live sessions,
        # cloude_LeaveIt (stamp 37.3h old), cloude_Ob (98.5h) and
        # cloude_Shopify (37.3h) each answered unknown(registry_stale)
        # while their own transcripts recorded the turn ending with
        # nothing pending.
        #
        # SO AGE ALONE MAY NOT DEFEAT done_idle WHEN A SECOND INDEPENDENT
        # SOURCE AGREES. ``fresh`` no longer gates rung 8; it gates only
        # the UNCORROBORATED refusal below it, which is rule (c) itself.
        # The corroboration is rung 8's transcript half, unchanged and
        # still behind ``trusts_pending_count``, so a claude too old to
        # write the count cannot reach this path by being old (rule (d)).
        fresh = status_age is not None and status_age < REGISTRY_STALE_AFTER_SECONDS
        quiet = _age_seconds(evidence.now, facts.newest_append_at)

        # RUNG 8. THE ONLY PATH TO done_idle, AND EVERY GATE IS A
        # SEPARATE AND. claude says idle; the version is new enough for
        # the count to mean anything (rule (d)); a turn-end record was
        # actually read; it is the last word in the window; the count is
        # zero rather than absent; the async ledger is empty; nothing is
        # queued; and the file has been quiet long enough that we are not
        # reading the 25 ms gap between the turn end and the next append.
        # Those seven ARE the corroboration rule (c) now defers to: every
        # one of them is read out of the transcript, which no registry
        # write can touch, so clearing them is a second source agreeing.
        if (
            registry.trusts_pending_count
            and facts.verdict == FACTS_FOUND
            and _turn_at_rest(evidence)
            and facts.pending_background_agents == 0
            and facts.open_async_agents == 0
            and not facts.queued_reinvoke
            and quiet is not None
            and quiet >= DONE_QUIET_SECONDS
        ):
            corroborated = (
                ""
                if fresh
                else ", and that idle stamp is %.0fs old but the transcript "
                "corroborates it" % (status_age or 0.0)
            )
            return _verdict(
                STATE_DONE_IDLE,
                REASON_TURN_ENDED,
                TIER_REGISTRY,
                "claude reports idle, the turn ended with no agents pending "
                "and the transcript has been quiet for %.1fs%s"
                % (quiet, corroborated),
                evidence=evidence,
            )

        # RUNG 8b. claude says idle but the transcript is still moving
        # and no turn end has landed after the last assistant record:
        # the status is between the model finishing and the record being
        # written. Read as still generating, never as at rest.
        if (
            quiet is not None
            and quiet < STREAMING_LOOKBACK_SECONDS
            and not _turn_at_rest(evidence)
        ):
            return _verdict(
                STATE_BUSY,
                REASON_STREAMING,
                TIER_TRANSCRIPT,
                "claude reports idle but the transcript appended %.1fs ago "
                "with no turn end after the last assistant record" % quiet,
                evidence=evidence,
            )

        # An idle that could not clear rung 8. Say WHICH gate refused, so
        # a log line distinguishes a stale record from a version too old
        # to write the count from a transcript nobody could read.
        #
        # RULE (c) IN ITS NARROWED FORM LIVES HERE: an old idle stamp that
        # NOTHING CORROBORATES still refuses. Rung 8 has already run, so
        # reaching this line means the transcript did not confirm a
        # finished turn, and a lone stale record may not originate one.
        if not fresh:
            return _verdict(
                STATE_UNKNOWN,
                REASON_REGISTRY_STALE,
                TIER_REGISTRY,
                "claude reports idle but the record has not been updated "
                "inside %ds and nothing in the transcript corroborates a "
                "finished turn, so it may sustain a verdict and may not "
                "start one" % REGISTRY_STALE_AFTER_SECONDS,
                evidence=evidence,
            )
        return _verdict(
            STATE_UNKNOWN,
            REASON_NO_EVIDENCE,
            TIER_REGISTRY,
            "claude reports idle and the transcript does not confirm the "
            "turn ended with no agents pending: %s" % facts.detail,
            evidence=evidence,
        )

    if not registry.known:
        # RUNG 9. No usable registry record. The transcript alone may
        # still say a question is open, and it may still say agents are
        # running, and it may NEVER say done: without claude's own status
        # there is no way to tell a finished turn from one that is about
        # to write its next line. The question half of that sentence is
        # rung 2, which does not consult the registry at all and has
        # therefore already answered every blocked EOF by the time
        # anything reaches here.
        #
        # The version gate does not apply here: with no record there is
        # no version to read, and a count that was WRITTEN and is
        # POSITIVE is evidence on its own. What the gate exists to stop
        # is an ABSENT count being read as zero, which cannot happen on
        # this branch because zero never reaches done_idle without a
        # registry.
        if (
            facts.pending_background_agents is not None
            and facts.pending_background_agents > 0
        ):
            return _verdict(
                STATE_BUSY,
                REASON_SUBAGENTS,
                TIER_TRANSCRIPT,
                "no usable registry record; " + facts.detail,
                evidence=evidence,
            )
        return _verdict(
            STATE_UNKNOWN,
            _REGISTRY_REFUSAL_REASONS.get(
                registry.verdict, REASON_REGISTRY_UNREADABLE
            ),
            TIER_REGISTRY,
            registry.detail or "no usable registry record for this session",
            evidence=evidence,
        )

    # RUNG 10. The pane is alive and nothing readable said anything
    # about it: a registry status outside the four claude writes, which
    # registry_read keeps VERBATIM rather than coercing. Refuse.
    return _verdict(
        STATE_UNKNOWN,
        REASON_NO_EVIDENCE,
        TIER_NONE,
        "the registry reports a status this resolver does not recognise: %r"
        % registry.status,
        evidence=evidence,
    )


#: Guard for callers and tests: the resolver's state vocabulary is the
#: one in ``evidence``, and nothing here may add to it.
RESOLVED_STATES: frozenset = ALL_STATES
