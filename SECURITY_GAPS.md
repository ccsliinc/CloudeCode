# Cloude Code - Complete Architecture Analysis

## What Is This App?

**Cloude Code** is a remote control platform for Claude Code CLI sessions. It lets you code from anywhere (couch, phone, tablet) by exposing your local Claude Code session over the internet through Cloudflare tunnels.

**Core value prop:** Control Claude Code remotely via web terminal + auto-detect dev servers and create public tunnel URLs with zero config.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        REMOTE CLIENT                                │
│  (Browser on phone/tablet/laptop anywhere on internet)              │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ HTTPS (Cloudflare Tunnel)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     CLOUDFLARE EDGE                                 │
│  (Quick tunnels: random URL, Named tunnels: custom domain)         │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ cloudflared process
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     LOCAL MACHINE (macOS)                           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Electron Menu Bar App (macOS/main.js)                       │  │
│  │  - Tray icon with status indicators                          │  │
│  │  - Manages Python server lifecycle                           │  │
│  │  - Auto-launch via LaunchAgent                               │  │
│  │  - Health polling every 5s                                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                │                                    │
│                                │ spawns/manages                     │
│                                ▼                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  FastAPI Backend (src/main.py - port 8000)                   │  │
│  │                                                               │  │
│  │  REST API Endpoints:                                          │  │
│  │  - POST /api/v1/auth/verify (TOTP → JWT)                     │  │
│  │  - POST/GET/DELETE /api/v1/sessions                          │  │
│  │  - GET/POST/DELETE /api/v1/tunnels                           │  │
│  │  - GET /health (no auth, for menu bar polling)               │  │
│  │                                                               │  │
│  │  WebSocket Endpoint:                                          │  │
│  │  - /ws/terminal (real-time PTY streaming)                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                │                                    │
│                                │ manages                            │
│                                ▼                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  SessionManager + PTY Session                                 │  │
│  │  - Spawns bash shell → runs Claude CLI                       │  │
│  │  - Bidirectional I/O via pseudo-terminal                     │  │
│  │  - Persists session metadata (survives restarts)             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                │                                    │
│                                │ monitors output                    │
│                                ▼                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  LogMonitor + AutoTunnelOrchestrator                         │  │
│  │  - Watches for "localhost:PORT" patterns                     │  │
│  │  - Auto-creates Cloudflare tunnel when detected              │  │
│  │  - Broadcasts tunnel_created event to all clients            │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Client-Server Communication Deep Dive

### 1. Authentication Flow

```
TOTP (Time-based One-Time Password)
       │
       ▼
POST /api/v1/auth/verify {code: "123456"}
       │
       ▼
Server validates with pyotp (±1 window for clock drift)
       │
       ▼
Returns JWT token {token: "...", expires_in: 1800}
       │
       ▼
Stored in localStorage['claude_tunnel_token']
       │
       ▼
All subsequent requests: Authorization: Bearer {token}
```

**Auth Files:**
- `/src/api/auth.py` - TOTP verification, JWT creation (lines 108-159)
- `/client/js/auth.js` - TOTP input UI, token storage

### 2. Session Creation

```
POST /api/v1/sessions
{
  working_dir: "/path/to/project",
  auto_start_claude: true,
  copy_templates: true
}
       │
       ▼
SessionManager.create_session()
       │
       ├──> Spawns PTY (pseudo-terminal)
       ├──> Forks bash shell process
       ├──> Runs: claude --dangerously-skip-permissions
       │
       ▼
Returns: {id, pty_pid, working_dir, status}
```

**Session Files:**
- `/src/core/session_manager.py` - PTY lifecycle management (14.8K lines)
- `/src/utils/pty_session.py` - Low-level PTY handling (8.2K lines)
- `/src/api/routes.py:85-150` - Session REST endpoints

### 3. WebSocket Terminal Connection

