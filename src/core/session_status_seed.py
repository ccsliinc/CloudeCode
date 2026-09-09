"""Seed a session's status from evidence that OUTLIVES the process.

WHAT WENT WRONG, MEASURED ON LIVE 2026-09-08 22:24Z. Nineteen live panes,
thirteen of them painting ``unknown``. ``SessionActivityTracker`` is an
in-memory dict that nothing hydrates at boot or at adopt, so after a
server restart ``resolve()`` finds no signal and falls to
``map_tmux_fallback``, which for a pane running claude answers
``unknown`` - correctly, because tmux cannot tell a thinking agent from a
resting one. Ten of the thirteen had NEVER fired a hook and never will:
they were started by hand, without the hook environment, and their
transcripts' last assistant turns are dated 2026-07-16 and 2026-08-24.
They have been sitting at an idle prompt for weeks and the light could
not say so. The owner's complaint, verbatim: "on the homepage and sidebar
many status unknown."

WHAT THIS MODULE MAY AND MAY NOT CLAIM. It may claim REST, from evidence
that is durable and dated. It may never claim WORK. That asymmetry is the
whole design and it is not a conservatism knob:

  - Rest is SELF-EVIDENCING. A conversation whose last record is the end
    of a turn is at rest until something appends to it, and nothing has.
    The evidence does not rot by sitting still, which is exactly why
    ``activity_persist.PERISHABLE`` excludes ``idle``.
  - Work is a claim about RIGHT NOW and it needs a heartbeat to expire
    it. Hooks carry one (``WORKING_HEARTBEAT_TIMEOUT_SECONDS``); a file
    on disk does not. A ``working`` seeded from a transcript could never
    be expired by anything, so it would be a permanent lie the moment it
    was wrong - the identical defect that made a raw tmux ``running``
    map to ``working`` and paint fifteen sessions busy on no evidence.

So the in-flight verdict on rung B seeds NOTHING and leaves the session
``unknown``. Under-claiming is this module's safe direction, the same way
it is ``session_activity``'s.

QUALIFIED 2026-09-09, AND THE QUALIFICATION IS EXACT. The paragraph above
argues against claiming work from the CONTENT of a record, which says what
happened and carries no clock of its own. It is not an argument against
claiming work from a TIMESTAMP. A transcript's mtime is a timestamp, so a
claim built on it can be expired against the same
``WORKING_HEARTBEAT_TIMEOUT_SECONDS`` a hook heartbeat uses, and it is:
:class:`StatusSeed` now carries ``expires_at`` and ``display_state``
refuses a seed whose claim has run out. That is RUNG ZERO below, owned by
``session_transcript_status``, and it is the only rung that may say
``working``. Everything else in this file is unchanged and still may not.

A LIVE HOOK ALWAYS WINS, IMMEDIATELY. The seam consults a seed only while
``SessionActivityTracker.hooks_seen`` is False, so the first hook event of
this process retires the seed for good with no expiry to wait out and no
value to clear. That is also what makes seeding idempotent: a seed is a
cached READING of durable evidence, not an event applied to a state
machine, so re-deriving it any number of times converges on the same
answer and re-deriving it after a hook has landed changes nothing.

THE RUNGS, IN ORDER. Each names what it MEASURED; none of them rounds a
missing measurement up to an answer.

  0. THE TRANSCRIPT AS IT STANDS RIGHT NOW - its mtime, and the newest
     turn end in its tail - resolved by ``session_transcript_status`` and
     passed in as ``live``. It is FIRST because it is the only rung that
     measures the present: rungs A and B are both records of what was
     true when something last wrote. It is the only rung that can say
     ``working``, the only one that can set an unread flag, and the only
     one that carries an expiry.
  A. THE ROW. ``sessions.activity_state`` / ``activity_state_at``, judged
     by ``activity_persist.restore_state`` - imported, never rebuilt, so
     the staleness horizon has one definition. A stale PERISHABLE state
     (``working``/``question``/``notice``) is refused: it was true once
     and says nothing about now. A stale ``idle`` / ``finished_unread``
     is kept, because a session at rest does not stop being at rest by
     sitting still. Read EPOCH-SCOPED here: two rows can carry one tmux
     name at once (a stopped conversation and its live successor), and a
     name-scoped read picks whichever epoch sorts newest, which is not
     the same question.
  B. THE TRANSCRIPT TAIL. The last decidable record of the conversation
     the row is bound to, read through the ONE bounded reader this
     codebase has (``claude_title_sync.read_tail_records``). Rest-shaped
     with nothing after it seeds ``idle`` at that record's timestamp;
     in-flight seeds nothing; an empty window seeds nothing; a MEASURED
     absent transcript seeds nothing and an UNREADABLE one seeds nothing
     for a different reason, named separately.
  C. A BARE SHELL. Already ``idle`` before this module is reached -
     ``resolve_pane_status`` maps a known shell command straight to
     ``idle`` and ``map_tmux_fallback`` passes it through. Nothing here
     changes it, and the seam never fires on it, because a bare shell
     never resolves to ``unknown`` in the first place.
  D. OTHERWISE ``unknown``. A real answer, and the one this module
     returns whenever every rung above declined.

WHY THE PERIODIC RE-SEED CANNOT CLAIM WORK EITHER, and why it exists.
A hand-started claude has no hook plumbing at all, so its light would
freeze at whatever the first seed said for the life of the process. The
seam therefore re-derives rung B every
:data:`SEED_REFRESH_INTERVAL_SECONDS` (about 0.3 ms per session against
the real corpus - the same bounded 64 KB tail read the title sync already
pays on every hook event). Re-deriving can move a session from ``idle``
back to ``unknown`` when the transcript grows an in-flight record, which
is the honest direction: a growing transcript is evidence the rest claim
has expired, NOT evidence of work. It still cannot say ``working``,
because a poll every sixty seconds is not a heartbeat - but rung 0 can,
because the claim it makes is expired by the FILE's timestamp rather than
by the poll's. A session with live hook signal is never re-seeded; hooks
are its truth.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from src.core.session_status import (
    STATUS_FINISHED_UNREAD,
    STATUS_IDLE,
)

# Re-exported so a caller has ONE import for the whole ladder, the way
# ``session_boot_readopt`` re-exports its plan's vocabulary.
from src.core.session_status_seed_records import (  # noqa: F401
    IN_FLIGHT_STOP_REASONS,
    LOCAL_COMMAND_MARKERS,
    LOCAL_COMMAND_SUBTYPE,
    REST_STOP_REASONS,
    REST_SYSTEM_SUBTYPES,
    TAIL_ABSENT,
    TAIL_AT_REST,
    TAIL_IN_FLIGHT,
    TAIL_NO_MARKER,
    TAIL_UNREADABLE,
    TranscriptRest,
    classify_record,
    classify_tail_records,
    is_local_command_envelope,
    parse_timestamp,
)

# ---------------------------------------------------------------------
# How often rung B is re-derived for a session with no live hook signal.
# ---------------------------------------------------------------------

#: Seconds between two transcript reads for one session. Sixty is chosen
#: against the cost, not against a desired latency: the bounded tail read
#: is 0.274 ms median against a 244 MB transcript, so the whole fleet of
#: twenty costs about 6 ms a minute. It is deliberately NOT tied to
#: ``WORKING_HEARTBEAT_TIMEOUT_SECONDS`` - that constant expires a claim
#: about live work, and nothing here makes one.
SEED_REFRESH_INTERVAL_SECONDS: int = 60

# ---------------------------------------------------------------------
# Which rung answered. Reported so a log line says what was measured
# rather than only what was concluded.
# ---------------------------------------------------------------------

#: Rung A: the durable state on the session's own instance row.
SEED_RUNG_ROW: str = "row"

#: Rung B: the last decidable record of the bound transcript.
SEED_RUNG_TRANSCRIPT: str = "transcript"

#: No rung answered. The session stays whatever it already was.
SEED_RUNG_NONE: str = "none"

@dataclass(frozen=True)
class StatusSeed:
    """A status derived from durable evidence, or the refusal to derive one.

    Description: the return of :func:`resolve_status_seed`. Frozen
      because a caller that could edit it could route around the ladder.

      - ``state``: the activity status to seed, or None when no rung
        answered. Only ever a resting state - see the module docstring.
      - ``at``: when the evidence was dated. Carried for logs and for
        callers that want to reason about the age of a claim; the display
        does not depend on it.
      - ``rung``: which rung answered, one of the ``SEED_RUNG_*``
        constants.
      - ``detail``: a plain sentence naming what was measured.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    state: Optional[str] = None
    at: Optional[datetime] = None
    rung: str = SEED_RUNG_NONE
    detail: Optional[str] = None
    #: When ``state`` stops being supportable, or None when it does not
    #: rot. Only the transcript ladder's ``working`` rung sets this: it
    #: is the one seeded state that is a claim about NOW, and a cached
    #: reading must not be able to stretch the window it was taken in.
    #: A resting state never carries one, because a conversation does
    #: not stop resting by sitting still.
    expires_at: Optional[datetime] = None

    @property
    def seeds(self) -> bool:
        """True only when a rung actually answered.

        Description: the one-line test the seam gates on, so a refusal
          can never be applied as a status.
        Inputs: n/a.
        Output: bool.
        Example: resolve_status_seed(...).seeds
        """
        return bool(self.state)


