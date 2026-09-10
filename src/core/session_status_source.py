"""Where a session's status came from, so measured and inferred are told apart.

``activity_status`` says WHAT a session is doing. It does not say how we
know, and until now nothing did - a ``working`` fed by a live hook stream
and an ``idle`` inferred from a file on disk rendered as the same word,
with the same confidence, on the same row. That is the false-green shape
this project keeps removing: an answer that reads exactly as strong as
its weakest possible provenance.

FIVE SOURCES, IN DESCENDING STRENGTH OF EVIDENCE:

  ``hook``        Claude Code's own lifecycle hooks are live for this
                  session this process run. The agent said what it was
                  doing; nothing was inferred.
  ``transcript``  Derived from the conversation's transcript file - its
                  mtime, or the last decidable record in its tail. A
                  MEASUREMENT of a file, not a statement by the agent.
  ``seed_row``    Restored from ``sessions.activity_state``: a record of
                  what was true when it was written, judged still worth
                  something by ``activity_persist.restore_state``.
  ``tmux``        tmux alone: a dead pane, a bare shell, or the honest
                  ``unknown`` that a non-shell foreground process earns.
  ``none``        Nothing answered. Reported rather than left blank so a
                  reader can tell "not measured" from "the field is
                  missing from this payload".

IT NEVER CHANGES A COLOR. The client renders this in the tooltip only
(``via hooks`` / ``via transcript``). A source is provenance, not state,
and letting it tint the LED would give one status two appearances and
undo the single-vocabulary work the light rests on.
"""

from __future__ import annotations

from typing import Optional

#: Live hook signal from Claude Code's own lifecycle hooks.
STATUS_SOURCE_HOOK: str = "hook"

#: Derived from the conversation transcript (mtime, or its tail records).
STATUS_SOURCE_TRANSCRIPT: str = "transcript"

#: Restored from the session's own instance row.
STATUS_SOURCE_SEED_ROW: str = "seed_row"

#: tmux's own pane classification and nothing else.
STATUS_SOURCE_TMUX: str = "tmux"

#: Nothing answered.
STATUS_SOURCE_NONE: str = "none"

#: Every legal value, for validation and for tests that must fail when a
#: sixth is added without being thought about.
ALL_STATUS_SOURCES: frozenset[str] = frozenset(
    {
        STATUS_SOURCE_HOOK,
        STATUS_SOURCE_TRANSCRIPT,
        STATUS_SOURCE_SEED_ROW,
        STATUS_SOURCE_TMUX,
        STATUS_SOURCE_NONE,
    }
)


def source_for_seed_rung(rung: Optional[str]) -> str:
    """Which source a seed ladder rung reports as.

    Description: the ONE place the seed ladder's vocabulary
      (``session_status_seed.SEED_RUNG_*``) is translated into this
      module's, so the two cannot drift. Imported rather than re-spelled
      by every caller. An unrecognised rung answers
      :data:`STATUS_SOURCE_NONE` rather than raising - a status must
      never be able to break a listing, and "not measured" is the honest
      reading of a rung nobody here recognises.
    Inputs: rung (str | None) - a ``SEED_RUNG_*`` value.
    Output: str - one of :data:`ALL_STATUS_SOURCES`.
    Example: source_for_seed_rung('transcript') -> 'transcript'
    """
    from src.core.session_status_seed import (
        SEED_RUNG_ROW,
        SEED_RUNG_TRANSCRIPT,
    )

    if rung == SEED_RUNG_ROW:
        return STATUS_SOURCE_SEED_ROW
    if rung == SEED_RUNG_TRANSCRIPT:
        return STATUS_SOURCE_TRANSCRIPT
    return STATUS_SOURCE_NONE