```
WS /ws/terminal?token={jwt}
       │
       ▼
Token verified via verify_jwt_token()
       │
       ▼
ConnectionManager.connect(websocket)
       │
       ▼
Subscribes to 3 async queues:
├── pty_output_queue (terminal bytes)
├── tunnel_queue (tunnel events)
└── log_queue (system messages)
       │
       ▼
Spawns 4 concurrent async tasks:
├── receive_messages() - Client input → PTY
├── send_pty_output() - PTY output → Client
├── send_queue_messages(tunnel) - Tunnel events
└── send_queue_messages(log) - Log events
```

**WebSocket Protocol:**

| Direction | Format | Description |
|-----------|--------|-------------|
| Client → Server | Binary (UTF-8) | User keyboard input |
| Client → Server | JSON | `{type: "pty_resize", cols, rows}` |
| Client → Server | JSON | `{type: "ping"}` (keepalive) |
| Server → Client | Binary | Raw PTY output bytes |
| Server → Client | JSON | `{type: "tunnel_created", tunnel}` |
| Server → Client | JSON | `{type: "log", content}` |
| Server → Client | JSON | `{type: "pong"}` |
| Server → Client | JSON | `{type: "error", message}` |

**WebSocket Files:**
- `/src/api/websocket.py` - Server-side handler (lines 72-298)
- `/client/js/terminal.js` - Client WebSocket + xterm.js (lines 391-558)

### 4. Auto-Tunnel Detection

```
Terminal output: "Server running on localhost:3000"
       │
       ▼
LogMonitor.detect_patterns()
  Pattern: "localhost:PORT" or "Listening on port"
       │
       ▼
AutoTunnelOrchestrator.on_port_detected(3000)
  - Checks if tunnel already exists for port
  - Prevents duplicates
       │
       ▼
HybridTunnelManager.create_tunnel(3000)
  ├── Quick Tunnel: `cloudflared tunnel --url http://localhost:3000`
  │   → Returns random URL: https://xxx.trycloudflare.com
  │
  └── Named Tunnel: Cloudflare API + DNS CNAME
      → Returns custom URL: https://3000.yourdomain.com
       │
       ▼
