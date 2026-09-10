"""Is the permission prompt this session claims to be blocked on ACTUALLY there?

``SessionActivityTracker.permission_open`` is set by one ``PermissionRequest``
hook and cleared by the next ``UserPromptSubmit`` / ``PreToolUse`` / ``Stop``.
That is a closed loop only while every one of those events reaches the SAME
tracker key, and on live 2026-09-09 one did not.

THE INCIDENT, TRACED TO THE ID. ``cloude_Media_Compression`` painted the
orange permission light with NO dialog on its pane: the tail read a settings
warning, a typed-but-unsubmitted prompt line, and ``bypass permissions on``.
The flag was set at 17:55:12.165Z on session id ``ses_949a8585``. The claude
running in that pane was measured (its own process environment) to hold
``CLOUDECODE_SESSION_ID=adopted:cloude_Media_Compression`` - a spawn-time
value tmux cannot rewrite into a running process - so the pane's own
``UserPromptSubmit`` 8s later, and both of its later ``Stop`` events, all
landed on a DIFFERENT tracker key. The hook store held tokens for both ids
against the one tmux name, so nothing was rejected and nothing looked wrong.

THE RULE THIS MODULE EXISTS FOR: A FLAG THAT NO REACHABLE EVENT CAN RETIRE IS
NOT A CLAIM, IT IS A STUCK BIT. The toast path already survives this exact
split - it remaps a stale id onto the live one before it stores or acks - and
the activity tracker does not. Rather than add a second remap and hope the two
never drift, the flag is re-verified against the thing BOTH ids share: the
pane. A dialog is a rectangle of text on screen; if it is not on screen, the
agent is not blocked, whatever any hook said.

EVERY MARKER BELOW WAS READ OFF A REAL DIALOG, twice, on a throwaway tmux
socket driving a real ``claude`` with a ``permissions.ask`` rule in its own
settings file (2026-09-09, claude 2.1.265 and 2.1.266). Two wordings were
captured because assuming one would have shipped a matcher that misses the
other:

    Bash tool, ask rule on "Bash", prompt "run the shell command: date +%s"

         Bash command

           date +%s
           Print current Unix timestamp

         Ask rule Bash overrides auto mode for this command.
         /permissions to let auto mode decide

         Do you want to proceed?
         > 1. Yes
           2. No

         Esc to cancel . Tab to amend

    Write tool, ask rule on "Write", Bash denied so it could not fall back

         Create file
         note2.txt
         ...
         Do you want to create note2.txt?
         > 1. Yes
           2. No

         Esc to cancel . Tab to amend

The question line CHANGES with the tool ("proceed?", "create note2.txt?", and
by the same pattern the edit prompt's "make this edit to X?"), so matching the
literal "Do you want to proceed?" would have answered "no dialog" for every
file operation - the exact family the owner's stuck session was warning about.
The option block and the footer are identical across both.

NOTE THE CONTRAST WITH THE TRUST DIALOG, which ``session_startup_gate.py``
matches: that one is NOT numbered on 2.1.263+ and its footer reads "Enter to
confirm . Esc to cancel". The two marker sets do not overlap, and they should
not - a session parked on the trust dialog has fired no hook at all, so it can
have no permission flag to verify. Two screens, two questions, two ladders.

DIRECTION OF ERROR, STATED OUT LOUD. A false POSITIVE here (matching text that
is not a dialog) keeps a flag that is already set, which is the status quo and
costs nothing new. A false NEGATIVE (failing to see a real dialog) clears a
flag that should have stood, and paints a blocked session as idle - the
false-green shape this project keeps removing. So the matcher is deliberately
broad, three independent markers, ANY of which keeps the flag; and a tail that
could not be READ keeps it too, because not having looked is not evidence of
absence.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Optional, Pattern, Union

#: How long an open permission claim is trusted on the hook's word alone
#: before the pane is asked to corroborate it.
#:
#: The cost of setting it too LOW is racing claude's own render: the
#: ``PermissionRequest`` hook fires as the dialog is being drawn, and a
#: capture taken in that instant could read the pane before the rectangle
#: is on it and clear a flag that was about to be true. Measured on the
#: probe runs above, the dialog was on screen within 3-5s of the prompt.
#: The cost of setting it too HIGH is 20 more seconds of a wrong light on
#: a session that is not blocked.
#:
#: 20s is the same number ``STARTUP_HOOK_GRACE_SECONDS`` uses, and for the
#: same shape of reason: several times the observed cost of the thing being
#: waited for, and well under the point a human notices the light is wrong.
PERMISSION_TAIL_GRACE_SECONDS: int = 20

#: How much scrollback to read. The dialog is about fifteen rendered lines
#: and sits at the BOTTOM of the pane, immediately above the input box, so
#: this only has to be deep enough to clear the footer. Smaller than
#: ``STARTUP_TAIL_LINES`` (200) on purpose: that one looks at a pane which
#: has produced nothing else, this one at a pane in the middle of a busy
#: conversation, where reading more is both slower and no more informative.
PERMISSION_TAIL_LINES: int = 60

#: How long one pane reading stands before the flag is re-checked, per
#: session.
#:
#: MEASURED FIRST, AND THE PREMISE DID NOT HOLD THE WAY THE SIBLING'S DID.
#: ``session_startup_gate.should_capture_tail`` claimed to be free in
#: steady state and was not, because its "no hook on record" refusal is
#: FAIL-OPEN: the ledger is in-memory, so a missing record made the gate
#: PASS and 13 of 13 healthy sessions captured on every poll forever.
#: ``should_capture_permission_tail`` is FAIL-CLOSED - a missing record
#: means no open claim, no stamp, and it REFUSES - so on a box with no
#: permission dialog open it really does spend nothing, and there was no
#: version of this file that needed a fix for that.
#:
#: WHAT IS REAL IS THE RE-LOOK. Both outcomes that KEEP the flag (the
#: dialog is on screen, or the tail could not be read) leave the gate
#: passing on the next poll, so a session whose claim is genuinely open
#: pays one ``capture-pane`` every 5s for as long as the human takes to
#: answer it. Re-reading buys nothing while the dialog is still there:
#: if it is really open, the pane's own claude clears the flag with a
#: hook the moment it is answered, and if it is the stuck-bit case this
#: module exists for, the FIRST look already cleared it.
#:
#: SO ONLY A RE-LOOK IS THROTTLED, never the first one. An instance with
#: nothing on record is read the moment it is 20s past its claim, exactly
#: as before, which is the case the feature was built for. What this
#: bounds is how long a flag that becomes clearable LATER can linger, and
#: the alternative to lingering is not "instant" - it is the indefinite
#: wrong light this module was written to end.
#:
#: 30s matches ``STARTUP_TAIL_RECHECK_SECONDS`` deliberately: the two
#: windows answer different questions but a reader holding one number for
#: "how long a pane reading stands" is better served than by two.
PERMISSION_TAIL_RECHECK_SECONDS: int = 30

#: Verdicts. Four, because "kept" has two genuinely different reasons and
#: collapsing them would make an unreadable pane indistinguishable from a
#: pane that was read and showed a dialog - the difference between evidence
#: and the absence of a look.
PERMISSION_KEPT_DIALOG: str = "kept_dialog_present"
PERMISSION_KEPT_UNREADABLE: str = "kept_tail_unreadable"
PERMISSION_CLEARED_NO_DIALOG: str = "cleared_no_dialog"
PERMISSION_NOT_CHECKED: str = "not_checked"

#: Markers whose presence means "a permission dialog is on this pane NOW".
#: ANY one of them keeps the flag. See the module docstring for the two
#: live captures these come from and why the set is the size it is.
PERMISSION_DIALOG_MARKERS: tuple[Union[str, Pattern[str]], ...] = (
    # The question line. Anchored to the start of a line and required to
    # end in a question mark so a sentence of claude's own prose that
    # happens to contain the phrase mid-paragraph does not match. The
    # tail after "to" is left open because it names the tool's action:
    # "proceed?", "create note2.txt?", "make this edit to app.py?".
    re.compile(r"^\s*Do you want to .{0,120}\?\s*$", re.M),
    # The option block, exactly as 2.1.265/266 renders it - NUMBERED, with
    # the cursor glyph on the affirmative row. Note this is the opposite
    # of the trust dialog, which numbers nothing and parks the cursor on
    # "No, exit"; that difference is why the two modules cannot share a
    # pattern.
    re.compile(r"^\s*❯\s*1\.\s*Yes\b", re.M),
    # The key-hint footer, byte-identical across both captured dialogs and
    # the literal proof that this screen is waiting on a keystroke. The
    # separator is U+00B7 with a space either side.
    "Esc to cancel · Tab to amend",
)


def detect_permission_dialog(tail: Optional[str]) -> Optional[bool]:
    """Does this scrollback tail show a permission dialog?

    Description: the matcher, split from the ladder so it can be tested on
        text alone - including against NEGATIVE CONTROLS, which for this
        family are mandatory. ``tests/test_session_permission_verify.py``
        feeds it the real steady-state footer of a busy claude AND the
        actual captured tail of the stuck live session, and requires
        ``False`` for both; a matcher that always finds something would
        pass every positive test and clear nothing, forever.
    Inputs:
        tail: captured pane text, or None when no capture was made.
    Output:
        bool | None - True when a marker matched, False when the text was
        read and no marker matched, None when there was no text to read.
        The None is load-bearing: "we did not look" and "we looked and it
        is not there" route differently in ``resolve_permission_check``.
    Example:
        >>> detect_permission_dialog("  Do you want to proceed?")
        True
        >>> detect_permission_dialog(None) is None
        True
    """
    if tail is None:
        return None
    for marker in PERMISSION_DIALOG_MARKERS:
        if isinstance(marker, str):
            if marker in tail:
                return True
        elif marker.search(tail):
            return True
    return False


def should_capture_permission_tail(
    *,
    pane_alive: Optional[bool],
    permission_open: bool,
    opened_at: Optional[datetime],
    now: datetime,
    grace_seconds: int = PERMISSION_TAIL_GRACE_SECONDS,
    last_check_at: Optional[datetime] = None,
    recheck_seconds: int = PERMISSION_TAIL_RECHECK_SECONDS,
) -> bool:
    """Is reading this pane's scrollback worth a subprocess call?

    Description: the COST GATE, and the reason this feature is free in
        steady state - the same shape as
        ``session_startup_gate.should_capture_tail``, and separate from
        the resolver for the same reason: the resolver must stay pure and
        the caller must decide whether to PAY for a tail before it has
        one.

        The gated set is normally EMPTY, and unlike its sibling in
        ``session_startup_gate`` that claim has been checked. It admits
        only a pane that is measured alive, holds an OPEN permission
        claim, and has held it for longer than the grace window. Every
        one of those refusals is FAIL-CLOSED: a session with no record at
        all has no open claim and no stamp, so it refuses. The startup
        gate's equivalent refusal is fail-OPEN (a missing in-memory hook
        record makes it PASS), which is exactly why that one was costing
        13 of 13 healthy sessions a capture per poll while this one costs
        nothing. Do not move this capture into the unconditional listing
        path.

        THE FOURTH REFUSAL IS THE RE-LOOK, and it is the only cost that
        was ever real here. Both verdicts that KEEP the flag leave this
        gate passing again next poll, so a genuinely open claim paid one
        subprocess every 5s until a human answered it. A reading younger
        than ``recheck_seconds`` now stands instead. A ``last_check_at``
        of None means nothing has been read for this claim, which reads
        as "look now" - so the FIRST look is never delayed and the
        stuck-flag case this module exists for is caught exactly as
        promptly as before.
    Inputs:
        pane_alive: True/False/None from the caller's liveness read. Only
            True qualifies - a pane that could not be read cannot be
            captured either, and a dead one has no dialog to answer.
        permission_open: the flag as the tracker holds it.
        opened_at: when the flag went False -> True, or None. None with
            the flag SET means the stamp was lost (a signal that predates
            this field, e.g. across a hot reload); it refuses rather than
            capturing, because a claim that cannot be dated cannot be
            shown to be past its grace window.
        now: injectable clock.
        grace_seconds: override for tests.
        last_check_at: when this claim's pane was last READ, or None when
            it has not been. None never throttles - not having looked is
            not a reason to keep not looking.
        recheck_seconds: how long a reading stands. Override for tests.
    Output:
        bool - True when the caller should capture a tail and pass it to
        ``resolve_permission_check``.
    Example:
        >>> from datetime import datetime, timedelta
        >>> t0 = datetime(2026, 9, 9, 12, 0, 0)
        >>> should_capture_permission_tail(
        ...     pane_alive=True, permission_open=True, opened_at=t0,
        ...     now=t0 + timedelta(seconds=99))
        True
    """
    if pane_alive is not True:
        return False
    if not permission_open:
        return False
    if opened_at is None:
        return False
    if (now - opened_at).total_seconds() < grace_seconds:
        return False
    if (
        last_check_at is not None
        and (now - last_check_at).total_seconds() < recheck_seconds
    ):
        return False
    return True


def resolve_permission_check(
    *,
    captured: bool,
    tail: Optional[str],
) -> str:
    """Turn one pane read into a verdict on the open permission claim.

    Description: the pure ladder. THREE OUTCOMES AND ONLY ONE OF THEM
        CLEARS, which is the whole design:

          1. No capture was attempted (the cost gate refused, or the flag
             is not open) -> ``PERMISSION_NOT_CHECKED``. Says nothing
             about the flag.
          2. A tail was read and a marker matched -> ``KEPT_DIALOG``. The
             agent really is parked; the hook was right.
          3. A tail was read and NO marker matched -> ``CLEARED_NO_DIALOG``.
             The one branch that retires the flag, and the only one with
             positive evidence behind it.
          4. A capture was attempted and produced nothing readable ->
             ``KEPT_UNREADABLE``. REFUSES TO CLEAR. Not having managed to
             look is not evidence that the dialog is gone, and clearing
             here would turn every transient tmux hiccup into a green
             light on a blocked session.

        Note ``captured`` is passed rather than inferred from
        ``tail is None``: both a refused capture and a failed one hand back
        None, and they are different facts. Only the second is a
        measurement that did not answer.
    Inputs:
        captured: True when the caller actually ran a capture for this
            session on this poll.
        tail: what the capture returned - text, or None when it failed.
    Output:
        str - one of the four ``PERMISSION_*`` verdicts.
    Example:
        >>> resolve_permission_check(captured=True, tail="idle prompt")
        'cleared_no_dialog'
        >>> resolve_permission_check(captured=True, tail=None)
        'kept_tail_unreadable'
        >>> resolve_permission_check(captured=False, tail=None)
        'not_checked'
    """
    if not captured:
        return PERMISSION_NOT_CHECKED
    seen = detect_permission_dialog(tail)
    if seen is None:
        return PERMISSION_KEPT_UNREADABLE
    return PERMISSION_KEPT_DIALOG if seen else PERMISSION_CLEARED_NO_DIALOG
