# Claude Code Remote Controller

Remote control and monitoring system for Claude Code development sessions. Control Claude Code from any device on your network - perfect for mobile-first workflows.

## Features

- **Single Session Management**: Run Claude Code in a persistent tmux session
- **Real-time Terminal Streaming**: Full bidirectional terminal I/O via WebSocket
- **Automatic Tunnel Creation**: Auto-detects dev servers and creates Cloudflare tunnels
- **Remote Access**: Control from any device on your LAN (or via VPN)
- **Session Persistence**: Sessions survive API server restarts
- **Mobile-Friendly**: Built for control from phones and tablets

## Prerequisites

- Python 3.11+
- tmux installed (`brew install tmux` on macOS)
- cloudflared CLI installed (`brew install cloudflared` on macOS)
- Claude CLI installed and configured

## Installation

1. Clone the repository:
```bash
cd ClaudeTunnel
```

2. Create virtual environment and install dependencies:
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

3. Copy environment template:
```bash
cp .env.example .env
```

4. Run the setup script to verify all dependencies:
```bash
./setup.sh
```

5. Configure Cloudflare (for named tunnels):
```bash
# Edit .env and add:
CLOUDFLARE_API_TOKEN=your_api_token_here
CLOUDFLARE_ZONE_ID=your_zone_id
CLOUDFLARE_DOMAIN=claude.adoom.nyc
CLOUDFLARE_TUNNEL_NAME=claude-controller
```

