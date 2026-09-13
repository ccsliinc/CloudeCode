"""Every job the hook route secretly owned still runs, with no hook.

**THIS FILE EXISTS BECAUSE THESE EIGHT JOBS HAVE NO OTHER WITNESS.** The
hook endpoint is about to be deleted. Six of the things it did were
notifications and one was a status; the rest were side effects nobody
would miss on the day they stopped: a startup-gate stamp, an agent
inference, a durable status write, the column the whole session list is
sorted by, a toast auto-ack, the only pull that can see a ``/rename``
typed inside claude, and the binding that tells the app which
conversation a session is having. Delete the route with no test naming
them and every one fails silently, in a way that surfaces days later as
"the ordering looks wrong" or "the light never goes out".

**THE EIGHTH WAS MISSED THE FIRST TIME AND A LIVE SOAK FOUND IT**, which
is the argument for the rest of the file: the suite was 7087 green while
``sessions.claude_session_uuid`` had no writer at all, because no test
named the binding.

**EVERY TEST HERE HAS A TWIN THAT PROVES IT CAN GO RED** (gotcha 11): for
each job, one test drives its passive trigger and asserts the job ran,
and one withholds the evidence and asserts it did NOT. A test that only
ever sees the happy path would pass just as well against a module that
ran all seven unconditionally, which is a different and worse bug.

**THE AUTO-ACK PAIR IS THE POINT OF THE WHOLE PULL REQUEST.** A real user
prompt clears a pending toast; a ``task-notification``, which is a
background agent reporting back with no human anywhere near the keyboard,
must not. Reading the second as the first is the exact defect class that
raised 410 false notifications in 50.8 hours.
"""

from __future__ import annotations

import types
from datetime import datetime, timedelta, timezone

import pytest

from src.core.attention import side_effects as side_effects_module
from src.core.attention.evidence import (
    AttentionVerdict,
    Evidence,
    FAMILY_CLAUDE,
    REASON_STREAMING,
    REASON_TURN_ENDED,
    STATE_BUSY,
    STATE_DONE_IDLE,
    TIER_REGISTRY,
)
from src.core.attention.ledger import AttentionLedger
from src.core.attention.registry_read import (
    REG_STALE,
    parse_registry_record,
    registry_for_session,
)
from src.core.attention.side_effects import AttentionSideEffects
from src.core.attention.transcript_facts import FACTS_FOUND, TranscriptFacts
from src.core.attention.watcher import Observation, WatchTarget
from src.core.db_models import SESSION_CLAUDE_UUID_SOURCE_REGISTRY
from src.core.session_lineage import (
    LINEAGE_BOUND,
    LINEAGE_CONTINUED,
    LINEAGE_UNRESOLVED,
    LineageResult,
)
from src.core.session_startup_gate_ledger import StartupGateLedger
from src.core.session_status import LIVENESS_LIVE

NOW = datetime(2026, 9, 13, 18, 0, 0, tzinfo=timezone.utc)
TMUX_NAME = "cloude_sideeffects"
EPOCH = 1789095742
SESSION_ID = "ses_side"
TARGET = WatchTarget(session_id=SESSION_ID, key="%s@%d" % (TMUX_NAME, EPOCH))

#: The conversation the registry record names. Spelled once so the
#: binding tests and the record builder cannot drift apart.
CONVERSATION_UUID = "11111111-2222-3333-4444-555555555555"

#: The folder-trust dialog as claude paints it, so the startup-gate tests
#: drive a tail that MATCHES a marker. Without it both gate tests would
#: answer ``ready`` for the same reason and the pair would prove nothing.
TRUST_DIALOG_TAIL = "  Yes, I trust this folder"


# ---------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------


