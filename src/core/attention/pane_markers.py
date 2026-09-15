"""What the rendered pane shows, read off the LAST BLOCK of text only.

TIER 3, AND THE WEAKEST ONE. The pane is what claude painted, not what
claude wrote down, so this module can confirm that a dialog is on screen
and it can never confirm that a session is finished. The resolver
enforces that: a pane read can only ever produce ``needs_user``.

WHY THE SCAN IS BOUNDED TO THE END OF THE CAPTURE. Every prior-art
implementation that matched dialog markers against the WHOLE capture
reported false positives, because claude's TUI leaves the text of a
dialog that has already been answered sitting in the scrollback above the
live region, and a spinner line lingers there too. ccmanager reads "the
block above the prompt box"; multi-agent-shogun reduced it further to
"check ONLY the last line". So the matchers here are fed the trailing
block and nothing else.

WHY THE BLOCK IS SPLIT ON TWO BLANK LINES AND NOT ONE. claude's own
dialogs contain single blank lines: the captured permission prompt has
one between the command echo and the rule explanation. Splitting on a
single blank would cut a real dialog in half and drop the
``Do you want to ...?`` question line above the split, which is one of
the three markers. Two consecutive blanks is what actually separates the
live region from what is left over above it.

AN ALL-BLANK CAPTURE IS A FAILED READ, NOT A CLEAR SCREEN. ``capture-pane``
against a full-screen TUI is documented to return only trailing blanks,
and claude runs full-screen. So a capture with no text in it answers
``None`` for every family: we did not manage to look. Answering False
there would say "no dialog is open" about a screen we never saw, and a
permission prompt reported as no-prompt is the failure this project has
already paid for twice.

THE MARKERS ARE IMPORTED, NOT COPIED. The permission set was read off two
real dialogs and carries its own negative controls in
``tests/test_session_permission_verify.py``; the folder-trust set was
measured across three launches. Re-spelling either here would give this
project two copies of a regex that has to stay identical, which is how
the status LED ended up contracted to byte-identical output in two trees.
Only the ``AskUserQuestion`` footer is new, and it is new because nothing
in the codebase matched it before.
"""

from __future__ import annotations

import re
from typing import List, Optional, Pattern, Sequence, Tuple, Union

from src.core.attention.evidence import PaneVerdict
from src.core.session_permission_verify import (
    PERMISSION_TAIL_LINES,
    detect_permission_dialog,
)
from src.core.session_startup_gate import detect_startup_prompt

#: How many consecutive blank lines separate the live region from stale
#: scrollback above it. TWO, for the reason in the module docstring: one
#: is used INSIDE a rendered dialog.
BLOCK_SEPARATOR_BLANK_LINES: int = 2

#: The furthest back the trailing block may run when the capture holds no
#: separator at all. Reuses the permission tier's own capture height, so
#: the two cannot drift into disagreeing about how much pane is "recent".
BLOCK_MAX_LINES: int = PERMISSION_TAIL_LINES

#: The footer claude renders under an ``AskUserQuestion`` menu, captured
#: on 2.1.266. Anchored to a whole line: the three phrases also appear in
#: help text and in claude's own prose about its tools, and only the
#: footer puts all three on one line by themselves.
#:
#: The separator is U+00B7 with a space either side in the live capture.
#: The class below also accepts a bullet, a pipe, a comma or a dash so a
#: footer restyle (there were four between 2.1.92 and 2.1.270) degrades
#: into a miss on the SEPARATOR rather than a miss on the whole dialog.
QUESTION_DIALOG_MARKERS: Tuple[Union[str, Pattern[str]], ...] = (
    re.compile(
        r"^\s*Enter to select\s*[·•|,-]?\s*"
        r"Tab/Arrow keys to navigate\s*[·•|,-]?\s*"
        r"Esc to cancel\s*$",
        re.M,
    ),
)


