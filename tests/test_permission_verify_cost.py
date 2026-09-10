"""What the permission verification costs a listing pass, per session.

WHY THIS FILE EXISTS, AND WHAT IT MEASURED FIRST. The startup gate's tail
capture was documented as free in steady state and was not: its "no hook
on record" refusal reads a ledger that is IN-MEMORY per server process, so
a session whose last hook predates this process never acquires a record
and the refusal PASSES. Measured on the owner's box 2026-09-09, 13 of 13
healthy sessions took a ``capture-pane`` on every 5s poll forever. This
file exists because ``verify_open_permission`` adds a THIRD potential
per-row capture to the same synchronous listing pass, and the same
question had to be asked of it rather than assumed either way.

THE ANSWER IS THAT ITS GATE IS FAIL-CLOSED, WHICH IS THE OPPOSITE
DIRECTION. Every refusal in ``should_capture_permission_tail`` needs a
POSITIVE fact to be passed: a pane measured alive, an open claim, and a
stamp saying when the claim was raised. A session with nothing on record
has no claim, no stamp, and is refused. So on a box with no permission
dialog open the cost is genuinely zero, and the first test here is that
measurement rather than a restatement of the docstring.

WHAT WAS REAL IS THE RE-LOOK. Both verdicts that KEEP the flag - the
dialog is on screen, or the tail could not be read - leave the gate
passing on the next poll, so a session whose claim is genuinely open paid
one ``capture-pane`` every 5s until a human answered it. That is bounded
now, and the bound is on the RE-look only.

THE LOAD-BEARING TEST IS NOT THE COUNT. A throttle that also delayed the
FIRST look at a claim would be cheaper still and would break the feature:
the stuck-flag incident this module exists for (a synthetic hook landing
on a row id while the pane's own claude holds an adopted id, so no
reachable event can ever clear the flag) is caught by the first look and
by nothing else. So the claim-keyed behaviour has its own test, and a NEW
claim on a session that was just checked must be read immediately.
"""

from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta
from typing import List, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_pvc_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_pvc_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

# ruff: noqa: E402
from src.core.session_permission_verify import (
    PERMISSION_NOT_CHECKED,
    PERMISSION_TAIL_GRACE_SECONDS,
    PERMISSION_TAIL_RECHECK_SECONDS,
)
from src.core.session_permission_verify_apply import verify_open_permission

#: How many sessions the healthy-box measurement is taken over. The claim
#: is about GROWTH, so the number only has to be big enough that a
#: per-session capture would be unmistakable.
HEALTHY_SESSIONS = 6

#: A real dialog's marker text, copied from the two live captures recorded
#: in ``session_permission_verify``'s module docstring. Used so the
#: "dialog still on screen" branch is exercised with something the real
#: matcher accepts rather than with a string invented here.
DIALOG_TAIL = (
    "  Bash command\n"
    "\n"
    "    date +%s\n"
    "\n"
    "  Do you want to proceed?\n"
    "  > 1. Yes\n"
    "    2. No\n"
    "\n"
    "  Esc to cancel . Tab to amend\n"
)


class _FakeTracker:
    """The two things the seam asks a SessionActivityTracker for.

    Description: holds an open-permission stamp per session and records
        whether ``clear_permission`` was called. A real tracker would
        work here too; this keeps the test about the COST GATE rather
        than about hook ordering, and it cannot accidentally satisfy the
        gate, because every value it returns is set explicitly by the
        test.
    Inputs: opened (dict[str, datetime | None]).
    Output: instances expose ``cleared`` (list[str]).
    Example: _FakeTracker({'s1': stamp})
    """

    def __init__(self, opened: Optional[dict] = None) -> None:
        self.opened = dict(opened or {})
        self.cleared: List[str] = []

    def permission_open_since(self, session_id: str) -> Optional[datetime]:
        """The claim's raise time, or None. Output: datetime | None."""
        return self.opened.get(session_id)

    def clear_permission(self, session_id: str) -> bool:
        """Retire the claim. Output: bool - True iff one was open."""
        if self.opened.pop(session_id, None) is None:
            return False
        self.cleared.append(session_id)
        return True


class _FakeManager:
    """A manager carrying only an activity tracker.

    Inputs: tracker (_FakeTracker).
    Output: instances expose ``_activity_tracker``.
    Example: _FakeManager(_FakeTracker())
    """

    def __init__(self, tracker: _FakeTracker) -> None:
        self._activity_tracker = tracker


