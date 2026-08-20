"""Pixel-level checks on the generated menu-bar tray icons.

WHY THIS FILE EXISTS

Two defects in this feature were invisible to every non-pixel check.

1. THE MARK MUST NOT BE REDRAWN. The status icons are built by compositing
   the shipped mark, never by re-tracing it. Nothing about a filename or a
   file size can tell you whether somebody quietly redrew the silhouette, so
   the test compares the generated icons' opaque region against the SOURCE
   asset's opaque region directly.

2. THE HEALTHY STATE MUST NOT LOOK LIKE THE STOPPED ONE. The first version of
   this feature left "ok" on AppKit's template-image path while the dotted
   states used the ordinary image path. The two paths render at different
   weights, and measured in a real menu bar the healthy glyph came out at p90
   luminance 70 while "stopped" came out at 78 - the stopped server was
   BRIGHTER than the healthy one, and the two were indistinguishable at a
   glance. Every unit test passed the whole time, because nothing compared
   the actual pixels of one state against another.

These assertions run on the generated PNGs, so they fail if somebody edits
the generator's constants without looking at the result.
"""

from __future__ import annotations

from pathlib import Path

import pytest

PIL = pytest.importorskip("PIL", reason="Pillow is required to inspect the icons")
from PIL import Image  # noqa: E402  (import must follow importorskip)

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "macOS" / "assets"
TRAY_DIR = ASSETS_DIR / "tray"

STATES = ("ok", "update", "attention", "unknown", "starting", "crashed", "stopped")
APPEARANCES = ("light", "dark")
SCALES = ("", "@2x")

#: States whose glyph is drawn at full (native-matching) weight.
FULL_WEIGHT_STATES = ("ok", "update", "attention", "unknown")

#: States whose glyph is deliberately dimmed because the server is not up.
DIMMED_STATES = ("starting", "crashed")


def icon_path(state: str, appearance: str, scale: str = "") -> Path:
    """Path of one generated tray icon.

    Args:
        state: Tray state name.
        appearance: "light" or "dark".
        scale: "" for 1x or "@2x" for the retina twin.

    Returns:
        Absolute path to the PNG.
    """
    return TRAY_DIR / f"tray-{state}-{appearance}{scale}.png"


def opaque_mask(image: Image.Image) -> set[tuple[int, int]]:
    """Coordinates of every pixel with any opacity.

    Args:
        image: Any image; converted to RGBA internally.

    Returns:
        Set of (x, y) coordinates whose alpha is greater than zero.
    """
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    return {
        (x, y)
        for y in range(rgba.height)
        for x in range(rgba.width)
        if pixels[x, y][3] > 0
    }


def in_dot_corner(x: int, y: int, edge: int) -> bool:
    """Whether a coordinate falls in the lower-right dot region.

    Args:
        x: Pixel column.
        y: Pixel row.
        edge: Icon edge length in pixels.

    Returns:
        True when the pixel belongs to the status dot or its gutter.
    """
    return x > edge * 0.45 and y > edge * 0.45


def mean_glyph_alpha(image: Image.Image) -> float:
    """Mean alpha of the GLYPH, excluding the status dot.

    The dot is drawn fully opaque in every state that has one, so including it
    would swamp the glyph weight being measured and make a dotted state look
    heavier than an undotted one for reasons that have nothing to do with the
    glyph. Measuring only opaque pixels keeps the number independent of how
    much empty space surrounds the mark.

    Args:
        image: Any image; converted to RGBA internally.

    Returns:
        Mean alpha in the range 0 to 255, or 0.0 when nothing is opaque.
    """
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    edge = rgba.size[0]
    values = [
        pixels[x, y][3]
        for y in range(rgba.height)
        for x in range(rgba.width)
        if pixels[x, y][3] > 0 and not in_dot_corner(x, y, edge)
    ]
    return sum(values) / len(values) if values else 0.0


@pytest.mark.parametrize("state", STATES)
@pytest.mark.parametrize("appearance", APPEARANCES)
@pytest.mark.parametrize("scale", SCALES)
def test_every_icon_exists(state: str, appearance: str, scale: str) -> None:
    """Every state, appearance and scale has a generated file on disk."""
    path = icon_path(state, appearance, scale)
    assert path.exists(), f"missing generated tray icon: {path}"


