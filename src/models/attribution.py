"""Binding a transcript nobody claimed to a project, and declining to."""

from typing import Optional, List
from pydantic import BaseModel, Field


class UnattributedSession(BaseModel):
    """One live tmux session the evidence ladder could not attribute.

    THE HINTS ARE WORDS, NOT A SCORE. Name shape and working directory
    are rendered as sentences the user can weigh - "its name matches the
    auto-generated form Cloude Code uses" - rather than folded into a
    confidence number that looks authoritative and cannot be checked.
    They are display only and never decided anything.
    """

    tmux_name: str = Field(..., description="The live tmux session name")
    epoch: Optional[int] = Field(
        default=None,
        description=(
            "tmux #{session_created}. None when the instance could not "
            "be dated, which is why some sessions cannot be answered for"
        ),
    )
    # The user-facing label for this instance, when the stored row
    # carries one. Usually None here by the nature of the question - the
    # ladder could not attribute these - but a row WITH a title is
    # exactly the one the user has the best chance of recognising, and
    # showing them an internal handle instead of the name they typed
    # makes recognition harder. None falls back to ``tmux_name``, which
    # is what this surface always rendered.
    label: Optional[str] = Field(
        default=None,
        description=(
            "User-facing label for this instance (sessions.title), or "
            "None. Falls back to tmux_name when None."
        ),
    )
    hints: List[str] = Field(
        default_factory=list,
        description="Tier 5 and 6 sentences. Display only, never a verdict",
    )
    reason: str = Field(
        ...,
        description=(
            "'no_admissible_evidence' (every tier was evaluated and none "
            "hit) or 'could_not_evaluate' (a tier could not be measured). "
            "NEVER collapsed into one bucket: only the second names a "
            "broken measurement"
        ),
    )


class SessionAttributionPrompt(BaseModel):
    """``GET /sessions/attribution-prompt`` - the Stage C question set.

    THREE OUTCOMES in ``state``:
      'none'        the ladder ran and left nothing to ask about.
      'pending'     there are sessions to ask about; ``sessions`` lists
                    them, itemised.
      'unavailable' the datastore could not be read, so whether there is
                    anything to ask CANNOT BE DETERMINED. Never rendered
                    as 'none' - an empty prompt and an unreadable one look
                    identical to a user and mean opposite things.
    """

    state: str = Field(..., description="'none' | 'pending' | 'unavailable'")
    sessions: List[UnattributedSession] = Field(default_factory=list)
    notice: Optional[str] = Field(
        default=None,
        description=(
            "The sentence above the list. Present only when there is "
            "something to act on, so its presence means act"
        ),
    )


class AttributionDeclineRequest(BaseModel):
    """``POST /sessions/attribution-decline`` - "leave these as external".

    A REAL ANSWER THAT IS REMEMBERED. It writes ``user_declined_at`` and
    leaves ``origin`` alone, because the row already says ``observed``
    and without the stamp the answer would be indistinguishable from
    never having been asked - so the prompt would return on every boot.
    """

    tmux_names: List[str] = Field(
        ..., description="The tmux session names the user left external"
    )


class AttributionDeclineResponse(BaseModel):
    """What the decline actually recorded, per session, never a bare count."""

    declined: List[str] = Field(default_factory=list)
    not_eligible: List[str] = Field(
        default_factory=list,
        description=(
            "Names whose row is not 'observed', or was already declined. "
            "Reported rather than counted as success"
        ),
    )
    unknown: List[str] = Field(
        default_factory=list,
        description="Names with no stored row at all",
    )
