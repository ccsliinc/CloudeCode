# Cloude Code

Drive a Mac's live Claude Code sessions from a phone. A FastAPI server owns real
tmux sessions on the Mac, streams the PTY over a WebSocket, and paints it into
xterm.js in a browser. The session runs whether anyone is watching or not, which
is the whole point and the source of most of the interesting design.

**THIS FILE IS A ROUTING LAYER.** It carries the rules you must not break, the
file pointer for each one, and nothing else. On 2026-09-13 the measurements, the
incident timelines, the rejected alternatives and the mutation-test stories were
moved VERBATIM into twelve documents under `docs/`, listed in the table below.
Nothing was deleted. If a rule here looks arbitrary, its evidence is in the
matching history document; read that before you argue with the rule.

## THE SPELLING "Cloude" IS DELIBERATE. NEVER CORRECT IT.

The product is called **Cloude Code**, one letter off "Claude Code", on purpose.
A rename is NEVER in scope for a tidying, linting or typo-fixing pass, because
the string is load bearing in five places that are not prose: **the tmux socket
`tmux -L cloude`**; **the session name prefix `cloude_*`** (`SESSION_PREFIX`,
`src/core/tmux_backend.py`), which discovery, adoption and the boot re-adopt all
scope themselves by; **the database filename `cloude.db`** and the state
directory `~/Library/Application Support/cloude-code-menubar/`; **the Electron
bundle id `com.cloudecode.menubar`** (`macOS/package.json`), on which macOS keys
permissions, the login item and the container; and **every `CLOUDE_*`
environment variable** plus every log event name a running install and its
already-installed hook block emit today.

So the blast radius of "fixing the typo" is the sessions the user is working in,
their entire database, and the app's identity to macOS. If a document, a
comment, a path or a variable reads `Cloude`, leave it. The same prohibition is
carried by `.github/ISSUE_TEMPLATE/task.yml` and `.claude/skills/work/SKILL.md`.

## Every document in `docs/`, and when to read it

CLAUDE.md is the only entry point guaranteed to be loaded, so a document it does
not name is effectively invisible: a clean-context agent will re-derive what the
file already says, or contradict it. Gotcha 8 is the argument.

This table is the routing layer. Read the one that answers your question.

