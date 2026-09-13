"""The edge detector: which verdicts are NEWS, and which are the weather.

The resolver answers "what does this session need" every time it is
asked, which is every two seconds for every live session. Almost every
answer is the same as the last one. A toast must be raised on the EDGE,
the moment the answer CHANGES, and this module is the only thing in the
package that remembers anything.

FIVE RULES, AND EVERY ONE OF THEM EXISTS BECAUSE OF A MEASURED DEFECT.

**FIRST SIGHT IS A BASELINE.** The first observation of a key records and
returns no transition. This is what stops the restart toast storm: on
boot the app re-adopts every surviving session and reads each one for the
first time, and a dozen sessions that have been sitting finished since
last night are not a dozen new pieces of news. The state was already true
before we looked.

**A SETTLE-REQUIRED VERDICT MUST BE SEEN TWICE.** The pane and the
end-of-transcript shape are both read mid-render: ``capture-pane`` can
catch a dialog half-drawn, and the transcript's own turn-end record lands
25 ms after the model stops and 7 ms before claude updates its status, so
a single read inside that gap is a read before the source settled. A
verdict the resolver marked :attr:`~AttentionVerdict.settle_required`
must therefore be observed twice, at least :data:`SETTLE_SECONDS` apart,
and a DIFFERENT verdict arriving in between resets the settle.

**``done_idle`` ALSO NEEDS QUIET.** A turn end followed immediately by
another append is not a finished turn, it is the gap between two records.
The caller passes the transcript's newest append time; the ledger holds
the transition until :data:`DONE_QUIET_SECONDS` have passed since it. THE
LEDGER READS NO FILES: the timestamp is an argument, which is what lets
the replay suite drive years of history in milliseconds.

**A FLICKER THROUGH ``unknown`` FREEZES THE ENTRY.** ``unknown`` is a
failure to observe, not an observation of a different state, so it
changes nothing at all: not the confirmed verdict, not a settle in
progress, not the emitted set. Without this, a session that answered
``busy``, then ``unknown`` for one tick because a file was being
rewritten, then ``busy`` again, would produce a second ``busy`` edge out
of nothing. The way back must not manufacture an edge.

**ONE EDGE PER (key, state, reason) UNTIL THE STATE MOVES.** A session
that sits in ``needs_user(permission)`` for ten minutes is one ask, not
three hundred. The emitted set is cleared the moment the STATE changes to
something else, so the same ask after a real detour is news again. A
reason change inside one state IS news, on purpose: ``needs_user`` going
from ``input`` to ``permission`` is a different question for the user.

IT ALSO HOLDS TWO EVIDENCE BASELINES, and :meth:`note_transcript` is
where they live: the newest user prompt and the newest append this key
has already been shown. They are not verdicts, but they are memory, and
putting them anywhere else would give the package a second thing that
remembers. They are what the watcher's side-effect layer reads instead of
a ``UserPromptSubmit`` hook.

KEYED ON THE INSTANCE, NOT THE SESSION ID. The key is
``UnreadStore.compose_key(tmux_name, epoch)``, the same identity the
unread flag already uses, for two reasons the project has already paid
for. Gotcha 4b: a session id is not a tmux name and deriving one from
the other loses sessions. Gotcha 10: ``CLOUDECODE_SESSION_ID`` is fixed
into a pane at spawn, so after a re-adopt the row id and the id the pane
believes in can diverge, and a flag keyed on the row id is one the pane's
own agent can never clear. The tmux name plus ``#{session_created}``
cannot diverge from the pane, because it IS the pane.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Optional, Set, Tuple

from src.core.attention.evidence import AttentionVerdict, STATE_DONE_IDLE, STATE_UNKNOWN
from src.core.attention.resolve import DONE_QUIET_SECONDS, SETTLE_SECONDS


@dataclass(frozen=True)
class Transition:
    """One edge: a session's attention state actually changed.

    Description: what :meth:`AttentionLedger.observe` returns when, and
      only when, there is news. The watcher's transition table is keyed
      on :attr:`state` and :attr:`reason`; :attr:`previous_state` is
      carried for the log line and for a consumer that wants to know
      what it changed FROM.
    Inputs: n/a.
    Output: n/a (data holder).
    """

    #: The instance key this edge belongs to.
    key: str

    #: The new state, a ``STATE_*`` constant. Never ``unknown``.
    state: str

    #: The new reason, a ``REASON_*`` constant.
    reason: str

    #: The full verdict, so a consumer can read the tier, the detail and
    #: the pending count without the ledger having to copy them out.
    verdict: AttentionVerdict

    #: What this key was confirmed at before, or None when the entry had
    #: never confirmed anything.
    previous_state: Optional[str]

    #: The caller's clock at the moment the edge was emitted.
    at: datetime


@dataclass
class _Entry:
    """One key's memory. Private: nothing outside this module reads it."""

    #: The last state this key was CONFIRMED at. None only before the
    #: first non-unknown observation.
    confirmed_state: Optional[str] = None

    #: The reason that went with it.
    confirmed_reason: Optional[str] = None

    #: A settle-required verdict seen once and waiting for its second
    #: sighting, as (state, reason).
    candidate: Optional[Tuple[str, str]] = None

    #: When that candidate was first seen.
    candidate_since: Optional[datetime] = None

    #: Every (state, reason) already emitted while the state has been
    #: what it is now. Cleared the moment the state changes.
    emitted: Set[Tuple[str, str]] = field(default_factory=set)

    #: The newest user-prompt timestamp this key has already been shown,
    #: and the newest append time. These are baselines about EVIDENCE,
    #: not about verdicts, and they live here so the module docstring's
    #: claim stays true: one place in this package remembers anything.
    seen_user_prompt_at: Optional[datetime] = None
    seen_append_at: Optional[datetime] = None

    #: Whether any evidence has been noted for this key at all. What
    #: makes the FIRST user prompt a baseline rather than an edge.
    evidence_noted: bool = False


