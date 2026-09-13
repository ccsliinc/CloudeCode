"""Content-keyed static URLs, so a warm cache stops asking.

WHAT PROBLEM THIS SOLVES, MEASURED IN CHROMIUM 2026-09-13.
``NoCacheStaticFiles`` stamped ``no-cache, must-revalidate`` on every
``.js`` and ``.css`` the app serves. ``no-cache`` does not forbid
caching - it forbids REUSE WITHOUT ASKING - so a page whose every byte
was already on the machine still made **218 conditional GETs** and got
**218 empty 304s** back, 65,400 bytes of pure header traffic through a
browser's six-connection HTTP/1.1 cap. A 304 is cheap in bytes and
expensive in round trips, which is the whole defect.

THE FIX IS A CONTENT KEY IN THE QUERY. The rendered HTML shell is
rewritten at serve time so every same-origin ``/static/...`` subresource
URL carries ``?v=<key>``, where the key is a short sha256 prefix of that
file's own BYTES. ``NoCacheStaticFiles`` then answers
``public, max-age=31536000, immutable`` for a request whose key still
matches, so the browser reuses it with no request at all.

**EVERYTHING ELSE KEEPS TODAY'S BEHAVIOUR, AND THAT ASYMMETRY IS THE
WHOLE SAFETY ARGUMENT.** No key at all - a runtime ``fetch``, a script
the client injects for itself, a theme's CSS, a theme's ``effects.js``
via ``import()`` - revalidates exactly as it does now. So does a key that
NO LONGER MATCHES, which is the case that matters: a bookmarked URL from
an older build is told to revalidate rather than being handed a
year-long promise about content that has already changed. An immutable
answer is given only where the URL itself names the bytes, so the promise
is true by construction and there is nothing to retract from the field.
The HTML document is never immutable either, because it is what hands out
every other key.

That also means the ghost-bundle failure ``NoCacheStaticFiles`` was
originally written for cannot come back: a phone holding an old key ASKS,
and is given the new bytes.

**IT IS FRONTEND-AGNOSTIC ON PURPOSE, AND THAT IS LOAD BEARING RATHER
THAN TIDY.** The current shell hand-loads about two hundred tags and is
being replaced from scratch. Nothing here knows that. The rewrite is a
pass over ``src`` attributes and ``<link href>`` attributes pointing
under ``/static/``: it does not care which tags carry them, how many
there are, what order they are in, or whether they are classic scripts,
modules, stylesheets, images, fonts or media. A page that loads one
bundle gets the same treatment as one that loads two hundred files, and a
rewritten frontend needs no change here at all. The only thing such a
frontend must keep doing is referencing its assets from HTML the server
renders.

**NO BUILD STEP, AND NOTHING COMMITTED.** A key is derived from the file
on disk and memoised on its ``(size, mtime_ns)``, so editing a file and
reloading serves it under a new URL with no restart and no artifact to go
stale - the same discipline ``src/core/static_cache.py`` already uses, for
the same reason: ``client/`` has no build step and must not acquire one.

**THE COST OF THE REWRITE ITSELF WAS PROFILED, NOT ASSUMED**, because it
runs inside the ``/`` handler and this codebase has paid for synchronous
work in a request handler more than once (the integrity pragma, the
config-tree walk). See ``url_to_path`` for the memo, and ``warm`` for why
the first request of a process does not pay the cold pass either.
"""

from __future__ import annotations

import hashlib
import re
import threading
from pathlib import Path
from typing import Iterable, Optional

#: Hex characters of sha256 kept in a URL key. 12 hex chars is 48 bits;
#: the only collision that could matter is between two versions OF THE
#: SAME FILE, which is far below any rate worth engineering against.
#: Short enough that a few hundred of them do not measurably grow a page.
KEY_LENGTH = 12

#: The URL prefix the static mount is served under.
STATIC_PREFIX = "/static/"

#: Cache-Control for a request whose key names the bytes being served.
#: One year is the maximum RFC 9111 asks anyone to honour; ``immutable``
#: (RFC 8246) is what additionally stops a plain reload revalidating.
IMMUTABLE = "public, max-age=31536000, immutable"

#: Cache-Control for everything else. Unchanged from what this app has
#: always sent, and deliberately so.
REVALIDATE = "no-cache, must-revalidate"

