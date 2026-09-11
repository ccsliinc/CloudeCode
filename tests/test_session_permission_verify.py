"""The permission flag must be retirable, and only by evidence.

Two fixes are under test here and they are two halves of one rule: a
``permission_open`` flag set by a hook is a CLAIM, and a claim that no
reachable observation can retire is a stuck bit rather than a careful
answer. See ``src/core/session_permission_verify.py`` for the live
incident (2026-09-09, ``cloude_Media_Compression``) that produced both.

THE DIALOG TEXT IN THIS FILE IS REAL. Every string in ``BASH_DIALOG`` and
``WRITE_DIALOG`` was captured from a genuine ``claude`` (2.1.265 and
2.1.266) driven on a THROWAWAY tmux socket with a ``permissions.ask``
rule in its own settings file, on 2026-09-09. The negative controls are
equally real: ``IDLE_PANE`` is that same claude at rest one second later,
and ``STUCK_LIVE_PANE`` is the actual captured tail of the live session
that was painting the permission light over no dialog at all. A matcher
tested only against text its own author invented proves that the author
can spell their own regex.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from src.core.session_activity import (
    EVENT_PERMISSION_REQUEST,
    EVENT_STOP,
    EVENT_USER_PROMPT_SUBMIT,
    SessionActivityTracker,
)
from src.core.session_permission_verify import (
    PERMISSION_CLEARED_NO_DIALOG,
    PERMISSION_KEPT_DIALOG,
    PERMISSION_KEPT_UNREADABLE,
    PERMISSION_NOT_CHECKED,
    PERMISSION_TAIL_GRACE_SECONDS,
    detect_permission_dialog,
    resolve_permission_check,
    should_capture_permission_tail,
)
from src.core.session_status import STATUS_IDLE, STATUS_QUESTION
from src.core.sessions.registry import SessionRegistry
from src.core.session_view_clears import clear_view_state

# ---------------------------------------------------------------------------
# Captured pane text. Provenance is in the module docstring; do not
# "tidy" these - the leading single space on the dialog rows, the U+00B7
# in the footer and the U+276F cursor glyph are all load-bearing.
# ---------------------------------------------------------------------------

#: A full-width horizontal rule, as claude draws above every dialog.
_RULE = "\u2500" * 120
#: The dotted rule the file-diff block fences its content with.
_DOTTED = "\u254c" * 120

#: claude 2.1.265, ask rule on Bash, prompt "run the shell command: date +%s".
BASH_DIALOG = "\n".join(
    [
        "  \u23bf  $ date +%s",
        "",
        _RULE,
        " Bash command",
        "",
        "   date +%s",
        "   Print current Unix timestamp",
        "",
        " Ask rule Bash overrides auto mode for this command.",
        " /permissions to let auto mode decide",
        "",
        " Do you want to proceed?",
        " \u276f 1. Yes",
        "   2. No",
        "",
        " Esc to cancel \u00b7 Tab to amend",
    ]
)

#: claude 2.1.266, ask rule on Write with Bash denied so it could not fall
#: back. THE QUESTION LINE IS DIFFERENT, which is the whole reason this
#: second capture exists: a matcher keyed on the literal "Do you want to
#: proceed?" answers "no dialog" for every file operation.
WRITE_DIALOG = "\n".join(
    [
        "\u276f use the Write tool to create note2.txt containing the word hello",
        "",
        "\u23fa Write(note2.txt)",
        "",
        _RULE,
        " Create file",
        " note2.txt",
        _DOTTED,
        "  1 hello",
        _DOTTED,
        " Do you want to create note2.txt?",
        " \u276f 1. Yes",
        "   2. No",
        "",
        " Esc to cancel \u00b7 Tab to amend",
    ]
)

#: NEGATIVE CONTROL 1 - the same claude at rest, nothing blocked.
IDLE_PANE = "\n".join(
    [
        _RULE,
        "\u276f",
        _RULE,
        "  jsugamele@mac-mini-m4:/private/tmp/claude-501/scratchpad\u2026",
        "  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
        "                                                              /rc",
    ]
)

#: NEGATIVE CONTROL 2 - the REAL tail of the stuck live session, captured
#: from ``cloude_Media_Compression`` while ``GET /sessions/list`` was
#: reporting ``question`` for it. If the matcher finds a dialog in this,
#: the fix does nothing at all for the case that motivated it. Note the
#: U+00A0 after the prompt glyph: that is what tmux actually returned.
STUCK_LIVE_PANE = "\n".join(
    [
        "Permission allow rule (.claude/settings.json): Write(.claude/notes/**) is not matched by file permission checks \u2014 only Edit(",
        "",
        "                                                                                    new task? /clear to save 410.1k tokens",
        "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 Media Compression \u2500",
        "\u276f\xa0thats me, i have another session running",
        "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
        "  jsugamele@mac-mini-m4:\u2302/\u2692/Assistants/Media \u2387(master) \u2726[Opus 5] \u25d0[\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591\u2591]                                         /rc",
        "  \u23f5\u23f5 bypass permissions on (shift+tab to cycle) \xb7 \u2190 for agents",
    ]
)

T0 = datetime(2026, 9, 9, 17, 55, 12)


# ---------------------------------------------------------------------------
# The matcher, against real text on both sides.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tail,label",
    [(BASH_DIALOG, "bash"), (WRITE_DIALOG, "write")],
    ids=["bash-dialog", "write-dialog"],
)
def test_a_real_permission_dialog_is_detected(tail: str, label: str) -> None:
    """Both captured dialog wordings match."""
    assert detect_permission_dialog(tail) is True, label


@pytest.mark.parametrize(
    "tail,label",
    [(IDLE_PANE, "idle"), (STUCK_LIVE_PANE, "stuck-live")],
    ids=["idle-pane", "stuck-live-pane"],
)
def test_a_pane_with_no_dialog_is_not_detected(tail: str, label: str) -> None:
    """THE NEGATIVE CONTROL. A matcher that always finds something would
    pass every positive test above and never clear a single flag."""
    assert detect_permission_dialog(tail) is False, label


def test_the_question_line_alone_is_enough_for_an_unseen_wording() -> None:
    """The edit prompt was NOT captured, so it is matched by shape.

    ``Do you want to make this edit to app.py?`` is the third wording
    claude uses and this file has no capture of it. The question-line
    pattern is deliberately open after "Do you want to" so an unseen
    wording still keeps the flag rather than silently clearing it.
    """
    assert detect_permission_dialog(
        " Do you want to make this edit to app.py?"
    ) is True


def test_the_phrase_mid_sentence_does_not_match() -> None:
    """Anchoring matters: claude's own prose must not read as a dialog."""
    prose = (
        "I can refactor this next. Do you want to proceed with the "
        "migration first, or should I write the tests?"
    )
    assert detect_permission_dialog(prose) is False


