"""The whole point of issue #123, scored against production ground truth.

WHAT THIS IS. Five real episodes, cut from the 50.8 hours of live server
log and the byte-exact transcripts behind them, replayed through the
shipped resolver, the shipped ledger and the shipped watcher on an
INJECTED CLOCK with no real sleeping and no real files. Each fixture
carries the transcript as the watcher would have read it at each instant,
what the hook path ACTUALLY raised (``production_raised``), and what the
new design SHOULD raise (``expected_toasts``). The headline number is
episode a: production announced "done" seven times while the session's own
background agents were still running, and the new path raises once, at the
end, when the work was really finished.

THREE THINGS THE CORPUS COULD NOT CAPTURE, named here so nobody mistakes
a reconstruction for a measurement.

**THE REGISTRY IS NOT IN THE CORPUS AND CANNOT BE.**
``~/.claude/sessions/<pid>.json`` is written on change with no history,
and this app never read it, so no snapshot of it exists for any past
instant. One event in episode b carries a registry object the corpus
author reconstructed and flagged ``synthetic``; everywhere else the field
is null. This harness reconstructs the rest the same way and from the
same source: the tier-1 state machine read out of the 2.1.266 binary
(``g2e``: ``waitingFor`` set means ``waiting``, else ``isLoading ||
delegatedActive`` means ``busy``, else ``idle``). See
:func:`reconstruct_registry`.

**THE RECONSTRUCTION DOES NOT DO THE SUPPRESSION.** That matters, because
a fabricated tier scored against itself proves nothing. In episode a the
seven false toasts are refused by rungs 2 and 3, ``queued_reinvoke`` and
``pendingBackgroundAgentCount > 0``, both read from the real transcript
and both ABOVE every registry rung in the precedence table. The
reconstructed registry only makes rung 8 reachable at all, which is the
last event. Delete the reconstruction and the count goes from one to
zero; it never goes up.

**THE PANE IS NOT IN THE CORPUS EITHER.** Pane text was never captured,
so ``pane`` is None at every instant. That is a real state the resolver
has a rung for (5b, fail toward the human), not a gap papered over.

A CORRECTION THIS FILE CARRIES. The fixture now called
``e_pending_field_absent_means_zero_pending.json`` shipped as
``e_pending_field_absent_answers_unknown.json`` and expected NO toast. It
rested on the belief that claude 2.1.266 writes a literal null for
``pendingBackgroundAgentCount`` when nothing is pending, so an absent key
had to mean an old binary that never wrote the field. Re-measured over 40
recent transcripts, 300 turn-end records on 2.1.266: 236 carry a positive
integer, 64 OMIT THE KEY, none carries a null and none carries a zero.
The null was an artifact of ``jq`` printing a missing key as null. So on a
record at or above 2.1.241 an absent key means ZERO PENDING AGENTS and
the turn really finished, and that episode is the same shape as episode
c, which the corpus labels ``legit``. Two episodes of one shape may not
have two different expected counts. The fixture's own
``superseded_expectation`` block keeps the old claim and the reason it
was wrong.

THE LEDGER IS PRIMED, AND THAT IS FAITHFUL RATHER THAN CONVENIENT. Each
episode opens on the instant production raised its first toast in the
window, and a Stop or a Notification is fired at a turn boundary, so the
session was WORKING the instant before the window opens. A watcher that
had been running would have been holding ``busy`` there. Replaying from
an empty ledger would instead make each episode's first event the
baseline, which is a statement about the harness rather than about the
evidence. The restart case, where the baseline really is empty, is
covered by its own test at the bottom of this file and by
``tests/test_attention_ledger.py``.

AND THE REPLAY TICKS AT THE WATCHER'S CADENCE, NOT AT PRODUCTION'S TOAST
INSTANTS. The fixture samples the transcript at each moment the hook path
raised, plus one tail sample, which is where the toasts were, not where a
watcher's reads would have been. A watcher reads every
:data:`~src.core.attention.watcher.DEFAULT_TICK_SECONDS`, so between two
fixture samples it read the same record set several more times at later
clocks. Those extra reads invent nothing: the record set is carried
forward VERBATIM from the most recent sample, which is what a reader at
that instant would have found, because anything appended in between would
be in the next sample. It matters because the gates are time-based.
Episode a's last turn end needs three seconds of transcript quiet and the
fixture's next sample is twenty-eight seconds later, by which time claude
had already started speaking again; sampled only where production
toasted, a genuinely finished turn is never observed at rest at all.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import pytest

from src.core.attention.evidence import (
    AttentionVerdict,
    Evidence,
    REASON_STREAMING,
    STATE_BUSY,
    TIER_REGISTRY,
)
from src.core.attention.ledger import AttentionLedger
from src.core.attention.pane_markers import classify_pane_tail
from src.core.attention.registry_read import parse_registry_record
from src.core.attention.transcript_facts import classify_transcript_records
from src.core.pipe_wakeup import KQUEUE_AVAILABLE
from src.core.attention.watcher import (
    AttentionWatcher,
    DEFAULT_TICK_SECONDS,
    WatchTarget,
)
from src.core.session_status import (
    LIVENESS_GONE,
    LIVENESS_LIVE,
    LIVENESS_UNKNOWN,
)
from src.core.unread_store import UnreadStore

FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "attention_replay")

#: Every episode, by the filename stem the fixture is stored under.
EPISODE_NAMES: Tuple[str, ...] = (
    "a_subagents_pending_then_really_done",
    "b_blocked_on_askuserquestion",
    "c_genuinely_idle_one_toast",
    "d_reinvoked_after_production_said_done",
    "e_pending_field_absent_means_zero_pending",
)

#: A stand-in ``#{session_created}`` so every key is instance-shaped.
#: The corpus records no tmux creation epoch, and nothing in the replay
#: depends on its value, only on it being stable within one episode.
REPLAY_EPOCH: int = 1757000000

#: A stand-in pid for a reconstructed registry record. Liveness is never
#: probed here: ``parse_registry_record`` only needs an anchor, and the
#: ``os.kill`` check belongs to ``registry_for_session``, which cannot be
#: replayed against processes that exited days ago.
REPLAY_PID: int = 424242

#: How ``tmux_liveness`` is spelled in the fixture, and what the resolver
#: calls it.
LIVENESS_BY_FIXTURE: Dict[str, str] = {
    "LIVE": LIVENESS_LIVE,
    "GONE": LIVENESS_GONE,
    "UNKNOWN": LIVENESS_UNKNOWN,
}


def parse_iso(text: str) -> datetime:
    """One fixture timestamp as an aware UTC datetime.

    Inputs: text (str) - ISO 8601 ending in ``Z``.
    Output: datetime - timezone aware.
    Example: parse_iso("2026-09-11T18:00:01Z").tzinfo is not None -> True
    """
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def load_episode(name: str) -> Dict[str, Any]:
    """Read one replay fixture off disk.

    Inputs: name (str) - the filename stem.
    Output: dict - the decoded timeline.
    Example: load_episode("c_genuinely_idle_one_toast")["production_raised"]
    """
    with open(os.path.join(FIXTURE_DIR, name + ".json")) as handle:
        return json.load(handle)


def reconstruct_registry(facts: Any, episode: Dict[str, Any]) -> Dict[str, Any]:
    """Build the registry record claude would have written at this instant.

    Description: the tier-1 state machine as read out of the 2.1.266
      binary, applied to facts the transcript really carries. NOT a
      measurement: see the module docstring. Three branches and no
      fourth, in the binary's own order.

      ``waiting`` when a non-user-invoked dialog is open, which at the
      transcript tier is an unanswered blocking tool at the end of the
      window. ``busy`` when ``delegatedActive`` is POSITIVELY true (a
      pending count, an open async launch, or a queued completion) or
      when ``isLoading`` is, which is a turn still open at the end of the
      window. ``idle`` otherwise.

      ``statusUpdatedAt`` is stamped at the transcript's newest append,
      because the measured ordering is that claude updates its own status
      7 ms after writing its turn-end record. That is what keeps the
      record ``fresh`` for rule (c) and what rung 6a compares against.
    Inputs:
      facts: the TranscriptFacts for this instant.
      episode: the decoded timeline, for the session's names and version.
    Output: dict - a raw registry record, shaped like the real file.
    Example: reconstruct_registry(facts, episode)["status"] -> 'idle'
    """
    session = episode["session"]
    turn_open = facts.newest_assistant_at is not None and (
        facts.turn_end_at is None or facts.newest_assistant_at > facts.turn_end_at
    )
    delegated = (
        (facts.pending_background_agents or 0) > 0
        or facts.open_async_agents > 0
        or facts.queued_reinvoke
    )
    if facts.blocked_on_tool is not None:
        status, waiting_for = "waiting", "input needed"
    elif delegated or turn_open:
        status, waiting_for = "busy", None
    else:
        status, waiting_for = "idle", None
    return {
        "reconstructed": True,
        "pid": REPLAY_PID,
        "status": status,
        "waitingFor": waiting_for,
        "sessionId": session["conversation_uuid"],
        "cwd": "/replay",
        "tmux": "%s:@0.%%0" % session["tmux_name"],
        "version": session["harness_version"],
        "statusUpdatedAt": None,
    }


def stamp_registry(raw: Dict[str, Any], facts: Any, now: datetime) -> Dict[str, Any]:
    """Fill in the fields a fixture registry record cannot carry.

    Description: the one synthetic record the corpus itself ships (event
      0 of episode b) has no pid and no ``statusUpdatedAt``, because the
      author only reconstructed the fields the rung under test reads.
      Both are required: the pid is the anchor
      ``parse_registry_record`` refuses a record without, and
      ``statusUpdatedAt`` is what rule (c) dates a rest claim from.
    Inputs: raw (dict) - the record so far. facts - TranscriptFacts.
      now (datetime) - this event's instant.
    Output: dict - a copy with both fields present.
    Example: stamp_registry({}, facts, now)["pid"] -> 424242
    """
    stamped = dict(raw)
    stamped.setdefault("pid", REPLAY_PID)
    at = facts.newest_append_at if facts.newest_append_at is not None else now
    if stamped.get("statusUpdatedAt") is None:
        stamped["statusUpdatedAt"] = int(at.timestamp() * 1000)
    return stamped


def evidence_for(
    event: Dict[str, Any], episode: Dict[str, Any], now: datetime, facts: Any
) -> Evidence:
    """Turn one fixture event into the bundle the resolver reads.

    Description: every tier comes from the shipped reader, used exactly
      as the watcher uses it, so this harness cannot accidentally be
      testing a second implementation of the same rules.
    Inputs: event (dict) - one timeline entry. episode (dict).
      now (datetime) - the tick's clock, which is the event's own instant
      or a later one on the watcher's cadence. facts - the
      TranscriptFacts for this event, built once and reused: the reader
      accepts a clock but classifies nothing by it, so the same records
      read two seconds later are the same facts.
    Output: Evidence.
    Example: evidence_for(event, episode, now, facts).now is now -> True
    """
    raw = event.get("registry")
    if raw is None:
        raw = reconstruct_registry(facts, episode)
    registry = parse_registry_record(stamp_registry(raw, facts, now), path_pid=None)
    pane_tail = event.get("pane_tail")
    tmux = event.get("tmux") or {}
    return Evidence(
        tmux_liveness=LIVENESS_BY_FIXTURE.get(
            tmux.get("liveness", "UNKNOWN"), LIVENESS_UNKNOWN
        ),
        agent_family=episode["session"].get("agent_family"),
        registry=registry,
        transcript=facts,
        # None means WE DID NOT LOOK, which is what the corpus records.
        # An empty capture would be a different fact and must not be
        # invented here.
        pane=classify_pane_tail(pane_tail) if pane_tail else None,
        now=now,
    )


def tick_schedule(episode: Dict[str, Any]) -> List[Tuple[int, datetime]]:
    """Every instant a running watcher would have read this session.

    Description: each fixture sample, then that sample's record set again
      every :data:`~src.core.attention.watcher.DEFAULT_TICK_SECONDS` until
      the next sample replaces it. See the module docstring for why the
      fixture's own sampling is not the watcher's.
    Inputs: episode (dict) - the decoded timeline.
    Output: list of (event index, instant), in time order.
    Example: tick_schedule(episode)[0][0] -> 0
    """
    events = episode["events"]
    schedule: List[Tuple[int, datetime]] = []
    for index, event in enumerate(events):
        start = parse_iso(event["t"])
        schedule.append((index, start))
        if index + 1 >= len(events):
            continue
        end = parse_iso(events[index + 1]["t"])
        at = start + timedelta(seconds=DEFAULT_TICK_SECONDS)
        while at < end:
            schedule.append((index, at))
            at = at + timedelta(seconds=DEFAULT_TICK_SECONDS)
    return schedule


def priming_verdict() -> AttentionVerdict:
    """The state a running watcher would have been holding on entry.

    Description: ``busy(streaming)``, registry tier, no settle. Every
      episode opens at a turn boundary, so the instant before it the
      session was working. See the module docstring for why the ledger
      is primed at all.
    Inputs: none.
    Output: AttentionVerdict.
    Example: priming_verdict().state -> 'busy'
    """
    return AttentionVerdict(
        state=STATE_BUSY,
        reason=REASON_STREAMING,
        tier=TIER_REGISTRY,
        settle_required=False,
    )


class Replay:
    """One episode driven through the real watcher, toasts collected.

    Description: the watcher is constructed with injected callables, so
      no session manager, no toast inbox and no policy store is involved
      and nothing sleeps. ``read_evidence`` hands back one pre-built
      bundle per tick, in order, which is exactly what the real reader
      would have returned had it been running.
    Inputs: see :meth:`__init__`.
    Output: :attr:`toasts`, :attr:`unread_set` and :attr:`busy_edges`.
    Example: Replay(load_episode(name)).run().toasts
    """

    def __init__(self, episode: Dict[str, Any]) -> None:
        """Build the watcher and the scripted evidence for one episode.

        Inputs: episode (dict) - the decoded timeline.
        Output: None.
        """
        self.episode = episode
        self.target = WatchTarget(
            session_id=episode["session"]["session_id"],
            key=UnreadStore.compose_key(
                episode["session"]["tmux_name"], REPLAY_EPOCH
            ),
        )
        facts = [
            classify_transcript_records(
                event["transcript_records"], now=parse_iso(event["t"])
            )
            for event in episode["events"]
        ]
        self.evidence: List[Evidence] = [
            evidence_for(episode["events"][index], episode, at, facts[index])
            for index, at in tick_schedule(episode)
        ]
        self.toasts: List[Tuple[str, datetime, str]] = []
        self.unread_set: List[str] = []
        self.busy_edges: List[str] = []
        self._cursor = 0
        self.ledger = AttentionLedger()
        self.watcher = AttentionWatcher(
            list_targets=lambda: [self.target],
            read_evidence=self._next_evidence,
            raise_toast=self._raise,
            set_unread=self._unread,
            on_busy_edge=self._busy,
            ledger=self.ledger,
            # No policy store in the replay, which is the same posture a
            # build without the mute feature has: nothing is suppressed,
            # so every count below is the count BEFORE any mute.
            read_policy=None,
            now=lambda: parse_iso(episode["events"][0]["t"]),
            tick_seconds=0.0,
            # A directory that cannot exist, so the early wake is never
            # armed and the replay touches no real path.
            registry_directory=os.path.join(FIXTURE_DIR, "no-such-registry-dir"),
        )

    def _next_evidence(
        self, target: WatchTarget, now: datetime
    ) -> Optional[Evidence]:
        """The next scripted bundle, already stamped with its own instant.

        Description: the watcher hands its clock to every reader, and a
          live reader stamps the evidence with it. Here the stamp is
          already on the bundle, because the replay's clock IS the
          fixture's, so the argument is accepted and not used.
        Inputs: target (WatchTarget), now (datetime).
        Output: Evidence.
        """
        bundle = self.evidence[self._cursor]
        self._cursor += 1
        return bundle

    def _raise(self, target: WatchTarget, kind: str, transition: Any) -> None:
        """Collect one toast. Inputs: target, kind, transition."""
        self.toasts.append((kind, transition.at, transition.reason))

    def _unread(self, target: WatchTarget) -> None:
        """Collect one unread flag write. Inputs: target."""
        self.unread_set.append(target.key)

    def _busy(self, target: WatchTarget, transition: Any) -> None:
        """Collect one busy edge. Inputs: target, transition."""
        self.busy_edges.append(transition.reason)

    def run(self, *, prime: bool = True) -> "Replay":
        """Drive every event through one watcher pass each.

        Inputs: prime (bool) - seed the ledger with the ``busy`` state a
          running watcher would have been holding. False replays from an
          empty ledger, which is the restart case.
        Output: self, for chaining.
        Example: Replay(episode).run().toasts
        """
        if prime:
            first = parse_iso(self.episode["events"][0]["t"])
            self.ledger.observe(
                self.target.key, priming_verdict(), first - timedelta(seconds=1)
            )

        async def drive() -> None:
            for _ in self.evidence:
                await self.watcher.tick_once()

        asyncio.run(drive())
        return self


@pytest.fixture(scope="module")
def replays() -> Dict[str, Replay]:
    """Every episode replayed once, shared by the assertions below.

    Inputs: none. Output: dict of episode name to finished Replay.
    """
    return {name: Replay(load_episode(name)).run() for name in EPISODE_NAMES}


# ---------------------------------------------------------------------
# The fixtures themselves
# ---------------------------------------------------------------------


def test_every_episode_is_present_and_self_describing():
    """A missing fixture must fail loudly, not silently score zero.

    Gotcha 11: a check that passes because it looked at nothing.
    """
    for name in EPISODE_NAMES:
        episode = load_episode(name)
        assert episode["name"] == name
        assert episode["events"], "%s has no events to replay" % name
        assert "expected_toasts" in episode
        assert isinstance(episode["production_raised"], int)


def test_no_fixture_is_larger_than_the_corpus_size_cap():
    """400 KB is the cap the corpus builder trimmed each timeline to."""
    for name in EPISODE_NAMES:
        size = os.path.getsize(os.path.join(FIXTURE_DIR, name + ".json"))
        assert size <= 400 * 1024, "%s is %d bytes" % (name, size)


def test_the_corrected_episode_keeps_the_claim_it_replaced():
    """The old expectation and the reason it was wrong stay on the file.

    A stale doc is worse than no doc (gotcha 8), and a fixture whose
    expectation changed without a record of why is exactly that.
    """
    episode = load_episode("e_pending_field_absent_means_zero_pending")
    superseded = episode["superseded_expectation"]
    assert superseded["old_name"] == "e_pending_field_absent_answers_unknown"
    assert superseded["old_expected_toasts"] == []
    assert "236" in superseded["why_it_was_wrong"]
    assert len(episode["expected_toasts"]) == 1


def test_the_corrected_episode_is_the_same_shape_as_the_control():
    """Two episodes of one shape may not carry two expected counts.

    Episode c is the corpus control, labelled ``legit`` by production's
    own ground truth. Episode e ends on the same shape: a turn-end record
    on the same harness version with the pending key absent, nothing
    queued and no launch open. This is the assertion that caught the
    fixture's original claim, so it is the one that must not be softened.
    """
    shapes = {}
    pair = (
        "c_genuinely_idle_one_toast",
        "e_pending_field_absent_means_zero_pending",
    )
    for name in pair:
        episode = load_episode(name)
        event = episode["events"][-1]
        facts = classify_transcript_records(
            event["transcript_records"], now=parse_iso(event["t"])
        )
        shapes[name] = (
            facts.verdict,
            facts.pending_field_present,
            facts.pending_background_agents,
            facts.queued_reinvoke,
            facts.open_async_agents,
            facts.blocked_on_tool,
            episode["session"]["harness_version"],
        )
    assert shapes[pair[0]] == shapes[pair[1]]


# ---------------------------------------------------------------------
# The scores
# ---------------------------------------------------------------------


@pytest.mark.parametrize("name", EPISODE_NAMES)
def test_each_episode_raises_exactly_what_the_fixture_expects(name, replays):
    """Count and kind, per episode, against ``expected_toasts``."""
    episode = load_episode(name)
    expected = [entry["kind"] for entry in episode["expected_toasts"]]
    raised = [kind for kind, _, _ in replays[name].toasts]
    assert raised == expected, "%s raised %r, expected %r (production raised %d)" % (
        name,
        replays[name].toasts,
        episode["expected_toasts"],
        episode["production_raised"],
    )


@pytest.mark.parametrize("name", EPISODE_NAMES)
def test_no_toast_is_raised_before_the_evidence_supported_it(name, replays):
    """The settle and quiet gates may DELAY a toast, never advance one.

    A toast earlier than the instant the fixture names would mean the
    resolver answered before its source had settled, which is the exact
    defect that made a hook-time read unusable.
    """
    episode = load_episode(name)
    for (kind, at, _), entry in zip(replays[name].toasts, episode["expected_toasts"]):
        assert at >= parse_iso(entry["at"]), (
            "%s raised %s at %s, expected %s or later"
        ) % (
            name,
            kind,
            at,
            entry["at"],
        )


def test_the_headline_one_toast_where_production_raised_seven(replays):
    """ISSUE #123 IN ONE ASSERTION.

    Five turns ended inside twelve minutes while this session's own
    background agents kept running. The hook path announced "done" at
    every one of them, because its counter was fed by a pane-wide session
    id that the agents posted under too. The pending count on the real
    turn-end records falls 5, 3, 3, 2, 1, 1 and then the key is absent,
    which on 2.1.266 is zero. Exactly one edge into ``done_idle`` exists,
    and it is the last one.
    """
    replay = replays["a_subagents_pending_then_really_done"]
    assert replay.episode["production_raised"] == 7
    assert [kind for kind, _, _ in replay.toasts] == ["Stop"]
    # And the six that were refused were refused for a REASON, not by
    # accident: the session was reported as working the whole time.
    assert replay.busy_edges


def test_the_queued_reinvoke_episode_raises_one_where_production_raised_three(replays):
    """Rung 2 is the only rung that catches this one.

    Production said done at 23:17:30. A background agent's completion was
    already sitting in the input queue, so claude was re-invoked with no
    human involved and worked for another three minutes. The decisive
    fact is not the pending count, it is an enqueue newer than the turn
    end.
    """
    replay = replays["d_reinvoked_after_production_said_done"]
    assert replay.episode["production_raised"] == 3
    assert [kind for kind, _, _ in replay.toasts] == ["Stop"]


def test_the_control_episode_still_gets_its_one_real_toast(replays):
    """THE CURE MUST NOT BE WORSE THAN THE DISEASE.

    49 of the 501 measured toasts were real. A resolver that raises
    nothing here has killed those too.
    """
    replay = replays["c_genuinely_idle_one_toast"]
    assert [kind for kind, _, _ in replay.toasts] == ["Stop"]


def test_the_omitted_pending_count_episode_matches_the_control(replays):
    """Same shape, same answer: one done toast.

    Named for the correction it carries. On a harness at or above
    2.1.241 an omitted ``pendingBackgroundAgentCount`` is how the binary
    writes zero, so this turn really ended.
    """
    replay = replays["e_pending_field_absent_means_zero_pending"]
    assert replay.episode["production_raised"] == 1
    assert [kind for kind, _, _ in replay.toasts] == ["Stop"]


def test_the_blocked_episode_raises_a_permission_kind_not_a_notification(replays):
    """Production got the COUNT right here and the KIND wrong.

    The window ends on an unanswered ``AskUserQuestion``, which is a hard
    block: claude has stopped and cannot continue until a human answers.
    That is the permission family, and it renders yellow.
    """
    replay = replays["b_blocked_on_askuserquestion"]
    assert replay.episode["production_toasts"][0]["kind"] == "Notification"
    assert [kind for kind, _, _ in replay.toasts] == ["PermissionRequest"]


def test_a_done_toast_always_sets_the_unread_flag_first(replays):
    """Suppressing is not acknowledging, so the flag is not the toast."""
    for name in EPISODE_NAMES:
        replay = replays[name]
        stops = [kind for kind, _, _ in replay.toasts if kind == "Stop"]
        assert len(replay.unread_set) == len(stops), name


# ---------------------------------------------------------------------
# The restart control
# ---------------------------------------------------------------------


def test_a_fresh_ledger_replayed_over_finished_sessions_raises_nothing():
    """THE RESTART BASELINE, on real evidence rather than on a stub.

    Every episode replayed from an EMPTY ledger, which is what the server
    has on boot. The first reading of each session is a baseline whatever
    it says, so a machine full of sessions that finished overnight makes
    no noise when the app comes back.
    """
    for name in EPISODE_NAMES:
        episode = load_episode(name)
        # Only the LAST event of each episode, which is the settled,
        # already-finished state a restart would find.
        episode = dict(episode, events=[episode["events"][-1]])
        replay = Replay(episode).run(prime=False)
        assert replay.toasts == [], "%s toasted on a cold start" % name
        assert replay.unread_set == []


# ---------------------------------------------------------------------
# The loop's own refusals, on real evidence
# ---------------------------------------------------------------------
#
# Everything above drives ``tick_once``. These drive the parts the module
# docstring makes promises about and nothing else exercises: that the
# loop survives a failing collaborator, that the mute gate is actually
# wired to the raise, and that ``run`` and ``poke`` work at all. A
# promise with no test behind it is gotcha 11 in prose form.


class SuppressingPolicy:
    """A mute policy that silences this session. Output: n/a (stub)."""

    verdict = "muted"
    generation = 7
    suppresses = True


def finished_evidence() -> Evidence:
    """The control episode's settled, quiet, finished reading.

    Description: real evidence, not a stub, so these tests fail for the
      same reasons production would.
    Inputs: none.
    Output: Evidence - resolves to ``done_idle``.
    Example: finished_evidence().now.tzinfo is not None -> True
    """
    episode = load_episode("c_genuinely_idle_one_toast")
    event = episode["events"][-1]
    facts = classify_transcript_records(
        event["transcript_records"], now=parse_iso(event["t"])
    )
    return evidence_for(event, episode, parse_iso(event["t"]), facts)


def build_watcher(**overrides: Any) -> Tuple[AttentionWatcher, Dict[str, list]]:
    """A watcher wired to recording stubs, with one target.

    Description: the ledger is PRIMED with the ``busy`` state a running
      watcher would have been holding, for the same reason the episode
      replays are: without it the first reading is the baseline and a
      session that is already finished is correctly not news, which is
      the wrong starting condition for a test about what happens next.
    Inputs: overrides - constructor keywords to replace.
    Output: (watcher, log) where log has ``toasts``, ``unread`` and
      ``busy`` lists.
    Example: watcher, log = build_watcher()
    """
    log: Dict[str, list] = {"toasts": [], "unread": [], "busy": []}
    target = WatchTarget(session_id="ses_x", key="cloude_x@1")
    ledger = AttentionLedger()
    long_ago = datetime(2020, 1, 1, tzinfo=timezone.utc)
    for key in ("cloude_x@1", "cloude_good@1", "cloude_bad@1"):
        ledger.observe(key, priming_verdict(), long_ago)
    kwargs: Dict[str, Any] = {
        "list_targets": lambda: [target],
        "read_evidence": lambda tgt, now: finished_evidence(),
        "raise_toast": lambda tgt, kind, tr: log["toasts"].append(kind),
        "set_unread": lambda tgt: log["unread"].append(tgt.key),
        "on_busy_edge": lambda tgt, tr: log["busy"].append(tr.reason),
        "ledger": ledger,
        "tick_seconds": 0.01,
        "registry_directory": os.path.join(FIXTURE_DIR, "no-such-registry-dir"),
    }
    kwargs.update(overrides)
    return AttentionWatcher(**kwargs), log


def test_one_unreadable_session_does_not_cost_the_others_their_tick():
    """A watcher that dies takes every notification with it."""
    good = WatchTarget(session_id="ses_good", key="cloude_good@1")
    bad = WatchTarget(session_id="ses_bad", key="cloude_bad@1")

    def read(target: WatchTarget, now: datetime) -> Evidence:
        if target is bad:
            raise OSError("transcript vanished mid read")
        return finished_evidence()

    watcher, log = build_watcher(
        list_targets=lambda: [bad, good], read_evidence=read
    )
    # The bad one never resolves at all, and never blocks the good one.
    asyncio.run(_drive(watcher, 2))
    assert log["toasts"] == ["Stop"]


def test_a_listing_that_throws_does_not_escape_the_tick():
    """Without a target list there is nothing to do, and that is all."""

    def explode() -> list:
        raise RuntimeError("registry snapshot failed")

    watcher, log = build_watcher(list_targets=explode)
    assert asyncio.run(watcher.tick_once()) == 0
    assert log["toasts"] == []


def test_an_action_that_throws_does_not_stop_the_next_edge():
    """The actions belong to the caller and can fail for its reasons."""

    def boom(target: WatchTarget) -> None:
        raise ValueError("unread store is locked")

    watcher, log = build_watcher(set_unread=boom)
    asyncio.run(_drive(watcher, 2))
    # The unread write failed, and the toast still went out.
    assert log["toasts"] == ["Stop"]


def test_a_muted_session_still_sets_unread_but_raises_no_toast():
    """SUPPRESSING IS NOT ACKNOWLEDGING.

    The user asked for silence, so the interruption is skipped. The
    session still finished, so the flag is still written and its light
    still says so.
    """
    watcher, log = build_watcher(
        read_policy=lambda target: (True, SuppressingPolicy())
    )
    asyncio.run(_drive(watcher, 2))
    assert log["toasts"] == []
    assert log["unread"] == ["cloude_x@1"]


def test_an_unreadable_policy_suppresses_rather_than_guessing():
    """An unanswered mute may not be read as "not muted"."""
    watcher, log = build_watcher(read_policy=lambda target: (True, None))
    asyncio.run(_drive(watcher, 2))
    assert log["toasts"] == []


def test_a_policy_reader_that_throws_suppresses_too():
    """A throw is one of the two ways a policy comes back unreadable."""

    def explode(target: WatchTarget) -> Tuple[bool, Any]:
        raise RuntimeError("policy store is gone")

    watcher, log = build_watcher(read_policy=explode)
    asyncio.run(_drive(watcher, 2))
    assert log["toasts"] == []


def test_no_policy_store_attached_raises_exactly_as_before_mute_shipped():
    """CAN THIS CHECK GO RED. The same three tests above, unmuted."""
    watcher, log = build_watcher(read_policy=None)
    asyncio.run(_drive(watcher, 2))
    assert log["toasts"] == ["Stop"]


def test_the_loop_runs_ticks_and_stops_on_cancellation():
    """``run`` must tick, and must stop when its task is cancelled."""

    async def drive() -> list:
        watcher, log = build_watcher()
        task = asyncio.create_task(watcher.run())
        for _ in range(200):
            await asyncio.sleep(0)
            if log["toasts"]:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return log["toasts"]

    assert asyncio.run(drive()) == ["Stop"]


def test_a_poke_wakes_the_wait_without_running_out_the_interval():
    """The early wake exists so a change is not held for a whole tick."""

    async def drive() -> str:
        # A tick long enough that returning on it would be a failure.
        watcher, _ = build_watcher(tick_seconds=30.0)
        watcher.poke("cloude_x@1")
        return await asyncio.wait_for(watcher._wait_for_work(), timeout=1.0)

    assert asyncio.run(drive()) == "poke"


def test_a_poke_arriving_during_a_wait_still_releases_it():
    """A poke raised from another callback, not before the wait."""

    async def drive() -> str:
        watcher, _ = build_watcher(tick_seconds=30.0)
        asyncio.get_running_loop().call_later(0.01, watcher.poke, "cloude_x@1")
        return await asyncio.wait_for(watcher._wait_for_work(), timeout=1.0)

    assert asyncio.run(drive()) == "poke"


def test_an_absent_registry_directory_leaves_the_watcher_on_the_tick():
    """A machine where claude has never run is a supported configuration."""

    async def drive() -> str:
        watcher, _ = build_watcher(tick_seconds=0.01)
        watcher._open_watch()
        try:
            return await asyncio.wait_for(watcher._wait_for_work(), timeout=1.0)
        finally:
            watcher._close_watch()

    assert asyncio.run(drive()) == "tick"


@pytest.mark.skipif(
    not KQUEUE_AVAILABLE,
    reason="no kqueue on this platform, so the early wake is the plain "
    "interval by design and there is nothing here to measure",
)
def test_the_directory_watch_wakes_on_a_session_appearing_and_leaving(tmp_path):
    """THE MECHANISM THE EARLY WAKE RESTS ON, measured end to end.

    A kqueue watch on a DIRECTORY descriptor is the thing the whole
    cadence claim depends on, and it had never been exercised on one:
    every other user of PipeWaiter in this codebase hands it a regular
    file. So this asserts all three halves of the design note in the
    watcher's module docstring: a registry file APPEARING wakes it, one
    being REMOVED wakes it, and an IN-PLACE REWRITE of a file inside the
    directory does NOT, which is why the tick and not the watch is what
    covers a status change.
    """

    async def drive() -> Tuple[bool, bool, bool]:
        watcher, _ = build_watcher(
            tick_seconds=2.0, registry_directory=str(tmp_path)
        )
        watcher._open_watch()
        try:
            assert watcher._waiter is not None and watcher._waiter.watching
            loop = asyncio.get_running_loop()
            record = tmp_path / "4242.json"
            loop.call_later(0.02, record.write_text, "{}")
            created = await watcher._backstop()
            loop.call_later(0.02, record.unlink)
            removed = await watcher._backstop()
            # A file that already exists, rewritten where it lies. The
            # directory itself is untouched, so this must time out.
            held = tmp_path / "77.json"
            held.write_text("{}")
            await watcher._backstop()
            watcher.tick_seconds = 0.3
            loop.call_later(0.02, held.write_text, '{"status": "idle"}')
            rewritten = await watcher._backstop()
            return created, removed, rewritten
        finally:
            watcher._close_watch()

    created, removed, rewritten = asyncio.run(drive())
    assert created is True
    assert removed is True
    assert rewritten is False


async def _drive(watcher: AttentionWatcher, passes: int) -> None:
    """Run ``passes`` ticks with no waiting. Inputs: watcher, passes."""
    for _ in range(passes):
        await watcher.tick_once()