class _FakeBackend:
    """A backend carrying only the socket name the capture needs.

    Inputs: socket_name (str).
    Output: instances expose ``socket_name``.
    Example: _FakeBackend('cloude_pytest_x')
    """

    def __init__(self, socket_name: str = "cloude_pytest_permcost") -> None:
        self.socket_name = socket_name


class _CaptureCounter:
    """Count the ``capture-pane`` subprocesses this seam would spawn.

    Description: replaces ``capture_pane_tail``, which is the one place
        the seam reads a pane, and returns a canned tail. Replacing
        rather than wrapping is right here: the point is the COUNT and
        the branch taken, and spawning a real tmux would make the test
        depend on a pane it does not own.
    Inputs: tail (str | None) - what each read returns.
    Output: instances expose ``count`` (int).
    Example: _CaptureCounter(DIALOG_TAIL).count
    """

    def __init__(self, tail: Optional[str]) -> None:
        self.tail = tail
        self.count = 0

    def install(self, monkeypatch) -> None:
        """Replace ``capture_pane_tail`` for one test.

        Inputs: monkeypatch (pytest fixture).
        Output: None.
        """
        from src.core import session_startup_gate_ledger as gate_ledger

        counter = self

        def counting(**kwargs):
            counter.count += 1
            return counter.tail

        monkeypatch.setattr(gate_ledger, "capture_pane_tail", counting)


def test_a_healthy_box_spends_no_subprocess_here(monkeypatch):
    """THE MEASUREMENT, not a restatement of the gate's docstring.

    No session holds an open permission claim, which is what a box with
    no dialog on any pane looks like. The seam must spawn nothing at all,
    and the count is taken over several sessions so a per-session cost
    could not hide as a constant.
    """
    counter = _CaptureCounter(DIALOG_TAIL)
    counter.install(monkeypatch)
    tracker = _FakeTracker()
    manager = _FakeManager(tracker)
    now = datetime(2026, 9, 10, 12, 0, 0)

    verdicts = [
        verify_open_permission(
            manager,
            session_id=f"ses_healthy_{i}",
            backend=_FakeBackend(),
            tmux_name=f"cloude_healthy_{i}",
            pane_alive=True,
            now=now,
        )
        for i in range(HEALTHY_SESSIONS)
    ]

    assert counter.count == 0, (
        f"the permission verification spawned {counter.count} capture-pane "
        f"calls across {HEALTHY_SESSIONS} sessions with NO open claim. "
        "Every refusal in this gate is fail-closed and must stay that "
        "way: a session with nothing on record has no claim, so a box "
        "with no dialog open must spend nothing on the listing path."
    )
    assert all(v == PERMISSION_NOT_CHECKED for v in verdicts)


def test_an_open_claim_past_the_grace_window_is_still_verified(monkeypatch):
    """THE BEHAVIOUR THE THROTTLE MAY NOT WEAKEN.

    An open claim older than the grace window is read, and a pane with no
    dialog on it clears the flag. This is the stuck-bit case the module
    exists for, and a cheaper gate that stopped doing it would pass every
    count in this file.
    """
    counter = _CaptureCounter("nothing here looks like a dialog\n")
    counter.install(monkeypatch)
    now = datetime(2026, 9, 10, 12, 0, 0)
    opened = now - timedelta(seconds=PERMISSION_TAIL_GRACE_SECONDS + 1)
    tracker = _FakeTracker({"ses_stuck": opened})
    manager = _FakeManager(tracker)

    verify_open_permission(
        manager,
        session_id="ses_stuck",
        backend=_FakeBackend(),
        tmux_name="cloude_stuck",
        pane_alive=True,
        now=now,
    )

    assert counter.count == 1, "the first look at a claim is never throttled"
    assert tracker.cleared == ["ses_stuck"], (
        "a claim whose pane shows no dialog must still be cleared - the "
        "throttle bounds the RE-look and may not weaken the verification"
    )