class RecordingManager:
    """A session manager that records what was asked of it.

    Description: carries exactly the members ``side_effects`` reaches
      for, and no more, so a member that MOVES raises here instead of
      answering falsy (gotcha 12). The startup gate is the REAL ledger
      rather than a recorder, because the assertion that matters is that
      the gate's own rung 1 goes ready, not that a method was called.
    Inputs: none.
    Output: n/a (test double).
    Example: mgr = RecordingManager()
    """

    def __init__(self) -> None:
        """Start with nothing recorded. Inputs: none. Output: None."""
        self._registry = types.SimpleNamespace(backends={})
        self.hook_tokens = types.SimpleNamespace(name_for=lambda sid: TMUX_NAME)
        self._instance_epochs = {SESSION_ID: EPOCH}
        self._startup_gate_ledger = StartupGateLedger()
        self._unread_store = types.SimpleNamespace(set_flag=self._set_flag)
        self.unread_writes: list = []
        self.state_writes: list = []
        self.work_stamps: list = []
        self.acks: list = []
        self.ack_returns: list = []
        self.lifecycle_events: list = []
        self.lifecycle_outcomes: list = []

    def _set_flag(self, tmux_name, field_name, value, epoch=None):
        """Record one unread write. Output: None."""
        self.unread_writes.append((tmux_name, field_name, value, epoch))

    def _unread_epoch(self, tmux_name):
        """The epoch the unread flag is keyed on. Output: int."""
        return EPOCH

    def _persist_settled_activity_state(self, tmux_name, state, epoch):
        """Record one durable status write. Output: None."""
        self.state_writes.append((tmux_name, state, epoch))

    def _persist_work_stamp(self, session_id, tmux_name, kind):
        """Record one ``last_work_at`` stamp. Output: None."""
        self.work_stamps.append((session_id, tmux_name, kind))

    def auto_ack_toasts(self, session_id, event_kind, cutoff=None):
        """Record one auto-ack and answer with the queued ids. Output: list."""
        self.acks.append((session_id, event_kind, cutoff))
        return list(self.ack_returns)

    def record_claude_lifecycle_event(
        self, session_id, event_kind, payload, *, uuid_source="hook",
        tmux_name=None,
    ):
        """Record one conversation binding. Output: the REAL LineageResult.

        The real result type rather than a stand-in, because the caller
        reads ``outcome`` off it to decide whether to memoise, and a
        namespace would let a renamed field pass (gotcha 12). Answers
        ``bound`` unless a test has queued something else.
        """
        self.lifecycle_events.append(
            (session_id, event_kind, payload, uuid_source, tmux_name)
        )
        outcome = (
            self.lifecycle_outcomes.pop(0)
            if self.lifecycle_outcomes
            else LINEAGE_BOUND
        )
        return LineageResult(outcome=outcome, row_id=1)


@pytest.fixture()
def wired(monkeypatch):
    """A manager, its side-effect layer, and the two pulls stubbed out.

    Description: ``apply_agent_inference`` and ``sync_claude_title`` read
      the process table and a transcript, so they are replaced with
      recorders. Everything else is the real call.
    Inputs: monkeypatch.
    Output: (manager, effects, calls) where ``calls`` has ``infer``,
      ``title``, ``ack_frames`` and ``rename_frames`` lists.
    Example: mgr, effects, calls = wired
    """
    calls = {"infer": [], "title": [], "ack_frames": [], "rename_frames": []}

    def fake_infer(manager, session_id, tmux_name):
        calls["infer"].append((session_id, tmux_name))
        return None

    def fake_title(manager, session_id):
        calls["title"].append(session_id)
        return types.SimpleNamespace(broadcast_title=None)

    monkeypatch.setattr(
        side_effects_module.session_agent_infer_apply,
        "apply_agent_inference",
        fake_infer,
    )
    monkeypatch.setattr(
        side_effects_module.claude_title_sync_apply, "sync_claude_title", fake_title
    )
    manager = RecordingManager()
    effects = AttentionSideEffects(
        manager,
        broadcast_toast_ack=lambda sid, tid: calls["ack_frames"].append((sid, tid)),
        broadcast_rename=lambda sid, name: calls["rename_frames"].append((sid, name)),
    )
    return manager, effects, calls


# ---------------------------------------------------------------------
# Evidence builders
# ---------------------------------------------------------------------


def registry_ok(status: str = "idle", session_uuid: str = CONVERSATION_UUID):
    """A real REG_OK record, through the real parser. Output: RegistryRecord."""
    return parse_registry_record(
        {
            "pid": 4242,
            "status": status,
            "sessionId": session_uuid,
            "cwd": "/tmp",
            "tmux": "%s:@0.%%0" % TMUX_NAME,
            "version": "2.1.266",
        },
        path_pid=4242,
    )


def registry_unreadable():
    """A real refusal, through the real parser. Output: RegistryRecord."""
    return parse_registry_record({}, path_pid=None)


def facts(**fields) -> TranscriptFacts:
    """Transcript facts with nothing in them but what the test names.

    Inputs: fields - any ``TranscriptFacts`` field.
    Output: TranscriptFacts.
    """
    fields.setdefault("verdict", FACTS_FOUND)
    return TranscriptFacts(**fields)


def evidence(*, registry=None, transcript=None, now=NOW) -> Evidence:
    """One bundle, live pane, claude family. Output: Evidence."""
    return Evidence(
        tmux_liveness=LIVENESS_LIVE,
        agent_family=FAMILY_CLAUDE,
        registry=registry if registry is not None else registry_ok(),
        transcript=transcript if transcript is not None else facts(),
        pane=None,
        now=now,
    )


