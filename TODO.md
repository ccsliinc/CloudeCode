# TODO — local model support (LM Studio) in cloudecode

Branch: `weekend-mvp-v3.1` (DEV). Deploy scope: **DEV commit + local DMG only. Nothing public.**

## Goal
Let a cloudecode session launch against the local LM Studio box the same way `cldl` does in `~/.zshrc`.

## Key facts (recon, verified)
- `src/config.py:535` `Settings.get_agent_command()` is the ONLY plumbing point. It builds
  `zsh -c 'source ~/.zshrc; cldor <model>'` when a model is set, else `... ; cld'`.
  The app never names the `claude` binary — the zsh function does.
- Because it sources `~/.zshrc`, `cldl` is already reachable from a cloudecode tmux pane.
- `~/.zshrc:406` `cldl()` — takes model as first positional arg, preflights LM Studio
  `GET /v1/models`, sets all ANTHROPIC_* env, execs claude. Same shape as `cldor`.
- Provider picker UI already exists: `client/js/providers.js:56` `showProviderModal()`.
- `providers.models` in config.json is a flat list of bare id strings — no provider kind.
  That is the gap this work closes.
- `MODEL_ID_PATTERN` (`src/models.py:31`) already accepts `qwen3.8-27b-uncensored`.

## Frozen contract
- `GET /api/v1/providers/local/models` -> `{host, models[], reachable, error}`
- `POST /api/v1/sessions` gains optional `provider`: `"openrouter" | "local" | null`
- `config.json` gains `providers.local_host` (default `192.168.1.167:1234`)

## Checklist
- [x] Backend: `local_host` on ProvidersConfig + getter (`src/config.py`)
- [x] Backend: `cldl` branch in `get_agent_command()` keyed on `provider == "local"`
- [x] Backend: `GET /api/v1/providers/local/models` proxy route, embeddings filtered
- [x] Backend: `provider` field on CreateSessionRequest + Session record
- [x] Client: local section in provider modal, live fetch, unreachable state
- [x] Client: `api.js` wrapper + pass `provider` on session create
- [x] pytest green
- [x] validator-agent confirms picker renders + local launch works
- [x] Commit on DEV
- [x] Bump `macOS/package.json`, `cd macOS && npm run package`, install DMG
- [ ] NOT DOING: rsync to PROD, public push, GitHub releases

## Sub-agent findings
(append below as `[AGENT] [TIME]: finding`)

[backend-local-provider] 2026-08-19 : Backend local-provider path shipped.
- `ProvidersConfig.local_host` (default `192.168.1.167:1234`) + `Settings.get_local_host()`.
  Validation lives in `src/models.py` as `normalize_local_host()` / `LOCAL_HOST_PATTERN`,
  next to `MODEL_ID_PATTERN` — plain host/IP + optional port + optional http(s) scheme ONLY.
  Rejects paths, query, userinfo, non-http schemes, shell metachars, IPv6 literals.
  Fail-soft to the default with a warning log (mirrors the models validator), so a
  hand-edited config.json can't brick startup. Purely additive: legacy config.json
  without the key deserializes unchanged.
