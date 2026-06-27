# ACTIVE BUG: session-click injects `/clear` and wipes context

## Symptom (confirmed via user screenshots)
- Clicking the title "cloude_cloudecode" returns to launchpad, clicking the session again REJOINS it.
- On rejoin, the literal text `/clear` is injected into the Claude Code TUI input box AND executed.
- Fresh "Claude Code v2.1.187" startup banner redraws; status bar shows `ctx:?` = CONTEXT ACTUALLY WIPED (real data loss, not cosmetic).

## Suspect regression
- Commit bbb5f8b "snap viewport to bottom on session rejoin" (touched client/js/terminal.js) is prime suspect.
- Rejoin chain: launchpad.js:637 -> app.js:518 returnToExistingTerminal() -> terminal.js:873 reconnectToExistingSession().

## Investigation status
- [x] ROOT CAUSE: locate exact file:line where `/clear` reaches the PTY (ws.send/sendInput) on rejoin
- [x] Determine which commit introduced it
- [x] Implement minimal fix at root cause
- [x] Validate via validator-agent (rejoin a session, confirm NO /clear injected, context preserved)
- [x] Commit

## Findings log
(sub-agents append here: [AGENT] [TIMESTAMP]: finding)

[IMPLEMENTER] [2026-06-23]: Fixed accidental /clear on launchpad rejoin. Removed the client-side Ctrl+L (0x0c) wire send in client/js/terminal.js ws.onopen (was gated on _needsReplayCtrlL, sent at +50ms). It collided with the server's authoritative handshake 0x0c (src/api/websocket.py ~:363, fallback ~:381, sent ~+200ms after dims+SIGWINCH). Two 0x0c <2s apart = Claude Code TUI's /clear chord → context wipe. Now exactly ONE 0x0c (server's) reaches the PTY per rejoin. Snap-to-bottom preserved independently via _pendingPostConnectScroll/_forceScrollToBottom (local xterm op, no wire write). Added a WHY comment so nobody reintroduces it.

[VERIFIER] [2026-06-23]: Adversarial verification PASSED all 5 checks (no residual client 0x0c, no server self-collision, no double-reconnect, repaint ordering intact, snap-to-bottom intact). PTY now receives exactly ONE 0x0c per rejoin. HIGH confidence (static). Remaining: one live byte-capture on real rejoin.

[STATUS] [2026-06-23]: Root cause = double Ctrl+L (0x0c) within 2s on rejoin triggering Claude Code's fullscreen /clear chord. Fix = removed redundant client-side 0x0c send in client/js/terminal.js (added by bbb5f8b); server handshake 0x0c (websocket.py:363) is now sole redraw source. Snap-to-bottom preserved.

[RELEASE] [2026-06-23]: Shipped v0.7.4 end-to-end. DEV b12f491 tagged+pushed; DMG built+signed (sha 954d4b26...); GitHub release live at github.com/Adoom666/CloudeCode/releases/tag/v0.7.4; PROD main pushed c7b08dd. Validation green (1x 0x0c per rejoin).

---

## RELEASE PLAN — v0.7.4 (chosen: validate-then-full-release)
- [x] Launch DEV server (bundled venv, 0.0.0.0:5001+, bg) WITHOUT disrupting running menubar app
- [x] Validate rejoin: confirm exactly ONE 0x0c per rejoin, NO /clear, context preserved
- [x] Bump macOS/package.json -> 0.7.4
- [x] cd macOS && npm run package (build DMG)
- [x] git tag -a v0.7.4 + push tag
- [x] gh release create v0.7.4 --repo Adoom666/CloudeCode with the DMG
- [x] Update README.md download URL + sha256, commit/push DEV (weekend-mvp-v3.1)
- [x] rsync -a --delete DEV -> PROD with verified excludes (.claude/, TODO.md, auth sentinels excluded)
- [x] PROD: verify on branch `main`, git add -A && commit "release: v0.7.4" && git push origin main
- NOTE: NEVER author code in PROD. PROD only receives rsync + release commit. PROD branch is `main` not `master`.

---

# Cloude Code v0.7.2 Release — SHIPPED 🤘

**Status:** COMPLETE

Originally planned as v0.7.0; pivoted to v0.7.2 because v0.7.0 and v0.7.1 were already published.

---

## Pipeline — ALL COMPLETE

- [x] 1. README regenerated via /makeReadme — all v0.7.0/v0.7.1/v0.7.2 features documented
- [x] 2. macOS/package.json version bumped 0.6.1 → 0.7.2
- [x] 3. DMG built: macOS/dist/Cloude Code-0.7.2-arm64.dmg (93 MB)
- [x] 4. SHA256 computed: `4f6638acf63645e6a631572b120119e6ea1b804337bbea68e2180d4b4422c3d7`
- [x] 5. README updated with v0.7.2 Download URL + SHA256
- [x] 6. Security review of DEV diff — CLEAN
- [x] 7. Committed on DEV (after rebase onto origin to absorb tmux mouse fix)
- [x] 8. Tagged v0.7.2 + pushed to origin
- [x] 9. GH Release created: https://github.com/Adoom666/CloudeCode/releases/tag/v0.7.2
- [x] 10. Rsync DEV → PROD with documented exclude list
- [x] 11. PROD: git add -A + commit "release: v0.7.2" + git push origin main
- [x] 12. DMG mount validation — PASS

---

## Shipped commits (DEV)

- 96abcbf feat: restore launchpad pencil-icon rename UX for running sessions
- bbb5f8b fix(terminal): snap viewport to bottom on session rejoin
- 810d508 release: v0.7.2

## Shipped commits (PROD)

- e575250 release: v0.7.2

---

## Final Validation Results

- **File exists + size:** 93 MB ✓
- **SHA256 match:** YES (`4f6638acf63645e6a631572b120119e6ea1b804337bbea68e2180d4b4422c3d7`) ✓
- **Mount:** SUCCESS at `/Volumes/Cloude Code 0.7.2` ✓
- **Contents verified:** `Cloude Code.app` present, `/Applications` symlink present ✓
- **Bundle check:** MacOS executable exists ✓
- **Detach:** SUCCESS ✓

---

## Notes for next promotion cycle

- Stale `src/core/tunnel/__pycache__/` in PROD causes rsync warning. One-time cleanup: `rm -rf "/Users/Adam/Dropbox/My Projects/Cloude Code Repos/Prod/CloudeCode/src/core/tunnel/__pycache__"`
- `config.json.bak.YYYYMMDD-HHMMSS` files leak through rsync. Either gitignore them in DEV or add `--exclude='*.bak.*'` to the playbook rsync.
- Backup branch `backup/pre-v0.7.2-rebase` preserved on DEV — safe to delete after a few days if everything stays stable.

---

## Folder Picker UX Enhancements (in progress)

- [ ] Backend: add `POST /filesystem/mkdir` endpoint (Path.mkdir parents=True, expanduser/resolve, mirror browse security) returning a BrowseResponse of the created dir
- [ ] Backend: make `GET /filesystem/browse` return HTTP 404 for missing/non-directory paths
- [ ] Frontend: convert read-only `#folder-picker-path` to an editable `<input>`; Enter navigates to typed path
- [ ] Frontend: on Enter, if browse 404s, call mkdir endpoint then navigate (auto mkdir -p)
- [ ] Frontend: type-ahead nav in folder list (accumulating buffer, 800ms reset, case-insensitive prefix, scroll into view); inactive while path input focused
- [ ] Frontend: keep path input in sync as user clicks/jumps folders
- [ ] Validate via validator-agent

### Agent notes
(sub-agents append here: [AGENT-NAME] [TIMESTAMP]: finding)

[BACKEND-SME] [done]: Added POST /filesystem/mkdir (model MkdirRequest in src/models.py:393, returns BrowseResponse) via make_directory in src/api/routes.py:1326-1357; factored shared _build_browse_response helper (routes.py:1252) and made GET /filesystem/browse 404 on missing OR non-directory paths.
[BACKEND-SME] [done]: Verified w/ bundled menubar venv — import/route registration + functional tests pass (mkdir -p creates+lists+idempotent, browse missing/file->404, mkdir-over-file->400).

[FRONTEND-SME] [done]: api.js — call() now sets err.status on non-2xx (~line 132) + new makeDirectory(path) POST /filesystem/mkdir (~line 357). launchpad.js — rewrote showFolderPickerModal() (~2078-2310): editable .folder-picker-path input, type-ahead (800ms buffer, startsWith match, .folder-picker-item-active highlight + scrollIntoView), ↑/↓ nav, Enter-on-active opens folder, path-bar Enter browses→on 404 auto-mkdir+navigate w/ inline "created <path>" status; capture-phase doc keydown removed on close (no leak); default focus = list.
[FRONTEND-SME] [done]: styles.css — .folder-picker-path now an address-bar input w/ focus glow + placeholder (~1555), .folder-picker-status success/error variants, .folder-picker-item-active (accent bg + inset accent bar, ~1631). node --check passed on both JS files.

---

## Release v0.7.5 — Full Prod Publish (in progress)

- [x] Bump version 0.7.4 -> 0.7.5 (all package.json + version chip sources) and commit "release: v0.7.5"
- [x] Verify codesigning identity (TeamID 3ZVEJNEQ9G) present
- [x] Build DMG: cd macOS && npm run package -> macOS/dist/Cloude Code-0.7.5-arm64.dmg
- [x] Verify new folder-picker code is inside the DMG bundle (mkdir endpoint in routes.py, type-ahead in launchpad.js)
- [x] Compute DMG sha256
- [x] git tag v0.7.5 + push tag
- [x] gh release create v0.7.5 with DMG asset
- [x] Update README download URL + sha256 (if present) and push
- [ ] rsync DEV->PROD (/Prod/CloudeCode, branch main) DRY-RUN, analyze deletions
- [ ] rsync real (only if dry-run clean), commit "release: v0.7.5 — sync from DEV"
- [ ] git fetch + check prod main not ahead, then push origin main

[RELEASE-BUILD] [done]: v0.7.5 bumped (macOS/package.json) + committed 0759288; signing identity "Apple Development: Adam Callen" TeamID 3ZVEJNEQ9G confirmed on signed .app; DMG built at macOS/dist/Cloude Code-0.7.5-arm64.dmg (97697844 bytes, sha256 236a08f7d0b7f1b5e80ce421ed1c16f2b1cbc6b50036d513b2d842c10b2807e0); in-DMG new-code verify PASS (routes.py filesystem/mkdir + launchpad.js folder-picker-status/type-ahead); .app signed+valid, DMG wrapper unsigned (normal for electron-builder), notarization absent (expected).

[RELEASE-PUBLISH] [done]: Pushed weekend-mvp-v3.1 (b12f491..0759288) to origin Adoom666/CloudeCodeDev; annotated tag v0.7.5 created at 0759288 + pushed; GitHub release live at https://github.com/Adoom666/CloudeCodeDev/releases/tag/v0.7.5 with DMG asset https://github.com/Adoom666/CloudeCodeDev/releases/download/v0.7.5/Cloude.Code-0.7.5-arm64.dmg (97697844 bytes); README bumped 0.7.4->0.7.5 + sha256 236a08f7... — PROD CloudeCode host PRESERVED (README link is promoted DEV->PROD, so it must keep pointing at public repo, not CloudeCodeDev).

