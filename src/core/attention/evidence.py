"""The shapes the attention resolver reads, and the shape it answers with.

DATA ONLY. Nothing in this module opens a file, shells out, reads a
clock or decides anything: it holds the four tiers of evidence in one
frozen bundle and names every string the resolver may put in a verdict.
The reading lives in ``registry_read``, ``transcript_facts`` and
``pane_markers``; the deciding lives in ``resolve``.

WHY THE STRINGS ARE CONSTANTS AND NOT LITERALS. A verdict is consumed by
the display mapping, the ledger, the raise gate and the tests, four
places that must agree on spelling. The project has already paid for a
string that was typed twice and drifted once (``docs/LESSONS.md``), so
no caller here types ``"needs_user"``; it imports :data:`STATE_NEEDS_USER`.

WHY ``None`` IS EVERYWHERE AND MEANS ONE THING. Every optional field on
:class:`PaneVerdict` and :class:`AttentionVerdict` uses ``None`` for
"could not be determined" and NEVER for "no" or "zero". That is the whole
defect this package exists to remove: 410 of 459 measured false toasts
came from an absent background-agent count read as a count of zero. A
reader that cannot tell absent from zero cannot be made correct by
anything downstream of it, so the distinction is carried in the types.

THE PANE'S TRI-STATE IS THE SHARPEST CASE. ``capture-pane`` against a
full-screen TUI returns trailing blanks and nothing else, so "the capture
came back empty" is not a measurement that no dialog is open. A pane we
did not look at, and a pane we looked at and could not read, both answer
``None``; only text we actually read and matched against answers False.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from src.core.agent_families import DEFAULT_FAMILY
from src.core.attention.registry_read import RegistryRecord
from src.core.attention.transcript_facts import TranscriptFacts

# ---------------------------------------------------------------------
# The four states a verdict can carry. FOUR, and the fourth is a real
# answer: ``unknown`` is what an honest resolver says when the evidence
# refused, and it is never spelled ``done_idle``.
# ---------------------------------------------------------------------

#: The turn is over, nothing is pending, and the session is at rest. The
#: ONE state that authorises a "session done" toast, and therefore the
#: one with the most conditions in front of it.
STATE_DONE_IDLE: str = "done_idle"

#: The session is stopped and the human is the only thing that can move
#: it: a permission prompt, a question, a plan to approve, an elicitation.
STATE_NEEDS_USER: str = "needs_user"

#: The session is working. Includes waiting on its own background agents,
#: which is the case that used to be reported as done.
STATE_BUSY: str = "busy"

#: Nothing readable said what this session is doing. NOT idle, NOT dead,
#: NOT a default: a named refusal that raises no toast and clears nothing.
STATE_UNKNOWN: str = "unknown"

#: Every state, for a caller that wants to assert it has handled them all.
ALL_STATES: frozenset = frozenset(
    {STATE_DONE_IDLE, STATE_NEEDS_USER, STATE_BUSY, STATE_UNKNOWN}
)

# ---------------------------------------------------------------------
# Reasons, grouped by the state they belong to. The reason is what the
# toast kind and the display hue are chosen from, so it is part of the
# contract and not a log string.
# ---------------------------------------------------------------------

#: ``done_idle``: the turn ended and every gate in front of it passed.
#: The plan's table names no reason here because there is exactly one way
#: to reach this state; the constant exists so the field is never empty.
REASON_TURN_ENDED: str = "turn_ended"

#: ``needs_user``: an unanswered ``AskUserQuestion`` is on screen.
REASON_QUESTION: str = "question"

#: ``needs_user``: a tool is asking to be allowed to run.
REASON_PERMISSION: str = "permission"

#: ``needs_user``: an unanswered ``ExitPlanMode`` is on screen.
REASON_PLAN_APPROVAL: str = "plan_approval"

#: ``needs_user``: claude wants input of some other kind - an
#: elicitation, a sandbox request, a worker request, an open dialog.
REASON_INPUT: str = "input"

#: ``busy``: background agents this session launched are still running.
REASON_SUBAGENTS: str = "subagents"

#: ``busy``: a background agent's completion is queued, so claude is
#: about to be re-invoked with no human involved.
REASON_QUEUED_REINVOKE: str = "queued_reinvoke"

#: ``busy``: claude is generating.
REASON_STREAMING: str = "streaming"

#: ``busy``: claude is running a tool.
REASON_TOOL: str = "tool"

#: ``busy``: a shell command the user started is still running.
REASON_SHELL: str = "shell"

#: ``unknown``: the registry holds no record for this session.
REASON_REGISTRY_ABSENT: str = "registry_absent"

#: ``unknown``: the registry record is about a previous run, or its
#: ``statusUpdatedAt`` is too old to originate a rest claim.
REASON_REGISTRY_STALE: str = "registry_stale"

#: ``unknown``: a registry file was there and could not be trusted.
REASON_REGISTRY_UNREADABLE: str = "registry_unreadable"

#: ``unknown``: two tiers were read and they contradict each other, so
#: neither is reported. A ``waiting`` that outlived its dialog by nine
#: minutes is the observed case.
REASON_EVIDENCE_DISAGREES: str = "evidence_disagrees"

#: ``unknown``: every tier refused, or the family has no reader yet.
REASON_NO_EVIDENCE: str = "no_evidence"

#: ``unknown``: tmux measured the pane as gone. Rendered ``dead``.
REASON_PANE_DEAD: str = "pane_dead"

#: ``unknown``: two live claude processes claim one pane, so no record
#: can be attributed to this session. Refuse, and raise nothing.
REASON_AMBIGUOUS_PANE: str = "ambiguous_pane"

#: Every reason, for exhaustiveness assertions in tests.
ALL_REASONS: frozenset = frozenset(
    {
        REASON_TURN_ENDED,
        REASON_QUESTION,
        REASON_PERMISSION,
        REASON_PLAN_APPROVAL,
        REASON_INPUT,
        REASON_SUBAGENTS,
        REASON_QUEUED_REINVOKE,
        REASON_STREAMING,
        REASON_TOOL,
        REASON_SHELL,
        REASON_REGISTRY_ABSENT,
        REASON_REGISTRY_STALE,
        REASON_REGISTRY_UNREADABLE,
        REASON_EVIDENCE_DISAGREES,
        REASON_NO_EVIDENCE,
        REASON_PANE_DEAD,
        REASON_AMBIGUOUS_PANE,
    }
)

# ---------------------------------------------------------------------
# Tiers. Which evidence DECIDED, recorded on the verdict so a log line,
# a status_source token and a test can all name the same thing.
# ---------------------------------------------------------------------

#: ``~/.claude/sessions/<pid>.json``, what claude says about itself.
TIER_REGISTRY: str = "registry"

#: The conversation jsonl tail, what claude wrote down.
TIER_TRANSCRIPT: str = "transcript"

#: The rendered pane, what claude put on screen. CAN ONLY EVER PRODUCE
#: ``needs_user``: see the rule in :mod:`src.core.attention.resolve`.
TIER_PANE: str = "pane"

#: tmux itself, which only ever answers whether the pane is alive.
TIER_TMUX: str = "tmux"

#: Nothing decided; the verdict is a refusal.
TIER_NONE: str = "none"

#: Every tier.
ALL_TIERS: frozenset = frozenset(
    {TIER_REGISTRY, TIER_TRANSCRIPT, TIER_PANE, TIER_TMUX, TIER_NONE}
)

#: The one agent family with a registry and a transcript reader in this
#: cut. Imported rather than spelled so the family vocabulary stays in
#: one place; codex arrives in the next PR with its own reader.
FAMILY_CLAUDE: str = DEFAULT_FAMILY


@dataclass(frozen=True)
class PaneVerdict:
    """What the last block of rendered pane text showed, per dialog family.

    Description: the output of
      :func:`src.core.attention.pane_markers.classify_pane_tail`. Each
      field is a TRI-STATE and the three values are not interchangeable:

      - ``True``: a marker for that family matched text we actually read.
      - ``False``: we read real text and no marker for that family
        matched. A measured negative.
      - ``None``: we did not look, or there was nothing to look at. NOT a
        negative. ``capture-pane`` on a full-screen TUI can return only
        trailing blanks, so an empty capture is a failed read and never a
        statement that the screen is clear.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    #: A tool approval prompt is on screen.
    permission_dialog: Optional[bool] = None

    #: An ``AskUserQuestion`` menu is on screen, matched on its footer.
    question_dialog: Optional[bool] = None

    #: The folder-trust dialog is on screen, which runs BEFORE claude
    #: registers itself and is therefore the startup gate, not a turn.
    trust_dialog: Optional[bool] = None

    #: What was read and what matched, in plain words.
    detail: str = ""

    @property
    def looked(self) -> bool:
        """Did this verdict come from text we actually read?

        Description: True when at least one family was measured either
          way. False for the all-``None`` verdict a blank or absent
          capture produces, which is the one a resolver must treat as a
          refusal rather than as a clear screen.
        Inputs: none beyond ``self``.
        Output: bool.
        Example: PaneVerdict().looked -> False
        """
        return (
            self.permission_dialog is not None
            or self.question_dialog is not None
            or self.trust_dialog is not None
        )

    @property
    def shows_dialog(self) -> bool:
        """Is any user-facing dialog positively on screen?

        Description: the trust dialog is DELIBERATELY excluded. It is a
          pre-registration screen owned by the startup gate, not a turn
          the user is being asked to unblock, and folding it in here
          would make a launching session look like a stopped one.
        Inputs: none beyond ``self``.
        Output: bool - True only on a positive permission or question
          match.
        Example: PaneVerdict(permission_dialog=True).shows_dialog -> True
        """
        return self.permission_dialog is True or self.question_dialog is True

    @property
    def shows_no_dialog(self) -> bool:
        """Did we read the screen and measure both dialog families absent?

        Description: the positive negative. True ONLY when both dialog
          families were read and both came back False, so a partial look
          can never be mistaken for a clear screen.
        Inputs: none beyond ``self``.
        Output: bool.
        Example: PaneVerdict(permission_dialog=False,
          question_dialog=False).shows_no_dialog -> True
        """
        return self.permission_dialog is False and self.question_dialog is False


