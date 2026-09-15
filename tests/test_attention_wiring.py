"""The watcher is actually BUILT, actually STARTED, and actually STOPPED.

**THIS FILE EXISTS BECAUSE EVERY OTHER ATTENTION TEST PASSES WITHOUT A
COMPOSITION SITE.** The replay suite, the ledger suite and the
side-effect suite all construct the watcher themselves and drive it by
hand, which is what makes them fast and what makes them blind to the one
defect that matters most: a watcher nothing constructs in ``lifespan``.
On 2026-09-13 that was the actual state of the branch. Every test was
green, and in a running server no toast could be raised, no session's
``last_work_at`` was written, the startup gate never reached ready and a
``/rename`` typed inside claude was never noticed. Nothing reported it,
because nothing here was asking.

**SO THE FIRST TEST BOOTS THE REAL APPLICATION.** Not a mock of the
lifespan, not a grep of ``main.py``: the real ``lifespan`` context
manager, entered and exited, with the assertion made against the tasks
actually alive on the loop. A grep would pass against a
``create_task`` whose result is dropped, and against a second watcher
built further down that wins.

**AND THE REST DRIVE THE PRODUCTION-BUILT OBJECT.** Every watcher below
comes out of :func:`~src.core.attention_wiring.build_attention_watcher`
with nothing injected past the manager, so a callable the builder forgets
to pass is a test failure rather than a job that quietly never runs. That
is the whole shape of the defect this file is about:
``on_observation`` is OPTIONAL on the watcher, leaving it unpassed is a
working configuration, and it orphans five of the seven jobs in silence.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_aw_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_aw_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core import listing_attention  # noqa: E402
from src.core.attention import side_effects as side_effects_module  # noqa: E402
from src.core.attention.registry_read import parse_registry_record  # noqa: E402
from src.core.attention.transcript_facts import (  # noqa: E402
    FACTS_FOUND,
    TranscriptFacts,
)
from src.core.attention.watcher import AttentionWatcher  # noqa: E402
from src.core.attention_wiring import build_attention_watcher  # noqa: E402
from src.core.session_activity import EVENT_STOP  # noqa: E402
from src.models import Toast  # noqa: E402
from src.core.session_status import (  # noqa: E402
    LIVENESS_LIVE,
    STATUS_IDLE,
    STATUS_UNKNOWN,
)
from src.core.session_status_map import StatusMap  # noqa: E402
from src.core.session_startup_gate_ledger import StartupGateLedger  # noqa: E402

SOCKET = "cloude"
EPOCH = 1789095742

#: The one coroutine this whole file is about. Named once so a rename in
#: the watcher cannot leave the boot test passing against nothing.
WATCHER_COROUTINE = "AttentionWatcher.run"


# ---------------------------------------------------------------------
# Bar 1: the real lifespan
# ---------------------------------------------------------------------


def _watcher_tasks():
    """Every live task running the watcher's loop, right now.

    Description: identifies the task by the COROUTINE it is running, not
      by a name the composition site chose, so the assertion survives a
      variable rename in ``main.py`` and fails if the loop itself is ever
      replaced by something else.
    Inputs: none.
    Output: list of asyncio.Task.
    Example: len(_watcher_tasks()) -> 1
    """
    return [
        task
        for task in asyncio.all_tasks()
        if getattr(task.get_coro(), "__qualname__", "") == WATCHER_COROUTINE
    ]


async def _boot_then_shut_down():
    """Run the real ``lifespan`` once and report what the watcher did.

    Description: EVERY FACT IS READ BEFORE ``asyncio.run`` GETS ITS TURN,
      and that is the whole reason this function returns a dict instead
      of the task. ``asyncio.run`` cancels every task still alive when it
      closes the loop, so a ``cancelled()`` read after it returns is True
      whether the shutdown cancelled the watcher or forgot to - a green
      check that looked at nothing (gotcha 11).

      It also asserts NOTHING itself. An assertion raised inside the
      context manager is thrown into the lifespan generator at its
      ``yield``, which skips the rest of teardown and leaves the boot's
      other background work running; the test then hangs instead of
      failing. Facts out, assertions in the test.
    Inputs: none.
    Output: dict of the facts the test asserts on.
    Example: (await _boot_then_shut_down())["created"] -> 1
    """
    from src.main import app, lifespan

    async with lifespan(app):
        created = _watcher_tasks()
        alive_during_boot = [task for task in created if not task.done()]
        watcher = getattr(app.state, "attention_watcher", None)
    return {
        "created": created,
        "alive_during_boot": alive_during_boot,
        "watcher": watcher,
        "done_at_exit": [task.done() for task in created],
        "cancelled_at_exit": [task.cancelled() for task in created],
        "still_running": [task for task in _watcher_tasks() if not task.done()],
    }


def test_the_boot_creates_the_watcher_task_and_the_shutdown_cancels_it():
    """One task exists while the app is up, and it is gone when it is not.

    A grep for ``create_task`` in ``main.py`` proves neither half: the
    result could be discarded, and a cancel that is never awaited can
    return before the loop's ``finally`` releases the kqueue and the
    directory descriptor the early wake holds.
    """
    facts = asyncio.run(_boot_then_shut_down())

    assert len(facts["created"]) == 1, (
        "lifespan must create exactly one attention watcher task; found %d"
        % len(facts["created"])
    )
    assert len(facts["alive_during_boot"]) == 1, (
        "the watcher task must still be running while the app is up"
    )
    assert isinstance(facts["watcher"], AttentionWatcher)
    assert facts["done_at_exit"] == [True], (
        "shutdown must not leave the watcher task running"
    )
    assert facts["cancelled_at_exit"] == [True], (
        "the watcher must end by CANCELLATION, not by returning or raising"
    )
    assert facts["still_running"] == []


# ---------------------------------------------------------------------
# The doubles: everything the production wiring reaches for, and no more
# ---------------------------------------------------------------------


class RecordingManager:
    """A session manager carrying exactly what the wiring touches.

    Description: no more members than the composition site reads, so a
      name that MOVES raises an ``AttributeError`` here rather than
      answering falsy through a ``getattr`` (gotcha 12). The startup-gate
      ledger is the real one, because the claim worth making is that the
      gate opens and not that a method was called.
    Inputs: see :meth:`__init__`.
    Output: n/a (test double).
    Example: mgr = RecordingManager({"ses_a": "cloude_a"})
    """

    def __init__(self, names: dict, reads: dict) -> None:
        """Build a manager over a fixed set of sessions.

        Inputs:
          names: session id to tmux name, one entry per live session.
          reads: tmux name to a (registry, transcript) pair, or to an
            exception INSTANCE to be raised when that session is read.
        Output: None.
        Example: RecordingManager({"a": "cloude_a"}, {"cloude_a": pair})
        """
        self._names = dict(names)
        self._reads = dict(reads)
        self._registry = types.SimpleNamespace(
            sessions={sid: object() for sid in names},
            backends={
                sid: types.SimpleNamespace(
                    tmux_session=name, socket_name=SOCKET
                )
                for sid, name in names.items()
            },
        )
        self.hook_tokens = types.SimpleNamespace(
            name_for=lambda sid: self._names.get(sid)
        )
        self._instance_epochs = {sid: EPOCH for sid in names}
        self._startup_gate_ledger = StartupGateLedger()
        self._unread_store = types.SimpleNamespace(set_flag=self._set_flag)
        self._notification_policy_store = None
        self.unread_writes: list = []
        self.state_writes: list = []
        self.work_stamps: list = []
        self.acks: list = []
        self.toasts: list = []
        self.status_map_builds: int = 0

    # -- the two reads the wiring takes off the listing's own path ----

    def _attention_reads_for(self, *, session_id, tmux_name, epoch, index=None):
        """The two file tiers, or the failure this session is rigged for."""
        answer = self._reads[tmux_name]
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def _build_tmux_status_map(self):
        """One bulk listing, counted so the per-pass memo can be proven."""
        self.status_map_builds += 1
        return StatusMap(
            {name: {"status": STATUS_IDLE} for name in self._names.values()},
            complete=True,
            socket=SOCKET,
        )

    # -- the side-effect surface --------------------------------------

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
        """Record one auto-ack. Output: list of acked toast ids."""
        self.acks.append((session_id, event_kind, cutoff))
        return []

    def record_toast(self, session_id, kind, title, body=None):
        """Record one raised toast. Output: the REAL ``Toast`` model.

        Description: a stand-in object would pass this method and fail
          three lines later, inside the model the composition site builds
          to put the card on the wire, and the watcher would log that as
          an action failure and carry on. The real model is what makes
          this double able to go red for the right reason.
        """
        toast = Toast(
            id="toast_%d" % len(self.toasts),
            session_id=session_id,
            kind=kind,
            title=title,
            body=body,
        )
        self.toasts.append(toast)
        return toast

    def notification_policy_stamp(self, session_id):
        """No store attached, so no policy. Output: None."""
        return None


@pytest.fixture()
def no_real_pulls(monkeypatch):
    """Replace the two jobs that read the machine with recorders.

    Description: the agent inference reads the process table and the
      title sync reads a transcript off disk. Neither belongs in a test
      about wiring, and both are asserted through the recorders instead.
    Inputs: monkeypatch.
    Output: dict with ``infer`` and ``title`` lists.
    Example: calls = no_real_pulls
    """
    calls = {"infer": [], "title": []}
    monkeypatch.setattr(
        side_effects_module.session_agent_infer_apply,
        "apply_agent_inference",
        lambda manager, session_id, tmux_name: calls["infer"].append(session_id),
    )
    monkeypatch.setattr(
        side_effects_module.claude_title_sync_apply,
        "sync_claude_title",
        lambda manager, session_id: (
            calls["title"].append(session_id)
            or types.SimpleNamespace(broadcast_title=None)
        ),
    )
    return calls


def registry(status: str, *, at: datetime = None):
    """A real registry record through the real parser. Output: RegistryRecord.

    Description: dated against the caller's clock by default. A fixed
      constant would age past ``REGISTRY_STALE_AFTER_SECONDS`` and the
      resolver would refuse it, which reads in a failure as "the wiring
      is broken" rather than as "this fixture is stale".
    """
    at = at if at is not None else datetime.now(timezone.utc)
    return parse_registry_record(
        {
            "pid": 4242,
            "status": status,
            "statusUpdatedAt": int(at.timestamp() * 1000),
            "sessionId": "11111111-2222-3333-4444-555555555555",
            "cwd": "/tmp",
            "tmux": "cloude_a:@0.%0",
            "version": "2.1.266",
        },
        path_pid=4242,
    )


def busy_pair(*, at: datetime = None):
    """Evidence a real claude writes while it is working. Output: tuple.

    Description: dated against the CALLER'S clock by default, because the
      watcher these bundles are fed to reads the real one and a fixed
      constant would age into a stale record the resolver refuses.
    """
    at = at if at is not None else datetime.now(timezone.utc)
    return (
        registry("busy", at=at - timedelta(seconds=5)),
        TranscriptFacts(
            verdict=FACTS_FOUND,
            newest_append_at=at - timedelta(seconds=1),
            newest_assistant_at=at - timedelta(seconds=1),
        ),
    )


def done_pair(*, at: datetime = None, prompt_at: datetime = None):
    """Evidence of a finished turn with nothing pending. Output: tuple.

    Description: every one of rung 8's seven gates cleared, which is the
      ONLY path to ``done_idle``. Assembled out of real dataclasses so a
      rule change in the resolver breaks this file instead of quietly
      turning its toast assertions into assertions about nothing.

      Dated against the caller's clock by default, for the reason
      :func:`busy_pair` gives.
    """
    at = at if at is not None else datetime.now(timezone.utc)
    return (
        registry("idle", at=at - timedelta(seconds=5)),
        TranscriptFacts(
            verdict=FACTS_FOUND,
            turn_end_at=at - timedelta(seconds=30),
            newest_assistant_at=at - timedelta(seconds=40),
            newest_append_at=at - timedelta(seconds=30),
            newest_user_prompt_at=prompt_at,
            pending_background_agents=0,
            pending_field_present=True,
        ),
    )


# ---------------------------------------------------------------------
# Bar 2: one bad session does not cost the tick, or the loop
# ---------------------------------------------------------------------


def test_a_failing_evidence_read_costs_one_session_and_not_the_others(
    no_real_pulls,
):
    """The watcher is the only thing that raises, so it may not die of one row.

    One session's read raises; the other's answers. The healthy session
    must still be resolved in the SAME tick, which is what proves the
    failure was caught around the row rather than around the pass.
    """
    manager = RecordingManager(
        {"ses_bad": "cloude_bad", "ses_ok": "cloude_ok"},
        {
            "cloude_bad": OSError("the registry directory went away"),
            "cloude_ok": done_pair(),
        },
    )
    watcher = build_attention_watcher(manager, tick_seconds=0.0)

    async def drive():
        """Baseline, then the edge into busy. Output: int - edges acted on."""
        await watcher.tick_once()
        manager._reads["cloude_ok"] = busy_pair()
        return await watcher.tick_once()

    acted = asyncio.run(drive())

    assert acted == 1, "the healthy session's edge must still have been acted on"
    assert {write[0] for write in manager.state_writes} == {"cloude_ok"}
    assert manager.work_stamps == [("ses_ok", "cloude_ok", None)]


def test_a_failing_read_does_not_stop_the_loop_ticking():
    """A tick that throws is logged and the next tick runs.

    Description: the loop is driven for real here rather than one pass at
      a time, because "does not die" is a statement about the ``while``
      and cannot be made about a single ``tick_once``. The target lister
      itself is what throws, which is the widest failure a tick has.
    """

    async def drive():
        manager = RecordingManager({"ses_a": "cloude_a"}, {"cloude_a": busy_pair()})
        watcher = build_attention_watcher(manager, tick_seconds=0.0)
        ticks = {"n": 0}
        original = watcher.tick_once

        async def counting_tick():
            ticks["n"] += 1
            if ticks["n"] == 1:
                raise RuntimeError("the first pass blew up")
            return await original()

        watcher.tick_once = counting_tick
        task = asyncio.create_task(watcher.run())
        for _ in range(200):
            await asyncio.sleep(0.01)
            if ticks["n"] >= 3:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return ticks["n"], manager.state_writes

    ticks, state_writes = asyncio.run(drive())

    assert ticks >= 3, "the loop stopped after the tick that raised"
    assert state_writes, "no session was resolved after the failed tick"


# ---------------------------------------------------------------------
# Bar 1, second half: the task that exists also TICKS
# ---------------------------------------------------------------------


def test_the_running_task_keeps_listing_its_targets():
    """A created task is not a ticking one, so this counts the passes.

    Description: the loop is left to run on its own cadence rather than
      being pumped by the test. Only a watcher whose ``run`` genuinely
      alternates a pass with a bounded wait reaches three passes here.
    """

    async def drive():
        manager = RecordingManager({"ses_a": "cloude_a"}, {"cloude_a": busy_pair()})
        watcher = build_attention_watcher(manager, tick_seconds=0.0)
        task = asyncio.create_task(watcher.run())
        for _ in range(200):
            await asyncio.sleep(0.01)
            if manager.status_map_builds >= 3:
                break
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return manager.status_map_builds, task

    builds, task = asyncio.run(drive())

    assert builds >= 3, "the watcher task did not tick repeatedly"
    assert task.cancelled()


def test_one_bulk_tmux_listing_is_taken_per_pass_not_per_session():
    """Fourteen sessions cost one ``list-panes``, which is the memo's whole job.

    A per-session probe would be a subprocess per session per tick, and
    it would additionally let two rows in one pass disagree about the
    same instant.
    """
    names = {"ses_%d" % i: "cloude_%d" % i for i in range(14)}
    manager = RecordingManager(
        names, {name: busy_pair() for name in names.values()}
    )
    watcher = build_attention_watcher(manager, tick_seconds=0.0)

    asyncio.run(watcher.tick_once())

    assert manager.status_map_builds == 1
    assert len(manager.state_writes) == 14, "every session must still be read"


# ---------------------------------------------------------------------
# Bar 3: the seven jobs fire from the PRODUCTION build
# ---------------------------------------------------------------------


def test_the_production_build_fires_every_job_the_hook_route_carried(
    no_real_pulls,
):
    """All seven, driven end to end with nothing injected past the manager.

    ``sessions.last_work_at`` gets its own assertion below as well,
    because it is a SORT KEY: a regression there silently reorders the
    user's whole session list and nothing else goes wrong, so nobody
    reports it as a bug.
    """

    async def drive():
        """Baseline, then work, then a finished turn. Output: the manager.

        Description: THREE PASSES, because an edge needs a state to move
          FROM: the ledger records first sight as a baseline on purpose,
          so a session that has been sitting finished since last night is
          not announced when the server comes back up.
        """
        manager = RecordingManager(
            {"ses_a": "cloude_a"}, {"cloude_a": done_pair()}
        )
        watcher = build_attention_watcher(manager, tick_seconds=0.0)
        await watcher.tick_once()
        # The session starts working: the edge into busy.
        manager._reads["cloude_a"] = busy_pair()
        await watcher.tick_once()
        # And finishes: the edge into done_idle.
        manager._reads["cloude_a"] = done_pair()
        await watcher.tick_once()
        return manager

    manager = asyncio.run(drive())

    # 1. the startup gate reached rung 1 off a registry record
    assert manager._startup_gate_ledger.first_hook_at("cloude_a") is not None
    # 2. the agent inference was triggered
    assert no_real_pulls["infer"] == ["ses_a"] * 3
    # 3. the auto unread flag was set on the finished turn
    assert manager.unread_writes == [("cloude_a", "auto", True, EPOCH)]
    # 4. the durable status was written, once per reading
    assert [write[0] for write in manager.state_writes] == ["cloude_a"] * 3
    # 5. the sort key moved, ONCE, on the edge into busy
    assert manager.work_stamps == [("ses_a", "cloude_a", None)]
    # 6. the toasts waiting on the human were acknowledged
    assert [ack[0] for ack in manager.acks] == ["ses_a"]
    # 7. the title pull ran on the transcript that grew
    assert no_real_pulls["title"], "the /rename pull never ran"
    # and the notification itself
    assert [toast.kind for toast in manager.toasts] == [EVENT_STOP]


def test_the_sort_key_is_not_written_when_nothing_says_the_session_worked(
    no_real_pulls,
):
    """The red twin for the work stamp (gotcha 11).

    A build that stamped ``last_work_at`` on every reading would pass the
    test above and be wrong: the column would stop meaning "when this
    session last did something" and every session would sort by the
    clock. Nothing here is working and nobody typed, so nothing moves.
    """

    async def drive():
        manager = RecordingManager(
            {"ses_a": "cloude_a"}, {"cloude_a": done_pair()}
        )
        watcher = build_attention_watcher(manager, tick_seconds=0.0)
        await watcher.tick_once()
        await watcher.tick_once()
        return manager

    manager = asyncio.run(drive())

    assert manager.work_stamps == []
    assert manager.state_writes, "the reading itself must still have happened"


# ---------------------------------------------------------------------
# Bar 4: one transition, one toast, with the listing running alongside
# ---------------------------------------------------------------------


def test_one_transition_raises_one_toast_while_the_listing_resolves_it_too(
    no_real_pulls,
):
    """The listing paints and the watcher raises, and only one of them raises.

    Description: the five second listing pass calls the SAME pure
      resolver on the SAME evidence, repeatedly, for as long as the
      session sits finished. It holds no ledger, so it cannot produce an
      edge; the watcher holds the only one, so a session that stays
      finished across many passes is announced exactly once. This drives
      both halves against one bundle, interleaved, which is the only way
      to state that as a property rather than as a reading of the code.
    """

    async def drive():
        at = datetime.now(timezone.utc)
        registry_record, transcript = done_pair(at=at)
        manager = RecordingManager(
            {"ses_a": "cloude_a"}, {"cloude_a": done_pair()}
        )
        watcher = build_attention_watcher(manager, tick_seconds=0.0)
        # A baseline, then the session works, so the finish below is a
        # real edge and not a first sight.
        await watcher.tick_once()
        manager._reads["cloude_a"] = busy_pair()
        await watcher.tick_once()

        painted = []
        manager._reads["cloude_a"] = (registry_record, transcript)
        for _ in range(4):
            # The listing pass, resolving the same session for display.
            painted.append(
                listing_attention.resolve_row_status(
                    registry=registry_record,
                    transcript=transcript,
                    tmux_liveness=LIVENESS_LIVE,
                    agent_family=None,
                    pane=None,
                    # The flag the watcher's own ``set_unread`` just set,
                    # so the two halves are asked about the same session
                    # in the same condition.
                    unread=True,
                    tmux_status=STATUS_UNKNOWN,
                    now=at,
                )
            )
            await watcher.tick_once()
        return manager, painted

    manager, painted = asyncio.run(drive())

    assert len(manager.toasts) == 1, (
        "a session that stays finished must be announced once, not once per pass"
    )
    assert manager.toasts[0].kind == EVENT_STOP
    # AND THE LISTING AGREED THE WHOLE TIME. A "one toast" that was
    # bought by the listing painting something else would be the defect
    # this design exists to prevent, so the paint is asserted too.
    assert {status for status, _source in painted} == {"finished_unread"}
    assert {source for _status, source in painted} == {"registry"}


# ---------------------------------------------------------------------
# The mute gate is wired, and it is wired the right way round
# ---------------------------------------------------------------------


async def _finish_a_session(manager):
    """Drive one session from a baseline through to a finished turn.

    Description: the shortest sequence that produces a ``done_idle``
      edge, which is the one the mute gate is asked about.
    Inputs: manager (RecordingManager).
    Output: None.
    Example: await _finish_a_session(mgr)
    """
    watcher = build_attention_watcher(manager, tick_seconds=0.0)
    await watcher.tick_once()
    manager._reads["cloude_a"] = busy_pair()
    await watcher.tick_once()
    manager._reads["cloude_a"] = done_pair()
    await watcher.tick_once()


def _muteable_manager(*, suppresses: bool):
    """A manager with a policy store attached and one fixed verdict.

    Inputs: suppresses (bool) - what the policy says about this session.
    Output: RecordingManager.
    Example: _muteable_manager(suppresses=True)
    """
    manager = RecordingManager({"ses_a": "cloude_a"}, {"cloude_a": done_pair()})
    manager._notification_policy_store = object()
    manager.notification_policy_stamp = lambda session_id: types.SimpleNamespace(
        suppresses=suppresses, verdict="muted" if suppresses else "unmuted",
        generation=1,
    )
    return manager


def test_a_muted_session_gets_no_toast_but_still_gets_its_unread_flag(
    no_real_pulls,
):
    """The mute silences the INTERRUPTION and never the record.

    Suppressing is not acknowledging: a muted session that finishes is
    still finished, and its light must still say so on the next poll.
    """
    manager = _muteable_manager(suppresses=True)

    asyncio.run(_finish_a_session(manager))

    assert manager.toasts == []
    assert manager.unread_writes == [("cloude_a", "auto", True, EPOCH)]


def test_an_unmuted_session_with_a_policy_store_attached_still_gets_its_toast(
    no_real_pulls,
):
    """The red twin for the gate, and the reason it exists (gotcha 11).

    A composition that never passed the policy reader would pass the
    muted test's sibling assertions and silently ignore the user's mute;
    one that passed a reader reporting "no store attached" would mute
    every session on the machine permanently. Only a build that wires the
    reader AND reports attachment truthfully passes both of these.
    """
    manager = _muteable_manager(suppresses=False)

    asyncio.run(_finish_a_session(manager))

    assert [toast.kind for toast in manager.toasts] == [EVENT_STOP]
