"""Content-keyed static URLs and the cache headers they license.

WHAT THIS FILE HAS TO PROVE, AND WHY EACH LEG EXISTS. The subject is a
CACHE PROMISE, and the failure mode of a cache promise is not an
exception - it is a browser that stops asking and keeps painting last
week's code, for a year, with nothing in any log. So every positive
assertion here is paired with a NEGATIVE CONTROL that plants exactly the
thing the check exists to catch and watches it be refused. A file that
only ever drove the keyed path would pass unchanged against a server
that answered ``immutable`` to everything, which is the one outcome that
must never ship.

See src/core/static_asset_keys.py for the rules being tested.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.core import static_asset_keys as keys

CLIENT_DIR = Path(__file__).resolve().parent.parent / "client"


@pytest.fixture(autouse=True)
def _cold_module() -> None:
    """Every test starts from a cold memo, so none inherits another's."""
    keys.reset_for_tests()
    yield
    keys.reset_for_tests()


@pytest.fixture()
def tree(tmp_path: Path) -> Path:
    """A miniature client tree.

    Returns:
        Path: the directory that stands in for ``client/``.
    """
    (tmp_path / "js").mkdir()
    (tmp_path / "css").mkdir()
    (tmp_path / "js" / "a.js").write_text("window.A = 1\n")
    (tmp_path / "css" / "one.css").write_text("body{color:red}\n")
    (tmp_path / "logo.png").write_bytes(b"\x89PNG\r\n")
    return tmp_path


# ---------------------------------------------------------------------------
# The key
# ---------------------------------------------------------------------------


def test_the_key_is_derived_from_content_not_from_the_name(tree: Path) -> None:
    """Two files key identically when their bytes match and differently
    when they do not - which is what makes the URL name the content."""
    twin = tree / "js" / "twin.js"
    twin.write_text("window.A = 1\n")
    assert keys.content_key(tree / "js" / "a.js") == keys.content_key(twin)
    twin.write_text("window.A = 99\n")
    keys.reset_for_tests()
    assert keys.content_key(tree / "js" / "a.js") != keys.content_key(twin)


def test_an_edited_file_gets_a_new_key_with_no_restart(tree: Path) -> None:
    """The memo is keyed on (size, mtime_ns), so an edit invalidates it
    in-process. This is what lets ``client/`` keep having no build step."""
    path = tree / "js" / "a.js"
    before = keys.content_key(path)
    path.write_text("window.A = 1 // edited\n")
    after = keys.content_key(path)
    assert before is not None and after is not None and before != after


def test_a_file_that_cannot_be_read_has_no_key(tree: Path) -> None:
    """A stat that did not happen is not a key of nothing. A missing file
    must degrade to None so callers revalidate rather than invent a
    promise."""
    assert keys.content_key(tree / "js" / "nope.js") is None
    assert keys.key_is_current(tree / "js" / "nope.js", "abc") is False


def test_key_is_current_refuses_a_stale_or_empty_key(tree: Path) -> None:
    """NEGATIVE CONTROL for the whole immutable path: only the exact
    current key may match."""
    path = tree / "js" / "a.js"
    current = keys.content_key(path)
    assert keys.key_is_current(path, current) is True
    assert keys.key_is_current(path, "") is False
    assert keys.key_is_current(path, "deadbeefcafe") is False
    path.write_text("window.A = 3\n")
    assert keys.key_is_current(path, current) is False


def test_cache_control_for_is_immutable_only_on_a_match(tree: Path) -> None:
    """The decision itself, exercised directly, including every way of
    failing to determine an answer."""
    path = tree / "js" / "a.js"
    assert keys.cache_control_for(path, keys.content_key(path)) == keys.IMMUTABLE
    assert keys.cache_control_for(path, "deadbeefcafe") == keys.REVALIDATE
    assert keys.cache_control_for(path, "") == keys.REVALIDATE
    assert keys.cache_control_for(None, "deadbeefcafe") == keys.REVALIDATE
    assert keys.cache_control_for(tree / "gone.js", "deadbeefcafe") == keys.REVALIDATE


# ---------------------------------------------------------------------------
# The rewrite
# ---------------------------------------------------------------------------