| Document | Read it when |
|---|---|
| `docs/DECISIONS.md` | **Before you re-litigate any design choice.** Standing rulings from Adam, who owns the code and is the sole tie-breaker. A ruling binds both parties and both sides' agents. This is the file that says double-click rename stays. |
| `docs/LESSONS.md` | Before you debug something that feels familiar. Defect shapes that have bitten this project more than once, with the evidence. Add one when a pattern REPEATS; once is an incident, twice is a pattern. |
| `docs/session-status.md` | Anything about the status lights. The single source of truth for the state model, the two rings, the five colours and where each fact is stored. |
| `docs/session-status-model.md` | You need the transition-by-transition derivation. Four independent state machines, every state citing the symbol it was read out of, drift-tested by `tests/test_status_model_chart_drift.py`. |
| `docs/notifications.md` | Anything about toasts. Raising is global, dismissing is per session, and those are independent axes. Also the external push channels: the queue stays sequential, the three channels inside one entry go out at once under a per-channel bound. |
| `docs/alert-state-model.md` | You are designing alerting. DESIGN ONLY, nothing in it is built, and it deliberately disagrees with `docs/session-status-model.md` in two places. Read that one first. |
| `docs/session-project-operations.md` | You need to know what an operation does to a session row, a project row and the tmux session underneath. Every node cites the symbol it came from. |
| `docs/history-archive-scope.md` | Before you touch the history and archive browser. The inventory of what already exists there, what is missing, and the fifth plugin surface it is the first consumer of. Its section 2.0 is the two-store split. |
| `docs/history-archive-join.md` | The archive browser renders nothing, or you are about to change how the archive reaches the message model. The column map that ruled out repointing the readers, how growth is answered without weakening the model's refusal, and the measured cost of a first run. |
| `docs/archive-search-index.md` | Before you touch archive SEARCH or `message_bodies.body_json`. Search matches an FTS5 index over content blocks, not the whole jsonl record, and the column is compressed per row - the two are coupled, because the column was only uncompressed so the old scan could grep it. Carries the tokenizer comparison, the recall table, the coverage ladder, and what a row's `typeof()` declares. |
| `docs/history-archive-db-split.md` | Before you move a table between `cloude.db` and `cloude-archive.db`, add one to either, or touch the integrity gate. Where the line falls and why, the three foreign keys that cross it, ATTACH versus two connections, the refusal ladder, and what reversibility actually costs at each stage. Read its sqlite correction FIRST if you are writing cross-database DDL: an unqualified `REFERENCES` is accepted at DDL time, refuses every insert forever, and `foreign_key_check` passes it silently. |
| `docs/transcript-archive-integrity.md` | Before you trust, change or re-point the transcript archive, and after any migration that touches `cloude-archive.db`. The READ half's proof: how the whole corpus is verified chain-aware rather than row by row, why a supersession pointer means a row holds an 8-byte sentinel instead of its own bytes, and why the throwaway round-trip harness beside it cannot prove the live shape. Carries the measurement that makes the archive non-negotiable: 2,524 of 23,715 rows name a `.jsonl` that exists nowhere on disk, so for those conversations this is the only copy left. Run it with `scripts/transcript-archive/verify_archive_integrity.py`. |
| `docs/transcript-restore.md` | Before you write anything into `~/.claude/projects`, or when a conversation cannot be resumed because its transcript is gone. The WRITE half of the archive: which of a path's many rows may be written (the newest, never a superseded snapshot, or you ship a silently truncated conversation), why the destination is the recorded `source_path` rather than a re-derived slug, the three refusals that protect a live file, and the end-to-end proof that a lost conversation really does resume. Read its `LIKE` section before writing any stem lookup: `_` is a wildcard and 528 live stems contain one. |
| `docs/project-reconcile.md` | The project list looks wrong after an upgrade. Written after a round trip actually lost rows. |
| `docs/session-attribution-import.md` | Sessions are reported as external that the launcher itself created. DESIGN ONLY, not implemented. |
| `docs/reconnect.md` | The terminal repaints wrong after sleep, wake or a dropped socket. Names the two re-attach paths, which behave differently. |
| `docs/ci.md` | You need to know what CI runs and what it does when a secret it needs is missing. Read it with the CI status paragraph under "How we work here", which says whether it is switched on at all. |
| `docs/debugging.md` | You need logs. The `CLOUDE_DEBUG=1` switch, from source and inside the packaged app. |
| `docs/secret-scanning.md` | You are touching the pre-commit hook, `.gitleaks.toml`, or `scripts/scan_secrets.py`. Carries the incident that caused all three. |
| `docs/test-artifact-cleanup.md` | You are removing a test session or project. It leaves traces in SEVEN places, and killing the tmux session clears exactly one of them. |
| `docs/upgrade-with-claude.md` | You are upgrading an install. The runbook `/upgrade` follows. Take the baseline FIRST. |
| `docs/upgrade-downgrade-roundtrip.md` | You are asking whether the previous version can be dropped back in. Answered by executing the round trip, not by reading the migration's own promises. |
| `docs/deploy-mini.md` | You are pushing this code to the `mac-mini-m4` dev box. A developer tool, NOT the end-user upgrade path. |
| `docs/deployment-docker.md` | You are running the server as a pure container. Operator facing. |
| `docs/ios-simulator-testing.md` | You changed anything that renders on a phone. Names the three things desktop responsive emulation cannot show you. |
| `docs/ios-standalone.md` | You are working on add-to-home-screen. What works over plain http, and what needs TLS. |
| `docs/perf-baseline-2026-09-10.md` | You need a number to judge a performance change against. Read its machine-load note before quoting any absolute figure. |
| `docs/webui-performance-and-session-menu-plan.md` | You picked up an issue carrying a `phase:N` label. This is the plan those issues were cut from, with the audit that justified it. |
| `docs/message-browser-api.md` | You are building the archive browser's server. DESIGN SPEC, not implemented. |
| `docs/message-browser-ui.md` | You are building the archive browser's client. DESIGN SPEC, not implemented. |
| `docs/message-model-gate.md` | You are touching the message model's ingest gate or `src/core/message_gate_contract.py`. |
| `docs/jsonl-shape-inventory.md` | You are writing a test against the transcript archive and need a real exemplar of a given line shape. |
| `docs/help-content-audit.md` | You are rewriting the launchpad help copy. |
| `docs/ui-preferences-inventory.md` | You are building the typed `ui_preferences` sync (or its partial-update or import step). Every durable browser-stored preference, classified as shared / per-viewer-only / already server-owned / secret, with the exact key, composition, writer and reader. |
| `docs/ui-inventory.md` | A designer or a newcomer needs the complete inventory of every screen, region and control in the app: what each one is for from the user's point of view, what states it can be in, and whether it appears on desktop, on a phone, or on both. Written for someone who does not read code. It is DESCRIPTIVE, not normative: it records what shipped, it does not rule on what should. Where it and the code disagree, the code wins and this file is the thing to fix. |
| `docs/ROADMAP.md` | You are picking the next feature to build, or asking whether an idea has already been thought about. The full 2026-09-13 brainstorm: 91 unconstrained ideas, the top 50 with a "probably possible" twin each, Adam's 17 fleshed out, the locked decisions (brand, catalog hosting, signing, cheap-model seam, TUI stack, mobile, remote hosts) and the three-tier roadmap. It is a PLAN, not a record of what shipped. |
| `docs/web-build-history.md` | You need the evidence behind a `web/` rule: the StatusLed parity proof, the slice measurements, mount-path traps, plugin mutation tests, static-asset keys and why the serve-time bundle was cut, the first-paint fan-out, the string-layer guards. |
| `docs/tmux-launch-history.md` | You are changing how a pane is launched or respawned: batching, the cold-socket `-f` config, env-write ordering, the boot re-adopt, the `ensure_pipe_pane` guard. |
| `docs/session-identity-history.md` | Session identity: adoption id resolution, hook token mint / keep / recovery, the owned ledger, project binding, agent evidence and inference, the conversation uuid, naming, the project folder, the two theme stores. |
| `docs/listing-performance-history.md` | The numbers behind `/sessions/list`, `GET /themes`, the attach path and the pipe reader: the off-the-loop gather, per-row readers, the instance index, the startup-gate tail, socket scope, the file drawer, kqueue, attach settle, cursor capture. |
| `docs/streaming-and-events-history.md` | The viewer fan-out, `/ws/events`, the preferences sync, the settings import, the local server detector. |
| `docs/status-led-history.md` | The full status-light record: owner rulings verbatim, the ring reversal, geometry, toast grouping, view-clears, the status seed, the transcript ladder, the dead-pane reaper. |
| `docs/restart-and-recreate-history.md` | Restart, respawn and recreate in full: the ladder, the four live-restart gates, the resume rules, the recreate presence gate. |
| `docs/terminal-client-history.md` | The terminal client: navigation generation, input ownership, the write queue, the reconnect ladder, the measured connect, `terminal.ready`, the input buffer, search, the two menus. |
| `docs/integration-1.4.0-history.md` | You are merging the other party's line, or asking what shipped in 1.4.0 and where. |
| `docs/maintenance-history.md` | The full "how we work here" record, the test-baseline drift history, the archive ingester, the integrity check, secret scanning, imported conversations, install refresh. |
| `docs/gotchas-detail.md` | The one-line gotcha is not enough and you want the incident behind it. |
| `docs/claude-md-archive-2026-09-13.md` | Nothing else matched: the original spelling warning, hooks and CSP, the theme-script consent ladder, the config writer, the `/sessions/list` field detail. |

Two rules keep this table honest. **Unreferenced is not unused**, so do not
delete or move a file in `docs/` because it looks orphaned. And **a new file in
`docs/` gets a row here in the same change**, or it is invisible on the day it is
written. `tests/test_docs_index.py` fails the build if a `docs/*.md` file is not
named in this file.

## Stack

| Layer | What | Where |
|---|---|---|
| Backend | Python 3.12, FastAPI, uvicorn, pydantic models | `src/` |
| Logging | structlog, event-name first arg, kwargs for context | everywhere |
| Terminal | tmux (live backend) driving a PTY, xterm.js client-side | `src/core/tmux_backend.py`, `client/js/terminal.js` |
| Frontend | vanilla JS, no framework, NO build step for `client/` | `client/` |
| Desktop shell | Electron wrapper (has its own `package.json`) | `macOS/` |
| Compiled frontend | Svelte 5 (runes) + TypeScript + Tailwind, built by vite | `web/`, output in `client/dist/` |
| State | JSON on disk (`config.json`), plus one SQLite file for refresh tokens | `src/config/`, `src/core/refresh_store.py` |

`client/` is served off disk under `/static`: no bundler, no transpile, no
`client/package.json`, so a file you add there must be valid in the browser as
written. `node --check` every JS file you touch.

## The `web/` build

Record: `docs/web-build-history.md`.

**TWO FRONTEND TREES LIVE IN THIS REPO AT THE SAME TIME, ON PURPOSE.**
`client/js` is hand-written vanilla JS served off disk; `web/` is Svelte 5 +
TypeScript + Tailwind compiled by vite into `client/dist/`. The first question
about any client change is which tree owns that screen. The launchpad is fully
compiled; the terminal, toasts, sidebar row menus, restart picker, settings
panels and archive screens are still vanilla and are not scheduled.

