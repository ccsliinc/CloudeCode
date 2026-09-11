"""The pure gzip cache behind issue #49 - no FastAPI, no HTTP.

WHAT THIS FILE IS DEFENDING AGAINST. src/core/static_cache.py is the one
place that decides "is this compression still fresh" for both the static
file mount and the rendered index.html shell. Its correctness rests on a
single claim: an unchanged (mtime, size) fingerprint means the cached
bytes are still right, and a changed one means they are not. Both halves
of that claim are asserted here directly, without going through a real
HTTP request (see tests/test_static_serving.py for the integration
level).
"""

from __future__ import annotations

import gzip
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ruff: noqa: E402
import importlib

from src.core import static_cache


def _fresh_module():
    """Reload static_cache so each test starts with an empty cache dict,
    since the module holds process-global state."""
    return importlib.reload(static_cache)


def test_peek_misses_on_an_entry_never_compressed() -> None:
    sc = _fresh_module()
    assert sc.peek("nothing-here", 1.0, 10) is None


def test_compress_and_cache_then_peek_hits() -> None:
    sc = _fresh_module()
    raw = b"hello world" * 100
    compressed = sc.compress_and_cache("key-a", 1000.0, len(raw), lambda: raw)
    assert gzip.decompress(compressed) == raw

    hit = sc.peek("key-a", 1000.0, len(raw))
    assert hit == compressed


def test_peek_misses_when_mtime_changed() -> None:
    sc = _fresh_module()
    raw = b"version one"
    sc.compress_and_cache("key-b", 1000.0, len(raw), lambda: raw)
    # Same size, different mtime - the file was touched even if its
    # content happens to be the same length.
    assert sc.peek("key-b", 2000.0, len(raw)) is None


def test_peek_misses_when_size_changed() -> None:
    sc = _fresh_module()
    raw = b"short"
    sc.compress_and_cache("key-c", 1000.0, len(raw), lambda: raw)
    assert sc.peek("key-c", 1000.0, len(raw) + 1) is None


def test_a_changed_file_recompresses_to_the_new_content() -> None:
    """The exact shape of "a simulated deploy must not serve stale
    bytes" (tests/test_static_serving.py's HTTP-level version of this),
    proven here at the cache layer directly."""
    sc = _fresh_module()
    old = b"the old content"
    new = b"the NEW content, deployed"

    first = sc.gzip_cached("key-d", 1.0, len(old), lambda: old)
    assert gzip.decompress(first) == old

    # A stale fingerprint is honoured (still old) until the fingerprint
    # actually changes...
    assert gzip.decompress(sc.gzip_cached("key-d", 1.0, len(old), lambda: old)) == old

    # ...and once mtime/size say the file changed, the SAME key
    # recompresses to the NEW bytes, never replaying the old cache entry.
    second = sc.gzip_cached("key-d", 2.0, len(new), lambda: new)
    assert gzip.decompress(second) == new


def test_get_raw_bytes_is_never_called_on_a_hit() -> None:
    """peek() must do zero I/O and zero compression on a hit - that is
    the entire "off the request path" claim for steady state."""
    sc = _fresh_module()
    raw = b"cached content"
    sc.compress_and_cache("key-e", 1.0, len(raw), lambda: raw)

    def _boom():
        raise AssertionError("get_raw_bytes must not be called on a cache hit")

    # peek() takes no getter at all - if it needed one, this test's
    # signature would already be wrong. This asserts the STRONGER claim:
    # even gzip_cached()'s convenience wrapper never invokes the getter
    # when peek() already has an answer.
    result = sc.gzip_cached("key-e", 1.0, len(raw), _boom)
    assert gzip.decompress(result) == raw


def test_warm_populates_every_entry_up_front() -> None:
    sc = _fresh_module()
    entries = [
        ("k1", 1.0, 3, lambda: b"abc"),
        ("k2", 1.0, 3, lambda: b"xyz"),
    ]
    count = sc.warm(entries)
    assert count == 2
    assert sc.peek("k1", 1.0, 3) is not None
    assert sc.peek("k2", 1.0, 3) is not None
    assert gzip.decompress(sc.peek("k1", 1.0, 3)) == b"abc"
    assert gzip.decompress(sc.peek("k2", 1.0, 3)) == b"xyz"


def test_cache_size_reflects_distinct_keys() -> None:
    sc = _fresh_module()
    assert sc.cache_size() == 0
    sc.compress_and_cache("only-key", 1.0, 1, lambda: b"a")
    assert sc.cache_size() == 1
    # Recompressing the SAME key on a fingerprint change replaces the
    # entry rather than adding a second one.
    sc.compress_and_cache("only-key", 2.0, 1, lambda: b"b")
    assert sc.cache_size() == 1
