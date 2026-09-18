"""Retry a browser rename that never reached Claude, a BOUNDED number of times.

THE DEFECT THIS CLOSES. A rename typed in the browser is pushed to Claude
exactly once, by ``SessionManager._push_rename_to_claude``. If that push
is deferred or fails - the transcript is not written yet, ``--resume``
exits non-zero, the binary cannot be resolved - nothing ever runs again
for that row. The browser keeps the new name, Claude keeps the old one,
permanently. Measured on the owner's live database 2026-09-16: 4 of 941
rows carry ``title != claude_title``, one of them a session that has been
running since 2026-09-04.

``sessions.claude_title`` is the marker and it was already recorded and
already unused. This module is the thing that finally reads it.

THE HARD PART IS NOT THE RETRY, IT IS THE ORDERING. ONE NAME PER SESSION,
LAST RENAME WINS FROM EITHER SIDE. If the user renamed in the TUI after
the browser push failed, Claude's name is the newer one and a retry that
pushed the browser's name would clobber it. ``custom-title`` records carry
no timestamp - this project already documented that as the reason first
sight of a title is a baseline rather than an instruction - so there is no
clock to order the two writers by.

THE ORDERING IS ESTABLISHED BY A WITNESSED STATE, NOT BY A CLOCK, and the
lemma comes from the sync's own write rules in
:mod:`src.core.claude_title_sync_apply`:

  * ``TITLE_APPLIED`` writes BOTH columns to the same value. (When
    ``writes_visible_title`` is true it sets ``title = claude_title =
    observed``; when it is false, ``observed == current_title`` already,
    so writing ``claude_title = observed`` also makes them equal.)
  * ``TITLE_BASELINE_RECORDED`` writes ``claude_title`` ALONE.
  * A browser rename writes ``title`` ALONE.

So the pair can only become unequal two ways: a browser write after they
were equal, or a baseline write onto a row where they were never equal.
The first is orderable - the browser wrote LAST, so its name is newer.
The second is not, and that is exactly the case the project's baseline
rule already refuses to act on.

Nothing on the row says which happened, so this module WITNESSES it. The
sync pass reads both columns anyway; whenever it sees them EQUAL it
records that value as the row's agreement mark. Later, if
``claude_title`` still equals the mark and ``title`` differs, the
divergence is provably the first case: Claude's side has not moved since
the agreed instant, so the only write that can have produced the
difference is the browser's. A row with NO mark, or whose mark has been
overtaken, is REFUSED as :data:`RETRY_UNORDERED`. Refusing costs a
cosmetic mismatch the user can fix; guessing costs them a name they
typed.

BELT AND BRACES ON TOP OF THE MARK. The push is additionally gated on a
POSITIVE reading that the transcript's own newest ``custom-title`` still
equals the recorded ``claude_title`` - the sync's ``TITLE_UNCHANGED``
verdict, computed on this same pass for free. ``CUSTOM_TITLE_NO_RECORD``
does not authorise anything: a silent window is not a confirmation that
Claude still holds the recorded name. That closes the one gap the mark
alone leaves, a TUI rename whose record scrolled out of the 64 KB tail.
Measured against three real transcripts, Claude re-appends a
``custom-title`` carrying its CURRENT name on essentially every turn
(147, 352 and 506 records), so a renamed value is re-asserted at the end
of the file continuously and cannot quietly scroll away.

EVERYTHING HERE IS PURE. The ladder takes a verdict, two column values, a
mark and a clock reading, and returns a decision. The store next door
holds the marks and the seam in ``claude_title_sync_apply`` is what acts
on them, so this file can be reasoned about with no datastore, no
subprocess and no filesystem.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Optional

from src.core.claude_title_sync import (
    TITLE_APPLIED,
    TITLE_BASELINE_RECORDED,
    TITLE_NOT_MEASURED,
    TITLE_UNCHANGED,
)

# ---------------------------------------------------------------------
# The bound, and why it is this number.
# ---------------------------------------------------------------------

#: How many pushes one distinct rename may ever cost. The single measured
#: transient is the transcript appearing 2m33s after the row bound its
#: uuid (2026-09-08, 14:47:41Z to 14:50:14Z), which is the failure this
#: retry exists for. Paired with :data:`MIN_ATTEMPT_INTERVAL_SECONDS` the
#: budget spans at least four minutes, about sixty percent more than that
#: transient, and costs at most five short-lived subprocesses for the
#: life of that rename. A sixth attempt buys nothing: a push still
#: failing after four minutes is failing for a reason that does not pass
#: with time, and an unbounded retry against a deleted transcript is a
#: subprocess every few seconds forever.
MAX_PUSH_ATTEMPTS: int = 5

#: The floor between two attempts for one rename. Without it the trigger
#: (a transcript that grew) would fire the whole budget inside a single
#: busy turn, spending five attempts in seconds on a transient that needs
#: minutes.
MIN_ATTEMPT_INTERVAL_SECONDS: float = 60.0

# ---------------------------------------------------------------------
# The verdicts. SEVEN, and none of them is a synonym for another: a
# refusal that could not look, a refusal that could look and cannot
# order, and a refusal that has run out of budget are three different
# facts about a row and an operator has to be able to tell them apart.
# ---------------------------------------------------------------------

#: Push the row's ``title`` to Claude now. The ONLY verdict that acts.
RETRY_PUSH: str = "push"

#: Both sides already hold the same name. The steady state, and the
#: common case: nothing is pending and nothing is spent.
RETRY_AGREED: str = "agreed"

#: Claude's side moved on this pass, or a baseline was recorded. The sync
#: owns the row; a retry must not push a name the transcript has just
#: overruled. TERMINAL for the pending rename.
RETRY_SUPERSEDED: str = "superseded"

#: The columns disagree and which side is newer CANNOT BE ESTABLISHED -
#: no agreement was ever witnessed for this row, or the mark has been
#: overtaken. Refuses. Re-evaluated whenever ``claude_title`` moves,
#: because that is exactly when a new agreement can be witnessed.
RETRY_UNORDERED: str = "unordered"

#: Nothing was read this pass, so nothing is decided. SPENDS NO BUDGET -
#: not having been able to look is not an attempt, and charging for it
#: would leave a machine whose corpus the checker cannot see with no
#: attempts left by the time it could have tried.
RETRY_UNREADABLE: str = "unreadable"

#: :data:`MAX_PUSH_ATTEMPTS` pushes have been spent on this exact label.
#: TERMINAL. A new label resets the budget, because a new rename is a new
#: fact rather than a retry of the old one.
RETRY_EXHAUSTED: str = "exhausted"

#: A push for this label ran less than :data:`MIN_ATTEMPT_INTERVAL_SECONDS`
#: ago. Holds without spending budget; the next pass reconsiders.
RETRY_WAITING: str = "waiting"

#: The verdicts that end a pending rename for good. An operator counting
#: stuck renames counts these plus :data:`RETRY_UNORDERED`, which is
#: terminal only while the row stands still.
TERMINAL_VERDICTS = (RETRY_SUPERSEDED, RETRY_EXHAUSTED)


@dataclass(frozen=True)
class RenameMark:
    """One row's ordering frame and its retry budget.

    Description: the durable per-row ledger entry, held by
      :mod:`src.core.claude_rename_retry_store`. Frozen because it
      records what was WITNESSED; a caller that could edit it in place
      could route around the ordering rule.

      - ``agreed_title``: the value both columns held when they were last
        seen EQUAL. The ordering frame. None means no agreement has ever
        been witnessed for this row, which is a refusal, not a zero.
      - ``attempted_label``: the exact label the budget below was spent
        on. A different label means a different rename and a fresh budget.
      - ``attempts``: pushes actually spawned for ``attempted_label``.
      - ``last_attempt_at``: unix seconds of the most recent spawn, for
        the interval floor. None when nothing has been spawned.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    agreed_title: Optional[str] = None
    attempted_label: Optional[str] = None
    attempts: int = 0
    last_attempt_at: Optional[float] = None