#: Any element carrying ``src``, plus ``<link href>``. ``href`` is taken
#: only from ``<link>`` because on an ``<a>`` it is a NAVIGATION rather
#: than a subresource: keying it would change a URL a person might copy
#: out of the page, and would buy nothing, since nothing is fetched.
_SRC_TAG = re.compile(r"""<[a-zA-Z][^>]*\bsrc\s*=\s*["'](/static/[^"']*)["']""")
_LINK_TAG = re.compile(
    r"""<link\b[^>]*\bhref\s*=\s*["'](/static/[^"']*)["']""", re.IGNORECASE
)

_LOCK = threading.Lock()

#: path -> (size, mtime_ns, key). A key is rehashed only when the file's
#: stat moves, so steady state is one ``os.stat`` per asset per render and
#: no hashing at all.
_KEY_CACHE: dict[str, tuple[int, int, str]] = {}

#: (url, client_dir) -> resolved path, or None for a refusal. See
#: ``url_to_path`` for the profile that justifies it.
_PATH_CACHE: dict[tuple[str, str], Optional[Path]] = {}


def content_key(path: Path) -> Optional[str]:
    """Return the content key for a file, hashing only when its stat moved.

    Args:
        path: absolute filesystem path of the asset.

    Returns:
        A ``KEY_LENGTH``-character lowercase hex string, or None when the
        file cannot be read. A stat that did not happen is NOT a stat of
        nothing, so None means "cannot determine" and every caller falls
        back to revalidation rather than inventing a key.

    Example:
        >>> content_key(Path("client/js/app.js"))  # doctest: +SKIP
        '3f9c1a0b7d21'
    """
    try:
        stat_result = path.stat()
    except OSError:
        return None
    stamp = (stat_result.st_size, stat_result.st_mtime_ns)
    cache_id = str(path)
    with _LOCK:
        cached = _KEY_CACHE.get(cache_id)
        if cached is not None and (cached[0], cached[1]) == stamp:
            return cached[2]
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:KEY_LENGTH]
    except OSError:
        return None
    with _LOCK:
        _KEY_CACHE[cache_id] = (stamp[0], stamp[1], digest)
    return digest


def key_is_current(path: Path, key: str) -> bool:
    """Is ``key`` the content key this file hashes to right now?

    This is the entire basis of the immutable promise. A stale key means
    the client holds a URL from an older build, so it gets revalidation
    and not a year-long claim about content that has already changed.

    Args:
        path: absolute filesystem path of the asset.
        key: the ``v=`` value the request carried.

    Returns:
        True only when the file could be read AND its current key matches.
    """
    if not key:
        return False
    return content_key(path) == key


def cache_control_for(path: Optional[Path], requested_key: str) -> str:
    """Decide the Cache-Control header for one static hit.

    Args:
        path: the file being served, or None when the URL could not be
            resolved to one inside the static root.
        requested_key: the ``v=`` query value, ``""`` when absent.

    Returns:
        ``IMMUTABLE`` only for a resolvable file whose current content key
        equals ``requested_key``; ``REVALIDATE`` for everything else,
        every failure to determine included.

    Example:
        >>> cache_control_for(Path("client/js/app.js"), "wrongkey")
        'no-cache, must-revalidate'
    """
    if path is None or not key_is_current(path, requested_key):
        return REVALIDATE
    return IMMUTABLE


def url_to_path(url: str, client_dir: Path) -> Optional[Path]:
    """Map a ``/static/...`` URL to its file, refusing anything outside.

    Args:
        url: URL path, query already stripped.
        client_dir: filesystem root the ``/static/`` prefix maps to.

    Returns:
        Path, or None when the URL is not under ``/static/`` or resolves
        outside ``client_dir``. Containment is checked component-wise
        after ``resolve()``, never with a string prefix, for the reason
        CLAUDE.md records: ``/Users/jsugamelevil`` is not inside
        ``/Users/jsugamele``.

    The resolution is memoised per ``(url, client_dir)``. Measured on this
    tree: a warm render costs **16.66 ms without this memo and 1.38 ms
    with it**, because ``resolve()`` is a ``realpath`` syscall walk and
    this runs for every one of the 214 URLs on the page. That cost would
    land on the event loop inside the ``/`` handler, which is the defect
    class CLAUDE.md records for the integrity pragma and the config-tree
    walk. The
    memo is safe because the MAPPING is a property of the tree layout
    rather than of file contents, and a symlink swapped underneath it
    would need an attacker who can already write into ``client/`` - who
    could simply edit the JavaScript instead. Refusals are memoised too,
    so a probe cannot be made expensive by repeating it.
    """
    if not url.startswith(STATIC_PREFIX):
        return None
    cache_id = (url, str(client_dir))
    with _LOCK:
        if cache_id in _PATH_CACHE:
            return _PATH_CACHE[cache_id]
    candidate = (client_dir / url[len(STATIC_PREFIX):]).resolve()
    try:
        candidate.relative_to(client_dir.resolve())
    except ValueError:
        candidate = None
    with _LOCK:
        _PATH_CACHE[cache_id] = candidate
    return candidate


