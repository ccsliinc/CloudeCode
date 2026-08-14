## 🚀 README OVERHAUL — 2026-08-13

**Goal:** Replace the 1604-line README.md with a world-class public-launch README for the GitHub repo, with real screenshots and generated hero art.

**Decisions (locked by user):**
- Audience: public GitHub launch (conversion-focused)
- Screenshots: automated headless capture + user supplies real iPhone shots later
- Art style: match app's own palette — coral `#d77757` on near-black `#0a0a0a`/`#1e1e1e`, text `#d4d4d4`
- Assets live in `docs/assets/` and get committed

**Tasks:**
- [x] Recon: backend architecture + feature enumeration
- [x] Recon: frontend/client UI feature enumeration
- [x] Recon: mine session prompt history for feature intent
- [x] Recon: existing docs, assets, branding, palette
- [x] Synthesize master feature spec from all recon
- [x] Generate hero banner + brand art in app palette
- [x] Boot app locally, capture 12 headless screenshots
- [x] Author new README.md
- [x] Validate: all image paths resolve, no overclaimed features
- [ ] Commit

**Follow-up work surfaced during the README build (NOT fixed — these are real bugs):**
- [ ] `./setup.sh` is broken — hard-exits without `cloudflared`, still prompts for Cloudflare API token/zone/domain. Leftover from the removed tunnel subsystem.
- [ ] `AuthConfig.session.tmux_socket_name` is a dead config knob — `build_backend()` never threads it into the `TmuxBackend` constructor, so every backend uses the hardcoded `DEFAULT_SOCKET_NAME` regardless of config.json.
- [ ] Vestigial tunnel UI in the menu-bar tray: `Tunnels: N` line permanently reads 0; teardown dialog still mentions Cloudflare DNS records.
- [ ] `cloudflare` and `pyyaml` remain in requirements.txt, wired to nothing.
- [ ] `docs/assets/social-card.png` was generated (1280x640) but is intentionally unreferenced by README — set it as the repo's social preview in GitHub repo Settings → General → Social preview.
- [ ] Old v0.2 screenshots still sit in `docs/images/` and are no longer referenced. Delete if unwanted.
- [ ] Retired headless mobile screenshots are still on disk but unreferenced by README: `mobile-terminal-live`, `mobile-launchpad`, `mobile-fab-open`, `mobile-provider-modal`, `mobile-dpad`, `mobile-slash-commands`, `mobile-paperclip-menu`, and the 4 `mobile-theme-*` files, all in `docs/assets/screenshots/`. Delete if you don't want them in git history.

**Accuracy guardrails (MUST NOT violate):**
- Cloudflare tunnel subsystem was DEMOLISHED in branch weekend-mvp-v3.1 — do NOT describe as a live feature
- No PWA / manifest / service worker exists — do not claim
- No voice input, no file browser, no diff viewer, no QR rendering — do not claim
- Latest release is v0.8.1 (README changelog is stale at v0.7.3 — fix it)

---

# ACTIVE: clipboard paste (paperclip menu) + terminal copy in browser — ship as DMG, deploy locally

## Goal
1. Paperclip (📎 attach) menu gains a "Paste from local clipboard" option: clipboard TEXT is injected into the terminal input; clipboard IMAGE keeps the existing upload flow (`_uploadAndInjectImage`, terminal.js:519 → POST /sessions/upload-image).
2. Copy from the web terminal: selecting text in xterm.js + Cmd+C (mac) / Ctrl+Shift+C (win/linux) writes selection to system clipboard via navigator.clipboard.writeText. Must NOT swallow Ctrl+C (SIGINT) when no selection. Also add a "copy" affordance for touch users if trivially in scope.
3. Validate both in a real browser, build the DMG, kill the running instance, install + relaunch.

