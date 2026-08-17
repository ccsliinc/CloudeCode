#!/usr/bin/env python3
"""Generate the Cloude Code DMG background artwork.

Emits an SVG source file and renders it to PNG at 1x and 2x so the Finder
window can be given a retina-correct background. Colours are lifted from the
app's own default theme manifest (client/css/themes/claude/theme.json) rather
than invented here, so the installer looks like the product.

Usage:
    python3 make-background.py [--out-dir DIR]

Outputs (in --out-dir, default: the directory holding this script):
    background.svg      the vector source, committed for reproducibility
    background.png      660x420, the 1x layer of the tiff
    background@2x.png   1320x840, the 2x layer of the tiff

Rendering uses rsvg-convert (librsvg). See build-dmg.sh for how the two PNGs
are combined into a multi-representation .tiff, which is the only way to hand
Finder a retina background.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

# --- window geometry, in points -------------------------------------------
# These MUST stay in sync with the AppleScript window bounds in build-dmg.sh.
WINDOW_W = 660
WINDOW_H = 420

# Icon cell centres, in points from the top-left of the window content area.
# build-dmg.sh positions the two DMG items at exactly these coordinates.
SLOT_LEFT_X = 190
SLOT_RIGHT_X = 470
SLOT_Y = 244

# The card drawn behind each icon cell. Sized so that a 128pt Finder icon
# centred at SLOT_Y, plus the filename label Finder draws beneath it, both
# land inside the card.
SLOT_TOP = 162
SLOT_H = 186
SLOT_HALF_W = 108

# --- palette --------------------------------------------------------------
# Fallbacks are used only if the theme manifest cannot be read; they are the
# same literals the manifest carries today.
THEME_RELATIVE = Path("client/css/themes/claude/theme.json")
PALETTE_FALLBACK = {
    "--color-bg-page": "#0a0a0a",
    "--color-bg": "#1e1e1e",
    "--color-fg": "#d4d4d4",
    "--color-fg-muted": "#858585",
    "--color-border": "#3e3e42",
    "--color-accent": "#d77757",
    "--color-accent-strong": "#e88768",
}

MONO = "Menlo, 'SF Mono', Monaco, monospace"


class ArtworkError(RuntimeError):
    """Raised when the artwork cannot be generated or rendered."""


def find_repo_root(start: Path) -> Path:
    """Walk up from `start` looking for the repository root.

    Args:
        start: any path inside the repository.

    Returns:
        The first ancestor directory containing a `.git` entry, or `start`
        itself when none is found (the script still works standalone).
    """
    for parent in [start] + list(start.parents):
        if (parent / ".git").exists():
            return parent
    return start


def load_palette(repo_root: Path) -> dict[str, str]:
    """Read the app's default theme colours.

    Args:
        repo_root: repository root, used to locate the theme manifest.

    Returns:
        A mapping of CSS custom property name to hex colour. Missing keys are
        filled from PALETTE_FALLBACK so the artwork always renders.
    """
    palette = dict(PALETTE_FALLBACK)
    manifest = repo_root / THEME_RELATIVE
    try:
        with manifest.open("r", encoding="utf-8") as handle:
            css_vars = json.load(handle).get("cssVars", {})
    except (OSError, ValueError):
        return palette
    for key in palette:
        value = css_vars.get(key)
        if isinstance(value, str) and value.startswith("#"):
            palette[key] = value
    return palette


def read_version(repo_root: Path) -> str:
    """Resolve the app version through the app's own single resolver.

    The release tag is the source of version truth, so the artwork must not
    carry a second one. This loads src/core/version.py by path (this script
    runs standalone, outside the package) and calls the same resolver the
    running server uses.

    Args:
        repo_root: repository root.

    Returns:
        A version string such as "0.8.1", or "" when it cannot be resolved.
        The caller renders no chip rather than a wrong literal.
    """
    module_path = repo_root / "src" / "core" / "version.py"
    try:
        spec = importlib.util.spec_from_file_location("cloude_version", module_path)
        if spec is None or spec.loader is None:
            return ""
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return str(module.resolve_version(repo_root))
    except (OSError, ImportError, AttributeError, SyntaxError):
        return ""


def cloud_path() -> str:
    """Return SVG markup for the coral cloud mark.

    The app's header uses the cloud emoji. Emoji do not render predictably
    through librsvg, so the mark is redrawn here as overlapping primitives in
    a single group, which fills as one silhouette.

    Returns:
        An SVG `<g>` fragment, drawn in a 0..124 x 0..86 local box.
    """
    return (
        '<g fill="url(#cloudFill)">'
        '<circle cx="38" cy="52" r="20"/>'
        '<circle cx="64" cy="38" r="28"/>'
        '<circle cx="94" cy="50" r="22"/>'
        '<rect x="34" y="50" width="62" height="22" rx="11"/>'
        "</g>"
    )


def build_svg(palette: dict[str, str], version: str) -> str:
    """Compose the full background SVG.

    Args:
        palette: colours from `load_palette`.
        version: version string to stamp, or "" to omit the chip.

    Returns:
        Complete SVG document text sized WINDOW_W x WINDOW_H points.
    """
    accent = palette["--color-accent"]
    accent_strong = palette["--color-accent-strong"]
    bg_page = palette["--color-bg-page"]
    bg = palette["--color-bg"]
    fg = palette["--color-fg"]
    muted = palette["--color-fg-muted"]

    # Parked in the top-right corner rather than beside the wordmark: the
    # wordmark is wide enough at 30pt that an inline chip collided with it.
    version_chip = ""
    if version:
        version_chip = (
            f'<rect x="{WINDOW_W - 92}" y="20" width="64" height="20" rx="10" '
            f'fill="{accent}" fill-opacity="0.10" stroke="{accent}" stroke-opacity="0.40"/>'
            f'<text x="{WINDOW_W - 60}" y="34" text-anchor="middle" '
            f'font-family="{MONO}" font-size="10" fill="{accent}" '
            f'letter-spacing="0.5">v{version}</text>'
        )

    # Scanline overlay: 2pt period, very low alpha. Sells the terminal look
    # without competing with the icon labels Finder draws on top.
    scanlines = (
        '<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse">'
        f'<rect width="4" height="1" fill="{fg}" fill-opacity="0.022"/>'
        "</pattern>"
    )

    slots = []
    for cx, step, caption in (
        (SLOT_LEFT_X, "1", "double-click to install"),
        (SLOT_RIGHT_X, "2", "read this first"),
    ):
        left = cx - SLOT_HALF_W
        slots.append(
            f'<rect x="{left}" y="{SLOT_TOP}" width="{SLOT_HALF_W * 2}" height="{SLOT_H}" rx="14" '
            f'fill="{bg}" fill-opacity="0.55" stroke="{accent}" stroke-opacity="0.18"/>'
            f'<circle cx="{left + 22}" cy="{SLOT_TOP + 22}" r="11" '
            f'fill="{accent}" fill-opacity="0.16" stroke="{accent}" stroke-opacity="0.5"/>'
            f'<text x="{left + 22}" y="{SLOT_TOP + 26}" text-anchor="middle" '
            f'font-family="{MONO}" font-size="11" font-weight="bold" fill="{accent}">{step}</text>'
            f'<text x="{left + 42}" y="{SLOT_TOP + 26}" font-family="{MONO}" '
            f'font-size="10" fill="{muted}" letter-spacing="0.3">{caption}</text>'
        )

    footer = (
        "macos only  |  installs a user launchagent into gui/501  |  "
        "no secrets ship inside this image"
    )

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED by packaging/dmg/artwork/make-background.py - do not hand edit -->
<svg xmlns="http://www.w3.org/2000/svg" width="{WINDOW_W}" height="{WINDOW_H}"
     viewBox="0 0 {WINDOW_W} {WINDOW_H}">
  <defs>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{bg_page}"/>
      <stop offset="0.55" stop-color="{bg_page}"/>
      <stop offset="1" stop-color="{bg}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.06" r="0.7">
      <stop offset="0" stop-color="{accent}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="{accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cloudFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{accent_strong}"/>
      <stop offset="1" stop-color="{accent}"/>
    </linearGradient>
    {scanlines}
  </defs>

  <rect width="{WINDOW_W}" height="{WINDOW_H}" fill="url(#page)"/>
  <rect width="{WINDOW_W}" height="{WINDOW_H}" fill="url(#glow)"/>
  <rect width="{WINDOW_W}" height="{WINDOW_H}" fill="url(#scan)"/>

  <g transform="translate({WINDOW_W / 2 - 62:.0f}, 22) scale(0.62)">
    {cloud_path()}
  </g>

  <text x="{WINDOW_W / 2}" y="110" text-anchor="middle" font-family="{MONO}"
        font-size="30" font-weight="bold" fill="{fg}" letter-spacing="1.5">cloude code</text>
  {version_chip}
  <text x="{WINDOW_W / 2}" y="133" text-anchor="middle" font-family="{MONO}"
        font-size="11" fill="{muted}" letter-spacing="0.6">
    remote control claude code sessions from anywhere
  </text>

  <line x1="90" y1="150" x2="{WINDOW_W - 90}" y2="150"
        stroke="{accent}" stroke-opacity="0.22"/>

  {"".join(slots)}

  <text x="{WINDOW_W / 2}" y="{WINDOW_H - 18}" text-anchor="middle" font-family="{MONO}"
        font-size="9" fill="{muted}" fill-opacity="0.8" letter-spacing="0.4">{footer}</text>
</svg>
"""