def test_no_text_is_not_the_same_answer_as_no_dialog() -> None:
    """``None`` in, ``None`` out - the caller routes the two differently."""
    assert detect_permission_dialog(None) is None
    assert detect_permission_dialog("") is False


# ---------------------------------------------------------------------------
# The cost gate.
# ---------------------------------------------------------------------------


def test_a_fresh_flag_inside_the_grace_window_is_never_captured() -> None:
    """The hook fires as the dialog is being drawn; do not race it."""
    assert should_capture_permission_tail(
        pane_alive=True,
        permission_open=True,
        opened_at=T0,
        now=T0 + timedelta(seconds=PERMISSION_TAIL_GRACE_SECONDS - 1),
    ) is False


def test_a_flag_past_the_grace_window_is_captured() -> None:
    assert should_capture_permission_tail(
        pane_alive=True,
        permission_open=True,
        opened_at=T0,
        now=T0 + timedelta(seconds=PERMISSION_TAIL_GRACE_SECONDS),
    ) is True


@pytest.mark.parametrize(
    "kwargs,label",
    [
        ({"pane_alive": None}, "pane unmeasured"),
        ({"pane_alive": False}, "pane dead"),
        ({"permission_open": False}, "no open flag"),
        ({"opened_at": None}, "undatable claim"),
    ],
)
def test_the_gate_refuses_everything_it_cannot_stand_behind(
    kwargs: dict, label: str
) -> None:
    """Steady state is the EMPTY set, and an undatable claim is not a
    licence to capture on every poll forever."""
    base = dict(
        pane_alive=True,
        permission_open=True,
        opened_at=T0,
        now=T0 + timedelta(seconds=600),
    )
    base.update(kwargs)
    assert should_capture_permission_tail(**base) is False, label


# ---------------------------------------------------------------------------
# The ladder.
# ---------------------------------------------------------------------------


def test_marker_present_keeps_the_flag() -> None:
    assert (
        resolve_permission_check(captured=True, tail=BASH_DIALOG)
        == PERMISSION_KEPT_DIALOG
    )


