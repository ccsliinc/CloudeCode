"""HTTP-facing glue for issue #49's precompression.

``src/core/static_cache.py`` is the pure cache (a dict keyed on a
fingerprint, no HTTP types in sight). This module is where that cache
meets FastAPI/Starlette: deciding whether a given static-file response or
a dynamically rendered document should be swapped for its gzip bytes, and
warming the cache once at startup so no request ever pays a cold-compress
cost in steady state. Split out of ``src/main.py``, which is already over
this repo's line-count guideline and must not grow - see CLAUDE.md.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Callable

from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, Response

from src.core import static_cache


async def maybe_gzip_file_response(response: Response, scope: dict) -> Response:
    """Serve a FileResponse's precompressed bytes when the client accepts
    gzip, never for a Range request or a conditional-match 304.

    Description: the compression decision for one static-file response.
      A ``FileResponse`` still carries the file's real stat (mtime, size)
      and path, which is exactly what static_cache needs to decide
      whether its cached compression is still fresh - so this reads those
      off the response object rather than re-`stat`-ing the file itself.
    Inputs: response (Response) - whatever NoCacheStaticFiles.get_response
        already produced (a FileResponse on a fresh 200, or a
        NotModifiedResponse on a 304 - only the former is eligible).
      scope (dict) - the ASGI scope, read for the Range and
        Accept-Encoding request headers.
    Output: Response - either the original response (a Range header on
      the request skips compression entirely; the file could not be
      compressed; or the client did not send Accept-Encoding: gzip) or a
      new Response carrying the precompressed bytes, Content-Encoding and
      a corrected Content-Length.
    Example: response = await maybe_gzip_file_response(response, scope)
    """
    if not isinstance(response, FileResponse) or response.status_code != 200:
        return response
    request_headers = Headers(scope=scope)
    # NEVER compress a range response - the byte offsets a Range header
    # names refer to the UNCOMPRESSED file, and FileResponse.__call__
    # (which runs after this, once this response is returned) decides the
    # 206 split from those offsets. A compressed body would make every
    # offset wrong.
    if "range" in request_headers:
        return response
    response.headers["Vary"] = "Accept-Encoding"
    accept_encoding = request_headers.get("accept-encoding", "")
    if "gzip" not in accept_encoding:
        return response
    stat_result = response.stat_result
    if stat_result is None:
        return response
    full_path = str(response.path)
    compressed = static_cache.peek(full_path, stat_result.st_mtime, stat_result.st_size)
    if compressed is None:
        # A miss is rare in steady state (see static_cache's module
        # docstring) - only the first request for a file, or the first
        # one after a developer edits it. Real file I/O plus gzip is
        # genuine CPU work, so it is offloaded to a thread rather than
        # run inline on the event loop, the same pattern CLAUDE.md
        # documents for the config-file tree walk.
        path_obj = Path(full_path)
        compressed = await asyncio.to_thread(
            static_cache.compress_and_cache,
            full_path,
            stat_result.st_mtime,
            stat_result.st_size,
            path_obj.read_bytes,
        )
    headers = dict(response.headers)
    headers["content-encoding"] = "gzip"
    headers["content-length"] = str(len(compressed))
    return Response(content=compressed, status_code=200, headers=headers,
                     media_type=response.media_type)


def warm_static_gzip_cache(root: Path, suffixes: tuple[str, ...]) -> int:
    """Precompress every static text file under ``root``, once, before the
    app accepts its first request.

    Description: issue #49's "compress ahead of time, not per request" -
      this is the "ahead of time" half, called once at import time in
      src/main.py (like ``APP_VERSION = resolve_version()``), which is
      acceptable ONLY because it happens once, during process startup,
      never on a request.
    Inputs: root (Path) - directory to walk recursively.
      suffixes (tuple[str, ...]) - lowercase filename suffixes eligible
        for compression; anything else (images, audio, fonts) is skipped
        entirely, never even stat'd for this purpose.
    Output: int - number of files compressed, for the startup log line.
    """
    entries = []
    for candidate in root.rglob("*"):
        if not candidate.is_file():
            continue
        if not candidate.name.lower().endswith(suffixes):
            continue
        try:
            stat_result = candidate.stat()
        except OSError:
            continue
        entries.append((
            str(candidate),
            stat_result.st_mtime,
            stat_result.st_size,
            candidate.read_bytes,
        ))
    return static_cache.warm(entries)


def render_compressible_html_response(
    request: Request,
    render: Callable[[], str],
    source_path: Path,
    cache_key: str,
) -> Response:
    """Build an HTML response for a dynamically rendered document,
    precompressed when the client accepts gzip.

    Description: for a document like index.html that is rendered per
      request (a template file plus process-lifetime-fixed state, here
      the version chip) rather than served straight from disk, freshness
      is checked against the TEMPLATE file's own mtime/size - valid
      exactly because the render is a deterministic function of those two
      inputs for the life of one process, so an unchanged template can
      never have produced different rendered bytes since the last
      compression.
    Inputs: request (Request) - read for Accept-Encoding.
      render (Callable[[], str]) - produces the current HTML string;
        called every time regardless of the compression outcome, since
        the caller needs it for the uncompressed fallback anyway and this
        module does not change how often the template itself is read.
      source_path (Path) - the on-disk file whose stat stands in for the
        rendered output's freshness.
      cache_key (str) - stable cache identity for this rendered document.
    Output: Response - HTMLResponse (uncompressed) or a plain Response
      carrying gzip bytes, both with the SAME Cache-Control the caller
      has always sent (no-cache, must-revalidate): compression changes
      the bytes on the wire, never how long they may be kept.
    Example:
      render_compressible_html_response(
          request, _render_index_html, client_dir / "index.html",
          "index.html:rendered")
    """
    html = render()
    headers = {"Cache-Control": "no-cache, must-revalidate", "Vary": "Accept-Encoding"}
    accept_encoding = request.headers.get("accept-encoding", "")
    if "gzip" in accept_encoding:
        try:
            stat_result = source_path.stat()
        except OSError:
            stat_result = None
        if stat_result is not None:
            compressed = static_cache.peek(cache_key, stat_result.st_mtime, stat_result.st_size)
            if compressed is None:
                compressed = static_cache.compress_and_cache(
                    cache_key, stat_result.st_mtime, stat_result.st_size,
                    lambda: html.encode("utf-8"),
                )
            headers["Content-Encoding"] = "gzip"
            headers["Content-Length"] = str(len(compressed))
            return Response(content=compressed, media_type="text/html", headers=headers)
    return HTMLResponse(content=html, headers=headers)
