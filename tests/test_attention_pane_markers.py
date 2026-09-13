"""Tests for reading dialog markers off the last block of a pane capture.

THE NEGATIVE CONTROLS ARE THE POINT OF THIS FILE, TWICE OVER.

First, a matcher that always finds something would pass every positive
test here and would report a permission prompt on every session forever.
So the steady-state footer of a busy claude and an idle prompt box are
both asserted to come back False.

Second, and this is the one that is easy to get wrong: FALSE AND None ARE
NOT THE SAME ANSWER. ``capture-pane`` against a full-screen TUI is
documented to return trailing blanks and nothing else, and claude runs
full-screen. A capture that reduces to nothing therefore means "we did
not manage to look", not "the screen is clear". An implementation that
answered False there would look correct in every other test in this file
and would silently suppress the permission prompts the user is actually
blocked on, so it gets its own assertions.

Third, the scan is bounded to the trailing block ON PURPOSE. Claude's TUI
leaves the text of an ALREADY ANSWERED dialog in the scrollback above the
live region; every prior-art implementation that matched against the
whole capture reported false positives from exactly that. So a dialog
sitting above a blank-line gap is asserted NOT to match.
"""

from __future__ import annotations

from src.core.attention.pane_markers import (
    BLOCK_MAX_LINES,
    BLOCK_SEPARATOR_BLANK_LINES,
    QUESTION_DIALOG_MARKERS,
    classify_pane_tail,
    last_text_block,
)

#: The permission prompt exactly as claude 2.1.265/266 renders it, taken
#: from the capture recorded in ``session_permission_verify``'s docstring.
#: Note the blank line INSIDE it: that is why the block separator is two
#: blank lines and not one.
PERMISSION_DIALOG_LINES = [
    "     Bash command",
    "",
    "       date +%s",
    "       Print current Unix timestamp",
    "",
    "     Ask rule Bash overrides auto mode for this command.",
    "",
    "   Do you want to proceed?",
    "   ❯ 1. Yes",
    "     2. No, and tell Claude what to do differently",
    "",
    "   Esc to cancel · Tab to amend",
]

#: The footer claude renders under an AskUserQuestion menu.
QUESTION_FOOTER = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"

#: A busy claude's steady-state footer. Contains none of the markers and
#: must stay that way.
BUSY_FOOTER_LINES = [
    "⏸ plan mode on (shift+tab to cycle) · ← 1 agent",
    "◯ Explore the resolver 3m 43s · ↓ 121.8k tokens",
]

#: An idle claude at its prompt box.
IDLE_PROMPT_LINES = [
    "─────────────────────────────────────────",
    "❯",
    "─────────────────────────────────────────",
    "⏵⏵ bypass permissions on (shift+tab to cycle)",
]


def test_permission_dialog_on_the_pane_is_matched() -> None:
    """A real permission prompt answers True for the permission family."""
    verdict = classify_pane_tail(PERMISSION_DIALOG_LINES)
    assert verdict.permission_dialog is True
    assert verdict.shows_dialog is True


def test_ask_user_question_footer_is_matched() -> None:
    """The AskUserQuestion footer answers True for the question family.

    This is the one marker family this project did not already have, so
    it needs a positive as well as the negatives below.
    """
    verdict = classify_pane_tail(["   What should I do next?", "   " + QUESTION_FOOTER])
    assert verdict.question_dialog is True
    assert verdict.permission_dialog is False


def test_question_footer_tolerates_a_different_separator() -> None:
    """A restyled separator still matches the footer.

    The footer drifted four times between 2.1.92 and 2.1.270. Matching
    the three phrases rather than the exact punctuation between them is
    the difference between degrading on a separator and losing the whole
    dialog.
    """
    swapped = "Enter to select | Tab/Arrow keys to navigate | Esc to cancel"
    assert classify_pane_tail([swapped]).question_dialog is True


def test_question_footer_is_anchored_to_its_own_line() -> None:
    """The three phrases inside a sentence of prose do NOT match.

    Claude writes about its own tools. A marker that matched mid-sentence
    would paint a question light while claude was explaining one.
    """
    prose = (
        "I will use Enter to select Tab/Arrow keys to navigate Esc to "
        "cancel when the menu opens."
    )
    assert classify_pane_tail([prose]).question_dialog is False