def verdict(state: str = STATE_DONE_IDLE, reason: str = REASON_TURN_ENDED):
    """A verdict with no settle and no pending count. Output: AttentionVerdict."""
    return AttentionVerdict(state=state, reason=reason, tier=TIER_REGISTRY)


def observation(
    *, registry=None, transcript=None, prompt_at=None, appended=False, state=None
) -> Observation:
    """One reading, assembled the way the watcher assembles it.

    Inputs: registry, transcript - evidence overrides. prompt_at - the
      new-user-prompt answer. appended - the transcript-grew answer.
      state - a verdict state override.
    Output: Observation.
    """
    return Observation(
        verdict=verdict() if state is None else verdict(state=state, reason=REASON_STREAMING),
        evidence=evidence(registry=registry, transcript=transcript),
        new_user_prompt_at=prompt_at,
        transcript_appended=appended,
    )


# ---------------------------------------------------------------------
# Job 1: the startup gate, rung 1
# ---------------------------------------------------------------------


def test_a_registry_record_opens_the_startup_gate(wired):
    """"Has this session started at all" is now "has claude registered".

    The gate's LADDER is untouched: rung 1 still reads
    ``StartupGateLedger.first_hook_at``. Only its input moved, from "any
    hook landed" to "a registry record exists", which is what the plan
    asked for.
    """
    from src.core.session_startup_gate import GATE_READY, resolve_startup_gate

    manager, effects, _calls = wired
    effects.on_observation(TARGET, observation(registry=registry_ok()))

    first = manager._startup_gate_ledger.first_hook_at(TMUX_NAME)
    assert first is not None
    # RUNG 1 IS ASSERTED THROUGH THE REAL LADDER, and against a tail that
    # would otherwise answer "still on the trust dialog", which is what
    # makes this a statement about rung ORDER rather than about one flag.
    assert (
        resolve_startup_gate(
            pane_alive=True,
            first_hook_at=first,
            instance_age_seconds=600.0,
            tail=TRUST_DIALOG_TAIL,
        )
        == GATE_READY
    )


def test_no_registry_record_leaves_the_startup_gate_shut(wired):
    """The can-go-red twin. A pane on its folder-trust dialog registers
    nothing, because that screen runs BEFORE claude registers itself, and
    a gate that opened anyway would light every launching session green.
    """
    from src.core.session_startup_gate import GATE_AWAITING, resolve_startup_gate

    manager, effects, _calls = wired
    effects.on_observation(TARGET, observation(registry=registry_unreadable()))
    first = manager._startup_gate_ledger.first_hook_at(TMUX_NAME)
    assert first is None
    assert (
        resolve_startup_gate(
            pane_alive=True,
            first_hook_at=first,
            instance_age_seconds=600.0,
            tail=TRUST_DIALOG_TAIL,
        )
        == GATE_AWAITING
    )


def test_the_startup_stamp_is_first_write_wins(wired):
    """Idempotent, which is what lets the hook path stay live beside it."""
    manager, effects, _calls = wired
    effects.on_observation(TARGET, observation(registry=registry_ok()))
    first = manager._startup_gate_ledger.first_hook_at(TMUX_NAME)
    effects.on_observation(TARGET, observation(registry=registry_ok()))
    assert manager._startup_gate_ledger.first_hook_at(TMUX_NAME) == first


# ---------------------------------------------------------------------
# Job 2: the agent inference
# ---------------------------------------------------------------------


def test_a_registry_record_triggers_the_agent_inference(wired):
    _manager, effects, calls = wired
    effects.on_observation(TARGET, observation(registry=registry_ok()))
    assert calls["infer"] == [(SESSION_ID, TMUX_NAME)]


def test_a_growing_transcript_triggers_the_agent_inference(wired):
    """A pane given a hand-typed claude has a transcript before we can
    read anything else about it."""
    _manager, effects, calls = wired
    effects.on_observation(
        TARGET, observation(registry=registry_unreadable(), appended=True)
    )
    assert calls["infer"] == [(SESSION_ID, TMUX_NAME)]


def test_no_sign_of_life_does_not_trigger_the_agent_inference(wired):
    """The can-go-red twin: a bare shell is not a claude."""
    _manager, effects, calls = wired
    effects.on_observation(
        TARGET, observation(registry=registry_unreadable(), appended=False)
    )
    assert calls["infer"] == []


# ---------------------------------------------------------------------
# Job 3: the auto-unread flag
# ---------------------------------------------------------------------


