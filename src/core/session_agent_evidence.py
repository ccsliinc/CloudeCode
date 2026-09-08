"""Which of the two ``agent_type`` values a live session should be believed on.

A LIVE session has two sources for "what is running in this pane", and
until now the weaker one won.

  the in-memory ``Session``   set at launch, or - for an ADOPTED session -
                              set from a scrollback FINGERPRINT, with
                              ``agent_type_via_fingerprint=True``
  the datastore row           ``sessions.agent_type``: the wrapper id the
                              launcher chose and executed

``SessionManager._session_info_for`` read the row only when the in-memory
value was EMPTY. That is the right rule for an empty value and the wrong
one for a guessed value: after a server restart every still-running
session is re-attached through the ADOPT path, which fingerprints the
pane and stores the bare family token it finds. So a session the app had
launched as ``claude-chrome`` came back holding the fingerprint's
``claude`` and rendered ``~claude`` - a dashed GUESS pill - while the row
next to it recorded the exact wrapper. Measured on the owner's box
2026-09-08: row 43, ``agent_type='claude-chrome'``,
``agent_family_source='launched'``, painted as a guess.

A GUESS MUST NEVER OUTRANK A RECORD. That is the whole content of this
module.

WHY A NON-BLANK ROW ``agent_type`` USED TO BE TAKEN AS A RECORD, AND WHY
THE ROW'S SOURCE IS NOW READ. The original rule was "nothing writes an
inference into that column": the fingerprint write path
(``session_agent_provenance.persist_fingerprint_family``) sets
``agent_family`` and ``agent_family_source`` and deliberately leaves
``agent_type`` alone, so a value in that column could only have come from
a launch decision, and consulting the source would have been a second
gate that could only ever agree with the first.

PUNCHLIST 3 ENDED THAT PREMISE. ``session_agent_infer_apply`` now writes
a value read out of the pane's own process tree into
``sessions.agent_type``, for the 27-of-40 population that was launched as
a bare shell and then had a claude typed into it by hand. That value is a
GUESS, and it is textually identical to a launched one - exactly the
condition ``from_fingerprint`` exists for. So the row's
``agent_family_source`` IS consulted here now, for one purpose only:
to decide whether the row rung's answer renders as a fact or as a guess.
It never changes WHICH rung answers. A caller that cannot supply the
source gets the old behaviour, which is right for every writer that
predates the inference.

WHAT THIS DOES NOT DO. It does not invent a value. Both sources empty
answers ``None`` with basis ``none``, which
``resolve_family_for_display`` then renders as "unknown family" - the
honest outcome for the sessions on this machine whose row genuinely
records no agent, and one that must not be papered over here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from src.core.db_models import SESSION_FAMILY_SOURCE_INFERRED_PROCESS

#: This process launched the session and remembers what it ran.
BASIS_MEMORY_LAUNCH = "memory_launch"
#: The datastore row records the wrapper a launch chose.
BASIS_RECORDED_ROW = "recorded_row"
#: The row carries a value this app INFERRED from the pane's process
#: tree rather than one it launched. Still the row rung - the same value,
#: reached the same way - but carried out as a guess.
BASIS_RECORDED_ROW_INFERRED = "recorded_row_inferred"
#: Nothing was recorded; a scrollback scan is all there is.
BASIS_MEMORY_FINGERPRINT = "memory_fingerprint"
#: Neither source said anything. NOT the same as "no agent is running".
BASIS_NONE = "none"


@dataclass(frozen=True)
class AgentEvidence:
    """The ``agent_type`` to display, and how strong the claim behind it is.

    Description: read ``agent_type`` together with ``from_fingerprint``;
      the second is what keeps a guess from rendering identically to a
      fact downstream. ``basis`` names which rung answered, for logging
      and for tests that need to prove WHICH source won rather than only
      that the strings matched.
    Inputs (constructor): agent_type (str | None) - the value to resolve
      a family and a wrapper from. from_fingerprint (bool) - True only
      when the value came from a scrollback scan. basis (str) - one of
      the four ``BASIS_*`` constants in this module.
    Output: an AgentEvidence instance.
    Example: AgentEvidence("claude-chrome", False, BASIS_RECORDED_ROW)
    """

    agent_type: Optional[str]
    from_fingerprint: bool
    basis: str
    from_process: bool = False


def choose_agent_evidence(
    *,
    memory_agent_type: Optional[str],
    memory_from_fingerprint: bool,
    row_agent_type: Optional[str],
    row_family_source: Optional[str] = None,
) -> AgentEvidence:
    """Pick the stronger of the two ``agent_type`` sources for a live session.

    Description: a four-rung ladder, strongest first. The order is the
      point; the values themselves are passed through untouched.

      1. An in-memory value this process did NOT fingerprint. The launcher
         chose it and ran it in this very process - nothing is closer to
         the truth.
      2. A non-blank datastore ``agent_type``. Usually a recorded launch
         decision, so it BEATS a fingerprint even though the fingerprint
         is more recent. When ``row_family_source`` says
         ``inferred_process`` the SAME rung answers with the SAME value,
         carried out as a guess (``from_process=True``, basis
         :data:`BASIS_RECORDED_ROW_INFERRED`) - a process read is a
         stronger guess than a scrollback scan, which is why it still
         outranks rung 3, and it is a guess, which is why it does not
         render like rung 2's usual answer.
      3. The in-memory value, which by elimination was fingerprinted.
         Carried through with ``from_fingerprint=True`` so it renders as
         the guess it is.
      4. Nothing. ``None`` with ``from_fingerprint=False``: not having
         looked is not the same as having looked and found no agent, and
         a "guessed nothing" would be a contradiction.
    Inputs:
      memory_agent_type (str | None) - ``Session.agent_type``.
      memory_from_fingerprint (bool) -
        ``Session.agent_type_via_fingerprint``.
      row_agent_type (str | None) - ``sessions.agent_type`` for this
        session's row, or None when there is no row / it could not be
        read. A blank string is treated as absent.
      row_family_source (str | None) - ``sessions.agent_family_source``
        on the SAME row. Optional: a caller that does not read it gets
        the pre-inference behaviour, in which every row value is a
        record. Never used to select a rung, only to label one.
    Output: AgentEvidence.
    Example:
      choose_agent_evidence(memory_agent_type="claude",
                            memory_from_fingerprint=True,
                            row_agent_type="claude-chrome").agent_type
        -> 'claude-chrome'
    """
    memory = (memory_agent_type or "").strip()
    row = (row_agent_type or "").strip()

    if memory and not memory_from_fingerprint:
        return AgentEvidence(memory_agent_type, False, BASIS_MEMORY_LAUNCH)

    if row:
        if (row_family_source or "").strip() == SESSION_FAMILY_SOURCE_INFERRED_PROCESS:
            return AgentEvidence(
                row_agent_type,
                False,
                BASIS_RECORDED_ROW_INFERRED,
                from_process=True,
            )
        return AgentEvidence(row_agent_type, False, BASIS_RECORDED_ROW)

    if memory:
        return AgentEvidence(memory_agent_type, True, BASIS_MEMORY_FINGERPRINT)

    return AgentEvidence(None, False, BASIS_NONE)
