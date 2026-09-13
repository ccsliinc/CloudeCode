"""Project an attention verdict onto the eight status names the UI paints.

THE EIGHT STATE NAMES STAY EIGHT. This module adds none. The resolver
answers four states with a reason each, and every one of those pairs maps
onto a name ``src.core.session_status`` already defines and every surface
in both frontends already renders. A ninth name would mean a ninth hue, a
new LED branch in two trees and a drift test to keep them identical.

THE MAPPING, AND WHERE EACH LINE COMES FROM:

===========================  ==========================================
verdict                      status
===========================  ==========================================
``unknown(pane_dead)``       ``dead``
``needs_user(question)``     ``question``
``needs_user(permission)``   ``question``
``needs_user(plan_approval)``  ``question``
``needs_user(input)``        ``notice``
``busy(subagents)``          ``working_subagent``
``busy(queued_reinvoke)``    ``working_subagent``
``busy(streaming|tool|shell)``  ``working``
``done_idle``                ``finished_unread`` or ``idle``
``unknown(anything else)``   ``unknown``
===========================  ==========================================

``done_idle`` DOES NOT PICK BETWEEN THE LAST PAIR ITSELF. ``idle`` and
``finished_unread`` are one session at rest seen through one flag, and
``session_status.derive_read_state`` is the single place that flag is
applied. Re-deriving it here would give the project a second half-rule,
which is exactly the defect that function was written to kill: a
one-directional derivation is a cache, not a derivation.

``unknown`` IS NEVER PAINTED AS ``idle``. The only tmux answer this
module will let override an ``unknown`` verdict is ``dead``, because
death is measured. Letting tmux's ``idle`` through would turn "nothing
readable said anything" into "this session is finished", which is the
false green the whole package exists to remove.
"""

from __future__ import annotations

from typing import Dict

from src.core.attention.evidence import (
    REASON_INPUT,
    REASON_PANE_DEAD,
    REASON_PERMISSION,
    REASON_PLAN_APPROVAL,
    REASON_QUESTION,
    REASON_QUEUED_REINVOKE,
    REASON_SHELL,
    REASON_STREAMING,
    REASON_SUBAGENTS,
    REASON_TOOL,
    STATE_BUSY,
    STATE_DONE_IDLE,
    STATE_NEEDS_USER,
    TIER_NONE,
    TIER_PANE,
    TIER_REGISTRY,
    TIER_TMUX,
    TIER_TRANSCRIPT,
    AttentionVerdict,
)
from src.core.session_status import (
    STATUS_DEAD,
    STATUS_IDLE,
    STATUS_NOTICE,
    STATUS_QUESTION,
    STATUS_UNKNOWN,
    STATUS_WORKING,
    STATUS_WORKING_SUBAGENT,
    derive_read_state,
)
from src.core.session_status_source import (
    STATUS_SOURCE_NONE,
    STATUS_SOURCE_PANE,
    STATUS_SOURCE_REGISTRY,
    STATUS_SOURCE_TMUX,
    STATUS_SOURCE_TRANSCRIPT,
)

#: Which hue each ``needs_user`` reason paints. An unlisted reason paints
#: ``question``: the STATE was measured, only the shade is a fallback,
#: and the fallback is the one that fails toward the human.
_NEEDS_USER_STATUS: Dict[str, str] = {
    REASON_QUESTION: STATUS_QUESTION,
    REASON_PERMISSION: STATUS_QUESTION,
    REASON_PLAN_APPROVAL: STATUS_QUESTION,
    REASON_INPUT: STATUS_NOTICE,
}

#: Which hue each ``busy`` reason paints. An unlisted reason paints
#: ``working``, the busy shade that claims the least.
_BUSY_STATUS: Dict[str, str] = {
    REASON_SUBAGENTS: STATUS_WORKING_SUBAGENT,
    REASON_QUEUED_REINVOKE: STATUS_WORKING_SUBAGENT,
    REASON_STREAMING: STATUS_WORKING,
    REASON_TOOL: STATUS_WORKING,
    REASON_SHELL: STATUS_WORKING,
}

#: Which ``status_source`` token each tier reports.
_TIER_SOURCES: Dict[str, str] = {
    TIER_REGISTRY: STATUS_SOURCE_REGISTRY,
    TIER_TRANSCRIPT: STATUS_SOURCE_TRANSCRIPT,
    TIER_PANE: STATUS_SOURCE_PANE,
    TIER_TMUX: STATUS_SOURCE_TMUX,
    TIER_NONE: STATUS_SOURCE_NONE,
}


def to_display(
    verdict: AttentionVerdict, *, unread: bool, tmux_status: str
) -> str:
    """Which of the eight status names does this verdict paint?

    Description: PURE and TOTAL. Every return value is a constant from
      ``src.core.session_status``; nothing here invents a name. The rest
      pair is resolved by ``derive_read_state`` rather than by an ``if``
      on the flag, so this module has no opinion about what unread means.
    Inputs:
      verdict: the resolver's answer.
      unread: the session's persisted unread flag, as MEASURED by the
        caller. Keyword-only, matching ``derive_read_state``.
      tmux_status: the tmux-derived status already on the row. Consulted
        for exactly one value, ``dead``, and only when the verdict is
        ``unknown``: an unmeasured session must never borrow tmux's
        ``idle``.
    Output:
      str - one of ``dead``, ``question``, ``notice``, ``working``,
      ``working_subagent``, ``finished_unread``, ``idle``, ``unknown``.
    Example:
      to_display(v, unread=True, tmux_status='running') -> 'question'
    """
    if verdict.state == STATE_DONE_IDLE:
        return derive_read_state(STATUS_IDLE, unread=unread)
    if verdict.state == STATE_NEEDS_USER:
        return _NEEDS_USER_STATUS.get(verdict.reason, STATUS_QUESTION)
    if verdict.state == STATE_BUSY:
        return _BUSY_STATUS.get(verdict.reason, STATUS_WORKING)
    if verdict.reason == REASON_PANE_DEAD or tmux_status == STATUS_DEAD:
        return STATUS_DEAD
    return STATUS_UNKNOWN


def status_source_for(verdict: AttentionVerdict) -> str:
    """Which ``status_source`` token names the tier that decided this.

    Description: PURE. The token is what ``/sessions/list`` reports and
      what a support question is answered from, so a tier this module
      does not recognise answers ``none`` rather than guessing: "we do
      not know where this came from" is a fact, and naming the wrong
      source is not.
    Inputs: verdict (AttentionVerdict).
    Output: str - ``registry``, ``transcript``, ``pane``, ``tmux`` or
      ``none``.
    Example: status_source_for(v) -> 'registry'
    """
    return _TIER_SOURCES.get(verdict.tier, STATUS_SOURCE_NONE)