Broadcasts to all WebSocket clients:
{type: "tunnel_created", tunnel: {id, port, public_url, status}}
```

**Tunnel Files:**
- `/src/core/auto_tunnel.py` - Pattern detection → tunnel creation (5.1K lines)
- `/src/core/hybrid_tunnel_manager.py` - Abstract tunnel interface (5.8K lines)
- `/src/core/tunnel_manager.py` - Quick tunnels via cloudflared (8.8K lines)
- `/src/core/named_tunnel_manager.py` - Cloudflare API tunnels (16K lines)
- `/src/utils/patterns.py` - Port detection regex patterns (5.9K lines)

---

## Directory Structure

```
cloudecode/
├── src/                              # Python Backend
│   ├── main.py                       # FastAPI entry point
│   ├── config.py                     # Pydantic settings
│   ├── models.py                     # Data models, message types
│   ├── api/
│   │   ├── routes.py                 # REST endpoints
│   │   ├── websocket.py              # WebSocket terminal
│   │   └── auth.py                   # TOTP/JWT auth
│   ├── core/
│   │   ├── session_manager.py        # PTY session lifecycle
│   │   ├── log_monitor.py            # Terminal output monitoring
│   │   ├── auto_tunnel.py            # Auto-detect ports → create tunnels
│   │   ├── hybrid_tunnel_manager.py  # Tunnel abstraction
│   │   ├── tunnel_manager.py         # Quick tunnels (cloudflared)
│   │   ├── named_tunnel_manager.py   # Named tunnels (Cloudflare API)
│   │   └── cloudflare_api.py         # Cloudflare SDK wrapper
│   └── utils/
│       ├── pty_session.py            # Low-level PTY handling
│       ├── patterns.py               # Port/server regex patterns
│       └── template_manager.py       # Project template copying
│
├── client/                           # Web Frontend
│   ├── index.html                    # SPA shell
│   ├── css/styles.css                # Dark theme styles
│   └── js/
│       ├── api.js                    # REST + WebSocket client
│       ├── auth.js                   # TOTP auth UI
│       ├── terminal.js               # xterm.js integration
│       ├── launchpad.js              # Project picker
│       ├── dpad.js                   # Mobile controls
│       └── slash-commands.js         # Command palette
│
├── macOS/                            # Electron Menu Bar App
│   ├── main.js                       # Main process (634 lines)
│   ├── server-manager.js             # Python server lifecycle (795 lines)
│   ├── launchagent-installer.js      # Auto-launch config
│   └── assets/                       # Icons
│
├── .env                              # Secrets (not committed)
├── config.json                       # User config (projects, commands)
├── requirements.txt                  # Python deps
├── start.sh                          # Start server
└── setup_auth.py                     # Generate TOTP/JWT secrets
```

---

## Key Files by Function

### Entry Points
| File | Purpose |
|------|---------|
| `/src/main.py` | FastAPI app, route mounting, lifespan |
| `/client/index.html` | SPA shell, loads JS modules |
| `/macOS/main.js` | Electron main process, tray menu |

### Authentication
| File | Purpose |
|------|---------|
| `/src/api/auth.py:108-159` | TOTP verification, JWT creation |
| `/client/js/auth.js` | TOTP input UI, token storage |

### WebSocket Communication
| File | Purpose |
|------|---------|
| `/src/api/websocket.py:72-153` | WS endpoint, auth, message routing |
| `/src/api/websocket.py:155-227` | Receive client input → PTY |
| `/src/api/websocket.py:230-269` | Send PTY output → client |
| `/client/js/terminal.js:391-422` | WS connection setup |
| `/client/js/terminal.js:461-525` | Message handling, binary/JSON |

### PTY Session Management
| File | Purpose |
|------|---------|
| `/src/core/session_manager.py` | Session lifecycle, persistence |
| `/src/utils/pty_session.py` | Fork, exec, I/O handling |

### Auto-Tunneling
| File | Purpose |
|------|---------|
| `/src/core/auto_tunnel.py:93-99` | Port detected → create tunnel |
| `/src/utils/patterns.py` | Regex for localhost:PORT |
| `/src/core/hybrid_tunnel_manager.py` | Tunnel strategy abstraction |

### Menu Bar App
| File | Purpose |
|------|---------|
| `/macOS/main.js:187-535` | Tray menu, status display |
| `/macOS/server-manager.js:296-459` | Python server spawn/kill |
| `/macOS/server-manager.js:540-608` | Health polling |

---

## Configuration

### Environment Variables (.env)
```bash
# Server
HOST=0.0.0.0
PORT=8000
DEFAULT_WORKING_DIR=~/Documents/Cloude

# Auth (generated by setup_auth.py)
TOTP_SECRET=base32_secret
JWT_SECRET=random_hex

# Tunnels
TUNNEL_PROVIDER=cloudflared
AUTO_CREATE_TUNNELS=true
USE_NAMED_TUNNELS=false  # true = custom domains

# Cloudflare (for named tunnels)
CLOUDFLARE_API_TOKEN=xxx
CLOUDFLARE_ZONE_ID=xxx
CLOUDFLARE_DOMAIN=yourdomain.com
CLOUDFLARE_TUNNEL_ID=xxx
```

### config.json
```json
{
  "jwt_expiry_minutes": 30,
  "projects": [
    {"name": "my-project", "path": "~/code/my-project", "description": "..."}
  ],
  "common_slash_commands": ["/help", "/clear", "/config", ...]
}
```

---

## Security Model

1. **TOTP** - 2FA gate (Google Authenticator compatible)
2. **JWT** - 30 min tokens, HS256, required for all protected endpoints
3. **WebSocket Auth** - Token in query param, verified on connect
4. **CORS** - Configurable allowed origins
5. **Secrets** - .env not committed, cloudflare creds scoped

---

## Data Flow Summary

```
[Mobile Browser] ──HTTPS──> [Cloudflare Tunnel] ──> [localhost:8000]
                                                          │
                                    ┌─────────────────────┴─────────────────────┐
                                    │                                           │
                              [REST API]                               [WebSocket]
                                    │                                           │
                    ┌───────────────┼───────────────┐         ┌────────────────┴───────────────┐
                    │               │               │         │                                │
              /auth/verify    /sessions      /tunnels    Binary PTY I/O              JSON Events
                    │               │               │         │                                │
              TOTP→JWT      Create/Destroy   List/Create  Keyboard↔Terminal        tunnel_created
                            PTY Session      Cloudflare                             log, error