See [Cloudflare Setup](#cloudflare-setup) section below for details.

## Usage

### Starting the Server

```bash
# Activate virtual environment
source venv/bin/activate

# Start the API server
python3 -m src.main
```

The server will start on `http://0.0.0.0:8000`

### API Endpoints

**Create a session:**
```bash
curl -X POST http://localhost:8000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"auto_start_claude": true}'
```

**Get session info:**
```bash
curl http://localhost:8000/api/v1/sessions
```

**Send a command:**
```bash
curl -X POST http://localhost:8000/api/v1/sessions/command \
  -H "Content-Type: application/json" \
  -d '{"command": "help"}'
```

**Get recent logs:**
```bash
curl http://localhost:8000/api/v1/sessions/logs?limit=50
```

**List active tunnels:**
```bash
curl http://localhost:8000/api/v1/tunnels
```

**Destroy session:**
```bash
curl -X DELETE http://localhost:8000/api/v1/sessions
```

### WebSocket Terminal

Connect to `ws://localhost:8000/ws/terminal` for real-time terminal streaming.

**Receive messages:**
- Log entries: `{"type": "log", "content": "...", "log_type": "stdout"}`
- Tunnel created: `{"type": "tunnel_created", "tunnel": {...}}`

**Send commands:**
```json
{"type": "command", "command": "your command here"}
```

## Architecture

```
┌─────────────────────────────────┐
│     MacBook (Host Machine)      │
│                                 │
│  ┌───────────────────────────┐ │
│  │  Claude Code (tmux)       │ │
│  │  - Single persistent      │ │
│  │    session                │ │
│  └───────────────────────────┘ │
│              ↕                  │
│  ┌───────────────────────────┐ │
│  │  Control Plane (Python)   │ │
│  │  - Session manager        │ │
│  │  - Log monitor            │ │
│  │  - Tunnel manager         │ │
│  │  - Auto-tunnel            │ │
│  └───────────────────────────┘ │
│              ↕                  │
│  ┌───────────────────────────┐ │
│  │  API Gateway (FastAPI)    │ │
│  │  - REST endpoints         │ │
│  │  - WebSocket streaming    │ │
│  └───────────────────────────┘ │
│              ↕                  │
└──────────────┼──────────────────┘
               ↓
    ┌──────────────────────┐
    │   Mobile/Web Client  │
    │   - Terminal view    │
    │   - Command input    │
    │   - Tunnel links     │
    └──────────────────────┘
```

## How It Works

1. **Session Creation**: Creates a tmux session and automatically launches Claude with `--dangerously-skip-permissions`
2. **Log Monitoring**: Polls terminal output every 500ms and streams to WebSocket clients
3. **Pattern Detection**: Regex patterns detect when dev servers start
4. **Auto-Tunneling**: When `localhost:PORT` is detected, automatically creates Cloudflare tunnel
5. **Broadcasting**: Tunnel URLs broadcast to all connected WebSocket clients
6. **Persistence**: Session metadata saved to JSON, survives server restarts

## Configuration

Edit `.env` to customize:

```bash
# Server
HOST=0.0.0.0
PORT=8000

# Sessions
DEFAULT_WORKING_DIR=~/claude-projects
SESSION_TIMEOUT=3600

# Tunnels
AUTO_CREATE_TUNNELS=true
TUNNEL_TIMEOUT=30

# Logging
LOG_BUFFER_SIZE=1000
```

## Cloudflare Setup

The system supports two tunnel modes:

### 1. Quick Tunnels (Default - Free)
Uses Cloudflare's `trycloudflare.com` service. No account required but:
- ❌ URLs change on restart
- ❌ No custom domain
- ❌ Subject to rate limits
- ❌ Service can be unstable

### 2. Named Tunnels (Recommended - Free with Account)
Uses your Cloudflare account with persistent custom domains:
- ✅ Stable URLs like `3000.claude.adoom.nyc`
- ✅ Automatic CNAME creation
- ✅ CNAMEs reused across restarts
- ✅ Single tunnel, multiple ports

**Setup Named Tunnels:**

1. **Authenticate cloudflared**:
```bash
cloudflared login
```
This opens a browser for OAuth authentication.

2. **Get Cloudflare API credentials**:
   - Go to: https://dash.cloudflare.com/profile/api-tokens
   - Click "Create Token"
   - Use template: "Edit zone DNS"
   - Add permissions: `Zone.DNS:Edit` and `Account.Cloudflare Tunnel:Edit`
   - Copy the token

3. **Get Zone ID**:
   - Go to your domain's overview in Cloudflare dashboard
   - Scroll down to "API" section
   - Copy the "Zone ID"

4. **Configure `.env`**:
```bash
USE_NAMED_TUNNELS=true
CLOUDFLARE_API_TOKEN=your_token_here
CLOUDFLARE_ZONE_ID=your_zone_id
CLOUDFLARE_DOMAIN=claude.adoom.nyc
CLOUDFLARE_TUNNEL_NAME=claude-controller
```

5. **Start the server**:
The system will automatically:
- Create the named tunnel `claude-controller`
- Start the tunnel process
- Create CNAMEs like `3000.claude.adoom.nyc` when ports are detected
- Reuse CNAMEs on subsequent starts

**How it works:**
- Single persistent tunnel: `claude-controller`
- Dynamic ingress rules added for each detected port
- CNAMEs created via Cloudflare API: `{port}.claude.adoom.nyc`
- Tunnel config auto-reloaded when ports added/removed

## Troubleshooting

### Session won't create
- Ensure tmux is installed: `which tmux`
- Check tmux sessions: `tmux ls`
- Try manually: `tmux new -s test`

### Tunnels not creating
- Ensure cloudflared is installed: `which cloudflared`
- Test manually: `cloudflared tunnel --url http://localhost:3000`
- Check logs in terminal output

### Can't connect from phone
- Ensure phone is on same WiFi network
- Find Mac's IP: `ifconfig | grep inet`
- Try: `http://192.168.1.x:8000/health`
- Check firewall settings

### Claude not starting
- Ensure claude is in PATH: `which claude`
- Check tmux session: `tmux attach -t claude-code-session`
- Look at session logs via API

## Development

### Project Structure

```
ClaudeTunnel/
├── src/
│   ├── main.py              # FastAPI app
│   ├── config.py            # Configuration
│   ├── models.py            # Data models
│   ├── core/
│   │   ├── session_manager.py
│   │   ├── log_monitor.py
│   │   ├── tunnel_manager.py
│   │   └── auto_tunnel.py
│   ├── api/
│   │   ├── routes.py
│   │   ├── websocket.py
│   │   └── deps.py
│   └── utils/
│       ├── tmux.py
│       └── patterns.py
└── tests/
```

### Running Tests

```bash
pytest tests/ -v
```

## Roadmap

- [x] Core session management
- [x] Real-time terminal streaming
- [x] Auto-tunnel creation
- [x] REST API
- [x] WebSocket streaming
- [ ] Web UI client
- [ ] Native iOS app
- [ ] Push notifications
- [ ] Multiple concurrent sessions
- [ ] Session recording/playback

## License

MIT

## Contributing

Pull requests welcome! Please open an issue first to discuss major changes.