def test_busy_footer_matches_nothing() -> None:
    """The steady-state footer of a working claude is a measured False."""
    verdict = classify_pane_tail(BUSY_FOOTER_LINES)
    assert verdict.permission_dialog is False
    assert verdict.question_dialog is False
    assert verdict.trust_dialog is False
    assert verdict.shows_no_dialog is True


def test_idle_prompt_box_matches_nothing() -> None:
    """An idle prompt is a measured False, not a dialog."""
    verdict = classify_pane_tail(IDLE_PROMPT_LINES)
    assert verdict.shows_dialog is False
    assert verdict.shows_no_dialog is True


def test_folder_trust_dialog_is_its_own_family() -> None:
    """The trust dialog is reported, and is NOT counted as a dialog to answer.

    It runs BEFORE claude registers itself, so it belongs to the startup
    gate. Folding it into ``shows_dialog`` would make a session that is
    still launching look like a session that is stopped and waiting.
    """
    verdict = classify_pane_tail(["  Yes, I trust this folder"])
    assert verdict.trust_dialog is True
    assert verdict.shows_dialog is False


def test_an_all_blank_capture_answers_none_not_false() -> None:
    """THE LOAD-BEARING CASE. A blank capture is a failed read.

    capture-pane on a full-screen TUI returns only trailing blanks. If
    that answered False, every permission prompt on a pane we could not
    read would be reported as no prompt at all.
    """
    verdict = classify_pane_tail(["", "   ", "\t", ""])
    assert verdict.permission_dialog is None
    assert verdict.question_dialog is None
    assert verdict.trust_dialog is None
    assert verdict.looked is False
    assert verdict.shows_no_dialog is False


def test_no_capture_at_all_answers_none() -> None:
    """None and an empty list are the same failed read, not a clear screen."""
    for capture in (None, []):
        verdict = classify_pane_tail(capture)
        assert verdict.permission_dialog is None
        assert verdict.looked is False


def test_a_dialog_in_stale_scrollback_is_not_matched() -> None:
    """An answered dialog left above the live region must not match.

    This is the false positive every prior-art implementation that
    scanned the whole capture reported.
    """
    lines = PERMISSION_DIALOG_LINES + ["", "", "❯ carry on"]
    verdict = classify_pane_tail(lines)
    assert verdict.permission_dialog is False
    assert last_text_block(lines) == ["❯ carry on"]


def test_a_single_blank_line_does_not_split_a_dialog() -> None:
    """The block separator is two blank lines because dialogs contain one.

    The captured permission prompt has a blank line between the command
    echo and the rule explanation, and the question line sits above it.
    Splitting on one blank would drop the question line and lose the
    dialog.
    """
    assert BLOCK_SEPARATOR_BLANK_LINES == 2
    block = last_text_block(PERMISSION_DIALOG_LINES)
    assert "   Do you want to proceed?" in block
    assert "     Bash command" in block


def test_the_block_is_bounded_when_the_capture_has_no_separator() -> None:
    """A capture with no blank line anywhere still reads a bounded block."""
    lines = ["line %d" % index for index in range(BLOCK_MAX_LINES * 3)]
    assert len(last_text_block(lines)) == BLOCK_MAX_LINES


def test_trailing_blanks_are_dropped_before_the_block_is_taken() -> None:
    """The unused bottom of the screen is not the block."""
    assert last_text_block(["live", "", "", ""]) == ["live"]


def test_every_question_marker_is_compiled_and_anchored() -> None:
    """The footer family is patterns, not substrings.

    A bare substring for any of these three phrases would match claude's
    prose about its own tools, which is the failure the anchoring test
    above proves does not happen. This asserts the SHAPE so a future
    addition cannot quietly reintroduce it.
    """
    for marker in QUESTION_DIALOG_MARKERS:
        assert hasattr(marker, "search"), marker
        assert marker.pattern.startswith("^")