```

---

---

# Security Improvements from Happy Project Analysis

**Last verified against code: 2026-06-25.**

## Executive Summary

Analyzed three repos from slopus/happy ecosystem. They've built a zero-knowledge E2E encrypted architecture with some solid security patterns we should adopt. Also found gaps we should avoid.

This doc was written against an earlier snapshot of the codebase and had drifted:
two of the items it originally flagged as open (rate limiting, CORS) are now
implemented. The verification pass below re-checked every item against the
current code, not just the two that changed. Status tags per item:

| Item | Status | Where it lives |
| --- | --- | --- |
| Rate limiting & brute-force protection | **RESOLVED** (rate limiting + replay dedup) — brute-force lockout beyond that is still open | `src/api/auth.py`, `src/main.py` |
| CORS hardening | **RESOLVED** | `src/config.py` |
| Scoped connection types | **STILL OPEN** | n/a |
| Token expiry handling (client refresh) | **RESOLVED** | `client/js/auth.js` |
| Brute-force lockout (temp ban after N failures) | **STILL OPEN** | n/a |
| Everything else below (E2E encryption, key derivation, RPC encryption, secure token storage, secret-key backup format, encrypted errors, cert pinning) | **STILL OPEN / not attempted**, unchanged from original analysis | n/a |

---

## Security Features Worth Adopting

### 1. End-to-End Encryption (HIGH PRIORITY)

**What Happy Does:**
- Zero-knowledge architecture - server CANNOT decrypt user data
- All session data encrypted with per-session keys
- Uses NaCl/libsodium (XSalsa20-Poly1305) + AES-256-GCM
- Ephemeral keypairs per message for forward secrecy

**Current Cloude Code:**
- No encryption of session data
- Server sees all terminal output in plaintext
- Tunnel URLs visible to anyone with access

**Recommendation:**
```
Priority: MEDIUM (nice-to-have for V2)
Complexity: HIGH
```
For now, our TOTP + JWT + Cloudflare HTTPS is adequate. Full E2E would require client-side encryption of all terminal data before WebSocket transmission.

---

### 2. Hierarchical Key Derivation (MEDIUM PRIORITY)

**What Happy Does:**
```typescript
// HMAC-SHA512 key tree (BIP32-style)
const I = await hmac_sha512(
    new TextEncoder().encode(usage + ' Master Seed'),
    seed
);
return {
    key: I.slice(0, 32),
    chainCode: I.slice(32)
};
```
- Derive per-session, per-machine, per-artifact keys from master
- Domain separation via usage strings
- Can't derive one key from another without the path

**Current Cloude Code:**
- Single JWT_SECRET for all tokens
- Single TOTP_SECRET for auth

**Recommendation:**
```
Priority: LOW
Complexity: MEDIUM
```
Our current single-secret model is fine for a single-user app. Would matter more for multi-tenant.

---

### 3. WebSocket RPC Encryption (MEDIUM PRIORITY)

**What Happy Does:**
```typescript
// All RPC calls encrypted with session-specific keys
async sessionRPC(sessionId, method, params) {
    const sessionEncryption = this.encryption.getSessionEncryption(sessionId);
    const result = await this.socket.emitWithAck('rpc-call', {
        method: `${sessionId}:${method}`,
        params: await sessionEncryption.encryptRaw(params)
    });
    return await sessionEncryption.decryptRaw(result.result);
}
```

**Current Cloude Code:**
- WebSocket messages sent as plaintext JSON/binary
- Relies on TLS (HTTPS/WSS) for transport encryption

**Recommendation:**
```
Priority: LOW
Complexity: HIGH
```
Our Cloudflare tunnel provides TLS encryption. Additional layer-7 encryption is defense-in-depth but overkill for our use case.

---

### 4. Scoped Connection Types (HIGH PRIORITY) ⭐ — STILL OPEN (verified 2026-06-25)

**What Happy Does:**
```typescript
// Three connection types with different access levels
'user-scoped'      // All user data
'session-scoped'   // Single session only
'machine-scoped'   // Daemon/machine specific
```
WebSocket validates scope and restricts data access accordingly.

**Current Cloude Code:**
- Single connection type - full access once authenticated
- No granular scoping
- **Verified 2026-06-25**: `src/api/websocket.py` and `src/models.py` still have
  no `ConnectionScope` enum or `clientType` param. Still genuinely open, not a
  doc-drift case.

**Recommendation:**
```
Priority: MEDIUM
Complexity: MEDIUM
Files to modify:
- /src/api/websocket.py (add clientType param)
- /src/models.py (add ConnectionScope enum)
- /client/js/api.js (pass scope in WS auth)
```
Could be useful if we add multi-session support later.

---

### 5. Rate Limiting & Brute Force Protection (HIGH PRIORITY) ⭐ — RATE LIMITING RESOLVED, LOCKOUT STILL OPEN (verified 2026-06-25)

**What Happy DOESN'T Do (and neither do we):**
- No rate limiting on auth endpoints
- No exponential backoff on failed auth
- Infinite polling without limits

**Current Cloude Code (as of this verification pass):**
- Rate limiting is implemented: `src/api/auth.py` wires a slowapi `Limiter`
  onto `POST /api/v1/auth/verify` at a configurable
  `"{totp_verify_per_minute}/minute;{totp_verify_per_hour}/hour"` limit,
  defaulting to `5/minute;20/hour` (`AuthRateLimits` in `src/config.py`).
  Client key is per-IP, with an opt-in `trust_proxy_headers` mode that reads
  the leftmost `X-Forwarded-For` entry when the app sits behind a reverse
  proxy. `/api/v1/auth/refresh` is separately capped at `10/minute`. The
  limiter is mounted in `src/main.py` and `slowapi>=0.1.9` is in
  `requirements.txt`.
- A second layer we didn't originally scope for: `src/api/auth.py` also keeps
  a 90-second `TTLCache` keyed on the submitted TOTP code, so a captured
  valid code can't be replayed within pyotp's own `valid_window=1` (±30s)
  acceptance window. Concurrent submissions are serialized under an
  `asyncio.Lock` to close the check-then-insert race.
- What is **still missing**: exponential backoff or a temporary lockout
  after N consecutive failed attempts. The slowapi limit is a flat window,
  not a growing penalty, and there's no ban state — once the window rolls
  over, a client gets a fresh budget of attempts. This is the same gap
  called out separately below under "Brute force lockout" in the roadmap;
  we're not double-counting it as resolved.

**Recommendation:**
```
Priority: HIGH
Complexity: LOW
Files to modify:
- /src/api/auth.py (add rate limiting decorator)
- /src/main.py (add slowapi or similar middleware)
```

**Implementation — DONE, differs slightly from the original sketch below:**
```python
# requirements.txt
slowapi>=0.1.9

