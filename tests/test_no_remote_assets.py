"""Regression guard: the client must not load anything off-origin.

WHY THIS EXISTS. xterm.js, its CSS and its three addons used to load from
cdn.jsdelivr.net. A phone with Brave Shields enabled dropped enough of that
for xterm to run while ``xterm.css`` never applied, so the character cell was
measured against an unstyled DOM, FitAddon derived a bogus cols/rows from it,
and the resize shipped that grid to tmux. The terminal rendered garbage on the
device while the desktop and the desktop mobile emulator both looked correct.

The assets are vendored under ``client/vendor/`` now. This test is what stops
someone reintroducing a CDN URL for convenience and quietly re-arming the same
failure for every user behind any content blocker or restrictive proxy.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

CLIENT_DIR = Path(__file__).resolve().parent.parent / "client"
INDEX_HTML = CLIENT_DIR / "index.html"

# Matches the src=/href= of any tag pointing at an absolute http(s) URL.
# Only loaded subresources matter here: an <a href> to a docs site is fine,
# a <script src> to a CDN is not.
_REMOTE_SUBRESOURCE = re.compile(
    r"""<(?:script|link|img|iframe|source|audio|video)\b[^>]*?"""
    r"""\b(?:src|href)\s*=\s*["'](https?://[^"']+)["']""",
    re.IGNORECASE | re.DOTALL,
)


def _index_html() -> str:
    """Read the SPA shell.

    Returns:
        str: full text of client/index.html.
    """
    return INDEX_HTML.read_text(encoding="utf-8")


def test_index_html_exists() -> None:
    """The shell must be where every other test assumes it is."""
    assert INDEX_HTML.is_file(), f"missing {INDEX_HTML}"


def test_index_html_loads_no_remote_subresource() -> None:
    """No script, stylesheet, image or media may come from another origin."""
    remote = _REMOTE_SUBRESOURCE.findall(_index_html())
    assert remote == [], (
        "client/index.html loads these off-origin subresources: "
        f"{remote}. vendor them under client/vendor/<lib>/ and serve from "
        "/static instead. see CLAUDE.md, security posture."
    )


def test_index_html_mentions_no_cdn_host() -> None:
    """Belt and braces: the known CDN host must not appear as a live URL.

    The host may still be named in comments and in the vendoring docs, which
    is deliberate: that is where the pinned upstream source is recorded. Only
    an executable reference is a failure, so comments are stripped first.
    """
    html = re.sub(r"<!--.*?-->", "", _index_html(), flags=re.DOTALL)
    assert "cdn.jsdelivr.net" not in html, (
        "cdn.jsdelivr.net reappeared in client/index.html outside a comment"
    )


@pytest.mark.parametrize(
    "asset",
    [
        "xterm.css",
        "xterm.js",
        "xterm-addon-fit.js",
        "xterm-addon-webgl.js",
        "xterm-addon-unicode11.js",
    ],
)
def test_vendored_xterm_asset_present_and_referenced(asset: str) -> None:
    """Each vendored xterm asset exists, is non-empty, and is actually used.

    Args:
        asset: filename under client/vendor/xterm/.
    """
    path = CLIENT_DIR / "vendor" / "xterm" / asset
    assert path.is_file(), f"missing vendored asset {path}"
    assert path.stat().st_size > 0, f"vendored asset is empty: {path}"
    assert f"/static/vendor/xterm/{asset}" in _index_html(), (
        f"{asset} is vendored but index.html does not reference it"
    )


def test_vendored_xterm_has_version_doc() -> None:
    """The pinned versions and hashes must be recorded beside the files."""
    version_md = CLIENT_DIR / "vendor" / "xterm" / "VERSION.md"
    assert version_md.is_file(), f"missing {version_md}"
    text = version_md.read_text(encoding="utf-8")
    assert "5.3.0" in text, "VERSION.md must pin the xterm version"


# ---------------------------------------------------------------------------
# The compiled Svelte bundle (client/dist, built from web/ - see CLAUDE.md,
# "The web/ build").
#
# WHY THIS NEEDS ITS OWN ASSERTIONS. The checks above read index.html, which
# is a hand-maintained file: a CDN URL only gets in there if a human types
# it. The bundle is machine-written, so the failure mode is different and
# worse - a dependency added in web/package.json can pull a remote font, an
# @import or a runtime chunk fetch into the output, and nobody reading the
# diff of a minified file would see it.
#
# WHAT IS AND IS NOT A FAILURE. A URL appearing in the bundle is NOT on its
# own a fault: Svelte's runtime carries `https://svelte.dev/e/...` in its
# error messages and `http://www.w3.org/1999/xhtml` as the namespace it
# hands to createElementNS, and Tailwind's licence banner names its own
# site. None of those is fetched. So these assertions match a URL in a
# LOADING POSITION - an import specifier, a CSS @import or url(), a src or
# href attribute, a Worker or importScripts - which is the thing that
# actually reaches the network and the thing a content blocker can drop.
# ---------------------------------------------------------------------------

DIST_DIR = CLIENT_DIR / "dist"

#: A remote URL in a position that causes a fetch. Deliberately NOT a bare
#: "https?://" scan: see the block comment above for why that would fail on
#: inert strings and teach everyone to add exemptions.
_REMOTE_LOAD = re.compile(
    r"""(?:
        \bfrom\s*["'](https?://[^"']+)["']          # static import
      | \bimport\s*\(\s*["'](https?://[^"']+)["']   # dynamic import
      | \bimportScripts\s*\(\s*["'](https?://[^"']+)["']
      | \bnew\s+Worker\s*\(\s*["'](https?://[^"']+)["']
      | \b(?:src|href)\s*=\s*["'](https?://[^"']+)["']
      | @import\s+(?:url\()?["']?(https?://[^"')\s]+)
      | \burl\(\s*["']?(https?://[^"')]+)
    )""",
    re.IGNORECASE | re.VERBOSE,
)

#: `script-src 'self'` forbids both of these outright. A bundler setting can
#: reintroduce either (a legacy build target, a plugin that ships a runtime
#: evaluator), and the page would break only in the browser, only under CSP,
#: with a console error nobody watching a test run would see.
_EVAL_SHAPED = re.compile(r"(?<![.\w$])eval\s*\(|new\s+Function\s*\(")


def _dist_files() -> list[Path]:
    """Every emitted file in the committed bundle.

    Returns:
        list[Path]: sorted paths under client/dist, empty when it is absent.
    """
    if not DIST_DIR.is_dir():
        return []
    return sorted(p for p in DIST_DIR.rglob("*") if p.is_file())


def test_the_built_bundle_is_committed() -> None:
    """client/dist must be present, and be the two fixed names.

    A missing bundle is not a pass: deploy-mini.sh ships the committed file
    set and would ship nothing, while index.html would still ask for it. The
    names are asserted too, because index.html references them literally and
    a build that started hashing filenames would 404 both.
    """
    names = {p.name for p in _dist_files()}
    assert names, (
        f"{DIST_DIR} is empty or absent. Build it: cd web && npm ci && npm run "
        "build, then commit client/dist. See CLAUDE.md, 'The web/ build'."
    )
    assert {"app.js", "app.css"} <= names, (
        "the bundle must emit the fixed names app.js and app.css that "
        f"client/index.html references; found {sorted(names)}"
    )


def test_index_html_loads_the_bundle() -> None:
    """The shell must actually reference both emitted assets.

    A committed bundle nothing loads is dead weight that still passes every
    other check in this file.
    """
    html = _index_html()
    assert '<script type="module" src="/static/dist/app.js">' in html, (
        "client/index.html does not load the compiled bundle as a module"
    )
    assert '/static/dist/app.css' in html, (
        "client/index.html does not load the compiled stylesheet"
    )


@pytest.mark.parametrize("name", ["app.js", "app.css"])
def test_bundle_loads_nothing_off_origin(name: str) -> None:
    """No emitted file may fetch anything from another origin.

    Args:
        name: filename under client/dist.
    """
    path = DIST_DIR / name
    if not path.is_file():
        pytest.fail(f"missing {path}; build web/ and commit client/dist")
    found = [
        url
        for match in _REMOTE_LOAD.findall(path.read_text(encoding="utf-8"))
        for url in match
        if url
    ]
    assert found == [], (
        f"client/dist/{name} loads these off-origin resources: {found}. "
        "vendor the dependency into the bundle instead; the CSP is "
        "default-src 'self' and a content blocker drops the rest anyway. "
        "see CLAUDE.md, security posture."
    )


@pytest.mark.parametrize("name", ["app.js"])
def test_bundle_contains_no_eval(name: str) -> None:
    """`script-src 'self'` forbids eval and new Function; prove neither shipped.

    Args:
        name: filename under client/dist.
    """
    path = DIST_DIR / name
    if not path.is_file():
        pytest.fail(f"missing {path}; build web/ and commit client/dist")
    hits = _EVAL_SHAPED.findall(path.read_text(encoding="utf-8"))
    assert hits == [], (
        f"client/dist/{name} contains {len(hits)} eval-shaped construct(s). "
        "The CSP has no 'unsafe-eval' and must not gain one; change the "
        "build target or drop the dependency that needs it."
    )


def test_the_bundle_detectors_can_actually_fail() -> None:
    """NEGATIVE CONTROL: a matcher that always passes is worse than useless.

    Both patterns above are asserted to find nothing in a real file. If
    either had been written wrong - an unanchored group, a typo in the
    alternation - it would find nothing in anything and this file would go
    green forever. So each is run against a sample that MUST match.
    """
    assert _REMOTE_LOAD.search('import x from "https://cdn.example/x.js"')
    assert _REMOTE_LOAD.search('@import url("https://fonts.example/f.css");')
    assert _REMOTE_LOAD.search("a{background:url(https://cdn.example/i.png)}")
    assert _REMOTE_LOAD.search('<script src="https://cdn.jsdelivr.net/x.js">')
    assert _EVAL_SHAPED.search("eval(payload)")
    assert _EVAL_SHAPED.search("new Function('return 1')")
    # And each must NOT match the inert shapes the bundle really contains,
    # or the assertions above would be unpassable rather than strict.
    assert not _REMOTE_LOAD.search('throw new Error("https://svelte.dev/e/x")')
    assert not _REMOTE_LOAD.search('createElementNS("http://www.w3.org/1999/xhtml")')
    assert not _EVAL_SHAPED.search("o.eval_(x)")
    assert not _EVAL_SHAPED.search("this.reevaluate(x)")