- **ALL NEW UI GOES IN `web/`, EVEN ON A SCREEN THAT IS STILL LEGACY** (owner,
  2026-09-12: "full send into svelt. let's not fuck around"). A PORT is legacy or
  compiled, never half of each.
- **`npm run build` from `web/`**, plus `watch`, `test`, `check`; NO vite dev
  server and no HMR, both of which would cost a proxy and a CSP relaxation.
  `npm ci`, never `npm install`.
- **OUTPUT NAMES ARE FIXED, `app.js` and `app.css`, no content hash**, because
  hand-maintained `client/index.html` names them.
- **CACHING IS A CONTENT KEY IN THE QUERY, NOT A REFUSAL TO CACHE**:
  `static_asset_keys.py` stamps `?v=<sha256 prefix>` on every same-origin
  `/static/` `src` and `href` at serve time, and `NoCacheStaticFiles` answers
  `public, max-age=31536000, immutable` ONLY while that key matches. Everything
  else, a stale key included, keeps `no-cache, must-revalidate`, and
  `index.html` is never immutable.
- **A SERVE-TIME BUNDLE WAS BUILT AND CUT SAME DAY**, since `client/js` is
  being rebuilt in Svelte and a bundle for it is throwaway; nothing under
  `/static-bundle/` exists. The keying above is FRONTEND-AGNOSTIC: each key
  comes from a file's content, memoised, so an edit serves fresh with no
  restart.
- **`client/dist` IS COMMITTED** and the `.gitignore` negation is load bearing,
  because `deploy-mini.sh` ships committed files and the mini runs no build;
  `scripts/web-build-check.sh` proves it current and its exit 2 means CANNOT
  DETERMINE, not pass.
- **Tailwind ships UTILITIES ONLY, prefixed `tw:`, in `@layer utilities`**, no
  preflight, `source(none)` plus one `@source` naming `web/src`.
- **NO INLINE SCRIPT, NO REMOTE ANYTHING, AND TAILWIND UTILITIES ONLY**, prefixed
  `tw:` inside `@layer utilities` with no preflight; `tests/test_no_remote_assets.py`
  reads the emitted bundle.
- **Logic that renders no component stays FRAMEWORK-FREE in `client/js`**, the
  terminal search family being the worked example.
- **`mountPanel` (`web/src/lib/mount.ts`) IS THE ONLY WAY A COMPONENT REACHES THE
  DOCUMENT**, one handle per container id; it does not clear the container, so A
  PANEL OWNS ITS CONTAINER and no markup goes inside one.
- **The status LED lives in BOTH trees on purpose**, contracted to
  BYTE-IDENTICAL output and proven by `StatusLed.parity.test.ts`; edit one alone
  and half the app's lights change.

| Piece | Where, under `web/src/lib/` unless stated |
|---|---|
| The vite project | `web/{package.json,vite.config.ts,svelte.config.js,tsconfig.json,vitest.config.ts}` |
| Tailwind entry; entry point publishing `window.CloudeWeb` | `web/src/app.css`, `web/src/main.ts` |
| THE ONE MOUNT PATH | `mount.ts` |
| Status LED and its pure modules | `StatusLed.svelte`, `led.ts`, `status-dot.ts` |
| Slices 1 to 5, the launchpad panels | `launchpad/{AttributionPrompt,RecentSessions,ProjectTree,RunningSessions*}.svelte` and their `attribution.ts`, `recent*.ts`, `project-*.ts`, `running-*.ts`, plus `sessions/` (`store.svelte.ts`, `running.ts`, `listing.ts`, `poller.ts`, `host.ts`, `env.ts`) |
| Slices 6 and 7, modals, create flows, shell and shim | `launchpad/*Modal.svelte`, `ModalShell.svelte`, `create-*.ts`, `entry-flows.ts`, `project-{actions,folder}.ts`, `{HomeScreen,HelpDisclosure,RichText}.svelte`, `home-*.ts`, `panels.ts`, `navigation.ts`, `nav-host.ts`, `deep-link.ts`, `new-fab.ts`, `shim.ts` |
| The plugin surface registry | `plugins/`, bridged by `client/js/session-row-menu-plugins.js` |
| Terminal search and prompt rail | `terminal-search/` (three components, `search-controller.svelte.ts`, `rail-model.svelte.ts`, `search-keys.ts`, `search-host.ts`, `mount-search.ts`) |
| Per-device UI preferences, legacy keys | `ui/prefs.svelte.ts` |
| The copy every screen prints | `client/js/{labels,i18n}/`, `client/js/icons/glyphs.js` |
| The REAL bundle in a node test sandbox | `tests/helpers/cloude-web-sandbox.mjs` |
| The committed bundle and its guard | `client/dist/app.{js,css}`, `scripts/web-build-check.sh` |

Slices 0 to 7 are DONE (`.claude/notes/svelte-migration-launchpad.md`) and
`client/js/launchpad.js` IS DELETED: the home screen is
`launchpad/HomeScreen.svelte`, mounted into the `#launchpad-screen` div
`client/index.html` still owns, and `window.Launchpad` is a shim.


**As of 2026-09-13 Adam is rebuilding the entire front end in Svelte** (style,
design and layout only; the architecture, the server contracts, the WebSocket and
xterm are unchanged). The strangler migration above is therefore historical:
treat `client/js` as code on its way out and put every new surface in `web/`.

### The session data layer, the running list, the plugin registry

- **SEVEN FIELDS ARE OVERWRITTEN UNCONDITIONALLY AND MUST NEVER BE
  `||`-DEFAULTED**: `agent_family`, `agent_family_source`, `agent_wrapper_label`,
  `startup_gate`, `status_source`, `label`, wrapper `status`. Each null means
  "could not be determined", and `!== undefined ? x : null` is NOT `|| null`.
- **PLUGINS ARE BUILD-TIME MODULES, AND THE REASON IS THE CSP**: added to
  `BUILTIN` and compiled in, with no loader, manifest, permissions model or
  dynamic `import()`, and never a remote URL or `eval`.
- **FOUR SURFACES AND THE LIST IS CLOSED** until a consumer argues otherwise;
  order is declared and total, a duplicate id is REFUSED AND LOGGED, and
  `enabled(context)` reads flags as `!== false`, checked at render AND at run.

## Architecture, the cornerstones

- **tmux is the live backend; `PTYBackend` is legacy** (ABC in
  `session_backend.py`, live in `tmux_backend.py`, legacy in
  `src/utils/pty_session.py`). Build nothing new on PTY.
