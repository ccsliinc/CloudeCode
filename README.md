# ☁️ Cloude Code

Remote control and monitoring for Claude Code CLI - code from anywhere.

Control Claude Code sessions from any device on your network. Built for mobile-first development workflows with auto-tunneling, persistent sessions, and real-time terminal streaming.

## What It Does

Runs Claude Code in a persistent pseudo-terminal on your Mac and exposes a web-based control interface. Access your coding session from your phone, tablet, or another computer. When Claude spins up a dev server, it automatically creates a public Cloudflare tunnel and broadcasts the URL to all connected clients.

Perfect for developers who want to code on the couch, monitor long-running tasks from their phone, or quickly share dev environments without manual tunnel setup.

## Key Features

- **PTY-Based Persistent Sessions** - Claude Code runs in an isolated pseudo-terminal that survives server restarts
- **Real-Time WebSocket Terminal** - Full bidirectional terminal I/O with xterm.js rendering and Unicode support
- **Intelligent Auto-Tunneling** - Pattern detection automatically creates Cloudflare tunnels when dev servers start
- **Hybrid Tunnel Strategy** - Choose between quick tunnels (instant, random URLs) or named tunnels (persistent custom domains)
- **Web Launchpad Interface** - Terminal-aesthetic UI for project management and session control
- **TOTP Authentication** - Secure access with Google Authenticator/Authy 2FA and JWT tokens
- **Project Management** - Quick-launch predefined projects with template file copying
- **Mobile-Optimized** - D-pad controls, special keyboard shortcuts (¥=Enter, €=Tab), and responsive design
- **Pattern Detection Engine** - Monitors terminal output for `localhost:PORT` and "Server ready" signals
- **Session Recovery** - Automatically validates and reconnects to existing sessions on startup

## Use Cases

- **Mobile Development**: Start Claude Code on your Mac, control it from your phone while away from your desk
- **Remote Pair Programming**: Share tunnel URLs so others can see your Claude Code session in real-time
- **Auto-Share Dev Servers**: Claude detects when you spin up a server and automatically creates a public URL
- **Multi-Device Workflows**: Start coding on your desktop, continue on the couch with your tablet
- **Live Demos**: Share live coding sessions and dev servers via public tunnel links

## Prerequisites

- **Python 3.11+**
- **Claude CLI** - Installed and configured (`claude` command in PATH)
- **cloudflared** - Cloudflare tunnel CLI ([install](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/))
- **macOS/Linux** - Tested on macOS, should work on Linux

Install system dependencies:
```bash
# macOS
brew install cloudflared

# Ensure Claude CLI is installed
which claude  # Should return a path
```

## Quick Start

### 1. Install Dependencies

```bash
# Clone and navigate to project
cd "Cloude Code"

# Create virtual environment and install Python packages
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Verify Setup

```bash
# Run setup script to check all dependencies
./setup.sh
```

This validates that `cloudflared`, `claude`, and Python are all properly installed.

### 3. Configure Authentication

```bash
# Generate TOTP secret and JWT key
python3 setup_auth.py
```

This will:
- Generate a TOTP secret for 2FA
- Create JWT secret for token auth
- Display a QR code for Google Authenticator/Authy
- Save config to `~/.claude-tunnel/config.json`
- Save QR image to `~/.claude-tunnel/totp-qr.png`

Scan the QR code with your authenticator app.

### 4. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your settings (optional)
# Defaults work fine for basic usage
```

### 5. Start the Server

```bash
# Start API server
./start.sh

# Or manually:
source venv/bin/activate
python3 -m src.main
```

Server runs on `http://0.0.0.0:8000`

### 6. Access Launchpad

Open `http://localhost:8000` in your browser (or `http://YOUR_MAC_IP:8000` from phone).

- Enter your TOTP code to authenticate
- Create a new project or select existing
- Terminal loads with Claude Code running

## Configuration

### Environment Variables (.env)

Key settings you might want to change:

```bash
# Server
HOST=0.0.0.0              # Bind to all interfaces for network access
PORT=8000                 # API server port

# Sessions
DEFAULT_WORKING_DIR=~/claude-projects  # Where new projects are created
SESSION_TIMEOUT=3600                   # Session idle timeout (seconds)

# Tunnels
AUTO_CREATE_TUNNELS=true               # Auto-create tunnels when ports detected
USE_NAMED_TUNNELS=false                # Use named tunnels (requires Cloudflare config)

# Cloudflare (for named tunnels only)
CLOUDFLARE_API_TOKEN=your_token        # API token with DNS edit + Tunnel edit perms
CLOUDFLARE_ZONE_ID=your_zone_id        # Zone ID for your domain
CLOUDFLARE_DOMAIN=claude.yourdomain.com  # Your custom domain
CLOUDFLARE_TUNNEL_NAME=claude-controller # Tunnel name
```

