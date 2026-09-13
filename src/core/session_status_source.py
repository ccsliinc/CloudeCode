"""Where a session's status came from, so measured and inferred are told apart.

``activity_status`` says WHAT a session is doing. It does not say how we
know, and until now nothing did - a ``working`` fed by a live hook stream
and an ``idle`` inferred from a file on disk rendered as the same word,
with the same confidence, on the same row. That is the false-green shape
this project keeps removing: an answer that reads exactly as strong as
its weakest possible provenance.

SIX SOURCES, IN DESCENDING STRENGTH OF EVIDENCE:

  ``registry``    ``~/.claude/sessions/<pid>.json``, the file claude
                  keeps about itself and rewrites on every status
                  change. The agent's own word, read passively off disk.
  ``pane``        The rendered pane: a dialog we matched in text we
                  actually read. It can only ever say the session is
                  waiting on a human.
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

#: Claude's own session registry file, read passively off disk.
STATUS_SOURCE_REGISTRY: str = "registry"

#: A dialog matched in pane text we actually read.
STATUS_SOURCE_PANE: str = "pane"

#: Derived from the conversation transcript (mtime, or its tail records).
STATUS_SOURCE_TRANSCRIPT: str = "transcript"

#: Restored from the session's own instance row.
STATUS_SOURCE_SEED_ROW: str = "seed_row"

#: tmux's own pane classification and nothing else.
STATUS_SOURCE_TMUX: str = "tmux"

#: Nothing answered.
STATUS_SOURCE_NONE: str = "none"

#: Every legal value, for validation and for tests that must fail when a
#: seventh is added without being thought about.
#:
#: ``hook`` WAS HERE AND IS GONE, because nothing can produce it any
#: more. The listing used to report it whenever Claude Code's lifecycle
#: hooks had spoken for a session this process run; that whole tier was
#: replaced by the passive resolver in ``src/core/attention/``, which
#: reads the registry, the transcript, the pane and tmux and never a
#: hook. A token no writer can emit is a value a reader will one day
#: branch on and never reach. Both clients keep a ``via hooks`` tooltip
#: entry for it, deliberately: a browser holding a cached response from
#: before the swap still renders it correctly, and an unknown key there
#: renders no suffix rather than failing.
ALL_STATUS_SOURCES: frozenset[str] = frozenset(
    {
        STATUS_SOURCE_REGISTRY,
        STATUS_SOURCE_PANE,
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
