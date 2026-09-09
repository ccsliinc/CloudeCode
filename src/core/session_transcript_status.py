"""What a HOOKLESS session's transcript says about it right now.

MEASURED ON LIVE 2026-09-09, f77a978. Nineteen live panes; only SIX had
ever fired a hook. The other thirteen were started by hand without the
hook environment, so ``SessionActivityTracker`` will never hold a signal
for them and their light rested entirely on
``session_status_seed``'s rung B - the last decidable record of the
transcript tail - which answers ``idle`` for a finished turn and NOTHING
for a turn in flight. Three of the thirteen had touched their transcript
within the previous 36 minutes and painted exactly the same rest as the
ones last touched in July. A session doing work is the one thing a status
light exists to show, and for two thirds of the fleet it could not show
it.

THE OLD DOCSTRING'S OBJECTION WAS RIGHT, AND THIS IS WHY IT DOES NOT
APPLY HERE. ``session_status_seed`` refuses to claim ``working`` from a
file because "a file on disk carries no heartbeat, so the claim could
never be expired". That objection is about a RECORD - the content of the
tail, which says what happened and carries no clock of its own. An
mtime is not a record, it is a TIMESTAMP, and a timestamp is exactly the
thing a claim can be expired against. So the working rung here reuses
``session_activity.WORKING_HEARTBEAT_TIMEOUT_SECONDS`` verbatim: the same
120 seconds that expires a hook heartbeat expires this one, and a
transcript that stops growing stops claiming work within one window
whether or not anything else ever happens. Nothing here is permanent, and
nothing here is derived from the CONTENT of a record about the past.

THE RUNGS, IN ORDER. Newest evidence first, the same ordering
``classify_tail_records`` and ``session_startup_gate`` both use.

  1. MTIME INSIDE THE HEARTBEAT WINDOW -> ``working``. The file was
     appended to within the last :data:`WORKING_HEARTBEAT_TIMEOUT_SECONDS`
     seconds, which is a measurement of NOW and outranks every record of
     THEN. It carries ``expires_at`` so a cached reading cannot outlive
     the window it was taken in.
  2. A TURN END NEWER THAN THE ONE THIS LADDER ALREADY RECORDED ->
     ``finished_unread``, and the AUTO unread flag is claimed ONCE for
     that turn. This is the hookless stand-in for a ``Stop`` hook.
  3. A TURN END ALREADY RECORDED -> ``finished_unread`` while the unread
     flag is still set, ``idle`` once a view has cleared it. Rung 3 is
     what makes a view mean something on a hookless session.
  4. IN FLIGHT OR NOTHING DECIDABLE, WITH A STALE MTIME -> nothing. The
     conversation was mid-turn when the file was last written and that
     was more than a heartbeat ago, so neither rest nor work can be
     claimed. The caller keeps ``unknown``, which is a real answer.
  5. NO TRANSCRIPT, OR ONE THAT COULD NOT BE READ -> nothing, and the two
     are named separately because only the first is a measurement.

A bare shell never reaches any of this: ``resolve_pane_status`` maps a
known shell command straight to ``idle`` and the seam is consulted only
while the answer is still ``unknown``.

FIRST SIGHT OF A TURN END IS A BASELINE, NOT AN INSTRUCTION. This is the
load-bearing rule of rung 2 and the reason it is written as "newer than
the one already recorded" rather than "not yet recorded". The ledger is
in memory, so a server restart empties it; if a first sighting claimed,
every hookless session on the box would light up unread on every restart,
including sessions whose last turn ended in July. So the first reading
for an instance RECORDS the timestamp and claims nothing. The same rule,
for the same reason, governs ``claude_title_sync``'s first sight of a
``custom-title``.

A TURN END WITH NO READABLE TIMESTAMP IS NEVER CLAIMED, because there is
no key to make the claim idempotent on. It falls to rung 3, which paints
correctly and writes nothing.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from src.core.session_activity import WORKING_HEARTBEAT_TIMEOUT_SECONDS
from src.core.session_status import (
    STATUS_FINISHED_UNREAD,
    STATUS_IDLE,
    STATUS_WORKING,
)
from src.core.session_status_seed_records import TranscriptRest

_HEARTBEAT = timedelta(seconds=WORKING_HEARTBEAT_TIMEOUT_SECONDS)

# ---------------------------------------------------------------------
# Which rung answered. Reported so a log line and a test can name what
# was measured rather than only what was concluded.
# ---------------------------------------------------------------------

#: Rung 1: the transcript file was appended to inside the heartbeat window.
RUNG_MTIME: str = "mtime"

#: Rung 2: a turn end newer than the one already recorded for this instance.
RUNG_TURN_END_NEW: str = "turn_end_new"

#: Rung 3: the turn end this ladder already knows about.
RUNG_TURN_END_SEEN: str = "turn_end_seen"

#: Rung 4: mid-turn when last written, and that was longer ago than a
#: heartbeat. Nothing may be claimed.
RUNG_STALE_IN_FLIGHT: str = "stale_in_flight"

#: Rung 5: no transcript, or one that could not be read.
RUNG_NO_TRANSCRIPT: str = "no_transcript"


@dataclass(frozen=True)
class TranscriptStatus:
    """What one hookless session's transcript supports, or a refusal.

    Description: the return of :func:`resolve_transcript_status`. Frozen
      because it reports measurements of a file, not a plan a caller may
      edit on the way past.

      - ``state``: the activity status to show, or None when no rung
        answered (the caller keeps ``unknown``).
      - ``at``: when the deciding evidence was dated.
      - ``expires_at``: when ``state`` stops being supportable, on the
        working rung ONLY. None means the claim does not rot - a resting
        conversation does not stop resting by sitting still.
      - ``claim_turn_end_at``: the timestamp of a turn end that has just
        been seen for the FIRST time and is NEWER than the recorded one,
        so the caller must set the auto unread flag once for it. None on
        every other rung, including a first-sight baseline.
      - ``rung``: which rung answered, one of the ``RUNG_*`` constants.
      - ``detail``: a plain sentence naming what was measured.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    state: Optional[str] = None
    at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    claim_turn_end_at: Optional[datetime] = None
    rung: str = RUNG_NO_TRANSCRIPT
    detail: str = ""

    @property
    def answers(self) -> bool:
        """True only when a rung produced a status to show.

        Description: the one-line test the seam gates on, so a refusal
          can never be applied as a status.
        Inputs: n/a.
        Output: bool.
        Example: resolve_transcript_status(...).answers
        """
        return bool(self.state)