### Cloudflare Tunnel Modes

#### Quick Tunnels (Default)
Uses `trycloudflare.com` - no account required.

**Pros:**
- Zero config
- Instant creation
- Free

**Cons:**
- Random URLs that change on restart
- Less stable
- Subject to rate limits

**Usage:** Works out of the box, no setup needed.

---

#### Named Tunnels (Recommended)
Uses your Cloudflare account with persistent custom domains.

**Pros:**
- Stable URLs like `3000.claude.yourdomain.com`
- Single persistent tunnel, multiple ports
- CNAMEs auto-created and reused
- More reliable

**Cons:**
- Requires Cloudflare account (free)
- Initial setup needed

**Setup:**

1. **Authenticate cloudflared:**
   ```bash
   cloudflared login
   ```
   Opens browser for OAuth flow.

2. **Create Cloudflare API Token:**
   - Go to https://dash.cloudflare.com/profile/api-tokens
   - "Create Token" → "Edit zone DNS" template
   - Add permissions: `Zone.DNS:Edit` and `Account.Cloudflare Tunnel:Edit`
   - Copy token

3. **Get Zone ID:**
   - Go to your domain's overview in Cloudflare dashboard
   - Scroll to "API" section → Copy "Zone ID"

4. **Update `.env`:**
   ```bash
   USE_NAMED_TUNNELS=true
   CLOUDFLARE_API_TOKEN=your_token_here
   CLOUDFLARE_ZONE_ID=your_zone_id
   CLOUDFLARE_DOMAIN=claude.yourdomain.com
   CLOUDFLARE_TUNNEL_NAME=claude-controller
   ```

5. **Restart server** - Named tunnel will auto-create and persist.

When dev servers start, CNAMEs like `3000.claude.yourdomain.com` are automatically created and reused across restarts.

## Architecture

```
┌─────────────────────────────────────┐
│   Browser/Mobile Client             │
│   ├── Auth (TOTP)                   │
│   ├── Launchpad (Project Manager)   │
│   └── xterm.js Terminal             │
└──────────────┬──────────────────────┘
               │ WebSocket + REST API
┌──────────────┴──────────────────────┐
│   FastAPI Server (Python)           │
│   ├── Session Manager (PTY)         │
│   ├── Log Monitor (Pattern Detect)  │
│   ├── Hybrid Tunnel Manager         │
│   ├── Auto-Tunnel Orchestrator      │
│   └── Cloudflare API Integration    │
└──────────────┬──────────────────────┘
               │
         ┌─────┴─────┐
         │           │
    ┌────┴───┐  ┌────┴─────────┐
    │ PTY    │  │ Cloudflared  │
    │ Process│  │ Tunnels      │
    │ (Claude│  │ (Public URLs)│
    │  Code) │  │              │
    └────────┘  └──────────────┘
```

**Flow:**
1. User authenticates with TOTP code
2. Launchpad creates/connects to PTY session running Claude Code
3. Terminal streams bidirectional I/O via WebSocket
4. Log monitor watches terminal output for port patterns
5. Auto-tunnel creates Cloudflare tunnel when `localhost:PORT` detected
6. Tunnel URL broadcast to all connected clients
7. Session persists across server restarts

## Project Structure

```
CloudeCode/
├── src/
│   ├── main.py                      # FastAPI app entry
│   ├── config.py                    # Environment config
│   ├── models.py                    # Pydantic models
│   ├── core/                        # Business logic
│   │   ├── session_manager.py       # PTY session management
│   │   ├── log_monitor.py           # Pattern detection
│   │   ├── tunnel_manager.py        # Quick tunnels
│   │   ├── named_tunnel_manager.py  # Named tunnels
│   │   ├── hybrid_tunnel_manager.py # Tunnel strategy
│   │   ├── auto_tunnel.py           # Auto-tunnel orchestration
│   │   └── cloudflare_api.py        # Cloudflare DNS API
│   ├── api/                         # API layer
│   │   ├── routes.py                # REST endpoints
│   │   ├── websocket.py             # WebSocket handlers
│   │   ├── auth.py                  # TOTP/JWT auth
│   │   └── deps.py                  # Dependency injection
│   └── utils/                       # Utilities
│       ├── pty_session.py           # PTY process wrapper
│       ├── patterns.py              # Regex pattern matcher
│       └── template_manager.py      # Project templates
├── client/                          # Frontend
│   ├── index.html                   # Single-page app
│   ├── css/styles.css               # Terminal aesthetic
│   └── js/
│       ├── api.js                   # API client
│       ├── auth.js                  # Auth module
│       ├── launchpad.js             # Project launcher
│       ├── terminal.js              # xterm.js integration
│       └── dpad.js                  # Mobile controls
├── .env.example                     # Environment template
├── requirements.txt                 # Python deps
├── setup.sh                         # Dependency checker
├── setup_auth.py                    # TOTP setup script
└── README.md                        # This file
```