@dataclass(frozen=True)
class Evidence:
    """One session's four tiers of evidence, gathered at one instant.

    Description: the sole input to
      :func:`src.core.attention.resolve.resolve_attention`. Assembled by
      the watcher and by the listing pass; both hand the SAME bundle to
      the SAME pure function, which is how ``/sessions/list`` is stopped
      from ever disagreeing with the toasts.

      ``registry`` and ``transcript`` are never None. Both readers answer
      a verdict object carrying their own refusal, so there is no
      ``if evidence.registry is not None`` anywhere in the resolver and
      no way to reach a field without passing its verdict.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    #: ``LIVENESS_LIVE`` / ``LIVENESS_GONE`` / ``LIVENESS_UNKNOWN`` from
    #: :mod:`src.core.session_status`. Tier 4, and the only tier that can
    #: say a session is dead.
    tmux_liveness: str

    #: The agent family on the row, or None when it was never determined.
    #: Gates which tiers apply: see rule (e) in the resolver.
    agent_family: Optional[str]

    #: Tier 1, never None: carries its own ``REG_*`` verdict.
    registry: RegistryRecord

    #: Tier 2, never None: carries its own ``FACTS_*`` verdict.
    transcript: TranscriptFacts

    #: Tier 3, None when no capture was attempted at all. A capture that
    #: was attempted and came back blank is a PaneVerdict of all ``None``,
    #: which is a different fact and reads the same way on purpose.
    pane: Optional[PaneVerdict]

    #: The caller's clock, timezone-aware UTC. Passed in rather than read
    #: so the resolver stays pure and the replay suite can drive it.
    now: datetime


@dataclass(frozen=True)
class AttentionVerdict:
    """What one session needs, and which evidence said so.

    Description: the output of
      :func:`src.core.attention.resolve.resolve_attention`. Carries the
      state AND its cause separately, because the ledger raises on the
      state while the toast kind and the display hue are chosen from the
      reason.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    #: One of the four ``STATE_*`` constants.
    state: str

    #: One of the ``REASON_*`` constants, from this state's group.
    reason: str

    #: One of the ``TIER_*`` constants: which evidence decided.
    tier: str

    #: Background agents still running, when a trusted count was read.
    #: None means the count is UNKNOWN and must never be read as zero.
    pending_background_agents: Optional[int] = None

    #: True when the pane, or the unanswered-tool-at-EOF shape, decided
    #: the STATE. Such a verdict must be seen twice before it raises,
    #: because both sources can be read mid-render.
    settle_required: bool = False

    #: Which rung answered and why, in plain words, for logs and for the
    #: failure message of a test that expected a different rung.
    detail: str = ""
