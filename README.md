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
- claude-code CLI installed and configured

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

4. (Optional) Configure settings in `.env`:
```bash
# Default settings work for most use cases
# Customize working directory, ports, etc. as needed
```

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

1. **Session Creation**: Creates a tmux session and automatically launches `claude-code`
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

### Claude Code not starting
- Ensure claude-code is in PATH: `which claude-code`
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
