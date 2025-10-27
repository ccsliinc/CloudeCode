"""Main FastAPI application for Claude Code Controller."""

import structlog
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import settings
from src.core.session_manager import SessionManager
from src.core.log_monitor import LogMonitor
from src.core.hybrid_tunnel_manager import HybridTunnelManager
from src.core.auto_tunnel import AutoTunnelOrchestrator
from src.api.routes import router as api_router
from src.api.websocket import router as ws_router

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
tunnel_manager: HybridTunnelManager = None
auto_tunnel: AutoTunnelOrchestrator = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    global session_manager, log_monitor, tunnel_manager, auto_tunnel

    logger.info("application_starting", version="1.0.0")

    # Initialize core components
    session_manager = SessionManager()
    log_monitor = LogMonitor(session_manager)
    tunnel_manager = HybridTunnelManager(session_manager)

    # Initialize tunnel manager
    await tunnel_manager.initialize()

    auto_tunnel = AutoTunnelOrchestrator(log_monitor, tunnel_manager)

    # Initialize auto-tunnel orchestrator
    auto_tunnel.initialize()

    # Start log monitoring
    await log_monitor.start_monitoring()

    # Make components available to app state
    app.state.session_manager = session_manager
    app.state.log_monitor = log_monitor
    app.state.tunnel_manager = tunnel_manager
    app.state.auto_tunnel = auto_tunnel

    logger.info("application_ready")

    yield

    # Cleanup on shutdown
    logger.info("application_shutting_down")

    await log_monitor.stop_monitoring()
    await auto_tunnel.cleanup()
    await tunnel_manager.shutdown()

    logger.info("application_shutdown_complete")


# Create FastAPI app
app = FastAPI(
    title="Claude Code Controller",
    description="Remote control and monitoring for Claude Code sessions",
    version="1.0.0",
    lifespan=lifespan
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(api_router, prefix="/api/v1")
app.include_router(ws_router)


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": "Claude Code Controller",
        "version": "1.0.0",
        "status": "operational"
    }


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
