# Troubleshooting

## Python Dependencies

### Pydantic version compatibility with Python 3.13
**Issue**: `pydantic==2.5.0` and `pydantic-core==2.14.1` fail to build on Python 3.13 due to `ForwardRef._evaluate()` missing required argument.

**Solution**: Update to newer versions:
- `pydantic>=2.10.0`
- `pydantic-settings>=2.6.0`
- `fastapi>=0.115.0`
- `uvicorn>=0.32.0`

These versions have prebuilt wheels for Python 3.13 on ARM64 macOS.

### Structlog logging_level error
**Issue**: `TypeError: make_filtering_bound_logger() got an unexpected keyword argument 'logging_level'`

**Solution**: Use `wrapper_class=structlog.BoundLogger` instead of `make_filtering_bound_logger(logging_level=20)` in structlog.configure()

### Log directory not found
**Issue**: `[Errno 2] No such file or directory: '/tmp/claude-code-logs/session_metadata.json'`

**Solution**: Create the log directory before starting:
```bash
mkdir -p /tmp/claude-code-logs
```

## Tmux

### Session already exists
**Issue**: Creating session fails with "session already exists"

**Solution**:
```bash
# List existing sessions
tmux -L claude-controller ls

# Kill existing session
tmux -L claude-controller kill-session -t claude-code-session
```

## Cloudflare Tunnels

### Tunnel URL not detected
**Issue**: Tunnel process starts but URL extraction times out

**Check**:
1. Verify cloudflared is installed: `which cloudflared`
2. Test manually: `cloudflared tunnel --url http://localhost:3000`
3. Check stderr output from tunnel process
4. Increase `TUNNEL_TIMEOUT` in .env

### Cloudflare service error (Error 1101)
**Issue**: `ERR Error unmarshaling QuickTunnel response` or `Worker threw exception`

**Cause**: Cloudflare's trycloudflare.com free tunnel service is experiencing temporary issues

**Solutions**:
1. Wait and retry later (usually resolves within minutes/hours)
2. Use a Cloudflare account with named tunnels (more reliable)
3. Use alternative tunnel provider (ngrok) - requires code modification

## WebSocket

### Connection refused
**Issue**: Client can't connect to WebSocket

**Check**:
1. Server running: `curl http://localhost:8000/health`
2. WebSocket URL correct: `ws://localhost:8000/ws/terminal`
3. CORS settings in config allow your origin
4. No firewall blocking WebSocket connections

### Stale session on startup (requires manual destroy/create)
**Issue**: After running `stop.sh`, next startup shows an old session that doesn't work. User must manually destroy and create new session.

**Root Cause**:
- `stop.sh` kills PTY processes but leaves session metadata file
- On startup, app tries to restore session from metadata but PTY is dead
- Creates "zombie" session that appears active but has no working PTY

**Fix Applied** (v1.0.1):
- Session manager now auto-deletes stale session metadata on startup
- Validates PTY process exists before restoring session
- Enhanced `has_active_session()` to check PTY validity
- WebSocket disconnect errors handled gracefully

**If issue persists**:
```bash
# Manually delete stale metadata
rm /tmp/claude-code-logs/session_metadata.json

# Restart service
./stop.sh && ./start.sh
```

## Common Patterns

### Check if server is running
```bash
curl http://localhost:8000/health
```

### View active tmux sessions
```bash
tmux -L claude-controller ls
```

### Attach to Claude Code session manually
```bash
tmux -L claude-controller attach -t claude-code-session
```

### Check session metadata
```bash
cat /tmp/claude-code-logs/session_metadata.json
```

### Kill all tunnels
```bash
pkill -f cloudflared
```