# src/api/auth.py — key func supports optional trust-proxy mode, and the
# limit string is built from AuthConfig instead of hardcoded:
limiter = Limiter(key_func=_rate_limit_key, headers_enabled=True)

@router.post("/auth/verify", response_model=AuthTokenResponse)
@limiter.limit(_totp_rate_limit)  # "5/minute;20/hour" by default, configurable
async def verify_totp(request: Request, response: Response, body: VerifyTOTPRequest):
```
`headers_enabled=True` also gets us `X-RateLimit-*` and `Retry-After` on 429s
for free, which the original sketch didn't call for but is worth keeping.

**What's left for the "brute force lockout" half of this item** (still open,
also tracked under Phase 2 below): a lockout/backoff state that persists
past a single rate-limit window. Today, once a window rolls over, the
attempt budget simply resets.

---

### 6. Secure Token Storage (MEDIUM PRIORITY)

**What Happy Does:**
```typescript
// Native platforms use OS secure storage
if (Platform.OS === 'web') {
    localStorage.getItem(AUTH_KEY);  // Web fallback
} else {
    SecureStore.getItemAsync(AUTH_KEY);  // Keychain/Keystore
}
```

**Current Cloude Code:**
- Web only - uses localStorage (plaintext)

**Recommendation:**
```
Priority: LOW
Complexity: N/A (web-only app)
```
We're web-only, so localStorage is our only option. Could add sessionStorage for shorter-lived tokens.

---

### 7. User-Friendly Secret Key Format (LOW PRIORITY)

**What Happy Does:**
```typescript
// Base32 with typo correction (1Password style)
formatSecretKeyForBackup(secretKey) {
    // "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
    // Auto-corrects: 0→O, 1→I, 8→B, 9→G
}
```

**Current Cloude Code:**
- TOTP secret is base32 (Google Authenticator compatible)
- No backup format for secret key

**Recommendation:**
```
Priority: LOW
Complexity: LOW
```
Nice UX improvement for manual secret entry, but we use QR codes.

---

### 8. Encrypted Error Responses (MEDIUM PRIORITY)

**What Happy Does:**
```typescript
// Errors encrypted - no info leakage
catch (error) {
    const errorResponse = { error: error.message };
    return encodeBase64(encrypt(key, errorResponse));
}
```

**Current Cloude Code:**
- Error messages sent as plaintext JSON
- Stack traces logged (but not sent to client)

**Recommendation:**
```
Priority: LOW
Complexity: MEDIUM
```
Our errors are generic enough. Main thing is ensuring no stack traces leak to client (we're good here).

---

### 9. CORS Hardening (HIGH PRIORITY) ⭐ — RESOLVED (verified 2026-06-25)

**What Happy Does WRONG:**
```typescript
cors: {
    origin: "*",  // WIDE OPEN - BAD!
    credentials: true,
    allowedHeaders: ["*"]
}
```

**Current Cloude Code (as of this verification pass):**
`settings.allowed_origins` in `src/config.py` is a computed property, not a
static default, and it never returns `"*"`. Precedence:
1. If the `ALLOWED_ORIGINS` env var is set, it's split on `,` and used
   verbatim (operator override).
2. Otherwise the property builds a safe allowlist from `HOST` + `PORT` plus
   loopback and mDNS hostname variants (`http://localhost:<port>`,
   `http://127.0.0.1:<port>`, `http://<hostname>:<port>`,
   `http://<hostname>.local:<port>`, and the literal bind address when
   `HOST` isn't `0.0.0.0`).