def render(html: str, client_dir: Path) -> str:
    """Rewrite a document so every same-origin static URL carries its key.

    This is the ONE entry point ``src/main.py`` calls.

    Args:
        html: the document to rewrite, already rendered.
        client_dir: filesystem root the ``/static/`` prefix maps to.

    Returns:
        str: the same document with ``?v=<key>`` appended to each
        ``/static/`` ``src`` and each ``<link href>``. A URL is left
        exactly as written when it already carries a query (this module
        did not put it there and must not disturb it), when it resolves
        outside the static root, or when the file cannot be read.
        ``data:``, absolute and protocol-relative URLs are not matched at
        all, and nothing else in the document moves.

    Example:
        >>> render('<script src="/static/js/app.js"></script>', Path("client"))
        '<script src="/static/js/app.js?v=3f9c1a0b7d21"></script>'
    """
    def rewrite(match: "re.Match[str]") -> str:
        """Key one matched tag, or hand it back untouched.

        Args:
            match: a ``_SRC_TAG`` or ``_LINK_TAG`` match, group 1 the URL.

        Returns:
            str: the tag with ``?v=<key>`` on its URL, or the original
            text whenever a key cannot be determined - which is the
            fail-soft direction, since an unkeyed URL still loads and
            still revalidates.
        """
        url = match.group(1)
        if "?" in url:
            return match.group(0)
        path = url_to_path(url, client_dir)
        if path is None:
            return match.group(0)
        key = content_key(path)
        if not key:
            return match.group(0)
        return match.group(0).replace(url, f"{url}?v={key}", 1)

    return _LINK_TAG.sub(rewrite, _SRC_TAG.sub(rewrite, html))


def shell_fingerprint(html: str) -> tuple[float, int]:
    """A ``(mtime, size)``-shaped freshness pair for a rendered document.

    ``src/core/static_cache.py`` keys an entry on a float and an int and
    compares both for equality; it does not care that they came from a
    ``stat``. A rendered shell's freshness is NO LONGER its template's
    stat, because the shell now embeds a content key per asset and so
    changes whenever any referenced file changes while the template's own
    mtime and size do not move at all. This derives the pair from the
    rendered bytes, which is the only thing actually true of them.

    Args:
        html: the fully rewritten document.

    Returns:
        tuple[float, int]: a stable pair for these exact bytes.
    """
    digest = hashlib.sha256(html.encode("utf-8")).digest()
    return (float(int.from_bytes(digest[:6], "big")), len(html))


def iter_static_urls(html: str) -> Iterable[str]:
    """Every same-origin ``/static/`` subresource URL in a document.

    Args:
        html: any HTML document.

    Yields:
        str: the URL as written, query included, in document order.
    """
    found = [(m.start(), m.group(1)) for m in _SRC_TAG.finditer(html)]
    found += [(m.start(), m.group(1)) for m in _LINK_TAG.finditer(html)]
    for _, url in sorted(found):
        yield url


def warm(client_dir: Path, shell: Path) -> int:
    """Hash every asset the shell references, once, at import time.

    A cold pass reads and hashes each referenced file. That is real work
    and it must not land on the first user request, which is the same
    bargain - and the same remedy - as
    ``static_serving.warm_static_gzip_cache`` beside the call site.

    Args:
        client_dir: filesystem root the ``/static/`` prefix maps to.
        shell: the HTML template whose references should be pre-hashed.

    Returns:
        int: how many URLs were keyed, for the startup log line. ``0``
        when the shell could not be read, which is not an error here: it
        costs the optimisation only, the next request re-derives whatever
        it can, and a boot must never fail over a cache warm.
    """
    try:
        html = shell.read_text(encoding="utf-8")
    except OSError:
        return 0
    return sum(1 for url in iter_static_urls(render(html, client_dir)) if "?v=" in url)


def reset_for_tests() -> None:
    """Drop every memo, so a test can measure a cold process.

    There is no production caller: each memo is validated against a stat,
    so nothing in the running app ever needs to clear them.
    """
    with _LOCK:
        _KEY_CACHE.clear()
        _PATH_CACHE.clear()