## Established facts (from recon — do NOT re-derive)
- App = FastAPI server (src/main.py) wrapping Claude Code in tmux; client = vanilla JS + xterm.js over WebSocket (client/js/terminal.js, 1727 lines); packaged as Electron tray app (macOS/, electron-builder, `npm run package` builds DMG into macOS/dist).
- Input path: terminal.js:268 `term.onData` → binary WS frame → websocket.py:452 → session_manager.send_input → tmux_backend.py:959-991 (>256B or control chars → bracketed paste via load-buffer/paste-buffer -p; else send-keys).
- terminal.js:383 `attachCustomKeyEventHandler` currently intercepts ONLY Shift+Enter — extend here for copy chord.
- Image paste already intercepted: terminal.js:439 `_applyPasteHandler` (capture-phase paste listener on #terminal). iOS 📎 attach path ~line 485 uses `navigator.clipboard.read()`.
- CSP `script-src 'self'` (src/main.py:252) — no inline scripts. Theme vars client/css/styles.css:13. Copy tone: lowercase labels.
- Keep files <500 lines: put clipboard logic in NEW module (e.g. client/js/clipboard.js) loaded after terminal.js; wire minimally.
- navigator.clipboard.read()/readText() need a secure context (localhost/LAN http OK? — verify; app is served on LAN http, so check actual availability and degrade gracefully with a status toast, no crash).
- DMG build: `cd macOS && npm run package`. Signing identity "Apple Development: Adam Callen" (3ZVEJNEQ9G) previously present.
- sme skill NOT installed in this env — sub-agents skip it.

## Tasks — ALL COMPLETE ✅ (2026-08-06)
- [x] IMPLEMENT — clipboard.js (paperclip paste option + copy chord) wired into terminal.js/index.html
- [x] VALIDATE — 6/6 PASS in headed Chromium (menu, 1-frame text paste, SIGINT safety, copy, image upload 201, no regressions)
- [x] BUILD — macOS/dist/Cloude Code-0.8.1-arm64.dmg (97,760,585 B, sha256 388a374d…25440, signed, clipboard.js verified in bundle)
- [x] DEPLOY — old instance quit, new .app rsynced into /Applications, relaunched (PID 23562), server 200 on :8000, clipboard.js served, 6/6 live tmux sessions untouched
- [x] COMMIT — b28df6c on weekend-mvp-v3.1 (5 files, secret scan clean, not pushed)

## Known non-issues surfaced during validation
- 📎 button is display:none except on coarse-pointer (touch) devices — intended mobile UX; flip the media query in styles.css if desktop should see it too.
- Pre-existing (NOT from this change): session.tmux_socket_name in config.json is dead config for new sessions — build_backend() (src/core/session_backend.py:264) never passes socket_name, hardcoded `cloude` wins; only adopt-external honors it. Flagged for a future fix.

## ROUND 2 — touch-device bugs (reported by user on phone, 2026-08-06) — ALL COMPLETE ✅
- [x] FIX menu anchoring: root cause = positionMenu() used right/bottom math off window.innerWidth/innerHeight, which diverges from iOS visualViewport (URL bar collapse / keyboard shift) → menu parked bottom-left, cut off. Fixed: left/top from button rect + visualViewport clamp (clipboard.js:195-220).
- [x] FEATURE touch copy: NEW client/js/touch-select.js — long-press (500ms/10px) → select mode → synthetic MouseEvents (detail:1) drive xterm's own SelectionService → floating clamped "copy" button → clipboard.writeText(term.getSelection()). Plain drag still scrolls; coarse-pointer gated; desktop unchanged. Validated iPhone 13 emulation (menu in-viewport above button, select+copy round-trip, scroll regression clean, outside-tap dismiss, desktop zero-change).
- [x] BUILD — Cloude Code-0.8.1-arm64.dmg rebuilt (97,780,470 B, sha256 f7ac2ae3…5367), touch-select.js verified in bundle
- [x] DEPLOY — graceful quit → rsync into /Applications → relaunch (PID 70286), :8000 200, touch-select.js served, 6/6 tmux sessions untouched
- [x] COMMIT — 38018c3 on weekend-mvp-v3.1 (6 files +443/-9, scan clean, not pushed)
- Note: bottom-left ~45px of terminal is owned by the slash-commands FAB — long-press can't start there (correct behavior).

## Findings log
<!-- [AGENT-NAME] [TIMESTAMP]: finding -->
[CLIPBOARD-IMPL] [2026-08-06]: Implemented in NEW client/js/clipboard.js (287 lines, loaded after terminal.js in index.html:103): paperclip 📎 now opens a fixed menu ("paste from clipboard" → navigator.clipboard.read() image→_uploadAndInjectImage / text→insertText as ONE WS frame for the >256B bracketed-paste heuristic, readText() fallback, pill degradation on LAN-http/denial; "attach image" → original file picker) + copy chord (Cmd+C / Ctrl+Shift+C with term.hasSelection() → navigator.clipboard.writeText, selection kept; bare Ctrl+C never intercepted). terminal.js edits are hook-points only: _applyKeyHandlers delegates to ClipboardTools.handleCopyChord (terminal.js:389), _applyImageAttachButton delegates to ClipboardTools.wireAttachButton (terminal.js:497). Reused: insertText (send path), _showStatusPill (status), _uploadAndInjectImage (image flow). Menu CSS appended at styles.css:2333 (z-index 71). node --check passes both files. NOT yet browser-validated.

---

## ARCHIVE: always-new-session on project click (SHIPPED)

[MULTISESSION-SME] [2026-08-04]: Changed `SessionManager.create_session`'s
"adopt-on-collision" block (`src/core/session_manager.py:1547-1595`, was
lines 1547-1575 pre-change) from redirecting into `adopt_external_session`
on a tmux-name collision to a **uniquifier**: appends `-2`, `-3`, ... to the
derived `cloude_<name>` until free, capped at 999 attempts (raises
`RuntimeError` if exhausted — should never happen in practice). Collision
check is the UNION of three sources: `probe.discover_existing()` (live tmux
socket — tmux's own hard-fail source), `self.active_tmux_names()` (live
in-memory backends), and `self.owned_tmux_sessions` (persisted, includes
detached-but-not-destroyed). This matches `rename_session`'s own collision
guard (`active OR owned_tmux_sessions`, line ~2010) so a name minted here
can never later be rejected by the rename guard. Suffix is appended AFTER
`_sanitize_tmux_name` so it's never mangled.

Client-side (`client/js/launchpad.js`): NO changes. `selectProject()`
(`:2363`) already unconditionally POSTs `/sessions` — no gating change
needed; the fix is entirely server-side and also covers
`_createNewSessionInner`'s same `/sessions` call for free. Investigated the
"already running" dead-code claim from recon (`detachAndOpenProject` at
`:2426`, catch blocks at `:1460`/`:1561`/`:2412`): confirmed the ONLY
server-side "already running" strings are internal double-`start()` guards
in `tmux_backend.py`/`pty_session.py` that can't fire through
`create_session`'s fresh-backend-per-call path — genuinely unreachable dead
code. Left it in place anyway per task scope discipline (not the point of
this task, no upside to the risk of missing a caller).

Tests: replaced `test_create_session_adopts_when_target_name_exists` (old
adopt-on-collision behavior, now wrong) with
`test_create_session_uniquifies_when_target_name_exists` (asserts `-2`,
asserts the pre-existing session is untouched) and added
`test_create_session_uniquifies_third_collision` (asserts `-3` when both
base and `-2` are taken). Both pass. Full suite: 394/395 passing, same 1
pre-existing unrelated failure (`test_ensure_pipe_pane_does_not_clobber_existing_pipe`)
confirmed present on `git stash` (unmodified branch) too.

Empirical verification against a real dev server (port 5051, scratch
config/working-dir, same shared `cloude` tmux socket as the live app — did
NOT touch any real `cloude_*` session or the live app's `config.json`,
sha256 confirmed byte-identical before/after): 3x `POST /sessions` with
identical `project_name`/`working_dir` → `cloude_zz_multisession_scratch_test`,
`-2`, `-3`, all three live tmux sessions in the same working_dir, all three
rows in `GET /sessions/list`. Destroyed `-2` → `-3` and the base session
unaffected. Detached the base session, then `POST /sessions/adopt` targeted
it by exact tmux name → landed in that exact session, `-3` untouched
throughout. All 6 success criteria met.

Known acceptable degradations (per-directory theme, shared uploads dir,
name-based deep link) — did not fix, confirmed no crash: all 3 sessions
created and ran fine in the same working_dir with no exceptions.

---

# ACTIVE: Provider selector modal on session launch

## Goal
Every path that spawns a NEW CLI session first shows a provider-selection modal.
- Pick **Claude** → launch `cld`
- Pick any OpenRouter model → launch `cldor <model>`
- Models are add/remove-able inline in the same modal, persisted in `config.json`.

Rejoin/adopt of an already-running tmux session is OUT OF SCOPE (no command is built there).

## Established facts (recon complete — do NOT re-derive)

**Architecture:** Electron (`macOS/main.js`) is only a tray + Python-server supervisor;
`macOS/preload.js` exposes an EMPTY api. There is NO Electron IPC launch surface.
Real app = vanilla-JS client (`client/js/`, no build step) → HTTP → Python FastAPI → tmux.

**Single choke point for command construction:**
- `SessionManager.create_session` — `src/core/session_manager.py:1427`
- resolves command at `src/core/session_manager.py:1597` via `settings.get_agent_command(agent_type)`
- spawns at `src/core/session_manager.py:1598`
- builder: `Settings.get_agent_command()` — `src/config.py:380-432` (returns ONE shell string)
- tmux spawn: `src/core/tmux_backend.py:359-372` — command appended as a single argv
  element; **tmux itself shell-parses it** (no shlex.split on our side).

**agent_type precedence already implemented server-side:** request → ProjectConfig → "claude"
(`src/core/session_manager.py:1473-1487`).

**`cld` / `cldor` are zsh FUNCTIONS in `~/.zshrc` (subshell form), NOT executables.**
- `cld` (~/.zshrc:247-286): pulls OAuth token from macOS Keychain (`claude-cld-oauth`),
  unsets all OpenRouter/Bedrock/Vertex vars, runs `command claude --dangerously-skip-permissions "$@"`.
- `cldor` (~/.zshrc:297-360): pulls key from Keychain (`claude-cldor-openrouter`),
  sets `CLAUDE_CONFIG_DIR=$HOME/.claude-cldor`, `ANTHROPIC_BASE_URL=https://openrouter.ai/api`,
  `ANTHROPIC_AUTH_TOKEN`, blank `ANTHROPIC_API_KEY`, and maps
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL` to `$1`.
  Takes first non-option arg as the model, `shift`s, forwards `"$@"` to
  `$HOME/.local/bin/claude --dangerously-skip-permissions --model <model>`.
- **Consequence:** tmux spawns a NON-interactive shell which does not source `.zshrc`,
  so the command MUST be wrapped so the functions exist. NO secret is ever handled by
  this app — the Keychain lookup happens inside the zsh function.

**Existing client conventions to REUSE (do not invent):**
- Modal pattern: `client/js/launchpad.js:1322` `showConfirmModal` (canonical smallest example).
  DOM shape `.modal-overlay > .modal-content > .modal-header/.modal-body/.modal-footer`,
  built imperatively, `document.body.appendChild`, returns a Promise.
- **Esc bug to avoid:** `overlay.addEventListener('keydown')` only fires when focus is inside.
  Use the folder-picker fix: capture-phase `document.addEventListener('keydown', fn, true)`
  removed on close (`client/js/launchpad.js:2125,2262`).
- Keyboard list (arrows + Enter + type-ahead + hover-sync): folder picker
  `client/js/launchpad.js:2145,2225-2260`; styles `client/css/styles.css:1634-1690`
  (`.folder-picker-list`, `.folder-picker-item`, `.folder-picker-item-active`).
- Modal CSS tokens: `client/css/styles.css:1201-1340`. Theme vars at `client/css/styles.css:13`.
- API wrapper: `client/js/api.js:59` `call()` (auth headers, propagates `error.status`).
- **CSP is `script-src 'self'`** (`src/main.py:252`) — no inline scripts, no eval.
- Copy tone: lowercase labels, headers prefixed `» `.

**Launch entry points that must be gated (all in `client/js/launchpad.js`):**
- `_createNewSessionInner()` :1464 → builds payload, calls `API.createSession` :1504
  (covers FAB `new-project` :1386, and `createNewSessionWithAgent()` :1395 for openclaw/hermes)
- `selectProject()` :2307 → `API.createSession` :2318
  (covers existing-project row click :1040, folder-picker open :1994/:2078,
   clone-from-github success :1845, deep link `/session/<name>` via router.js:36-48 → :1962,
   `detachAndOpenProject()` :2354)
- `createConsoleSession()` :1409 — agent_type `shell`, NOT gated (no Claude CLI involved)
- `detachAndCreateNew()` :1928 — re-enters `_createNewSessionInner`, inherits the gate

Gating those TWO functions covers every path. Do NOT add a gate per call site.

## Contract (both workstreams code against this — do not deviate)

### config.json (repo root, `Settings.auth_config_file` — `src/config.py:250`)
New top-level block. Absent = defaults apply.
```json
"providers": { "models": ["qwen/qwen3.8-max", "moonshotai/kimi-k3", "openai/gpt-5.6-sol"] }
```
"Claude" is implicit, always the first option, never stored in this list, never removable.

### Model id validation (BOTH server and client)
Regex: `^[A-Za-z0-9._~/-]{1,120}$`. Reject anything else with 400.
This is the shell-injection guard — enforce it server-side regardless of client checks.

### REST API (new)
- `GET    /api/v1/providers`                     → `{"models": [...]}`
- `POST   /api/v1/providers/models`              body `{"model": "..."}` → `{"models": [...]}`
                                                   400 invalid format, 409 duplicate
- `DELETE /api/v1/providers/models/{model:path}` → `{"models": [...]}`, 404 if absent

### Session create
`CreateSessionRequest` (`src/models.py:157-196`) gains:
`model: str | None = None`  — None => Claude (`cld`). Set => OpenRouter (`cldor <model>`).
Same validation regex. Persist onto the Session alongside `agent_type`
(`src/core/session_manager.py:1620`).

### Command building — `Settings.get_agent_command(agent_type, model=None)` (`src/config.py:380`)
- `agent_type == "claude"`, `model` falsy → run `cld`
- `agent_type == "claude"`, `model` set   → run `cldor <model>`
- all other agent_types (codex/hermes/openclaw/shell) → UNCHANGED
Must be wrapped so `~/.zshrc` is sourced. Quote with `shlex.quote`; never raw-concat the model.

## Tasks
- [ ] **BACKEND** — config schema, `get_agent_command`, `CreateSessionRequest.model`,
      provider REST endpoints, validation. Empirically verify the zsh wrapper actually
      starts Claude Code inside a real tmux session.
- [ ] **FRONTEND** — provider selector modal (keyboard-first, reuses folder-picker list
      pattern) with inline add/remove rows; gate `_createNewSessionInner` + `selectProject`;
      CSS in `client/css/styles.css`.
- [ ] **VALIDATE** — validator-agent confirms modal appears on every new-session path and
      that both `cld` and `cldor <model>` sessions actually come up live.

## Findings log
<!-- [AGENT-NAME] [TIMESTAMP]: finding -->

[FIX-SME] [2026-08-03]: Fixed pre-commit-persist ordering bug. `openProjectFromFolder` (:2022) called `saveProjectWithUniqueName` (config.json write) BEFORE `selectProject`'s internal provider-modal await, orphaning the project row on Esc — hoisted `showProviderModal()` to right after the project-name modal, before the persist call. `showCloneFromGithubModal` (:1722) had the same shape one level deeper: backend `POST /projects/clone` clones to disk AND persists the project entry atomically in a single call, invoked before `selectProject`'s gate — hoisted the provider modal to the very top of `showCloneFromGithubModal`, before the clone form is even shown, so the clone/persist request never fires pre-commit. Both hoisted (no rollback needed — the clone's disk write is real user data pre-existing before the gate even applies now, so it's a non-issue, not an excused side effect). To avoid double-prompting, extended `selectProject(project, providerChoice)` with an optional pre-resolved second arg — callers that already gated pass their choice through; existing-project/deep-link/detach-retry callers still call it with one arg and get the original single-prompt behavior. `_createNewSessionInner` (:1464) was already correctly ordered (provider modal → project name modal → createSession → createProject persist) — audited, no bug, no change. `node --check` passes.

[FRONTEND-SME] [2026-08-03]: Built provider selector modal in NEW file client/js/providers.js (340 lines, attaches showProviderModal() onto window.Launchpad; loaded after launchpad.js in client/index.html:94-97). Reuses .folder-picker-list/-item/-active/-status markup+CSS and the folder-picker's capture-phase document keydown pattern (removed on close) verbatim — no new nav implementation. Added 4 new CSS classes only (.provider-item-name, .provider-item-remove, .provider-add-row, .provider-add-input) in client/css/styles.css, all on theme vars. api.js gained getProviders()/addProviderModel()/removeProviderModel() (DELETE URL-encodes the model id for the `/` in ids). Gated _createNewSessionInner (launchpad.js:1473) and selectProject (launchpad.js:2329) — provider modal awaited before payload build; null=abort, payload.model set only when a model was chosen (omitted for claude). createConsoleSession left ungated as specified. Verified detachAndCreateNew/detachAndOpenProject re-enter the two gated functions via setTimeout and so re-show the provider modal on retry — this matches the PRE-EXISTING behavior where the project-name modal also re-prompts on that same retry path, so it's not a new regression, just consistent with how retry-after-detach already worked.

Nested-modal handling: removing a model opens showConfirmModal on top of the provider modal; a `confirmPending` flag makes the provider modal's document-capture keydown listener go inert while the confirm dialog is up, so Escape/Enter there don't also get intercepted by the outer modal. Add-model Escape closes just the inline add-input (revert to "+ add model" row) rather than the whole modal, via the same capture listener checking an `addInputOpen` flag before falling through to the default close(null).

Last-used choice persisted under single localStorage key `cloude_provider_last_model` (empty string = claude). Client-side regex `^[A-Za-z0-9._~/-]{1,120}$` enforced before POST, matching the contract; server 400/409 still surfaced inline via .folder-picker-status--error on top of that.

Not covered by frontend (per contract, backend's job): actual config.json persistence, server-side validation, get_agent_command wiring, CreateSessionRequest.model field — could not live-test end-to-end since GET/POST/DELETE /api/v1/providers and the session model field 404/ignore until backend lands (expected per task notes, not a frontend bug).

[BACKEND-SME] [2026-08-03]: Empirically settled the zsh wrapper: `zsh -c 'source ~/.zshrc >/dev/null 2>&1; cld'` (and `cldor <model>` variant) — chosen over `zsh -ic 'cld'`. Both rendered the Claude Code TUI cleanly with zero leading garbage in a real detached scratch-socket tmux session (`tmux -L cloude_test_N`, verified via `tmux capture-pane -p -S -100`), and BOTH Keychain entries (`claude-cld-oauth`, `claude-cldor-openrouter`) resolved headlessly with NO ACL/GUI prompt — so the documented Keychain-headless risk did NOT materialize on this machine. Picked `zsh -c 'source ...'` anyway: narrower surface (explicit rc source, `>/dev/null 2>&1` silences any stray output, skips interactive-shell machinery/job-control/oh-my-zsh update checks entirely) vs `-ic` which is more exposed to future rc-file noise. Model is shlex-quoted TWICE (inner `cldor <model>` token boundary + outer `zsh -c` boundary via `shlex.quote(inner_script)`) — proven via direct `subprocess.run(["zsh","-c",cmd])` round-trip (mirrors tmux's internal `$SHELL -c <string>` exec) that `; rm -rf /`, backticks, `$(...)`, and a leading `~` all stay a single literal argv token (ARGC:1), no execution, no tilde-expansion. Full end-to-end proof: created a REAL session via the live API with `model="openai/gpt-5.6-sol"`, tmux pane rendered the OpenRouter-routed Claude Code TUI cleanly (capture-pane confirmed), cleaned up after. CRITICAL FINDING: none — no blockers. Implemented `providers` config block + `get_provider_models/add_provider_model/remove_provider_model` (src/config.py, cache-invalidated same pattern as save_project), `get_agent_command(agent_type, model=None)` rewrite (claude branch now ALWAYS uses cld/cldor, `agents.claude_command`/`CLAUDE_CLI_PATH` marked LEGACY/bypassed — this is a deliberate behavior change per the contract, existing tests in tests/test_session_agent_type.py updated accordingly, all 56 pass), `CreateSessionRequest.model` + `Session.model` with regex `^[A-Za-z0-9._~/-]{1,120}$` (src/models.py, shared `MODEL_ID_PATTERN`/`_MODEL_ID_RE`), 3 REST endpoints (src/api/routes.py) matching the contract exactly incl. `{model:path}` for slash-containing ids. Added a global `RequestValidationError`→400 handler in src/main.py so `CreateSessionRequest.model`'s pydantic validator surfaces 400 (not FastAPI's default 422), matching the provider-add endpoint's explicit 400 — verified no other route asserts on 422. All live-curl-tested: GET/POST(400/409)/DELETE(404) on /api/v1/providers*, and POST /api/v1/sessions with malicious model strings (backticks, `$()`) both correctly 400. Full test suite: 393 passed, 1 pre-existing unrelated failure (confirmed via git stash — test_ensure_pipe_pane_does_not_clobber_existing_pipe fails identically on clean tree).

[SECFIX-SME] [2026-08-03]: Fixed all 4 security-review findings pre-commit. (1+2) `MODEL_ID_PATTERN` (src/models.py) changed from `^[A-Za-z0-9._~/-]{1,120}$` to `^(?!-)[A-Za-z0-9._~/-]{1,120}$`, and validation centralized into one new `is_valid_model_id(v)` helper using `.fullmatch()` instead of `.match()` — fixes the `$`-matches-before-trailing-newline bypass (`"openai/gpt-4\n"` now correctly rejected) and blocks a leading `-` (fixes the `cldor` `"$1" != -*` argument-injection path; `"--continue"`/`"-p"` now 400). Both `src/models.py` (CreateSessionRequest field_validator) and `src/api/routes.py` (`add_provider_model` route) now call `is_valid_model_id()` — no call site touches `_MODEL_ID_RE` directly anymore. `client/js/providers.js`'s independent JS-side regex updated to match (`(?!-)` added) for UX consistency; server remains authoritative. (3) Root-caused the stored DOM XSS: `Launchpad.showConfirmModal` (client/js/launchpad.js:1322) now escapes `title`/`message`/`details` via `this._escapeHtml()` before building `innerHTML` — was previously only escaping the button labels. Audited all 4 callers (3 in launchpad.js, 1 in providers.js `removeModel`): none intentionally embed HTML; one caller (`_handleKillRunningSession`) was pre-escaping its own interpolated value and had to be adapted (pre-escape removed) to avoid double-encoding now that the shared function escapes centrally. `app.js` has a separate, non-shared, copy-pasted `showConfirmModal` with the same unescaped-innerHTML pattern, but its one caller (`logout()`) only ever passes static strings — no attacker-controlled data reaches it, so left untouched as out-of-scope for this finding (flagged here for awareness, not fixed). (4) Added a pydantic `field_validator` on `ProvidersConfig.models` (src/config.py) that filters each entry through `is_valid_model_id()` at config-load time; DROPS invalid entries with a `structlog` warning rather than raising — chosen over raise because raising would blow up the enclosing `try/except` in `load_auth_config()` and replace the ENTIRE providers block with the 3-model default (losing every valid entry over one bad one), whereas every other malformed sub-block in that function already follows the same drop/fallback-soft philosophy; a single bad hand-edited entry shouldn't be able to hard-brick app startup. Verification: full pytest suite 393 passed / 1 pre-existing unrelated failure (identical baseline). Empirical HTTP-shaped checks via FastAPI TestClient (isolated temp config.json, never touched the real one after an initial scratch-script mistake was caught and reverted) — 14/14 passed: both bad ids 400 at pydantic layer AND `/api/v1/providers/models`, all 4 valid ids (incl. leading-`~`) still accepted. XSS pipeline simulated end-to-end in Node (render→browser-attribute-decode→showConfirmModal escape) confirming `<img src=x onerror=alert(1)>` never survives as a raw tag into the final `innerHTML`. `node --check` clean on both touched JS files. Also: `.claude/scheduled_tasks.lock` (tracked runtime PID/session lock, was showing as churning staged-deleted) added to `.gitignore` and `git rm --cached`'d — not committed.

---

# ARCHIVE — previous work below

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


[TOUCH-FIX] [2026-08-06]: Fixed 📎 menu misplacement on real iPhone (clipboard.js positionMenu mixed window.innerWidth/innerHeight with getBoundingClientRect — iOS layout/visual viewport divergence under URL-bar collapse / pinch-zoom / keyboard pushed the computed right/bottom off-screen; now uses rect-relative left/top + visualViewport clamping with 8px margins, body-appended) and added touch selection (new client/js/touch-select.js: long-press 500ms/10px tolerance enters select mode, synthesizes mousedown/mousemove/mouseup with detail:1 at touch coords so xterm 5.3's own SelectionService does pixel→cell mapping — WebGL-safe; floating "copy" button at lift point, clamped; outside tap exits; coarse-pointer gated, desktop inert). Playwright iPhone-13 emu 6/6 PASS (menu in-viewport+above-button, long-press select+clipboard round-trip, plain drag still scrolls, outside-tap dismiss, desktop mouse select untouched). Files: client/js/clipboard.js (positionMenu), client/js/touch-select.js (new), client/js/terminal.js (_applyTouchSelection hook), client/index.html (script tag), client/css/styles.css (.cloude-touch-copy + touch-callout guard).