The code comment is explicit about why: CORS middleware in `src/main.py` is
wired with `allow_credentials=True`, and wildcard-origin plus credentials is
the exact footgun this section originally warned about — so the default
deliberately can never produce `"*"`.

**What we did NOT end up doing** (differs from the original sketch below):
we didn't hardcode a literal placeholder list like
`["http://localhost:8000", "https://yourdomain.com"]`. The computed
HOST/PORT/hostname approach means a fresh install works out of the box on
whatever LAN hostname the machine actually has, without the user needing to
edit `.env` first.

**Original recommendation (superseded by the implementation above, kept for context):**
```
Priority: HIGH
Complexity: LOW
Files to modify:
- /src/config.py (add explicit origin list)
- /src/main.py (use restrictive CORS)
- /.env.example (document ALLOWED_ORIGINS)
```

```python
# Original sketch — NOT what shipped, see "Current Cloude Code" above
allowed_origins: list[str] = Field(
    default=["http://localhost:8000", "https://yourdomain.com"],
    description="Explicitly allowed CORS origins"
)
```

---

### 10. Certificate Pinning (LOW PRIORITY)

**What Happy Doesn't Do:**
- No certificate pinning
- Standard TLS only

**Current Cloude Code:**
- Same - relies on Cloudflare/system TLS

**Recommendation:**
```
Priority: LOW
Complexity: HIGH
```
Overkill for our use case. Cloudflare handles TLS termination.

---

## Security Gaps in Happy We Should Avoid

