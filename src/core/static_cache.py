"""Precomputed gzip bytes for static text, kept fresh by a stat comparison
rather than a rebuild step. See issue #49.

WHY A STAT COMPARISON AND NOT "COMPRESS ONCE, NEVER AGAIN". ``client/`` has
no build step (see CLAUDE.md) - a developer edits a JS file on disk and
reloads the browser expecting the new bytes. A cache that compressed once
at import time and never revisited a file would serve stale gzip forever
after that edit, which is a worse bug than the one this module exists to
fix. So every entry remembers the ``(mtime, size)`` of the content it was
built from, and a request whose file no longer matches recompresses
exactly that one file - never the whole tree, never on every request.

WHY THIS IS STILL "OFF THE REQUEST PATH" IN THE SENSE THE ISSUE MEANS.
``warm()`` is called once at process start (see ``src/main.py``) and
populates every known compressible file's entry before the app accepts
its first request, so in STEADY STATE every request finds a fresh entry
and never calls ``gzip.compress()`` at all - it is a dict lookup under a
lock. The mtime check is what makes that safe rather than merely fast: it
is the same class of guard as ``corpus_ingest_scan``'s "skip a file only
when its size, its mtime and the database's hash all agree" (see
CLAUDE.md, "the transcript archive the app maintains").

WHY THE MISS PATH IS SPLIT FROM THE HIT PATH (``peek()`` vs
``compress_and_cache()``), RATHER THAN ONE FUNCTION. The caller in
``src/main.py`` runs inside an async request handler, on the event loop.
Compressing a file up to several hundred KB is real CPU work - the exact
"blocks the loop for everyone" mistake CLAUDE.md documents repeatedly (the
db integrity pragma, the recursive config-tree walk). A cache HIT must
never pay a thread-dispatch cost to answer a dict lookup, so ``peek()`` is
a plain synchronous call safe to make directly from the event loop; a
cache MISS is rare (first request ever, or the one request after an edit)
and is what the caller routes through ``asyncio.to_thread()``, exactly the
pattern CLAUDE.md already prescribes for this class of problem.
"""

from __future__ import annotations

import gzip
import threading
from dataclasses import dataclass
from typing import Callable, Optional

#: gzip compression level. 6 is zlib's own default: a good ratio/CPU
#: balance for text, and consistent with what most web servers ship.
GZIP_LEVEL = 6


@dataclass(frozen=True)
class _Entry:
    """One cached compression, and the fingerprint it was built from.

    Attributes:
        mtime: the source content's modification time when compressed.
        size: the source content's byte length when compressed.
        gzip_bytes: the compressed result.
    """

    mtime: float
    size: int
    gzip_bytes: bytes


_cache: dict[str, _Entry] = {}
_lock = threading.Lock()


def peek(cache_key: str, mtime: float, size: int) -> Optional[bytes]:
    """Description: return the cached compression for ``cache_key`` if its
      fingerprint still matches, without touching the filesystem or the
      compressor. Safe to call directly from an async event loop - it is
      a dict lookup under a lock, nothing else.
    Inputs: cache_key (str) - stable identity for the cached entry (an
        absolute file path, or a fixed literal for a single rendered
        document such as index.html).
      mtime (float), size (int) - the CURRENT content's freshness
        fingerprint, cheap to obtain from an os.stat_result the caller
        already has.
    Output: bytes | None - cached gzip bytes, or None on a miss (entry
      absent, or its fingerprint no longer matches).
    Example: static_cache.peek(str(full_path), st.st_mtime, st.st_size)
    """
    with _lock:
        entry = _cache.get(cache_key)
    if entry is not None and entry.mtime == mtime and entry.size == size:
        return entry.gzip_bytes
    return None


def compress_and_cache(
    cache_key: str, mtime: float, size: int, get_raw_bytes: Callable[[], bytes]
) -> bytes:
    """Description: compress ``get_raw_bytes()``'s output and store it
      under ``cache_key`` with the given fingerprint. This is the
      EXPENSIVE half - real file I/O plus gzip - so a caller running on an
      event loop should reach it through ``asyncio.to_thread()`` rather
      than calling it directly, and should call ``peek()`` first so a hit
      never reaches here at all.
    Inputs: cache_key (str), mtime (float), size (int) - see peek().
      get_raw_bytes (Callable[[], bytes]) - produces the uncompressed
        content; called exactly once, only because this is a miss.
    Output: bytes - the freshly compressed content, also now cached.
    Example:
      static_cache.compress_and_cache(str(full_path), st.st_mtime,
                                       st.st_size, full_path.read_bytes)
    """
    raw = get_raw_bytes()
    compressed = gzip.compress(raw, compresslevel=GZIP_LEVEL)
    with _lock:
        _cache[cache_key] = _Entry(mtime=mtime, size=size, gzip_bytes=compressed)
    return compressed


def gzip_cached(
    cache_key: str, mtime: float, size: int, get_raw_bytes: Callable[[], bytes]
) -> bytes:
    """Description: peek(), falling back to compress_and_cache() on a
      miss. SYNCHRONOUS end to end - only for callers with no event loop
      to protect, i.e. warm() at startup. An async request handler must
      call peek() and compress_and_cache() separately so the (rare) miss
      path can be offloaded to a thread; see the module docstring.
    Inputs: as peek() / compress_and_cache().
    Output: bytes - cached or freshly compressed gzip bytes.
    """
    cached = peek(cache_key, mtime, size)
    if cached is not None:
        return cached
    return compress_and_cache(cache_key, mtime, size, get_raw_bytes)


def warm(entries: list[tuple[str, float, int, Callable[[], bytes]]]) -> int:
    """Description: populate the cache for every given entry up front, so
      steady-state requests never pay a first-miss compression cost.
      Called once at process startup (src/main.py), synchronously - there
      is no event loop yet to protect, and it is the one place this
      module is allowed to do real work inline.
    Inputs: entries (list[tuple]) - each (cache_key, mtime, size,
        get_raw_bytes), the same shapes gzip_cached() takes.
    Output: int - number of entries compressed (a fresh process always
      compresses every entry once; the count is for the startup log line).
    """
    count = 0
    for cache_key, mtime, size, get_raw_bytes in entries:
        gzip_cached(cache_key, mtime, size, get_raw_bytes)
        count += 1
    return count


def cache_size() -> int:
    """Description: how many entries are currently cached. Diagnostic
      only - not load-bearing for any decision.
    Inputs: none. Output: int.
    """
    with _lock:
        return len(_cache)