def test_the_done_edge_sets_the_auto_unread_flag(wired):
    """What the ``Stop`` hook did last, now on the edge into ``done_idle``."""
    manager, effects, _calls = wired
    effects.set_unread(TARGET)
    assert manager.unread_writes == [(TMUX_NAME, "auto", True, EPOCH)]


def test_a_session_with_no_tmux_name_sets_no_flag(wired):
    """The can-go-red twin. ONE FLAG, ONE KEY: with no name there is no
    key, and a flag filed under a guess would light the wrong pane."""
    manager, effects, _calls = wired
    manager.hook_tokens.name_for = lambda sid: None
    effects.set_unread(TARGET)
    assert manager.unread_writes == []


# ---------------------------------------------------------------------
# Job 4: the durable activity state
# ---------------------------------------------------------------------


def test_every_reading_makes_the_resolved_state_durable(wired):
    """Without this a restart forgets what every session was doing, and
    the tmux fallback answers a confident ``idle`` rather than unknown."""
    manager, effects, _calls = wired
    effects.on_observation(TARGET, observation())
    assert manager.state_writes == [(TMUX_NAME, "idle", EPOCH)]


def test_a_busy_reading_persists_working_not_idle(wired):
    manager, effects, _calls = wired
    effects.on_observation(TARGET, observation(state=STATE_BUSY))
    assert manager.state_writes == [(TMUX_NAME, "working", EPOCH)]


def test_no_tmux_name_persists_nothing(wired):
    """The can-go-red twin: a name-less row has nothing to key a write on."""
    manager, effects, _calls = wired
    manager.hook_tokens.name_for = lambda sid: None
    effects.on_observation(TARGET, observation())
    assert manager.state_writes == []


# ---------------------------------------------------------------------
# Job 5: sessions.last_work_at, the sort key
# ---------------------------------------------------------------------


def test_a_new_user_prompt_stamps_the_work_time(wired):
    """THE SORT KEY OF THE WHOLE SESSION LIST. A regression here silently
    reorders every list the user reads and breaks nothing else, so it
    gets its own test rather than riding on another one."""
    manager, effects, _calls = wired
    effects.on_observation(TARGET, observation(prompt_at=NOW))
    assert manager.work_stamps == [(SESSION_ID, TMUX_NAME, None)]


def test_the_busy_edge_stamps_the_work_time(wired):
    from src.core.attention.ledger import Transition

    manager, effects, _calls = wired
    effects.on_busy_edge(
        TARGET,
        Transition(
            key=TARGET.key,
            state=STATE_BUSY,
            reason=REASON_STREAMING,
            verdict=verdict(state=STATE_BUSY, reason=REASON_STREAMING),
            previous_state=STATE_DONE_IDLE,
            at=NOW,
        ),
    )
    assert manager.work_stamps == [(SESSION_ID, TMUX_NAME, None)]


def test_a_quiet_reading_stamps_nothing(wired):
    """The can-go-red twin. A session merely being LOOKED AT is not work,
    which is the defect ``last_work_at`` exists to keep out of the sort."""
    manager, effects, _calls = wired
    effects.on_observation(TARGET, observation())
    assert manager.work_stamps == []


def test_a_none_kind_reaches_the_real_stamp():
    """The passive caller's ``None`` kind is not filtered out.

    Drives the REAL ``SessionManager._persist_work_stamp`` rather than a
    double, because the thing being asserted is that widening the filter
    did not break the filter: the two lifecycle events must still be
    refused and a kind-less call must still get through.
    """
    from src.core.session_manager import SessionManager

    calls: list = []
    probe = types.SimpleNamespace(
        _last_work_stamp_at={},
        _instance_epochs={},
        _work_stamp_epoch=lambda sid, name: calls.append((sid, name)) or None,
    )
    SessionManager._persist_work_stamp(probe, "ses_a", "cloude_x", None)
    assert calls == [("ses_a", "cloude_x")]
    SessionManager._persist_work_stamp(probe, "ses_b", "cloude_x", "SessionStart")
    assert len(calls) == 1


# ---------------------------------------------------------------------
# Job 6: the auto-ack, and the bug this pull request exists to kill
# ---------------------------------------------------------------------


def test_a_new_user_prompt_clears_the_pending_toasts(wired):
    """The passive ``UserPromptSubmit``: the user turned up, so every
    notification asking them to turn up is answered."""
    manager, effects, calls = wired
    manager.ack_returns = ["toast_1", "toast_2"]
    effects.on_observation(TARGET, observation(prompt_at=NOW))

    assert len(manager.acks) == 1
    session_id, kind, cutoff = manager.acks[0]
    assert (session_id, kind) == (SESSION_ID, "UserPromptSubmit")
    assert calls["ack_frames"] == [
        (SESSION_ID, "toast_1"),
        (SESSION_ID, "toast_2"),
    ]