def test_a_claim_whose_dialog_is_still_there_is_not_re_read_every_poll(
    monkeypatch,
):
    """THE COST THAT WAS REAL, and the only thing this round changes.

    A dialog that IS on screen keeps the flag, which leaves the gate
    passing again on the next poll. Before the throttle that meant one
    subprocess every 5s for as long as the human took to answer. Three
    polls inside the recheck window must now cost exactly one read, and
    a poll past the window must cost another - a throttle that never
    expired would be a verification that stopped happening.
    """
    counter = _CaptureCounter(DIALOG_TAIL)
    counter.install(monkeypatch)
    start = datetime(2026, 9, 10, 12, 0, 0)
    opened = start - timedelta(seconds=PERMISSION_TAIL_GRACE_SECONDS + 1)
    tracker = _FakeTracker({"ses_open": opened})
    manager = _FakeManager(tracker)

    def poll(at: datetime) -> None:
        verify_open_permission(
            manager,
            session_id="ses_open",
            backend=_FakeBackend(),
            tmux_name="cloude_open",
            pane_alive=True,
            now=at,
        )

    poll(start)
    assert counter.count == 1
    poll(start + timedelta(seconds=5))
    poll(start + timedelta(seconds=10))
    assert counter.count == 1, (
        f"three polls inside the {PERMISSION_TAIL_RECHECK_SECONDS}s "
        f"recheck window cost {counter.count} captures. Re-reading a "
        "dialog that is still on screen buys nothing: if the claim is "
        "real its own claude clears it with a hook, and if it is the "
        "stuck-bit case the FIRST look already cleared it."
    )

    poll(start + timedelta(seconds=PERMISSION_TAIL_RECHECK_SECONDS + 1))
    assert counter.count == 2, (
        "a throttle that never expires is a verification that stopped "
        "happening"
    )


def test_a_new_claim_is_read_immediately_even_right_after_a_check(monkeypatch):
    """THE LOAD-BEARING TEST: the throttle is keyed on the CLAIM.

    A session-keyed record would have inherited the previous claim's
    reading and delayed the first look at the NEW one by up to a full
    interval - silently, and in exactly the situation the verification
    exists for. The key carries the claim's own raise time, so a new
    ``PermissionRequest`` finds no record and is read at once.
    """
    counter = _CaptureCounter(DIALOG_TAIL)
    counter.install(monkeypatch)
    start = datetime(2026, 9, 10, 12, 0, 0)
    first_claim = start - timedelta(seconds=PERMISSION_TAIL_GRACE_SECONDS + 1)
    tracker = _FakeTracker({"ses_churn": first_claim})
    manager = _FakeManager(tracker)

    def poll(at: datetime) -> None:
        verify_open_permission(
            manager,
            session_id="ses_churn",
            backend=_FakeBackend(),
            tmux_name="cloude_churn",
            pane_alive=True,
            now=at,
        )

    poll(start)
    assert counter.count == 1

    # A second claim is raised one second later. Its stamp is different,
    # so the record from the first claim cannot answer for it.
    later = start + timedelta(seconds=1)
    tracker.opened["ses_churn"] = later - timedelta(
        seconds=PERMISSION_TAIL_GRACE_SECONDS + 1
    )
    poll(later)

    assert counter.count == 2, (
        "a NEW permission claim was throttled by the previous claim's "
        "reading. The first look at a claim is what catches a flag no "
        "reachable event can retire, and it must never be delayed."
    )


def test_a_refused_read_does_not_start_a_throttle_window(monkeypatch):
    """A window may only be opened by a capture that actually happened.

    Here the pane is not measured alive, so the gate refuses and nothing
    is read. If the refusal recorded a check anyway, the session would be
    throttled out of its FIRST real look once the pane came back.
    """
    counter = _CaptureCounter(DIALOG_TAIL)
    counter.install(monkeypatch)
    start = datetime(2026, 9, 10, 12, 0, 0)
    opened = start - timedelta(seconds=PERMISSION_TAIL_GRACE_SECONDS + 1)
    tracker = _FakeTracker({"ses_norow": opened})
    manager = _FakeManager(tracker)

    verify_open_permission(
        manager,
        session_id="ses_norow",
        backend=_FakeBackend(),
        tmux_name="cloude_norow",
        pane_alive=None,
        now=start,
    )
    assert counter.count == 0

    verify_open_permission(
        manager,
        session_id="ses_norow",
        backend=_FakeBackend(),
        tmux_name="cloude_norow",
        pane_alive=True,
        now=start + timedelta(seconds=1),
    )
    assert counter.count == 1, (
        "a refused read started a throttle window, so the claim's first "
        "real look was skipped"
    )