def test_tail_read_and_no_marker_clears_the_flag() -> None:
    assert (
        resolve_permission_check(captured=True, tail=STUCK_LIVE_PANE)
        == PERMISSION_CLEARED_NO_DIALOG
    )


def test_an_unreadable_tail_keeps_the_flag() -> None:
    """REFUSES ON NO EVIDENCE. Not having managed to look is not evidence
    the dialog is gone."""
    assert (
        resolve_permission_check(captured=True, tail=None)
        == PERMISSION_KEPT_UNREADABLE
    )


def test_a_refused_capture_says_nothing_about_the_flag() -> None:
    """A capture the gate declined and one that failed both hand back
    None, and they are different facts."""
    assert (
        resolve_permission_check(captured=False, tail=None)
        == PERMISSION_NOT_CHECKED
    )


# ---------------------------------------------------------------------------
# The tracker's half: the stamp, and re-arming.
# ---------------------------------------------------------------------------


def test_the_stamp_dates_the_transition_not_the_duplicate() -> None:
    """A repeating PermissionRequest must not push the grace window out."""
    t = SessionActivityTracker()
    t.record_event("s1", EVENT_PERMISSION_REQUEST, now=T0)
    t.record_event(
        "s1", EVENT_PERMISSION_REQUEST, now=T0 + timedelta(seconds=60)
    )
    assert t.permission_open_since("s1") == T0


def test_clearing_drops_the_stamp_with_the_flag() -> None:
    t = SessionActivityTracker()
    t.record_event("s1", EVENT_PERMISSION_REQUEST, now=T0)
    assert t.clear_permission("s1") is True
    assert t.permission_open_since("s1") is None
    # Idempotent - nothing left to clear.
    assert t.clear_permission("s1") is False


def test_a_hook_clear_also_drops_the_stamp() -> None:
    """The three hook-driven clears are untouched by this change."""
    for kind in (EVENT_USER_PROMPT_SUBMIT, EVENT_STOP):
        t = SessionActivityTracker()
        t.record_event("s1", EVENT_PERMISSION_REQUEST, now=T0)
        t.record_event("s1", kind, now=T0 + timedelta(seconds=1))
        assert t.permission_open_since("s1") is None, kind


def test_a_duplicated_permission_after_a_clear_re_sets_it() -> None:
    """A NEW prompt is a new claim, and it gets its own grace window.

    This is the order-tolerance contract: clearing is not a latch, and a
    PermissionRequest arriving after a clear (a duplicate of the one that
    was cleared, or a genuinely new prompt - the hook stream cannot tell
    us which) must re-open the flag rather than be swallowed.
    """
    t = SessionActivityTracker()
    t.record_event("s1", EVENT_PERMISSION_REQUEST, now=T0)
    t.clear_permission("s1")
    later = T0 + timedelta(seconds=120)
    t.record_event("s1", EVENT_PERMISSION_REQUEST, now=later)
    assert t.permission_open_since("s1") == later
    assert t.resolve("s1", STATUS_IDLE) == STATUS_QUESTION
    # And the fresh claim is inside its own grace window again.
    assert should_capture_permission_tail(
        pane_alive=True,
        permission_open=True,
        opened_at=t.permission_open_since("s1"),
        now=later + timedelta(seconds=1),
    ) is False


def test_clear_permission_on_an_unknown_session_is_a_no_op() -> None:
    assert SessionActivityTracker().clear_permission("nope") is False
    assert SessionActivityTracker().permission_open_since("nope") is None


# ---------------------------------------------------------------------------
# FIX A: a view clears the permission.
# ---------------------------------------------------------------------------


class _FakeBackend:
    """Minimal stand-in: ``clear_view_state`` reads one attribute."""

    def __init__(self, tmux_session: str) -> None:
        self.tmux_session = tmux_session


class _FakeUnreadStore:
    """Records what it was asked to clear, so the test can assert the
    permission clear did not cost the unread clear."""

    def __init__(self) -> None:
        self.cleared: list[tuple[str, object]] = []

    def clear(self, tmux_name: str, epoch: object) -> None:
        self.cleared.append((tmux_name, epoch))


class _FakeManager:
    """The three things ``clear_view_state`` actually touches.

    Description: ``backends`` lives on the registry (v2 slice S4), so the
      double carries a REAL ``SessionRegistry`` rather than a dict of its
      own. A double that kept the dict would agree with a reader that had
      not been repointed, which is the whole failure mode being guarded.
    """

    def __init__(self, tracker: SessionActivityTracker) -> None:
        self._registry = SessionRegistry(log_cap=lambda: 1000)
        self._registry.backends["ses_1"] = _FakeBackend(
            "cloude_Media_Compression"
        )
        self._activity_tracker = tracker
        self._unread_store = _FakeUnreadStore()

    def _unread_epoch(self, tmux_name: str) -> str:
        return "epoch-1"


