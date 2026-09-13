"""Regression tests for replayed-scrollback line endings.

THE BUG THESE EXIST FOR (fix/scroll-render-jank, 2026-08-16)

``tmux capture-pane -p`` separates lines with a BARE LF. The client
replays those bytes into an xterm built with ``convertEol: false``, where
a bare LF means "move down one row, KEEP the column". Reproduced on an
iPhone 16e simulator (iOS 26.1, DPR 3, 43x34 grid): writing
``"AAAAAAAAAA\\nBBBBBBBBBB\\nCCCCCCCCCC"`` into the live terminal produced

    AAAAAAAAAA
              BBBBBBBBBB
                        CCCCCCCCCC

and the xterm buffer dump matched the screen exactly, which is what makes
it a BUFFER bug rather than a paint bug. Every adopted or rejoined
session's replayed history was staircased this way; freshly streamed PTY
output was always clean because a real PTY sends ``\\r\\n``.

The tests below pin the two halves of the fix: the normalizer's
semantics, and the fact that ``TmuxBackend.capture_scrollback`` actually
applies it (the half that would silently rot if someone rewrote the
capture path).
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# ---- minimal env bootstrap so ``src.config`` import succeeds -----------
os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_sbn_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_sbn_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.core.scrollback_replay import (  # noqa: E402
    normalize_replay_newlines,
    with_cursor_restore,
)
from src.core import tmux_backend as tmux_backend_mod  # noqa: E402


# ---- the normalizer ----------------------------------------------------

def test_bare_lf_becomes_crlf():
    """The staircase case: capture-pane's bare LFs must become CRLF."""
    assert normalize_replay_newlines(b"AAA\nBBB\nCCC") == b"AAA\r\nBBB\r\nCCC"


def test_existing_crlf_is_untouched():
    """Already-correct input must not gain a second carriage return."""
    assert normalize_replay_newlines(b"AAA\r\nBBB\r\n") == b"AAA\r\nBBB\r\n"


def test_normalization_is_idempotent():
    """Applying it twice equals applying it once."""
    once = normalize_replay_newlines(b"AAA\nBBB\r\nCCC\n")
    assert normalize_replay_newlines(once) == once


def test_mixed_endings_all_land_on_crlf():
    """A capture that mixes both styles comes out uniform."""
    assert (
        normalize_replay_newlines(b"one\ntwo\r\nthree\nfour")
        == b"one\r\ntwo\r\nthree\r\nfour"
    )


def test_lone_carriage_return_is_preserved():
    """A bare CR is a real cursor command (progress bars, spinners) and
    must survive untouched - it is not a line ending to rewrite."""
    assert normalize_replay_newlines(b"50%\r100%") == b"50%\r100%"


def test_ansi_escapes_survive():
    """``capture-pane -e`` emits SGR sequences. None of them embed a raw
    LF, so a byte-level substitution must leave them byte-identical."""
    src = b"\x1b[1;32mgreen\x1b[0m\nplain\n"
    assert normalize_replay_newlines(src) == b"\x1b[1;32mgreen\x1b[0m\r\nplain\r\n"


def test_empty_input_returns_empty():
    """The capture-failed path returns b"" and must stay b""."""
    assert normalize_replay_newlines(b"") == b""


def test_no_newlines_is_unchanged():
    assert normalize_replay_newlines(b"single line") == b"single line"


# ---- the wiring --------------------------------------------------------

class _StubBackend:
    """Minimal stand-in exposing only what capture_scrollback touches."""

    scrollback_lines = 3000
    tmux_session = "cloude_probe"
    replay_in_progress = False

    def __init__(self, payload: bytes, rc: int = 0):
        self._payload = payload
        self._rc = rc
        self.args: tuple = ()

    def _run_tmux_sync(self, *args, **kwargs):
        self.args = args
        return self._rc, self._payload, b""


def test_capture_scrollback_normalizes_its_output():
    """The real defect: capture_scrollback must not hand bare LFs to the
    client, however the tmux call itself is spelled."""
    stub = _StubBackend(b"drwxr-xr-x  jsugamele\ntotal 12\n")
    out = tmux_backend_mod.TmuxBackend.capture_scrollback(stub, lines=10)
    assert out == b"drwxr-xr-x  jsugamele\r\ntotal 12\r\n"
    assert b"\n" not in out.replace(b"\r\n", b"")


def test_capture_scrollback_failure_still_returns_empty():
    """A non-zero tmux exit keeps returning b"" - the normalizer must not
    turn a failure into a success."""
    stub = _StubBackend(b"whatever\n", rc=1)
    assert tmux_backend_mod.TmuxBackend.capture_scrollback(stub, lines=10) == b""


@pytest.mark.parametrize("flag", ["-p", "-e", "-J"])
def test_capture_scrollback_keeps_its_tmux_flags(flag):
    """-J joins tmux's hardware wraps into logical lines, which is only
    correct once every line actually starts at column 0. Guard the pair."""
    stub = _StubBackend(b"x\n")
    tmux_backend_mod.TmuxBackend.capture_scrollback(stub, lines=10)
    assert flag in stub.args


# ---- the cursor suffix -------------------------------------------------
#
# THE SECOND HALF OF A REPLAYABLE CAPTURE. ``capture-pane`` serialises
# CELLS and never cursor state, so a client that replays one is left
# wherever the last character it wrote landed - which is where the pane's
# cursor is only by coincidence. Measured on a real Claude Code pane
# 2026-09-08: the cursor sat on row 9 inside the input box while the
# capture ran to row 12, because the box's bottom border, the path line
# and the mode line all sit BELOW the prompt.
#
# The rule lives in ONE function so the attach paint and the rejoin
# history paint cannot disagree about the arithmetic. These tests pin the
# arithmetic; the callers' own suites pin that they apply it.


def test_a_cursor_becomes_a_one_based_absolute_position():
    """tmux reports 0-based ``(x, y)``; CUP is 1-based ``row;col``.

    BOTH the order swap and the two increments are in this one line, and
    getting either wrong puts every replayed session's cursor in the
    wrong place while looking entirely plausible.
    """
    assert with_cursor_restore(b"body", (5, 2)) == b"body\x1b[3;6H"


def test_the_origin_cell_is_row_one_column_one():
    """The 0-based origin is not a falsy special case."""
    assert with_cursor_restore(b"body", (0, 0)) == b"body\x1b[1;1H"


def test_no_cursor_appends_nothing_at_all():
    """THE NEGATIVE CONTROL, and the reason the parameter is nullable.

    A cursor that could not be read leaves the client where the text
    ended, which is the behaviour from before the suffix existed. An
    invented ``(0, 0)`` would move every session to the top-left while
    looking like a working feature, so ``None`` must add NO bytes - not a
    home sequence, not an empty escape.
    """
    assert with_cursor_restore(b"body", None) == b"body"


def test_an_empty_capture_stays_empty():
    """``b""`` means "nothing was captured" to every caller.

    A lone positioning sequence would make an empty capture truthy, and
    the rejoin route reads a truthy capture as "paint this", so the
    client would be handed a paint of nothing.
    """
    assert with_cursor_restore(b"", (5, 2)) == b""
    assert with_cursor_restore(b"", None) == b""


def test_the_suffix_is_ascii_and_leaves_the_body_untouched():
    """The capture's own bytes are never rewritten, only appended to."""
    body = "héllo\r\n".encode("utf-8")
    out = with_cursor_restore(body, (1, 1))
    assert out.startswith(body)
    assert out[len(body):] == b"\x1b[2;2H"