def _elapsed(now: datetime, since: Optional[datetime]) -> Optional[float]:
    """Seconds from ``since`` to ``now``, or None if unmeasurable.

    Description: PURE. Returns None for a missing timestamp AND for a
      pair that cannot be subtracted (one aware, one naive), because a
      ledger that raises stops a watcher, and an interval we cannot
      measure is one that has not been shown to have elapsed.
    Inputs: now (datetime), since (datetime | None).
    Output: float | None - seconds, negative if ``since`` is ahead.
    Example: _elapsed(now, None) is None -> True
    """
    if since is None:
        return None
    try:
        return (now - since).total_seconds()
    except TypeError:
        # Mixed aware and naive datetimes. A measurement we cannot make.
        return None


def _is_newer(candidate: Optional[datetime], seen: Optional[datetime]) -> bool:
    """Is ``candidate`` a timestamp strictly later than ``seen``?

    Description: PURE. A missing candidate is never newer, because an
      absent reading is not a reading. A missing ``seen`` beside a real
      candidate IS newer: nothing has been recorded yet. A pair that
      cannot be compared (one aware, one naive) answers False, on the
      same reasoning as :func:`_elapsed`: a comparison we cannot make is
      not one that has been shown to hold, and the callers of this turn
      a True into a dismissal.
    Inputs: candidate (datetime | None), seen (datetime | None).
    Output: bool.
    Example: _is_newer(None, None) -> False
    """
    if candidate is None:
        return False
    if seen is None:
        return True
    try:
        return candidate > seen
    except TypeError:
        # Mixed aware and naive datetimes. A comparison we cannot make.
        return False


