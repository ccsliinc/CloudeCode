"""The status LED, asserted against hooks a real Claude Code actually fired.

WHY THIS FILE EXISTS. Every other test of this pipeline asserts against a
row somebody typed. ``tests/test_status_led.node.mjs`` proves the mapping,
``tests/test_session_activity.py`` proves the state machine and
``tests/test_hook_driven_status.py`` proves the wiring - all against
fixtures, and all of them would stay green if the real ``claude`` binary
stopped firing the events they name, or fired different ones, or fired
them at a session id the token no longer matches. This file closes that
gap the only way it can be closed: it launches a real agent, lets it POST
its own hooks over loopback at a real server, and asks
``GET /sessions/list`` and the SHIPPED ``ledStateFor`` what the user would
be looking at.

THE FINDING THAT SHAPED THE PROMPTS, and it is not obvious from the code.
``UserPromptSubmit`` does NOT set ``last_tool_event_ts`` - only
``PreToolUse`` / ``PostToolUse`` / ``SubagentStart`` / ``SubagentStop``
do. So a turn that calls no tool never paints ``working`` at all; it goes
straight from ``idle`` to ``Stop``. The working assertion therefore needs
a prompt that makes the agent USE something, and it needs the turn to
outlive a poll interval, which is why it reads several seeded files
instead of answering a question.

RUNNING IT. Opt in explicitly - it spends real Claude turns and about a
minute of wall clock::

    CLOUDE_REAL_HOOK_TESTS=1 venv/bin/python3 -m pytest \\
        tests/test_led_real_hooks.py -v -s

Without that variable, and without tmux / claude / node, every test here
skips with a reason NAMING what went unmeasured. A skip that just says
"skipped" is the silent pass this suite exists to prevent.

ORDER IS LOAD-BEARING. These run in file order against ONE live session,
because a fresh agent per assertion would multiply the cost by eight. An
early failure will cascade, and that is the right shape: the later states
genuinely were not reached.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterator, Optional

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_rht_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_rht_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from tests.real_hook_app import KEY_DOWN, KEY_ENTER, RealHookApp
from tests.real_hook_assertions import TIMELINE, await_state, record
from tests.real_hook_harness import led_state_for, poll_until, skip_reason

#: The prompt whose turn must outlive a poll interval. Several small
#: reads, each one a PreToolUse/PostToolUse pair, so the heartbeat that
#: paints ``working`` is refreshed rather than raced.
WORKING_PROMPT = (
    "read note-1.txt, note-2.txt, note-3.txt, note-4.txt and note-5.txt "
    "one at a time, and after each one tell me the single word it holds"
)

#: The prompt that must raise a REAL permission prompt. Bash is the one
#: tool this run's settings file puts behind an ``ask`` rule.
PERMISSION_PROMPT = "run the shell command: date +%s"

@pytest.fixture(scope="module")
def live() -> Iterator[RealHookApp]:
    """One real server, one real session, for the whole file.

    Description: skips with a NAMED reason before anything is started,
      seeds the files the working prompt reads, creates the session
      through the app's own create path, and tears the pane and the
      server down in ``finally`` whatever happened.
    Output: yields the live :class:`RealHookApp`.
    """
    reason = skip_reason()
    if reason:
        pytest.skip(reason)

    app = RealHookApp()
    with app:
        for index in range(1, 6):
            (app.work_dir / f"note-{index}.txt").write_text(f"word{index}\n")
        app.create_session()
        try:
            yield app
        finally:
            if TIMELINE:
                print("\n--- measured timeline ---")
                for line in TIMELINE:
                    print(line)
                print(f"hooks: {app.ledger.describe()}")


# =========================================================================== #
# 1. the gate, before any hook has ever fired                                  #
# =========================================================================== #


def test_a_pane_on_the_trust_dialog_is_awaiting_a_keypress(live: RealHookApp) -> None:
    """Punchlist 19, against live data rather than a fixture.

    The pane is alive, has a real pid, and every other field reads
    healthy. The ONLY signal that it is stuck is the ABSENCE of a hook,
    and the gate has to wait out ``STARTUP_HOOK_GRACE_SECONDS`` before it
    is allowed to say so - hence the longer timeout.
    """
    assert live.ledger.events(live.session_id) == [], (
        "a hook arrived before the trust dialog was answered, which would "
        "make the rest of this file measure the wrong thing: "
        f"{live.ledger.describe()}"
    )
    await_state(
        live,
        "trust dialog",
        want_status=("idle", "unknown", "running", "working"),
        want_inner=("waiting-input",),
        # 2026-09-09: STEADY, not breathing. A pane parked on its trust
        # dialog is a live turn that is not moving, and the ring means
        # activity - see docs/session-status.md.
        want_outer=("steady",),
        want_gate=("awaiting_startup_prompt",),
        timeout=50.0,
    )


# =========================================================================== #
# 2. answering it - a real SessionStart                                        #
# =========================================================================== #


def test_answering_the_dialog_fires_session_start_and_opens_the_gate(
    live: RealHookApp,
) -> None:
    """The first REAL hook of the run flips the gate to ``ready``."""
    assert "trust this folder" in live.pane_tail(30), (
        "the pane is not on the trust dialog, so the keypress below would "
        f"be typed into something else. pane tail:\n{live.pane_tail(20)}"
    )
    live.send_keys(KEY_DOWN, KEY_ENTER, settle=0.6)

    matched, _ = poll_until(
        lambda: live.ledger.events(live.session_id),
        lambda seen: "SessionStart" in seen,
        timeout=45.0,
    )
    assert matched, (
        "no SessionStart hook ever reached the server after the dialog was "
        f"answered. hooks: {live.ledger.describe()}\n"
        f"pane tail:\n{live.pane_tail(15)}"
    )
    await_state(
        live,
        "SessionStart",
        want_status=("idle", "unknown"),
        # 2026-09-09: `idle` (read, at rest) got its own inner state and
        # dropped the `done` green fill it used to share with
        # `finished_unread` - see docs/session-status.md.
        want_inner=("idle", "unknown"),
        want_outer=("off", "dim"),
        want_gate=("ready",),
    )


# =========================================================================== #
# 3. a real turn, with real tool calls                                         #
# =========================================================================== #


def test_a_real_turn_with_tool_calls_paints_working(live: RealHookApp) -> None:
    """``PreToolUse`` is what makes the light say the agent is busy."""
    live.type_prompt(WORKING_PROMPT)
    await_state(
        live,
        "UserPromptSubmit+tools",
        want_status=("working", "working_subagent"),
        want_inner=("working",),
        # `active` ONLY, and it no longer varies with the unread flag: a
        # working session is working. The unread ring is the green
        # finished-turn one, and a ring saying a turn ENDED around a
        # session that is mid-turn is two contradictory claims.
        want_outer=("active",),
        timeout=60.0,
    )


# =========================================================================== #
# 4. the turn ending with nobody watching                                      #
# =========================================================================== #


def test_a_real_stop_with_nobody_viewing_paints_finished_unread(
    live: RealHookApp,
) -> None:
    """``Stop`` sets the auto-unread flag, and the DOT has to show it."""
    await_state(
        live,
        "Stop (unviewed)",
        want_status=("finished_unread",),
        # 2026-09-09: the green dot is the whole signal. It used to
        # breathe an amber ring, which read as background work on the one
        # state that means the opposite.
        want_inner=("done",),
        want_outer=("off",),
        timeout=180.0,
    )
    assert "Stop" in live.ledger.events(live.session_id), (
        f"finished_unread was reached without a Stop hook: "
        f"{live.ledger.describe()}"
    )


# =========================================================================== #
# 5. what claude actually sends after a turn ends                              #
# =========================================================================== #


def test_a_trailing_subagent_stop_does_not_re_arm_the_heartbeat(
    live: RealHookApp,
) -> None:
    """PUNCHLIST ITEM 4, ASSERTED AGAINST THE EVENT THAT CAUSED IT.

    This test was written as a CHARACTERISATION of a defect and said so:
    it pinned ``working`` here and instructed that it be INVERTED, not
    loosened, once the state machine stopped stamping a ``SubagentStop``
    at ``subagent_depth == 0``. That fix has landed, so this is the
    inversion, and the ``done``/``unread`` assertion that always belonged
    here is restored.

    THE INPUT IS UNCHANGED AND IT IS REAL. Measured on claude 2.1.265,
    twice independently and on a turn with no subagent anywhere in it:
    ``SubagentStop`` arrives 1.50s AFTER ``Stop`` (Stop+38.96s,
    SubagentStop+40.46s in one run; Stop+11.61s, SubagentStop+13.24s in an
    isolated probe of a one-word answer). The trailing SubagentStop is not
    an edge case, it is what every finished turn looks like on this
    binary. What changed is only what the state machine does with it:
    there is no unmatched ``SubagentStart``, so it closes nothing, stamps
    no heartbeat and moves no state.

    THE HOLD IS THE POINT. The old defect re-armed
    ``WORKING_HEARTBEAT_TIMEOUT_SECONDS`` of ``working``, so a single
    reading taken in the 1.5s gap would have passed against the broken
    code too. This one waits for the stray to LAND and then re-reads
    after it, which is the only ordering that can tell the fix from the
    gap.
    """
    seen = live.ledger.events(live.session_id)
    assert "Stop" in seen, f"no Stop was ever recorded: {live.ledger.describe()}"
    matched, _ = poll_until(
        lambda: live.ledger.events(live.session_id),
        lambda events: "SubagentStop" in events,
        timeout=30.0,
    )
    assert matched, (
        "claude did not send a trailing SubagentStop this run. That is a "
        "CHANGE IN BEHAVIOUR, not a flake - re-measure, and if it has "
        "genuinely stopped, say so here rather than deleting the "
        f"assertion. hooks: {live.ledger.describe()}"
    )
    seen = live.ledger.events(live.session_id)
    assert seen.index("SubagentStop") > seen.index("Stop"), (
        "the SubagentStop preceded the Stop this run, so this run cannot "
        f"have measured the trailing case: {live.ledger.describe()}"
    )
    observed = live.signals()
    led = led_state_for(observed)
    record("trailing SubagentStop", observed, led)
    assert observed.get("activity_status") == "finished_unread", (
        "a SubagentStop with no matching SubagentStart re-armed the "
        "working heartbeat on a finished turn - punchlist item 4 is back.\n"
        f"  signals:    {observed}\n"
        f"  led:        {led}\n"
        f"  hooks seen: {live.ledger.describe()}"
    )
    assert led["inner"] == "done" and led["outer"] == "off", (
        f"the light disagrees with the status it was given: {led} from "
        f"{observed}"
    )


# =========================================================================== #
# 6. binding a terminal - the app's own mark-viewed seam                       #
# =========================================================================== #


def test_binding_a_terminal_clears_the_unread_light(live: RealHookApp) -> None:
    """A WS terminal binding is the ONLY thing that clears auto-unread.

    The assertion is about BOTH RINGS, which is what the owner's
    2026-09-09 ruling makes observable: unread is the green ``unread``
    ring around a ``done`` centre, read is the grey ``idle`` dot under a
    ``steady`` ring. Both change, so a half-applied clear cannot pass. It
    also
    asserts the status itself lands on ``idle``, because that is the state
    punchlist item 4 made UNREACHABLE: with the trailing ``SubagentStop``
    re-arming the heartbeat, clearing the flag revealed ``working``
    underneath for the rest of the 120s window rather than a session at
    rest. Reaching ``idle`` here is the live proof of the fix the previous
    test asserts against the event.
    """
    before = live.signals()
    assert before.get("unread") is True, (
        "the session was not unread before a terminal was bound, so this "
        f"test cannot have measured the clearing: {before}"
    )
    live.view()

    def cleared(observed: dict[str, Any]) -> bool:
        return (
            observed.get("unread") is False
            and led_state_for(observed)["inner"] != "done"
        )

    matched, observed = poll_until(live.signals, cleared, timeout=30.0)
    led = led_state_for(observed or {})
    record("terminal bound", observed or {}, led)
    assert matched, (
        "binding a WS terminal did not clear the unread light.\n"
        f"  last signals: {observed}\n"
        f"  hooks seen:   {live.ledger.describe()}"
    )
    assert (observed or {}).get("activity_status") == "idle", (
        "the flag cleared but the dot did not reach idle, which is what "
        "punchlist item 4 made unreachable.\n"
        f"  last signals: {observed}\n"
        f"  last led:     {led}\n"
        f"  hooks seen:   {live.ledger.describe()}"
    )
    assert led["inner"] == "idle" and led["outer"] == "steady", (
        # 2026-09-09: `idle` is its own grey inner state and the ring goes
        # from green to that same grey, still and lit. See
        # docs/session-status.md and client/js/status-led.js.
        f"the light disagrees with the status it was given: {led} from "
        f"{observed}"
    )


# =========================================================================== #
# 6. a real permission prompt                                                  #
# =========================================================================== #


def test_a_real_permission_request_paints_the_waiting_state(
    live: RealHookApp,
) -> None:
    """A genuine ``PermissionRequest``, not a hand-POSTed one.

    Both spellings are accepted on purpose. The server's single
    ``question`` state is being split into ``question`` (a
    PermissionRequest - the agent is stopped) and ``notice`` (a plain
    Notification) in a change landing beside this one, and this test must
    measure the light either side of that seam rather than pin the
    version it happened to be written against.
    """
    live.type_prompt(PERMISSION_PROMPT)
    matched, _ = poll_until(
        lambda: live.ledger.events(live.session_id),
        lambda seen: "PermissionRequest" in seen or "Notification" in seen,
        timeout=90.0,
    )
    assert matched, (
        "no PermissionRequest and no Notification ever arrived, so the "
        "waiting state was never exercised. hooks: "
        f"{live.ledger.describe()}\npane tail:\n{live.pane_tail(15)}"
    )
    await_state(
        live,
        "PermissionRequest",
        want_status=("question", "notice"),
        # THREE inner states, because either hook may be the one that
        # arrives. `question` is yellow (the agent is stopped), `notice`
        # is light blue (it is not), and a startup prompt landing here
        # would be `waiting-input`. See client/js/status-led.js.
        want_inner=("waiting-permission", "waiting-input", "notice"),
        # The turn is still OPEN, so the ring breathes. Only a resting
        # session stops moving.
        want_outer=("active",),
    )


# =========================================================================== #
# 7. the negative control                                                      #
# =========================================================================== #


def test_a_bogus_token_is_refused_and_moves_nothing(live: RealHookApp) -> None:
    """The control, and it asserts TWO things for a reason.

    A route that rejected the RESPONSE while having already mutated the
    state would satisfy an assertion about the 403 alone, and that is
    exactly the shape of defect a negative control exists to catch. So
    the signals are compared byte-for-byte either side of the refusal.
    """
    import httpx

    before = live.signals()
    real_token = live.app.state.session_manager._hook_tokens.get(live.session_id)
    assert real_token, "no hook token was minted, so nothing was controlled for"
    bogus = ("0" * len(real_token))[: len(real_token)]
    assert bogus != real_token

    resp = httpx.post(
        f"http://127.0.0.1:{live.port}/api/v1/hooks/claude-event",
        headers={
            "X-Cloudecode-Session": live.session_id,
            "X-Cloudecode-Token": bogus,
            "X-Cloudecode-Event": "Stop",
            "Content-Type": "application/json",
        },
        json={"hook_event_name": "Stop"},
        timeout=15.0,
    )
    assert resp.status_code == 403, (
        f"a bogus token was not refused: {resp.status_code} {resp.text[:200]}"
    )
    after = live.signals()
    assert after == before, (
        "a refused hook moved the session's state, so the 403 is cosmetic: "
        f"before={before} after={after}"
    )
    record("bogus token (403)", after, led_state_for(after))


# =========================================================================== #
# 8. the pane dying                                                            #
# =========================================================================== #


def test_a_killed_pane_leaves_the_live_list_rather_than_painting_dead(
    live: RealHookApp,
) -> None:
    """THE OWNER'S DECISION, NOT A DEFECT CHARACTERISATION. Verbatim,
    2026-09-08: "they go into recent, they can disappear."

    So a session whose process was killed DROPS OFF THE LIVE LIST. Its
    lifecycle has stopped and it belongs in Recent, where a restart is a
    resume; it does not linger in the sidebar wearing a dead light. The
    ``dead``/``off`` state in ``ledStateFor`` is real and stays, but it is
    GALLERY-ONLY - no live endpoint is meant to carry a dead row to the
    client, and this test is what holds that line.

    An earlier round read the same measurement as a bug and shipped the
    opposite rule (a husk KEPT its row, painted dead). That was overruled
    and reverted. If you are here because this assertion is in your way,
    the answer is not to loosen it: it encodes a product decision, so
    changing it needs the owner, not a patch.

    THE KNOWN GAP, AND IT IS DELIBERATELY OBSERVED RATHER THAN ASSERTED.
    ``kill_agent`` SIGKILLs the process and ``remain-on-exit`` holds the
    pane open, so the tmux SESSION is still there and still appears in the
    listing the reaper works from - and ``session_lifecycle`` reaps on
    ABSENCE from that listing. The row therefore leaves the live list
    without yet arriving in Recent. That is the second half of the owner's
    decision and it is not built; it needs a reaper rung keyed on a
    MEASURED ``#{pane_dead}``, which is a new durable writer and its own
    change. The recent-list membership is RECORDED below so a run says
    what it was, and deliberately not asserted in either direction:
    asserting absence would pin the gap open, and asserting presence would
    fail a build for work nobody has done yet.
    """
    assert live.row() is not None, (
        "the session had already left /sessions/list before it was killed, "
        "so this test measured nothing about the kill"
    )
    live.kill_agent()

    gone, last = poll_until(live.row, lambda row: row is None, timeout=30.0)
    assert gone, (
        "a pane whose process was SIGKILLed is still being listed as live "
        f"after 30s: {last}\npane tail:\n{live.pane_tail(6)}"
    )
    record("pane killed", live.signals(), led_state_for(live.signals()))

    attachable = live._httpx.get("/api/v1/sessions/attachable")
    assert attachable.status_code == 200, attachable.text
    names = {
        row.get("tmux_session") or row.get("name") for row in attachable.json()
    }
    assert live.tmux_name not in names, (
        "the dead pane reappeared on /sessions/attachable, which would make "
        "`dead` reachable after all - assert it here instead of asserting "
        f"its absence. rows: {names}"
    )

    # THE SECOND HALF OF THE DECISION, observed and printed rather than
    # asserted - see the docstring. When the reaper learns to file a
    # measured husk, this prints True and the honest change is to promote
    # it to an assertion here.
    recent = live._httpx.get("/api/v1/sessions/recent")
    in_recent: Any = "unreadable"
    if recent.status_code == 200:
        body = recent.json()
        rows = body if isinstance(body, list) else body.get("sessions", [])
        in_recent = any(
            (row.get("tmux_session") or row.get("tmux_name")) == live.tmux_name
            for row in rows
            if isinstance(row, dict)
        )
    TIMELINE.append(
        f"    killed pane in /sessions/recent: {in_recent} "
        f"(HTTP {recent.status_code})"
    )
