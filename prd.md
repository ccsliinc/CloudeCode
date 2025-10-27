Perfect! Let's build this systematically. Let me map out the complete architecture first, then dive deep into the API/terminal/port forwarding component.

# 🏗️ **System Architecture Overview**

```
┌─────────────────────────────────────────────────────────────────┐
│                    MacBook Pro M1 (Host)                         │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         Layer 1: Claude Code (tmux session)               │  │
│  │  • claude-code CLI running in isolated tmux session       │  │
│  │  • Spawns dev servers (localhost:3000, :8000, etc)       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↕                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         Layer 2: Control Plane (Python Service)           │  │
│  │  • Session Manager: tmux interaction                      │  │
│  │  • Log Monitor: capture & parse output                    │  │
│  │  • Tunnel Manager: cloudflared automation                 │  │
│  │  • File Watcher: track code changes                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↕                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         Layer 3: API Gateway (FastAPI)                    │  │
│  │  • REST endpoints: /api/v1/*                              │  │
│  │  • WebSocket: /ws/sessions/{id}/stream                    │  │
│  │  • Auth: simple token-based (MVP)                         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↕                                   │
└──────────────────────────────┼──────────────────────────────────┘
                               ↓ (HTTP/WS over LAN/WAN)
                    ┌──────────┴──────────┐
                    ↓                     ↓
         ┌─────────────────┐   ┌─────────────────┐
         │   Web Client    │   │  iOS/Mac App    │
         │   (Phase 2)     │   │   (Phase 3)     │
         └─────────────────┘   └─────────────────┘
```

---

# 📋 **Phase 1: API + Terminal Integration - Complete Design Spec**

## **1. Technology Stack**

```yaml
Language: Python 3.11+
Framework: FastAPI 0.104+
WebSocket: fastapi.WebSocket
Process Management: tmux (via subprocess)
Tunnel: cloudflared CLI
Async Runtime: asyncio + uvicorn
File Monitoring: watchdog
Configuration: pydantic-settings
Logging: structlog
Testing: pytest + pytest-asyncio
```

## **2. Project Structure**

```
claude-code-controller/
├── src/
│   ├── __init__.py
│   ├── main.py                 # FastAPI app entry point
│   ├── config.py               # Configuration management
│   ├── models.py               # Pydantic models
│   │
│   ├── core/
│   │   ├── __init__.py
│   │   ├── session_manager.py  # Tmux session management
│   │   ├── log_monitor.py      # Output capture & parsing
│   │   ├── tunnel_manager.py   # Cloudflare tunnel automation
│   │   └── file_watcher.py     # File system monitoring
│   │
│   ├── api/
│   │   ├── __init__.py
│   │   ├── routes.py           # API endpoints
│   │   ├── websocket.py        # WebSocket handlers
│   │   └── deps.py             # Dependencies & auth
│   │
│   └── utils/
│       ├── __init__.py
│       ├── tmux.py             # Tmux utility functions
│       └── patterns.py         # Regex patterns for detection
│
├── tests/
│   ├── test_session_manager.py
│   ├── test_tunnel_manager.py
│   └── test_api.py
│
├── requirements.txt
├── pyproject.toml
├── README.md
└── .env.example
```

## **3. Core Components Specification**

### **3.1 Session Manager**

**Responsibilities:**
- Create/destroy tmux sessions
- Send commands to sessions
- Capture session output
- Track session state

**Key Methods:**
```python
class SessionManager:
    async def create_session(session_id: str) -> Session
    async def destroy_session(session_id: str) -> bool
    async def send_command(session_id: str, command: str) -> bool
    async def get_output_stream(session_id: str) -> AsyncGenerator[str]
    async def get_session_info(session_id: str) -> SessionInfo
    def list_sessions() -> List[Session]
```

**Tmux Commands Used:**
```bash
# Create new session
tmux new-session -d -s {session_id} -c {working_dir}

# Send initial command (launch claude-code)
tmux send-keys -t {session_id} "claude-code" C-m

# Capture output
tmux pipe-pane -t {session_id} -o "cat >> {log_file}"

# Send command
tmux send-keys -t {session_id} "{command}" C-m

# Get pane content
tmux capture-pane -t {session_id} -p

# Kill session
tmux kill-session -t {session_id}
```

### **3.2 Log Monitor**

**Responsibilities:**
- Tail log files in real-time
- Parse output for patterns (localhost:PORT)
- Broadcast events to WebSocket clients
- Maintain rolling buffer (last 1000 lines)

**Key Methods:**
```python
class LogMonitor:
    async def start_monitoring(session_id: str) -> None
    async def stop_monitoring(session_id: str) -> None
    async def get_log_stream(session_id: str) -> AsyncGenerator[LogEntry]
    def get_recent_logs(session_id: str, limit: int = 100) -> List[LogEntry]
```

