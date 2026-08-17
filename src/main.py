"""Main FastAPI application for Cloude Code Controller."""

import os
import json
import mimetypes
import structlog
import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from src.config import settings
from src.core.session_manager import SessionManager
from src.core.log_monitor import LogMonitor
from src.core.local_servers import LocalServersTracker
from src.core.refresh_store import RefreshStore
from src.core.upload_sweeper import UploadSweeper
from src.core.notifications import NotificationRouter
from src.core.notifications import ntfy as ntfy_backend
from src.core.notifications import pushover as pushover_backend
from src.core.notifications import slack as slack_backend
from src.core import claude_hooks
from src.core.version import resolve_version
from src.core.update_check import UpdateChecker
from src.api.version_routes import router as version_router, set_update_checker
from src.api.routes import router as api_router
from src.api.websocket import router as ws_router
from src.api.auth import router as auth_router, limiter as auth_limiter
from src.api.config_files_routes import router as config_files_router
from src.api.status_routes import router as status_router

# Configure structlog
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.JSONRenderer()
    ],
    wrapper_class=structlog.BoundLogger,
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
)

logger = structlog.get_logger()


# Global instances (will be initialized in lifespan)
session_manager: SessionManager = None
log_monitor: LogMonitor = None
local_servers: LocalServersTracker = None
refresh_store: RefreshStore = None
_refresh_purge_task: asyncio.Task = None
notification_router: NotificationRouter = None


# Six-hour cadence for the purge loop. Keep a module-level constant so
# tests can monkeypatch to something fast.
_REFRESH_PURGE_INTERVAL_SECONDS = 6 * 60 * 60


