"""Phase 7 — agent fingerprint detector tests.

Verifies ``detect_agent_type`` against real captured scrollback for each
of the four supported AI CLIs, plus edge cases (empty input, unrelated
TUI output, banner buried under noise, generic box-drawing frames).
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from src.core.agent_fingerprint import detect_agent_type

# Directory holding real scrollback captures, one .txt per agent. These are
# multi-kilobyte dumps of live TUI output that are deliberately NOT committed
# (they are noisy, they carry whatever happened to be on screen when they were
# taken, and they are not ours to redistribute). The default path is the
# original author's machine; anyone else points AGENT_CAPTURE_DIR at their own
# copy. When the captures are absent the parametrized cases skip with a reason
# rather than failing, because their absence says nothing about the detector.
CAPTURE_DIR_ENV = "AGENT_CAPTURE_DIR"
DEFAULT_CAPTURE_DIR = "/Users/Adam/Dropbox/llmScratch"

CAPTURES = Path(os.environ.get(CAPTURE_DIR_ENV, DEFAULT_CAPTURE_DIR)).expanduser()


def _load_capture(fname: str) -> str:
    """Read a real scrollback capture, skipping the test when it is absent.

    Inputs:
        fname (str): capture file name, e.g. ``"claude.txt"``.

    Outputs:
        str: the capture text, decoded permissively because real terminal
        dumps contain partial escape sequences and stray bytes.

    Raises:
        pytest.skip.Exception: when the capture directory or file is missing.

    Example:
        >>> _load_capture("claude.txt")  # doctest: +SKIP
        '...scrollback...'
    """
    path = CAPTURES / fname
    if not path.is_file():
        pytest.skip(
            f"scrollback capture {fname} not available at {CAPTURES}. "
            f"These captures are intentionally uncommitted; set "
            f"{CAPTURE_DIR_ENV} to a directory containing them to run this "
            f"case. The synthetic fingerprint tests below still run."
        )
    return path.read_text(encoding="utf-8", errors="replace")


@pytest.mark.parametrize(
    "fname,expected",
    [
        ("openclaw.txt", "openclaw"),
        ("hermes.txt", "hermes"),
        ("codex.txt", "codex"),
        ("claude.txt", "claude"),
    ],
)
def test_real_capture_detects(fname: str, expected: str) -> None:
    assert detect_agent_type(_load_capture(fname)) == expected


def test_empty_returns_none() -> None:
    assert detect_agent_type("") is None
    assert detect_agent_type(None) is None


def test_unrelated_returns_none() -> None:
    assert detect_agent_type(
        "just some random TUI output\n$ ls\nfile.txt"
    ) is None


def test_banner_buried_under_noise_caught_only_by_second_pass() -> None:
    """Banner at line 0, then 60+ lines of noise → first pass (50 lines)
    misses; second pass (2000 lines) catches it."""
    banner = "🦞 OpenClaw something something boot line\n"
    noise = "\n".join(f"noise line {i}" for i in range(80))
    scrollback = banner + noise

    # Confirm the 50-line tail does NOT contain the banner.
    tail = "\n".join(scrollback.splitlines()[-50:])
    assert "OpenClaw" not in tail

    # But the full detector (two-pass) finds it.
    assert detect_agent_type(scrollback) == "openclaw"


def test_box_drawing_frames_are_not_a_false_positive() -> None:
    """Generic TUI box-drawing alone must not trigger any agent.

    The new fingerprints anchor on agent-specific glyphs, not on
    ``╭─`` / ``╰─`` corners which appear in countless CLIs.
    """
    junk = "\n".join(
        [
            "╭─ some box ─╮",
            "│ inner txt │",
            "╰────────────╯",
            "$ generic shell prompt",
        ]
    )
    assert detect_agent_type(junk) is None