def test_a_task_notification_clears_nothing(wired):
    """**THE EXACT BUG CLASS THIS PULL REQUEST EXISTS TO KILL.**

    A background agent reporting back writes a ``user`` record with
    ``origin.kind == task-notification`` and no human is anywhere near
    the keyboard. The transcript reader refuses to count it as a user
    prompt, so ``new_user_prompt_at`` stays None and nothing is
    dismissed. Driven through the REAL classifier, because the refusal
    lives there and a hand-set None would assert nothing.
    """
    from src.core.attention.transcript_facts import classify_transcript_records

    manager, effects, _calls = wired
    stamp = NOW.isoformat().replace("+00:00", "Z")
    notice = {
        "type": "user",
        "timestamp": stamp,
        "origin": {"kind": "task-notification"},
        "promptSource": "system",
        "message": {
            "role": "user",
            "content": "<task-notification><status>completed</status>",
        },
    }
    read = classify_transcript_records([notice], now=NOW)
    assert read.newest_user_prompt_at is None, "the reader counted a notice"

    ledger = AttentionLedger()
    ledger.note_transcript(
        TARGET.key, user_prompt_at=None, append_at=NOW - timedelta(seconds=60)
    )
    new_prompt, _appended = ledger.note_transcript(
        TARGET.key,
        user_prompt_at=read.newest_user_prompt_at,
        append_at=read.newest_append_at,
    )
    effects.on_observation(
        TARGET, observation(prompt_at=new_prompt, appended=_appended)
    )
    assert manager.acks == []
    assert manager.work_stamps == []


def test_a_real_user_prompt_survives_the_same_reader(wired):
    """The other half of the pair: the reader does not refuse everything.

    A test that only proved the notice was ignored would pass against a
    reader that ignored every record, which is the failure shape gotcha
    11 names.
    """
    from src.core.attention.transcript_facts import classify_transcript_records

    manager, effects, _calls = wired
    stamp = NOW.isoformat().replace("+00:00", "Z")
    typed = {
        "type": "user",
        "timestamp": stamp,
        "message": {"role": "user", "content": "run the tests"},
    }
    read = classify_transcript_records([typed], now=NOW)
    assert read.newest_user_prompt_at is not None

    ledger = AttentionLedger()
    ledger.note_transcript(
        TARGET.key, user_prompt_at=None, append_at=NOW - timedelta(seconds=60)
    )
    new_prompt, appended = ledger.note_transcript(
        TARGET.key,
        user_prompt_at=read.newest_user_prompt_at,
        append_at=read.newest_append_at,
    )
    assert new_prompt is not None
    effects.on_observation(TARGET, observation(prompt_at=new_prompt, appended=appended))
    assert [call[1] for call in manager.acks] == ["UserPromptSubmit"]
    assert manager.work_stamps == [(SESSION_ID, TMUX_NAME, None)]


def test_the_ack_cutoff_is_naive_utc(wired):
    """``Toast.created_at`` is naive UTC and the package is aware UTC.

    The ordering guard degrades to "not after" on a mismatch, silently
    dropping itself, so the conversion is asserted rather than assumed.
    """
    manager, effects, _calls = wired
    effects.on_observation(TARGET, observation(prompt_at=NOW))
    cutoff = manager.acks[0][2]
    assert cutoff is not None and cutoff.tzinfo is None
    assert cutoff == NOW.replace(tzinfo=None)


def test_the_busy_edge_answers_a_permission_and_nothing_else(wired):
    """A tool that is RUNNING proves the permission was granted. That set
    is one member wide on purpose, and it is selected by naming the rule,
    not by respelling it here."""
    from src.core.attention.ledger import Transition
    from src.core.toast_auto_ack import kinds_answered_by

    manager, effects, _calls = wired
    effects.on_busy_edge(
        TARGET,
        Transition(
            key=TARGET.key,
            state=STATE_BUSY,
            reason=REASON_STREAMING,
            verdict=verdict(state=STATE_BUSY, reason=REASON_STREAMING),
            previous_state=STATE_DONE_IDLE,
            at=NOW,
        ),
    )
    assert [call[1] for call in manager.acks] == ["PreToolUse"]
    assert kinds_answered_by("PreToolUse") == frozenset({"PermissionRequest"})


# ---------------------------------------------------------------------
# Job 7: the /rename typed inside claude
# ---------------------------------------------------------------------


def test_a_growing_transcript_pulls_the_claude_title(wired):
    """The only way the app can see a ``/rename``: no event carries one."""
    _manager, effects, calls = wired
    effects.on_observation(TARGET, observation(appended=True))
    assert calls["title"] == [SESSION_ID]