def last_text_block(lines: Optional[Sequence[str]]) -> List[str]:
    """The trailing block of a pane capture, stale scrollback dropped.

    Description: PURE. Drops the blank lines the TUI leaves at the bottom
      of the screen, then walks backwards to the first run of
      :data:`BLOCK_SEPARATOR_BLANK_LINES` blank lines, or to
      :data:`BLOCK_MAX_LINES`, whichever comes first. Blank lines INSIDE
      the block are kept, because a dialog contains them.
    Inputs:
      lines: the captured pane text, one string per line, oldest first.
        None or an all-blank capture answers an empty list, which the
        caller must read as "could not look".
    Output:
      list[str] - the trailing block, possibly empty.
    Example:
      last_text_block(["old", "", "", "live"]) -> ['live']
    """
    if not lines:
        return []

    end = len(lines)
    while end > 0 and not lines[end - 1].strip():
        end -= 1
    if end == 0:
        # Nothing but blanks: a full-screen TUI capture that told us
        # nothing. See the module docstring.
        return []

    start = end
    blank_run = 0
    index = end
    while index > 0 and (end - index) < BLOCK_MAX_LINES:
        index -= 1
        if lines[index].strip():
            blank_run = 0
            start = index
        else:
            blank_run += 1
            if blank_run >= BLOCK_SEPARATOR_BLANK_LINES:
                break
    return list(lines[start:end])


def _matches(text: str, markers: Tuple[Union[str, Pattern[str]], ...]) -> bool:
    """Does any marker in a family match this text?

    Description: PURE. Literal markers are substring tests, compiled ones
      are searches, matching how the permission family is already applied
      in ``session_permission_verify``.
    Inputs:
      text: the block to test.
      markers: literals and compiled patterns, any one of which counts.
    Output: bool.
    Example: _matches("Esc to cancel", QUESTION_DIALOG_MARKERS) -> False
    """
    for marker in markers:
        if isinstance(marker, str):
            if marker in text:
                return True
        elif marker.search(text):
            return True
    return False


def classify_pane_tail(lines: Optional[Sequence[str]]) -> PaneVerdict:
    """Which dialog families are on screen in the last block of this pane?

    Description: PURE, and it NEVER RAISES. Reduces the capture to its
      trailing block and runs the three marker families over that block
      alone. Each family answers True, False or None, and the three are
      independent: a capture can show a permission prompt and no trust
      dialog, and that is two measurements, not one.

      A capture that reduces to nothing answers ``None`` for all three.
      That is the load-bearing case: it is what a full-screen TUI returns
      when ``capture-pane`` cannot see its content, and it must never be
      spelled the same way as a screen we read and found clear.
    Inputs:
      lines: captured pane text, one string per line, oldest first. None
        means no capture was attempted.
    Output:
      PaneVerdict - tri-state per family plus a detail naming what was
      read.
    Example:
      classify_pane_tail(["Do you want to proceed?"]).permission_dialog
      -> True
    """
    block = last_text_block(lines)
    if not block:
        return PaneVerdict(
            detail=(
                "the pane capture held no text, so nothing was measured; "
                "capture-pane on a full-screen TUI returns trailing blanks "
                "and that is a failed read, not a clear screen"
            )
        )

    text = "\n".join(block)
    permission = detect_permission_dialog(text)
    question = _matches(text, QUESTION_DIALOG_MARKERS)
    trust = detect_startup_prompt(text)

    found = [
        name
        for name, value in (
            ("permission", permission),
            ("question", question),
            ("trust", trust),
        )
        if value is True
    ]
    if found:
        summary = "matched " + ", ".join(found)
    else:
        summary = "matched no dialog family"
    return PaneVerdict(
        permission_dialog=permission,
        question_dialog=question,
        trust_dialog=trust,
        detail=(
            "read the last %d line(s) of the pane capture and %s"
            % (len(block), summary)
        ),
    )
