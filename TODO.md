# Cloude Code Weekend MVP — Implementation TODO

Source plan: `/Users/Adam/.claude/plans/i-want-you-to-graceful-narwhal.md` (v3.1)
Branch: weekend-mvp-v3.1

## Milestone A — Foundation
- [x] Item 1: tmux-backed session persistence — **[ITEM-1] [2026-04-19T12:06:49Z]: completed**
- [x] Item 2: Tunnel manager refactor (pluggable backends) — **[ITEM-2] [2026-04-19T12:16:34Z]: completed**
- [ ] Item 3: WS subprotocol JWT auth
- [ ] Item 4: TOTP rate limit (slowapi)
- [ ] Item 5: JWT refresh tokens + SQLite revocation store

## Milestone B — Notifications
- [ ] Item 6: Notification module (ntfy.sh)
- [ ] Item 7: IdleWatcher state machine
- [ ] Item 8: Notification rate limiter
- [ ] Item 9: Deep-link routing + CSP middleware

## Milestone C — Docker packaging
- [ ] Item 10: Dockerfile (pure-container)
- [ ] Item 11: docker-compose.yml + preflight bind-IP script
- [ ] Item 13: .dockerignore
- [ ] Item 14: README deployment modes + docs

## Sub-agent findings (append-only, no overwrite)
(Sub-agents append `[AGENT-NAME] [ISO-timestamp]: finding` lines here as they complete items.)
[ITEM-2] [2026-04-19T12:16:34Z]: completed — TunnelManager router + LocalOnlyBackend/QuickCloudflareBackend/NamedCloudflareBackend created under src/core/tunnel/. HybridTunnelManager preserved as legacy shim. config.py + config.example.json + .env.example updated. main.py wires TunnelManager.from_settings and guards verify_public_access on backend.supports_public(). auto_tunnel.py updated to work with dict-shape tunnels. 34/34 tests pass. Cloudflare-less boot confirmed via /health smoke.