- **Sessions live on a dedicated socket, `tmux -L cloude`**, which is why they
  survive a restart and why we can never kill a user's own tmux session.
- **Created vs adopted is a real distinction**: a truly external session has the
  id `adopted:<tmux-name>`, so anything that parses or routes on an id handles
  both shapes, and a session id is NOT a tmux name.
- **AN ADOPTION RESOLVES THE ID, IT DOES NOT MINT ONE**
  (`session_adopt_identity.py`), because tmux fixes `CLOUDECODE_SESSION_ID` into
  the pane at spawn and can never tell a running agent a new one. AN INVENTED ID
  REGISTERS ONE LIVE PANE TWICE, adding a second `tmux_names` entry to the very
  map the boot re-adopt reverses to recover an id, so the stored row keeps the
  conversation uuid and the project binding while every attention write lands
  under the invented one.
- **A RECOVERED ID MUST NOT BE RE-MINTED A TOKEN**, since `_mint_hook_token`
  REPLACES and revokes what the running agent holds; a re-keyed adoption calls
  `_keep_hook_token`, and `hook_token_recovery.py` is in memory and NEVER MINTS.
- **`PaneDeadError` MEANS A MEASURED DEATH**: a `#{pane_dead}` probe that
  RUNS and reads `"1"` raises it, becoming `AdoptTargetGoneError` - 409
  `session_gone`, not 500. A probe that could NOT run stays `RuntimeError`,
  a 500: unmeasured is not dead.
- **A RESTART IS THE ONE MOMENT A LIVE PANE'S ENV CAN BE CORRECTED**, so
  `respawn` issues `set-environment` BEFORE `respawn-pane`, batched
  (`tmux_command_batch.py`) but never inside the spawn.
- **BOOT RE-ADOPTS EVERY SURVIVING SESSION** (`session_boot_readopt{,_plan}.py`),
  ID RECOVERED NOT MINTED from the hook-token store's `tmux_names`; the pass is
  SCHEDULED, never awaited, because uvicorn binds at the `yield`.
