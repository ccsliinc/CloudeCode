"""Tests for the dmg build inputs.

The dmg itself cannot be built in a test: it needs hdiutil, a mounted volume
and a Finder that opens a real window on somebody's desktop. What CAN be
tested, and is worth testing, is everything that silently rots:

  * the artwork geometry and the Finder layout geometry are two copies of the
    same numbers in two languages. If they drift, the icons land off the
    cards and nobody notices until they look at the image.
  * the generated background really is 1x and 2x at the declared size.
  * the "no secrets on the image" gate actually trips. That gate exists
    because of two real near misses; a gate nobody tests is decoration.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
ARTWORK = REPO_ROOT / "packaging" / "dmg" / "artwork" / "make-background.py"
BUILD = REPO_ROOT / "packaging" / "dmg" / "build-dmg.sh"
PAYLOAD = REPO_ROOT / "packaging" / "dmg" / "payload"


def _py_const(name: str) -> int:
    """Read an integer constant out of make-background.py.

    Args:
        name: the constant's name.

    Returns:
        Its integer value.

    Raises:
        AssertionError: when the constant is missing.
    """
    match = re.search(rf"^{name} = (\d+)$", ARTWORK.read_text(encoding="utf-8"), re.M)
    assert match, f"{name} not found in {ARTWORK.name}"
    return int(match.group(1))


def _sh_const(name: str) -> int:
    """Read an integer constant out of build-dmg.sh.

    Args:
        name: the variable's name.

    Returns:
        Its integer value.

    Raises:
        AssertionError: when the variable is missing.
    """
    match = re.search(rf"^{name}=(\d+)$", BUILD.read_text(encoding="utf-8"), re.M)
    assert match, f"{name} not found in {BUILD.name}"
    return int(match.group(1))


@pytest.mark.parametrize(
    "py_name,sh_name",
    [
        ("WINDOW_W", "WIN_W"),
        ("WINDOW_H", "WIN_H"),
        ("SLOT_LEFT_X", "ICON_LEFT_X"),
        ("SLOT_RIGHT_X", "ICON_RIGHT_X"),
        ("SLOT_Y", "ICON_Y"),
    ],
)
def test_artwork_and_layout_geometry_agree(py_name: str, sh_name: str) -> None:
    """The background is drawn for exactly the window the build script sets."""
    assert _py_const(py_name) == _sh_const(sh_name)


def test_icons_sit_inside_their_cards() -> None:
    """A 128pt icon centred on the slot must fit inside the card behind it."""
    half = _py_const("SLOT_HALF_W")
    top = _py_const("SLOT_TOP")
    height = _py_const("SLOT_H")
    centre_y = _py_const("SLOT_Y")
    icon = _sh_const("ICON_SIZE")
    assert icon // 2 < half, "the icon is wider than its card"
    assert centre_y - icon // 2 >= top, "the icon overflows the top of its card"
    # The filename label Finder draws underneath needs roughly 24pt.
    assert centre_y + icon // 2 + 24 <= top + height, "the label overflows the card"


def test_cards_do_not_overlap() -> None:
    left = _py_const("SLOT_LEFT_X")
    right = _py_const("SLOT_RIGHT_X")
    half = _py_const("SLOT_HALF_W")
    assert left + half < right - half, "the two cards overlap"
    assert right + half <= _py_const("WINDOW_W"), "the right card runs off the window"


def test_background_renders_at_1x_and_2x(tmp_path: Path) -> None:
    """The generator produces both representations at the declared size."""
    result = subprocess.run(
        [sys.executable, str(ARTWORK), "--out-dir", str(tmp_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 and "rsvg-convert not found" in result.stderr:
        pytest.skip("rsvg-convert is not installed on this machine")
    assert result.returncode == 0, result.stderr

    width = _py_const("WINDOW_W")
    height = _py_const("WINDOW_H")
    for name, scale in (("background.png", 1), ("background@2x.png", 2)):
        png = tmp_path / name
        assert png.is_file(), f"{name} was not produced"
        # PNG IHDR: 8 byte signature, 4 byte length, 4 byte type, then w and h
        # as big-endian uint32.
        header = png.read_bytes()[16:24]
        got_w = int.from_bytes(header[0:4], "big")
        got_h = int.from_bytes(header[4:8], "big")
        assert (got_w, got_h) == (width * scale, height * scale)


def test_svg_source_is_written(tmp_path: Path) -> None:
    subprocess.run(
        [sys.executable, str(ARTWORK), "--out-dir", str(tmp_path)],
        capture_output=True,
        text=True,
    )
    svg = tmp_path / "background.svg"
    if not svg.is_file():
        pytest.skip("rsvg-convert is not installed on this machine")
    text = svg.read_text(encoding="utf-8")
    assert "do not hand edit" in text
    # The accent colour comes from the app's own theme manifest, not a literal
    # invented in the artwork script.
    assert "#d77757" in text


def test_secret_gate_trips_on_a_planted_env(tmp_path: Path) -> None:
    """assert_no_secrets must refuse a staging tree containing a .env."""
    (tmp_path / ".env").write_text("TOTP_SECRET=NOTAREALSECRETBUTLOOKSLIKEONE\n")
    result = subprocess.run(
        ["bash", "-c",
         f'source "{BUILD}" >/dev/null 2>&1 || true; '
         f'die() {{ echo "$1" >&2; exit 1; }}; '
         f'log() {{ :; }}; '
         f'assert_no_secrets "{tmp_path}"'],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0, "the secret gate did not trip"


def test_secret_gate_passes_a_clean_tree(tmp_path: Path) -> None:
    (tmp_path / "install.sh").write_text("#!/bin/bash\necho hello\n")
    result = subprocess.run(
        ["bash", "-c",
         f'source "{BUILD}" >/dev/null 2>&1 || true; '
         f'die() {{ echo "$1" >&2; exit 1; }}; '
         f'log() {{ :; }}; '
         f'assert_no_secrets "{tmp_path}"'],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    "script",
    ["install.sh", "upgrade.sh", "rollback.sh", "run.sh",
     "install-command-wrapper.sh", "lib/common.sh", "lib/upgrade-model.sh"],
)
def test_payload_scripts_parse(script: str) -> None:
    """Every shipped script must at least be syntactically valid bash."""
    result = subprocess.run(
        ["bash", "-n", str(PAYLOAD / script)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr


def test_upgrade_model_choice_is_isolated() -> None:
    """Only upgrade-model.sh may know how code arrives.

    If a git verb leaks into install/upgrade/rollback directly, swapping to an
    artifact-based model stops being a one-file change, which is the whole
    point of that file.
    """
    for name in ("install.sh", "upgrade.sh", "rollback.sh"):
        text = (PAYLOAD / name).read_text(encoding="utf-8")
        code_lines = [
            line for line in text.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        body = "\n".join(code_lines)
        # Strip double-quoted string literals first: these scripts TALK about
        # git constantly in their error messages ("git is not installed"), and
        # a message is not a call.
        body = re.sub(r'"[^"]*"', '""', body)
        # `git ls-remote` in install.sh is the one allowed exception: it runs
        # before any checkout exists, so there is nothing for the model layer
        # to operate on yet.
        offenders = re.findall(r'\bgit\b\s+(clone|checkout|fetch|pull|tag)\b', body)
        assert not offenders, f"{name} uses git directly: {offenders}"
