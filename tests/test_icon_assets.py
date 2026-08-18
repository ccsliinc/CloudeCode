"""fix/real-app-icon — regression test for every icon asset the app declares.

Guards against exactly the bug class this branch fixed: a `<link>` or
manifest `icons[]` entry pointing at a filename that has been renamed or
deleted, which 404s silently (nobody watches the network tab of their own
home-screen icon). Checks two independent things for every declared icon:

1. The path referenced in client/index.html, client/manifest.webmanifest and
   the header-icon constant in client/js/app.js resolves to a file that
   actually exists on disk.
2. The exact same URL, requested through a minimal Starlette app that mounts
   client/ the same way src/main.py does (StaticFiles at /static, plus the
   two dedicated /manifest.webmanifest and /apple-touch-icon.png routes),
   returns HTTP 200.

Deliberately does NOT import src.main / boot the real app: that pulls in
session_manager's lifespan (tmux, auth config, upload sweeper) for no
benefit here. The route shapes under test are exactly two lines of
src/main.py (the StaticFiles mount + the apple-touch-icon FileResponse) and
are cheap to mirror directly.

Hermetic - no server process, no config.json, no network.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
CLIENT_DIR = ROOT / "client"
INDEX_HTML = CLIENT_DIR / "index.html"
MANIFEST = CLIENT_DIR / "manifest.webmanifest"
APP_JS = CLIENT_DIR / "js" / "app.js"


def _static_test_app() -> FastAPI:
    """Rebuild just the icon-serving surface of src/main.py.

    Mirrors app.mount("/static", ...) and the /manifest.webmanifest and
    /apple-touch-icon.png routes exactly (same source directory, same
    fixed apple-touch-icon target file), without any of the session/auth
    machinery the real app boots.
    """
    app = FastAPI()
    app.mount("/static", StaticFiles(directory=str(CLIENT_DIR)), name="static")

    @app.get("/manifest.webmanifest")
    async def manifest():
        return FileResponse(MANIFEST, media_type="application/manifest+json")

    @app.get("/apple-touch-icon.png")
    async def apple_touch_icon():
        return FileResponse(CLIENT_DIR / "assets" / "icons" / "icon-180.png")

    return app


def _html_icon_hrefs() -> list[str]:
    """Extract every icon-ish <link href> from index.html's <head>.

    Returns:
        List of href values for rel="icon", rel="apple-touch-icon" and
        rel="manifest" link tags, in document order.
    """
    html = INDEX_HTML.read_text(encoding="utf-8")
    hrefs = []
    for match in re.finditer(r"<link\s+[^>]*>", html):
        tag = match.group(0)
        rel_match = re.search(r'rel="([^"]+)"', tag)
        href_match = re.search(r'href="([^"]+)"', tag)
        if not rel_match or not href_match:
            continue
        if rel_match.group(1) in ("icon", "apple-touch-icon", "manifest"):
            hrefs.append(href_match.group(1))
    return hrefs


def _manifest_icon_srcs() -> list[str]:
    """Return every icons[].src from manifest.webmanifest."""
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return [entry["src"] for entry in data.get("icons", [])]


def _header_brand_icon_url() -> str:
    """Extract HEADER_BRAND_ICON_URL from client/js/app.js.

    Returns:
        The string literal assigned to the constant.

    Raises:
        AssertionError: if the constant is missing (renamed out from under
            this test rather than pointing at a deleted file - either way
            the test should fail loudly, not skip).
    """
    js = APP_JS.read_text(encoding="utf-8")
    match = re.search(r"HEADER_BRAND_ICON_URL\s*=\s*'([^']+)'", js)
    assert match, "HEADER_BRAND_ICON_URL not found in client/js/app.js"
    return match.group(1)


def _url_to_disk_path(url: str) -> Path:
    """Map a served URL path to the file it resolves to on disk.

    Args:
        url: an absolute path like "/static/assets/icons/icon-192.png" or
            one of the two dedicated routes.

    Returns:
        The Path src/main.py would actually serve for that URL.
    """
    if url == "/manifest.webmanifest":
        return MANIFEST
    if url == "/apple-touch-icon.png":
        return CLIENT_DIR / "assets" / "icons" / "icon-180.png"
    assert url.startswith("/static/"), f"unhandled icon URL shape: {url}"
    return CLIENT_DIR / url[len("/static/"):]


def all_declared_icon_urls() -> list[str]:
    """Every icon URL this app declares, from all three sources, deduped."""
    urls = _html_icon_hrefs() + _manifest_icon_srcs() + [_header_brand_icon_url()]
    seen: list[str] = []
    for url in urls:
        if url not in seen:
            seen.append(url)
    return seen


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(_static_test_app())


@pytest.mark.parametrize("url", all_declared_icon_urls())
def test_icon_file_exists_on_disk(url: str) -> None:
    """Every declared icon URL maps to a file that exists on disk."""
    path = _url_to_disk_path(url)
    assert path.is_file(), f"{url} -> {path} does not exist"


@pytest.mark.parametrize("url", all_declared_icon_urls())
def test_icon_is_served_with_200(url: str, client: TestClient) -> None:
    """Every declared icon URL is actually served (HTTP 200), not a 404."""
    response = client.get(url)
    assert response.status_code == 200, f"{url} returned {response.status_code}"
    assert len(response.content) > 0


def test_maskable_icon_declared_and_distinct_from_any_purpose() -> None:
    """The manifest's maskable icon is its own file, not a reused 'any' icon.

    Regression guard for the specific bug this branch fixed: the maskable
    entry used to point at the same icon-512.png as the "any" entry, whose
    content fills ~98% of the canvas width and gets clipped by an Android
    adaptive-icon mask. Asserts the maskable src differs from every "any"
    src so that mistake can't quietly come back.
    """
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    icons = data.get("icons", [])
    maskable = [i["src"] for i in icons if i.get("purpose") == "maskable"]
    any_purpose = [i["src"] for i in icons if i.get("purpose") == "any"]
    assert maskable, "manifest declares no maskable icon"
    for src in maskable:
        assert src not in any_purpose, (
            f"maskable icon {src} reuses an 'any'-purpose file; "
            "it will not respect the adaptive-icon safe zone"
        )
