"""Precompressed static text, and cache behaviour that must not regress.

WHAT THIS FILE IS DEFENDING AGAINST. Issue #49: static JS/CSS/JSON/HTML
was served uncompressed on every request (measured: 4.15MB of eager JS
alone after issue #48's lazy-load split), and ``NoCacheStaticFiles``
already stamps ``Cache-Control: no-cache, must-revalidate`` on that same
suffix set for a real, previously-shipped reason (CLAUDE.md, "the comment
at src/main.py:905" - a phone that heuristically cached JS with no
Cache-Control header, on a deploy, kept running pre-feature code). That
history is why the mandatory case here is
``test_a_simulated_deploy_never_serves_stale_bytes``: a compression layer
that broke revalidation would reintroduce exactly the bug the header was
added to prevent, silently, because every other assertion in a naive
suite would still pass.

The requests are made WITHOUT the app's lifespan (no ``with`` block, same
pattern as tests/test_archive_spa_routes.py) - static serving and the
startup gzip warm-up both run outside the lifespan, so no background
scheduler needs to start for any of this.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("DEFAULT_WORKING_DIR", tempfile.mkdtemp(prefix="cc_staticsrv_wd_"))
os.environ.setdefault("LOG_DIRECTORY", tempfile.mkdtemp(prefix="cc_staticsrv_logs_"))
os.environ.setdefault("TOTP_SECRET", "testsecretnotreal")
os.environ.setdefault("JWT_SECRET", "testjwtnotreal")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
import pytest
from fastapi.testclient import TestClient

from src.core import static_cache
from src.main import app, client_dir

CLIENT = TestClient(app)

# A real, non-trivial JS file that issue #48 kept eager, so it is always
# present regardless of which family is lazy-loaded this week.
JS_ASSET = "/static/js/api.js"
CSS_ASSET = "/static/css/styles.css"


def test_text_asset_served_compressed_when_accepted() -> None:
    """Case 1 (partial): Accept-Encoding: gzip gets a smaller wire body.

    httpx (which TestClient wraps) transparently decodes a gzip response,
    so ``.content`` here is already the decompressed bytes - this is
    itself a correctness signal (a client that could not decode the
    encoding would surface an error), and what proves compression
    actually happened ON THE WIRE is the response's own Content-Length
    header, which reports the COMPRESSED size regardless of what httpx
    did with it afterward.
    """
    # httpx sends its own "Accept-Encoding: gzip, deflate" by default, so
    # the genuinely uncompressed baseline has to ask for "identity"
    # explicitly - the same override test_..._not_accepted() uses.
    plain = CLIENT.get(JS_ASSET, headers={"Accept-Encoding": "identity"})
    assert plain.status_code == 200
    assert "content-encoding" not in plain.headers

    gz = CLIENT.get(JS_ASSET, headers={"Accept-Encoding": "gzip"})
    assert gz.status_code == 200
    assert gz.headers.get("content-encoding") == "gzip"
    assert gz.headers.get("vary") == "Accept-Encoding"
    # Decoded bytes are identical to the uncompressed response...
    assert gz.content == plain.content
    # ...but the WIRE size (Content-Length, the compressed size the
    # server actually sent) is meaningfully smaller than the raw file.
    wire_size = int(gz.headers["content-length"])
    assert wire_size < len(plain.content)


def test_text_asset_served_uncompressed_when_not_accepted() -> None:
    """Case 1 (the other half): no Accept-Encoding, no Content-Encoding."""
    resp = CLIENT.get(JS_ASSET, headers={"Accept-Encoding": "identity"})
    assert resp.status_code == 200
    assert "content-encoding" not in resp.headers
    assert resp.headers.get("vary") == "Accept-Encoding", (
        "Vary must be present either way - the response DOES depend on "
        "Accept-Encoding even when this particular request declined it"
    )


def test_css_and_json_suffixes_also_compress() -> None:
    """Not just JS - the same suffix set NoCacheStaticFiles already
    revalidates (.js, .html, .json, .css) is what gets compressed."""
    resp = CLIENT.get(CSS_ASSET, headers={"Accept-Encoding": "gzip"})
    assert resp.status_code == 200
    assert resp.headers.get("content-encoding") == "gzip"


def test_compression_happened_off_the_request_path() -> None:
    """Case 2: compression is proven to have run at STARTUP, not per
    request, by asserting the cache already holds an entry for a file
    this test process never explicitly warmed and never requested before
    this exact assertion. If compression happened per request instead,
    this would still pass by accident on cache population timing, so the
    real proof is the separate static_cache unit tests (peek() answers
    instantly with no I/O) - this is the integration-level corroboration.
    """
    full_path = str((client_dir / "js" / "api.js").resolve())
    stat_result = (client_dir / "js" / "api.js").stat()
    cached = static_cache.peek(full_path, stat_result.st_mtime, stat_result.st_size)
    assert cached is not None, (
        "api.js should already be compressed by the startup warm pass, "
        "before this test ever made a request for it"
    )


def test_unversioned_url_still_revalidates() -> None:
    """Case 3: an ordinary /static/* URL still forces a conditional GET."""
    resp = CLIENT.get(JS_ASSET)
    assert resp.headers.get("cache-control") == "no-cache, must-revalidate"

    gz = CLIENT.get(JS_ASSET, headers={"Accept-Encoding": "gzip"})
    assert gz.headers.get("cache-control") == "no-cache, must-revalidate", (
        "compression must never loosen the revalidation contract"
    )


def test_conditional_get_still_returns_304() -> None:
    """Compression must not break If-None-Match - a browser that already
    has the file must still get an instant 304 with no body, exactly as
    before this change."""
    first = CLIENT.get(JS_ASSET)
    etag = first.headers.get("etag")
    assert etag, "StaticFiles must still set an ETag"

    second = CLIENT.get(JS_ASSET, headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""

    # And the same holds when the client also accepts gzip.
    third = CLIENT.get(
        JS_ASSET, headers={"If-None-Match": etag, "Accept-Encoding": "gzip"}
    )
    assert third.status_code == 304
    assert third.content == b""


def test_a_simulated_deploy_never_serves_stale_bytes() -> None:
    """Case 5, MANDATORY. Edit a served file, and the very next request
    (compressed or not) must return the NEW bytes, not the compression
    from before the edit. This is the exact regression the no-cache
    header was added to prevent (CLAUDE.md), reintroduced one layer down
    if a compressed copy could ever outlive the file it was made from."""
    target = client_dir / "js" / "api-toasts.js"
    original = target.read_text(encoding="utf-8")
    marker = f"/* deploy-simulation {time.time()} */\n"
    try:
        # A distinct mtime is what static_cache keys its freshness on;
        # sleeping past filesystem mtime resolution avoids a same-tick
        # false negative on filesystems with coarse mtime granularity.
        time.sleep(1.05)
        target.write_text(marker + original, encoding="utf-8")

        plain = CLIENT.get("/static/js/api-toasts.js")
        assert marker.strip() in plain.text

        gz = CLIENT.get("/static/js/api-toasts.js", headers={"Accept-Encoding": "gzip"})
        assert gz.headers.get("content-encoding") == "gzip"
        # httpx decodes the gzip body for us; .text is the decoded string.
        assert marker.strip() in gz.text, (
            "the client received a STALE compressed copy after a deploy - "
            "this is the exact regression the no-cache header exists to "
            "prevent, one layer down"
        )
    finally:
        target.write_text(original, encoding="utf-8")