def test_a_view_clears_an_open_permission() -> None:
    """THE OWNER'S RULE: clicking a tab marks the session read."""
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    mgr = _FakeManager(tracker)

    assert clear_view_state(mgr, session_id="ses_1") is True
    assert tracker.permission_open_since("ses_1") is None
    assert tracker.resolve("ses_1", STATUS_IDLE) == STATUS_IDLE


def test_a_view_is_idempotent() -> None:
    """Looking twice reaches the same state as looking once."""
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    mgr = _FakeManager(tracker)

    clear_view_state(mgr, session_id="ses_1")
    first = tracker.resolve("ses_1", STATUS_IDLE)
    clear_view_state(mgr, session_id="ses_1")
    assert tracker.resolve("ses_1", STATUS_IDLE) == first
    assert len(mgr._unread_store.cleared) == 2


def test_a_view_by_tmux_name_clears_the_permission_too() -> None:
    """The manual mark-read control arrives holding the NAME, not the id,
    and must reach the same flag."""
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    mgr = _FakeManager(tracker)

    assert clear_view_state(mgr, tmux_name="cloude_Media_Compression") is True
    assert tracker.permission_open_since("ses_1") is None


def test_a_view_still_clears_the_notice_and_the_unread_flag() -> None:
    """The new clear is ADDITIVE - nothing the view did before is lost."""
    from src.core.session_activity import EVENT_NOTIFICATION

    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_NOTIFICATION, now=T0)
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    mgr = _FakeManager(tracker)

    clear_view_state(mgr, session_id="ses_1")
    assert tracker.resolve("ses_1", STATUS_IDLE) == STATUS_IDLE
    assert mgr._unread_store.cleared == [
        ("cloude_Media_Compression", "epoch-1")
    ]


# ---------------------------------------------------------------------------
# FIX B, the seam: one capture, applied.
# ---------------------------------------------------------------------------


class _CountingBackend(_FakeBackend):
    """A backend the seam can read a socket name off."""

    def __init__(self, tmux_session: str, socket_name: str = "cloude") -> None:
        super().__init__(tmux_session)
        self.socket_name = socket_name


def _seam_manager(tracker: SessionActivityTracker) -> _FakeManager:
    mgr = _FakeManager(tracker)
    mgr._registry.backends["ses_1"] = _CountingBackend(
        "cloude_Media_Compression"
    )
    return mgr


def _run_seam(monkeypatch, tracker, tail, *, now, calls: list) -> str:
    """Drive the seam with a stubbed capture, recording every call."""
    from src.core import session_permission_verify_apply as apply_mod
    from src.core import session_startup_gate_ledger as ledger

    def fake_capture(*, socket: str, name: str, lines: int):
        calls.append((socket, name, lines))
        return tail

    monkeypatch.setattr(ledger, "capture_pane_tail", fake_capture)
    return apply_mod.verify_open_permission(
        _seam_manager(tracker),
        session_id="ses_1",
        backend=_CountingBackend("cloude_Media_Compression"),
        tmux_name="cloude_Media_Compression",
        pane_alive=True,
        now=now,
    )


PAST_GRACE = T0 + timedelta(seconds=PERMISSION_TAIL_GRACE_SECONDS + 5)


def test_the_seam_does_not_capture_inside_the_grace_window(monkeypatch) -> None:
    """The expensive input is not paid for while the claim is fresh."""
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    calls: list = []
    verdict = _run_seam(
        monkeypatch, tracker, IDLE_PANE,
        now=T0 + timedelta(seconds=1), calls=calls,
    )
    assert verdict == PERMISSION_NOT_CHECKED
    assert calls == []
    assert tracker.permission_open_since("ses_1") == T0


def test_the_seam_does_not_capture_when_no_permission_is_open(
    monkeypatch,
) -> None:
    """STEADY STATE IS FREE. This is the case every healthy row takes."""
    calls: list = []
    verdict = _run_seam(
        monkeypatch, SessionActivityTracker(), IDLE_PANE,
        now=PAST_GRACE, calls=calls,
    )
    assert verdict == PERMISSION_NOT_CHECKED
    assert calls == []