async def _refresh_purge_loop(store: RefreshStore):
    """Background task — sweeps expired refresh tokens every 6 hours."""
    while True:
        try:
            await asyncio.sleep(_REFRESH_PURGE_INTERVAL_SECONDS)
            await store.purge_expired()
        except asyncio.CancelledError:
            # Normal shutdown path — let it propagate.
            raise
        except Exception as e:  # pragma: no cover - defensive
            logger.error("refresh_purge_loop_error", error=str(e))
            # Brief back-off before retrying so we don't hot-loop on a
            # persistent error condition.
            await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    global session_manager, log_monitor, local_servers
    global refresh_store, _refresh_purge_task, notification_router

    logger.info("application_starting", version="1.0.0")

    # feat/launch-wrappers — one-shot, idempotent config.json migration
    # (hardcoded cld/cldor -> user-editable wrappers). MUST run before the
    # first load_auth_config() call below so a freshly-seeded wrapper list
    # is visible immediately. Best-effort / fail-soft, same posture as
    # claude_hooks.ensure_hook_settings() further down: any failure is
    # logged, never raised, and NEVER blocks server boot or touches
    # config.json beyond the migration's own backup + atomic write.
    from src.core.config_migration import ensure_config_migrated
    ensure_config_migrated(Path(settings.auth_config_file).expanduser())

    # Initialize core components
    session_manager = SessionManager()
    # Re-adopt a surviving tmux session (if any) from previous server run.
    # No-op for PTY backend (PTYs die with the parent).
    await session_manager.lifespan_startup()
    log_monitor = LogMonitor(session_manager)

    # Item 6: notification router. Wired AFTER log_monitor (which is the
    # signal source for IdleWatcher in Item 7).
    auth_cfg = settings.load_auth_config()
    notif_cfg = auth_cfg.notifications
    await ntfy_backend.init(notif_cfg.ntfy_base_url, notif_cfg.ntfy_topic)
    # v0.7.0 Part 4 — Slack incoming-webhook channel. Empty URL = silently
    # disabled (slack.init logs once and returns without building a client).
    await slack_backend.init(getattr(notif_cfg, "slack_webhook_url", ""))
    # Pushover channel. Either field empty = silently disabled
    # (pushover.init logs once and returns without building a client).
    await pushover_backend.init(
        getattr(notif_cfg, "pushover_token", ""),
        getattr(notif_cfg, "pushover_user_key", ""),
    )
    notification_router = NotificationRouter(
        notif_cfg, asyncio.get_running_loop()
    )
    await notification_router.start()

    # Item 7: inject the live router into SessionManager so IdleWatcher
    # instances created via create_session have a valid emit target.
    session_manager.attach_notification_router(notification_router)

    # v0.7.0 Part 3 — idempotent-merge cloudecode's Claude Code lifecycle
    # hooks into ~/.claude/settings.json. Best effort: a parse error /
    # write error / disabled-by-config all return without raising, and a
    # try/except guards against any genuinely unexpected throw so server
    # boot is NEVER blocked by hook-settings glitches. The hook block
    # only matters for sessions that spawn ``claude`` AFTER this point
    # (env vars travel through tmux at spawn time), but the merge itself
    # is idempotent and re-running is cheap.
    try:
        claude_hooks.ensure_hook_settings()
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("claude_hooks_ensure_failed", error=str(exc))

    # Plan v3.2 — LocalServersTracker replaces the demolished tunnel
    # subsystem. Hooks into log_monitor pattern callbacks for detection
    # and runs a 30s janitor that retires stopped listeners.
    local_servers = LocalServersTracker(loop=asyncio.get_running_loop())
    local_servers.attach(log_monitor, session_manager)
    await local_servers.start()

    # Start log monitoring (must come AFTER local_servers.attach so the
    # callback registry is populated before pattern matches start firing).
    await log_monitor.start_monitoring()

    # Item 5: refresh-token revocation store. Lives in the existing state
    # directory (log_directory) so it rides along with the rest of the
    # app's persistent state. Must be up BEFORE any request can hit
    # /auth/verify — which in practice means before the yield below.
    log_dir = settings.get_log_dir()
    db_path = str(log_dir / "refresh_tokens.db")
    refresh_store = RefreshStore(db_path)
    await refresh_store.init()
    _refresh_purge_task = asyncio.create_task(
        _refresh_purge_loop(refresh_store)
    )

    # Make components available to app state
    app.state.session_manager = session_manager
    app.state.log_monitor = log_monitor
    app.state.local_servers = local_servers
    app.state.refresh_store = refresh_store
    app.state.notification_router = notification_router

    # Background upload-uploads TTL pruner — safety net for long-running
    # servers. Layers 1 (destroy_session rmtree) and 2 (startup orphan
    # sweep in SessionManager.lifespan_startup) cover the common cases;
    # this handles slow-bleed accumulation when the server stays up for
    # weeks. No-op when uploads.enabled is False.
    upload_sweeper_task = None
    if auth_cfg.uploads.enabled:
        cfg = auth_cfg.uploads
        upload_sweeper = UploadSweeper(
            ttl_seconds=cfg.ttl_seconds,
            interval_seconds=cfg.sweep_interval_seconds,
            project_paths=[p.path for p in auth_cfg.projects],
            default_dir=settings.get_working_dir(),
        )
        app.state.upload_sweeper = upload_sweeper
        upload_sweeper_task = asyncio.create_task(upload_sweeper.run())
        logger.info(
            "upload_sweeper_scheduled",
            interval_seconds=cfg.sweep_interval_seconds,
            ttl_seconds=cfg.ttl_seconds,
        )

    # Release self check. Runs on its own daemon thread, first check 30s
    # after boot, so nothing on the startup path or any page load ever waits
    # on a network call. It NEVER upgrades anything; it reports, and the
    # three outcomes include an explicit "could not check".
    update_checker = UpdateChecker(
        config_path=Path(settings.auth_config_file).expanduser(),
    )
    set_update_checker(update_checker)
    app.state.update_checker = update_checker
    update_checker.start()

    logger.info("application_ready")
    logger.info(
        "server_ready_local_only",
        host=settings.host,
        port=settings.port,
    )

    yield

    # Cleanup on shutdown
    logger.info("application_shutting_down")

    # Signal the release self check to exit. It is a daemon thread, so this
    # is politeness rather than a requirement.
    update_checker.stop()
    set_update_checker(None)

    # Stop the upload sweeper first — it touches no other components, so
    # cancelling it early gives its CancelledError handler a clean window
    # to log shutdown intent before the rest of teardown noise hits.
    if upload_sweeper_task is not None:
        upload_sweeper_task.cancel()
        with suppress(asyncio.CancelledError):
            await upload_sweeper_task
        logger.info("upload_sweeper_stopped")

    # Cancel the refresh-token purge loop first so it doesn't try to
    # touch a closed DB connection.
    if _refresh_purge_task is not None:
        _refresh_purge_task.cancel()
        try:
            await _refresh_purge_task
        except (asyncio.CancelledError, Exception):
            pass
    if refresh_store is not None:
        await refresh_store.close()

    await log_monitor.stop_monitoring()
    if local_servers is not None:
        await local_servers.stop()

    # Item 6: tear down notification pipeline AFTER everything else has
    # stopped emitting. Router cancels its worker; ntfy backend closes
    # the httpx client.
    if notification_router is not None:
        await notification_router.stop()
    await ntfy_backend.shutdown()
    await slack_backend.shutdown()
    await pushover_backend.shutdown()

    logger.info("application_shutdown_complete")


