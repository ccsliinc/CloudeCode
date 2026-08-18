"""Regression tests for two specific bugs reported 2026-08-17 alongside the
theme contrast audit:

1. The home-screen ownership stripe (`.running-session-row.owned` /
   `.external`) was hardcoded to `--color-warning`, which reads as a
   generic caution-yellow unrelated to ownership and clashes with several
   themes' accent-tinted cards (most visibly Matrix).
2. The help disclosure's README link (`.adopt-disclosure-body a`) had NO
   rule at all, so it fell through to the browser's default link blue in
   every theme.

Both are asserted structurally against ``client/css/styles.css`` - a color
literal (hex/rgb/named) on either selector family is the regression, not a
specific ratio (the ratio side is covered by ``test_theme_contrast.py``).
"""
from __future__ import annotations

import re
from pathlib import Path

STYLES_CSS = Path(__file__).resolve().parents[1] / "client" / "css" / "styles.css"

# A literal color value: hex, rgb()/rgba(), or a handful of CSS named
# colors commonly pasted in by mistake (blue, red, etc). var(...) is
# excluded on purpose - that is the ONLY acceptable form here.
_LITERAL_COLOR_RE = re.compile(
    r"(?:color|background)\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|"
    r"\b(?:blue|red|green|yellow|purple|orange|pink|cyan|magenta)\b)",
    re.IGNORECASE,
)


def _rule_body(css: str, selector: str) -> str:
    """Extract the `{ ... }` body immediately following a literal selector
    string. Raises if the selector is not found - a missing selector is a
    bug in the test itself (selector renamed), never a silent pass.
    """
    idx = css.index(selector)
    start = css.index("{", idx)
    end = css.index("}", start)
    return css[start + 1:end]


def test_ownership_stripe_uses_badge_tokens_not_hardcoded():
    css = STYLES_CSS.read_text(encoding="utf-8")
    for selector in (".running-session-row.owned", ".running-session-row.external"):
        body = _rule_body(css, selector)
        literal = _LITERAL_COLOR_RE.search(body)
        assert literal is None, (
            f"{selector} has a hardcoded color ({literal.group(0)!r}) instead of "
            "a var(--color-badge-*-fg) token - this is the exact class of bug "
            "reported 2026-08-17 (yellow bars clashing with themed cards)"
        )
        assert "var(--color-badge-" in body, (
            f"{selector} does not reference a --color-badge-*-fg token at all"
        )


def test_help_readme_link_is_themed_not_default_blue():
    css = STYLES_CSS.read_text(encoding="utf-8")
    assert ".adopt-disclosure-body a" in css, (
        "no rule targets the README link at all - it will render the browser's "
        "default blue/purple link color in every theme"
    )
    body = _rule_body(css, ".adopt-disclosure-body a {")
    literal = _LITERAL_COLOR_RE.search(body)
    assert literal is None, (
        f".adopt-disclosure-body a has a hardcoded color ({literal.group(0)!r}) "
        "instead of a var(--color-accent*) token"
    )
    assert "var(--color-accent" in body

    # Distinguishable from body text by more than color alone (colorblind
    # users): must carry its own text-decoration, not rely on hover only.
    assert "text-decoration: underline" in body, (
        ".adopt-disclosure-body a has no at-rest underline - color is the "
        "only thing distinguishing it from surrounding body text"
    )


def test_no_other_hardcoded_link_colors_in_styles_css():
    """Grep every `a { ... }` / `a:hover` / `a:visited` / `a:focus` block
    in styles.css for a literal color. Catches the "pasted the same blue
    in several places" pattern named in the report - not just the help
    link.
    """
    css = STYLES_CSS.read_text(encoding="utf-8")
    anchor_rule_re = re.compile(r"([.\w#:>\s,-]*\ba(?::hover|:visited|:focus-visible|:focus)?\s*\{[^}]*\})")
    offenders = []
    for m in anchor_rule_re.finditer(css):
        rule = m.group(1)
        # Only consider rules that actually target the `a` element (not
        # e.g. `.badge` or `.adopt-disclosure-body` matched by `\ba` loosely).
        selector = rule.split("{", 1)[0]
        if not re.search(r"(^|[\s>.,])a(:\w[\w-]*)?\s*$", selector.strip()):
            continue
        literal = _LITERAL_COLOR_RE.search(rule)
        if literal:
            offenders.append((selector.strip(), literal.group(0)))
    assert not offenders, f"hardcoded link color(s) found: {offenders}"
