"""Bringing back a session whose tmux SESSION is gone, on the row it has.

THE GAP THIS CLOSES, AND WHY IT IS NOT ANY OF THE THREE PATHS THAT
ALREADY EXIST. ``POST /sessions/respawn`` puts a process back into a pane
that is still THERE - ``remain-on-exit on`` kept the window, the pane id
and the ``pipe-pane`` alive, so there is something to respawn into.
``respawn-pane -k`` replaces the process in a pane that is alive. And
``src/core/session_imported_restart.py`` creates a session for a row that
never had a tmux identity at all.

None of them can reach the case in between: a row that DID have a tmux
session and no longer does. The tmux server was restarted, the session
was killed outright, the machine rebooted - the name is simply absent
from ``tmux -L cloude list-sessions``. There is no pane to respawn into,
so the respawn ladder reads the pane, gets nothing, and answers
``cannot_determine``: an honest refusal that leaves the user with one
option, which is to build a fresh session by hand and lose the row. The
row is where the project binding, the title, the pinned theme, the unread
key and the group membership live, so losing it loses all five.

SO THE MECHANIC IS A CREATE AND THE SEMANTIC IS STILL A RESUME. CLAUDE.md
states the rule: "A RESTART MEANS A RESUME, ON EVERY RUNG THAT CAN". This
is that rule applied to the one rung that could not: a new tmux session,
in the conversation's own directory, under the wrapper the user picked,
with ``--resume <uuid>``, recorded ONTO the existing row through
``create_session(reuse_session_id=...)`` so nothing is minted beside it.

NOTHING NEW IS INVENTED TO DECIDE IT. The transcript guard, the directory
measurement, the wrapper validation, the ``--resume`` fragment and the
three conversation words are all the imported path's, imported rather
than respelled: :func:`plan_recreate` measures the one fact only it has -
whether the tmux session is still on the socket - and hands everything
else to ``plan_imported_restart``. A second spelling of any of those
rules would eventually disagree with the pane path, and the disagreement
would be invisible until it refused a restart somebody needed.

THE GATE IS A MEASURED ABSENCE, AND ``is_alive()`` CANNOT PROVIDE ONE.
``TmuxBackend.is_alive`` runs ``has-session`` and returns a bool, so
"tmux says no such session" and "tmux is missing, timed out, or errored"
come back as the same False. Acting on that would recreate a session that
is running perfectly well, next to itself, over a socket hiccup. So the
measurement here is a LISTING - ``discover_existing()``, which already
carries this project's three-outcome discipline in ``TmuxListing.ok`` and
``TmuxListing.complete``. That measurement lives next door in
``src/core/session_recreate_presence.py``, and its three outcomes are
kept apart:

  :data:`TMUX_GONE`     the listing ran, was COMPLETE, and the name is
        not in it. The only outcome a recreate may be offered on.
  :data:`TMUX_PRESENT`  the name is in the listing. The existing restart
        owns this session; a recreate would spawn a second tmux beside a
        live one and rebind the row onto the newcomer, orphaning the pane
        the user is actually talking to. Reported as ``not_dead``, the
        same word the respawn ladder uses for the same refusal.
  :data:`TMUX_UNKNOWN`  the listing did not run, or ran with rows the
        parser refused, or the name is one this listing cannot see. NOT
        gone. Not having been able to look is not evidence of absence,
        and this is the gate on an action that writes a row.

A NAME OUTSIDE THE ``cloude_`` NAMESPACE IS ALWAYS UNKNOWN.
``discover_existing`` filters to ``SESSION_PREFIX``, so a session named
anything else is absent from that listing whether it is running or not,
and reading its absence as a measurement would be reading the filter
rather than the socket. An adopted external session therefore never
reaches the gate, which is also the right answer on its own terms: this
app did not launch it and has no record of what to put back.

WHAT MOVES, AND WHAT DELIBERATELY DOES NOT. The new tmux session is a new
INSTANCE - a new ``#{session_created}`` - so the row is re-keyed onto it.
That re-key is ``session_restart.rebind_instance``, reached through
``create_session(reuse_session_id=...)``, and it holds ``sessions.id``
fixed while it moves the triple. Everything that references a session
references the id: the project binding
(``sessions.project_id`` / ``project_attribution``), the title, the
conversation link, the lineage columns, and - since schema v24 -
``session_group_membership``, whose primary key is ``session_uuid`` and
not the tmux name. So group filing and position ride the row too. The one
thing keyed on the NAME is per-device browser state, which is why this
path asks for the SAME tmux name back; the create path's own
uniquify-on-collision rule still applies, and the response reports the
name that was actually taken rather than the one that was asked for.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional

import structlog

from src.core.session_imported_restart import (
    ImportedRestartPlan,
    ResumeDirectory,
    plan_imported_restart,
)
from src.core.session_recreate_presence import (
    TMUX_GONE,
    TMUX_PRESENT,
    TMUX_UNKNOWN,
    TmuxPresence,
)
from src.core.session_respawn import (
    RESPAWN_AGENT,
    RESPAWN_CANNOT_DETERMINE,
    RESPAWN_NOT_DEAD,
    RespawnPlan,
)
from src.core.session_resume_target import (
    CONVERSATION_NONE_RECORDED,
    CONVERSATION_RESUMED,
    CONVERSATION_UNKNOWN,
)

logger = structlog.get_logger()

#: The rung. Its own word rather than ``agent`` because what it does is
#: different in kind: ``agent`` puts a process into a pane that exists,
#: this CREATES the tmux session. A UI that rendered them identically
#: would tell a user their pane was being reused when it is being
#: replaced, and the scrollback they are looking at does not survive.
RECREATE: str = "recreate"


def has_tmux_identity(row: Optional[Mapping[str, Any]]) -> bool:
    """Whether this row ever had a tmux session, and so can be recreated.

    Description: the exact complement of
      ``session_imported_restart.is_imported_row``, expressed by calling
      it rather than by respelling its test. The two paths partition
      every row between them, and a partition written twice is a
      partition that eventually overlaps or leaves a gap.
    Inputs: row (Mapping | None) - a ``sessions`` row.
    Output: bool.
    Example: has_tmux_identity({'tmux_name': 'cloude_a',
      'tmux_created_epoch': 1})  # True
    """
    from src.core.session_imported_restart import is_imported_row

    if row is None:
        return False
    return not is_imported_row(row)


@dataclass(frozen=True)
class RecreatePlan:
    """What recreating one dead session would do.

    Description: the SAME four fields the pane path and the imported path
      report - ``kind``, ``command``, ``conversation``, ``detail`` - plus
      the facts only this path has. A client that renders a
      ``RespawnPlan`` renders this with no second code path.
    Attributes:
        kind: :data:`RECREATE` on success; ``not_dead`` when the tmux
            session is still there; ``transcript_missing`` on a MEASURED
            missing transcript; ``cannot_determine`` when presence, the
            row or the wrapper could not be resolved. Never ``shell`` -
            an unpicked recreate is not offered at all rather than
            silently handing back a login shell.
        command: the exact command that would run, or None.
        conversation: ``'resumed'`` / ``'none_recorded'`` / ``'unknown'``,
            DERIVED FROM THE ARGV by ``continuity_from_command`` so the
            claim can never outrun the command.
        presence: the ``TMUX_*`` verdict this plan was gated on.
        working_dir: the SPELLING the session would be created in, as
            measured by ``resume_directory``.
        tmux_name: the name the new session asks for. Not a promise: the
            create path uniquifies on collision.
        reuse_session_id: the ``sessions.id`` the new tmux instance is
            recorded onto, so no second row is minted.
        label: the title the new session carries.
        agent_type: the wrapper id asked for.
        detail: one sentence, fit to show verbatim.
    """

    kind: str
    command: Optional[str] = None
    conversation: str = CONVERSATION_UNKNOWN
    presence: str = TMUX_UNKNOWN
    working_dir: Optional[str] = None
    tmux_name: Optional[str] = None
    reuse_session_id: Optional[int] = None
    label: Optional[str] = None
    agent_type: Optional[str] = None
    detail: str = ""

    @property
    def actionable(self) -> bool:
        """True only when this plan can be acted on right now.

        Description: the kind AND a command. A recreate with no command
          has nothing to run, and a UI reading the kind alone would
          enable a button over an empty string.
        Inputs: n/a. Output: bool.
        Example: plan.actionable
        """
        return self.kind == RECREATE and bool(self.command)


def plan_recreate(
    row: Optional[Mapping[str, Any]],
    *,
    row_read_ok: bool,
    presence: TmuxPresence,
    choice_verdict: Optional[str] = None,
    choice_command: Optional[str] = None,
    choice_detail: str = "",
    agent_type: Optional[str] = None,
    directory: Optional[ResumeDirectory] = None,
) -> RecreatePlan:
    """Decide what recreating one dead session would do. PURE.

    Description: the caller reads the row, measures the socket through
      :func:`tmux_presence`, measures the directory through
      ``session_imported_restart.resume_directory`` and validates the
      wrapper through ``session_agent_choice.validate_agent_choice``;
      this classifies. Same division of labour as
      ``resolve_respawn_plan``, and what makes every outcome testable
      with no tmux, no database and no filesystem.

      THE ORDER OF THE GATES IS THE ORDER OF THE CERTAINTIES, and the
      first two belong to this module alone. A row that could not be READ
      is ``cannot_determine`` before anything else, because every later
      gate reads it. Then PRESENCE, because it is the only gate that can
      protect a RUNNING agent, and it must be answered before any
      question about what to put in its place. Everything after that is
      the imported path's ladder, called rather than copied: a measured
      missing transcript refuses ahead of the wrapper (no wrapper choice
      makes a deleted conversation resumable), then the wrapper.
    Inputs: row (Mapping | None) - the ``sessions`` row. row_read_ok
      (bool) - True iff the datastore answered. presence (TmuxPresence) -
      the socket measurement. choice_verdict (str | None) -
      ``AgentChoice.verdict``. choice_command (str | None) - the resolved
      command, which MUST already carry the ``--resume`` fragment.
      choice_detail (str) - the validator's sentence. agent_type
      (str | None) - the wrapper id asked for. directory
      (ResumeDirectory | None) - the measurement; None is UNCHECKED,
      which never refuses.
    Output: RecreatePlan.
    Example: plan_recreate(row, row_read_ok=True,
      presence=TmuxPresence(TMUX_GONE), choice_verdict='accepted',
      choice_command='zsh -c ...').kind  # 'recreate'
    """
    if not row_read_ok or row is None:
        return RecreatePlan(
            kind=RESPAWN_CANNOT_DETERMINE,
            presence=presence.outcome,
            detail=(
                "the session's row could not be read, so what recreating "
                "it would do was not evaluated"
            ),
        )

    tmux_name = _str(row.get("tmux_name"))

    if presence.outcome == TMUX_PRESENT:
        # THE ONE GATE THAT PROTECTS A RUNNING AGENT. Recreating over a
        # live tmux session would spawn a second one and rebind the row
        # onto the newcomer, leaving the pane the user is talking to
        # alive, unreferenced and invisible.
        return RecreatePlan(
            kind=RESPAWN_NOT_DEAD,
            presence=presence.outcome,
            tmux_name=tmux_name,
            reuse_session_id=_row_id(row),
            detail=presence.detail,
        )

    if presence.outcome != TMUX_GONE:
        return RecreatePlan(
            kind=RESPAWN_CANNOT_DETERMINE,
            presence=presence.outcome,
            tmux_name=tmux_name,
            reuse_session_id=_row_id(row),
            detail=presence.detail
            or (
                "whether this session's tmux is still running could not "
                "be determined, so nothing was offered"
            ),
        )

    # EVERY REMAINING RULE IS THE IMPORTED PATH'S, CALLED NOT COPIED. It
    # already answers, in this order: a measured missing transcript, then
    # the wrapper, then the conversation the argv actually carries.
    inner: ImportedRestartPlan = plan_imported_restart(
        row,
        row_read_ok=True,
        choice_verdict=choice_verdict,
        choice_command=choice_command,
        choice_detail=choice_detail,
        agent_type=agent_type,
        directory=directory,
    )

    if inner.kind != RESPAWN_AGENT:
        return RecreatePlan(
            kind=inner.kind,
            command=inner.command,
            conversation=inner.conversation,
            presence=presence.outcome,
            working_dir=inner.working_dir,
            tmux_name=tmux_name,
            reuse_session_id=inner.reuse_session_id or _row_id(row),
            label=inner.label,
            agent_type=agent_type,
            detail=inner.detail,
        )

    return RecreatePlan(
        kind=RECREATE,
        command=inner.command,
        conversation=inner.conversation,
        presence=presence.outcome,
        working_dir=inner.working_dir,
        tmux_name=tmux_name,
        reuse_session_id=inner.reuse_session_id,
        label=inner.label,
        agent_type=agent_type,
        detail=_recreate_sentence(inner.conversation, inner.working_dir),
    )


def _recreate_sentence(conversation: str, working_dir: Optional[str]) -> str:
    """The one sentence a recreate plan shows, with its continuity clause.

    Description: written here rather than reused from the imported path
      because the two say different true things - that path's session
      never had a tmux, this one's had one and lost it, and the user is
      about to lose its scrollback. The CONTINUITY clause is the half
      that must never be softened: a session coming back without its
      history has to say so in the same breath as the offer.
    Inputs: conversation (str) - one of the three conversation words.
      working_dir (str | None) - the measured spelling.
    Output: str.
    Example: _recreate_sentence('resumed', '/tmp/x')
    """
    where = f" in {working_dir!r}" if working_dir else ""
    if conversation == CONVERSATION_RESUMED:
        tail = "on the same conversation"
    elif conversation == CONVERSATION_NONE_RECORDED:
        tail = (
            "WITHOUT its history, because no conversation is recorded on "
            "this row"
        )
    else:
        tail = (
            "and nothing claims to resume its history, because the "
            "conversation could not be determined"
        )
    return (
        f"this session's tmux is gone, so recreating it starts a new one"
        f"{where} on the same record, {tail}. its old scrollback does not "
        "come back."
    )


def as_respawn_plan(plan: RecreatePlan) -> RespawnPlan:
    """Render a recreate plan in the pane path's own shape.

    Description: lets the recreate preview answer with the SAME response
      model the picker already renders, so the client needs a second URL
      and not a second renderer. ``kills_live_pane`` is False BY
      CONSTRUCTION and is not a parameter: this path only ever runs when
      the tmux session was measured absent, so there is no live pane, and
      a settable field here would be a route to ``-k`` that nothing
      measured.
    Inputs: plan (RecreatePlan).
    Output: RespawnPlan.
    Example: as_respawn_plan(plan).kind  # 'recreate'
    """
    return RespawnPlan(
        kind=plan.kind,
        command=plan.command,
        detail=plan.detail,
        chosen=bool(plan.agent_type),
        conversation=plan.conversation,
        kills_live_pane=False,
    )


def _row_id(row: Mapping[str, Any]) -> Optional[int]:
    """The row's integer primary key, or None when it is not an int.

    Inputs: row (Mapping). Output: int | None.
    """
    value = row.get("id")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _str(value: Any) -> Optional[str]:
    """A non-empty stripped string, or None.

    Inputs: value (Any). Output: str | None.
    """
    if value is None:
        return None
    text = str(value).strip()
    return text or None