**Pattern Detection:**
```python
PATTERNS = {
    'localhost_server': r'(?:https?://)?localhost:(\d+)',
    'server_ready': r'(?:Server|Development server) (?:running|listening) (?:at|on)',
    'error': r'(?:ERROR|Error|error):',
    'file_created': r'(?:Created|Writing|Saved) (?:file|to):\s*(.+)',
}
```

### **3.3 Tunnel Manager**

**Responsibilities:**
- Detect when Claude Code starts a local server
- Launch cloudflared tunnel automatically
- Extract public URL from tunnel output
- Track tunnel lifecycle
- Kill tunnels when session ends

**Key Methods:**
```python
class TunnelManager:
    async def create_tunnel(session_id: str, port: int) -> Tunnel
    async def destroy_tunnel(tunnel_id: str) -> bool
    async def get_tunnel_url(tunnel_id: str) -> str
    def get_active_tunnels(session_id: str) -> List[Tunnel]
    async def health_check(tunnel_id: str) -> bool
```

**Cloudflare Tunnel Process:**
```python
# Start tunnel
process = subprocess.Popen(
    ["cloudflared", "tunnel", "--url", f"http://localhost:{port}"],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True
)

# Monitor output for URL
# Output format: "https://random-words-1234.trycloudflare.com"
```

### **3.4 File Watcher (Optional for MVP, but good to spec)**

**Responsibilities:**
- Monitor working directory for changes
- Track what files Claude Code creates/modifies
- Provide file tree view

**Key Methods:**
```python
class FileWatcher:
    async def start_watching(session_id: str, path: str) -> None
    async def stop_watching(session_id: str) -> None
    def get_file_tree(session_id: str) -> FileTree
    def get_recent_changes(session_id: str, limit: int = 20) -> List[FileChange]
```

## **4. Data Models**

```python
# models.py

from pydantic import BaseModel, Field
from typing import Optional, List, Dict
from datetime import datetime
from enum import Enum

class SessionStatus(str, Enum):
    CREATING = "creating"
    RUNNING = "running"
    STOPPED = "stopped"
    ERROR = "error"

class Session(BaseModel):
    id: str = Field(..., description="Unique session identifier")
    tmux_session: str = Field(..., description="Tmux session name")
    working_dir: str = Field(..., description="Working directory path")
    status: SessionStatus
    created_at: datetime
    last_activity: datetime
    tunnels: List['Tunnel'] = []
    
class Tunnel(BaseModel):
    id: str
    session_id: str
    port: int
    public_url: str
    created_at: datetime
    status: str  # "active", "stopped", "error"
    process_pid: Optional[int] = None

class LogEntry(BaseModel):
    timestamp: datetime
    session_id: str
    content: str
    log_type: str = "stdout"  # "stdout", "stderr", "system"
    
class CommandRequest(BaseModel):
    command: str = Field(..., description="Command to execute")
    
class CreateSessionRequest(BaseModel):
    working_dir: Optional[str] = Field(None, description="Override working directory")
    auto_start_claude: bool = Field(True, description="Auto-launch claude-code")
    
class SessionInfo(BaseModel):
    session: Session
    recent_logs: List[LogEntry]
    active_tunnels: List[Tunnel]
    stats: Dict[str, any] = {
        "total_commands": 0,
        "uptime_seconds": 0,
        "log_lines": 0
    }
```

## **5. API Endpoints Specification**

### **REST API**

```python
# Base URL: http://localhost:8000/api/v1

# Sessions
POST   /sessions                    # Create new Claude Code session
GET    /sessions                    # List all sessions
GET    /sessions/{id}              # Get session details
DELETE /sessions/{id}              # Stop and destroy session
POST   /sessions/{id}/command      # Send command to session
GET    /sessions/{id}/logs         # Get recent logs (last N lines)

# Tunnels
GET    /sessions/{id}/tunnels      # List active tunnels for session
POST   /sessions/{id}/tunnels      # Manually create tunnel for specific port
DELETE /tunnels/{tunnel_id}        # Stop specific tunnel

# Files (optional for MVP)
GET    /sessions/{id}/files        # Get file tree
GET    /sessions/{id}/files/changes # Get recent file changes

# System
GET    /health                     # Health check
GET    /version                    # API version info
```

### **WebSocket Streams**

```python
# Real-time log streaming
WS /ws/sessions/{id}/logs

# Message format (Server -> Client):
{
    "type": "log",
    "timestamp": "2025-10-27T10:30:00Z",
    "content": "Server running on http://localhost:3000",
    "log_type": "stdout"
}

{
    "type": "tunnel_created",
    "tunnel": {
        "id": "tun_abc123",
        "port": 3000,
        "public_url": "https://random-words.trycloudflare.com",
        "created_at": "2025-10-27T10:30:05Z"
    }
}

{
    "type": "session_status",
    "status": "running",
    "uptime": 3600
}

# Client can send commands through WebSocket too:
{
    "type": "command",
    "command": "npm run build"
}
```