## API Reference

### Authentication

**Get TOTP Config:**
```bash
GET /api/v1/auth/totp/config
```

**Verify TOTP:**
```bash
POST /api/v1/auth/totp/verify
{"token": "123456"}
```
Returns JWT token.

### Sessions

**Create Session:**
```bash
POST /api/v1/sessions
{
  "working_directory": "~/my-project",
  "auto_start_claude": true
}
```

**Get Session Info:**
```bash
GET /api/v1/sessions
```

**Destroy Session:**
```bash
DELETE /api/v1/sessions
```

### Projects

**List Projects:**
```bash
GET /api/v1/projects
```

**Create Project:**
```bash
POST /api/v1/projects
{
  "name": "my-app",
  "path": "~/projects/my-app",
  "description": "My new project"
}
```

**Delete Project:**
```bash
DELETE /api/v1/projects/{name}
```

### Tunnels

**List Active Tunnels:**
```bash
GET /api/v1/tunnels
```

**Create Manual Tunnel:**
```bash
POST /api/v1/tunnels
{"port": 3000}
```

**Destroy Tunnel:**
```bash
DELETE /api/v1/tunnels/{port}
```

### WebSocket

**Connect to Terminal:**
```
ws://localhost:8000/ws/terminal?token=YOUR_JWT_TOKEN
```

**Receive messages:**
- Terminal output: `{"type": "output", "data": "base64_encoded_data"}`
- Tunnel created: `{"type": "tunnel_created", "tunnel": {...}}`
- Keepalive: `{"type": "ping"}`

**Send messages:**
- Terminal input: `{"type": "input", "data": "command text"}`
- Resize: `{"type": "resize", "cols": 80, "rows": 24}`
- Pong: `{"type": "pong"}`

## Troubleshooting

### Authentication Fails
- **Symptom**: TOTP code rejected
- **Fix**: Run `python3 setup_auth.py` again and re-scan QR code. Check system clock is synced (TOTP is time-based).

### Tunnels Not Creating
- **Symptom**: Dev servers start but no tunnel URL appears
- **Check**:
  - `which cloudflared` returns a path
  - `AUTO_CREATE_TUNNELS=true` in `.env`
  - Look for "Tunnel created" in terminal output
- **Test manually**: `cloudflared tunnel --url http://localhost:3000`

### Can't Connect from Phone
- **Symptom**: `http://MAC_IP:8000` times out
- **Check**:
  - Phone on same WiFi network
  - Mac firewall allows port 8000: System Preferences → Security → Firewall
  - Find Mac IP: `ifconfig | grep inet` (look for 192.168.x.x)
  - Try `http://localhost:8000/health` on Mac first

### Claude Not Starting
- **Symptom**: Session created but Claude doesn't launch
- **Check**:
  - `which claude` or `ls ~/.claude/local/claude` works
  - Claude CLI is authenticated: `claude --help`
  - Check session logs via WebSocket or API
- **Manual test**: Run `claude --dangerously-skip-permissions` in terminal

### Session Lost After Reboot
- **Symptom**: Can't reconnect to session after Mac restart
- **Cause**: PTY processes don't survive reboots
- **Fix**: Create new session (old session auto-cleaned on server start)

### Named Tunnel CNAMEs Not Creating
- **Symptom**: Tunnel works but DNS records not created
- **Check**:
  - `CLOUDFLARE_API_TOKEN` has `Zone.DNS:Edit` permission
  - `CLOUDFLARE_ZONE_ID` matches your domain's Zone ID
  - Check API logs in terminal output
- **Manual test**: Use Cloudflare dashboard to create a test DNS record

## Development

### Running Tests

```bash
# Activate virtual environment
source venv/bin/activate

# Run all tests
pytest tests/ -v

# Run specific test file
pytest tests/test_session_manager.py -v
```

### Contributing

Pull requests welcome. For major changes, open an issue first.

**Development setup:**
1. Fork the repo
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Make changes and test
4. Commit (`git commit -m 'Add amazing feature'`)
5. Push (`git push origin feature/amazing-feature`)
6. Open Pull Request

## License

MIT

---

Built for developers who want to code from anywhere. No more being chained to your desk.