def test_the_seam_clears_a_flag_with_no_dialog_on_the_pane(
    monkeypatch,
) -> None:
    """THE LIVE CASE. Real tail, real absence, flag retired."""
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    calls: list = []
    verdict = _run_seam(
        monkeypatch, tracker, STUCK_LIVE_PANE, now=PAST_GRACE, calls=calls,
    )
    assert verdict == PERMISSION_CLEARED_NO_DIALOG
    assert len(calls) == 1
    assert tracker.permission_open_since("ses_1") is None
    assert tracker.resolve("ses_1", STATUS_IDLE) == STATUS_IDLE


def test_the_seam_captures_once_per_poll_then_stops(monkeypatch) -> None:
    """One capture per poll while the flag is open, and NONE after it is
    cleared - which is also what makes the log line fire exactly once."""
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    calls: list = []
    _run_seam(monkeypatch, tracker, STUCK_LIVE_PANE, now=PAST_GRACE, calls=calls)
    _run_seam(monkeypatch, tracker, STUCK_LIVE_PANE, now=PAST_GRACE, calls=calls)
    assert len(calls) == 1


def test_the_seam_keeps_a_flag_with_a_dialog_on_the_pane(monkeypatch) -> None:
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    calls: list = []
    verdict = _run_seam(
        monkeypatch, tracker, BASH_DIALOG, now=PAST_GRACE, calls=calls,
    )
    assert verdict == PERMISSION_KEPT_DIALOG
    assert tracker.permission_open_since("ses_1") == T0
    assert tracker.resolve("ses_1", STATUS_IDLE) == STATUS_QUESTION


def test_the_seam_keeps_a_flag_it_could_not_read_the_pane_for(
    monkeypatch,
) -> None:
    """REFUSES ON NO EVIDENCE, and keeps trying on the next poll."""
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    calls: list = []
    verdict = _run_seam(
        monkeypatch, tracker, None, now=PAST_GRACE, calls=calls,
    )
    assert verdict == PERMISSION_KEPT_UNREADABLE
    assert tracker.permission_open_since("ses_1") == T0
    assert tracker.resolve("ses_1", STATUS_IDLE) == STATUS_QUESTION
    _run_seam(monkeypatch, tracker, None, now=PAST_GRACE, calls=calls)
    assert len(calls) == 2


def test_the_seam_never_invents_a_permission(monkeypatch) -> None:
    """A dialog on the pane of a session holding NO flag changes nothing.
    Only a hook may open this claim; the pane may only close it."""
    tracker = SessionActivityTracker()
    calls: list = []
    verdict = _run_seam(
        monkeypatch, tracker, BASH_DIALOG, now=PAST_GRACE, calls=calls,
    )
    assert verdict == PERMISSION_NOT_CHECKED
    assert tracker.permission_open_since("ses_1") is None
    assert tracker.resolve("ses_1", STATUS_IDLE) == STATUS_IDLE


def test_the_seam_refuses_a_dead_or_unmeasured_pane(monkeypatch) -> None:
    from src.core import session_permission_verify_apply as apply_mod
    from src.core import session_startup_gate_ledger as ledger

    calls: list = []
    monkeypatch.setattr(
        ledger, "capture_pane_tail",
        lambda **kw: calls.append(kw) or IDLE_PANE,
    )
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    for alive in (None, False):
        assert apply_mod.verify_open_permission(
            _seam_manager(tracker),
            session_id="ses_1",
            backend=_CountingBackend("cloude_Media_Compression"),
            tmux_name="cloude_Media_Compression",
            pane_alive=alive,
            now=PAST_GRACE,
        ) == PERMISSION_NOT_CHECKED
    assert calls == []
    assert tracker.permission_open_since("ses_1") == T0


def test_the_seam_never_raises_when_the_capture_blows_up(monkeypatch) -> None:
    """A listing poll must not fail because one pane could not be read."""
    from src.core import session_permission_verify_apply as apply_mod
    from src.core import session_startup_gate_ledger as ledger

    def boom(**kwargs):
        raise OSError("tmux went away")

    monkeypatch.setattr(ledger, "capture_pane_tail", boom)
    tracker = SessionActivityTracker()
    tracker.record_event("ses_1", EVENT_PERMISSION_REQUEST, now=T0)
    assert apply_mod.verify_open_permission(
        _seam_manager(tracker),
        session_id="ses_1",
        backend=_CountingBackend("cloude_Media_Compression"),
        tmux_name="cloude_Media_Compression",
        pane_alive=True,
        now=PAST_GRACE,
    ) == PERMISSION_NOT_CHECKED
    assert tracker.permission_open_since("ses_1") == T0