def mtime_is_fresh(
    mtime: Optional[datetime], now: datetime
) -> bool:
    """Was the transcript appended to inside the heartbeat window.

    Description: PURE. True only for an age in ``[0, heartbeat]``. A
      mtime in the FUTURE is deliberately not fresh: it is a clock
      disagreement, not a measurement of the last two minutes, and
      rounding it up to "working" would make an unexpirable claim out of
      the one input that was supposed to be expirable.
    Inputs: mtime (datetime | None) - timezone-aware file mtime.
      now (datetime) - timezone-aware clock.
    Output: bool.
    Example: mtime_is_fresh(now - timedelta(seconds=5), now) -> True
    """
    if mtime is None:
        return False
    age = now - mtime
    return timedelta(0) <= age <= _HEARTBEAT


def resolve_transcript_status(
    *,
    mtime: Optional[datetime],
    tail: Optional[TranscriptRest],
    last_turn_end_seen: Optional[datetime],
    unread: bool,
    now: datetime,
) -> TranscriptStatus:
    """The status a hookless session's transcript supports, or a refusal.

    Description: PURE - the whole rung order lives here so the seam that
      calls it holds no policy, the same split
      ``session_startup_gate`` keeps from its ledger. See the module
      docstring for the rungs and for why the working rung is allowed to
      exist here and not in ``session_status_seed``.

      IT NEVER WRITES THE UNREAD FLAG. It reports, in
      ``claim_turn_end_at``, that a claim is owed; the seam is what
      records it and what writes the flag. Keeping the write out of the
      pure half is what makes rung 2 testable without a manager, and
      what makes the "first sight is a baseline" rule a property of the
      ledger rather than a side effect hidden in a ladder.
    Inputs: mtime (datetime | None) - transcript file mtime, tz-aware.
      tail (TranscriptRest | None) - the tail verdict, or None when the
      transcript was not read at all. last_turn_end_seen (datetime |
      None) - the newest turn end this ladder has already recorded for
      THIS instance, or None on a first sighting. unread (bool) - the
      session's persisted unread flag, read and never written. now
      (datetime) - tz-aware clock.
    Output: TranscriptStatus.
    Example:
      resolve_transcript_status(mtime=now, tail=None, last_turn_end_seen=None,
                                unread=False, now=now).state -> 'working'
    """
    if mtime_is_fresh(mtime, now):
        return TranscriptStatus(
            state=STATUS_WORKING,
            at=mtime,
            # The claim expires with the file's own timestamp, not with
            # the moment it was read, so a reading served from a cache
            # cannot stretch the window it was taken in.
            expires_at=(mtime or now) + _HEARTBEAT,
            rung=RUNG_MTIME,
            detail=(
                "the conversation transcript was appended to within the "
                "last "
                f"{WORKING_HEARTBEAT_TIMEOUT_SECONDS} seconds, which is a "
                "measurement of now and expires like one"
            ),
        )

    if tail is None or not tail.at_rest:
        if tail is None:
            return TranscriptStatus(
                rung=RUNG_NO_TRANSCRIPT,
                detail=(
                    "no transcript was read for this session, so nothing "
                    "about it was measured"
                ),
            )
        return TranscriptStatus(
            rung=RUNG_STALE_IN_FLIGHT,
            detail=(
                "the transcript said "
                f"{tail.verdict} and its file has not been touched inside "
                "the heartbeat window, so neither work nor rest can be "
                "claimed"
            ),
        )

    at = tail.at
    if at is not None and last_turn_end_seen is not None and at > last_turn_end_seen:
        return TranscriptStatus(
            state=STATUS_FINISHED_UNREAD,
            at=at,
            claim_turn_end_at=at,
            rung=RUNG_TURN_END_NEW,
            detail=(
                "the transcript's newest turn end is newer than the one "
                "already recorded for this pane, so this conversation "
                "finished a turn nobody has looked at"
            ),
        )

    return TranscriptStatus(
        state=STATUS_FINISHED_UNREAD if unread else STATUS_IDLE,
        at=at,
        rung=RUNG_TURN_END_SEEN,
        detail=(
            "the transcript's newest turn end is one this ladder has "
            "already recorded, so the session is at rest and its unread "
            "flag is whatever a view last left it"
        ),
    )
