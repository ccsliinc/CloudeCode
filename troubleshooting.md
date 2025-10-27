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

## WebSocket

### Connection refused
**Issue**: Client can't connect to WebSocket

**Check**:
1. Server running: `curl http://localhost:8000/health`
2. WebSocket URL correct: `ws://localhost:8000/ws/terminal`
3. CORS settings in config allow your origin
4. No firewall blocking WebSocket connections

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