def test_a_quiet_transcript_pulls_nothing(wired):
    """The can-go-red twin, and the cost argument: an unchanged file is
    not read again."""
    _manager, effects, calls = wired
    effects.on_observation(TARGET, observation(appended=False))
    assert calls["title"] == []


def test_a_changed_title_reaches_the_wire(monkeypatch):
    """A name typed in the pane updates every attached tab, through the
    same frame the browser rename broadcasts."""
    calls: list = []
    monkeypatch.setattr(
        side_effects_module.claude_title_sync_apply,
        "sync_claude_title",
        lambda manager, sid: types.SimpleNamespace(broadcast_title="renamed"),
    )
    monkeypatch.setattr(
        side_effects_module.session_agent_infer_apply,
        "apply_agent_inference",
        lambda manager, sid, name: None,
    )
    effects = AttentionSideEffects(
        RecordingManager(),
        broadcast_rename=lambda sid, name: calls.append((sid, name)),
    )
    effects.on_observation(TARGET, observation(appended=True))
    assert calls == [(SESSION_ID, "renamed")]


# ---------------------------------------------------------------------
# Containment: one broken job must not cost the other six their tick
# ---------------------------------------------------------------------


def test_one_failing_job_does_not_stop_the_others(wired):
    """Every notification on the machine is raised from inside this tick."""
    manager, effects, calls = wired

    def boom(*args, **kwargs):
        raise RuntimeError("the process table went away")

    monkey = side_effects_module.session_agent_infer_apply
    original = monkey.apply_agent_inference
    monkey.apply_agent_inference = boom
    try:
        effects.on_observation(TARGET, observation(prompt_at=NOW, appended=True))
    finally:
        monkey.apply_agent_inference = original

    assert manager._startup_gate_ledger.first_hook_at(TMUX_NAME) is not None
    assert manager.state_writes and manager.work_stamps and manager.acks
    assert calls["title"] == [SESSION_ID]


# ---------------------------------------------------------------------
# The ledger's evidence baselines, which every trigger above rests on
# ---------------------------------------------------------------------


def test_the_first_reading_is_not_a_new_user_prompt():
    """**THE BOOT-STORM GUARD.** Every session on the machine has an old
    prompt sitting in its transcript. Reading those as news on the first
    tick after a restart would clear every toast the user has not read.
    """
    ledger = AttentionLedger()
    new_prompt, appended = ledger.note_transcript(
        "k", user_prompt_at=NOW - timedelta(hours=9), append_at=NOW
    )
    assert new_prompt is None
    assert appended is True, "an append on first sight is a cheap, idempotent pull"


def test_a_later_prompt_is_news_and_the_same_one_is_not():
    ledger = AttentionLedger()
    ledger.note_transcript("k", user_prompt_at=NOW, append_at=NOW)
    again, _ = ledger.note_transcript("k", user_prompt_at=NOW, append_at=NOW)
    assert again is None
    later = NOW + timedelta(seconds=5)
    fresh, appended = ledger.note_transcript("k", user_prompt_at=later, append_at=later)
    assert fresh == later
    assert appended is True


def test_an_unchanged_transcript_is_not_an_append():
    ledger = AttentionLedger()
    ledger.note_transcript("k", user_prompt_at=None, append_at=NOW)
    _prompt, appended = ledger.note_transcript("k", user_prompt_at=None, append_at=NOW)
    assert appended is False


def test_forgetting_an_instance_drops_its_baselines():
    """The next session to compose the same key starts clean, rather than
    inheriting a prompt from a conversation that no longer exists."""
    ledger = AttentionLedger()
    ledger.note_transcript("k", user_prompt_at=NOW, append_at=NOW)
    ledger.forget("k")
    new_prompt, appended = ledger.note_transcript(
        "k", user_prompt_at=NOW, append_at=NOW
    )
    assert new_prompt is None and appended is True


# ---------------------------------------------------------------------
# End to end through the real watcher
# ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_watcher_runs_the_observation_jobs_every_tick(wired):
    """The wiring itself, not just the callables: an unwired action is a
    job that still dies when the route goes."""
    import os

    from src.core.attention.watcher import AttentionWatcher

    manager, effects, calls = wired
    reading = evidence(registry=registry_ok(), transcript=facts(newest_append_at=NOW))
    watcher = AttentionWatcher(
        list_targets=lambda: [TARGET],
        read_evidence=lambda target, now: reading,
        raise_toast=lambda target, kind, transition: None,
        set_unread=effects.set_unread,
        on_busy_edge=effects.on_busy_edge,
        on_observation=effects.on_observation,
        ledger=AttentionLedger(),
        now=lambda: NOW,
        tick_seconds=0.0,
        registry_directory=os.path.join(os.sep, "no-such-registry-dir"),
    )
    await watcher.tick_once()

    assert manager._startup_gate_ledger.first_hook_at(TMUX_NAME) is not None
    assert calls["infer"] == [(SESSION_ID, TMUX_NAME)]
    assert calls["title"] == [SESSION_ID]
    assert manager.state_writes