def render(svg_path: Path, png_path: Path, scale: int) -> None:
    """Rasterise the SVG with rsvg-convert.

    Args:
        svg_path: path to the SVG source.
        png_path: path the PNG is written to.
        scale: integer pixel scale, 1 or 2.

    Raises:
        ArtworkError: if rsvg-convert is missing or exits non-zero.
    """
    cmd = [
        "rsvg-convert",
        "--width", str(WINDOW_W * scale),
        "--height", str(WINDOW_H * scale),
        "--format", "png",
        "--output", str(png_path),
        str(svg_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except FileNotFoundError as exc:
        raise ArtworkError(
            "rsvg-convert not found. install it with: brew install librsvg"
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise ArtworkError(
            f"rsvg-convert failed ({exc.returncode}): {exc.stderr.decode(errors='replace')}"
        ) from exc


def main(argv: list[str] | None = None) -> int:
    """Entry point.

    Args:
        argv: argument vector, defaults to sys.argv[1:].

    Returns:
        Process exit code: 0 on success, 1 on a generation failure.
    """
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="generate the cloude code dmg background")
    parser.add_argument("--out-dir", type=Path, default=here)
    args = parser.parse_args(argv)

    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    repo_root = find_repo_root(here)

    svg_path = out_dir / "background.svg"
    svg_path.write_text(build_svg(load_palette(repo_root), read_version(repo_root)), encoding="utf-8")

    try:
        render(svg_path, out_dir / "background.png", 1)
        render(svg_path, out_dir / "background@2x.png", 2)
    except ArtworkError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"wrote {svg_path.name}, background.png (1x), background@2x.png (2x) in {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