- **EVERY SESSION BELONGS TO A PROJECT** (owner: "its impossible to not have a
  project"), the tree tests `attribution === 'none'` BEFORE `project_id`, and
  `session_project_binding.py::columns_to_write` is the rule that **THE PAIR
  MOVES TOGETHER OR NEITHER MOVES**; canonicalising the path is a FALLBACK RUNG.
- **ATTENTION IS RESOLVED FROM WHAT THE HARNESS WRITES, NEVER FROM WHAT IT
  TELLS US**: ZERO hooks are installed (owner, 2026-09-13, `docs/DECISIONS.md`),
  and `src/core/attention/resolve.py` walks FOUR TIERS in precedence order,
  REGISTRY (`~/.claude/sessions/<pid>.json`) then TRANSCRIPT tail then PANE then
  TMUX. Only the registry may ORIGINATE rest, THE PANE CAN NEVER SAY DONE, tmux
  alone may say dead, ABSENT IS `unknown` AND `unknown` IS NEVER `idle`, and
  there is no `or 0` anywhere in it because the background-agent count is
  OMITTED WHEN ZERO.
- **CSP is `default-src 'self'`, `frame-ancestors 'none'`, NO third-party origin
  in any directive**; `style-src` keeps `'unsafe-inline'` for xterm's inline
  style attributes, while inline SCRIPT and `eval` are not permitted.
- **A THEME CAN SHIP A SCRIPT AND THE CSP IS NOT WHAT GATES IT**: `effects.js` is
  same-origin, and the gate is one ladder (`client/js/theme-consent.js`,
  `theme_script_consent.py`) with SIX outcomes, one of which runs. DENY WINS OVER
  EVERYTHING, an unreadable record refuses a cached grant, an `always` stores the
  sha256 of the exact file, and `once` is never stored or sent.
- **Config writes go through ONE boundary, `src/core/config_writer.py`**
  (`tests/test_one_config_writer.py` fails on a second): `.bak` first, temp file,
  `fsync`, `os.replace`, and `commit(path, mutate)` takes a MUTATOR so no caller
  can supply a stale base.
- **ABSENT IS NOT A DEFAULT** in `ui_preferences`: the server never fabricates a
  value, and a stale write is a **409 carrying the current revision AND values**.
- **`ui_preferences` is the typed home for preferences with no server owner**
  (`ui_preferences{,_store}.py`, `preferences_routes.py`), and the ten
  per-viewer keys in `docs/ui-preferences-inventory.md` are deliberately absent.
- **`/ws/events` IS AN OPTIMISATION AND MAY NEVER BECOME A DEPENDENCY**: the 5s
  reconciliation poll is untouched and every publish site is fail-soft.
- **`/ws/events` is ONE authenticated socket per browser**, authenticated exactly
  as the terminal socket is, bounded at 256 events or 1 MiB with overflow closing
  **4429**, and the mute gates the TOAST, not the STATUS.
- **THE LISTING PASS GATHERS OFF THE LOOP AND ITS WRITES STAY ON IT** (SNAPSHOT,
  `asyncio.to_thread`, then the per-row loop back on the loop), because the
  writes are read-modify-writes against state the attention watcher's side
  effects mutate there: **A PARTIAL, CORRECT IMPROVEMENT BEATS A COMPLETE, RACY
  ONE.**
- **AN OVERFLOW DISCONNECTS; IT NEVER TRUNCATES**, because escape sequences span
  chunks; the close code is **4429**.
- **THE VIEWER FAN-OUT IS BOUNDED AND HAS ONE WRITER PER SOCKET**
  (`viewer_fanout.py`, `src/api/websocket.py`), and the handler is SYNCHRONOUS
  because `await queue.put` on a full queue IS the backpressure the bound exists
  to prevent; **4 MiB or 256 chunks**, the same number the client queue uses.
- **THE PIPE READER WAKES ON THE APPEND** (`pipe_wakeup.py`, kqueue on asyncio's
  own selector) with the 20 ms sleep kept as a BACKSTOP, because a reader that
  misses an event does not read late, it STOPS reading.
- **The local server detector is fully wired, has no client, and STAYS** by the
  owner's ruling: keep `local_servers.py`, its route, its two WebSocket models
  and the janitor, know that the API field is hardcoded empty at all four
  assignment sites, and never put a panel back IN FLOW beside
  `.terminal-container`.

## The `/sessions/list` shape

`GET /sessions/list` returns `SessionInfo` (`src/models/sessions.py`) and the
fields sit on **two different levels**:

- On the wrapper: `activity_status`, `unread`, `startup_gate`, `tmux_session`,
  `agent_type`, `agent_family`, `agent_family_source`, `agent_wrapper_label`,
  `pinned_theme`, `session_backend`, `recent_logs`, `local_servers`, `stats`
- On the nested `.session`: `id`, `pty_pid`, `working_dir`, and the rest of the
  `Session` model

Reading `info.id` or `info.session.unread` gives you `undefined` silently, and it
looks exactly like "the backend didn't send it". **This is the single most
repeated bug in the project.** Check the level before you debug the endpoint.

**`status_source` NAMES THE TIER THAT DECIDED**, one of `registry`,
`transcript`, `pane`, `tmux`, `none`, derived from the rung that answered and
never from what the caller believed. **`hook` IS GONE** and nothing can write it;
`seed_row` keeps its constant and has no writer on the live path. Both clients
still render a `via hooks` tooltip entry so a cached response from before the
swap does not break.

- **A GUESS MUST NEVER OUTRANK A RECORD**: `choose_agent_evidence` picks launch,
  row, fingerprint, nothing, a written inference carries its source with its
  value, and AN INFERENCE IS NOT INTENT, so it never reaches the respawn ladder.
- **`startup_gate` asks a DIFFERENT question from `activity_status`: has this
  session started at all?** A claude on its folder-trust dialog is a live pane
  with a healthy pid and NO REGISTRY RECORD YET, because the trust dialog runs
  BEFORE claude registers itself (`session_startup_gate.py`; the ladder is
  unchanged and only its rung-1 input moved).

## The status lights

Full model: `docs/session-status.md`. Record and owner rulings:
`docs/status-led-history.md`.

Eight states: `working`, `working_subagent`, `question`, `notice`,
`finished_unread`, `idle`, `dead`, `unknown`, and `unknown` is a real answer,
never `idle`. **THE EIGHT STATE NAMES STAY EIGHT; only the paint collapses onto
FIVE hues.** GREEN is working, YELLOW is stopped and waiting on you (`question`
and the startup gate), LIGHT BLUE is `notice` alone, GREY is `idle` and `unknown`
told apart by SHAPE, RED is `dead` and a dropped WebSocket told apart by the
LABEL alone, so those labels are load bearing and never paraphrases.

- **A SESSION WAITING ON ITS OWN SUB-AGENTS IS NOT WAITING ON THE USER**, and it
  is the RUNG ORDER that says so, not a counter: the turn-end record's
  `pendingBackgroundAgentCount` and the async-launch ledger answer `busy` above
  every registry rung, while an unanswered blocking tool at the end of the
  transcript outranks BOTH, because background agents do not unblock a human
  dialog. **TOASTS ARE RAISED ON TRANSITIONS BY `attention/watcher.py`**, the
  only raise site, and **A PERMISSION-CLASS TOAST IS SUPPRESSED BY NOTHING BUT
  THE EXPLICIT PER-SESSION MUTE**.
- **THE LED IS TWO INDEPENDENT RINGS** (`status-led.js`), so every surface must
  PASS IT SIGNALS (`unread`, `startup_gate`, `status_source`, `transport`), not
  just the status string.

## Restarting, recreating, and what a session comes back as

Record: `docs/restart-and-recreate-history.md`.

| Piece | File |
|---|---|
| The ladder, the projection, pane liveness | `src/core/session_respawn.py` |
| The preview, and validating an `agent_type` choice | `src/core/session_restart_preview.py`, `session_agent_choice.py`, `src/api/restart_routes.py` |
| Panel, options, reopen, arm control, continuity copy | `client/js/session-restart-{picker,options,return,live,continuity}.js` |
| Recreate a session whose tmux is GONE | `src/core/session_recreate{,_presence}.py`, `src/api/recreate_routes.py` |

- **A RESTART MEANS A RESUME, ON EVERY RUNG THAT CAN** (owner: "restart on recent
  is really just resume"), so `resume_extra_args` builds `--resume <uuid>` ONCE
  for all four command resolutions; NEVER concatenate the flag, which lands
  outside `zsh -c '...'`.
- **REPLACING WHAT IS RUNNING IS `respawn-pane -k` BEHIND FOUR GATES**: a
  positively live row, the picker's arm checkbox, the confirm modal naming both
  outcomes, and `confirm_restart_live`. `RespawnPlan.kills_live_pane` is the only
  thing that passes `-k`, and identity is MEASURED across the kill.
- **RECREATE IS GATED ON A MEASURED ABSENCE**, a COMPLETE listing with
  `tmux_presence` keeping `gone` / `present` / `unknown` apart and only `gone`
  acting; it is addressed by `session_uuid` and RE-KEYS the existing row.

## The conversation id, naming, and a project's folder

Record: `docs/session-identity-history.md`.

- `sessions.claude_session_uuid` is the id a restart resumes, and **A ONE-SHOT
  CHANNEL WITH NO RETRY IS THE WHOLE PROBLEM**: the `SessionStart` announcement
  that used to fill it fired ONCE per conversation, so one lost delivery left a
  row unable to resume for life. **IT IS RE-READ NOW, NOT ANNOUNCED**: claude's
  registry record carries `sessionId` and is rewritten on every status change,
  so `attention/registry_read.py` sees it every pass and gates on it, and the
  adopt-time correlation ladder (`claude_session_correlate_ladder.py`,
  `session_claude_correlate_bind.py`) writes the column. A CONTINUOUS SOURCE
  RETIRES THE DEFECT CLASS THAT A RECOVERY PATH ONLY PATCHED.
- **ONE NAME PER SESSION, LAST RENAME WINS FROM EITHER SIDE**, and no hook event
  carries a `/rename`, so the pane's name is readable only from the transcript.
- **A PROJECT'S DIRECTORY IS PERMANENT**, so `project_directory.py` canonicalises
  with `os.path.realpath`, NOT `expanduser`, which does not resolve symlinks and
  is how one directory becomes two projects.

## A session's theme, and the two stores that hold one

Record: `docs/session-identity-history.md`. `pinned_themes.json` is keyed on the
bare tmux NAME and holds a theme pinned to ONE session; `<working_dir>/.cc.theme`
is keyed on the DIRECTORY and holds a PROJECT default. **THE PIN WINS**
(`session_theme_resolution.py`), because a default that beats an explicit choice
is an override. **THE THEME PATCH WRITES THE PIN ALONE**, since the dotfile is
folder-wide and a per-session control writing a shared value is how pinning
session B rethemed session A; a project default goes through `set_project_theme`.
**A PIN OUTLIVES ITS TMUX SESSION**, claiming only what to paint if the name
returns, while the OWNERSHIP prune in that same pass STAYS.

## The terminal client

Record: `docs/terminal-client-history.md`.

- **ONE NAVIGATION GENERATION** (`navigation-generation.js`), a monotonic counter
  and not a target identity: capture the token SYNCHRONOUSLY at the gesture and
  check it immediately before the write you cannot take back, and a stale token
  DISCARDS silently. A BOOT PAINT IS NOT A NAVIGATION.
- **INPUT OWNERSHIP IS THE SAME RULE ONE LAYER DOWN**
  (`terminal-input-ownership.js`), because input in the wrong pane RUNS A
  COMMAND. **CLAIM AT THE GESTURE, CHECK AT THE WRITE**: a claim taken at
  completion time reads like a check and is a no-op.
- **THE WRITE QUEUE IS BOUNDED AT 4 MiB AND RELEASED ON A SWITCH**: queued bytes
  are ours and discardable, bytes handed to `term.write()` are XTERM's, so the
  release discards, AWAITS that write's callback, then resets, with NO TIMER, and
  it drops from the FRONT in WHOLE CHUNKS and ANNOUNCES it.
- **THE PRE-READY INPUT BUFFER IS KEYED BY CONNECTION GENERATION, NOT SESSION ID**,
  with no local echo ever, 64 KiB, and an overflow REJECTING THE WHOLE UNSENT BATCH.
- **THE CONNECT IS MEASURED, NOT SLEPT** (`terminal-readiness.js`), bounded at
  500 ms, and every wait polls a TIMER, never a frame (gotcha 9).
- **`terminal.ready` IS THE ONE POSITIVE STATEMENT THAT THE PANE CAN TAKE
  INPUT**, sent once and NEVER WITHHELD: it carries `startup_command` (`issued` /
  `none` / `failed` / `unknown`), and `failed` and `none` must never collapse.

## The archive, the integrity check, secret scanning, upgrades

Record: `docs/maintenance-history.md`.

- **Secret scanning**: install the pre-commit hook once per clone, add detectors
  only to `message_model_secrets.py`, never print or store a matched value, and
  remember **exit 2 from `scripts/scan_secrets.py` means could-not-scan, not a
  pass** (`docs/secret-scanning.md`).
- **A byte-exact archive of `~/.claude/projects` lives in `cloude.db`**, kept by a
  fail-soft loop (`corpus_ingest_*.py`): a steady-state pass must stay invisible, a
  skipped rooting pass is a NAMED STATE rather than zeros, and liveness is
  published on every terminating path including failures.
- **The `real_tmux` marker** is applied AUTOMATICALLY by `tests/conftest.py`, and
  `-m "not real_tmux"` is a fast loop that **IS NOT A VERIFICATION RUN**.
- **Stage files by name** when committing. No `git add -A`.
- **`PRAGMA integrity_check` IS A MAINTENANCE OPERATION, NOT A LIVENESS PROBE**,
  and must never go back on `GET /api/v1/version`, which the tray polls every
  20 s; `tests/test_db_integrity_verdict.py` booby-traps every binding.
- **ONLY A POSITIVE, FRESH, `ok` VERDICT TAKEN ON THIS DATABASE MAY SKIP THE
  PRAGMA** (`db_integrity_gate.py`), and a cached FAILURE runs the live pragma
  rather than short-circuiting.

## The archive's names come from the app database

The archive stores a project as the SLUG Claude Code derived from a cwd, and
the browser rendered that raw. `projects.display_name` in `cloude.db` has held
the real name all along and nothing joined the two.

| Piece | File |
|---|---|
| The forward slug join, the tie-break, the refusals | `src/core/archive_display_names.py` |
| The ONE bulk read of cloude.db | `src/core/app_name_index.py` |
| The seam that decorates an envelope after the read | `src/core/archive_name_decorate.py` |

**`observed_cwd` WAS THE INTENDED SOURCE AND IT IS EMPTY.**
`archive_project_names` derives its `display_name` from that column. Measured
2026-09-18: NULL on **100 of 100** rows, and `archive_project_overlay` holds
**0** rows, so every project painted its slug. An earlier pass checked exactly
those two places, correctly reported "no display name source exists", and never
looked in the app database.

**THE JOIN RUNS FORWARD, BECAUSE THE SLUG IS NOT INVERTIBLE.** Every character
outside `[A-Za-z0-9-]` becomes a single `-`, so `/`, `_`, `.`, a space and a
literal `-` all collapse onto one byte. `bhpp_new_server`, `3D Work` and
`dev_tools/scripts` all lose the thing that distinguishes them. So each
`projects.root` and `raw_path` is pushed through this project's OWN slug rule
(`path_spellings` into `slugify_project_dir`, never a second copy) and the
RESULT is compared to the archive's directory name. A lossy function is still a
function: computing it in its defined direction is exact. **Measured on live:
73 of 100 slugs resolve**, 64 as-written and 9 through a symlink spelling.

**ONE REAL DIRECTORY IS ONE NAME, AND THE NAIVE TIE-BREAK RECREATES THE SPLIT.**
`~/Development` is a symlink into iCloud, and the data carries the scar: project
4 `Hirschfeld (old path)` is rooted at the short spelling and project 6
`Hirschfeld` at the long one, so BOTH slugs match BOTH rows. Ranking by which
row matched more literally answers `Hirschfeld (old path)` for the short slug
and `Hirschfeld` for the long one, which is the defect restated rather than
fixed. `resolve_slug` instead asks whether the candidates denote the same real
directory (`realpath` of each root) and keeps the row whose root is ALREADY
CANONICAL, which is a measured filesystem property and the spelling
`project_directory` has written since `a4eeef1`. All 3 contested slugs resolve,
and both Hirschfeld slugs answer `Hirschfeld`.
`tests/test_archive_display_names.py` reproduces the naive rule inline so the
file fails if it returns.

**CANDIDATES THAT DISAGREE ABOUT WHICH DIRECTORY THEY ARE REFUSE**, because a
slug cannot adjudicate a real collision. Zero on the live corpus, and it is the
rung that stops the tie-break degenerating into "pick one".

**AN ANCESTOR IS NOT A NAME, AND THAT RUNG WAS BUILT AND THROWN AWAY.** Nine of
the 27 unresolved slugs are real subdirectories of named projects. Claiming the
parent's name labels a distinct project with another project's name, and the
slug prefix test that finds them cannot tell a child from a sibling whose name
merely starts the same way: `-Users-x-Media` prefixes both `/Users/x/Media/sub`
and `/Users/x/Media-Extra`, because the separator and the literal hyphen are the
same byte. Those nine report `none` and render their slug. The other 18 are
`/private/tmp` and `/private/var/folders` scratch directories that correctly
have no project row.

**`sessions.title` IS THE SESSION NAME, NOT `claude_title`.** Per the one-name
model, `claude_title` is the marker that makes `claude_title_sync` idempotent
under duplicated hook events, not a second name; measured on live it is set on
31 of 941 rows against `title`'s 896. `title` is joined on
`claude_session_uuid` = the archive's `session_ref` under the `uuid` scheme and
names **882 of 1,305** own conversations (67.6%). An `agent` sidechain is never
looked up: it has no row and never will.

**IT ADDS FIELDS AND OVERWRITES NONE.** `display_name` and `title` already on
these rows are measurements OF THE ARCHIVE, and `archive_titles`' `title_source`
would become a lie if a value from another database were written under it. The
new values arrive as `app_display_name`, `app_description`, `app_name_source`,
`app_project_id` and `app_session_title`, with `meta.app_naming` carrying the
rate. A corpus collected on ANOTHER machine has no row here, so the archive's
own reading stays the only one it has.

**ONE DATABASE OPEN PER LISTING, AND IT MUST NOT ATTACH.** The decoration runs
on an envelope the archive read has already finished and closed for, so the
`ARCHIVE_ONLY` connection never sees `cloude.db` and neither holds the other's
write lock. Decorating inside the read would put both files under one lock
scope, which is what `db_connection_shape` forbids and what produced the
516-second hold in issue #224. Measured: **1 connection, 2 statements, 5.1 ms**
for 79 projects and 882 titles, and it does not grow with the row count.
`tests/test_app_name_index_cost.py` pins the count rather than a clock, because
the count is the defect exactly.

**THE `$HOME` ALIAS SCAN IS NOW HOISTABLE.** `path_spellings` rebuilt the
symlink table on every call, which is right for the adopt and hook paths that
ask about one directory and stale-proof. A bulk caller paid it per project: the
owner's `$HOME` holds 474 entries and the scan costs 0.84 ms, so naming 79
projects spent **131 ms of a 139 ms** index build re-listing one directory 158
times. `home_dir_aliases()` is public and `path_spellings(aliases=...)` accepts
the table; the build is **4.1 ms** with identical results. It is scanned once
per PASS, never memoised for the process, or a new symlink would be invisible
until a restart.

## Refreshing the local install on a new version

Adam's rule: every new version, his local copy gets refreshed to it. Record:
`docs/maintenance-history.md`.

- **The version lives in exactly one place, `macOS/package.json`**, and killing
  Electron does not kill its Python child, which keeps serving the OLD code.
- **Two launch modes rsync from different places**: the packaged app from its own
  `Contents/Resources`, so launching it REVERTS unreleased repo changes, and dev
  mode (`npm start` from `macOS/`) from the repo root; both write the derived
  copy at `~/Library/Application Support/cloude-code-menubar/server/`.
- **macOS has no `setsid`**: use
  `nohup npm start > /tmp/cloude-menubar.log 2>&1 & disown`.
- **Verify the DERIVED copy by GREP, never by timestamp**, since rsync preserves
  mtime, and **sessions survive a refresh by design** on the `cloude` socket.
- Done when the port answers, the derived copy contains the new code (grepped),
  `tmux -L cloude list-sessions` is unchanged, and the version matches.

## The string layer, and the one catalog rule

Every user-visible string comes from ONE catalog both clients read, in
`client/js/i18n/` (`catalog.en.js`, `format.js`, `pseudo.js`, `catalogs.js`,
`runtime.js`, `boot.js`), with per-screen assembly in `client/js/labels/` and the
Svelte accessor `web/src/lib/i18n/index.svelte.ts`. **There is no second table,
ever, for any reason.** THE CATALOG IS DATA, NOT CODE (no functions, no template
literals), keys name what a string MEANS and are flat and dotted, there is NO
LIBRARY because `script-src 'self'` refuses the function ICU runtimes compile,
and A MISSING KEY RENDERS THE KEY ITSELF, loudly, never throwing. Model:
`.claude/notes/i18n-design.md`; record: `docs/web-build-history.md`.

## How we work here

Record, and the full test-baseline history: `docs/maintenance-history.md`.

- **Every function documented**: one-line description, typed inputs, typed
  output, an example when usage is not obvious. Types belong in the signature.
- **New logic goes in new focused modules.** Past the 500-line guideline and must
  not grow: `client/js/terminal.js`, `client/js/app.js`, `client/css/styles.css`,
  `src/core/session_manager.py`. `src/api/routes.py` is an AGGREGATOR now (106
  lines), so adding a router line to it is correct.
- **`src/config/` is a package and `settings.py` stays over 500 lines** by the
  owner's ruling; **`src/core/sessions/` holds the collaborators `SessionManager`
  composes**, where THE STATE MOVES AND NEVER COPIES, injection is KEYWORD-ONLY
  with a default, nothing may import `session_manager`, and no file may exceed
  500 lines (`tests/test_sessions_package_rules.py`).
- **No bare `except:` and no blanket `except Exception:` that swallows**: catch
  the specific error, log it with structlog context, or re-raise, and a
  deliberate swallow carries a comment saying why.
- **`python3`, never `python`.** Tests: `venv/bin/python3 -m pytest -q` from the
  repo root; system python3 has no fastapi.
- **TAKE YOUR OWN BASELINE ON A CLEAN TREE BEFORE YOU JUDGE YOUR OWN RUN.** Last
  reading, 2026-09-12 on `master`, `-p no:randomly`: **7365 passed / 0 failed /
  60 skipped**, node **203 suites all passing**, vitest **1430**. RE-MEASURE
  BEFORE QUOTING IT; it has been stale twice.
- **A CHECKOUT WITH NO `config.json` MANUFACTURES A FAKE FAILURE SET** (19 failed
  plus 26 errored in a fresh worktree); it is gitignored, so copy one in before
  you measure anything.
- **CI IS SWITCHED OFF, ON PURPOSE** (owner: "P25 - kill the CI"), three
  workflows `disabled_manually`. NO TEST WAS FAILING AND NO TEST WAS REMOVED: the
  runs were refused for billing BEFORE STARTING, and **a check that could not run
  is not a check that failed** (`docs/ci.md`).
- **`node --check`** every JS file you touch, before you claim it works.
- **Voice**: no em-dashes, no en-dashes, no emojis, anywhere, including commit
  messages. UI copy is lowercase and plain.
- **Push only to `Adoom666/CloudeCodeDev`. It is the only repository: nothing is
  pushed, mirrored or released anywhere else. NEVER to `upstream`
  (Adoom666/CloudeCode)** (owner's ruling, `docs/DECISIONS.md`). On Adam's clone
  that remote is `origin`, so check `git remote -v` first; the `upstream` push
  URL is `DISABLED_do_not_push_to_Adoom666_CloudeCode` and must be re-applied on
  a fresh clone.
- **`gh`'s active account is GLOBAL TO THE MACHINE and does not hold still**,
  because other agents run `gh` under other accounts: never `gh auth switch`, and
  assert your own on EVERY call with
  `GH_TOKEN="$(gh auth token -u <account>)" gh ...`, the token coming from
  command substitution AT CALL TIME and NEVER written to a file, an env file, a
  commit or a log.

## Gotchas that have cost real time

Full text and the incident behind each: `docs/gotchas-detail.md`. Other documents
cite these BY NUMBER, so the numbers do not move.

1. **Wrapper vs `.session`.** Check which level of `SessionInfo` you are on
   before you go looking in the backend; it reads like a missing field.
2. **Hook events are unordered, duplicated and droppable.** Floor the counters
   and make every transition idempotent.
3. **An adopted session is not a launcher "project".** Deep links resolve
   projects first, then live/adopted sessions; resolving only projects spawned a
   duplicate. Unresolvable targets go through `rejectTarget()`.
4. **The tmux socket is load-bearing.** Shelling out to `tmux` without
   `-L cloude` talks to the user's personal tmux server.
4b. **A session id is not a tmux name, and deriving one from the other loses
   sessions**: `build_backend` with no `session_name` rebuilds a name no socket
   ever carried, so pass the STORED `tmux_session`.
5. **A uuid on the row is not evidence a transcript exists, and a missing
   transcript is not evidence the conversation is gone.** `--fork-session` mints
   phantoms; check the archived twin before declaring history lost.
6. **cwd spelling splits a session in two.** `~/Development` is a symlink into
   iCloud and the transcript directory comes from the LITERAL cwd string, so
   always write the long iCloud spelling, in code and in documents.
7. **`if (pinned) apply()` with no else leaves the last session's theme on
   screen.** A missing else is state left over from the previous thing; every
   navigation goes through `ThemeNavigation.applyForTarget()`.
8. **A stale doc is worse than no doc.** A missing doc sends the next agent to
   the code; a confidently wrong one sends it to write a bug. Update the document
   in the same change as the behaviour.
9. **A bare `await requestAnimationFrame` never resolves in a hidden tab**, so
   anything that must happen for a background tab races a timer instead
   (`terminal-layout-wait.js`): a wait may DELAY the work, never cancel it.
10. **`CLOUDECODE_SESSION_ID` IS FIXED INTO A PANE AT SPAWN, so after a re-adopt
    the row id and the id the pane believes in can diverge**, and a flag keyed on
    the row id is one the pane's own claude can never clear. Ask of any flag
    keyed on a session id whether the two ids can diverge: the attention ledger
    and the unread flag both key on `UnreadStore.compose_key(tmux_name, epoch)`
    for this reason, because that identity IS the pane. The original incident's
    mechanism, a synthetic hook event aimed at a row id, was removed on
    2026-09-13 with the hooks; the lesson is not.
11. **A CHECK THAT PASSES BECAUSE IT LOOKED AT NOTHING**, the most repeated
    failure shape here. **A GREEN CHECK MUST FIRST PROVE IT CAN GO RED**: ask
    what it does when its subject is ABSENT, its tool MISSING, and its output
    goes to a pipe, and never read exit 0 from a command whose stderr you
    discarded.
12. **A NAME THAT MOVED, REACHED THROUGH `getattr` OR `hasattr`, MERGES WITH ZERO
    CONFLICTS AND ANSWERS FALSY**, and `setattr` on a name an object does not
    carry SUCCEEDS too, so grep for all three on a moved member's OLD name before
    you trust a green suite.
13. **THE DEPLOYED SERVER TREE IS DERIVED, AND THE APP REWRITES IT ON EVERY
    LAUNCH.** `macOS/bootstrap.js` runs
    `rsync -a --delete <bundle>/Contents/Resources/src/` into
    `~/Library/Application Support/cloude-code-menubar/server/src/` on every
    launch, dev included. So files copied into the server dir survive right up
    to the restart meant to pick them up and are wiped BY that restart.
    Measured 2026-09-18: five files sha-verified in place, `bootout` plus
    `bootstrap`, and afterwards the two modified ones held their pre-deploy
    shas and the three new ones were gone - with the server listening, health
    200, auth refusing and the log perfect. **Deploy to
    `/Applications/Cloude Code.app/Contents/Resources/src/`.** The bundle is
    adhoc-signed and its seal covers `Resources/src`, but `codesign --verify`
    already reported "a sealed resource is missing or invalid" BEFORE anything
    was touched and the app has launched in that state for weeks; measure that
    rather than assuming either way. What caught the revert was asking which
    FILE the process imported: move the relevant `.pyc` to `~/.Trash` before
    the restart, and CPython writes one back only when it imports the `.py`
    beside it, so a fresh timestamp under the deployed tree is provenance and
    an absent one is proof the module was never reached.

## Where the 1.4.0 integration moved things

Record: `docs/integration-1.4.0-history.md`. The other party's line keeps the
older spelling of these names, so a merge from it compiles cleanly and reaches
for seams this line has already moved.

| His spelling | This line |
|---|---|
| `session_manager.sessions` / `.backends` | `session_manager._registry.sessions` / `.backends` |
| `session_manager._subscribers` | `session_manager._registry.subscribers` |
| `session_manager.subscribe_output` / `unsubscribe_output` | `SessionRegistry.subscribe` / `.unsubscribe` |
| `session_manager._pending_toasts`, `ack_toast`, `get_toasts` | `session_manager._toast_inbox.pending` / `.ack` / `.get` |
| `session_manager._hook_tmux_names`, `_mint_hook_token` | `session_manager.hook_tokens.tmux_names` / `.mint`, plus `.keep` and `.name_for`. The STORE AND THE MINT-AT-SPAWN SURVIVE because the boot re-adopt reverses that map, but the route's `validate` and `recover` are DELETED and move to nothing |
| `session_manager.pinned_themes`, `set_project_theme`, `resolve_project_theme` | `session_manager._theme_store.*` |
| `session_manager.pending_terminal_commands` | `session_manager._sidecars` |
| `session_manager._owned_instances_from_db`, `is_owned_tmux_name` | `session_manager._owned.instances_from_db` / `.is_owned_name` |
| `session_manager._last_probe_socket` | `session_manager._probe_health.socket` |
| `src/api/routes.py` handlers | the sibling module that owns the resource |
| `src/config.py`, `src/models.py` | the `src/config/` and `src/models/` packages |

**THE DANGEROUS HALF IS THE ONE THAT DOES NOT RAISE**: a moved name reached
through a `getattr` or a `hasattr` answers FALSY instead of failing, and two of
that shape reached production after the fold. After any merge from that line,
grep for `getattr` / `hasattr` / `setattr` on every moved name, and **check
`src/api/routes.py`'s LINE COUNT before anything else** (106 is correct;
4,000-plus means the decomposition was silently reverted).