@pytest.mark.asyncio
async def test_a_watcher_with_no_observation_wiring_still_ticks():
    """The replay suite and every build without a composition site pass
    no observation callable at all; that must stay a working shape."""
    import os

    from src.core.attention.watcher import AttentionWatcher

    reading = evidence()
    watcher = AttentionWatcher(
        list_targets=lambda: [TARGET],
        read_evidence=lambda target, now: reading,
        raise_toast=lambda target, kind, transition: None,
        set_unread=lambda target: None,
        on_busy_edge=lambda target, transition: None,
        ledger=AttentionLedger(),
        now=lambda: NOW,
        tick_seconds=0.0,
        registry_directory=os.path.join(os.sep, "no-such-registry-dir"),
    )
    assert await watcher.tick_once() == 0


# ---------------------------------------------------------------------
# Job 8: the conversation binding, sessions.claude_session_uuid
# ---------------------------------------------------------------------
#
# THIS JOB WAS MISSED WHEN THE OTHER SEVEN WERE REHOMED, AND THE WHOLE
# SUITE STAYED GREEN WHILE THE PRODUCT DID NOT WORK. The hook route was
# the only writer of the column that tells the app which conversation a
# session is having; with the route gone the column stayed NULL, so the
# transcript tier answered "no conversation is bound to this row" for
# every session forever and the states derived from it - a finished turn,
# an unread finish, a session waiting on its own sub-agents - could not
# be reached at all. Every test below has a twin that can go red.


def test_a_live_registry_record_binds_its_conversation_to_the_row():
    """The happy path: a record that names a conversation writes it.

    The WRITER is the hook's own writer, reached with the hook's own
    event name, so nothing about the UPDATE or its readers changed. What
    moved is the caller and the provenance it declares.
    """
    manager, effects, _calls = _fresh()
    effects.on_observation(TARGET, observation(registry=registry_ok()))

    assert len(manager.lifecycle_events) == 1
    (
        session_id,
        event_kind,
        payload,
        uuid_source,
        pane,
    ) = manager.lifecycle_events[0]
    assert session_id == SESSION_ID
    assert event_kind == "SessionStart"
    assert payload["session_id"] == CONVERSATION_UUID
    assert uuid_source == SESSION_CLAUDE_UUID_SOURCE_REGISTRY
    # THE PANE TRAVELS WITH THE BINDING. Measured on a live server: the
    # writer's own lookup reads the in-memory Session model and then the
    # persisted hook-token map, and after a restart both are empty for a
    # re-adopted session, so every binding answered "no live session
    # carries this cloudecode session id" once per session every two
    # seconds, forever. Passing the pane the rest of the tick is keyed on
    # is what makes the join possible at all.
    assert pane == TMUX_NAME


def test_no_registry_record_binds_nothing():
    """The can-go-red twin. A pane that has registered nothing has told
    us no conversation, and inventing one would bind a row to a file
    that is not its own."""
    manager, effects, _calls = _fresh()
    effects.on_observation(TARGET, observation(registry=registry_unreadable()))
    assert manager.lifecycle_events == []


def test_a_registry_record_with_no_conversation_binds_nothing():
    """A record can be REG_OK and still carry no ``sessionId``. None
    there means NOT KNOWN, and a write keyed on a None uuid would be the
    same false fact one layer down."""
    manager, effects, _calls = _fresh()
    effects.on_observation(
        TARGET, observation(registry=registry_ok(session_uuid=None))
    )
    assert manager.lifecycle_events == []


def test_the_binding_is_not_re_issued_on_every_tick():
    """IDEMPOTENCE, AND IT IS ABOUT COST, NOT CORRECTNESS.

    The writer already refuses to touch the table for a uuid it has seen
    (it answers ``continued``), so a second call is harmless - but
    reaching that answer costs a database connection and a ``tmux
    list-sessions`` subprocess, and on a two second tick that is a
    subprocess per session per tick for the life of the process. Once
    settled, the job stops calling.
    """
    manager, effects, _calls = _fresh()
    for _ in range(5):
        effects.on_observation(TARGET, observation(registry=registry_ok()))
    assert len(manager.lifecycle_events) == 1