## **6. Configuration**

```python
# config.py

from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    
    # Sessions
    default_working_dir: str = "~/claude-projects"
    max_sessions: int = 5
    session_timeout: int = 3600  # seconds
    
    # Logging
    log_buffer_size: int = 1000  # lines to keep in memory
    log_file_retention: int = 7  # days
    
    # Tunnels
    tunnel_provider: str = "cloudflare"  # or "ngrok" later
    auto_create_tunnels: bool = True
    tunnel_timeout: int = 30  # seconds to wait for URL
    
    # Security
    api_key: Optional[str] = None  # Simple auth for MVP
    allowed_origins: List[str] = ["*"]  # CORS
    
    # Paths
    tmux_socket_name: str = "claude-controller"
    log_directory: str = "/tmp/claude-code-logs"
    
    class Config:
        env_file = ".env"
```

## **7. Core Logic Flow**

### **Creating a Session:**
```
1. POST /sessions
2. Generate unique session_id (e.g., "ses_abc123")
3. Create tmux session: tmux new-session -d -s ses_abc123
4. Start log monitoring task (background)
5. Send "claude-code" command to tmux
6. Return session info to client
7. Client connects to WebSocket for logs
```

### **Auto-Tunnel Creation:**
```
1. Log monitor detects: "Server running on http://localhost:3000"
2. Extract port: 3000
3. Check if tunnel already exists for this port
4. If not, launch: cloudflared tunnel --url http://localhost:3000
5. Wait for tunnel URL in output (with timeout)
6. Parse URL: https://random-words.trycloudflare.com
7. Store tunnel info in session
8. Broadcast event to WebSocket clients:
   {"type": "tunnel_created", "port": 3000, "url": "..."}
```

### **Sending Commands:**
```
1. POST /sessions/{id}/command with {"command": "npm test"}
2. Validate session exists and is running
3. Send to tmux: tmux send-keys -t {session_id} "npm test" C-m
4. Log monitor captures output
5. Stream output to WebSocket clients
6. Return 200 OK
```

## **8. Error Handling**

```python
# Custom exceptions
class SessionNotFoundError(Exception): pass
class SessionCreationError(Exception): pass
class TunnelCreationError(Exception): pass
class TmuxCommandError(Exception): pass

# API error responses
{
    "error": "session_not_found",
    "message": "Session ses_abc123 does not exist",
    "code": 404
}
```

## **9. Security Considerations (MVP)**

```python
# Simple API key auth
@app.middleware("http")
async def verify_api_key(request: Request, call_next):
    if settings.api_key:
        provided_key = request.headers.get("X-API-Key")
        if provided_key != settings.api_key:
            return JSONResponse(
                status_code=401,
                content={"error": "unauthorized"}
            )
    return await call_next(request)
```

## **10. Testing Strategy**

```python
# Unit tests
- test_session_manager.py: Mock tmux commands
- test_tunnel_manager.py: Mock cloudflared process
- test_log_monitor.py: Test pattern detection

# Integration tests
- test_api.py: Test full API flow
- test_websocket.py: Test real-time streaming

# Manual testing checklist:
1. ✓ Create session successfully
2. ✓ Claude Code launches in tmux
3. ✓ Logs stream via WebSocket
4. ✓ Localhost:PORT detected
5. ✓ Tunnel created automatically
6. ✓ Public URL accessible
7. ✓ Commands sent and executed
8. ✓ Session cleanup on destroy
```

---

# 🚀 **MVP Feature Checklist**

**Must Have (Phase 1.0):**
- ✅ Create/destroy Claude Code sessions in tmux
- ✅ Stream logs via WebSocket in real-time
- ✅ Auto-detect localhost:PORT patterns
- ✅ Auto-create cloudflare tunnels
- ✅ Send commands to active session
- ✅ List active sessions and tunnels
- ✅ Basic error handling

**Nice to Have (Phase 1.1):**
- ⭕ Multiple concurrent sessions
- ⭕ Session persistence (survive server restart)
- ⭕ File system monitoring
- ⭕ Log search/filter
- ⭕ Tunnel health checks

**Future (Phase 1.2+):**
- ⭕ ngrok as alternative tunnel provider
- ⭕ Authentication with JWT
- ⭕ Rate limiting
- ⭕ Session recording/playback
- ⭕ Metrics & monitoring

---

## **Ready to Build?**

I've designed the complete architecture for Phase 1. The system is:
- **Modular:** Each component has clear responsibilities
- **Async:** Non-blocking operations for performance
- **Testable:** Mock-friendly design
- **Extensible:** Easy to add features later

**Next steps - I can:**
1. **Build the entire backend** (all files, fully functional)
2. **Start with just the core** (session manager + tmux integration)
3. **Prototype just one flow** (create session → auto-tunnel)

Which approach do you want? I'm ready to start coding! 🎯