def resolve_status_seed(
    *,
    row_state: Optional[str],
    row_state_at: Optional[str],
    tail: Optional[TranscriptRest] = None,
    live: Optional["TranscriptStatus"] = None,
    now: Optional[datetime] = None,
) -> StatusSeed:
    """The status a session's durable evidence supports, or a refusal.

    Description: PURE - the whole rung order lives here so the seam that
      calls it holds no policy. Rung A is the row, judged by
      ``activity_persist.restore_state`` (imported, never rebuilt, so the
      staleness horizon has exactly one definition). Rung B is the
      transcript tail, and only its ``at_rest`` verdict answers. Anything
      else returns a seed that does not seed, with a sentence naming
      which rung declined and why.

      NOTHING HERE CAN RETURN ``working``. Rung A cannot, because
      ``restore_state`` refuses a stale perishable state and a fresh one
      is a live hook fact rather than a seed. Rung B cannot, by
      construction. See the module docstring.
    Inputs: row_state (str | None) - ``sessions.activity_state`` for THIS
      instance. row_state_at (str | None) - ``sessions.activity_state_at``.
      tail (TranscriptRest | None) - rung B's measurement, or None when
      the transcript was not consulted. now (datetime | None) -
      injectable clock.
    Output: StatusSeed.
    Example:
      resolve_status_seed(row_state='idle', row_state_at=stamp).state -> 'idle'
    """
    from src.core.activity_persist import restore_state

    # RUNG ZERO, AND IT COMES FIRST BECAUSE IT IS THE ONLY MEASUREMENT OF
    # NOW. ``live`` is ``session_transcript_status``'s verdict for a
    # session with no hook signal: the transcript's own mtime and the
    # newest turn end in its tail. Everything below it is a RECORD OF
    # THEN - the row was written by a process that has since exited, and
    # the tail's ``at_rest`` says only that nothing has been appended
    # since. A measurement of the last two minutes outranks both, and
    # unlike them it EXPIRES: the ``working`` it can produce carries
    # ``expires_at`` and dies with the heartbeat window whatever else
    # happens. That is the objection the module docstring raises against
    # a file-derived working claim, answered rather than argued with -
    # see ``session_transcript_status`` on why an mtime is a timestamp
    # and a tail record is not.
    if live is not None and live.answers:
        return StatusSeed(
            state=live.state,
            at=live.at,
            rung=SEED_RUNG_TRANSCRIPT,
            detail=live.detail,
            expires_at=live.expires_at,
        )

    restored, reason = restore_state(row_state, row_state_at, now=now)
    if restored:
        return StatusSeed(
            state=restored,
            at=parse_timestamp(row_state_at),
            rung=SEED_RUNG_ROW,
            detail=(
                f"the session's own instance row records {restored!r} and "
                "that record is still worth something"
            ),
        )

    if tail is None:
        return StatusSeed(
            rung=SEED_RUNG_NONE,
            detail=(
                f"the row answered nothing ({reason}) and the transcript "
                "was not consulted"
            ),
        )

    if tail.at_rest:
        return StatusSeed(
            state=STATUS_IDLE,
            at=tail.at,
            rung=SEED_RUNG_TRANSCRIPT,
            detail=tail.detail,
        )

    return StatusSeed(
        rung=SEED_RUNG_NONE,
        detail=(
            f"the row answered nothing ({reason}) and the transcript said "
            f"{tail.verdict}"
        ),
    )