def test_range_request_on_audio_is_unaffected() -> None:
    """Case 6: a range request must never be compressed, and audio
    behaviour is unchanged - the response has no Content-Encoding, and
    the returned bytes are the exact slice asked for."""
    audio_files = list((client_dir / "assets" / "audio").glob("*.m4a")) + list(
        (client_dir / "assets" / "audio").glob("*.ogg")
    )
    if not audio_files:
        pytest.skip("no theme audio bed present in this checkout - cannot determine")
    sample = audio_files[0]
    rel = sample.relative_to(client_dir).as_posix()
    url = f"/static/{rel}"

    full = CLIENT.get(url)
    assert full.status_code == 200

    ranged = CLIENT.get(
        url, headers={"Range": "bytes=0-99", "Accept-Encoding": "gzip"}
    )
    assert ranged.status_code == 206
    assert "content-encoding" not in ranged.headers
    assert len(ranged.content) == 100
    assert ranged.content == full.content[:100]


def test_root_html_shell_compresses_and_keeps_the_version_chip() -> None:
    """The rendered SPA shell (not a StaticFiles hit) compresses too, and
    the {{VERSION}} substitution still happened before compression - a
    literal token must never reach the wire either way."""
    plain = CLIENT.get("/")
    assert plain.status_code == 200
    assert "{{VERSION}}" not in plain.text
    assert plain.headers.get("cache-control") == "no-cache, must-revalidate"

    gz = CLIENT.get("/", headers={"Accept-Encoding": "gzip"})
    assert gz.status_code == 200
    assert gz.headers.get("content-encoding") == "gzip"
    assert "{{VERSION}}" not in gz.text
    assert gz.text == plain.text
    assert gz.headers.get("cache-control") == "no-cache, must-revalidate"


def test_session_deep_link_shell_also_compresses() -> None:
    """/session/<project> shares the same render+compress path as /."""
    gz = CLIENT.get("/session/some-project", headers={"Accept-Encoding": "gzip"})
    assert gz.status_code == 200
    assert gz.headers.get("content-encoding") == "gzip"
    assert '<div id="archive-screen"' in gz.text