| Issue | Happy Status | Our Status | Action |
|-------|--------------|------------|--------|
| Token cache memory leak | ❌ Unbounded Map | ✅ JWT expires + server-side refresh store with rotation/revocation | Keep our approach |
| CORS wide open | ❌ origin: "*" | ✅ Computed safe allowlist, never `"*"`, `src/config.py` | **RESOLVED, verified 2026-06-25** |
| No rate limiting | ❌ Missing | ✅ slowapi 5/min;20/hour + TOTP replay dedup, `src/api/auth.py` | **RESOLVED, verified 2026-06-25** — brute-force *lockout* beyond the rate window is still open, see Phase 2 |
| 100MB body limit | ❌ Too high | ✅ Default (no explicit oversized limit set) | Keep default |
| Debug logging default | ❌ Level: debug | ✅ `log_level="info"` in `src/main.py`; spot-checked `logger.*` calls in `src/api/auth.py` — codes/jti are truncated before logging, no raw secrets found | **Reviewed, no gap found** |
| Infinite WebSocket reconnect | ❌ Infinity | ✅ Max 5 attempts | Keep our approach |

---

## Recommended Security Roadmap

### Phase 1: Quick Wins (Do Now) — DONE, verified 2026-06-25
1. ~~**Add rate limiting to auth endpoints**~~ — done, `5/minute;20/hour` per IP,
   configurable via `AuthRateLimits` (`src/config.py`), plus a TOTP replay-dedup
   cache that wasn't in the original plan.
2. ~~**Harden CORS**~~ — done, computed allowlist, never `"*"`
   (`src/config.py: Settings.allowed_origins`).
3. ~~**Review logging**~~ — done, no tokens/secrets found in log calls.

### Phase 2: Improvements (V1.1)
4. **Add connection scoping** - session-scoped vs user-scoped — **still open**,
   verified 2026-06-25 (`src/api/websocket.py`, `src/models.py`).
5. ~~**Token expiry handling** - Client-side token refresh~~ — **done**.
   `client/js/auth.js` implements `refresh()` against `POST /auth/refresh`,
   backed server-side by `src/core/refresh_store.py` with rotation and
   reuse-detection (revokes the whole chain on a replayed refresh token).
6. **Brute force lockout** - Temporary ban after N failures — **still open**.
   The rate limiter (item 1 above) caps *rate*, not cumulative failures; there
   is no lockout state that survives a window rollover.

### Phase 3: Advanced (V2) — unchanged, still open
7. **End-to-end encryption** - Client-side encryption of terminal data
8. **Per-session encryption keys** - Key derivation from master secret
9. **Encrypted error responses** - Prevent info leakage

---

## Files Modified for Phase 1 (as actually implemented)

| File | Change |
|------|--------|
| `/src/main.py` | Wires `app.state.limiter`, `SlowAPIMiddleware`, and the CORS middleware reading `settings.allowed_origins` |
| `/src/api/auth.py` | `Limiter` instance, `_rate_limit_key` (proxy-aware), `_totp_rate_limit` (config-driven), TOTP replay-dedup `TTLCache` |
| `/src/config.py` | `AuthRateLimits` model + `Settings.allowed_origins` computed property (never `"*"`) |
| `/requirements.txt` | `slowapi>=0.1.9` |

`/.env.example` does not need an `ALLOWED_ORIGINS` line to work correctly —
the computed default is safe without it — though setting it is how an
operator opts into a custom origin list.

---

## Summary

Happy has solid crypto (NaCl, AES-256-GCM, HMAC-SHA512 key derivation) but weak operational security (no rate limiting, CORS wide open). Original plan, with outcomes:

1. **Steal:** Rate limiting pattern (once they add it), connection scoping —
   rate limiting done; connection scoping still not started.
2. **Skip:** Full E2E encryption (overkill for single-user), cert pinning —
   still skipped, no change.
3. **Fix:** CORS (we have the same gap), add rate limiting — both done, see
   items 5 and 9 above.

Remaining genuinely open items as of 2026-06-25: scoped connection types,
brute-force lockout beyond the rate-limit window, and everything in the
Phase 3 / "not adopted" bucket (E2E encryption, hierarchical key derivation,
WebSocket RPC encryption, OS-level secure token storage, secret-key backup
formatting, encrypted error responses, certificate pinning) — all unchanged
from the original analysis.