def test_only_same_origin_static_urls_are_touched(tree: Path) -> None:
    """A data: URI, an absolute URL, a protocol-relative one and a
    non-/static path must all come through byte-identical."""
    html = (
        '<link rel="icon" href="data:image/png;base64,AAAA">\n'
        '<script src="https://cdn.example/x.js"></script>\n'
        '<script src="//cdn.example/y.js"></script>\n'
        '<link rel="manifest" href="/manifest.webmanifest">\n'
        '<script src="/static/js/a.js"></script>\n'
    )
    out = keys.render(html, tree)
    assert "data:image/png;base64,AAAA" in out
    assert 'src="https://cdn.example/x.js"' in out
    assert 'src="//cdn.example/y.js"' in out
    assert 'href="/manifest.webmanifest"' in out
    assert re.search(r'src="/static/js/a\.js\?v=[0-9a-f]{12}"', out)


def test_a_url_that_already_carries_a_query_is_left_alone(tree: Path) -> None:
    """This module did not write that query and must not disturb it."""
    html = '<script src="/static/js/a.js?debug=1"></script>'
    assert keys.render(html, tree) == html


def test_an_anchor_href_is_never_keyed(tree: Path) -> None:
    """An <a href> is a NAVIGATION, not a subresource: nothing is fetched,
    so keying it would only corrupt a URL somebody might copy out of the
    page. A <link href> beside it must still be keyed, or this exemption
    would be a hole rather than a distinction."""
    html = (
        '<a href="/static/js/a.js">download</a>\n'
        '<link rel="stylesheet" href="/static/css/one.css">\n'
    )
    out = keys.render(html, tree)
    assert '<a href="/static/js/a.js">' in out
    assert re.search(
        r'<link rel="stylesheet" href="/static/css/one\.css\?v=[0-9a-f]{12}">', out
    )


@pytest.mark.parametrize(
    "tag",
    [
        '<script type="module" src="{u}"></script>',
        '<script defer src="{u}"></script>',
        '<script async src="{u}"></script>',
        '<img src="{u}" alt="">',
        '<source src="{u}">',
        "<video src='{u}'></video>",
    ],
)
def test_the_rewrite_does_not_care_what_kind_of_tag_it_is(tree: Path, tag: str) -> None:
    """FRONTEND-AGNOSTIC IS THE POINT, not a nicety: the shell this ships
    against is being rewritten from scratch, so nothing here may depend on
    which tags a page happens to use or how many.

    Args:
        tag: a tag template with a ``{u}`` placeholder for the URL.
    """
    out = keys.render(tag.format(u="/static/logo.png"), tree)
    assert re.search(r"/static/logo\.png\?v=[0-9a-f]{12}", out), out


def test_one_tag_and_two_hundred_tags_get_the_same_treatment(tree: Path) -> None:
    """A page that loads a single bundle must be keyed exactly as a page
    that loads two hundred files, or this module would hold an opinion
    about a frontend it is not allowed to hold."""
    one = keys.render('<script src="/static/js/a.js"></script>', tree)
    many = keys.render('<script src="/static/js/a.js"></script>\n' * 200, tree)
    assert many.count("?v=") == 200
    assert many.splitlines()[0] == one


def test_url_to_path_refuses_an_escape(tree: Path) -> None:
    """Containment is component-wise after resolve(), never a string
    prefix - CLAUDE.md's /Users/jsugamelevil rule. Asked twice, because
    the resolution is memoised and a refusal must stay a refusal."""
    assert keys.url_to_path("/static/../../etc/passwd", tree) is None
    assert keys.url_to_path("/static/../../etc/passwd", tree) is None
    assert keys.url_to_path("/etc/passwd", tree) is None
    assert keys.url_to_path("/static/js/a.js", tree) == (tree / "js" / "a.js").resolve()


def test_an_unresolvable_url_is_passed_through_rather_than_dropped(tree: Path) -> None:
    """A URL this module cannot key must still load. Silently removing it
    would turn a caching optimisation into a missing script."""
    html = '<script src="/static/js/gone.js"></script>'
    assert keys.render(html, tree) == html


def test_the_rewrite_is_stable_for_an_unchanged_tree(tree: Path) -> None:
    """Two renders with nothing touched must be identical, or every
    reload would invalidate every client's cache."""
    html = '<script src="/static/js/a.js"></script>'
    assert keys.render(html, tree) == keys.render(html, tree)


# ---------------------------------------------------------------------------
# The real shell, and the real serving path
# ---------------------------------------------------------------------------


def test_the_real_shell_keys_every_static_url_it_references() -> None:
    """Against client/index.html itself: after the rewrite there must be
    no same-origin /static subresource URL left without a key."""
    html = (CLIENT_DIR / "index.html").read_text(encoding="utf-8")
    out = keys.render(html, CLIENT_DIR)
    unkeyed = [u for u in keys.iter_static_urls(out) if "?v=" not in u]
    assert unkeyed == [], f"unkeyed static URLs survived the rewrite: {unkeyed}"