class AttentionLedger:
    """Remembers what each session was last confirmed to need.

    Description: in memory, one entry per instance key, no persistence
      and no I/O of any kind. Losing it on restart is CORRECT: the first
      observation after a restart is a baseline, which is exactly the
      behaviour that stops a boot toast storm.
    Inputs: none.
    Output: see :meth:`observe`.
    Example:
        ledger = AttentionLedger()
        ledger.observe("cloude_a@1757000000", verdict, now) is None
    """

    def __init__(self) -> None:
        """Start with no memory of any session.

        Inputs: none. Output: None.
        Example: AttentionLedger()
        """
        self._entries: Dict[str, _Entry] = {}

    def observe(
        self,
        key: str,
        verdict: AttentionVerdict,
        now: datetime,
        *,
        last_append_at: Optional[datetime] = None,
    ) -> Optional[Transition]:
        """Record one reading, and say whether it is an edge.

        Description: the whole module. Walks the five rules in the order
          the docstring gives them; the first one that holds the reading
          back returns None, and only a reading that clears all of them
          becomes a :class:`Transition`.
        Inputs:
          key: the instance key,
            ``UnreadStore.compose_key(tmux_name, epoch)``. NOT a session
            id: see the module docstring.
          verdict: what the resolver just answered.
          now: the caller's clock, so no clock is read here.
          last_append_at: the transcript's newest append time, used ONLY
            by the ``done_idle`` quiet gate. None means the caller could
            not measure it, which skips the gate rather than failing it:
            the resolver's own rung 8 has already applied the same quiet
            rule against the evidence it read, and refusing here as well
            on an unmeasurable timestamp would silence a finished session
            forever.
        Output:
          Transition | None - None whenever there is no news.
        Example:
          ledger.observe(key, busy_verdict, now) is None  # first sight
        """
        entry = self._entries.get(key)

        # RULE 4, AND IT COMES FIRST. ``unknown`` is a failure to
        # observe. It may not confirm, it may not reset a settle, and it
        # may not create an entry that a later reading would then treat
        # as a second sighting.
        if verdict.state == STATE_UNKNOWN:
            if entry is None:
                self._entries[key] = _Entry()
            return None

        # RULE 1. FIRST SIGHT IS A BASELINE. The state is recorded as
        # confirmed AND as already emitted, so a session that has been
        # sitting finished since last night is not news the moment the
        # server comes back up.
        if entry is None or entry.confirmed_state is None:
            fresh = entry if entry is not None else _Entry()
            fresh.confirmed_state = verdict.state
            fresh.confirmed_reason = verdict.reason
            fresh.emitted = {(verdict.state, verdict.reason)}
            fresh.candidate = None
            fresh.candidate_since = None
            self._entries[key] = fresh
            return None

        pair = (verdict.state, verdict.reason)

        # RULE 2. A pane-decided or EOF-decided verdict must be seen
        # twice, SETTLE_SECONDS apart. A different verdict arriving in
        # between replaces the candidate, which is what resets the
        # settle.
        if verdict.settle_required:
            if entry.candidate != pair:
                entry.candidate = pair
                entry.candidate_since = now
                return None
            waited = _elapsed(now, entry.candidate_since)
            if waited is None or waited < SETTLE_SECONDS:
                return None
        else:
            entry.candidate = None
            entry.candidate_since = None

        # RULE 3. ``done_idle`` also needs the transcript to have been
        # quiet. Held rather than dropped: the candidate stays where it
        # is so the next tick can pass this gate without restarting a
        # settle.
        if verdict.state == STATE_DONE_IDLE and last_append_at is not None:
            quiet = _elapsed(now, last_append_at)
            if quiet is None or quiet < DONE_QUIET_SECONDS:
                return None

        # RULE 5. One edge per (key, state, reason) until the STATE
        # moves. The emitted set is cleared on a real state change, so
        # the same ask after a genuine detour is news again.
        previous = entry.confirmed_state
        if previous != verdict.state:
            entry.emitted = set()
        entry.confirmed_state = verdict.state
        entry.confirmed_reason = verdict.reason
        if pair in entry.emitted:
            return None
        entry.emitted.add(pair)
        return Transition(
            key=key,
            state=verdict.state,
            reason=verdict.reason,
            verdict=verdict,
            previous_state=previous,
            at=now,
        )

    def note_transcript(
        self,
        key: str,
        *,
        user_prompt_at: Optional[datetime],
        append_at: Optional[datetime],
    ) -> Tuple[Optional[datetime], bool]:
        """Record this key's transcript timestamps, and say what moved.

        Description: THE PASSIVE REPLACEMENT FOR TWO HOOKS, and the only
          state in this package about evidence rather than about
          verdicts. ``UserPromptSubmit`` used to tell the app that the
          human had turned up; a real user prompt in the transcript,
          later than the one this key was last shown, says exactly the
          same thing with nobody installed in the harness.

          THE TWO ANSWERS BASELINE DIFFERENTLY ON PURPOSE, AND THE
          DIRECTION IS THE JUSTIFICATION. The first reading of a key
          reports NO new user prompt, because a prompt drives a
          DISMISSAL: on boot, every session on the machine has an old
          prompt sitting in its transcript, and treating those as news
          would silently clear every toast the user has not read. The
          same reading DOES report an append, because an append drives a
          cheap idempotent PULL (a title read), and the worst a spurious
          one costs is one bounded read per session per boot, while a
          missed one loses a rename typed while the server was down.

          Callers ask this once per reading, whatever the verdict says,
          because a user prompt is a fact about the file and not about
          the state the resolver derived from it.
        Inputs:
          key: the instance key, as :meth:`observe` takes it.
          user_prompt_at: ``TranscriptFacts.newest_user_prompt_at``, or
            None when the window held no real user prompt.
          append_at: ``TranscriptFacts.newest_append_at``, or None when
            nothing dated could be read.
        Output:
          (new_user_prompt_at, transcript_appended) - the first is the
          prompt timestamp ONLY when it is strictly newer than the one
          this key was last shown, else None; the second is True when the
          transcript has grown since the last reading, or this is the
          first reading.
        Example:
          ledger.note_transcript(key, user_prompt_at=None,
                                 append_at=None) -> (None, True)
        """
        entry = self._entries.get(key)
        if entry is None:
            entry = _Entry()
            self._entries[key] = entry

        first = not entry.evidence_noted
        entry.evidence_noted = True

        new_prompt: Optional[datetime] = None
        if not first and _is_newer(user_prompt_at, entry.seen_user_prompt_at):
            new_prompt = user_prompt_at
        if _is_newer(user_prompt_at, entry.seen_user_prompt_at):
            entry.seen_user_prompt_at = user_prompt_at

        appended = first or _is_newer(append_at, entry.seen_append_at)
        if _is_newer(append_at, entry.seen_append_at):
            entry.seen_append_at = append_at

        return new_prompt, appended

    def confirmed_state(self, key: str) -> Optional[str]:
        """The state this key is currently confirmed at, if any.

        Description: read-only, for a caller that wants to know what the
          ledger is holding without observing anything. None both for a
          key never seen and for one that has only ever answered
          ``unknown``, which are the same fact: nothing was confirmed.
        Inputs: key (str) - the instance key.
        Output: str | None - a ``STATE_*`` constant.
        Example: ledger.confirmed_state(key) -> 'busy'
        """
        entry = self._entries.get(key)
        return None if entry is None else entry.confirmed_state

    def forget(self, key: str) -> None:
        """Drop everything remembered about one instance. Idempotent.

        Description: called when a session is destroyed or its tmux
          instance is replaced, so the NEXT session to compose the same
          key starts from a baseline rather than inheriting an edge from
          a conversation that no longer exists. Forgetting a key that
          was never seen is not an error.
        Inputs: key (str) - the instance key.
        Output: None.
        Example: ledger.forget("cloude_a@1757000000")
        """
        self._entries.pop(key, None)

    def tracked_keys(self) -> Tuple[str, ...]:
        """Every key this ledger currently remembers, for logs and tests.

        Description: order is insertion order, which is the order the
          keys were first observed in.
        Inputs: none beyond ``self``.
        Output: tuple[str, ...].
        Example: ledger.tracked_keys() -> ('cloude_a@1757000000',)
        """
        return tuple(self._entries)