def display_state(
    seed: StatusSeed,
    *,
    unread: bool = False,
    now: Optional[datetime] = None,
) -> Optional[str]:
    """What a seed renders as, given the session's unread flag.

    Description: mirrors the tail of ``SessionActivityTracker.resolve``
      exactly - a session at rest that nobody has looked at is
      ``finished_unread``, not ``idle``. It READS the unread flag and
      never writes one: unread is keyed on the tmux INSTANCE and owned
      elsewhere, and nothing in this module may move it.
      AN EXPIRED SEED RENDERS NOTHING. A seed is cached for up to
      :data:`SEED_REFRESH_INTERVAL_SECONDS`, so a claim about NOW - the
      transcript ladder's ``working`` - could otherwise be served for a
      minute after the window it was measured in had closed. Every
      resting seed carries no ``expires_at`` at all and is unaffected;
      only the one state that is a claim about right now can go stale
      here, and when it does this returns None and the caller keeps
      ``unknown``, which is the honest answer for a claim that ran out.
    Inputs: seed (StatusSeed). unread (bool) - the session's persisted
      unread flag, supplied by the caller. now (datetime | None) -
      injectable clock, used only to judge ``expires_at``.
    Output: str | None - the status to render, or None when the seed
      declined to answer or its claim has expired.
    Example: display_state(StatusSeed('idle'), unread=True) -> 'finished_unread'
    """
    if not seed.seeds:
        return None
    if seed.expires_at is not None:
        stamp = now or datetime.now(timezone.utc)
        if stamp > seed.expires_at:
            return None
    if seed.state == STATUS_IDLE and unread:
        return STATUS_FINISHED_UNREAD
    return seed.state