def test_the_real_shell_still_loads_exactly_the_same_assets() -> None:
    """THE REWRITE MUST NOT ADD, DROP OR REORDER A SINGLE SUBRESOURCE.
    Compared with the query stripped, so the only permitted difference is
    the key itself."""
    html = (CLIENT_DIR / "index.html").read_text(encoding="utf-8")
    before = list(keys.iter_static_urls(html))
    after = [
        u.split("?", 1)[0]
        for u in keys.iter_static_urls(keys.render(html, CLIENT_DIR))
    ]
    assert before == after
    assert len(before) > 100, "the shell should reference many assets; did the scan break?"


def _client() -> TestClient:
    """A TestClient over just the static mount.

    Returns:
        TestClient: enough of the app to exercise the caching decision
        without booting the whole server (which needs a config.json, a
        state dir and a database this test has no business touching).
    """
    from src.main import NoCacheStaticFiles

    app = FastAPI()
    app.mount("/static", NoCacheStaticFiles(directory=str(CLIENT_DIR)), name="static")
    return TestClient(app)


def test_a_matching_key_is_immutable_and_anything_else_revalidates() -> None:
    """The core promise, and its negative control in the same test: the
    SAME url with a stale key, and with no key at all, must both come back
    revalidating."""
    url = "/static/js/app.js"
    key = keys.content_key(CLIENT_DIR / "js" / "app.js")
    with _client() as client:
        keyed = client.get(f"{url}?v={key}")
        stale = client.get(f"{url}?v=000000000000")
        bare = client.get(url)
    assert keyed.status_code == 200
    assert keyed.headers["cache-control"] == keys.IMMUTABLE
    assert stale.headers["cache-control"] == keys.REVALIDATE
    assert bare.headers["cache-control"] == keys.REVALIDATE


def test_a_conditional_request_for_a_keyed_url_is_still_immutable() -> None:
    """A 304 must carry the header too, or the browser goes on asking and
    the whole change buys nothing."""
    url = "/static/css/styles.css"
    key = keys.content_key(CLIENT_DIR / "css" / "styles.css")
    with _client() as client:
        first = client.get(f"{url}?v={key}")
        second = client.get(
            f"{url}?v={key}", headers={"If-None-Match": first.headers["etag"]}
        )
    assert second.status_code == 304
    assert second.headers["cache-control"] == keys.IMMUTABLE


def test_a_keyed_css_response_is_still_served_and_still_compressible() -> None:
    """The key rides in the QUERY, so it must not disturb the file lookup,
    the media type or issue #49's precompression."""
    key = keys.content_key(CLIENT_DIR / "css" / "styles.css")
    with _client() as client:
        response = client.get(
            f"/static/css/styles.css?v={key}", headers={"Accept-Encoding": "gzip"}
        )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/css")
    assert response.headers.get("content-encoding") == "gzip"
    assert response.headers["cache-control"] == keys.IMMUTABLE


def test_the_shell_itself_is_never_immutable() -> None:
    """index.html is the ONE document whose URL cannot be content-keyed,
    because it is what hands out every other key. It must revalidate even
    when somebody appends a key by hand."""
    with _client() as client:
        response = client.get("/static/index.html?v=deadbeefcafe")
    assert response.headers["cache-control"] == keys.REVALIDATE


def test_an_image_is_left_on_the_browser_default() -> None:
    """NoCacheStaticFiles only ever governed .js/.css/.html/.json, and this
    change did not widen that. An image carrying a key gets no
    Cache-Control from us - stated here so a later reader knows it is a
    decision and not an oversight."""
    with _client() as client:
        response = client.get("/static/assets/icons/icon-192.png?v=deadbeefcafe")
    assert response.status_code == 200
    assert response.headers.get("cache-control") is None


def test_the_shell_fingerprint_tracks_the_rendered_bytes() -> None:
    """The gzip cache keys on this. Keying it on index.html's own stat
    would serve a gzip of the PREVIOUS shell after any asset edit, pointing
    every browser at keys that no longer exist."""
    assert keys.shell_fingerprint("a") == keys.shell_fingerprint("a")
    assert keys.shell_fingerprint("a") != keys.shell_fingerprint("b")


def test_warm_hashes_the_real_shells_assets() -> None:
    """Boot must leave nothing for the first request to hash."""
    keys.reset_for_tests()
    assert keys.warm(CLIENT_DIR, CLIENT_DIR / "index.html") > 100


def test_warm_survives_a_missing_shell(tmp_path: Path) -> None:
    """It is an optimisation, so it may cost itself and never the boot."""
    assert keys.warm(tmp_path, tmp_path / "nope.html") == 0