- `GET /api/v1/providers/local/models` -> `{host, models[], reachable, error}`. Uses the
  already-present `httpx` (no new dep), 5s timeout matching cldl's `curl --max-time 5`,
  redirects NOT followed. Filters ids containing "embed" AND anything failing
  `is_valid_model_id` (an id we'd reject at launch must never be offered). ALWAYS 200 —
  unreachable/timeout/HTTP-error/non-JSON all return `reachable:false` + a short human
  string so the modal can render the state.
- `provider: Optional[Literal["openrouter","local"]]` on `CreateSessionRequest` and
  `Session` (`ProviderKind` alias in src/models.py), threaded route -> session_manager
  -> `get_agent_command(agent_type, model, provider)`.
- `get_agent_command` local branch emits
  `zsh -c 'source ~/.zshrc >/dev/null 2>&1; CLDL_HOST=<host> cldl <model>'`.
  DECISION: `CLDL_HOST` is injected (both values shlex-quoted, same nesting as cldor).
  Without it, config.json's host and cldl's own default could diverge and the session
  would launch against a different box than the picker enumerated. `provider="local"`
  with no model raises ValueError; the create-session route rejects it with an explicit
  400 BEFORE its try-block (that block's blanket `except Exception` would otherwise
  rewrite an HTTPException into a 500 — worth knowing for any future guard there).
- `provider=None` and `provider="openrouter"` produce byte-identical output to the
  pre-existing cld/cldor strings — verified by direct call, not by reading code.
- Tests: `tests/test_local_provider.py` (62 tests) incl. a zsh round-trip injection test
  for the CLDL_HOST + model quoting, and a genuinely-closed-port unreachable test.
  Full suite: 1 failed, 456 passed. The single failure is
  `test_session_backend.py::test_ensure_pipe_pane_does_not_clobber_existing_pipe` —
  PRE-EXISTING, reproduced on a stashed clean tree, unrelated to this work.
- Live check: route returned `["qwen3.8-27b-uncensored"]` from the real box (embedding
  model filtered); dead port returned 200 + `reachable:false`.

### [client-local-picker] 18:52
- Local section added to the provider modal (`client/js/providers.js`), below the
  add-model row, headed `► local · lm studio`. No add/remove buttons — the list is
  whatever LM Studio reports.
- Three states all render inline, never blocking: loading (`checking for local
  models…`), populated (rows selectable exactly like OpenRouter ones), unreachable
  (`<host> unreachable — <reason>`, host named so you know WHICH box is down).
  The probe runs in PARALLEL with `getProviders()` and is never awaited before the
  first paint, so a hung/timing-out LM Studio leaves the modal fully usable and
  launchable the whole time.
- Provider now round-trips through localStorage via a SECOND key
  `cloude_provider_last_provider`. Absent key = openrouter, so pre-existing installs
  read back exactly as before. Stale cache degrades to claude (never launches the
  wrong provider) in both cases: box down, and box up but model unloaded.
- `POST /api/v1/sessions` only ever gets `provider: "local"`. claude + OpenRouter stay
  wire-identical to today (absent === server default), so nothing regresses if the
  backend field lands later. Two payload sites patched in `launchpad.js` (:1527, :2399).
- Section header/note are deliberately NOT `.folder-picker-item`, which keeps the DOM
  order of `.folder-picker-item` 1:1 with `items[]` for the existing `setActive()`
  index math. Type-ahead and arrow nav reach local rows.
- FINDING (phone-first): `.folder-picker-item` rows measured 40px on a 390px viewport —
  under the 44px touch-target floor. Bumped to 12px padding inside the EXISTING mobile
  media query, on the shared row class so the provider list and folder picker move
  together (a local-only bump would have broken the rhythm). Mobile list max-height
  240px -> `min(340px, 50vh)` since the list now carries two sections.
- FINDING (process): mid-task, `git status` briefly reported a clean tree and my four
  files read as unmodified — a Dropbox sync race on this repo path, not a real revert.
  Re-applying blind duplicated two blocks; caught and collapsed. If you see phantom
  reverts here, re-check before re-patching.
- Verified: 29/29 Playwright checks green on a 390x844 mobile context (all three states,
  provider round-trip, stale-cache degradation, legacy-cache compat, late-probe not
  stealing the user's selection, zero console errors), plus screenshots reviewed at
  mobile + desktop. Unreachable path verified against a REAL thrown 404 as well as the
  contract's `reachable:false`. No JS lint/test runner is configured in this repo;
  `node --check` clean on all three JS files. No stub or mock left in the tree — the
  harness lives only in the session scratchpad.
- Files: `client/js/providers.js` 472, `client/js/api.js` 853, `client/js/launchpad.js`
  2478, `client/css/styles.css` 2457.

[css-touch-target] 2026-08-19: Fixed 43px rows (local model row, add-model row) missing the
44px touch-target floor by 1px. Root cause + fix both in ONE place: the mobile media query
(`@media (max-width: 768px)`) rule for the shared `.folder-picker-item` class in
`client/css/styles.css` (~line 1832) — bumped `padding: 12px 14px` to `padding: 13px 14px`.
Every row type (claude, OpenRouter model rows, add-model row, local model rows) uses this one
class, so the single value change fixed both undersized rows without a new rule and without
touching claude/OpenRouter rows' markup.
- Measured via a Playwright script against a static harness (real styles.css, real row markup
  copied from `client/js/providers.js`) at 390x844, `getBoundingClientRect().height`:
  - BEFORE: claude 44.00px, OpenRouter row 53.00px, add-model row 43.00px, local row 43.00px.
  - AFTER:  claude 46.00px, OpenRouter row 55.00px, add-model row 45.00px, local row 45.00px.
  All four >= 44px floor after the fix.
- Document width stayed 390 (no horizontal scroll introduced) before and after.
- Root-cause note: claude's row measured 1px taller than the add/local rows even under
  identical padding/class because its icon glyph (◆) falls back to a font with slightly
  taller line-box metrics than the glyphs used on the add/local rows (+, ▪); OpenRouter rows
  are tallest because the 28px remove button (bumped in the same media query) dominates the
  row's flex height. This is why a single shared-class padding bump — not per-row tweaks —
  was the correct fix.
- Touched only `client/css/styles.css`. Harness/script/screenshot left in
  `/Users/Adam/Dropbox/llmScratch/css-touch-target-*` — not committed, not in repo. Not
  committed per instructions.

[harden-proxy] 2026-08-19: Hardened `GET /api/v1/providers/local/models` (src/api/routes.py)
against slow-drip + unbounded-body resource exhaustion from a hostile/MITM'd `local_host`.
- Replaced the per-read-only `httpx.AsyncClient(timeout=5.0)` + `client.get()` with
  `httpx.Timeout(5.0, connect=5.0)` (per-op ceiling) wrapped in `asyncio.wait_for(...,
  timeout=5.0)` as the real total wall-clock deadline — the per-op knobs alone can't catch a
  slow-drip sender that always answers just under the read timeout.
- Switched to `client.stream("GET", ...)` + `aiter_bytes()`, aborting via a new
  `_LocalModelsResponseTooLarge` internal exception once the running total exceeds
  `_LOCAL_MODELS_MAX_BYTES` (1 MiB), before any `json.loads()`. New exception is caught in the
  same try/except ladder as the existing `httpx.TimeoutException` / `HTTPStatusError` /
  `HTTPError` / `ValueError` branches and returns the identical graceful-failure shape (200 +
  `reachable: false` + short `error` string) — no second success/failure path added, no 500,
  no raise.
- Added `import asyncio` to routes.py (no new dependency; httpx was already in use).
- tests/test_local_provider.py: converted the two `client.get()`-mocking tests
  (`test_local_models_filters_embeddings`, `test_local_models_drops_ids_the_launch_path_would_reject`)
  to mock `client.stream()` + `aiter_bytes()` instead, matching the new streaming call shape.
  Added `test_local_models_oversized_body_returns_200_not_500` (3x512KiB chunks = 1.5MiB body
  against the 1MiB cap) proving the graceful path, not a raise/hang.
- Fixed the two `tempfile.mkdtemp()` calls that ran at import time and were never cleaned up
  (needed before `src.config` import, so a normal pytest fixture can't build them — fixtures
  only run post-collection). Kept `mkdtemp()` but registered `atexit.register(shutil.rmtree,
  ..., ignore_errors=True)` on both dirs so they're swept on interpreter exit regardless of
  pass/fail. Verified `ls -d /tmp/cc_local_* | wc -l` → 0 after a full suite run.
- Full suite: `1 failed, 457 passed` — the 1 failure is the known pre-existing
  `test_ensure_pipe_pane_does_not_clobber_existing_pipe` (tmux, unrelated, fails on clean tree
  too). test_local_provider.py alone: 63 passed.
- Live happy path re-verified by calling `list_local_provider_models()` directly against the
  real box: `host='192.168.1.167:1234' models=['qwen3.8-27b-uncensored'] reachable=True
  error=None`.
- Touched only `src/api/routes.py` and `tests/test_local_provider.py`. Not committed per
  instructions.

---

## Provider modal: Codex row + OpenRouter grouping — DONE (2026-08-25)

**Goal:** add `codex --yolo` as a pinned pick directly under `claude` in the launch-time
provider modal, and group the OpenRouter model list under a `claude · via openrouter` heading.

- [x] `client/js/providers.js` — pinned `codex` row at index 1 (modelless, reported as
      `agentType: 'codex'`); lazy `► claude · via openrouter` section header emitted before the
      first model row, or before `add model` when the catalog is empty. Modal now returns
      `{model, provider, agentType}`. `codex` persists via the existing
      `cloude_provider_last_provider` key (value `'codex'`, model key empty) so it restores on
      reopen; legacy installs (model key set, provider key absent) still read back as OpenRouter.
- [x] `client/js/launchpad.js` — both payload builders (`_createNewSessionInner`, `selectProject`)
      set `payload.agent_type` from `providerChoice.agentType`. Modal choice wins over the FAB's
      agent argument. Wire format for claude/OpenRouter/local is byte-identical to before.
- [x] `src/config.py` — `AgentsConfig.codex_command` default is now
      `zsh -c 'source ~/.zshrc >/dev/null 2>&1; codex --yolo'`. The rc-source shim is required:
      `codex` here lives under nvm (`~/.nvm/versions/node/v22.22.0/bin/codex`) and the tmux pane
      shell is non-interactive/non-login, so a bare `codex` is "command not found".
- [x] `tests/test_session_agent_type.py` — default-command assertion updated.

**Validation**
- Headless Playwright against the real `providers.js` + `styles.css`: row order and 1:1
  `items[]`↔DOM index mapping confirmed; all four return shapes correct (claude / codex /
  openrouter / local); localStorage round-trip confirmed. Edge cases all pass: empty catalog,
  LM Studio unreachable, stale remembered model, legacy no-provider-key install, and a local
  model that only arrives after the first paint.
- Real tmux launch on a scratch socket: `codex --yolo` rendered its TUI cleanly, no
  "command not found", no rc-file noise leaking into the alt-screen.
- Full suite: `1 failed, 457 passed`. The 1 failure is the known pre-existing
  `test_ensure_pipe_pane_does_not_clobber_existing_pipe` (fails on a clean tree too).