@pytest.mark.parametrize("state", STATES)
def test_the_mark_is_composited_never_redrawn(state: str) -> None:
    """The glyph silhouette must still be the SHIPPED mark, pixel for pixel.

    The only pixels a generated icon may remove are the ones inside the dot's
    gutter, and the only pixels it may add are the dot itself. Everything
    else has to match the source asset's alpha stencil exactly. A redrawn or
    re-traced mark fails here immediately.
    """
    source = Image.open(ASSETS_DIR / "iconTemplate@2x.png")
    source_mask = opaque_mask(source)

    generated = Image.open(icon_path(state, "dark", "@2x"))
    generated_mask = opaque_mask(generated)

    edge = generated.size[0]
    # The dot and its gutter live in the lower-right corner. Anything outside
    # that corner must be identical to the source.
    source_outside = {p for p in source_mask if not in_dot_corner(p[0], p[1], edge)}
    generated_outside = {
        p for p in generated_mask if not in_dot_corner(p[0], p[1], edge)
    }

    added = generated_outside - source_outside
    removed = source_outside - generated_outside

    assert not added, (
        f"{state}: {len(added)} pixels were ADDED to the mark outside the dot "
        "corner; the silhouette must be the shipped asset, not a redraw"
    )
    assert not removed, (
        f"{state}: {len(removed)} pixels were REMOVED from the mark outside "
        "the dot corner; the silhouette must be the shipped asset"
    )


@pytest.mark.parametrize("appearance", APPEARANCES)
def test_stopped_is_clearly_fainter_than_healthy(appearance: str) -> None:
    """A stopped server must not look like a healthy one.

    This is the regression that shipped and was caught only by measuring a
    real menu bar: "stopped" rendered BRIGHTER than "ok". The margin below is
    deliberately large, because a couple of luminance steps apart is not a
    signal anybody notices in a menu bar.
    """
    ok_alpha = mean_glyph_alpha(Image.open(icon_path("ok", appearance, "@2x")))
    stopped_alpha = mean_glyph_alpha(Image.open(icon_path("stopped", appearance, "@2x")))

    assert stopped_alpha < ok_alpha, (
        f"{appearance}: stopped ({stopped_alpha:.1f}) is not fainter than ok "
        f"({ok_alpha:.1f}); a stopped server would look healthy"
    )
    assert ok_alpha - stopped_alpha > 30, (
        f"{appearance}: stopped ({stopped_alpha:.1f}) and ok ({ok_alpha:.1f}) "
        "are too close to tell apart at menu-bar size"
    )


@pytest.mark.parametrize("appearance", APPEARANCES)
def test_full_weight_states_share_one_glyph_weight(appearance: str) -> None:
    """States that are not dimmed must all render at the same glyph weight.

    If they drift apart, the icon starts implying a severity difference that
    the code never intended.
    """
    weights = {
        state: mean_glyph_alpha(Image.open(icon_path(state, appearance, "@2x")))
        for state in FULL_WEIGHT_STATES
    }
    spread = max(weights.values()) - min(weights.values())
    assert spread < 12, f"{appearance}: glyph weights drifted apart: {weights}"


@pytest.mark.parametrize("appearance", APPEARANCES)
def test_dimmed_states_sit_between_healthy_and_stopped(appearance: str) -> None:
    """The not-running states are dimmer than healthy but brighter than stopped."""
    ok_alpha = mean_glyph_alpha(Image.open(icon_path("ok", appearance, "@2x")))
    stopped_alpha = mean_glyph_alpha(Image.open(icon_path("stopped", appearance, "@2x")))

    for state in DIMMED_STATES:
        value = mean_glyph_alpha(Image.open(icon_path(state, appearance, "@2x")))
        assert stopped_alpha < value < ok_alpha, (
            f"{appearance}: {state} ({value:.1f}) must sit between stopped "
            f"({stopped_alpha:.1f}) and ok ({ok_alpha:.1f})"
        )


def test_unknown_is_a_hollow_ring_not_a_filled_dot() -> None:
    """The cannot-determine state must be visually distinct from an alarm.

    A filled dot claims "I measured this". A hollow ring says "I could not".
    If the ring ever fills in, the icon starts making a claim it cannot back,
    which is the false green this whole feature exists to prevent.
    """
    image = Image.open(icon_path("unknown", "dark", "@2x")).convert("RGBA")
    pixels = image.load()
    edge = image.size[0]

    # Centre of the dot, matching the generator's geometry.
    dot_d = edge * 0.40
    cx = int(edge - dot_d / 2.0 - edge * 0.04)
    cy = int(edge - dot_d / 2.0 - edge * 0.04)

    assert pixels[cx, cy][3] == 0, (
        "the unknown ring has a filled centre; it would read as a definite "
        "signal rather than an absent measurement"
    )

    filled = Image.open(icon_path("attention", "dark", "@2x")).convert("RGBA")
    assert filled.load()[cx, cy][3] > 0, (
        "the attention dot is hollow; it must be filled so it differs from "
        "the unknown ring"
    )


def test_no_two_states_are_pixel_identical() -> None:
    """Nominally different states must actually look different."""
    seen: dict[bytes, str] = {}
    for state in STATES:
        data = Image.open(icon_path(state, "dark", "@2x")).convert("RGBA").tobytes()
        assert data not in seen, (
            f"{state} renders identically to {seen[data]}"
        )
        seen[data] = state