@dataclass(frozen=True)
class RetryDecision:
    """What one retry pass decided about one row.

    Description: the return of :func:`decide_retry`.

      - ``verdict``: one of the ``RETRY_*`` constants.
      - ``label``: the name to push, on :data:`RETRY_PUSH` only.
      - ``attempts_spent``: how many pushes this label has already cost,
        so a log line can say "3 of 5" rather than "it failed again".
      - ``detail``: a plain sentence naming why.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    verdict: str
    label: Optional[str] = None
    attempts_spent: int = 0
    detail: Optional[str] = None

    @property
    def acts(self) -> bool:
        """True only when a push should actually be spawned.

        Description: the one-line test the seam gates its subprocess on,
          so no call site has to re-spell the list of refusals.
        Inputs: n/a.
        Output: bool.
        Example: decide_retry(...).acts -> False
        """
        return self.verdict == RETRY_PUSH


def _clean(value: Optional[str]) -> Optional[str]:
    """One column value as a non-empty string, or None.

    Description: a NULL column, an empty string and a string of spaces
      all mean "this row carries no name here" and must compare the same
      way, or a row whose title was cleared would read as a divergence.
    Inputs: value (str | None).
    Output: str | None.
    Example: _clean("  ") is None -> True
    """
    if value is None:
        return None
    text = value.strip()
    return text or None


def witness_agreement(
    *, title: Optional[str], claude_title: Optional[str]
) -> Optional[str]:
    """The value to record as this row's ordering frame, if any.

    Description: PURE. An agreement exists only when BOTH columns carry
      the same non-empty name. A NULL ``claude_title`` is not an
      agreement with anything - it is the "we have never seen Claude's
      side" state, which is precisely the case with no ordering - and
      neither is a NULL ``title``.

      Called on the POST-WRITE values of a sync pass, so a
      ``TITLE_APPLIED`` that has just set both columns is witnessed
      immediately. That is the main way marks come to exist, and it is
      why a healthy session acquires its ordering frame on the first pass
      that observes Claude's name at all.
    Inputs: title (str | None) - ``sessions.title``. claude_title
      (str | None) - ``sessions.claude_title``.
    Output: str | None - the agreed name, or None when there is none.
    Example: witness_agreement(title='A', claude_title='A') -> 'A'
    """
    left = _clean(title)
    right = _clean(claude_title)
    if left is not None and left == right:
        return left
    return None


def budget_for(mark: Optional[RenameMark], label: str) -> int:
    """Attempts already spent on THIS label.

    Description: PURE. A mark whose ``attempted_label`` names a different
      name reports ZERO, because the user renaming again is a new fact
      and must not inherit the exhausted budget of the name they just
      replaced. Without this rule a second rename after a first one had
      burned its five attempts would never be pushed at all.
    Inputs: mark (RenameMark | None). label (str) - the name now on the
      row.
    Output: int - attempts spent on ``label``.
    Example: budget_for(RenameMark(attempted_label='A', attempts=3), 'B')
      -> 0
    """
    if mark is None or mark.attempted_label != label:
        return 0
    return max(0, int(mark.attempts or 0))


def decide_retry(
    *,
    sync_action: str,
    title: Optional[str],
    claude_title: Optional[str],
    mark: Optional[RenameMark],
    now: float,
    max_attempts: int = MAX_PUSH_ATTEMPTS,
    min_interval_seconds: float = MIN_ATTEMPT_INTERVAL_SECONDS,
) -> RetryDecision:
    """Whether to re-push a browser rename that never reached Claude.

    Description: PURE, and the whole policy. The ladder, in order, with
      the reason each rung sits where it does:

      1. The transcript could not be read -> :data:`RETRY_UNREADABLE`.
         FIRST, because a reading that did not happen decides nothing and
         must not be charged against the budget.
      2. The sync WROTE this pass -> :data:`RETRY_SUPERSEDED`. An
         ``APPLIED`` means Claude renamed after we last looked, so
         Claude's name is the newer one and pushing over it is exactly
         the clobber this module exists to avoid. A ``BASELINE`` means
         first sight, which by this project's standing rule establishes
         no ordering at all.
      3. The columns agree -> :data:`RETRY_AGREED`. The steady state.
      4. The ordering frame is missing or overtaken ->
         :data:`RETRY_UNORDERED`. See the module docstring: a divergence
         with no witnessed agreement behind it may be a baseline that
         landed on a row whose visible label was already different, and
         that case genuinely cannot be ordered.
      5. The budget for this label is spent -> :data:`RETRY_EXHAUSTED`.
      6. The last push is younger than the interval floor ->
         :data:`RETRY_WAITING`.
      7. Otherwise -> :data:`RETRY_PUSH`.

      Note rung 2 is reached only on a pass that actually wrote, so the
      surviving path into rung 4 is ``TITLE_UNCHANGED``: the transcript's
      newest ``custom-title`` was READ and equals ``claude_title``. That
      is the positive confirmation described in the module docstring, and
      it is why a ``CUSTOM_TITLE_NO_RECORD`` window - which arrives here
      as ``TITLE_NOT_MEASURED`` - authorises nothing.
    Inputs: sync_action (str) - a ``claude_title_sync.TITLE_*`` verdict
      from this same pass. title (str | None) - ``sessions.title`` after
      the pass. claude_title (str | None) - ``sessions.claude_title``
      after the pass. mark (RenameMark | None) - the row's ledger entry.
      now (float) - unix seconds. max_attempts (int). min_interval_seconds
      (float).
    Output: RetryDecision.
    Example: decide_retry(sync_action=TITLE_UNCHANGED, title='New',
      claude_title='Old', mark=RenameMark(agreed_title='Old'),
      now=0.0).verdict -> 'push'
    """
    if sync_action == TITLE_NOT_MEASURED:
        return RetryDecision(
            RETRY_UNREADABLE,
            detail=(
                "the transcript said nothing this pass, so whether claude "
                "still holds the recorded name is unknown and no attempt "
                "is spent"
            ),
        )

    if sync_action in (TITLE_APPLIED, TITLE_BASELINE_RECORDED):
        return RetryDecision(
            RETRY_SUPERSEDED,
            detail=(
                "the transcript moved this pass, so claude's name is the "
                "newer one and a browser push would overwrite it"
            ),
        )

    label = _clean(title)
    recorded = _clean(claude_title)

    if label is None or recorded is None or label == recorded:
        return RetryDecision(
            RETRY_AGREED,
            detail="both sides carry the same name, so nothing is pending",
        )

    if mark is None or mark.agreed_title is None:
        return RetryDecision(
            RETRY_UNORDERED,
            detail=(
                "the two names disagree and no agreement has ever been "
                "witnessed for this row, so which of them is newer cannot "
                "be established - refusing rather than guessing"
            ),
        )

    if mark.agreed_title != recorded:
        return RetryDecision(
            RETRY_UNORDERED,
            detail=(
                "claude's recorded name has moved since the last witnessed "
                "agreement, so the browser label can no longer be shown to "
                "be the newer one"
            ),
        )

    spent = budget_for(mark, label)
    if spent >= max(0, int(max_attempts)):
        return RetryDecision(
            RETRY_EXHAUSTED,
            label=label,
            attempts_spent=spent,
            detail=(
                f"{spent} pushes have been spent on this name and the bound "
                f"is {max_attempts}; this rename will not be attempted again"
            ),
        )

    last = mark.last_attempt_at if mark.attempted_label == label else None
    if last is not None and (now - float(last)) < float(min_interval_seconds):
        return RetryDecision(
            RETRY_WAITING,
            label=label,
            attempts_spent=spent,
            detail=(
                "the previous push for this name is younger than the "
                "interval floor, so this pass holds without spending an "
                "attempt"
            ),
        )

    return RetryDecision(
        RETRY_PUSH,
        label=label,
        attempts_spent=spent,
        detail=(
            "claude's name has not moved since the last witnessed "
            "agreement, so the browser label is the newer one and is "
            "pushed again"
        ),
    )


def record_attempt(
    mark: Optional[RenameMark], *, label: str, now: float
) -> RenameMark:
    """The mark after one push has actually been spawned.

    Description: PURE. Charges exactly one attempt, and RESETS the count
      when the label differs from the one the budget was spent on -
      renaming again starts a new budget, which is the same rule
      :func:`budget_for` reads. The agreement frame is carried through
      untouched: spending an attempt is not evidence about which side is
      newer, and rewriting the frame here would let a failing push
      slowly re-authorise itself.
    Inputs: mark (RenameMark | None) - the row's entry, if any. label
      (str) - the name that was pushed. now (float) - unix seconds.
    Output: RenameMark - the entry to store.
    Example: record_attempt(None, label='New', now=1.0).attempts -> 1
    """
    base = mark or RenameMark()
    spent = budget_for(base, label)
    return replace(
        base, attempted_label=label, attempts=spent + 1, last_attempt_at=float(now)
    )


def record_agreement(mark: Optional[RenameMark], agreed: str) -> RenameMark:
    """The mark after an agreement between the two columns was witnessed.

    Description: PURE. Moves the ordering frame to the newly agreed name
      and CLEARS the retry budget, because an agreement means whatever
      was pending has been resolved - by the push landing, by the user
      renaming in the TUI, or by the two names coinciding - and the next
      divergence is a new rename with a full budget of its own.
    Inputs: mark (RenameMark | None). agreed (str) - the name both
      columns now carry.
    Output: RenameMark.
    Example: record_agreement(None, 'A').agreed_title -> 'A'
    """
    return RenameMark(
        agreed_title=agreed,
        attempted_label=None,
        attempts=0,
        last_attempt_at=None,
    )


__all__ = [
    "MAX_PUSH_ATTEMPTS",
    "MIN_ATTEMPT_INTERVAL_SECONDS",
    "RETRY_AGREED",
    "RETRY_EXHAUSTED",
    "RETRY_PUSH",
    "RETRY_SUPERSEDED",
    "RETRY_UNORDERED",
    "RETRY_UNREADABLE",
    "RETRY_WAITING",
    "TERMINAL_VERDICTS",
    "RenameMark",
    "RetryDecision",
    "budget_for",
    "decide_retry",
    "record_agreement",
    "record_attempt",
    "witness_agreement",
    "TITLE_UNCHANGED",
]