# Create FastAPI app
app = FastAPI(
    title="☁️ Cloud Code",
    description="Remote control and monitoring for Claude Code sessions",
    version="1.0.0",
    lifespan=lifespan
)


# Provider-selector modal (v3.1) — remap FastAPI's default 422 to 400 for
# request-BODY validation failures. Needed so the model-id shell-injection
# guard on ``CreateSessionRequest.model`` (a pydantic field_validator in
# src/models.py, which raises before the route body ever runs) surfaces as
# 400 — matching the sibling ``POST /api/v1/providers/models`` endpoint,
# which validates the same regex manually and returns an explicit 400. No
# other route in this app asserts on the literal 422 status code (grepped
# at introduction time), so this is a safe app-wide remap rather than a
# narrowly-scoped one.
@app.exception_handler(RequestValidationError)
async def _validation_error_as_400(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=400,
        content=jsonable_encoder({"detail": exc.errors()}),
    )


# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
logger.info("CORS allowed origins", origins=settings.allowed_origins)


# Item 9: Content-Security-Policy + hardening headers.
#
# Ordering note (Starlette LIFO): `add_middleware` registers outer-to-inner
# as you call it, but they EXECUTE inner-to-outer on the request and
# outer-to-inner on the response. We want CSP applied to EVERY response
# including those produced by CORS preflight, static files, and the
# catch-all SPA route — so we register it here, after CORS. On response
# path it runs last, giving us a single place to stamp headers on
# anything the app returns (including errors).
#
# Policy rationale for a local / LAN-only SPA:
# - `default-src 'self'` — lock everything to same-origin by default.
# - `script-src 'self'` — no inline or eval; all JS ships from /static.
#   xterm.js and its addons used to load from cdn.jsdelivr.net; they are
#   now vendored under client/vendor/xterm/ (see that dir's VERSION.md)
#   and served same-origin, so the CDN host is no longer needed here.
# - `style-src 'self' 'unsafe-inline'` — xterm addons (webgl, fit) inject
#   inline style attributes on DOM nodes they manage. Without
#   `'unsafe-inline'` the terminal renders blank. This is the smallest
#   concession that keeps the terminal usable. cdn.jsdelivr.net dropped
#   here too now that xterm.css is vendored same-origin.
# - `connect-src 'self' ws: wss:` — WebSocket terminal stream runs on
#   the same origin; allow ws:/wss: so future tunnels (Cloudflare named)
#   with a different scheme can still connect.
# - `img-src 'self' data:` — data: URIs are used for QR codes / emoji SVGs.
# - `font-src 'self' data:` — xterm embeds icon fonts as data: URIs. This
#   never actually needed cdn.jsdelivr.net (xterm.css references no
#   remote font URL), so nothing changes here beyond the comment being
#   made honest.
# - `frame-ancestors 'none'` — clickjack defense; Cloude Code is never
#   meant to be iframed.
@app.middleware("http")
async def csp_headers(request: Request, call_next):
    """Stamp CSP + hardening headers on every response."""
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "connect-src 'self' ws: wss:; "
        "img-src 'self' data:; "
        "font-src 'self' data:; "
        "frame-ancestors 'none';"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response