def test_a_binding_the_writer_settled_as_already_known_also_stops():
    """``continued`` is a settled answer, not a failure: the table
    already holds this uuid, so there is nothing left to do."""
    manager, effects, _calls = _fresh()
    manager.lifecycle_outcomes = [LINEAGE_CONTINUED]
    effects.on_observation(TARGET, observation(registry=registry_ok()))
    effects.on_observation(TARGET, observation(registry=registry_ok()))
    assert len(manager.lifecycle_events) == 1


def test_a_binding_that_could_not_be_evaluated_is_retried():
    """The can-go-red twin of the memo, and the reason the memo keys on
    the OUTCOME rather than on the call.

    ``unresolved`` is not "nothing to do", it is "we could not tell" -
    most often a tmux listing that did not run - and memoising it would
    leave the row unbound for the life of the process off one bad
    subprocess.
    """
    manager, effects, _calls = _fresh()
    manager.lifecycle_outcomes = [LINEAGE_UNRESOLVED]
    effects.on_observation(TARGET, observation(registry=registry_ok()))
    effects.on_observation(TARGET, observation(registry=registry_ok()))
    assert len(manager.lifecycle_events) == 2


def test_a_new_conversation_in_the_same_pane_binds_again():
    """The memo is keyed on the uuid, not on the session, so a pane that
    genuinely moves to another conversation is not locked out by a
    binding that settled for the previous one."""
    manager, effects, _calls = _fresh()
    effects.on_observation(TARGET, observation(registry=registry_ok()))
    other = "99999999-8888-7777-6666-555555555555"
    effects.on_observation(
        TARGET, observation(registry=registry_ok(session_uuid=other))
    )
    assert [event[2]["session_id"] for event in manager.lifecycle_events] == [
        CONVERSATION_UUID,
        other,
    ]


def test_a_record_naming_another_conversation_never_reaches_the_writer():
    """THE MISMATCH RULE, DRIVEN THROUGH THE REAL GATE.

    A row that already holds conversation A is never rewritten to B by
    this path, and the refusal is upstream: ``registry_for_session`` is
    handed the row's own uuid and answers REG_STALE for a record naming a
    different one, so the record arrives here with ``known`` False. This
    test builds that refusal with the real function rather than asserting
    it by hand, so removing the gate turns it red.
    """
    manager, effects, _calls = _fresh()
    stale = registry_for_session(
        tmux_name=TMUX_NAME,
        index={TMUX_NAME: registry_ok()},
        claude_session_uuid="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    )
    assert stale.verdict == REG_STALE

    effects.on_observation(TARGET, observation(registry=stale))
    assert manager.lifecycle_events == []


def test_a_registry_source_can_never_mint_a_lineage_row():
    """BELT AND BRACES FOR THE SAME RULE, one layer down.

    Reached directly - a future caller, or a gate somebody removes - a
    diverging registry observation must still refuse to write. A registry
    record is a claude PROCESS announcing itself and carries no statement
    that the pane's incumbent conversation moved, so it classifies as a
    sibling and mints nothing.
    """
    from src.core.session_lineage_divergence import (
        DIVERGENCE_SIBLING_PROCESS,
        SESSION_START_SOURCE_REGISTRY,
        classify_uuid_divergence,
        mints_a_row,
    )

    verdict_for_registry = classify_uuid_divergence(SESSION_START_SOURCE_REGISTRY)
    assert verdict_for_registry == DIVERGENCE_SIBLING_PROCESS
    assert mints_a_row(verdict_for_registry) is False


def _fresh():
    """A manager and a side-effect layer with the two pulls stubbed.

    Description: the ``wired`` fixture in this file needs monkeypatch,
    which a plain function cannot take. The binding tests care about one
    job and about call COUNTS across several observations, so they build
    the pair directly and replace the two readers that touch the process
    table and the filesystem.
    Inputs: none.
    Output: (RecordingManager, AttentionSideEffects, dict).
    """
    calls = {"infer": [], "title": []}
    manager = RecordingManager()
    effects = AttentionSideEffects(manager)
    effects._infer_agent = lambda *a: calls["infer"].append(a)
    effects._sync_title = lambda *a: calls["title"].append(a)
    return manager, effects, calls


def test_a_session_with_no_resolvable_pane_binds_nothing():
    """The can-go-red twin of the pane argument. A binding needs an
    INSTANCE, and a name nobody could resolve identifies no row, so the
    job declines rather than handing the writer a None to re-derive."""
    manager, effects, _calls = _fresh()
    effects._bind_conversation(SESSION_ID, None, registry_ok())
    assert manager.lifecycle_events == []
