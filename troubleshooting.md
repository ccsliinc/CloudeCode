# CloudeCode Troubleshooting

## Auto-Tunnel Not Detecting Ports (Oct 30, 2025)

### Problem
Port 3000 running locally wasn't accessible via https://3000.claude.adoom.nyc/ - auto-tunnel wasn't detecting it.

### Root Cause
Pattern detection in `log_monitor.py` was completely disabled. The monitoring loop (lines 90-95) just sleeps without processing PTY output. Pattern detection code was commented out (lines 98-119), so auto-tunnel never saw terminal output and couldn't detect ports.

### Solution
Modified `src/api/websocket.py`:
- Added pattern detection to `send_pty_output()` function (lines 248-256)
- PTY output is now decoded and analyzed for port patterns before sending to client
- Pattern detection runs without breaking output streaming

### Manual Tunnel Creation (Temporary Fix)
To immediately fix port 3000 accessibility:
1. Added ingress rule to `/Users/Adam/.cloudflared/claude-controller.yml`:
   ```yaml
   - hostname: 3000.claude.adoom.nyc
     service: http://127.0.0.1:3000
   ```
2. Killed 14 duplicate cloudflared processes
3. Restarted single cloudflared instance with updated config

### Cloudflare Tunnel Issues
- Multiple duplicate cloudflared processes were running (found 14 instances)
- Each restart creates a new process without killing old ones
- Solution: Kill all cloudflared processes before starting new one

### SSL Certificate Issue
- CNAME `3000.claude.adoom.nyc` exists and points to correct tunnel
- SSL handshake failing at Cloudflare edge
- DNS resolves correctly (104.21.59.133, 172.67.177.233)
- HTTP redirects to HTTPS (301) but HTTPS fails
- Likely cause: SSL cert not provisioned for subdomain yet (can take minutes to hours)

### Next Steps
1. Server needs restart to apply pattern detection fix
2. Test auto-tunnel with new server startup
3. Wait for Cloudflare SSL cert provisioning (check in 30 minutes)
4. Verify https://3000.claude.adoom.nyc/ works

### Files Modified
- `/Users/Adam/Dropbox/My Projects/CloudeCode/src/api/websocket.py` - Added pattern detection to PTY output stream
- `/Users/Adam/.cloudflared/claude-controller.yml` - Added port 3000 ingress rule

### Important Notes
- Auto-tunnel feature was broken since PTY switch
- Will now work for future port detections
- Server restart required to apply fix
