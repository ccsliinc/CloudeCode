"""HTTP request timing, as a pure ASGI middleware.

Uvicorn's own access log line carries no timestamp and no duration, so
answering "how long did this request take" after the fact meant carrying
forward the nearest unrelated structlog timestamp and guessing. This module
emits exactly one structlog event per HTTP request, `http_request`, carrying
the method, the path (never the query string - see `_client_ip` and the
docstring on `RequestLogMiddleware` below for why headers and query strings
are excluded on purpose), the status code, the caller's address, and how
long the whole request took.

Deliberately NOT `starlette.middleware.base.BaseHTTPMiddleware`: that class
consumes the wrapped app's response through Starlette's own `Response`
machinery and reconstructs a new one to send, which buffers a streaming
body in full before any of it reaches the client and does not participate
in a `scope["type"] == "websocket"` connection at all. Either behavior would
break the terminal's byte-streamed PTY socket or `/ws/events`. A pure ASGI
middleware that only wraps `send` on an `http` scope, and passes every other
scope straight through untouched, has neither problem.
"""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable, MutableMapping, Optional

import structlog

logger = structlog.get_logger()

# Suffixes and prefixes that log at DEBUG rather than INFO. A single page
# load of this app pulls roughly 220 bundled assets; logging every one of
# them at INFO would drown every other line in the log for no diagnostic
# value, which is exactly the failure mode `docs/debugging.md` already
# describes for `LOG_LEVEL=DEBUG` as a blunt global.
_STATIC_PREFIXES = ("/static/",)
_STATIC_SUFFIXES = (".js", ".css", ".map", ".png", ".woff2")

ASGIApp = Callable[[MutableMapping[str, Any], Callable, Callable], Awaitable[None]]


def _is_static_asset(path: str) -> bool:
    """Decide whether `path` is a bundled asset that logs at DEBUG.

    Input: `path`, the ASGI scope's `path` (never carries a query string -
    that lives in the separate `scope["query_string"]` key, which this
    module never reads).
    Output: `True` for a `/static/` path, or one ending in a bundled-asset
    suffix; `False` otherwise.
    """
    return path.startswith(_STATIC_PREFIXES) or path.endswith(_STATIC_SUFFIXES)


def _client_ip(scope: MutableMapping[str, Any]) -> Optional[str]:
    """Read the caller's address straight off the ASGI transport.

    Input: `scope`, an ASGI HTTP scope.
    Output: the client's IP as a string, or `None` when the transport
    reported none (a unix socket, or some test harnesses).

    Reads `scope["client"]` ONLY. An `X-Forwarded-For` or similar header is
    supplied by the caller and unverified at this layer; honouring it here
    would let any client claim to be any IP in this log.
    """
    client = scope.get("client")
    if not client:
        return None
    return client[0]


class RequestLogMiddleware:
    """Pure ASGI middleware: times one HTTP request, logs it once.

    A `websocket` or `lifespan` scope is passed through to the wrapped app with
    no wrapping of `send` and no observation of its frames, so the terminal
    socket, `/ws/events` and the app's own startup/shutdown are untouched.
    """

    def __init__(self, app: ASGIApp) -> None:
        """`app`: the ASGI application this instance wraps."""
        self.app = app

    async def __call__(
        self,
        scope: MutableMapping[str, Any],
        receive: Callable[[], Awaitable[MutableMapping[str, Any]]],
        send: Callable[[MutableMapping[str, Any]], Awaitable[None]],
    ) -> None:
        """Time and log one HTTP request; pass any other scope straight through.

        Input: the standard ASGI `(scope, receive, send)` triple.
        Output: `None`. Emits `http_request` once the wrapped app returns,
        whether it returned normally or raised, and re-raises any
        exception unchanged - this middleware observes, it never handles.
        """
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "")
        path = scope.get("path", "")
        client_ip = _client_ip(scope)
        status: Optional[int] = None

        async def send_wrapper(message: MutableMapping[str, Any]) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        started = time.perf_counter()
        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            # A raised handler never got to send a response of its own, so
            # there is no real status to report. 500 is what the client
            # actually sees once Starlette's own ServerErrorMiddleware
            # (which wraps OUTSIDE this one) turns the exception into a
            # response.
            self._log(method, path, client_ip, 500, started)
            raise
        else:
            self._log(method, path, client_ip, status, started)

    @staticmethod
    def _log(
        method: str,
        path: str,
        client_ip: Optional[str],
        status: Optional[int],
        started: float,
    ) -> None:
        """Emit the one `http_request` event for a finished request.

        Input: `method`, `path` (no query string, no headers, no cookies -
        never log those, a query string alone can carry a bearer token),
        `client_ip`, `status` (the code sent, or `None` if the app never
        started a response), `started` (the `perf_counter()` reading taken
        before the app ran).
        Output: `None`. Logs at DEBUG for a static asset path
        (`_is_static_asset`), INFO otherwise.
        """
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        level = "debug" if _is_static_asset(path) else "info"
        getattr(logger, level)(
            "http_request",
            method=method,
            path=path,
            status=status,
            client_ip=client_ip,
            duration_ms=duration_ms,
        )