# Wire slowapi rate limiter. The Limiter instance is defined in
# src/api/auth.py (where the @limiter.limit decorators are applied).
# Here we just bolt it onto the app:
#   - app.state.limiter is where SlowAPIMiddleware looks it up.
#   - _rate_limit_exceeded_handler emits a 429 with a Retry-After header
#     derived from the exception's reset time. Do NOT override or duplicate
#     its logging — slowapi already warns on 429 internally.
app.state.limiter = auth_limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# Include routers
app.include_router(auth_router, prefix="/api/v1")  # Auth routes (no auth required)
app.include_router(api_router, prefix="/api/v1")   # API routes (auth required)
app.include_router(config_files_router, prefix="/api/v1")  # Claude-config file tree/editor (auth required)
app.include_router(version_router, prefix="/api/v1")  # Version + release self check (auth required)
app.include_router(status_router, prefix="/api/v1")  # Read-only server/host/tmux status (auth required)
app.include_router(ws_router)                       # WebSocket routes

# Mount static files
client_dir = Path(__file__).parent.parent / "client"


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles subclass that forces revalidation on .html, .js and .json assets.

    Why: mobile browsers (iOS Safari in particular) aggressively heuristic-
    cache JS served over LAN HTTP with no ``Cache-Control`` header. That
    was producing a ghost bug where a phone would render a pre-v3.1
    ``launchpad.js`` bundle that predates the running-sessions feature,
    so the section silently stayed hidden.

    Fix: stamp ``Cache-Control: no-cache, must-revalidate`` on HTML, JS and
    JSON responses. ``no-cache`` still allows caching but forces a
    conditional GET (If-None-Match / If-Modified-Since) on every load, so
    the browser gets an instant 304 when the file is unchanged and the new
    bytes when it isn't. ``.css`` was added after a stale stylesheet proved NOT to be merely
    cosmetic: a deployed fix removed an ``overflow: hidden`` that was
    clipping hover tooltips, and returning browsers kept the cached sheet,
    so the affected controls stayed unreadable until a manual hard reload.
    Images and fonts keep the browser default; they version rarely and
    are not load-bearing for interaction.

    ``.json`` is on the list as of Phase 9 (theme system): ``theme.json``
    files served from ``/static/css/themes/<id>/`` and ``/themes/<id>/``
    are user-edited at runtime, and iOS Safari was caching them across
    sessions — flipping a manifest's CSS vars and requiring a hard reload
    to see the change. Same revalidation strategy as JS/HTML.

    Applied via subclass rather than ASGI middleware because (a) it only
    runs on static hits, (b) it can't accidentally leak Cache-Control
    onto API JSON responses, and (c) it sidesteps any ordering tangles
    with the existing CSP middleware.
    """

    _NO_CACHE_SUFFIXES = (".js", ".html", ".json", ".css")

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if path.lower().endswith(self._NO_CACHE_SUFFIXES):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


# Pin .m4a to audio/mp4 BEFORE any StaticFiles mount is constructed.
#
# Python's mimetypes table maps .m4a to `audio/mp4a-latm`, and Starlette's
# FileResponse takes the served Content-Type straight from that table. But
# `audio/mp4a-latm` (RFC 6416) names raw MPEG-4 audio in LATM/LOAS transport
# syntax - a bare elementary stream with NO container. Our theme beds are the
# opposite thing: `file` reports "ISO Media, Apple iTunes ALAC/AAC-LC (.M4A)"
# and the header opens with an `ftyp M4A isomiso2` box, i.e. an MP4 container,
# whose registered type is `audio/mp4` (RFC 4337).
#
# This is not a cosmetic label. Every response here carries
# `X-Content-Type-Options: nosniff` (see csp_headers), which explicitly
# FORBIDS the browser from correcting a wrong Content-Type by sniffing the
# bytes. So a browser that does not recognise `audio/mp4a-latm` as a
# decodable type has no fallback left and simply refuses the file. The
# hardening header and the bad type combine into a failure neither one
# would cause alone.
mimetypes.add_type("audio/mp4", ".m4a")

app.mount("/static", NoCacheStaticFiles(directory=str(client_dir)), name="static")


# ---------------------------------------------------------------------------
# App version injection (header chip)
#
# The web client's version chip is `{{VERSION}}` in client/index.html and is
# stamped at serve time so it NEVER drifts from the real release.
#
# THE RELEASE TAG IS THE SOURCE OF TRUTH. The full resolution order (env var,
# then the generated VERSION file, then an exact `git describe` tag, then the
# legacy macOS/package.json, then a loose describe) lives in ONE place:
# src/core/version.py. Do not add a second resolver here or anywhere else. On
# total failure the resolver returns "" so the chip renders blank rather than
# a wrong literal.
#
# Resolved once at import time (immutable for the life of the process).
# ---------------------------------------------------------------------------
_VERSION_PLACEHOLDER = "{{VERSION}}"

# Cached at import time - version is fixed for the process lifetime.
APP_VERSION = resolve_version()


def _render_index_html() -> str:
    """Read the SPA shell and stamp the real version into the chip.

    Shared by `/` and `/session/{project}` so the inject logic lives in ONE
    place. The chip renders as `v<version>` (e.g. `v0.7.3`); if the version
    is unknown the placeholder is replaced with an empty string so no raw
    `{{VERSION}}` token ever reaches the browser.
    """
    html = (client_dir / "index.html").read_text(encoding="utf-8")
    chip = f"v{APP_VERSION}" if APP_VERSION else ""
    return html.replace(_VERSION_PLACEHOLDER, chip)


# ---------------------------------------------------------------------------
# User themes mount (Phase 9 — pluggability surface)
# ---------------------------------------------------------------------------
# Serves user-authored theme assets from
# ``~/Library/Application Support/cloude-code-menubar/themes/`` (or env
# override CLOUDE_USER_THEMES_DIR) at the URL prefix ``/themes/<id>/<file>``.
# This parallels the bundled-theme URL ``/static/css/themes/<id>/<file>``
# and is consumed by client/js/themes/registry.js when applying a manifest
# whose ``source`` field is ``"user"``.
#
# UNAUTH on purpose — per spec section "Architecture F" (Pluggability
# Surface) and the T3 critique decision, theme assets contain no secrets
# and mirror the unauth ``/static/*`` mount. Theme authors MUST NOT put
# secrets in theme.json or effects.js — same threat model as any static
# resource served on the LAN-only deployment.
#
# Mount only when the dir exists on disk so a missing user dir isn't a
# 500 source — the discovery endpoint also gracefully handles absence.
def _resolve_user_themes_dir() -> Path:
    """Resolve user themes dir. Honors env override, defaults to OS-portable
    Application Support path on macOS / config dir on linux/docker.
    """
    env_dir = os.environ.get("CLOUDE_USER_THEMES_DIR")
    if env_dir:
        return Path(env_dir).expanduser()
    # macOS canonical path; on linux/docker the home-relative Library dir
    # is benign (just nonexistent), so the if-exists gate below skips the
    # mount cleanly. Operators on those platforms can set the env var.
    return Path.home() / "Library" / "Application Support" / "cloude-code-menubar" / "themes"


user_themes_dir = _resolve_user_themes_dir()
if user_themes_dir.exists():
    app.mount(
        "/themes",
        NoCacheStaticFiles(directory=str(user_themes_dir), html=False),
        name="user-themes",
    )
    logger.info("user_themes_mount", path=str(user_themes_dir))
else:
    logger.info("user_themes_mount_skipped", path=str(user_themes_dir), reason="dir not present")


@app.get("/")
async def root():
    """Serve the web interface."""
    # See NoCacheStaticFiles docstring — the HTML shell served from "/"
    # bypasses StaticFiles, so stamp the no-cache header here too or the
    # phone will keep booting a stale shell that references old JS URLs.
    # _render_index_html() also stamps the live app version into the chip.
    return HTMLResponse(
        content=_render_index_html(),
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


# Item 9: deep-link route. `/session/<project>` serves the SAME SPA shell
# as `/` — the client-side router (client/js/router.js) reads the path
# on load, validates the slug, and auto-selects the project after auth.
#
# Why a dedicated FastAPI route (not a catch-all):
# - Keeps routing explicit; `/static/*`, `/ws/*`, `/api/*`, `/health` all
#   resolve to their real handlers. FastAPI matches more-specific routes
#   first, and this one is a SINGLE path segment under `/session/`, so
#   there is no collision with anything else we mount.
# - Path-level validation is intentionally permissive: we accept any
#   non-empty path segment here and rely on the client router to enforce
#   the strict slug regex and display a visible error for invalid names.
#   That means a visitor who pastes a bad URL sees the app shell with an
#   error banner — not a 404 from the server. Security posture is
#   unchanged because no server-side state is touched by this route.
@app.get("/session/{project}")
async def session_deep_link(project: str):
    """Serve the SPA shell for deep-link URLs.

    The ``project`` path parameter is consumed by the client-side router
    after the SPA boots; this handler does not inspect or validate it.
    """
    # Same no-cache rationale as root(): force the HTML shell to
    # revalidate on every load so a stale cached shell doesn't pin
    # the phone to an old JS bundle. Shares _render_index_html() with
    # root() so the version chip is stamped identically on both routes.
    return HTMLResponse(
        content=_render_index_html(),
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


# Web app manifest + apple-touch-icon, served from the ORIGIN ROOT.
#
# Both files physically live under client/ and are therefore already
# reachable at /static/..., but they get root routes anyway:
#
# - The manifest's ``scope``/``start_url`` are resolved relative to the
#   manifest URL. Serving it from /static/ would scope the app to /static/,
#   and a standalone launch would then treat "/" as off-scope and open it
#   in a browser tab instead of the app window.
# - iOS probes /apple-touch-icon.png at the origin root when a page's
#   <link rel="apple-touch-icon"> is missing or fails; answering that probe
#   costs one route and removes a whole class of "why is my home screen
#   icon a screenshot of the page" failure.
#
# Media type is stamped explicitly: the manifest MUST be served as
# application/manifest+json or Chrome ignores it, and the extension is not
# in Python's mimetypes table.
_WEB_MANIFEST_PATH = client_dir / "manifest.webmanifest"
_APPLE_TOUCH_ICON_PATH = client_dir / "assets" / "icons" / "icon-180.png"


@app.get("/manifest.webmanifest")
async def web_manifest():
    """Serve the web app manifest from the origin root."""
    return FileResponse(
        _WEB_MANIFEST_PATH,
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-cache, must-revalidate"},
    )


@app.get("/apple-touch-icon.png")
async def apple_touch_icon():
    """Serve the 180px home-screen icon for iOS's root-path probe."""
    return FileResponse(_APPLE_TOUCH_ICON_PATH, media_type="image/png")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "session_active": session_manager.has_active_session() if session_manager else False,
        "monitoring": log_monitor.is_monitoring if log_monitor else False
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
        log_level="info"
    )
