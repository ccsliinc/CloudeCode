"""The lazy-loaded archive and config-editor families, served correctly.

WHAT THIS FILE IS DEFENDING AGAINST. Issue #48 moved 59 files (51 of the
archive's `client/js/archive-*.js` plus the 7 `config-editor-*.js` files
and the vendored CodeMirror bundle) out of client/index.html's eager
`<script>` list and into two arrays in client/js/module-families.js that
client/js/module-loader.js fetches on demand. Two ways that split could
silently drift apart from the real file tree: a URL in module-families.js
pointing at a file that no longer exists (the lazy load would 404 forever
and the family would never work), or a file staying in BOTH the eager
list and a lazy array (double-loaded, double-initialised).

Route parsing has to survive the split too: archive-deeplink.js is what
lets a cold load of /archive/t/<id> resolve BEFORE anything is lazily
loaded, so it - and archive-entry.js, the always-visible "is the archive
on" probe - must still be in the eager list.

The requests are made without running the app's lifespan (no ``with``
block, same pattern as tests/test_archive_spa_routes.py), so no
background scheduler starts.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_lazyload_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_lazyload_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
import pytest
from fastapi.testclient import TestClient

from src.main import app

CLIENT_DIR = ROOT / "client"
INDEX_HTML = CLIENT_DIR / "index.html"
MODULE_FAMILIES_JS = CLIENT_DIR / "js" / "module-families.js"

# Files that must stay in index.html's EAGER script list. Losing any of
# these silently degrades either loud-failure behaviour (the two loader
# glue files), route resolution on a cold deep link (archive-deeplink.js),
# or the always-visible entry-point probe (archive-entry.js).
EXPECTED_EAGER = [
    "/static/js/module-loader.js",
    "/static/js/module-families.js",
    "/static/js/archive-loader.js",
    "/static/js/config-editor-loader.js",
    "/static/js/archive-deeplink.js",
    "/static/js/archive-entry.js",
]

# A representative sample of the 59 files that must NOT be eager any more.
# The full set is verified structurally below by parsing module-families.js
# and checking none of its URLs still appear as an eager <script> tag.
EXPECTED_NOT_EAGER = [
    "/static/js/archive-screen.js",
    "/static/js/archive-nav.js",
    "/static/js/api-archive.js",
    "/static/js/config-editor-panel.js",
    "/static/js/config-editor-modal.js",
    "/static/vendor/codemirror/codemirror-bundle.js",
]

_SCRIPT_SRC_RX = re.compile(r'<script\s+src="([^"]+)"\s*>\s*</script>')


def _index_html() -> str:
    return INDEX_HTML.read_text(encoding="utf-8")


def _eager_script_urls() -> set[str]:
    """Every same-origin URL index.html loads via an eager <script> tag."""
    return set(_SCRIPT_SRC_RX.findall(_index_html()))


def _family_urls() -> dict[str, list[str]]:
    """Parse window.ModuleFamilies.ARCHIVE and .CONFIG_EDITOR out of the
    source file directly, rather than executing JS, so this test has no
    dependency on a JS runtime.

    Returns:
        dict[str, list[str]]: {"ARCHIVE": [...], "CONFIG_EDITOR": [...]}.
    """
    src = MODULE_FAMILIES_JS.read_text(encoding="utf-8")
    families: dict[str, list[str]] = {}
    for name in ("ARCHIVE", "CONFIG_EDITOR"):
        block_match = re.search(
            r"var\s+" + name + r"\s*=\s*\[(.*?)\];", src, re.DOTALL
        )
        assert block_match, f"could not find the {name} array in module-families.js"
        urls = re.findall(r"'([^']+)'", block_match.group(1))
        assert urls, f"{name} array in module-families.js parsed to zero URLs"
        families[name] = urls
    return families


def test_module_families_js_exists() -> None:
    assert MODULE_FAMILIES_JS.is_file(), f"missing {MODULE_FAMILIES_JS}"


@pytest.mark.parametrize("url", EXPECTED_EAGER)
def test_eager_file_still_loads_unconditionally(url: str) -> None:
    """Route parsing and the loader glue itself must never be lazy."""
    assert url in _eager_script_urls(), (
        f"{url} must stay in client/index.html's eager <script> list"
    )


@pytest.mark.parametrize("url", EXPECTED_NOT_EAGER)
def test_lazy_family_member_is_no_longer_eager(url: str) -> None:
    assert url not in _eager_script_urls(), (
        f"{url} is still an eager <script> tag in client/index.html - it "
        "belongs only in client/js/module-families.js now, or it will "
        "load twice and initialise twice"
    )


def test_every_family_url_is_absent_from_the_eager_list() -> None:
    """No URL module-loader.js will fetch on demand may ALSO be eager -
    that would download and execute the family twice."""
    eager = _eager_script_urls()
    families = _family_urls()
    for family_name, urls in families.items():
        overlap = eager.intersection(urls)
        assert not overlap, (
            f"{family_name} URL(s) {sorted(overlap)} are still eager in "
            "index.html as well as listed for lazy loading"
        )


def test_every_family_url_resolves_to_a_real_file_on_disk() -> None:
    """A URL in module-families.js pointing at nothing would make the lazy
    load fail 100% of the time - this is what would catch that before a
    user does."""
    families = _family_urls()
    for family_name, urls in families.items():
        for u in urls:
            assert u.startswith("/static/"), f"{family_name} url {u} is not same-origin under /static/"
            rel = u[len("/static/"):]
            path = CLIENT_DIR / rel
            assert path.is_file(), (
                f"{family_name} lists {u} but {path} does not exist - "
                "module-families.js has drifted from the real file tree"
            )
            assert path.stat().st_size > 0, f"{path} exists but is empty"


@pytest.fixture(scope="module")
def client():
    """One shared TestClient (and one lifespan start/stop) for every test
    in this file that needs to make a real HTTP request. 59 family members
    times a fresh app lifespan each would start and stop the corpus
    ingester and the db integrity scheduler 59 times over - this fixture
    is what keeps that to one."""
    with TestClient(app) as c:
        yield c


@pytest.mark.parametrize(
    "family_name,url",
    [(name, u) for name in ("ARCHIVE", "CONFIG_EDITOR") for u in _family_urls()[name]],
)
def test_every_family_url_is_served_by_the_app(client: TestClient, family_name: str, url: str) -> None:
    """Every lazy-loaded URL must actually come back over HTTP, same as it
    would in a real browser's request for it."""
    resp = client.get(url)
    assert resp.status_code == 200, f"{family_name} member {url} did not serve: {resp.status_code}"
    assert len(resp.content) > 0, f"{family_name} member {url} served an empty body"


def test_archive_deeplink_route_still_resolves_without_the_lazy_family(client: TestClient) -> None:
    """A cold load of a deep archive link must still return the SPA shell -
    proof that route PARSING (archive-deeplink.js, eager) is independent of
    the archive family (lazy). This mirrors
    tests/test_archive_spa_routes.py's own assertion but is kept here too
    because it is the direct behavioural claim issue #48 makes."""
    resp = client.get("/archive/t/12345")
    assert resp.status_code == 200
    assert '<div id="archive-screen"' in resp.text
    assert "/static/js/archive-deeplink.js" in resp.text
