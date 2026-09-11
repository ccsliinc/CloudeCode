# Cloude Code

Drive a Mac's live Claude Code sessions from a phone. A FastAPI server owns real
tmux sessions on the Mac, streams the PTY over a WebSocket, and paints it into
xterm.js in a browser. The session runs whether anyone is watching or not, which
is the whole point and the source of most of the interesting design.

Read this before writing code here. It is orientation first, conventions second.

## THE SPELLING "Cloude" IS DELIBERATE. NEVER CORRECT IT.

This product is called **Cloude Code**, one letter off "Claude Code", and that
is on purpose. Measured 2026-09-10: **214 files** in this tree carry the
spelling (`grep -rl "Cloude" .`, excluding the repository metadata directory,
`venv` and `node_modules`). It looks exactly like a typo that propagated, which
is why this warning is the first thing in the file rather than an entry in the
gotchas list at the bottom.

A rename is NEVER in scope for a tidying, linting, typo-fixing or naming
consistency pass. It is not a small change and it is not reversible by a second
find-and-replace, because the string is load bearing in places that are not
prose:

- **The tmux socket, `tmux -L cloude`.** Every session this app owns lives on
  that socket. Rename it and the server addresses a socket with nothing on it,
  while the user's live panes carry on running somewhere it can no longer see.
- **The session name prefix, `cloude_*`** (`SESSION_PREFIX`,
  `src/core/tmux_backend.py`). Discovery, adoption, the boot re-adopt and the
  recreate gate all scope themselves by that prefix. Change it and every
  existing session becomes invisible to its own app.
- **The database filename, `cloude.db`**, and the state directory
  `~/Library/Application Support/cloude-code-menubar/`. Rename either and the
  app boots onto an empty database beside the real one, losing every project
  binding, title, pinned theme and unread flag on disk.
- **The Electron bundle id, `com.cloudecode.menubar`** (`macOS/package.json`).
  macOS keys permissions, the login item and the app's own container on that
  id. A changed bundle id is a different application to the operating system.
- **Every environment variable, `CLOUDE_*`**, and every log event name a
  running install and its already-installed hook block emit today.

So the blast radius of "fixing the typo" is: the sessions the user is currently
working in, their entire database, and the app's identity to macOS. If you were
told to fix typos, this is not one of them. If a document, a comment, a path or
a variable reads `Cloude`, leave it.

The same prohibition is carried by `.github/ISSUE_TEMPLATE/task.yml` and by
`.claude/skills/work/SKILL.md`. Both of those are opt-in and reach only an
agent that happens to read them. This file is the one every agent loads, which
is why a third copy is correct rather than duplication.

## Every document in `docs/`, and when to read it

CLAUDE.md is the only entry point guaranteed to be loaded, so a document it
does not name is effectively invisible: a clean-context agent will re-derive
what the file already says, or contradict it. Gotcha 8 below is the argument -
a doc nobody can find is a missing doc that still costs maintenance.

This table is the routing layer. Read the one that answers your question; do
not read all 27.

| Document | Read it when |
|---|---|
| `docs/DECISIONS.md` | **Before you re-litigate any design choice.** Standing rulings from Adam, who owns the code and is the sole tie-breaker. A ruling binds both parties and both sides' agents. This is the file that says double-click rename stays. |
| `docs/LESSONS.md` | Before you debug something that feels familiar. Defect shapes that have bitten this project more than once, with the evidence. Add one when a pattern REPEATS; once is an incident, twice is a pattern. |
| `docs/session-status.md` | Anything about the status lights. The single source of truth for the state model, the two rings, the five colours and where each fact is stored. |
| `docs/session-status-model.md` | You need the transition-by-transition derivation. Four independent state machines, every state citing the symbol it was read out of, drift-tested by `tests/test_status_model_chart_drift.py`. |
| `docs/notifications.md` | Anything about toasts. Raising is global, dismissing is per session, and those are independent axes. Also the external push channels: the queue stays sequential, the three channels inside one entry go out at once under a per-channel bound. |
| `docs/alert-state-model.md` | You are designing alerting. DESIGN ONLY, nothing in it is built, and it deliberately disagrees with `docs/session-status-model.md` in two places. Read that one first. |
| `docs/session-project-operations.md` | You need to know what an operation does to a session row, a project row and the tmux session underneath. Every node cites the symbol it came from. |
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

Two rules keep this table honest. **Unreferenced is not unused**, so do not
delete or move a file in `docs/` because it looks orphaned. And **a new file in
`docs/` gets a row here in the same change**, or it is invisible on the day it
is written, which is the failure this table exists to end.
`tests/test_docs_index.py` fails the build if a `docs/*.md` file is not named
in this file, on the same principle as `tests/test_no_remote_assets.py`.

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

`client/` is served straight off disk under `/static`. There is no bundler, no
transpile, no `client/package.json`. A file you add there is live on reload, so
it must be valid in the browser as written. Run `node --check` on every JS file
you touch. That is still true of `client/js`; the one compiled tree is `web/`,
described next.

## The `web/` build

**TWO FRONTEND TREES LIVE IN THIS REPO AT THE SAME TIME, ON PURPOSE.** `client/js`
is the app: hand-written vanilla JS, no build step, served off disk. `web/` is a
Svelte 5 + TypeScript + Tailwind project that vite compiles into `client/dist/`.
They coexist for the length of a screen-by-screen (strangler) migration, and
during it a screen is either legacy or compiled, never half of each. The
owner's framing, verbatim: "lean and mean. kiss." No SvelteKit, no node process
at runtime, no SSR, and no vite dev server - FastAPI serves the emitted files
under `/static` exactly as it serves everything else.

| Piece | Where |
|---|---|
| The vite project | `web/package.json`, `web/vite.config.ts`, `web/svelte.config.js`, `web/tsconfig.json`, `web/vitest.config.ts` |
| Tailwind entry (utilities only, prefixed) | `web/src/app.css` |
| Entry point, publishes `window.CloudeWeb` | `web/src/main.ts` |
| The first ported component and its two pure modules | `web/src/lib/StatusLed.svelte`, `led.ts`, `status-dot.ts` |
| THE ONE MOUNT PATH, used by every migration slice | `web/src/lib/mount.ts` |
| Slice 1, the attribution prompt card | `web/src/lib/launchpad/AttributionPrompt.svelte`, `attribution.ts` |
| Slice 2, the recent sessions section | `web/src/lib/launchpad/RecentSessions.svelte`, `recent.ts`, `recent-actions.ts`, `recent-chrome.ts`, `recent-visibility.ts` |
| Slice 3, the session data layer | `web/src/lib/sessions/store.svelte.ts`, `running.ts`, `attribution.ts`, `listing.ts`, `poller.ts`, `host.ts`, `env.ts`, `types.ts` |
| Slice 4, the project tree | `web/src/lib/launchpad/ProjectTree.svelte` and its six children, `project-{groups,node,chrome,chrome-control,tree-host}.ts`, `tree-collapse.svelte.ts` |
| Slice 5, the running sessions list | `web/src/lib/launchpad/RunningSessions.svelte`, `RunningSessionRow.svelte`, `RunningSessionName.svelte`, `StartupGateBadge.svelte`, `WrapperPill.svelte`, `running-{row,actions,host,chrome}.ts`, `web/src/lib/sessions/session-label.ts` |
| Slice 6, the modals and the create flows | `web/src/lib/launchpad/{ModalShell,ChoiceModal,CloneModal,EditProjectModal,ProjectFolderModal,ProjectNameModal}.svelte`, `create-{flow,host,harness}.ts`, `entry-flows.ts`, `open-folder-flow.ts`, `project-{actions,folder}.ts`, `modals.ts`, `modal-types.ts`, `web/src/lib/modal.ts` |
| Slice 7, the shell and the shim | `web/src/lib/launchpad/{HomeScreen,HelpDisclosure,RichText}.svelte`, `home-{screen-host,chrome,sections,anchors}.ts`, `new-fab.ts`, `panels.ts`, `navigation.ts`, `nav-host.ts`, `deep-link.ts`, `status-report.ts`, `rich-text.ts`, `shim.ts` |
| The copy the shell prints | `client/js/labels/home-screen.js` |
| The copy those two print | `client/js/labels/project-tree.js`, `client/js/labels/running-session.js` |
| The shared icon geometry, as DATA | `client/js/icons/glyphs.js` |
| The copy the data layer prints | `client/js/labels/session-listing.js` |
| Put the REAL bundle in a node test's sandbox | `tests/helpers/cloude-web-sandbox.mjs` |
| Per-device UI preferences, on the legacy keys | `web/src/lib/ui/prefs.svelte.ts` |
| Its tests, incl. the equivalence proof | `web/src/lib/StatusLed.test.ts` |
| Slice 1's tests | `web/src/lib/launchpad/attribution.test.ts` |
| Slice 2's tests | `web/src/lib/launchpad/recent{,-actions,-chrome,-visibility}.test.ts`, `no-delete-wording.test.ts` |
| The emitted bundle, COMMITTED | `client/dist/app.js`, `client/dist/app.css` |
| Prove the committed bundle is current | `scripts/web-build-check.sh` |

**The workflow is `npm run build` from `web/`, and `npm run watch` for a
rebuild-on-save loop.** `npm test` runs vitest, `npm run check` runs
svelte-check. There is deliberately NO vite dev server and no HMR: a dev server
would need a proxy in front of FastAPI and a CSP relaxation to load its client,
and both are permanent complications bought for a convenience. Build, reload,
move on.

**THE OUTPUT FILE NAMES ARE FIXED - `app.js` and `app.css`, no content hash -
and that is a decision, not a default.** `client/index.html` is a hand-maintained
1400-line file that keeps loading the legacy scripts throughout the migration,
so it references the bundle by a name that must never change; a hashed name
would mean rewriting that file on every build. Cache correctness is not given
up, because `NoCacheStaticFiles` (`src/main.py`) already stamps
`Cache-Control: no-cache, must-revalidate` on every `.js` and `.css`, so the
browser revalidates each load. The names are set in
`build.rollupOptions.output`.

**`client/dist` IS COMMITTED, AND THE `.gitignore` NEGATION THAT KEEPS IT
TRACKED IS LOAD BEARING.** `scripts/deploy-mini.sh` ships the committed file set
by tar and the mini runs no build, so an ignored bundle would deploy nothing -
and every hash check in that script would then compare an absent file against an
absent file and read green, because absent on both sides compares equal. Note
the `dist/` line in the Python section of `.gitignore` has no leading slash and
so matches a directory named `dist` at ANY depth: measured 2026-09-09,
`git check-ignore -v client/dist/app.js` answered `.gitignore:9:dist/`. The
`!client/dist/` negation is what un-ignores it.

**A COMMITTED ARTIFACT HAS ONE FAILURE MODE AND IT IS SILENT**, so
`scripts/web-build-check.sh` exists: it rebuilds from `web/src` and fails if
`git status --porcelain client/dist` is non-empty. It is wired into
`deploy-mini.sh` BEFORE the transfer (exit 1 becomes `DEPLOY FAILED`, its exit 2
- could not evaluate, no node - becomes `CANNOT DETERMINE`, because a check that
did not run is not a check that passed; `CLOUDE_DEPLOY_SKIP_WEB_CHECK=1` is the
named, printed escape hatch) and into the `javascript` job in
`.github/workflows/tests.yml`. Every dependency in `web/package.json` is pinned
to an exact version and `package-lock.json` is committed, because the check
compares BYTES and a floating transitive dependency would make it fail for a
reason nobody caused. Use `npm ci`, not `npm install`.

**NO INLINE SCRIPT AND NO REMOTE ANYTHING, WHICH IS WHY VITE NEVER SEES AN
HTML FILE.** `build.rollupOptions.input` points at `web/src/main.ts`, not at an
`index.html`, so vite's HTML plugin never runs and never emits a document or
the inline module-preload script that `script-src 'self'` would refuse. We own
`client/index.html`. `tests/test_no_remote_assets.py` now also reads the
emitted bundle: it fails on a remote URL in a LOADING position (an import
specifier, a CSS `@import` or `url()`, a `src`/`href`, a Worker) and on any
`eval` or `new Function`, with a negative control asserting both patterns can
actually match - a bare `https?://` scan would fail on Svelte's own error-message
URLs and the XHTML namespace string, which are inert, and teach everyone to add
exemptions.

**TAILWIND SHIPS UTILITIES ONLY, PREFIXED `tw:`, INSIDE `@layer utilities`, AND
ALL THREE OF THOSE ARE ABOUT NOT TOUCHING THE RUNNING APP.** Preflight is not
imported at all, because it is a global reset and this stylesheet loads beside
every legacy stylesheet in the app. The prefix exists because Tailwind finds
class names by scanning TEXT, comments included: the first build of `web/src/app.css`
emitted `.container`, `.block`, `.inline` and `.ring` purely because those words
appear in the prose of the TypeScript beside it. Measured on this repo
2026-09-09, no legacy element carries any of the four (the five `container` hits
are all `*-container` compounds), so that was a landmine rather than a live bug -
and `tw:flex` cannot collide with anything the legacy tree writes. The layer is
the guard in the other direction: for normal declarations an UNLAYERED rule
beats a layered one at any specificity, and every legacy stylesheet here is
unlayered. Automatic source detection is off (`source(none)`) with one explicit
`@source` naming `web/src`, so nothing outside that tree can contribute a class
name.

**THE FIRST PORT IS THE STATUS LED, AND ITS CONTRACT IS BYTE-IDENTICAL OUTPUT.**
`web/src/lib/led.ts` ports `client/js/status-led.js` and
`web/src/lib/status-dot.ts` ports the status half of
`client/js/session-status-ui.js`; `window.CloudeWeb.ledHtml(status, signals)`
must return exactly what `SessionStatusUI.dotHtml(status, signals)` returns.
That is not asserted by hand-written expectations, which would only prove the
port agrees with what the porter remembered: `web/src/lib/StatusLed.test.ts`
loads the two REAL legacy files in a `vm` sandbox and compares string against
string across the whole cross product of status, unread flag, startup gate and
status source - 1008 comparisons, plus a negative control proving the
comparison is capable of failing. Measured in a real browser under the
production CSP on 2026-09-09: 1008 of 1008 identical.

**THE STATUS LED IS STILL WIRED TO NOTHING, AND THAT IS DELIBERATE.**
`main.ts` publishes it but no legacy parent calls it: the parents build their
rows as HTML strings and set them with `innerHTML`, so switching one means
rewriting a parent, which is slices 4 and 5. The Svelte runtime is proven end
to end regardless: `window.CloudeWeb.renderProbe()` mounts the compiled
component into a DETACHED element and hands back its `outerHTML`, so a broken
Svelte runtime cannot pass while every pure string function still would.

**`mountPanel` IS THE ONLY WAY A COMPONENT REACHES THE DOCUMENT, AND EVERY
SLICE USES IT.** `web/src/lib/mount.ts` records one `mount()` handle per
container id and `unmount()`s the previous one before mounting the next.
Svelte's `mount()` APPENDS and returns a handle that owns the reactive effects
behind those nodes, so calling it twice on one container paints twice and
leaves the first set of effects running, subscribing and answering forever.
Nothing outside that file may call `mount()` on an element that is in the
document. It does NOT clear the container - `unmount()` removes the nodes
Svelte created and nothing else, which is exactly right while a container is
shared with legacy markup mid-migration, and a helper that also wiped would be
a hidden second behaviour a later slice could not turn off. A missing container
is a warned no-op, not a throw: that is what the legacy renderers did, and a
mount that silently does nothing is indistinguishable from a component that
renders nothing.

### Migration status

The plan and its seven slices are `.claude/notes/svelte-migration-launchpad.md`.
A slice deletes its legacy code in the same commit; a screen is legacy or
compiled, never half of each.

- **Slice 0, toolchain** - DONE (`9d31ec4`). vite + Svelte 5 + TypeScript +
  Tailwind, the StatusLed proof component, nothing wired.
- **Slice 1, the attribution prompt card** - DONE. 224 lines out of
  `client/js/launchpad.js`, `mountPanel` built, `loadProjects()` calls
  `window.CloudeWeb.launchpad.mountAttributionPrompt()` where its own render
  used to run. Proven in a real browser under the production CSP.
- **Slice 2, the recent sessions section** - DONE (issue #67, PR #68 on
  `Adoom666/CloudeCodeDev`). 792 legacy lines gone: nine methods and the two
  show-archived preference accessors out of `client/js/launchpad.js`, plus
  `client/js/session-recent-visibility.js` and its script tag deleted outright.
  The shared store starts here holding the recent slice only. Every user-visible
  string goes through `client/js/i18n/catalog.en.js`; 33 keys added.
  Proven in a real browser under the production CSP.
- **Slice 3, the session data layer** - DONE (issue #70, PR #71 on
  `Adoom666/CloudeCodeDev`). 787 legacy lines gone: thirteen methods and
  the twelve instance fields they wrote, out of `client/js/launchpad.js`.
  See "The launchpad's session data layer" below.
- **Slice 4, the project tree** - DONE (issue #76, PR #77).
- **Slice 5, the running sessions list** - DONE (issue #90, PR #91 on
  `Adoom666/CloudeCodeDev`). 1,032 legacy lines gone from
  `client/js/launchpad.js` (4,093 to 3,023): fifteen methods, the
  `_lastRunningSig` cache and two orphan docblocks slice 4 left behind,
  plus `client/js/session-list-busy-guard.js` and
  `client/js/launchpad-wrapper-pill.js` deleted outright with their script
  tags. See "The running sessions list" below.
- **Slice 6, the modals and the create flows** - DONE (issue #98, PR #99 on
  `Adoom666/CloudeCodeDev`). Seventeen methods and `client/js/project-create-folder.js`
  left `client/js/launchpad.js` for eleven entry points on the namespace.
- **Slice 7, the shell, and the end of `client/js/launchpad.js`** - DONE
  (issue #102, PR #103 on `Adoom666/CloudeCodeDev`). THE FILE IS DELETED.
  The last 1,875 lines - `renderLaunchpadUI`'s 363-line template string, the
  six FAB methods, the header help toggle, the three section disclosures and
  their localStorage map, the home bar's version chip and server-controls
  wire, `updateStatus`, `showError` and the eight navigation methods - are
  `web/src/lib/launchpad/HomeScreen.svelte` and the modules beside it. See
  "The home screen shell, and the shim that replaced launchpad.js" below.

## The home screen shell, and the shim that replaced launchpad.js

`client/js/launchpad.js` DOES NOT EXIST. Slice 7 deleted it. The home screen
is `web/src/lib/launchpad/HomeScreen.svelte`, mounted into the empty
`#launchpad-screen` div `client/index.html` still owns, and `window.Launchpad`
is a shim the bundle publishes.

| Piece | File |
|---|---|
| The shell's markup, and every anchor in it | `web/src/lib/launchpad/HomeScreen.svelte` |
| The help panel, and the marker set its prose carries | `HelpDisclosure.svelte`, `RichText.svelte`, `rich-text.ts` |
| Mount and tear down the screen | `home-screen-host.ts` |
| The four panels, in mount order, as ONE list | `panels.ts` |
| The imperative wires: version, server controls, help, disclosures | `home-chrome.ts` |
| The collapsed-section map, on the legacy key | `home-sections.ts` |
| The ids outside code addresses, written down | `home-anchors.ts` |
| The "+" speed dial | `new-fab.ts` |
| Every navigation, and the two rules they may not break | `navigation.ts`, `nav-host.ts`, `deep-link.ts` |
| The status line and the error card | `status-report.ts` |
| `window.Launchpad` | `shim.ts` |

**THE SHIM MERGES, IT DOES NOT ASSIGN, AND THAT IS AN ORDERING FACT.** The
bundle is a `<script type="module">`, so it runs AFTER every classic script on
the page. `client/js/providers.js` publishes the launch picker onto
`window.Launchpad` at its own load time, which is earlier. Assigning a fresh
object in the bundle would drop that publication on the floor and the first
"new project" would open a picker that resolves null; so `publishLaunchpadShim`
merges into whatever it finds, and `providers.js` creates the object if it is
not there yet. `window.CloudeWeb` still THROWS on a collision, for the opposite
reason: nothing but `main.ts` is supposed to publish into it.

**EIGHT MEMBERS, EACH WITH A NAMED CALLER, AND THE LIST IS MEASURED RATHER THAN
REMEMBERED.** `launchpadScreen` and `init` (`app.js`, the "already inited" test
and the mount), `loadProjects` (`app.js`, on every arrival at the screen),
`loadRunningSessions` (`terminal.js`), `openProjectByName` (`router.js`),
`_deriveRunningSessionDisplayName` (`app.js`, the deep-link slug),
`sessionRecords` (`session-sidebar-clicks.js`), and `showProviderModal`, which
`providers.js` WRITES and `nav-host.ts` reads. The migration plan predicted
twelve; six slices of movement plus three call sites resolved in this one leave
these eight, and `web/src/lib/launchpad/shim.test.ts` greps `client/js` and
requires the two sets to agree in BOTH directions - a member the tree uses and
the shim lacks is a TypeError on whatever screen reaches it, and a member
nothing uses is dead weight that makes the next reader think this is unfinished.

**THE FOUR LOAD-BEARING IDS ARE ANCHORS, AND THE RE-PARENTING IS LEFT ALONE.**
`app.js:896` toggles `.active` on `#launchpad-screen`, which stays in
`client/index.html` and is the MOUNT TARGET, so the shell never renders it.
`app.js:358` re-parents the one `#statusText` node into `#home-bar-status`;
`app.js:381` writes `#home-bar-status-text` from that node's `data-status`
through a MutationObserver; `globalAudioToggle.js:300` inserts its button as
`#home-bar-status`'s SIBLING, which makes `.home-bar` load-bearing too. All
four re-derived on this tree, unchanged. `home-anchors.ts` enumerates them so a
guard can iterate. **What this costs the shell is that every one of those nodes
must be STATIC markup**: a `{#if}` or a keyed `{#each}` over them re-creates the
node and silently drops whatever was moved in, and the symptom - a status light
that vanishes on the second visit to the home screen - looks nothing like its
cause. There is deliberately NO message bus for either surface; the plan's
section 6 asks for an anchor and says so.

**THE SHELL READS NOTHING, SO IT PAINTS ONCE.** Slices 4 and 5 both found the
same trap - a reactive subscription makes every intermediate assignment a
repaint where the old renderer painted once at the end - and this component
carries no rune but its props. The one thing that changed is the REFETCH path:
`loadProjects()` used to REMOUNT the attribution card and the RECENT list to
refresh them, throwing both away to change at most a row. Each now exports
`refresh()` on its mount handle and `panels.ts::refreshLaunchpadPanels` calls
it. `HomeScreen.behaviour.test.ts` holds a MutationObserver across the mount
and asserts zero records outside the four panel containers.

**A DEEP LINK STILL NEVER CREATES, AND THE GUARD IS STILL DOUBLE.**
`openProjectByName` resolves LIVE sessions only and reaches
`Router.rejectTarget` on a miss; `selectProject` throws while
`resolvingDeepLink` is set, so a future refactor that re-wires the two fails
loudly instead of minting `<name>-2`. A listing that did not run is still not
an empty listing: the ladder re-asks up to five times while the probe CANNOT
DETERMINE and takes the first answer that did run.

**TWO THINGS THE BROWSER FOUND THAT NO TEST HAD.** First, `mountPanel`
APPENDS into its container and never clears it, so the
`<div class="launchpad-empty">loading projects...</div>` the shell used to put
inside `#project-list` sat on screen above the tree forever - the legacy
`renderProjectList()` had been clearing it with an `innerHTML` write. A PANEL
OWNS ITS CONTAINER: no markup goes inside one. Second, the rejoin's pre-fit
carried gotcha 9 over verbatim from `launchpad.js` - a bare
`await requestAnimationFrame` pair, which NEVER RESOLVES in a backgrounded tab,
so a deep link resolved there froze inside `prepareTerminal` and never
returned. `nav-host.ts::twoFrames` races it against a 250 ms timer, the same
number and the same rule `client/js/terminal-layout-wait.js` uses: a layout
wait may DELAY the work, never cancel it.

**THE HELP PROSE KEEPS WHOLE SENTENCES, WHICH IS WHY IT CARRIES MARKERS.** It
is the longest copy this app owns and nearly every paragraph has an inline
`<code>` in it. Splitting each into the fragments around those spans fixes the
english word order into the template, and word order is exactly what a
translation changes. So each paragraph is ONE catalog message carrying
`[[code]]`, `((em))` and `<<link>>`, expanded by `rich-text.ts` into DATA that
`RichText.svelte` renders through Svelte's own `{expr}` escaping - so there is
no `{@html}` on this path, which is the review trigger the migration plan names
for this screen. A marker set is not a mini-language: no expressions, no
nesting, one pass, nothing compiled. **A COMMAND IS NOT COPY**: the three shell
commands the panel shows are data in `client/js/labels/home-screen.js`, because
a translated `tmux -L cloude` is a broken instruction.

**AND `project.create.console.description` IS GONE RATHER THAN WORKED AROUND.**
It was a catalog sentence that got STORED as the console project's description
in `config.json`, so a locale change could never retranslate it - the
server-strings gap `.claude/notes/i18n-design.md` section 7 names, reached from
the client. A description is USER data; the console row is identified by its
NAME, and an adopted session's project row has carried `''` since it shipped.
The console project is now created with no description at all.

**THREE LEGACY CALL SITES WERE RESOLVED, NOT FORWARDED.** `providers.js` has
its own `escapeForMarkup` (the text-node form, so the browser's serialiser is
the implementation) and calls `window.App.showConfirmModal` directly, which is
the owner it was forwarding to through the shim anyway;
`terminal-commands-panel.js` calls `window.CloudeWeb.launchpad.createConsoleSession`.
`create-host.ts` also stopped bouncing five of its own calls through the shim.

**THREE OF SLICE 2's MOVED METHODS HAVE CALLERS THE SLICE DOES NOT OWN, and
they were not left behind as a second copy.** The project tree's ended rows
archive and restart (slice 4); the running-sessions row forks (slice 5). Both
still-legacy surfaces now call `window.CloudeWeb.launchpad.archiveSessionRecord`
/ `.restartRecentSession` / `.forkSession` by name. One behaviour, one greppable
call site per surface, no dual path. Note `tests/test_session_restart_identity.node.mjs`
stubs that NAMESPACE now rather than `Launchpad._restartRecentSession`: stubbing
the old method name would assert against a function nothing calls, which is the
quietest way for a test to stop testing.

**THE RECENT SECTION'S HEADING IS STILL LEGACY MARKUP, AND THAT IS DELIBERATE.**
`mountPanel` puts the component inside `#recent-sessions-list`, while
`#recent-sessions-count`, `#recent-show-deleted-toggle` and
`#recent-sessions-section`'s own visibility are SIBLINGS of it that this section
still owns. `initSectionDisclosures()` binds the collapse to that heading once at
boot, so re-rendering it would drop the listener on the floor and the failure
would be a chevron that stops working rather than an error anybody sees. The
three writes therefore live in one module, `recent-chrome.ts`, injected as part
of the component's host so it stays assertable with no document.
`web/src/lib/launchpad/recent-chrome.test.ts` asserts the component's chrome
never touches the list container AT ALL, by recording every element it asks for.

**A `localStorage` READ AT IMPORT TIME BREAKS THE BUNDLE'S OWN CONTRACT, and it
broke a test that had nothing to do with this slice.** `main.ts` promises that
LOADING the bundle does no work. `prefs.svelte.ts` first read its preference at
module scope, and `tests/test_session_row_menu_superset.node.mjs` started failing:
it loads `client/dist/app.js` into a `vm` sandbox where `localStorage` is absent
and `console` carries no `warn`, so the read threw, the catch reached for a
method that did not exist, and the whole bundle failed to evaluate. The read is
lazy now, on first ACCESS. Any new module in this tree owes the same check.

**THE LEGACY CALL SITE IS GUARDED, AND THE GUARD IS LOUD.** `client/index.html`
loads the bundle as a deferred module, so in a browser `window.CloudeWeb` is
always there by the time a screen renders. It is absent in every node harness,
and the mount call is the LAST statement in `loadProjects()` - so an unguarded
throw there rejects the promise every caller awaits and takes the whole home
screen down over a card. Measured: it did, and
`tests/test_project_list_render_guard.node.mjs` went from 11 passed to 9
failed. The call site tests for the bundle and `console.error`s when it is
missing, because a panel that silently never mounts is the same false green
this project keeps paying for. Any later slice's call site needs the same
shape.

## The launchpad's session data layer

Slice 3 of the launchpad migration. The four fetches, the attribution
join, the work-stamp index, the three-outcome listing latch and the 5s
poll left `client/js/launchpad.js` and now live in
`web/src/lib/sessions/`.

**THE LEGACY FIELDS ARE ACCESSORS, SO THERE IS EXACTLY ONE DATA PATH.**
`this.projects`, `this.runningSessions`, `this.sessionAttribution*`,
`this.sessionRecords`, `this._workStampByName`, `this.projectPresence`,
`this.projectAuthority`, `this.projectsListingOk`, `this._archivedFetchOk`
and `this.runningSessionsListing` are no longer instance fields: they are
properties on `Launchpad.prototype` that read and write `sessionStore`.
Roughly forty renderer lines still SAY `this.runningSessions` and every
one of them is now a store read, which is what stops a renderer painting a
stale array while the store holds a fresh one. **There is no fallback
object behind them, deliberately** - an accessor that quietly fell back to
a local field when the bundle was missing would be a second data owner
that works, looks right, and disagrees the moment either side is written
to. A missing bundle throws by name. In a browser it cannot happen;
a node harness evaluates the real `client/dist/app.js` in its sandbox
through `tests/helpers/cloude-web-sandbox.mjs`, which is strictly better
than a stub because those tests then exercise the shipped store.

**`loadRunningSessions` WAS PORTED LINE BY LINE AND NOT TIDIED.** Seven
fields are overwritten UNCONDITIONALLY and must never be `||`-defaulted:
`agent_family`, `agent_family_source`, `agent_wrapper_label`,
`startup_gate`, `status_source`, `label`, and the wrapper-level `status`.
Each is a three-outcome field whose null is a real answer meaning "the
server could not determine it", so a `||` keeps the previous tick's value
and a session whose wrapper was deleted mid-session goes on being named
after it. Note `!== undefined ? x : null` is NOT `|| null`: the first
preserves a server-sent null, zero, false or empty string as itself.
`web/src/lib/sessions/running.test.ts` is written so each of those goes
RED on a default. **KNOWN GAP, LEFT ALONE:** the merge's live-only
unshift branch never set `status_source`, so a session reaching the
launchpad ONLY through `/sessions/list` carries no status provenance. It
reads like a missing line and it may be one; it was pinned by a test
rather than fixed, because slice 3 is a MOVE and fixing a behaviour while
relocating it makes a regression impossible to bisect. It belongs to
slice 5, which owns that tooltip.

**BOTH JOIN RUNGS SURVIVE, AND WHICH ONE A ROW TAKES IS A PROPERTY OF THE
TWO ENDPOINTS DISAGREEING.** `sessionAttributionByInstance` keys on
`${tmux_name}\u0000${created_at_epoch}`; `sessionAttribution` is the
name-only fallback and never holds an archived row. `/sessions/attachable`
excludes live sessions and `SessionInfo` carries NO `created_at_epoch`, so
a live-only row is unshifted with `created_at_epoch: live.created_at_epoch
|| 0` and therefore ALWAYS takes the name-only rung. `ambiguous` and
`listingOk === false` are refusals that route to NEEDS ATTENTION and must
never render as "no project" - empty maps alone say the second thing, and
the latch is the only thing that makes them say the first.

**THE POLL FINALLY HAS A TEARDOWN.** `_startRunningSessionsPoller` called
`setInterval` and the word `clearInterval` appeared NOWHERE in
`launchpad.js`; the handle was stored purely as an idempotence flag.
`web/src/lib/sessions/poller.ts` owns the interval and `stopPolling()`
clears it. The two gates are unchanged - signed in, and
`ProjectListRenderGuard.shouldPoll(document)` - and A SKIP IS NOT A STOP:
the interval keeps running while the launchpad is not the screen on
display, so returning to it resumes with nothing to restart. Measured in
a real browser under the production CSP: 3 ticks in a 11.5s window with
home up, ZERO with `#launchpad-screen` off `.active`, 3 again on return
with nothing restarting it, and zero after `stopPolling()`.

**`window` IS NOT `globalThis`, AND THAT COST A DEBUGGING ROUND.** The
methods that moved read `window.Auth`, `window.UIFlags` and
`window.ProjectListRenderGuard`. Those are the same object in a browser
and are NOT in a node `vm` sandbox, where the harness builds a plain
object and hangs it on the context. A first draft reached for
`globalThis`, the poller's auth gate answered false, and the tick silently
never ran - it surfaced in `tests/test_project_list_render_guard.node.mjs`
looking exactly like a repaint bug. A BARE `window` reference also THROWS
where a property read would not, because vitest runs this tree in the
`node` environment on purpose. `web/src/lib/sessions/env.ts` is the one
place both are handled; anything new in this tree reads through it.

## The running sessions list

Slice 5 of the launchpad migration. The home screen's flat list of live
sessions left `client/js/launchpad.js` and is
`web/src/lib/launchpad/RunningSessions.svelte`, which READS the store
rather than being told to paint.

**IT REPLACED A REPAINT WITH A SUBSCRIPTION, AND THE THING IT DELETED IS
WORTH NAMING.** `renderRunningSessions()` built a JSON signature of every
row, compared it to `_lastRunningSig`, and on a difference wrote
`#running-sessions-list.innerHTML` and rebound one delegated listener.
Three things that shape could not do, all structural:

1. A CHANGED TICK WAS NEVER CHEAP. One flipped status dot rebuilt every
   row on screen.
2. IT BOUGHT CORRECTNESS WITH STALENESS. `session-list-busy-guard.js`
   SKIPPED the paint entirely while an inline rename input was open or a
   row menu was up, because an `innerHTML` write under either destroys
   what the user is doing. So a status change landing during one was
   simply not shown. **That file is deleted rather than consumed**: a
   component's rows are not rebuilt, so there is nothing to guard.
3. A FIELD LEFT OUT OF THE SIGNATURE STAYED STALE FOREVER.
   `agent_wrapper_label` and `startup_gate` were each ADDED to that
   signature after shipping, each because the value changes with nothing
   else on the row changing at all. A subscription cannot have that bug:
   the template reads the field, so the field is the dependency.

**MEASURED IN BRAVE UNDER THE PRODUCTION CSP, 2026-09-10**, over a
9-project, 45-row screen driven through the real `loadRunningSessions`
(`tests/manual/running-sessions-mutation-harness.html`, served by
`scripts/lib_csp_static_server.py`'s handler on 127.0.0.1:5057): twelve
idle ticks cost **0 mutation records and 0 nodes**; twelve ticks
containing ONE status change cost **5 records, every one an attribute,
and 0 nodes**; twelve ticks on a FAILING probe also cost 0 and 0. The
negative control is what makes those numbers mean anything - one
legacy-style `innerHTML` rewrite of the same rows scores **1 record and
2,439 nodes**, and twelve of them 29,256. The tab reported
`visibilityState: hidden` throughout (`hasFocus()` true, so an occluded
window rather than a backgrounded tab); a microtask-only control that
uses no timer at all returned the identical counts, so the throttle is
not in the numbers.

**AND THE BUSY CASE IS THE ONE THE GUARD COULD NOT DO.** With a rename
editor open and half-typed text in it, a tick carrying a status change
cost 10 attribute records and 0 nodes, the editor kept its node AND its
text, and the dot updated. With `SessionRowMenuOpen.isOpen()` forced true
- the guard's other trigger, which was GLOBAL, so a menu open on the
sidebar froze the home list too - the dot still updated, because nothing
consults that predicate any more.

**THE LISTING VERDICT IS PUBLISHED ONCE PER TICK, AND THAT IS SLICE 4's
DEFECT ONE FIELD OVER.** `e5662d8` fixed the ROW SET: it was assigned in
fetch order, then again sorted after an await, and a keyed list moved all
45 rows and moved them back. `loadRunningSessions` was still opening with
`runningSessionsListing = emptyListing()` and assigning the real verdict
after the same await. The assignment after it is unconditional, so the
reset changed nothing about the ANSWER and everything about how many
times it was published: on a screen whose probe is failing, every tick
removed the NEEDS ATTENTION block and put it back and flipped the heading
between a number and "could not be determined". This list is the ONLY
surface that renders that verdict, so nothing else could have caught it.
`web/src/lib/launchpad/running-tick-mutations.test.ts` holds both halves,
as a source-shape assertion AND as a measured count.

**NOTHING RENDERS HTML FROM A STRING, AND FIVE MODULES HAD TO BE SPLIT TO
KEEP IT THAT WAY.** `SessionRowActions.html`, `SessionStatusUI
.markUnreadHtml`, `SessionStartupGate.indicatorHtml`,
`SessionThemeTint.attrs`/`swatchHtml` and `LaunchpadWrapperPill.html` all
return markup, and there is no `{@html}` anywhere in this migration. Four
of the five are SHARED with the sidebar row and therefore stay; the card
consumes their DATA halves (`actionsFor`, `labelFor`, `isAwaiting`,
`colorsFor`) and renders its own elements.
`web/src/lib/launchpad/running-copy.parity.test.ts` loads each real module
in a `vm` sandbox and holds its words against the catalog's, with a
negative control per comparison, so two carriers cannot become two
answers. `LaunchpadWrapperPill` had exactly one caller and moved.

**THE FIVE REMAINING ICONS BECAME DATA.** `client/js/icons/glyphs.js` held
`pencil` and `archive` for exactly this reason; `close`, `trash`,
`restart` and the two envelopes joined them, and the five builders in
`session-status-ui.js` are one-line delegates to `glyphSvg` now. ONE set
of coordinates, two renderers - the alternative is the same button drawn
two different shapes on two screens. The emitted strings are
byte-identical to the ones they replaced, which is asserted rather than
assumed. **Any `vm` sandbox that loads `session-status-ui.js` must inject
`CloudeGlyphs`** the way `client/js/i18n/boot.js` publishes it, or every
icon answers the empty string; `tests/helpers/cloude-web-sandbox.mjs`
does it for every harness that uses it.

**MARK UNREAD ARRIVES THROUGH THE PLUGIN BRIDGE NOW, AND THE SECOND COPY
IS GONE.** `launchpad.js` drew its own inline envelope control through
`markUnreadHtml` with its own `_handleMarkUnread`, which is what the
plugin's own docblock called out as the remaining dual path. The card
renders `window.CloudeWeb.sessionCardMenuItems(row, ctx)` and activates
through `runSessionCardAction`, so `ui.show_mark_unread_control` is read
once, by the contribution's `enabled`, for both surfaces. An EMPTY list
is what the flag being off looks like and stays silent; an absent
FUNCTION is a bundle that failed to load and is loud. The contribution's
two labels moved into the catalog with the rest of this surface and
`session-card-actions.test.ts` still holds them against the real
`markUnreadHtml`.

**`markUnreadHtml` NOW HAS NO CALLER AND IS KEPT ON PURPOSE.** It is the
anchor the two parity tests compare against, so deleting it would delete
the only independent record of what those words are. It is not dead
weight; it is the control.

**THE HOST IS THE SEAM, AND A MUTATION PROVED IT NEEDED ITS OWN TEST.**
`web/src/lib/launchpad/running-host.ts` is the one place this surface
reaches `window`. Dropping restart from a live row INSIDE it failed
nothing: the component tests drive a recording host, and the parity test
drives the legacy module directly, so neither crossed the seam between
them. `running-host.test.ts` hangs the REAL legacy modules on the real
`window` under jsdom and asserts the host answers exactly what the module
answers, id for id and in order. **A pass-through is where a
pass-through stops passing things through, and it needs a test of its
own.**

**THE RENAME PENCIL LOST A RUNG THAT COULD NEVER FIRE.** The legacy chain
was `session_id || tmux_session || name`, and the middle rung has never
had a value on this surface: every row the merge produces comes from an
`AttachableSession`, which carries `name` and no `tmux_session`. A rung
that has never been observed to fire is unmeasured, not proven; this one
is provably unreachable and was dropped rather than carried forward
looking like a fallback somebody relies on. The three STATES are
unchanged and are asserted as behaviour.

**THE SESSION-LABEL RULE NOW HAS A TYPED CALLER IN THIS TREE.**
`web/src/lib/sessions/session-label.ts` delegates to
`client/js/session-label.js`, the shared module the sidebar row, the tab
title, the in-page header and the toast cards all read, and
`project-tree-host.ts` was repointed at it - it used to call
`Launchpad._sessionDisplayLabel`, which this slice deleted.

## The plugin surface registry

A typed, BUILD-TIME registry of the four places a feature may extend a
screen, plus the one real feature that now arrives through it. It lives in
`web/src/lib/plugins/` and is compiled into `client/dist/app.js` with
everything else in that tree.

| Piece | Where |
|---|---|
| The four surfaces and every payload type | `web/src/lib/plugins/types.ts` |
| Register, and ask a surface what it holds | `web/src/lib/plugins/registry.ts` |
| The `session-card-action` adapter: describe them, run one | `web/src/lib/plugins/session-card-actions.ts` |
| The ship list, the whole "loader" | `web/src/lib/plugins/builtin.ts` |
| The worked example | `web/src/lib/plugins/mark-unread/index.ts` |
| THE ONE BRIDGE, both directions | `client/js/session-row-menu-plugins.js` |
| The legacy consumer | `client/js/session-row-menu{,-items,-actions}.js` |

**FOUR SURFACES, AND THE LIST IS CLOSED UNTIL A CONSUMER ARGUES OTHERWISE:**
`session-card-action`, `launchpad-panel`, `sidebar-item`, `status-source`.
They are the four `.claude/notes/svelte-migration-launchpad.md` section 6
named. ONLY THE FIRST IS PROVEN - it has a real consumer and a real
contribution. The other three carry the smallest payload their eventual
consumer plainly needs and are documented in `types.ts` as unsettled, so the
first real consumer is expected to change the type rather than work around
it. A surface with no reader is a guess about a screen nobody has written.

**PLUGINS ARE BUILD-TIME MODULES, AND THE REASON IS THE CSP.** A plugin is a
TypeScript module in this tree, added to the `BUILTIN` array in `builtin.ts`
and compiled in. There is NO loader, no manifest schema, no permissions
model, no marketplace, no settings page and no dynamic `import()` of a
runtime-assembled path, because `script-src 'self'` forbids remote script,
inline script and `eval` - "fetch a plugin and run it" has no implementation
in this browser tab, only a CSP relaxation pretending to be one. The owner's
framing, verbatim: "lean and mean. kiss." If a runtime rung is ever wanted,
the precedent to copy is the theme `effects.js` flow in
`client/js/themes/registry.js`: same-origin, flat non-traversable filename,
explicit consent remembered per id. Never a remote URL, never `eval`.

**THEMES ARE A SEPARATE, OLDER, WORKING SYSTEM AND ARE NOT THIS.** 26 bundled
manifests at `client/css/themes/<id>/theme.json` plus a user themes
directory, scanned server-side by `GET /themes`, already carry `cssVars`, an
optional whole `themeCss`, an `xterm` palette and the consent-gated
`effects.js`. Themes were already expandable and are NOT being rebuilt.
Nothing on this registry duplicates, replaces or wraps them: a contribution
that wants to recolor something belongs in a theme manifest.

**ORDER IS DECLARED AND TOTAL, NEVER INSERTION LUCK.** `surfacesOf(kind)`
sorts on each contribution's `order` (absent reads as 0) and then on its
`id`, and hands back a sorted COPY, so a read cannot mutate the registry and
two builds that import the plugins in a different sequence paint the same
list. A DUPLICATE ID IS REFUSED AND LOGGED rather than overwriting: silent
last-write-wins would let a new plugin replace a shipped control with
something that merely shares its name, and the symptom would be a control
that "stopped working" with nothing in the log. The refusal is ALL OR
NOTHING, so a partially registered plugin is never a state to handle. No
mutable singleton is exported - `createRegistry()` builds an independent one
(which is how the tests get isolation with no test-only `reset()`), and
`register` / `surfacesOf` are functions over one private instance.

**`enabled(context)` IS WHAT MAKES A SHIPPED CONTRIBUTION SWITCHABLE WITHOUT
UNREGISTERING IT**, and it reads flags as `!== false`. That is
`client/js/ui-flags.js`'s own rule carried through unchanged: a probe that
could not run, an older server or an unparseable config all leave a control
where the user last saw it, because turning "I could not tell" into "hide it"
is how a capability disappears with nobody deciding to remove it. It is
checked TWICE - at render and again in `runSessionCardAction` - since a menu
can sit open across a poll or a flag change, and checking only at paint time
would make the flag a suggestion.

**THE WORKED EXAMPLE IS MARK UNREAD, AND IT IS A RE-SEAT, NOT A REDESIGN.**
The control shipped in 1.2 behind `ui.show_mark_unread_control`
(`src/config.py::UIConfig`, served on `GET /api/v1/features`). 1.2.1 then
rewrote the row menu into a DECLARATIVE TABLE and mark unread was one of the
eight items in it: an entry in `session-row-menu-items.js`, an availability
probe in `session-row-menu.js::contextFromRow` asking whether
`SessionStatusUI.markUnreadHtml` returned empty, and a
`session-row-menu-actions.js::runMarkUnread` that fabricated a detached
element for `SessionSidebarClicks.onMarkUnreadClick`. All four are DELETED,
along with `onMarkUnreadClick` itself and the two list-scoped bindings that
had been unreachable since the control folded into the menu. THERE IS NO
DUAL PATH, and that is mutation proven: emptying the `BUILTIN` ship list
removes the item from the live menu entirely and fails five node cases and
nine vitest cases by name, rather than falling back to anything.

**A CONTRIBUTION SUPPLIES A MENU ITEM, NOT MARKUP, AND THAT IS THE 1.2.1
SHAPE RATHER THAN THE ONE THIS SURFACE WAS BORN WITH.** It was first written
against a menu that CONCATENATED raw HTML from whichever module owned each
control, so `SessionCardAction` carried `icon`, `className` and `attrs` and
the adapter emitted a `<span role="button">`. 1.2.1's menu renders every item
itself as the same `<button role="menuitem">` with a label and a shortcut
letter, so a contribution that still emitted its own span would paint a
control unlike its seven neighbours, absent from the arrow-key focus ring and
invisible to `itemIdForKey`. Those three fields were deleted rather than left
unread; a contribution now supplies `shortcut`, `label(row)` and `run`, plus
the `order` it already had. `client/js/session-row-menu-plugins.js` is the
ONE bridge - `menuItems(row)` to describe, `run(id, ctx)` to activate - and
`session-row-menu.js::itemsFor` is the ONE place the two lists meet, merging
on `(order, id)`. The native table numbers itself 100, 300, 400, 500, 600,
700, 800; mark unread takes 200, which is the second slot the owner's
2026-09-10 superset ruling put it in. THE RULING DID NOT CHANGE - the eight
items, their order, the separator above restart and close, and the flag gate
are all still asserted by `tests/test_session_row_menu_superset.node.mjs`,
whose own docblock anticipated this port: "a port that satisfies these is
correct whatever it renders".

**WHICH OPTIONAL ITEMS A ROW OFFERS IS STILL CAPTURED AT PAINT TIME.** The
trigger's `data-row-menu-mark-unread` became `data-row-menu-plugin-items`, a
comma-joined id list: the same fact - which optional items this row offers -
recorded for ALL of them rather than for one by name. 1.2.1's frozen-snapshot
rule is unchanged, and the round-trip case that proves it now reads
`pluginItems` in place of `markUnreadAvailable`.

**THE WORDS ARE THE SHIPPED WORDS, PROVEN RATHER THAN REMEMBERED.**
`web/src/lib/plugins/session-card-actions.test.ts` loads the REAL
`client/js/session-status-ui.js` in a `vm` sandbox and compares
`markUnreadHtml`'s `title` and `aria-label` against the contribution's
`label`, in both unread states. It used to compare MARKUP attribute by
attribute, which stopped meaning anything the moment a contribution supplied
none; what survived is the part a user can see, and it still matters because
the sidebar row DRAWS ITS OWN INLINE COPY through `markUnreadHtml` (that
screen is not migrated; the home screen stopped having a second copy when
slice 7 deleted `client/js/launchpad.js`) and two surfaces describing one
action in different words would read as two features. The negative controls are kept: the
comparison is proven able to fail, and the parser still refuses markup it
cannot read.

**THE NODE SUITE RUNS THE REAL BUNDLE, NOT A FIXTURE.**
`tests/test_session_sidebar_rows.node.mjs` and
`tests/test_session_row_menu_superset.node.mjs` load `client/dist/app.js`
into their `vm` sandboxes alongside the legacy modules - the emitted file carries no
`import` or `export` statement, so it runs there and publishes the real
`window.CloudeWeb`. So the assertions about the menu are about the shipped
path. The guard in the bridge is LOUD, AND IT GUARDS THE FUNCTION RATHER
THAN THE RESULT: a missing bundle `console.error`s and drops the
contributions, while an EMPTY list stays silent because that is exactly what
`ui.show_mark_unread_control: false` looks like. Confusing the two is how a
panel silently loses a shipped control, which is the false green this project
keeps paying for.

Measured in a real browser under the production CSP (a static server
importing `src.security_headers`), 2026-09-10: flag on, the item renders from
the plugin path, is decorated by the menu into a `role="menuitem"`, is
visible, and a click calls `setSessionUnread` with the OPPOSITE of the
painted state and repaints once; flag off, it is absent and the menu's other
three items are untouched. One CSP violation in the whole run, and it is the
deliberate off-origin image placed as the negative control.

NOTE THAT MEASUREMENT PREDATES THE 1.2.1 REBASE and was taken against the
concatenated-HTML shape described above. The behaviour it records is
unchanged and is covered by the node and vitest suites, but THE BROWSER RUN
HAS NOT BEEN REPEATED against the declarative menu. Repeat it before quoting
it as current.

## Architecture, the parts that shape everything else

**tmux is the live backend. `PTYBackend` is legacy.** The `SessionBackend` ABC is
at `src/core/session_backend.py:32` and has two implementations, each in its own
file: `TmuxBackend` (`src/core/tmux_backend.py:163`) is the one that runs, and
`PTYBackend` (`src/utils/pty_session.py:293`) is the legacy path. Only the ABC
lives in `session_backend.py`; do not go looking for the subclasses there. Write
against tmux; do not build new behavior on the PTY path.

**Sessions live on a dedicated tmux socket, `tmux -L cloude`.** That socket is
separate from the user's own tmux server, which is why our sessions survive a
server restart and why we can never accidentally kill a user session. Sessions we
create are named `cloude_*`. Constants: `DEFAULT_SOCKET_NAME` (`src/core/tmux_backend.py:84`) and
`SESSION_PREFIX` (`:87`). Address sessions by socket + name, never by prefix
guessing.

**Created vs adopted is a real distinction, not a detail.** Cloude Code can
attach to a tmux session it did not create. A TRULY external one - no row for
its instance triple - gets an id of `adopted:<tmux-name>` and is absent from
the owned tmux name set. Anything that parses, matches, displays or routes on a
session id has to handle both shapes. Strip the prefix to recover the tmux name;
do not assume the id is a clean display string.

**THAT SET LIVES ON `OwnedTmuxLedger`, NOT ON THE MANAGER, AND SO DOES THE FILE
THAT REMEMBERS IT.** `src/core/sessions/owned_tmux_ledger.py` owns the set (as
`.names`), the pre-v3 backfill sentinel, the boot listing,
`session_metadata.json` and the two datastore-backed ownership queries
(`is_owned_name`, `instances`). `SessionManager` holds one as `self._owned` and
keeps no copy and no forwarder; `build_services` hands the same object to
`AppServices.owned_tmux`, so a route reaches it there rather than through the
manager. `owned_tmux_sessions` is still the ON-DISK key in that file and must
stay spelled that way, because a v3 file written by an older build uses it.

Two halves of that file are unrelated and must not be confused: the owned set is
about EVERY session this app created, and the session pointer is about the one
most-recently-active. `drop_session_pointer` unlinks the pointer and re-writes
the set, because unlinking the file outright threw away N sessions' ownership
record to clean up one, on the ORDINARY path - after which every
launcher-created session resolved EXTERNAL. The write is tmp plus `fsync` plus
`os.replace` and `tests/test_owned_tmux_ledger.py` measures the protocol rather
than the resulting file, because a plain in-place write produces identical
contents and no atomicity.

**AN ADOPTION RESOLVES THE ID, IT DOES NOT MINT ONE, and the difference is the
hook path.** `adopt_external_session` opened with the literal
`adopted_id = f"adopted:{name}"` until 2026-09-08. That is wrong for a session
the app already has a row for. `get_env_for_spawn` puts `CLOUDECODE_SESSION_ID`
into the pane at `new-session` time, so the agent inside presents its
create-time id on every hook POST for life, with a token bound to THAT id;
registering the same live pane under an invented id makes `validate_hook_token`
answer False and `routes.py` return **403 - not 410**, so grepping for the
stale-session code finds nothing and the hook path looks healthy. Measured:
94 refusals in four minutes for one session. `src/core/session_adopt_identity.py`
now resolves the id through the boot re-adopt's OWN ladder
(`session_boot_readopt_plan.resolve_session_id`, imported rather than rebuilt,
so the two paths cannot name one pane two things), keyed on the instance triple
via `session_store.get_instance`.

Note it is NOT "a row exists, so reuse its id": `persist_adoption` records the
sighting BEFORE the id is resolved, so a row exists for every adoption by then.
The derived rung is reached because a fresh `observed` row carries no
`legacy_session_id` and no hook-token mapping.

**ONE PANE IS ONE REGISTRATION, so the adopt teardown keys on the tmux NAME.**
While the id was always `adopted:<name>`, "the registration for this id" and
"the registration for this pane" were the same question. Resolving the id made
them different, and keying the teardown on the id alone leaves the other one
behind. Measured on live minutes after the re-key shipped: the rehydrated
`session_metadata.json` entry held `cloude_Agent_-_Cloude_Code` as
`adopted:cloude_Agent_-_Cloude_Code`, the browser's adopt correctly re-keyed to
`ses_fb8dd410`, and `GET /sessions/list` returned **22 rows for 21 live tmux
sessions** - one pane, two backends, two tailers on one FIFO.
`SessionRegistry.registered_ids_for_tmux_name` is what enforces the rule; it
lives on the registry rather than the manager because it has to run against
the very `backends` dict the registration path writes, and a second dict
holding a copy answers every equality assertion while missing the second
registration. Note this was caught
only because the deploy was verified against `/sessions/list` rather than
against the `boot_readopt_complete` log line, which was perfect.

**AND A RECOVERED ID MUST NOT BE RE-MINTED A TOKEN.** `_mint_hook_token`
REPLACES the token it holds for an id. Called on a re-keyed id it revokes the
credential the running agent is holding and cannot be handed a replacement for,
so the 403 storm returns wearing the correct session id and every log line looks
right. A re-keyed adoption calls `_keep_hook_token` instead, which re-binds the
tmux name and leaves the secret alone; a derived id still mints exactly as
before.

**AND WHEN A MINT DOES LAND ON A RUNNING AGENT, IT IS NOW RECOVERABLE
ONCE.** The rule above is the prevention; this is the net under it,
because the failure is invisible from inside the pane and cost 4h24m of
dead hooks on 2026-09-08. Traced to the millisecond: a derived-id adopt
minted at 16:16:40.633984Z, the first `hook_post_rejected_invalid_token`
for that id landed 130 ms later at 16:16:40.763005Z, and 4,325 followed
until the owner restarted the pane by hand at 20:40:23Z. The same id was
being ACCEPTED minutes before (`toast_recorded` 16:11:28Z), so it was a
rotation, not a misconfiguration. `src/core/hook_token_recovery.py` keeps
a bounded IN-MEMORY ring of tokens this process minted and then replaced;
on a rejection, `SessionManager.recover_hook_token` accepts a value ONLY
if this server minted it for THAT id on THAT pane and superseded it, then
re-binds the store to what the running process holds, logs
`hook_token_rebound_from_superseded` once, and NEVER MINTS - minting is
the defect, and a recovery that minted would revoke the credential again
while every log line read correctly. `RECOVERY_NO_MATCH` (searched, not
found) is kept apart from `RECOVERY_UNAVAILABLE` (nothing to search, or
the pane binding is unknown); both refuse, but only the first says
anything about the token. THE NEGATIVE CONTROL IS THE LOAD-BEARING TEST:
a recovery that accepted broadly would pass the positive test perfectly
and be a credential bypass. In memory only is deliberate - a mint plus a
restart is not recoverable this way, and the restart already has its own
answer.

**AND A RESTART IS THE ONE MOMENT A LIVE PANE'S ENV CAN BE CORRECTED.**
tmux copies the SESSION environment into a pane's process at spawn, so
`CLOUDECODE_SESSION_ID` and `CLOUDECODE_HOOK_TOKEN` cannot be pushed into
a process already running - which is why a hand restart was what ended
the storm above. `TmuxBackend.respawn` takes `spawn_env` and issues
`set-environment` BEFORE `respawn-pane`, and the boot re-adopt does the
same for the next process in each pane. Ordering is the whole claim, so
`tests/test_respawn_refreshes_pane_env.py` proves it against REAL tmux by
having the respawned process write its own inherited value: a mock
asserting two calls happened in order would only be testing its own
arrangement.

**THE ENVIRONMENT WRITES TRAVEL TOGETHER NOW, AND THEY STILL NEVER
TRAVEL WITH THE SPAWN.** `respawn` issued one tmux process per variable;
`src/core/tmux_command_batch.py` sends them as one `;`-separated command
list, measured p50 20.99 ms to 9.38 ms for the two we inject. The batch is
still a SEPARATE, AWAITED call ahead of `respawn-pane`, which is the
distinction that matters: putting the spawn INSIDE the list would make
this ordering a property of tmux's command queue rather than of two
ordered awaits, and would swallow the spawn's own return code. Proved by
`tests/test_tmux_launch_batching_real_tmux.py`, which has the respawned
process write its own inherited value, and whose negative control was run
before it shipped - with the writes moved BEHIND the spawn the pane does
not come back empty, it comes back holding the tmux server's STALE
global values, which is the 403 storm above wearing a plausible face.

**THE LAUNCH IS SIX TMUX PROCESSES, DOWN FROM FOURTEEN, AND THE RULE FOR
WHAT MAY SHARE ONE IS COMPATIBLE FAILURE BEHAVIOUR.** Counted by tracing a
real `TmuxBackend.start()`, not estimated. Two batches: the pre-spawn
`history-limit` plus `remain-on-exit`, and the post-probe decorations
(extended keys, mouse, the two wheel bindings, terminal-features,
escape-time, `window-size manual`, aggressive-resize), which now carry
that same pre-spawn pair re-applied at their head and therefore number
ten rather than eight - see the cold-socket paragraph below. Every
command in both was already `check=False`. The three whose outcome
the caller ACTS on - `new-session`, `respawn-pane`, `pipe-pane` - stay in
processes of their own, because tmux gives no per-command control over a
list and a batch that reported only "the batch failed" would be a
downgrade. `attach_existing`'s four adopt-time options batch the same way,
behind `ensure_pipe_pane` rather than in front of it. Measured on tmux
3.6a at load average 14: the eight decorations cost **p50 206.41 ms apart
and p50 9.35 ms together**.

**TMUX ABORTS A COMMAND LIST AT ITS FIRST ERROR, WHICH IS WHY THE RUNNER
FALLS BACK.** Measured, not assumed: a list whose first command is invalid
exits 1 and the second never runs. So a naive batch turns "one option this
socket will not take" into "and every option after it was silently
skipped", which is strictly WORSE than the per-command loop it replaces.
`run_optional_batch` re-runs the commands individually on any non-zero
exit - every one of them is idempotent, so that restores exactly the
pre-batch behaviour, and it is also the only thing that can name WHICH
command failed, since tmux's stderr carries the error text but not its
position in the list. It costs nothing in steady state. A token that IS
`;` or ENDS in one is REFUSED rather than batched, because it would split
the list somewhere the caller did not intend; a semicolon in the MIDDLE
of a token is fine, which the wheel bindings depend on.

**AND `set-option` DOES NOT START A TMUX SERVER ON tmux 3.6a, WHICH THE
COMMENT IN `start()` USED TO CLAIM.** Measured on a cold throwaway
socket: both pre-spawn `set-option` calls exit 1 with "error connecting",
batched or separate, and after `new-session` the socket reports
`history-limit 2000` (tmux's default, not our 50000) and
`remain-on-exit off`. It was silent because both calls pass `check=False`,
and it reaches the FIRST session created after a reboot, after a tmux
server restart, or any time the socket's last session closes and the
server exits under `exit-empty`. The pre-spawn pair still runs and still
must: it is the ONLY thing that can make a pane be BORN at
`HISTORY_LIMIT`, and on a warm socket - every session after the first - it
lands.

**THE TWO OPTIONS ARE RE-APPLIED AT THE HEAD OF THE POST-PROBE DECORATION
BATCH, WHICH FIXES THE SOCKET AND CANNOT FIX THE FIRST PANE.** Measured
through a real `TmuxBackend.start()` on a cold socket, before and after:
the socket's global `history-limit` **2000 to 50000** and its global
`remain-on-exit` **off to on**. It costs no extra tmux process, because
that batch is issued either way, and both commands are pure assignments of
a constant, so they are idempotent and safe under the runner's
individual-rerun fallback.

**THE RE-APPLICATION CANNOT REACH THE FIRST PANE, BECAUSE A PANE'S DEPTH
IS FIXED INTO ITS GRID AT CREATION.** Measured three ways on tmux 3.6a, a
pane born under the stock limit still reports `#{history_limit} 2000`
after a global `set-option`, after a session-scoped one, and after
`respawn-pane -k`. So the re-application fixes the socket for every LATER
session and cannot hand the first one its 48000 missing lines.
`tests/test_cold_socket_options_real_tmux.py` pins that as a measured
fact. What the first session always DID keep is its corpse: the
belt-and-braces `set-option -t <session> remain-on-exit on` after
`new-session` resolves to that session's WINDOW, so the dead-on-arrival
probe always had a pane to read - the GLOBAL window table was the half
that was wrong.

**SO THE FIRST PANE IS NOW BORN AT THE FULL DEPTH, FROM A `-f` CONFIG THE
SERVER READS BEFORE IT MAKES THE PANE.** tmux reads a `-f` file when it
STARTS THE SERVER, which on a cold socket happens inside the
`new-session` invocation itself and strictly before the session is
created. That is the only window there is. Measured through a real
`TmuxBackend.start()` on a cold socket, the first pane's own
`#{history_limit}` goes **2000 to 50000**.
`src/core/tmux_server_config.py` renders and atomically writes it,
`TmuxBackend._server_config_argv` places it, and
`tests/test_cold_socket_born_at_depth_real_tmux.py` measures the PANE
rather than the option table, because #87 already proved those two can
disagree.

**IT COSTS ZERO EXTRA TMUX PROCESSES, WHICH IS THE WHOLE REASON IT WON.**
`-f` is two more argv elements on a call that was being made anyway.
Counted at base and at head: a COLD launch spends **8 at both**, a warm
one **6 at both**. Cold is two above the six quoted higher up because the
pre-spawn batch cannot reach a server that is not running, so
`run_optional_batch` re-runs its two commands individually - #87's
fallback, not this. The spawn is still its own invocation and still
carries its own return code; nothing is batched into it, and the env
injection ordering is untouched.

**EVERY FAILURE PATH DEGRADES TO THE PRE-FIX LAUNCH, AND tmux's OWN
BEHAVIOUR WAS MEASURED RATHER THAN ASSUMED.** A missing `-f` file, an
unreadable one (mode 000) and a MALFORMED one all give `rc=0` and a
working session; on a warm socket `-f` is ignored outright. The malformed
case is the one to know: tmux DISCARDS THE WHOLE CONFIG SILENTLY, so a
valid line placed before the bad one does not apply either and nothing is
printed. That is why `render_config` refuses a token it cannot express
instead of quoting it hopefully, and why the test measures the pane
afterwards. If the file cannot be written at all, `_server_config_argv`
returns `[]` and the launch is byte-identical to what it was: losing
scrollback depth is survivable, refusing a session is not.

**THE FILE IS RE-DERIVED ON EVERY LAUNCH, SO A STALE ONE IS IMPOSSIBLE.**
It lives at `<state_dir>/cloude-tmux.conf` and its body is rendered from
the same argv fragments the pre-spawn and post-spawn batches send, so all
three places that state these two options read one definition. Nothing
migrates it on upgrade and nothing cleans it up; the next launch
overwrites it with what the running build believes.

**AND `-f` REPLACES tmux's OWN DEFAULT CONFIG LOAD, WHICH IS DESIRED AND
IS ALSO A REAL CHANGE.** Per tmux(1), given a config on the command line
tmux does not read `/etc/tmux.conf` or `~/.tmux.conf`. This file already
states the intent - CloudeCode carries its own explicit tmux settings and
deliberately does not source a personal config, because one references
plugins that do not exist on another machine - so until now a COLD
CloudeCode socket was quietly doing the opposite. Measured on the
developer's box: none of the three default paths exists, so nothing there
was being inherited and nothing is lost. On a box that HAS one, that
config stops reaching our socket.

**THE REJECTED ALTERNATIVE, KEPT SO IT IS NOT RE-PROPOSED.**
`start-server` ALONE does not work - the batch exits 0 and the server,
having no sessions, is gone before the next tmux process connects. Adding
`set-option -s exit-empty off` to that list DOES work, measured, and
leaves a tmux server with zero sessions alive on our socket for the life
of the box. Adam rejected that on 2026-09-10 for exactly that reason.

**BOOT HOLDS EVERY SURVIVING SESSION, not just the last one.** It used to
rehydrate the ONE session in `session_metadata.json`; measured 2026-09-08, 21 live
sessions and zero held. `src/core/session_boot_readopt{,_plan}.py` now re-adopts
every instance whose row says `origin` is `created` or `adopted`, keyed on the
triple. The ID IS RECOVERED, NOT MINTED: the hook-token store's `tmux_names` map is
the only durable record of the `CLOUDECODE_SESSION_ID` injected into the pane, so
reversing it is what stops the hook route answering 410. A name with no row stays
adoptable, an unreadable table yields `cannot_determine` and holds nothing, and the
pass is SCHEDULED, never awaited - uvicorn binds at the lifespan `yield`, so an
awaited pass is dead port (measured: 1.2 ms to bind, versus 49 ms awaited and 945 ms
serial). It takes its own listing because `discover_existing` carries no epoch.
A session the legacy metadata-driven reconcile registers first (PT-IMC, measured
2026-09-08) is skipped here as `SKIP_ALREADY_HELD` by NAME before an epoch is ever
resolved for it; `_record_epoch_for_already_registered` fills `_instance_epochs`
from this pass's own listing anyway, because that gap is what left the status seed
ladder unable to identify the instance for the life of the process.

**EVERY SESSION BELONGS TO A PROJECT, AND THE ROW IS WHERE THAT LIVES.**
The owner's rule, verbatim: "all sessions belong to projects, the root folder
... its impossible to not have a project." Nothing in memory carries it - the
`Session` model (`src/models/sessions.py:45`) has no project field and `SessionInfo`
ships none, so `/sessions/list` cannot lose a project and cannot restore one.
The launchpad tree reads `project_id` / `project_attribution` off
`GET /sessions/records`, joined to the live session by tmux name plus epoch in
`buildProjectSessionGroups` (`web/src/lib/launchpad/project-groups.ts`, moved
there by slice 4 from `client/js/launchpad.js:3878`), and it tests
`attribution === 'none'` BEFORE it looks at `project_id`. So a row carrying
both an id and `none` renders under "no project" while holding a perfectly good
one, which is what the owner saw. The invariant is enforced in
`src/core/session_project_binding.py` and nowhere else: `resolve_project_binding`
is the ladder (as-written match, then the same path canonicalised, then a minted
project, then `none` for a scratch dir, then `unknown`), and `columns_to_write`
is the rule that **THE PAIR MOVES TOGETHER OR NEITHER MOVES**. It is called from
`persist_adoption` (`session_adopt_persist.py`, `allow_create=False` - re-entering
a session is not a moment to invent a project) and from `persist_creation`
(`session_create_persist.py`, `allow_create=True`), while `create_project`
(`project_writes.py`) adopts the project-less live rows already under its new
root, which is punchlist 16 closed from both directions.

Two things caused this and both are worth keeping. First, a HALF-WRITE:
`claim_instance` applies each column "only when not None", so a derived
`(None, 'none')` skipped the id and wrote the attribution ALONE - the row kept
its project and acquired a value contradicting it. "Only when not None" reads
as conservative and is not, when the columns are a pair. Second, a SPELLING the
lexical matcher cannot cross: `project_attribution.attribute` refuses to resolve
symlinks, correctly, so a session probed at `/Users/jsugamele/Development/...`
could never match a project declared at the iCloud path that same directory
resolves to. Canonicalising is a FALLBACK RUNG, tried only after the as-written
match fails, so a project declared at a symlink still collects the sessions
declared there. Measured 2026-09-08: rows 7 and 8 held projects 1 and 2 beside
`none`, row 45 held NULL from the create race, and 3 of 22 running sessions
rendered project-less.

**IT HELD ZERO ON ITS FIRST REAL BOOT, and the cause is worth keeping.** The
pass builds an OWNED backend (`build_backend`, not `TmuxBackend.for_external`)
and calls `attach_existing(needs_pipe_setup=True)`. That reached
`ensure_pipe_pane`, whose guard was `not self._running and not self._is_external`
- and `_running` is not set until the BOTTOM of `attach_existing`. So both halves
were true for every owned session: 20 failures, all `"backend not running"`, all
inside one millisecond, before a single tmux command was issued.

**A guard whose only exercised caller sets the flag it checks has never been
tested.** Until the boot re-adopt, the sole caller reaching that branch was the
external adopt path, where `for_external` sets `_is_external=True` and the guard
CANNOT fail. 4874 green tests had never observed it raise, because
`tests/test_boot_readopt.py` is hermetic and its `FakeBackend.attach_existing`
has no guard to fail. The fix threads intent explicitly -
`ensure_pipe_pane(attaching=True)`, passed only from inside `attach_existing`,
after `is_alive()` and the `#{pane_dead}` probe have both answered. It does not
set `_running` early: that would make the backend claim it was streamable across
four tmux round trips and leave the claim standing on an object whose setup
raised. `tests/test_boot_readopt_real_tmux.py` covers it against a REAL backend
on a real throwaway socket, because a double cannot reproduce a guard.

**Claude Code lifecycle hooks feed the status machine.** `src/core/claude_hooks.py`
merges a managed hook block into `~/.claude/settings.json` (marked
`# cloudecode-managed`, idempotent, atomic write, bails rather than clobbering an
unparseable file). Hooks POST to a loopback-only endpoint authenticated by an
env-injected shared token. Events: `Stop`, `Notification`, `PermissionRequest`
(these three also raise a toast), plus `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `SubagentStart`, `SubagentStop` (activity state only).
**AND THREE OF THEM ANSWER TOASTS AS WELL AS RAISING THEM**: a prompt
submitted from ANY client fires `UserPromptSubmit` wherever it was typed, so
`src/core/toast_auto_ack.py` acks that session's open toasts as `answered`
(`PreToolUse` acks only a permission; `Stop` acks a permission or a notice and
NEVER the "your turn" it just raised, by KIND so the rule survives a duplicate
or a reorder, and never a toast raised after the event's own instant). Clients
drop the card on the `toast.ack` frame or, on a socket-less screen, when the
poll reconciles the open set - see `docs/notifications.md`.

Hook events arrive **unordered, and may be duplicated or dropped.** Every
consumer in `src/core/session_activity.py` is therefore idempotent: last-write-
wins booleans and floored counters (`subagent_depth = max(0, depth - 1)`). If you
add a hook consumer, it has to survive the same event twice and a missing pair
half. Never increment without a floor, never assume a `Stop` follows the
`UserPromptSubmit` you saw.

**Security posture.** CSP is stamped on every response by the middleware in
`src/main.py`. As of 2026-08-16 there is **no third-party origin in any
directive**: the baseline is `default-src 'self'` with `frame-ancestors 'none'`,
and `https://cdn.jsdelivr.net` has been removed from `script-src`, `style-src`
and `font-src`. It used to sit in all three because xterm.js 5.3.0, its CSS and
its fit / webgl / unicode11 addons loaded straight from the CDN in
`client/index.html`. They are now vendored under `client/vendor/xterm/`.
`style-src` still carries `'unsafe-inline'` and must keep it: xterm addons set
inline style attributes on nodes they manage, and the terminal renders blank
without it. Inline **styles** are therefore permitted; inline **script** and
`eval` are not.

**Why the CDN removal was a correctness fix, not only hardening.** A remote
xterm asset is one content blocker away from breaking the terminal for
everybody. Brave Shields on a phone dropped enough of it that xterm ran but
`xterm.css` did not apply, so the character cell was measured wrong, `FitAddon`
derived a bogus cols/rows from it, and `sendResize` reflowed the real tmux pane
to a grid matching nothing on screen. The symptom was a terminal that rendered
garbage on the device while the desktop and the desktop mobile emulator both
looked perfect, which is exactly what you would least suspect a CDN of. Nothing
the terminal needs may be loaded off-origin again. `tests/test_no_remote_assets.py`
fails the build if a third-party URL reappears in `client/index.html`.

New third-party libraries get **vendored** under `client/vendor/<lib>/` and
served from `/static`, with a `VERSION.md` beside the files recording version,
upstream source URL and sha256, plus a refresh script under
`scripts/<lib>-vendor/`. CodeMirror 6 and xterm are the worked examples
(`scripts/xterm-vendor/fetch.sh` re-downloads the pinned versions and hard-fails
on a hash mismatch). Do not add a host to the CSP, do not weaken
`frame-ancestors 'none'`, do not introduce inline script or `eval`, and do not
read `style-src 'unsafe-inline'` as license to widen anything further.

**A THEME CAN SHIP A SCRIPT, AND THE CSP IS NOT WHAT GATES IT.** A theme's
optional `effects.js` is served same-origin, from `/static/css/themes/<id>/`
for a bundled theme and from the `/themes/<id>/` mount for a user-authored
one, and is loaded by dynamic `import()`. `script-src 'self'` therefore
PERMITS it, correctly and unchanged - the policy's job is to stop code
arriving from somewhere else, not to decide which of our own origin's files
the user wants running. The gate is the app's own, it lives in
`client/js/theme-consent.js` (the ladder and the record) and
`src/core/theme_script_consent.py` (the same ladder, server side), and
`client/js/themes/registry.js` keeps only the modal and the execution.
**Nothing in #45 changed the CSP, and nothing in it may.**

**SIX OUTCOMES, ONE OF WHICH RUNS, AND THE ORDER IS THE CLAIM.** No script
declared; a recorded `never`; a record that could not be READ; a bundled
theme; a script whose bytes could not be digested; a grant naming DIFFERENT
bytes; a grant naming THESE bytes; nothing on record. Only the last-but-two
executes. **DENY WINS OVER EVERYTHING**, including the bundled bypass and
including a newer grant, whichever was written last - that is the property
that makes sharing a restriction safe. An UNREADABLE record refuses a cached
grant rather than honouring it, because a client that cannot read the record
cannot show that no newer `never` exists, which is exactly the "a cached
approval cannot outrank a newer global Never" this was asked for. The cost of
that refusal is an animation that does not play.

**CONSENT IS SHARED, AND WHAT MAKES A SHARED GRANT SAFE IS A DIGEST.** The
record moved out of this browser's `cloude.themeJsAllowlist` and into the
server-owned `ui_preferences.theme_script_consent`, so a `never` set anywhere
binds everywhere. `docs/ui-preferences-inventory.md` had recommended against
sharing it, and it was right about the shape it was describing: a grant keyed
on a theme ID alone is a standing yes for whatever that file later becomes,
and a theme directory is a folder anything with write access can edit. So an
`always` stores the sha256 of the exact `effects.js` it was granted for. The
server stamps that onto the manifest as `effectsDigest` from the bytes it is
about to serve, a manifest cannot declare its own, and editing the file makes
the grant stop matching so the user is asked again about the script that now
exists. **THE USER APPROVES AN ARTIFACT, NOT A NAME.**
`ui_preferences.validate_changes` REFUSES an `always` carrying no digest and
refuses the word `once` outright, so an unbounded grant and a persisted
temporary allowance are both unexpressible rather than merely unwritten.

**`ALLOW ONCE` IS NEVER STORED AND NEVER SENT**, and the legacy local key is
read for its REFUSALS ONLY. A `false` in `cloude.themeJsAllowlist` still
refuses, for free, because honouring an existing restriction can only reduce
what runs. Every `true` in it is IGNORED: it names no digest, so there is
nothing to bind a grant to, and those users are asked exactly once more. That
same reasoning is why the #46 settings import refuses that key by name.

**THE GATE IS A SEPARATE FILE SO ITS REFUSALS CAN BE MEASURED.**
`ThemeConsent.gateEffects` takes the injector as a CALLBACK and calls it on
exactly one path, so `tests/test_theme_script_consent.node.mjs` hands it a spy
and proves an unconsented theme never executes - against the real callback
registry.js passes in, not against an internal flag that correlates with it
today. Sixteen of its twenty-five cases are refusals. **A suite that only drove
the consented path would pass against a gate that never refuses**, which is
this project's own "a matcher that always finds something is worse than
useless" one layer up. A revocation arriving from another device runs the
module's `destroy()`, drops the loader cache, cancels an on-screen prompt and
is re-checked mid-`import()` before `init()` runs - and it SAYS that anything
the script already did to the page stands until a reload, because claiming
otherwise would be the false green this project keeps paying to remove.

**AND ONE OF THOSE REFUSALS WAS DECORATIVE, WHICH ONLY A MUTATION TEST
COULD SHOW.** Driven against a `decide()` mutated to always RUN, thirteen
of the twenty-one cases failed and `allow once is never written anywhere`
was the ONLY negative control still passing - because under an
always-allow gate the script runs and nothing is persisted either, so
every assertion it made was satisfied for the wrong reason. The fact it
never checked is the one that separates the two worlds: whether the user
was ASKED. Its `prompt` is a recording spy now, asserted to have been
called exactly once and about THIS manifest, and the same mutation now
fails it on `the script ran without the user ever being asked`. **A GREEN
NEGATIVE CONTROL PROVES NOTHING UNTIL YOU HAVE WATCHED IT GO RED**; if
you add one here, mutate `decide()` to always return `run` and watch.

**A "NEVER" THAT COULD NOT BE WRITTEN DOWN IS `skip_denied_unsaved`, NOT
`skip_denied`.** `gateEffects` ignored `remember()`'s return value for a
refusal, so it reported every one as recorded. Reproduced end to end
2026-09-10: `GET /themes` serves a folder called `Neon Rain` intact,
digest and all, and `validate_consent_map` then 422s the refusal, so the
user clicked "never", watched it take effect, and it was gone on reload
and never reached another device. It FAILED CLOSED every time, so it was
never an execution hole - it was a durability lie, which on a consent
control is its own defect, because it teaches the user the control does
not work. The gate now checks the status (`committed` or `unchanged` are
the only two that mean the record took it) and reports through an
optional `notify` callback that registry.js routes to `FabMenu.notify`.
**THE COPY LIVES WITH THE DECISION** (`UNSAVED_REFUSAL_COPY`) and the
caller supplies only the channel, so the sentence and the fact cannot
drift. A missing `notify` still logs; a message nobody could deliver is
not a reason to go back to saying nothing. `stale_revision` on a refusal
is reported the same way and deliberately NOT retried - it fails closed,
the user is told, and the next attempt succeeds.

**A THEME ID IS ONE RULE WITH FIVE CONSUMERS, AND `ThemeManifest.id` HAS
NO PATTERN AT ALL.** The only rule on the manifest is that the id equals
the directory name, so the keyspace is whatever the filesystem allows,
while `THEME_ID_RE` decided what a consent key and the selected-theme
preference could be. Those disagreed. The id has to survive as: a
directory name, a filesystem path segment, a URL path segment (safe
already - `effectsUrlFor` passes it through `encodeURIComponent`), a JSON
object key in the shared `theme_script_consent` map, and the `theme`
preference. `THEME_ID_RE` now covers the names people really have -
letters, digits, `.`, `_`, `-` AND THE SPACE, up to 128 characters, first
character not `.`, `-` or a space and last not a space - and
`src/core/theme_script_consent.py` names a reason beside every exclusion
rather than listing them.

**IT WAS DECLARED IN TWO FILES, AND `ui_preferences` NOW IMPORTS IT.**
Its own copy answered the same question about the same string, so a
folder name one accepted and the other refused was a theme you could
select and could not record a decision about.
`tests/test_theme_id_charset.py` asserts the two are the SAME OBJECT, not
two equal patterns, so a future widening cannot reach one and miss the
other.

**THE BROWSER KEEPS NO COPY OF IT, UNLIKE `DIGEST_RE`, AND THAT IS A
CHOICE.** A client-side mirror would only be good for pre-empting a
write, which means a mirror that drifted would refuse a write the server
would have taken - and the drift test guarding it would be guarding a
problem it created. The gate handles it REACTIVELY through `persisted()`
instead, which is correct whatever the write failed for: a rejected key,
a network outage, a stale revision. `DIGEST_RE` is mirrored because the
ladder BRANCHES on it; this would have branched on nothing.

**`\Z`, NOT `$`, AND THAT IS NOT COSMETIC.** Python's `$` also matches
immediately before a trailing newline, so the pattern this replaced
accepted `"matrix\n"` - a legal POSIX filename, and a second spelling of
one theme. JS `$` without the `m` flag does not, which is why the mirror
is the python pattern with `\Z` swapped back.

**NON-ASCII IS STILL REFUSED, DELIBERATELY, AND IT IS THE ONE REFUSAL
THAT COSTS A REAL USER SOMETHING.** The consent map in `config.json` IS
the audit record of what the user let execute, and a key carrying a bidi
override, a zero-width joiner or a homograph is one an operator cannot
read back and check. Supporting it properly needs a normalisation and
confusables policy, which is a bigger change and a worse one to make
hastily on a consent surface. A theme named `über` still renders, still
prompts and still fails CLOSED - what it cannot do is REMEMBER the
answer, and the user is now told that instead of being shown a refusal
that evaporates. Note what was NOT done: dropping such a theme from
`GET /themes` entirely was considered and rejected as over-broad, because
a theme that declares no script has no consent problem at all and would
have vanished for nothing.

**KNOWN DESIGN LIMIT: THE DIGEST IS TAKEN ONCE PER PAGE LOAD, THE
`import()` HAPPENS WHENEVER THE THEME IS APPLIED.** `loadManifests()` has exactly
one caller (`client/js/themes/registry.js:1179`), so the
`effectsDigest` a grant is matched against is the bytes as they were at
load. Edit `effects.js` after that and, WITHIN THAT ONE OPEN PAGE, the
grant still matches and the edited file runs. **This is recorded rather
than fixed, on purpose.** Exploiting it requires a process already
writing the themes directory while the page is open, which is an actor
who already has code execution as the user - so it does not lower the bar
for the threat this gate exists to raise, which is a theme the user
installed turning out to do something they did not agree to. A reload
re-measures. Do not restructure the load path to chase it; that is a
bigger change than it is worth, and re-digesting per apply would put a
filesystem read on every theme switch.

**THE ATTACH CAPTURE CARRIES THE CURSOR, BECAUSE `capture-pane`
SERIALISES CELLS AND NEVER CURSOR STATE.** `capture_visible_screen()`
(`src/core/tmux_backend.py`) appends an explicit `ESC[row;colH` read from
tmux's `#{cursor_x}` / `#{cursor_y}` via `pane_cursor_position()`. Without
it the client's cursor lands wherever the last captured character was
written, which is where the pane's cursor is only by coincidence.
Measured on a real Claude Code pane 2026-09-08: the pane's cursor sat on
row 8, inside its input box, while the capture ran to row 13, because the
box's bottom border, the path line and the mode line all sit BELOW the
prompt. The client was left five rows too low.

That was survivable on the ALTERNATE screen and is fatal on the NORMAL
one, which is now the shipped case because `disable_alternate_screen`
defaults on and is the only thing that makes scrollback exist. Captured
over a real keystroke, a normal-screen frame is
`ESC[38D ESC[4B \r ESC[38C ESC[4A X ...` and contains ZERO absolute
positioning, so a wrong starting cursor is never recovered from; the
alternate-screen renderer re-anchors with `ESC[H` and `ESC[r;cH` every
frame and silently corrects the client on the next keypress. The
normal-screen renderer also steps over runs of spaces with `ESC[nG`
rather than writing them, so the row it lands on is not even erased,
which is why the user's typed sentence appeared painted ON TOP of the
input box's bottom border with the border showing through the word gaps.

Rows line up one to one: `paint_on_attach` sends `ESC[H ESC[2J` first and
`-S 0` starts at the first VISIBLE row, so tmux's 0-based `#{cursor_y}`
is client row `y + 1`. **A cursor that cannot be read appends nothing** -
leaving the client where the text ended is the old behaviour, and an
invented `(0, 0)` would move every session to the top-left while looking
like a working feature.

**THE REPORTED "INPUT LAG" WAS THAT SAME DEFECT, NOT A THROUGHPUT
PROBLEM, AND THE NUMBERS SAY SO.** Claude Code diffs against its OWN
model of the screen, so the bytes it emits are identical no matter where
the browser's cursor is: a mispositioned cursor cannot make a repaint
bigger. Measured on a throwaway socket, per keystroke on the normal
screen: 52 bytes at an idle prompt, about 650 while the thinking spinner
animates. With the UI parked at the bottom of the viewport the pane
scrolled 4 lines over 10 keystrokes, not once per keystroke. And
`HISTORY_LIMIT` at 50000 does not reach the attach at all - the attach
paints ONE viewport through `paint_on_attach`, never `scrollback_lines`
and never the history. What the user actually experienced was measured
end to end by replaying a real pane's capture into a second real pane and
then feeding it that pane's own keystroke bytes: with the cursor
uncorrected, one typed `H` landed on the mode line at row 12 instead of
the input box at row 8; with it corrected the two panes agreed cell for
cell. You type, nothing appears where you are looking, a later full
redraw dumps it all at once. That is indistinguishable from lag from the
user's seat.

The residual cost of the normal screen is FLICKER on redraw, not latency,
and it is the price of having scrollback at all;
`AuthConfig.session.disable_alternate_screen` is the switch and turning
it off costs every line of history. Note this was NOT A/B'd between
renderers: Claude Code 2.1.215 on the developer's box reports
`alternate_on=0` even with no env var and no settings key, so a
fullscreen comparison could not be produced. The fix costs one extra
tmux round trip per attach, 9.8 ms median against 17.5 ms for the capture
beside it. `tests/test_capture_cursor_real_tmux.py` proves the claim with
a real second pane rather than a substring assertion, because asserting
the bytes end in `ESC[3;6H` proves only that the string was formatted.

<<<<<<< HEAD
**Config writes are atomic and backed up, and there is now ONE of them.**
`src/config/config_file.py::write_config_atomic` is the pattern: write the
`.bak` of the pre-write bytes first, then temp file, `fsync`, `os.replace`. A
half-written `config.json` costs the user their whole setup, so there is no
"just dump the JSON" shortcut anywhere in this codebase. Do not re-spell it;
both writers (the settings PATCH and the wrapper CRUD) call that one function.

**AND ITS ATOMICITY IS TESTED BY ITS MECHANISM, NOT BY ITS OUTCOME.** Replacing
tmp-plus-rename with a plain in-place write leaves IDENTICAL final bytes, so
every outcome assertion stays green; the two differ only when the write does not
finish. `tests/test_config_settings.py` therefore stages a failure part way
through and asserts the destination is untouched, and separately asserts the
destination is never opened for writing at all.
=======
**AND THE 150 ms ATTACH SETTLE IS NOW PAID ONLY WHEN A RESIZE ACTUALLY
WENT OUT.** The handshake slept 150 ms on every attach so a `SIGWINCH`
raised by the handshake resize could reach the pane's foreground process
before the capture stomped its buffer. That is the right thing to wait
for when a resize happened, and pure latency when the browser comes back
at the geometry the pane is already at, which is the common reconnect.
`src/api/attach_settle.py` is the rule and it has THREE outcomes, not
two: the pane's own `#{pane_width}`/`#{pane_height}` measured EQUAL to
the negotiated grid skips both the resize and the pause; measured
DIFFERENT resizes and settles as before; and anything else - the probe
refused, the backend cannot be asked, the client sent no dims, the resize
raised - settles as before. **A READING THAT DID NOT HAPPEN IS NOT A
READING OF NOTHING**: treating unknown as unchanged would leave the
pane's grid disagreeing with the browser, invisibly, until the user
typed. Both sleep sites go through the one function; the degraded branch
that never got client dims can never take the fast path, by construction.

**COMPARE AGAINST THE PANE, NEVER AGAINST THE NEGOTIATOR'S CACHE, and
that is why this costs a probe at all.** `TerminalSizeNegotiator` forgets
a session the moment its last client disconnects, so on the very common
close-tab-reopen-tab attach it has NO record and reports the size as
changed - keying the settle on its return alone would never once take the
fast path. Worse, a value it did remember says nothing about a pane an
adopt, a restart or an external `resize-window` has since moved.
Measured on tmux 3.6a at load average 14: the probe costs p50 9.85 ms,
the `resize-window` plus `refresh-client` pair it also skips costs p50
22.81 ms of BLOCKING event-loop time, and the whole resize-and-settle
segment on an identical-geometry attach went **p50 152.2 ms to 12.5 ms**.
A changed geometry still measures p50 186.7 ms, which is the point.
`tests/test_attach_settle_skip.py` proves the refusal against a REAL
backend whose tmux session has been killed, because a double asked to
return None proves only that someone wrote `return None`; its timing
claims are made by RECORDING the sleeps rather than by a wall clock,
which on a loaded box would either flake or be too loose to prove
anything.

**Config writes are atomic and backed up, and they go through ONE
boundary.** The sequence is unchanged and is not open to tidying: the `.bak` of
the pre-write bytes FIRST, then a temp file, `fsync`, `os.replace`. A
half-written `config.json` costs the user their whole setup, so there is no
"just dump the JSON" shortcut anywhere in this codebase. What changed is WHERE
it lives: `src/core/config_writer.py` is the only module that may perform it,
and `tests/test_one_config_writer.py` fails the build if a second one appears.

**ATOMIC AND SERIALIZED ARE DIFFERENT PROPERTIES, AND THIS ONLY HAD THE
FIRST.** Five functions wrote `config.json` - `Settings.update_settings_config`,
`Settings._write_wrappers`, `slash_favorites.write`,
`terminal_commands.replace_terminal_commands` and
`config_migration.migrate_config_file`. Every one was atomic, so a crash could
never truncate the file, and every one read the document, merged its own block,
and replaced. Two arriving together each merged into the SAME base and the
second replace threw the first writer's block away: the file was never corrupt
and the update was still lost. They also all used the same temp filename,
`config.json.tmp`, which a lock hides and a second process does not.

**THE FRESH READ INSIDE THE LOCK IS THE FIX, and it is enforced by the shape of
the API rather than by remembering.** `config_writer.commit(path, mutate)` takes
a MUTATOR, not a document: it acquires the path's lock, reads the file itself,
and hands that dict over. A caller cannot supply a stale base because it never
supplies a base. The temp file carries the pid plus a random suffix, a nested
`commit` raises rather than deadlocking, and `on_commit` listeners see the
committed document while the lock is still held. Four named outcomes, no silent
ones: `committed` / `unchanged` / `stale_revision` / `backup_unavailable`.
`unchanged` (the mutator returned `None`) touches NEITHER the config nor the
backup, which is the no-op behaviour the migration has always had, and
`backup_required=True` is what preserves that writer's FAIL-SAFE posture -
alone among the five, it refuses to run at all rather than write without a
rollback path.

**`ui_preferences` IS THE TYPED, VERSIONED HOME FOR PREFERENCES WITH NO SERVER
OWNER.** `src/core/ui_preferences.py` is the pure rules (the pydantic model, the
validation, the merge), `src/core/ui_preferences_store.py` the seam that puts
them on the lock and caches the read, and `src/api/preferences_routes.py` is
`GET`/`PATCH /api/v1/preferences`. The field set comes from
`docs/ui-preferences-inventory.md`, which classified all 24 durable
browser-stored keys; the ten in its PER-VIEWER column are NOT here and
`tests/test_ui_preferences.py` names every one of them, because a sync set that
quietly grew would pass every positive test and push one device's layout onto
every other device the user owns.

Four things about it are load-bearing. **A READ TOUCHES NO DISK**: the
projection is loaded once and refreshed by the `on_commit` listener, so a
wrapper edit or a boot migration keeps it in step - a cache invalidated only by
its own writer is wrong the moment anybody else writes. **AN UNRECOGNISED FIELD
IS PRESERVED**, so a newer client's preference survives an older server and a
downgrade destroys nothing; it is bounded rather than trusted, and a name that
reads like a credential is refused outright, which is what stops the passthrough
becoming a place to park a token. **ABSENT IS NOT A DEFAULT**: every field
defaults to `None` and the server never fabricates a value, so hydrating from an
empty or unreadable block cannot overwrite a real local setting - the client
keeps its own default and, until a read SUCCEEDS, refuses to write at all.
**THE REVISION MOVES ONLY ON A REAL CHANGE**, so a no-op `PATCH` does not make
every other client refresh for something that did not happen.

**A STALE WRITE IS A 409 THAT SAYS WHAT IS CURRENT, NEVER A SILENT
OVERWRITE AND NEVER A BARE REFUSAL.** The check is evaluated INSIDE the lock
against the document the write is about to merge into; checking it outside
compares against a read another writer can invalidate first, which is the lost
update wearing a check. The refusal carries the current revision AND the current
values, because a client cannot reconcile against a number it was not told, and
a bare 409 is how a retry loop against an unchanged conflict gets written. Same
shape as `if_version` on the respawn path. `tests/test_ui_preferences_api.py`
carries the NEGATIVE CONTROL: the identical request with the check declined,
asserted to overwrite, so the 409 test cannot quietly stop proving anything.

**`preferences.changed` IS AN OPTIMISATION AND THE REVISION IS THE ONLY
ORDERING IT NEEDS.** `client/js/preferences.js` applies a frame ONLY when its
revision is strictly HIGHER than the one it holds. That single rule survives
everything hook events already taught this project: the same frame twice is an
equal revision and ignored, a reordered pair has the older one lower and
ignored, a dropped frame is closed by the next higher one or by the next
refresh. It is a fold over a number, not an increment, so the socket promises
nothing. **APPLYING A RECEIVED CHANGE MUST NEVER GENERATE A SAVE** or two
browsers ping-pong forever, so `set()` refuses for the duration of the
fan-out - the guard is at this layer rather than in every control. **A
RECONNECT PERFORMS AN AUTHORITATIVE REFRESH, NOT AN EVENT REPLAY**
(`terminal.js`'s `ws.onopen`), and it never uploads this browser's snapshot.
That limit is CLOSED as of 2026-09-10 and the sentence that used to sit here
is history: the terminal WebSocket is still SESSION-SCOPED and still exists
only while a terminal is open, but `/ws/events` now carries the frame to a
browser sitting on the launchpad as well. The preferences route publishes to
BOTH, deliberately, and a browser holding both sockets receives the frame
twice - which is safe by construction rather than by luck, because
`applyRemote` applies a frame only when its revision is strictly HIGHER than
the one held. Dropping the terminal half would break every already-loaded
client that has no event socket yet, for no gain. The hydration on entering a
screen is untouched and is still what covers a client with neither.

## The application event channel, `/ws/events`

ONE AUTHENTICATED SOCKET PER BROWSER, carrying compact change notices about
every session, so a client on the home screen or looking at session A hears
about session B without waiting for its next poll. It closes the gap the
preferences work recorded above.

| Piece | File |
|---|---|
| The per-consumer bounded queue, and the named overflow | `src/core/bounded_stream.py` |
| The fan-out registry and the one publish path | `src/core/event_hub.py` |
| What a notice may claim, and the hook seam | `src/core/session_change_notice.py` |
| The endpoint | `src/api/events_routes.py` |
| The client | `client/js/app-events.js` |

**IT AUTHENTICATES EXACTLY AS THE TERMINAL SOCKET DOES, AND THERE IS NO
SECOND SCHEME.** The JWT rides `Sec-WebSocket-Protocol` and is checked by the
same `verify_jwt_from_subprotocol`, with the same `cloude.jwt.v1` marker
echoed on accept and the same 4401 / 4400 split. The client opens it through
`API.openWebSocket(null, '/ws/events')`, the function the terminal already
uses. A token in the URL is what that avoids: query strings are routinely
written to proxy and access logs and the header is not, and
`tests/test_ws_events.py` asserts a `?token=` handshake is still refused.

**COMPACT IS THE DESIGN, NOT AN OPTIMISATION.** A status notice carries the
session instance plus the handful of fields a row paints; the structural
notice carries only its own name and means RE-READ. A notice carrying a full
`SessionInfo` would become a second serialization of `/sessions/list` with its
own bugs and would drift from it; a notice that says re-read cannot. The
client honours that: it pokes `SessionSidebar.refreshNow()` and
`Launchpad.loadRunningSessions()` rather than patching a row in place, so an
event can only make the SAME refresh happen sooner.

**ABSENT IS NOT A DEFAULT.** `build_status_notice` OMITS any field the caller
could not measure rather than sending null, because a null says "this is now
false" and a fabricated `idle` or `ready` is exactly the false-green failure
this project keeps paying for.

**THE QUEUE IS BOUNDED AT 256 EVENTS OR 1 MiB PER CLIENT, AND AN OVERFLOW IS A
NAMED OUTCOME.** `BoundedStream.offer` is SYNCHRONOUS - a bounded
`asyncio.Queue` would have been the obvious change and would have been wrong,
because `await queue.put` on a full queue is precisely the backpressure into
the producer that the bound exists to prevent. Crossing the bound LATCHES,
closes that client's stream, drops it from the registry and closes its socket
with **4429**, an application code rather than 1013 so the client can tell
"you fell behind" apart from "the server went away" and skip its reconnect
banner. That client reconnects at once, with no backoff, and performs an
AUTHORITATIVE REFRESH: nothing replays and nothing is buffered for a browser
that is not there. No other client is touched.

**THE MUTE GATES THE TOAST AND NOT THE STATUS, AND THAT IS DELIBERATE.** The
toast notice is published from the one place in `claude_event_hook` a
suppressed toast never reaches - past the notification-policy gate and the
sub-agent gate, beside the existing per-session broadcast - so the policy is
enforced BY CONSTRUCTION and not by a second copy of the rule. The status
notice is published BEFORE those gates, because muting suppresses the
INTERRUPTION and changes nothing about what a row is allowed to say: a muted
session's light updates on the poll today, and a channel that refused to
report it would make that row visibly staler than before the channel existed.

**IT IS AN OPTIMISATION AND MAY NEVER BECOME A DEPENDENCY.** The five second
reconciliation poll is untouched. A tmux session started by hand on the
`cloude` socket produces no event here at all, and adopting an external
session is a first-class case in this app, so the poll is the only thing that
can see it. Every publish site is fail-soft: an app with no hub publishes
nothing, and a client whose socket never connects converges on exactly the
schedule it did before.

**PENDING IS NOT COMMITTED, AND A CONFLICT DROPS NEITHER SIDE.** A deliberate
choice applies locally at once and reports `pending`; a failure keeps the user's
value on screen as `failed` with the committed one still readable beside it, so
a retry knows both; a stale refusal or a remote change landing on an unsaved
edit becomes `conflict`, holding both values for the user to resolve. Silently
dropping either is how somebody loses a setting they watched themselves change.
Hydration runs BEFORE any preference-dependent control initialises, through
`App._initAuthenticatedState()` - ONE function called by both post-auth paths,
because two copies of that sequence is how one of them acquires a step the other
never gets (gotcha 7's shape).

**THE EIGHT EXISTING CONTROLS ARE MIGRATED ONE AT A TIME, THROUGH ONE SEAM,
AND ONLY WITH THE USER'S PRESS.** #43 and #44 built the block and the client
layer and deliberately rewired NOTHING, because moving each control is a
behaviour change with its own question about the value already sitting in that
browser. #46 answers that question in two halves.
`client/js/preference-bridge.js` is the seam: `read` prefers the shared value
and falls through to the control's own local reader, `write` MIRRORS to
localStorage AND the server. So a control becomes shared by changing its read
and its write, not by growing a preference layer inside itself. FOUR of the
eight are on it - the global theme (`themes/registry.js`), the sidebar density,
the global audio toggle and the last model chosen (`providers.js`) - each
having exactly one read function and one write function to move. The other four
(the sidebar arrangement, the two dock pins, the two fold maps) are collected
and importable but their controls still read local only; that is a known gap,
not an oversight, and the bridge is what closes it when somebody picks it up.

**MIRRORED, NEVER MOVED, AND THE LOCAL COPY IS NEVER CLEARED.** Three reasons
and the third is the one that matters: the local value is what answers when the
server is unreachable, it is what the pre-hydration paint reads (which is how
`applyStoredThemeIdSync` still kills the flash of the default), and #46's own
rule is that the local source is RETAINED until the server confirms. There is
no tidy-up step, because the tidying is what loses a user's settings on exactly
the request that failed. **ABSENT IS NOT A DEFAULT** here either: a field the
server does not hold falls THROUGH to local rather than reading as the
control's default, or every control would snap to its default the first time a
browser hydrated against a fresh install and the next change would save that
default over every other device. **AND THE BRIDGE NEVER SAVES ON ITS OWN** - no
read-then-write, no write-back-on-hydrate, no upload of a value the server has
not got.

**THE IMPORT IS EXPLICIT, PREVIEWED, AND ONE-TIME PER INSTALL.**
`src/core/settings_import.py` is the pure rules, `settings_import_store.py` the
one commit, `src/api/settings_routes.py` the three endpoints
(`GET /settings/import/state`, `POST /settings/import/preview`,
`POST /settings/import`), `client/js/settings-import-collect.js` the reader and
`client/js/settings-import.js` the panel, mounted as a slot on the settings
screen's general tab. **NOTHING IS UPLOADED WITHOUT A PRESS, ON ANY PATH** -
there is no import-on-load, no import-on-reconnect and none inside hydration.
The failure that buys: an automatic migration means the LAST browser to connect
wins, so a machine nobody has opened in three months uploads its stale snapshot
and silently reverts every setting changed since.

**THE PREVIEW AND THE IMPORT ARE THE SAME PLAN, BY CONSTRUCTION.**
`build_plan` is called by both endpoints and `changes_from` derives the write
from its output, so the preview cannot describe one thing and the commit
perform another. A preview that lies is worse than no preview: it is a safety
control telling the user they are safe. `tests/test_settings_import.py` proves
it by previewing, committing and comparing what landed, rather than by reading
two code paths and agreeing they look similar. The plan is REBUILT INSIDE THE
WRITE LOCK against the document the write will merge into, and a changed
selection re-fetches the preview from the server rather than being adjusted in
the browser - a second implementation of the plan is the one thing that could
make the two differ. Six per-field outcomes, and **SERVER VALUES WIN BY
DEFAULT**: a conflict is `conflict_kept` unless the user ticked that specific
field, which makes it `conflict_overridden`. There is no import-everything.

**THE MARKER AND THE VALUES LAND IN ONE COMMIT.** `ui_preferences_import` is a
sibling key in config.json, written by `apply_import` in the same
`config_writer.commit` as the preference merge, because both half-failures are
bad and both are silent: settings without the marker leave the install
re-offering the import to the next stale browser, and the marker without the
settings closes the offer having changed nothing. An import that writes NO
values still writes the marker - "everything here already matched" is a
completed import.

**THE ALLOWLIST IS A PROJECTION AND THE COLLECTOR NEVER ITERATES STORAGE.**
`importable_fields()` is `ui_preferences.known_fields()` minus
`REFUSED_FIELDS`, so a field added to the block is importable the day it lands.
The client reads only literal keys from its own table - there is no
`for (i = 0; i < localStorage.length; i++)` and there may never be one - which
is what keeps `claude_tunnel_token` and `claude_refresh_token` out of the
payload BY CONSTRUCTION rather than by a denylist one forgotten entry away from
uploading a credential. `tests/test_settings_import_collect.node.mjs` measures
that two ways: a recording storage proving neither token was ever READ, and the
serialised payload searched for the token VALUE.

**AND `theme_script_consent` IS REFUSED DESPITE BEING A PREFERENCE**, which is
the interesting half. #45 made it a known field, which would otherwise make it
importable. A browser's local record of "I allowed this theme's script" is the
pre-#45 `cloude.themeJsAllowlist` shape: a theme id and no digest, so importing
it would mint exactly the unbounded standing grant #45 exists to make
unexpressible. The issue's rule is "never infer theme-script approval from a
theme selection"; this is that rule one step further - never carry an approval
at all. Refused by NAME on the server and absent from the client's table, so
neither end depends on the other remembering.

**THE LOCAL SERVER DETECTOR IS FULLY WIRED, HAS NO CLIENT, AND IS KEPT ON
PURPOSE.** `LocalServersTracker` (`src/core/local_servers.py`) scrapes a port
number out of pane output, validates it with `is_valid_dev_port`, probes it
with `port_is_listening`, and broadcasts `local_server_detected` /
`local_server_lost` over the WebSocket. It is constructed, attached and started
at boot (`src/main.py:537-539`), stopped on shutdown (`:776-777`), read by
`GET /sessions/{session_name}/local-servers` (`src/api/routes.py:2614`) and
cleared when a session is destroyed (`:963`). **The owner ruled it STAYS.** Do
not remove the tracker, the route, the two WebSocket message models
(`src/models.py:1818, 1826`) or the model fields, and do not disable the
janitor. It is dead code retained deliberately, which is not the same thing as
dead code nobody noticed, and this paragraph exists so a dead-code sweep can
tell the two apart.

Nothing in `client/` has consumed it since `4ee2f44` removed the panel.
Grepping `client/` for `local_server`, `localServer` or `local-servers` finds
only comments: three in `terminal-resize-settle.js`, `terminal-away-bar.js` and
`terminal-away-bar.css` citing `#localServersContainer` as the worked example
of why a panel must never sit IN FLOW beside `.terminal-container` (it was
toggled on every fetch, so it reflowed the terminal under the user), plus one
unrelated CSS accent comment. So the route and both WebSocket messages are live
and unread. **Do not put any panel back in flow beside the terminal container.**

**AND THE `local_servers` FIELD ON THE API IS HARDCODED EMPTY, SO IT DOES NOT
REFLECT WHAT THE TRACKER KNOWS.** `SessionInfo.local_servers` and
`SessionStats.local_servers` (`src/models.py:229, 236`) are assigned an empty
value at all four assignment sites: `session_manager.py:4845` (`0`),
`session_manager.py:5167` (`[]`), `routes.py:1459` (`[]`) and `:1461` (`0`).
Those literals PREDATE the panel removal, so this is not a consequence of it.
A client reading that field today is told, wrongly, that the session has no
local servers while the tracker sitting beside it is detecting them. **Anyone
reviving this feature must wire those four sites, not assume they work** - the
tracker is the part that is correct, and an afternoon spent debugging it would
be an afternoon spent on the wrong file. They are deliberately NOT wired here:
reporting real detections to a client that does not read them is a behaviour
change nobody asked for.

The standing cost, measured rather than assumed, so it can be judged later: the
janitor (`_janitor_loop`) wakes every `JANITOR_INTERVAL_SECONDS` (30.0) and
re-probes only the ports it is ALREADY TRACKING, in a worker thread so a slow
`connect_ex` cannot stall the event loop. State is in-memory and starts empty
on every boot, and a port is tracked only after a pane actually prints one. So
on a box where no session has printed a port the loop costs one wakeup every 30
seconds and ZERO probes, not a sweep per session. That is small, and it is not
nothing; the open question of whether it is worth paying while nothing reads
the result is the owner's to answer, and it is written down here so he can
answer it with the real number in front of him.
>>>>>>> 6012467

## The `/sessions/list` shape

`GET /sessions/list` returns `SessionInfo` objects
(`src/models/sessions.py`), and the
fields sit on **two different levels**:

- On the wrapper: `activity_status`, `unread`, `startup_gate`, `tmux_session`,
  `agent_type`, `agent_family`, `agent_family_source`, `agent_wrapper_label`,
  `pinned_theme`, `session_backend`, `recent_logs`, `local_servers`, `stats`
- On the nested `.session`: `id`, `pty_pid`, `working_dir`, and the rest of the
  `Session` model

Reading `info.id` or `info.session.unread` gives you `undefined` silently, and it
looks exactly like "the backend didn't send it". This is the single most
repeated bug in the project. Check the level before you debug the endpoint.

**Three fields describe the agent, and they answer three different questions.**
`agent_type` is the raw stored value: a wrapper id (`claude-chrome`) or a bare
family name (`shell`). `agent_family` plus `agent_family_source` are the
DISPLAY-time resolution of it (`src/core/agent_family_display.py`), and the
source is what keeps a fingerprinted guess from rendering like a launch fact.
`agent_wrapper_label` is the wrapper's configured label
(`src/core/agent_wrapper_display.py`), `null` whenever no configured wrapper can
be named - a fingerprinted value, a bare family name, or an id config no longer
carries. `AttachableSession` carries the same three, resolved by the same
functions, so a launchpad row merged from either endpoint agrees about itself.

**A GUESS MUST NEVER OUTRANK A RECORD, and the ordering lives in one place.** A
live session has two sources for `agent_type`: the in-memory `Session` and
`sessions.agent_type` on its row. `_session_info_for` used to read the row only
when the in-memory value was EMPTY, and that is wrong for an ADOPTED session -
every live session is re-adopted after a server restart, the adopt path
fingerprints the pane and stores the bare family token, so a session launched as
`claude-chrome` came back holding `claude` and painted `~claude` (the dashed
"guessed" pill) beside a row that recorded the exact wrapper. Measured on the
owner's box 2026-09-08: row 43, `agent_type='claude-chrome'`,
`agent_family_source='launched'`. `session_agent_evidence.choose_agent_evidence`
is now the only thing that picks between the two, as a four-rung ladder:
in-memory launch, then the row, then the in-memory fingerprint, then nothing.
The row beats the fingerprint because nothing writes an inference into
`sessions.agent_type` - `persist_fingerprint_family` writes `agent_family` and
deliberately leaves that column alone.

**`startup_gate` answers a DIFFERENT question from `activity_status`: has this
session started at all?** A freshly launched claude parked on its folder-trust
dialog is a live pane, running a real process, with a pid tmux reports happily -
and it has fired NO hook, so every field beside it reads healthy and the row
painted a green `Connected` dot over a session waiting for a keypress. That is
punchlist 19. `activity_status` describes what a RUNNING agent is doing; this
says whether it is running. Three values, `ready` / `awaiting_startup_prompt` /
`unknown`, resolved by `src/core/session_startup_gate.py` (the PURE ladder) with
its state and its one tmux read next door in
`src/core/session_startup_gate_ledger.py`, and rendered by
`client/js/session-startup-gate.js` as `needs a keypress` on the sidebar row and
the launchpad card, plus a `StartupPrompt` toast claimed ONCE per instance.

**The signal is the ABSENCE of a hook, and it was measured.** Controlled
experiment, 2026-09-08, claude 2.1.263, throwaway `tmux -L cloude-test` socket
with the hook POSTs pointed at a local listener: launched in an UNTRUSTED
directory the pane sat alive on the trust dialog for 35.8s and the listener got
ZERO POSTs; the dialog was answered at +34s and the first hook, `SessionStart`,
landed 1.76s later. Launched in the same directory once trusted, three runs,
`SessionStart` landed 0.49s / 0.50s / 0.41s after pane birth. So a hook is
positive proof startup finished, and `STARTUP_HOOK_GRACE_SECONDS = 20` is forty
times the normal cost of getting one.

**A HOOK OUTRANKS THE SCROLLBACK, and the rung order is the whole design.** tmux
does not erase the trust dialog when it is answered, so a session that answered
it an hour ago still has the marker text in its tail. Reading the text first
would pin that session at `awaiting_startup_prompt` forever, which is why
`resolve_startup_gate` tests the hook before it ever looks at the text. Old
scrollback is STALE EVIDENCE. Rung 5 (no tail captured) refuses with `unknown`
while rung 7 (tail read, nothing matched) answers `ready` - the same asymmetry
the transcript-presence guard uses, for the same reason. `ready` claims only
"not blocked on a startup prompt", NOT "healthy": a pane measured dead answers
`ready` here, and `activity_status` is what says it died.

**THE TAIL READ WAS CLAIMED TO BE FREE IN STEADY STATE AND IT WAS NOT, AND
THAT SENTENCE IS WHY THE TERMINAL LAGGED.** `should_capture_tail` gates the one
`capture-pane` on alive + past the grace window + no hook, and this file used to
say that set "on a working box is the empty set". It is not. The hook record
lives in `StartupGateLedger`, which is IN-MEMORY and per server process, so a
session that fired its last hook before this process started has none and never
acquires one. Measured 2026-09-09 on the owner's box: **13 of 13 live sessions,
all healthy, took a capture on every 5s listing poll, forever.** The fourth
refusal closes it - a reading younger than `STARTUP_TAIL_RECHECK_SECONDS` (30s)
stands instead of being re-taken, the ledger carries the verdict
(`record_tail_read` / `last_tail_match` / `tail_age_seconds`), and
`resolve_startup_gate` consults that remembered verdict ONLY at rung 5, where
the alternative is refusing. Only a RE-look is throttled: an instance with
nothing on record is read immediately, so a session parked on its trust dialog
since birth is detected exactly as promptly as before. A throttle without the
remembered verdict would flap the row between a measured answer and `unknown`
on alternating polls, which is worse than the cost it saves. Do not move that
capture up into the unconditional path.

**THE LISTING PASS USED TO RUN ENTIRELY ON THE EVENT LOOP, SO ITS COST WAS
TERMINAL LATENCY. ITS EXPENSIVE READS NOW RUN IN A WORKER THREAD.** This is
the rule the two paragraphs above and the section below all serve, and the
history is kept because every cost-reduction round in this section was aimed
at it. `list_session_infos` was `async def` whose body was entirely
SYNCHRONOUS, so for as long as it ran the server did nothing else at all: it
could not read the tmux pipe carrying terminal output, could not spawn the
`send-keys` that delivers a keystroke, and could not answer another request.
Measured 2026-09-09, 13 live sessions: **27 tmux subprocesses and 1008 ms per
pass** (one bulk `list-panes -a` at 282 ms, then `has-session` x13 at 377 ms
and `capture-pane` x13 at 349 ms), polled every 5s by the sidebar and again by
the launchpad. The user reported it as typing lag and as a sidebar click taking
two seconds; the click's own endpoint measured **45-64 ms**, so essentially all
of that two seconds was queueing. The control that proved the mechanism is
`GET /sessions/records`, which does its work in a threadpool: its own cost is
5.8 ms and its p99 was 161 ms, all of it spent waiting to be served.

**THE PASS IS THREE STAGES NOW, AND THE ORDER IS THE CLAIM.** SNAPSHOT on the
loop (`_listing_snapshot`, copying the names and the socket out of the live
dictionaries into tuples), GATHER in `asyncio.to_thread`, then the per-row loop
back on the loop, UNCHANGED. `src/core/listing_gather.py` is the thread body
and `src/core/listing_prefetch.py` the name-keyed decorations. Measured with 4
live sessions, **13 of the pass's 17 SQLite connections** now open off the
loop, along with the one bulk `tmux list-panes -a`. The file drawer's shallow
read, in the paragraph below, is the worked example this copies.

**EVERY WRITE DELIBERATELY STAYED ON THE LOOP, AND THE REASON IS NOT
TIDINESS.** Twelve of them - the activity tracker's signals, the unread epoch
memo, the permission-verify and startup-gate ledgers with their once-per-instance
toast claims, the status seed's cache and the durable
`_persist_settled_activity_state` write - are each a READ-MODIFY-WRITE against
in-memory state the hook route mutates on the loop at the same time. The
permission pair is the one that makes a torn read SILENT rather than loud:
`permission_open` and `permission_opened_at` are SET in one order and CLEARED
in the opposite one, so a thread reading them mid-transition sees a coherent
looking half-state and no exception is raised anywhere. Moving those needs an
APPLY stage that re-validates at write time, in the manner of
`config_writer.commit`'s fresh read inside the lock. That is a real refactor of
a 400-line function and **A PARTIAL, CORRECT IMPROVEMENT BEATS A COMPLETE,
RACY ONE.**

**AND THE SINGLE-FLIGHT COALESCER IS WHY TWO GATHERS CANNOT OVERLAP.**
`src/core/single_flight.py` makes a caller asking for a listing while one is
in flight AWAIT that pass rather than start its own, which it was built for a
different reason (15 polling clients were each paying for an identical answer,
giving the endpoint a measured period of about 0.85 s rather than 5 s). It
matters here too: with the loop free during a gather, without it a second
request would start a SECOND thread reading the same rows.

**THE SAFETY PROPERTY IS A TEST, NOT AN AUDIT, BECAUSE A BOUND METHOD CARRIES
`self`.** `ListingReaders` hands the thread bound methods and nothing else,
which narrows what `listing_gather` itself can reach and narrows NOTHING about
what a reader's own body may grow into: a `self.sessions` read added inside
`_label_for_tmux_name` would put a live container back in the thread and no
signature would say so. So `tests/test_listing_off_the_loop.py` wraps the six
live containers (`sessions`, `backends`, `_instance_epochs`, `pinned_themes`,
`_hook_tmux_names`, `_activity_tracker`) in thread recorders, drives the REAL
`_listing_readers()` bundle through `asyncio.to_thread`, and fails naming the
container and the thread. It carries its own negative control, and that control
was WATCHED GOING RED against a live read injected into a real reader before it
shipped.

**THE FILE DRAWER'S TREE SCAN WAS THE SAME DEFECT ON A SECOND PATH, AND IT
WAS NOT A SUBPROCESS OR A SQLITE PROBLEM.** `GET /config-files/tree` was an
`async def` calling `config_files.list_tree` directly, a recursive filesystem
walk, so opening the file drawer stalled every terminal in the app for the
length of the walk. The cost is `stat` SYSCALLS and nothing else: measured
2026-09-10 against this repository's own working directory, **1621 nodes,
6501 `stat` calls against 93 directory reads** - about four `stat`s per node,
because `_build_node` asked `is_dir()` three times and the sort key asked
`is_file()` once. Against `~/.claude`: 1112 nodes, 4551 `stat`s. Warm wall
time 264 to 477 ms per open. **A subprocess count or a connection count would
have passed before the fix and proved nothing**, which is the sibling
listing's lesson applied in the other direction.

The fix is two halves and the ORDER matters. First
`await asyncio.to_thread(config_files.list_subtree, ...)`, which is what
actually stops the stall; second an optional `depth`, so the levels nobody
expands are never walked. Interleaved A/B in one process, so the same load
hit both arms: the walk ON the loop stalled a concurrent coroutine for
**372.8 ms p50, tracking its own 374.1 ms wall time almost exactly** - the
handler's duration IS the stall - while in a thread the same walk's wall time
was unchanged and the stall fell to **101.5 ms p50 against a 50.0 ms idle
control on a box at load average 33**, no longer tracking the wall time at
all. THE RESIDUAL IS NOT SETTLED: that box was heavily contended and the
control's own noise floor is half the post-fix figure, so re-measure on a
quiet machine before quoting 101.5 ms as this path's cost.

The second half is measured in SYSCALLS, which do not care what else the box
is doing. One open of the drawer, both roots: **8363 `stat` calls and 365
directory reads before, 245 and 2 after**, a 34x reduction, because a client
sending `depth=1` never asks for a level nobody expanded. Expanding five
directories by hand still costs only **1667**, 20 percent of what a single
open used to cost unconditionally. The offload removed the STALL and the
shallow read removed the WORK: shipping only the second would still block the
loop for whatever the shallow read costs, which is why that order is the one
the issue specified.

**`children_loaded` IS THE THREE-OUTCOME RULE REACHING `children`.** An empty
`children` list used to mean BOTH "read, genuinely empty" AND "stopped at the
depth cap" - a conflation that predates shallow reads and that shallow reads
would have made routine. `TreeNode.children_loaded` is True only when the
directory was actually enumerated, and a client tests `=== false`, never
falsiness, so a server that omits the field reads as loaded and an old client
sending no `depth` still gets the whole tree. **CONTAINMENT IS RE-CHECKED ON
EVERY EXPANSION**, through the same `resolve_safe_path` that `read_file` uses:
component-wise `Path.relative_to` after `resolve()`, never a string prefix,
so `/Users/jsugamelevil` is not inside `/Users/jsugamele`. That makes a
per-level read STRICTER than the recursive walk, which descends through a
symlink without re-resolving it. See `src/core/config_files_tree_request.py`
(the pure request rules), `client/js/config-editor-lazy.js` (the expansion and
its three outcomes) and `tests/test_config_files_shallow.py`, whose
loop-blocking test is STRUCTURAL rather than timed - a stand-in walk parks
until a coroutine beside it releases it, so it can only pass off the loop and
cannot flake on load - and which carries the negative control proving that
harness detects a walk that IS on the loop.

**A SECOND SUBPROCESS MUST NEVER ASK WHAT THE BULK ROW ALREADY SAYS, BUT ONLY
THE POSITIVE HALF OF THAT ROW IS EVIDENCE.** `backend.is_alive()` is
`tmux has-session`, and `list-panes -a` in the same pass already enumerates
every live session BY NAME. `src/core/session_status_map.py` is where the fact
that makes the row usable travels with the data: `StatusMap` is a `dict`
subclass carrying `complete`, so every existing consumer and every plain-dict
test double is untouched. **The asymmetry is the design.** A completed listing
that NAMES a session proves it exists, so `listing_proves_alive` returns True
and the probe is skipped. A listing that does not name it proves much less - it
covers only the socket the probe was bound to and it is one moment in time - so
it returns False meaning "not established", and `_session_info_for` still runs
`is_alive()` for exactly those rows. **Trusting the negative was tried and it
was wrong**: it dropped every row whose backend the listing could not see,
which four `tests/test_session_rename.py` cases caught immediately and which in
production would delete a LIVE session off the sidebar. Costing the probe only
for rows about to be dropped costs nothing in steady state, where all 13
sessions are in the listing. `tests/test_listing_subprocess_cost.py` pins it
against REAL tmux by COUNTING subprocesses rather than timing anything: the
count is the defect exactly, and a wall clock on a loaded box would either flake
or be too loose to prove anything.

**THE SIBLING LISTING'S COST WAS NOT SUBPROCESSES, AND ASSUMING IT WAS WOULD
HAVE MISSED IT.** `/sessions/attachable` was already down to TWO tmux calls in
steady state - its per-row pane fingerprint is cached per instance triple - so a
subprocess count would have passed before any fix and proved nothing. What grew
with the row count was SQLITE CONNECTIONS: the title, the durable row id and the
recorded launch are three columns of ONE row under ONE key, and each was fetched
by its own function opening its own connection. Measured 2026-09-09 with 11
rows: **33 connections, about 33 ms of a 55 ms pass**, roughly 60 percent of it.
`src/core/session_instance_index.py` reads them in one `SELECT` and answers every
row from memory; the pass now opens the datastore **3 times regardless of row
count** (`owned_tmux_instances`, `reconcile_lifecycle`, and the index), measured
at **52-61 ms to 24-35 ms warm**. The two SELECTION RULES differ and both are
preserved: `label_for_instance` asks for `ORDER BY id DESC LIMIT 1` while the
other two take an unordered `fetchone()`, so the index keeps the FIRST row for
identity and launch and the LAST for the title. Collapsing them would be a silent
change in the duplicate case nobody looks at. **Measure what is actually wrong,
not what the last fix happened to be.**

**AND THE SAME PASS OPENS A SQLITE CONNECTION PER ROW, WHICH IS THE HALF
HIS INDEX DID NOT REACH.** `session_instance_index` was wired to
`/sessions/attachable` only. `/sessions/list` has the identical shape one
layer down: the status seed ladder's
`session_status_seed_read.read_instance_row` opens its OWN connection, per
session, for four columns off the row found by the SAME instance triple
the index already keys on. Measured in-process against real tmux with 19
live panes, one pass: **95 datastore opens before, 77 after** - the index
costs one and saves one per session - and the synchronous pass itself
**58.9 ms p50 / 68.4 p99 to 49.7 / 57.2**. Trust the COUNT, not the
milliseconds: that timing is a warm local database with no rows in it, and
the live figure it is meant to explain is 270.1 ms p50 against 418.5 p99
with a no-op `/health` inflating from 45.3 ms quiet to 181.9 ms while a
listing is in flight. **THE COST IS A BURST, NOT A DRIP**, and saying so
accurately is the point: `seeded_display` re-derives at most once per 60s
per session, so about one poll in twelve reaches the read - but the seeds
warm together and therefore EXPIRE together, so the shape is N synchronous
opens landing inside ONE pass, which is what a p99 is made of.

**`InstanceIndex` NOW CARRIES `complete`, AND THAT IS WHAT MAKES IT SAFE TO
READ FROM.** An empty index is harmless for a DECORATION - a missing title
renders as nothing, exactly what the per-row read produced when the
datastore would not open - and is NOT harmless for the seed, where `None`
means "this instance could not be identified" and would blank the status
ladder for every session in the pass. So `complete` is True only when a
query actually RAN, a real answer of zero rows included, and the seam reads
the index only then; anything else falls through to the connection it was
always opening. Same discipline as `StatusMap.complete`, same sentence
underneath it: a reading that did not happen is not a reading of nothing.
The four seed columns join the FIRST-row group in the duplicate-triple
rule, because `read_instance_row` also took an unordered `fetchone()`.
**AND THE INDEX IS SKIPPED WHEN NOTHING CAN USE IT**, which is his own
`2b1fcb9` correction applied to this path: the seam is reached only inside
`if not hooks_seen(session_id)`, so a box where every session has fired a
hook would pay one connection to answer nobody. `hooks_seen` is a
NECESSARY condition and not a sufficient one, so that gate may over-include
and must never under-include.

**FOUR PER-ROW READERS REMAIN ON THIS PASS AND ARE STILL DELIBERATELY NOT
FOLDED IN; THREE OF THEM MOVED OFF THE LOOP INSTEAD.** Measured and
attributed by caller, 19 sessions: `_restored_activity_state` 19,
`_identity_for_live_name` 19, `_label_for_tmux_name` 19,
`_owned_instances_from_db` 19. Every one is NAME-KEYED with a recency rule
("the newest instance of this name") while the index is keyed on the full
instance triple, so answering them from it would be a silent behaviour
change in the duplicate-name case nobody looks at. THAT IS STILL TRUE and
nothing was folded in. What changed is WHERE the first three run: they are
the body of `build_listing_prefetch`, called once per name in the gather
thread, with the same queries and the same selection rules, so it is a
change of where the work happens and never of what it answers.

**THE FOURTH, OWNERSHIP, STAYS ON THE LOOP, AND AN ADOPTION IS THE REASON.**
`is_owned_tmux_name` is a two-rung ladder, the in-memory
`owned_tmux_sessions` set then the datastore, and an ADOPTION MOVES ONLY THE
DATASTORE - `adopt_external_session` says so in its own docstring, and the
only three `.add` sites are the boot backfill, create and rename. So the
datastore is exactly the rung an adoption lands on, and it is the rung a
prefetch would freeze. Freeing the loop is what makes an adoption able to
land WHILE the gather runs at all, so prefetching this one would drop
`created_by_cloude` off a freshly adopted row for a whole poll cycle - the
threading change would have INTRODUCED that race. It cost 4 of the pass's 17
datastore opens at 4 sessions, so the other three carry the clear majority of
the saving, and leaving it on the loop makes the staleness question GONE
rather than documented. A test that faked the adoption by calling
`owned_tmux_sessions.add` was green while vouching for nothing, and is
replaced by one driving the DATASTORE rung through a real pass.

`tests/test_listing_pass_datastore_cost.py` pins the ceiling at the EXACT
measured `4N + 1` with NO headroom, re-measured 2026-09-11 over three
consecutive runs, and its failure message names WHICH reader grew. The spare
open it used to carry meant the alarm was simply off while the pass sat under
the bound. **Raising that bound is re-introducing the defect with the alarm
switched off.** Note what it does and does not measure: it counts
CONNECTIONS, which stopped being the same thing as STALLS the moment 13 of
the 17 moved into a thread. `tests/test_listing_off_the_loop.py` is the file
that proves WHERE they run.

**THE PERMISSION VERIFY WAS CHECKED AND ITS GATE WAS ALREADY RIGHT, WHICH
IS WORTH KEEPING BECAUSE THE OBVIOUS READ WAS WRONG.**
`verify_open_permission` is a third potential per-row `capture-pane` on
this pass, and the expectation was that it carried the startup gate's
defect. It does not, and the difference is the DIRECTION of the refusals.
`should_capture_tail`'s "no hook on record" is FAIL-OPEN: the ledger is
in-memory, so a missing record makes it PASS, which is how 13 of 13
healthy sessions captured on every poll forever.
`should_capture_permission_tail` is FAIL-CLOSED at every rung - no open
claim, no stamp, no capture - so a box with no dialog on any pane spends
nothing here, measured over six sessions rather than asserted. What WAS
real is the RE-look: both verdicts that KEEP the flag leave the gate
passing next poll, so a genuinely open claim paid one subprocess every 5s
until a human answered it. `PERMISSION_TAIL_RECHECK_SECONDS = 30` bounds
that and nothing else. **THE LEDGER IS KEYED ON THE CLAIM,
`(session_id, permission_opened_at)`, NOT ON THE SESSION**: a new
`PermissionRequest` carries a new stamp, finds no record and is read at
once, so the throttle can never delay the FIRST look at a claim - which is
the only thing that catches a flag no reachable event can retire, the
adopted-id stuck bit of gotcha 10. A session-keyed record would have
delayed exactly that case, silently. A window opens only after a capture
ACTUALLY happened, so a refusal cannot throttle the first real look once a
pane comes back.

**AND A LISTING MAY ONLY VOUCH FOR THE SOCKET IT WAS TAKEN FROM.**
`listing_proves_alive` replaces a `backend.is_alive()` that probed THE
BACKEND'S OWN socket with a lookup in a listing taken from the PROBE'S. As
merged, neither was compared. A tmux session NAME is not unique across
sockets and this app mints names from project slugs, so a name present on
the probe's socket would have vouched for a dead session held by a backend
pinned elsewhere - a green `Connected` dot over a corpse, this project's
recurring failure. `StatusMap` now carries the socket the listing came
from, read off the probe so it can never claim one it did not come from,
and the function takes the socket the caller is asking ABOUT. Unstated on
either side, or a mismatch, REFUSES - and a refusal costs exactly the
pre-fix probe, so refusing too often is free and answering across sockets
is not. `tests/test_listing_liveness_socket_scope.py` measures it on two
real throwaway sockets with one name alive on A and killed on B, and
reproduces the PRE-FIX rule inline so the file fails if the old behaviour
returns rather than only checking that a keyword argument exists. Its
positive control is load-bearing: a backend on the listing's own socket
must still skip its probe, or a fix that refused everything would pass.

**AND THE FAN-OUT UNDER THAT READER IS BOUNDED PER VIEWER, WITH ONE WRITER
EACH.** This sits DOWNSTREAM of the kqueue reader and changes nothing about
it: the backstop, the `_pending_data` latch and the one-Future-plus-one-timer
wait are untouched. What changed is what happens to a chunk once the reader
has it. `_make_output_handler` did `await queue.put(encoded)` into an
`asyncio.Queue()` with NO maxsize, once per subscriber - and a queue with no
maxsize never blocks on put, so the defect never announced itself. It simply
GREW: this process held every byte a stopped browser had not read, for as long
as it did not read them, and the failure landed on the whole server rather
than on the one client that caused it. Measured on this tree, 5000 chunks of
8192 bytes fanned to three stalled viewers: **156.3 MiB held and still
climbing, against 8.0 MiB after**, with the overflow declared at chunk 256.

| Piece | File |
|---|---|
| The bounded queue and the named overflow, shared with `/ws/events` | `src/core/bounded_stream.py` |
| The viewer's bound, its frame kinds and the offer helpers | `src/core/viewer_fanout.py` |
| The one writer, the feeders, and the broadcast seam | `src/api/websocket.py` |

**THE HANDLER IS SYNCHRONOUS NOW, AND THAT IS THE CLAIM.**
`TmuxBackend._emit_output` awaits whatever `on_output` returns, so a coroutine
there puts the tail loop one await away from a browser's queue. `offer` is a
plain call that admits or refuses; a bounded `asyncio.Queue` would have been
the obvious change and would have been exactly wrong, because `await
queue.put` on a full queue IS the backpressure into the source that the bound
exists to prevent. The accounting costs **p50 0.83 us to 1.46 us per chunk for
three viewers**, next to the **9.58 us** the base64 encode of that same chunk
already costs once - so it is real, it is stated, and it is noise at this
scale.

**THE BOUND IS 4 MiB OR 256 CHUNKS, AND THE CHUNK COUNT IS WHAT FIRES.** The
tail loop reads at most 8192 bytes per `os.read`, which base64 inflates to
10,924 characters, so 256 chunks is about 2.8 MiB - inside the byte budget,
which is therefore the BACKSTOP for a future larger read rather than the
operative bound. 4 MiB is the same number `client/js/terminal-write-queue.js`
uses, deliberately: one number in the system beats two separately tuned ones.

**AN OVERFLOW DISCONNECTS; IT NEVER TRUNCATES.** You cannot fix a slow viewer
by dropping bytes. Escape sequences span chunk boundaries, so a terminal handed
half a sequence does not lose one cell - it leaves the VT parser wrong for
everything after it, until something resets. So the only safe response is to
stop that viewer and have it recapture, which the client already knows how to
do: a reconnect re-runs `paint_on_attach`. The close code is **4429**, an
APPLICATION code rather than 1013 so the client can tell "you fell behind"
apart from "the server went away"; it is declared once in `bounded_stream.py`
and the event channel imports the same number. It lands on the reconnect
policy's existing `retry_same_id` branch and spends no retry budget, because
the socket had opened. **STILL OPEN**: that branch shows the reconnect notice
and waits one backoff step, so the recovery is correct but not yet invisible.
Giving 4429 a silent branch means a new branch in `_scheduleRecovery`, and
`client/js/terminal.js` is at 2761 lines against a 2765 guard that must not be
raised for convenience.

**ONE WRITER PER VIEWER IS A CORRECTNESS CLAIM, NOT TIDINESS.** Two coroutines
awaiting `send` on one websocket interleave frames, and the result is a
corrupted stream rather than an exception - nothing in the system reports it.
This endpoint had FOUR concurrent senders (the pty stream, the log stream, the
local-server stream, and the receive loop's own pong and error replies) plus
`ConnectionManager.broadcast_to_session` reaching in from a toast, a rename or
a resize. `_drain_viewer` is now the only thing that touches a live socket;
`_pump_text` takes a stream rather than a websocket so a new message source
cannot add a sender by copying it, the read loop answers a ping THROUGH the
stream, and both broadcast methods `_offer` instead of sending. A socket
registered with no stream is reported UNDELIVERABLE rather than sent to
directly - that fallback is the second writer coming back through the door
this closes. The handshake's own sends (the welcome, the dimension request,
`paint_on_attach`) are sequential in one coroutine ABOVE the `create_task`
block and are pinned there by `tests/test_viewer_fanout.py`.

**AND THE "IS THIS A VIEWER OUTBOX" TEST IS STRUCTURAL, NOT `isinstance`.**
Measured rather than theorised: it shipped as
`isinstance(candidate, BoundedStream)`, which is an identity test against a
class imported BY VALUE, and it answered False inside a full suite run the
moment the process held two class objects for one module name - a stream
built from one binding measured against the other, both reporting
`__module__ == 'src.core.bounded_stream'`. It fails SILENTLY and in the
worst direction: `_close_viewer_stream` stops closing, so every writer task
stays parked in `get()` until its socket dies, and every broadcast reports
its viewer undeliverable. `is_viewer_stream` now asks for the three
attributes the callers actually use, which no `asyncio.Queue` has and which
depend on no module identity.

**TEXT AND BYTES SHARE THE VIEWER'S ONE BUDGET.** A second unbounded lane for
log and toast frames beside the bounded byte lane would leave the bound saying
nothing about the memory actually held, and a viewer that is not reading is
not reading any of it.

**THE PIPE READER WAKES ON THE APPEND NOW, AND THE 20ms IS A BACKSTOP.**
`TmuxBackend._tail_loop` used to `asyncio.sleep(0.02)` on every empty read, which
made that interval a FLOOR ON KEYSTROKE LATENCY - the echo lands at a uniformly
random point in the window, so it was seen about half an interval late on every
keystroke. `src/core/pipe_wakeup.py` registers the pipe fd with kqueue
(`EVFILT_VNODE`, `NOTE_WRITE | NOTE_EXTEND`) and hands the KQUEUE DESCRIPTOR to
asyncio's own selector via `loop.add_reader`, so no thread is spent per session
and no dependency is added. Measured interleaved A/B in one process, so the same
load hit both arms, 100 keystrokes each through a real tmux pane: **p50 26.10 ->
12.31 ms, p90 60.20 -> 28.44, p99 141.32 -> 77.59**, with idle CPU across 11 idle
panes **0.97% against 0.98% of one core** - indistinguishable, which is the only
reason this was kept rather than reverted.

Three things about it are load-bearing. **The backstop is the safety argument**:
an event-driven reader that misses an event does not read late, it STOPS reading,
so every wait is still bounded by the same 20ms and the worst case is exactly the
behaviour it replaces. **The latch is not optional**: the loop reads, gets
nothing, and only THEN waits, so an append landing in that gap was already
notified - `_pending_data` catches it, or the unlucky keystrokes would each cost
a full backstop. And **it is one Future plus one timer, never
`asyncio.wait_for(event.wait(), timeout)`**, which reads better and costs an
extra Task per idle cycle; that version measured idle CPU going the wrong way.
Linux has no `select.kqueue`, so CI runs the plain-sleep fallback, and
`tests/test_pipe_wakeup.py` covers both. Its wake tests hand `wait` a FIVE SECOND
timeout and allow half a second, so a pass cannot have come from the timer.

**A TEST THAT TIMES A SUBPROCESS STARTING IS NOT TIMING WHAT IT CLAIMS.** Those
wake tests flaked once in a full run at load average 14 and passed the same suite
minutes later. The cause was in the test: `Popen` returns when the fork succeeds,
not when `sh` has exec'd `cat` and opened the file, so bytes written before that
sit in a pipe buffer producing no append and no notification. The fixture now
warms up and waits for the file to actually grow before anything is measured. If
you write a latency test against a real process, prove the process is live first.

**The ledger is keyed by the tmux INSTANCE, not by `session_id`, and that is not
interchangeable with `SessionActivityTracker.hooks_seen`.** A confirmed live
restart (`respawn-pane -k`) keeps the session_id AND the epoch and moves only the
pane pid, so `StartupGateLedger` keys on (epoch, pane_pid) and drops the whole
record - first-hook time and toast claim together - when either is MEASURED to
move. A null never resets, or the ledger would reset every poll and re-toast
forever. And every hook kind feeds it, not just `SessionStart`: hooks are
droppable, and a session whose `SessionStart` was lost but whose `PreToolUse`
landed is plainly past its prompt. Feeding it one event kind would rebuild the
one-shot-channel-with-no-retry defect that cost this project sixteen conversation
ids.

Note for anyone touching `src/core/agent_fingerprint.py`: its
`^\s*❯\s*1\.\s*Yes, I trust this folder` pattern CANNOT fire on claude 2.1.263.
The live capture shows no option numbers and the cursor on "No, exit", so the
options read `❯ No, exit` then `  Yes, I trust this folder`. The startup gate
matches the sentence text instead, for exactly that reason.

**`unknown family` on a row whose record says `not_launched` is DATA, not a bug,
AND IT IS NOW FILLED FROM THE PANE'S OWN PROCESS.** The shape is
`agent_type` NULL beside `agent_family_source='not_launched'`: the
`auto_start_claude:false` plus a hand-sent claude command case named under
"Restarting a session" above. Both halves of the record are true - the app
really did open a bare shell and really did start no agent - and neither can
say what the human then typed into the pane. Re-measured 2026-09-08 on the
owner's box: 12 rows carry that shape (it read 27 of 40 earlier; the
population moves, re-measure rather than quoting either), and none of the 19
live panes does, because every live row already carries a wrapper id.

`src/core/session_agent_infer.py` is the ladder,
`session_agent_infer_apply.py` the per-session seam and
`session_agent_infer_sweep.py` the fleet pass. **THE EVIDENCE IS THE PANE'S
PROCESS**: the claude command line in its process tree (one `ps -A`, walked
with `claude_resume_argv`'s existing traversal rather than a second one),
because that is the only thing that can tell `claude-chrome` from
`claude-skip-permissions` - they fire identical hooks, print identical banners
and differ only in their flags. `#{pane_current_command}` CORROBORATES and
never creates: it answers the family when its basename is literally `claude`,
and the claude VERSION STRING that 15 of 19 live panes report there selects no
rung at all.

**A HOOK IS NOT THE TRIGGER, AND ASSUMING IT WAS ALMOST SHIPPED A RUNG THAT
COULD NEVER FIRE.** tmux copies `CLOUDECODE_SESSION_ID` and
`CLOUDECODE_HOOK_TOKEN` into a pane's process AT SPAWN, so a claude a human
typed into an already-running pane has neither and never announces itself.
Measured 2026-09-08: 10 of the hand-started `not_launched` sessions have never
fired a hook and never will - which is exactly the population this feature
exists for. So the read is driven three ways: `sweep_live_sessions` at the END
of the boot re-adopt pass and after an adoption, plus the per-session hook path
for a session that DOES carry the env. A hook remains the STRONGEST evidence
where it exists (it proves a claude is running before anything is read); its
ABSENCE is simply not evidence of absence. The sweep costs TWO subprocesses for
the whole fleet, and only if a row needs them - the row gate runs first, so a
box whose sessions all carry an `agent_type` spends no `ps` at all. There is no
periodic re-sweep yet, which is the known gap.

**THE ANCHOR GATE IS WHY THIS CANNOT ALWAYS FIND SOMETHING.** A wrapper is
named only when the observed argv carries at least one distinguishing flag AND
exactly one configured claude-family wrapper passes that same set - equality,
not subset, or a wrapper passing `--dangerously-skip-permissions` would claim
a pane running that plus `--chrome`. Empty agreeing with empty is the absence
of evidence, not two facts agreeing. Measured against the owner's real five
wrappers: `cld`, `cldl` and `claude-skip-permissions` all reduce to the same
single flag, so 16 of the 19 live panes tie three ways and get the bare family
`claude`, and only the 3 running `--chrome` resolve to a wrapper id.

The value is stored with `agent_family_source='inferred_process'`, a SIXTH
family source that renders as the dashed guess pill, never the solid one. It
is kept apart from `fingerprint` because the two were measured differently: a
process read is the stronger guess, which is why it is the one guess allowed
to name a wrapper, and it is still a guess. Writing it broke the premise
`session_agent_evidence` was built on ("nothing writes an inference into
`agent_type`"), so the row's source now travels with its value through
`identity_for_live_name`, `choose_agent_evidence` and `stored_launch_for` -
read one without the other and a guess paints solid.

**AN INFERENCE IS NOT INTENT, so `session_agent_infer.restart_agent_type`
keeps it out of the respawn ladder entirely.** `session_respawn.py` is
unchanged: `RESPAWN_SHELL` still fires on an empty `#{pane_start_command}`,
which is this whole population, and it fires BEFORE `agent_command` is
consulted - so filling `agent_type` could never have changed that rung anyway.
What it could have changed is an ADOPTED session with a real recorded start
command, silently moving it off `RESPAWN_REPLAY` on a guess, and that is what
`restart_agent_type` refuses. The restart picker's explicit choice remains the
only thing that overrides the gate.

The write happens at most once per pane: the WHERE clause requires
`agent_type` empty and the source not `launched`, which the first success makes
false, and an in-process memo keyed on the tmux INSTANCE keeps a `ps` off the
`PreToolUse` path. Steady state on a healthy box is one indexed SELECT per pane
per server process and no subprocess at all.

## How we work here

- **Every function documented**: one-line description, typed inputs, typed
  output, and an example when the usage is not obvious. Types belong in the
  Python signature, not only in the docstring.
- **A pure forwarder is exempt from the full docstring rule.** A member whose
  entire body is `return self._collaborator.method(...)` has no behaviour of
  its own to document. Restating the collaborator's contract creates a SECOND
  copy of it that can go stale, and a confidently wrong doc sends the next
  agent to write a bug. Such a member carries one line naming its replacement
  and its delete date, and nothing else. The exemption applies ONLY to a member
  marked deprecated with a delete date, so it cannot be stretched to cover a
  thin method that does anything at all: one argument reshaped, one default
  filled in, one error translated, and the full rule applies again. Types still
  belong in the signature, on the forwarder as on everything else. The
  measurement behind this: the first five decomposition slices left 23 pure
  forwarders costing 291 lines, an average of 12.7 lines to forward one call,
  which is why two of those three slices GREW the file they were shrinking.
- **DRY, single source of truth, named constants.** No magic strings. A literal
  like the hook marker or the socket name lives in exactly one module and gets
  imported.
- **New logic goes in new focused modules.** These files are already past the
  500-line guideline and should not grow: `client/js/terminal.js`,
  `client/js/app.js`, `client/css/styles.css`,
  `src/api/routes.py`, `src/core/session_manager.py`. Edit them when the change
  belongs there; do not use them as the default landing spot.
- **`src/config/` is a package**, not a module: one typed block of `config.json`
  per file, `settings.py` holding only the env-backed fields and the two caches,
  and the behaviour in named siblings (`auth_loader`, `state_paths`,
  `agent_command`, `config_file`, `config_writes`, `summary`, `wrappers`,
  `provider_models`). `__init__.py` re-exports every public name the flat module
  had, so `from src.config import settings` is unchanged.
  **`settings.py` IS OVER THE 500-LINE GUIDELINE AT 632 AND THE OWNER HAS RULED
  THAT IT STAYS THERE.** His words, 2026-09-10, on being shown the one open
  question S5 left: "Leave it it's ok". This is a RULING, recorded in
  `docs/DECISIONS.md` under "`src/config/settings.py` stays over 500 lines", and
  it binds both sides: do not "fix" this file to hit a line count. The class
  keeps 31 public names because 111 modules import from this package and the
  suite patches those members on the CLASS (23 sites patch `state_dir_override`,
  eight patch `type(sm.settings).get_state_dir`); a name that stopped resolving
  there would be invisible to every one of them. The bodies are all gone - what
  remains is 109 lines of pre-existing field declarations and 31 typed entry
  points averaging 13 lines. Getting under 500 needs the entry points DELETED
  and their ~45 callers migrated, which is Rule B applied to `Settings`. That is
  its own slice, it is filed as a FUTURE OPTIONAL slice in
  `.claude/notes/backend-decomposition-plan.md` and in `.claude/TODO.md`, and it
  is NOT SCHEDULED.
- **`src/core/sessions/` holds the collaborators `SessionManager` composes**, one
  mutable state cluster each, per
  `.claude/notes/backend-decomposition-plan.md`. THE STATE MOVES, IT NEVER
  COPIES: a collaborator holds the one and only copy of its cluster and the
  facade keeps none, because two objects holding one logical state and kept in
  sync by hand is the shape of the bug that produced 22 `/sessions/list` rows
  for 21 live panes. `SessionManager()` still takes NO required arguments (104
  test files construct it bare); a collaborator is an optional KEYWORD-ONLY
  argument with a default-constructed value, so injection is available to a new
  test and invisible to every old one. Two rules hold for every module in the
  package and both are enforced by `tests/test_sessions_package_rules.py`
  rather than remembered: nothing in there may import `session_manager`, and no
  file exceeds 500 lines. `ProbeHealthRecorder` (slice S1) is the worked
  example, and `ProbeHealth` is DEFINED there and re-exported from
  `session_manager` so every existing import keeps resolving. `ThemeStore`
  (S2, with `theme_accents` and `theme_dotfile` beside it) is the worked
  example for a cluster of DICTS, and it carries two rules the scalar one
  could not teach. **A moved attribute that anything REBINDS needs a
  property SETTER that writes through to the collaborator**: several tests
  assign `mgr.pinned_themes = {...}` wholesale, and a read-only property
  raises while a plain instance attribute silently shadows the property and
  forks the two objects while every value assertion still passes. **And a
  collaborator that does file I/O takes its path as a zero-argument
  CALLABLE, not a `settings` import.** Every theme test redirects state with
  `monkeypatch.setattr("src.core.session_manager.settings", stub)`, which
  patches the name in THAT module; a collaborator importing `settings`
  itself does not see it and reads and WRITES the developer's real
  `~/.cloude-sessions` during a pytest run. Resolving the path at call time
  is also exactly what the loose methods did. `ToastInbox` (S3) adds the
  third shape: **a moved container reached by a DEFENSIVE ACCESSOR in
  another module needs its own proof leg.**
  `src/core/toast_history.py` reads `getattr(manager, "_pending_toasts",
  None)` and answers `{}` for anything that is not a Mapping, deliberately
  and documented as such - so a facade that stopped exposing that name
  would show an EMPTY toast history on every surface while raising nowhere
  and failing no existing test. Whenever a slice moves a field, grep for a
  `getattr` on its name before trusting a green suite; that shape is what
  CLAUDE.md calls the characteristic failure of this refactor, and it has
  now appeared in two of the first three slices. `SessionRegistry` (S4,
  the log buffers and command counters, half the registry cluster with S7
  bringing the rest) settles the SETTER POSTURE as evidence rather than
  taste: **a write-through setter exists where a whole-map rebind is
  MEASURED in the tree, and the property is read-only everywhere else**,
  so a future assignment fails loudly instead of shadowing the property.
  It also generalises S2's callable rule from paths to VALUES - the line
  cap arrives as `lambda: settings.log_buffer_size`, because four test
  modules install a stub `settings` on `session_manager` carrying their
  own `log_buffer_size` and a collaborator that imported `settings` would
  read the real one. And it names the case where the existing suite can
  prove NOTHING: this cluster has zero readers outside `session_manager`
  and had zero tests of its own, so no pre-existing test could redden for
  any defect in the move and the structural legs carry the whole proof.
  Measured on the aliasing mutation, where `__init__` holds the
  collaborator's own dict as a plain attribute: leg (a), the `is` check,
  stays GREEN and only leg (b) fails. `AttachmentSidecars` (S5, the idle
  watchers, the adopt FIFO offsets and the pending terminal commands)
  QUALIFIES the getattr rule above rather than repeating it. **A
  defensive-accessor leg catches a REMOVED property, and it catches a
  COPYING one only if it asserts identity on the container itself.**
  `toast_history`'s leg does (`is` on the dict) and the websocket's
  `getattr(sm, "idle_watchers", {}).get(session_id)` does not - measured
  on the copying mutation, that leg passed while identity, cross-writes,
  the rebind and injection all failed. And **a test that constructs the
  manager with `SessionManager.__new__` bypasses `__init__`, so every
  property a slice adds is unreachable there**: it has to install the
  collaborator by hand the way it already installs `backends`. One file
  does that today, `tests/test_terminal_commands.py`, and it was
  repointed in the same commit. S5 also carries the one-shot rule for
  the two sidecars that are consumed exactly once - `take_fifo_offset`
  and `take_pending_command` POP, `peek_fifo_offset` does not, because
  `adopt_fifo_start_offset` is a property and a getter that consumed
  would let an unrelated read destroy the replay position of a session
  nobody had attached to yet.
- **No bare `except:` and no blanket `except Exception:`** that swallows. Catch
  the specific error, log it with structlog context, or re-raise. If you
  deliberately swallow, a comment says why (see the History-API guard in
  `client/js/router.js` for the shape).
- **Production ready.** No mocks, no placeholders, no test endpoints left behind.
- **`python3`, never `python`.** Tests: `venv/bin/python3 -m pytest -q` from the
  repo root. System python3 has no fastapi. Current baseline, re-measured
  2026-09-10 on `docs/6-meta-cluster` off `51f3489` with `-p no:randomly`,
  is **5758 passed / 0 failed / 18 skipped**, and ZERO FAILED IS THE NEW
  NUMBER TO HOLD: the two this file used to call permanently environmental
  were diagnosed and fixed on that branch (see below), so a failure here is
  now a real signal rather than one you are meant to recognise and ignore.
  The reading before it was
  **5656 passed / 2 failed / 19 skipped** on `release/1.2.1`. The same worktree read
  **5641 / 2 / 19** at the bare merge of `adamdev/master` 2b1fcb9 and
  **5628 / 2 / 19** at `release/1.2`, so his commits added 13 tests and
  this round added 15, with no new failures at either step. Note the SKIP COUNT MOVES BY ONE between
  runs (21 or 22) purely on `pytest-randomly`'s ordering, so a lone
  22 is not a test that stopped being measured; the skip REASONS are what
  to read, and `-p no:randomly` pins it at 21. Two failures this file used to name as
  permanently environmental are FIXED as of 2026-09-10, by diagnosis rather
  than by a skip, and the precondition behind each is written down because
  nobody had ever recorded it:
  `test_version_probe.py::test_current_version_empty_when_unresolvable`
  asserts a directory with no version source resolves to `""`, and
  `CLOUDE_APP_VERSION` is rung 1 of `resolve_version` and IGNORES the
  directory entirely. It is exported in the developer's own shell, so the
  test failed locally with `assert '0.8.1' == ''` and passed in CI, where
  nothing exports it. It now clears the variable for that one test, and a
  new test asserts the override outranks the directory so the rung has
  coverage instead of being a trap.
  `test_nuke_sandbox.py::test_dry_run_deletes_nothing` asserts a `--dry-run`
  leaves the sandbox manifest bit-identical; `nuke.sh` falls through to the
  `python3` on PATH, and when THAT interpreter lives inside a read-only
  bundle CPython redirects bytecode caching to
  `$HOME/Library/Caches/com.apple.python/...`, where HOME is the sandbox. The
  dry run deleted nothing and still grew the manifest by 49 directories. On
  this box `/usr/bin/python3` is the Xcode-bundled Python 3.9, which is
  exactly that case; CI uses `actions/setup-python`, which writes
  `__pycache__` beside the source. The fixture sets
  `PYTHONDONTWRITEBYTECODE=1`, suppressing only `.pyc` writing, so anything
  `nuke.sh` itself creates in HOME is still measured.
  `test_home_write_guard.py::test_guard_refuses_the_real_claude_settings_path_by_name`
  and
  `test_state_dir_resolution.py::test_get_state_dir_default_is_never_under_the_system_temp_dir`,
  which this file also used to name, both PASS. Neither was fixed on
  purpose, so treat them as environmental in both directions rather than as
  a guarantee.
  A CHECKOUT WITH NO `config.json` MANUFACTURES A FAKE FAILURE SET, and it
  is a big one: 19 failed plus 26 errored in a fresh `git worktree`, every
  one of them an app that could not start (401s from the test client,
  FileNotFoundError from the route tests), and every one of them clearing
  the moment the file is put back. `config.json` is gitignored, so a new
  worktree never has it. Copy one in before you measure anything, and do
  not attribute a failure to a code change until you have reproduced the
  same run on the base commit in the same directory.
  TAKE YOUR OWN BASELINE ON A CLEAN TREE BEFORE YOU JUDGE YOUR OWN RUN -
  this figure has been stale twice, and the population of environmental
  failures moves.
  Your job is to add no NEW ones. Watch for a broken environment
  manufacturing a fake baseline: a `venv` symlink pointing at a
  `venv.nosync` directory that no longer exists lets the suite limp
  along and undercount silently, rather than failing outright. If the
  numbers you see look nothing like these, check the symlink and rebuild
  the venv from `requirements.txt` before trusting the count. **That is not
  hypothetical: it happened.** The baseline this file carried before
  2026-09-08 read 4647 passed / 13 skipped and was stale by an order of
  magnitude for exactly that reason. **One test in this suite is measured
  FLAKY under a full run** (`test_respawn_refreshes_pane_env.py::test_the_session_environment_itself_is_updated`
  failed once alongside 3 passes in isolation, both runs on the same tree
  minutes apart) - it drives the real `cloude` tmux socket, which is the
  same class of flakiness INFRA-49 already names. A lone failure there
  without a code change behind it is not a new regression; re-run before
  chasing it. **THAT GROUP HAS A NAME NOW: the `real_tmux` marker**, 115 of
  the 5776 collected tests, so `-m "not real_tmux"` gives a fast local loop
  and `-m real_tmux` runs the contended group on its own, more than once,
  because one pass proves nothing about a flake. It is applied
  AUTOMATICALLY by `tests/conftest.py`, derived from the module importing
  `tests/socket_guard.py` or the test requesting the `tmux_test_socket`
  fixture, never hand-written on a test - a hand-kept list is wrong the
  first time somebody adds a test without knowing the list exists. It
  deliberately OVER-includes: marking a fast test costs a little coverage
  in a loop that was never a full verification anyway, while missing a
  real-tmux test puts a load-sensitive flake back into the fast loop. It
  adds no skip, changes no timeout and touches no assertion, so a plain
  `pytest` run collects and runs exactly what it did before, and
  `-m "not real_tmux"` IS NOT A VERIFICATION RUN. No timeout was raised to
  fix a flake: a timeout long enough never to flake is also long enough to
  hide a real hang. See `docs/ci.md`. Node: **197 tracked suites, all 197 passing** (re-counted
  2026-09-09 at the 1.2 merge; v1.1 alone had 193, of which 2 failed).
  `test_archive_full_page_mode.node.mjs`, the one long-standing node
  failure this file used to name, is FIXED and now passes. Re-measured
  2026-09-10 on the navigation-token branch: **206 tracked suites, all
  206 passing**, against 202 on its base commit in the same worktree -
  four added, no new failures. Note `test_terminal_layout.node.mjs`
  flaked ONCE in that base run and passed in isolation seconds later on
  the same tree, so a lone failure there without a code change is not a
  regression; re-run before chasing it. The piped-stdin CLI helper for
  the real-hook harness lives at `tests/helpers/led_state_for.mjs`, outside
  the `tests/*.node.mjs` glob the CI loop runs, because it is not a suite and
  exits non-zero when run with no input - which is what it used to be
  reported as, from `tests/led_state_for.node.mjs`, before the move.
- **CI IS SWITCHED OFF, ON PURPOSE, AND YOUR LOCAL RUN IS THE ONLY EVIDENCE
  THERE IS.** The owner's ruling, 2026-09-10, verbatim: "P25 - kill the CI".
  Three workflows on `Adoom666/CloudeCodeDev` are `disabled_manually` -
  `tests`, `secret scan` and `release`. `Claude Code Review` and `Claude Code`
  are still active, because they are the review bot rather than CI.
  **NO TEST WAS FAILING AND NO TEST WAS REMOVED.** Every run from
  2026-09-10T13:47Z was refused BEFORE STARTING with "recent account payments
  have failed or your spending limit needs to be increased": twelve
  consecutive red runs, two workflows, four jobs each, none of which ever
  executed, which is why `gh run view --log-failed` answers `log not found`.
  **A check that could not run is not a check that failed**, the same
  distinction as `StatusMap.complete`, the recreate gate's `gone` versus
  `unknown`, and `db_integrity`'s `cannot_determine` versus `failed`. GitHub
  renders both as a red X and emails both, so a human has to draw it.
  The consequence, said plainly: `2b1fcb98` is the last commit CI ever tested,
  everything after it including the v1.2.1 merge has never been through it,
  and **nothing you write today will be checked by anything but you.** Run the
  python suite and the node suites yourself, and say in the PR which ones you
  actually ran. The workflow FILES are untouched, so reversing this is
  `gh workflow enable <name> -R Adoom666/CloudeCodeDev` per workflow once the
  billing is settled. Do not delete, `continue-on-error` or otherwise green a
  workflow to quiet the board; that replaces a true "unknown" with a false
  "passed". Details and the re-enable commands are in `docs/ci.md`.
- **`CLOUDE_REAL_HOOK_TESTS=1` opts in to `tests/test_led_real_hooks.py`**, which
  launches a REAL `claude` in a throwaway tmux socket and asserts the status LED
  against hooks it actually fired. It is off by default because it spends real
  Claude turns and about 50 seconds; without the variable (or without tmux /
  claude / node) every test in it skips with a reason naming what went
  unmeasured.
- **`node --check`** every JS file you touch, before you claim it works.
- **Stage files by name** when committing. No `git add -A`.
- **Voice**: no em-dashes, no en-dashes, no emojis, anywhere, including commit
  messages. UI copy is lowercase and plain.
- **Push only to `origin` (ccsliinc/CloudeCode) or `adamdev` (Adoom666/CloudeCodeDev). NEVER to `upstream` (Adoom666/CloudeCode).** Owner's rule, 2026-09-08. The `upstream` push URL is set to `DISABLED_do_not_push_to_Adoom666_CloudeCode` on the owner's clone so a push there fails by construction; re-apply that with `git remote set-url --push upstream DISABLED...` on any fresh clone.

## Restarting a session, and picking what it comes back as

`POST /sessions/respawn` revives a pane whose PROCESS exited. It can ALSO
replace a running one, but only when the request says so:
`resolve_respawn_plan` answers `RESPAWN_NOT_DEAD` for a live pane unless
`live_restart_confirmed=True`, and tmux itself refuses `respawn-pane`
without `-k`. See "Replacing what is running" below.

**The ladder gates on tmux's `#{pane_start_command}`, and the empty case is
the trap.** Empty means the pane was born a bare shell, so a restart lands on
`RESPAWN_SHELL` and hands back a LOGIN SHELL rather than the agent - silently,
for a real subset of the sessions on a working box, because
`sessions.agent_type` lands NULL for every session created with
`auto_start_claude:false` plus a hand-sent claude command.

| Piece | File |
|---|---|
| The ladder, the projection, and pane liveness | `src/core/session_respawn.py` |
| Which conversation it comes back on | `src/core/session_resume_target.py` |
| Shape the preview the picker reads | `src/core/session_restart_preview.py` |
| Validate an `agent_type` choice, and persist it | `src/core/session_agent_choice.py` |
| `GET /sessions/restart/preview` | `src/api/restart_routes.py` |
| The panel, and the reopen afterwards | `client/js/session-restart-picker.js`, `client/js/session-restart-return.js` |
| The option list, extracted so the picker stays under 500 lines | `client/js/session-restart-options.js` |
| Keep the row keyed on its instance after a kill | `src/core/session_instance_rekey.py` |
| The arm control and the kill confirmation | `client/js/session-restart-live.js` |
| What the user is told about the conversation | `client/js/session-restart-continuity.js` |
| Recreate a session whose tmux is GONE | `src/core/session_recreate.py` |
| Is the tmux session still on the socket | `src/core/session_recreate_presence.py` |
| `GET /sessions/recreate/preview`, `POST /sessions/recreate` | `src/api/recreate_routes.py` |

**A SESSION WHOSE TMUX IS GONE HAS NO PANE TO RESPAWN INTO, AND THAT WAS A
DEAD END UNTIL 2026-09-08.** The respawn ladder reads a PANE, so a row whose
tmux SESSION was killed outright - the server restarted, the machine rebooted,
the name is simply absent from `tmux -L cloude list-sessions` - answers
`cannot_determine`. Honest, and the only way back was a fresh session built by
hand, which loses the row and with it the project binding, the title, the pinned
theme, the unread key and the group filing. `src/core/session_recreate.py`
closes it as punchlist item 22's remaining half: a new tmux session, in the
conversation's own directory, under the wrapper the user picked, with
`--resume <uuid>`, recorded onto the EXISTING row through
`create_session(reuse_session_id=...)`. It decides only the one fact it owns -
presence - and calls `plan_imported_restart` for the transcript guard, the
directory spelling, the wrapper and the three conversation words, so the two
create-a-session paths cannot drift.

**THE GATE IS A MEASURED ABSENCE, AND `is_alive()` CANNOT PROVIDE ONE.** It
runs `has-session` and returns a bool, so "no such session" and "tmux is
missing, timed out, or errored" are the same False; recreating on that would
spawn a second tmux beside a healthy one and rebind the row onto the newcomer,
leaving the pane the user is talking to alive and unreferenced. So the
measurement is a LISTING (`discover_existing()`, whose `ok` and `complete`
already carry the discipline) and `session_recreate_presence.tmux_presence`
keeps three outcomes apart: `gone` only when a COMPLETE listing ran and the
name is not in it, `present` reported as the ladder's own `not_dead`, and
`unknown` for a listing that did not run, one that ran with rows the parser
refused, or a name outside the `cloude_` namespace the listing does not cover.
Only `gone` may act. `tests/test_recreate_gate_real_tmux.py` measures the
transition against a real throwaway socket, because a double agrees with
whatever it was built to agree with.

**ADDRESSED BY `session_uuid`, NOT BY THE TMUX NAME, and that was caught rather
than designed.** The first draft resolved the row by name plus greatest epoch;
`tests/test_no_name_keyed_session_identity.py` failed it, correctly - a name is
reusable and this app re-mints them, so "the newest row with this name" is a
recency guess, and a wrong answer rebinds a DIFFERENT session's row. The routes
now take the durable key and read the tmux name OFF the row. The client bridges
its own gap the same way: the sidebar addresses rows by name, so
`SessionRestartOptions.recreateTarget` returns a uuid only when EXACTLY ONE
record carries that name and null otherwise. A refusal costs the user the offer,
which is what they had before the feature existed; a guess would cost them a
session.

**THE ROW IS RE-KEYED, NOT REPLACED.** The new tmux session is a new instance,
so `session_restart.rebind_instance` moves the triple while holding
`sessions.id` fixed. Group filing rides along because `session_group_membership`
has keyed on `session_uuid` since v24 - the v8 table it replaced keyed on
`tmux_name`, which is the landmine an earlier design of this feature would have
walked into. The SAME tmux name is asked for so name-scoped per-device browser
state survives, and it is free by construction because the gate only passes on a
measured absence; the create path still uniquifies on collision, so the name
actually taken is REPORTED rather than assumed.

**A PREDICTION IS NEVER A PERMISSION, and that is why the preview reports the
rung twice.** `resolve_respawn_plan` short-circuits on `not_dead` BEFORE it
reads the start command, so on its own it can only tell you a running session
is running - not what it would come back AS, which is the only interesting
question about the idle-but-alive sessions a user actually wants to restart.
So the tail of the ladder is factored into `_rung_from_start_command` and
reached two ways: `resolve_respawn_plan` through the probe gate AND the
liveness gate, `project_restart_rung` through the probe gate only. There is
still ONE ladder. `unchanged` is what a restart does now, `projected` is what
it would come back as, `pane_state` (`dead` / `alive` / `unknown`) is liveness
on its own. A UI badge may read `projected`; only `unchanged` / `actionable_now`
may enable a button. Wire the badge to the button and every live session
becomes restartable.

**`agent_type` on the respawn request is an ID, never a command.** It is
validated against `agents.wrappers` and an unconfigured id is a 400.
`Settings.get_agent_command` deliberately falls back to the default wrapper for
an unknown type, which is right for a launch and wrong for a picker - a user
who asks for `claude-chrome` and silently gets `claude-skip-permissions` has
been lied to. Validate through `session_agent_choice.validate_agent_choice`
first; never call `get_agent_command` with a user-supplied id directly.

**An explicit choice outranks the `pane_start_command` gate; nothing else
does.** The gate exists because a STORED `agent_type` is not evidence of
intent. A wrapper picked in this request, after the user was shown what it
would do, is different evidence. It does NOT outrank `not_dead` or a probe that
did not answer. The verdict stays `RESPAWN_AGENT`; `RespawnPlan.chosen` and a
different sentence carry the distinction rather than a sixth kind.

**A RESTART MEANS A RESUME, ON EVERY RUNG THAT CAN.** The owner's
definition, 2026-09-07, verbatim: "restart on recent is really just
resume. restart on open is close and resume session so it loads a new
wrapper or new claude binary." ONE semantic, two mechanics: a dead row has
no process to kill so its restart IS a resume, and a live row has its pane
killed first, the kill existing only so the pane picks up a new wrapper or
a new claude binary. Both come back on the SAME conversation.

`f95a9ed` made that true only on the REPLAY rung, by accident of what tmux
had written down. The AGENT rung re-derives its command through
`Settings.get_agent_command`, which carries no `--resume`, so a restart
there started a FRESH conversation wearing the old session's name.
`sessions.claude_session_uuid` now reaches that command as
`extra_args=['--resume', <uuid>]`, built once by
`session_resume_target.resume_extra_args` and passed to all FOUR command
resolutions in a restart request - the stored agent's and every wrapper
offer's, on the action side and on the preview side. Building it in one
place is what makes the preview's predicted command and the action's
actual command the same string by construction. NEVER concatenate the flag
onto a resolved command: `get_agent_command` returns
`zsh -c 'source ~/.zshrc ...; cld'` and an appended argument lands outside
that quoting, handed to zsh instead of to claude.

**The resume drops claude's own `--name`, and that is a known gap, not a
bug fix waiting to be noticed.** `resume_extra_args` carries `--resume
<uuid>` only, so a restarted session comes back without whatever name
claude itself had been given (`--name`, `/rename`). The app's own row title
survives regardless, because it lives in `sessions.title`, not in claude's
argv. Open item: reuse `claude_title_sync`'s read of the transcript's last
`custom-title` to reapply the name on a resume the same way it already
detects one.

**A MISSING uuid IS A NAMED OUTCOME, NOT A SILENT FRESH START.**
`RespawnPlan.conversation` and the preview's `conversation` field carry
`resumed` / `none_recorded` / `unknown`, the SAME three words
`RestartSessionResponse.conversation` has used since the restart route
shipped, reused rather than re-invented. `none_recorded` means the row was
READ and holds no conversation, so the session comes back WITHOUT its
history - a legitimate restart, said out loud rather than performed
quietly. `unknown` means the row could not be read: no `--resume` is
injected and nothing claims a resume, because an unknown is never a yes.
The value is DERIVED FROM THE ARGV - a command carrying a `--resume` reads
`resumed` whatever the caller believed - so the claim can never outrun the
command. The rung sentence the picker renders verbatim carries the clause,
and `SessionRestartLive.liveConfirmCopy` names it before anything dies.

Note the asymmetry, it is deliberate: an unreadable ROW degrades the claim
and never refuses, while a MEASURED missing TRANSCRIPT refuses outright.
Not having looked is not evidence of absence; having looked and found
nothing is.

**A REPLAY CAN RESUME A CONVERSATION, and that is guarded.** `RESPAWN_REPLAY`
hands tmux back its own `#{pane_start_command}`, and measured on the owner's
box 2026-09-07, 3 of 19 live sessions carry an explicit `--resume <uuid>` in
theirs. So a replay can re-run a resume, and a resume against a deleted
transcript exits instantly, leaving a dead pane the row still calls running -
the incident this project already paid for. `resume_uuid_in` extracts the uuid,
`refuse_if_transcript_missing` turns a DEFINITE absence into
`RESPAWN_TRANSCRIPT_MISSING`, and the filesystem lookup lives in
`src/core/session_transcript_presence.py` so the ladder stays pure. THE
GUARD COVERS THE AGENT RUNG TOO now that it resumes, on the dead path as
well as the live one: the check in `TmuxBackend.respawn` keys on
`plan.resume_uuid` and is not gated on liveness. TWO CONVERSATIONS CAN BE
IN PLAY AT ONCE - the replay rung resumes what tmux recorded, the agent
rung resumes what the ROW says - so the preview passes presence verdicts
as `presence_by_uuid`, keyed by the uuid each was measured for. One
verdict applied to both would refuse a restart nobody measured.
`unchecked` NEVER refuses - not having been able to look is not evidence a file is gone, and
refusing on it would break restart on every machine whose corpus lives somewhere
the checker was not told about. The PREVIEW applies the same guard; a preview
that skipped it would promise a replay the restart then declines.

**Replacing what is running: `respawn-pane -k`, and the four gates in
front of it.** The owner's two calls (2026-09-07) were "same tmux should
be fine" and "yes resume the same session", so this is not
close-and-recreate. It kills the pane's process and respawns it in the
same pane, same tmux name, same row - and because no row is minted,
project attribution, pinned theme, unread state, group filing and
sidebar position all stay put without anything re-carrying them. It also
sidesteps rather than fixes the `session_group_members` primary-key
defect, which keys on `tmux_name`.

It is DESTRUCTIVE and irreversible, so it is gated four times and no
gate is derivable from a prediction. **ALL FOUR GATES ARE IN FORCE AND
THE CONTROL IS REACHABLE**, which is the owner's 2026-09-09 call: the
row's kebab menu stays and restart stays on it. One line of this project
folded the row's controls back to inline pin and close and removed
restart with the menu; that was not taken. See "The row's controls" under
the status lights.

1. `actionsFor` offers restart on a row whose status we POSITIVELY know
   is live. `unknown` still gets close alone.
2. The picker's arm checkbox (`SessionRestartLive.armHtml`, always
   emitted unchecked, takes no argument) is what unlocks the choices. `optionsHtml` derives
   `disabled` from `actionable_now` ALONE, so a live pane paints every
   radio locked whatever it projects.
3. `App.showConfirmModal` with `SessionRestartLive.liveConfirmCopy`,
   which names the
   bare-shell outcome AND what happens to the conversation. Measured
   2026-09-08: 18 of 22 live sessions have an empty `pane_start_command`,
   so an UNPICKED restart comes back a login shell for 82 percent of them
   (it read 15 of 19 on 2026-09-07; the population moves, re-measure
   rather than quoting either). That warning is what makes this safe to
   ship. Note the whole sentence: an explicit wrapper choice OVERRIDES
   the gate (`session_respawn.py:542`), so only an unpicked restart lands
   on the shell rung.
4. `confirm_restart_live` on the request. `RespawnPlan.kills_live_pane`
   is the ONLY thing that makes anything pass `-k`, and it is set only
   when the pane was measured alive AND the caller confirmed AND the
   rung is actionable. `project_restart_rung` has no liveness input, so
   a projection cannot set it. `refuse_if_transcript_missing` BUILDS its
   refusal rather than copying, so a missing transcript cannot kill.

`activity_status` informs all of this and refuses none of it - it reads
`working` for about four minutes after a resume.

**Identity is MEASURED across the kill, not assumed.** `#{session_created}`
belongs to the SESSION and `-k` replaces the pane's PROCESS, so on tmux
3.7c the instance triple does not move (measured 2026-09-07: same epoch,
same `pane_id`, new `pane_pid`). Fourteen queries in `src/core` key on
that triple exactly and all read the same column, so they break or hold
together. `TmuxBackend.respawn` therefore reads the epoch either side and
`session_instance_rekey.reconcile_instance_epoch` answers `unchanged` /
`rekeyed` / `cannot_determine`, re-keying the row on the OLD triple if it
ever does move. `cannot_determine` is not `unchanged`; a reading that did
not answer is not evidence nothing moved.

**Respawn writes exactly one column, and only when asked.** On a restart
verified alive with a picked wrapper, `sessions.agent_type` is updated on the
row keyed by the instance triple. Nothing else - a respawn is still not a fork
and never touches a lineage column. With no `agent_type` it issues no write at
all. A restart that FAILED records nothing, and `agent_type_persisted` says so
rather than letting a stuck choice look saved.

## The conversation id, and how a row loses it

`sessions.claude_session_uuid` is the id a restart resumes: the row's copy of a
transcript uuid. Do not conflate it with the instance triple, a pin id or a
project name. Everything in this section was traced to file and line on 2026-09-08 and
shipped in `8dd54a8`. **Note that `8dd54a8` is committed but not deployed at
the time of writing**, so a live install may still be showing the old
behaviour.

| Piece | File |
|---|---|
| Second chance at correlation when the hook writes nothing | `src/core/session_lineage_recovery.py` |
| How Claude Code actually slugifies a working directory | `src/core/claude_project_dirs.py` |
| The correlation ladder itself | `src/core/claude_transcript_correlate.py` |
| Propose a uuid for a row that lacks one | `src/core/session_uuid_backfill.py` |
| What counts as evidence, and what only corroborates | `src/core/session_uuid_backfill_rules.py` |
| Render the proposal for a human | `src/core/session_uuid_backfill_report.py` |
| The operator entry point, DRY RUN BY DEFAULT | `scripts/backfill_claude_session_uuid.py` |

**A ONE-SHOT CHANNEL WITH NO RETRY IS THE WHOLE PROBLEM.** On the create path
the uuid had exactly ONE writer, Claude Code's `SessionStart` hook. An empty
POST body becomes `{}` at `routes.py:2108`, `session_manager.py:4341` returns
`LINEAGE_UNRESOLVED`, and nothing is written. The live log holds 25 such
failures across 20 distinct sessions, and 16 of 39 rows carried no uuid at all.
Contrast the other hook events, which repeat: that is precisely why
`last_work_at` self-heals on the next event and the uuid never did. If you add
a field fed by a hook, ask which of the two kinds of event feeds it, and give
the one-shot kind a recovery path rather than a log line.

**A FALLBACK THAT CANNOT FIRE IS NOT A FALLBACK, AND IT IS INVISIBLE.**
`slugify_project_dir` mapped only `/` and `.`. The real rule replaces
EVERYTHING outside `[A-Za-z0-9-]` with a single `-`, verified against 908 of
919 live transcripts. Every path on the developer's machine contains a space
and two tildes, so every slug the ladder built was wrong and the fallback had
NEVER ONCE SUCCEEDED there. It looked exactly like a fallback that was never
needed. A ladder rung that has never been observed to fire is unmeasured, not
proven.

**A RECORDED uuid IS NOT EVIDENCE A TRANSCRIPT EXISTS.** Rows fall into three
groups, not two: over 39 rows, 16 absent, 18 sound, and 5 PHANTOM, holding a
uuid with no file behind it. All 5 phantoms collide with a sibling row, because
the correct uuid is already held by the twin that the cwd spelling trap split
off. The mechanism is `--fork-session`: it MINTS A NEW uuid, `SessionStart`
records the new one, and the forked transcript may never materialise. So the
picker can say "no transcript for <uuid>" perfectly truthfully about a uuid
that has nothing to do with the conversation the user is in, while the real
73 MB transcript sits on the archived twin. A message can be locally correct
and lead every reader to the wrong conclusion.

**Both cwd spellings must be resolved in BOTH directions.** Forward, by
slugifying every spelling found in a HOME symlink scan; and backward, from each
transcript's own recorded cwd, canonicalised. Backward is not optional: 754 of
919 transcripts sit in a directory that disagrees with their own recorded cwd.

**Evidence is counted in independent FAMILIES, and weak signals corroborate
rather than create.** Two matcher defects were caught by CONTROLS, not by
reading the code, and both would have shipped looking right. Directory
agreement was clearing a two-signal bar as one fact corroborating itself. And
the negative control, a row pointed at a project that does not exist while real
transcripts are present, returned `ambiguous` instead of `no_candidate` because
timing alone counted as evidence; an anchor gate now lets timing and title
corroborate a candidate and never create one. **A matcher that always finds
something is worse than useless**, so a negative control is mandatory for
anything in this family.

**`agent_type` is a SEPARATE failure, do not fold them together.** A crosstab
over all 39 rows finds 14 with `agent_type` NULL and a hook-written uuid. The
two are independent, and the `agent_type` persistence gap is still its own open
item.

## Naming a session, and the one name rule

ONE NAME PER SESSION, LAST RENAME WINS FROM EITHER SIDE. It lives in three places
- `sessions.title` (the browser), claude's own name (`--name`, `/rename`) and the
jsonl's `custom-title` record, where the two writers MEET. See
`src/core/claude_title_sync.py` (tail reader + rules), `claude_title_sync_apply.py`
(the seam, run from the hook route on every event), `claude_rename.py` (push out).
**NO HOOK EVENT CARRIES A `/rename`** - claude intercepts slash commands before
they become prompts - so the pane's name is only readable by READING THE
TRANSCRIPT. Last 64 KB only, 0.274 ms median against a 244 MB file, because this
runs on `PreToolUse`; an older rename reads `no_record` and changes nothing.
`sessions.claude_title` stops being dead weight and becomes the marker that makes
the sync idempotent under duplicated events.
**FIRST SIGHT OF A TITLE IS A BASELINE, NOT AN INSTRUCTION**: `custom-title` has
no timestamp, so it cannot be ordered against the label already on the row.
**A BOUND uuid IS NOT EVIDENCE A TRANSCRIPT EXISTS** and the push paid for it -
14:47:41Z 2026-09-08, a rename logged `claude_rename_pushed` and delivered
nothing because the file appeared 2m33s later, `--resume` exited 1, stderr went to
DEVNULL. `decide_push` now defers on a MEASURED absence only (`unchecked` still
sends) and `spawn_oob_rename` reaps and logs. STILL OPEN: a deferred push is
never retried; `title != claude_title` is the marker a retry would key on.
**The plain create endpoint was the one creator passing no label**, so only
launchpad sessions launched claude with no `--name`; `CreateSessionRequest.label`
closes it, and an absent label leaves the command line byte-identical.

## Where a new project's folder comes from

A project's directory is `sessions.working_dir`, and it is permanent: the
row carries it, the launcher lists it, and the archive derives a
transcript directory from it. So the create path is the one place that can
poison every downstream reader, and until 2026-09-08 it did.

| Piece | File |
|---|---|
| Compose, validate and create the directory | `src/core/project_directory.py` |
| The folder step, and the pure rules behind it | `client/js/project-create-folder.js` |
| Where it is wired in | `src/api/routes.py` (`create_session`), `web/src/lib/launchpad/create-flow.ts` (slice 6 moved it out of `launchpad.js::_createNewSessionInner`) |

**"START EMPTY" HAD NO FOLDER STEP AT ALL.** The chain was "+" > new
claude project > start empty > provider > name this project > create
session, and nothing in it ever asked where the project should live. The
client posted a name and no `working_dir`, so `SessionManager.create_session`
fell through to `work_path = settings.get_working_dir() / session_id` and a
project the user named `Punchlist Test` was created at
`.../ses_5a756046`. That is not a folder anyone chose, recognises, or can
find later, and it was written into the row as the project's home. The
fallback is still there for an old client, but it now logs at warning
level: it went unnoticed for as long as it did precisely because it was
silent.

**THE SECOND DEFECT WAS IN THE SAME LINE, AND IT IS GOTCHA 6.** That path
was built with `Path.expanduser()`, which expands `~` and stops. It does
NOT resolve symlinks, so `~/Development` stayed the SHORT spelling of a
directory that really lives in iCloud, and a short spelling is how one
directory becomes two projects. `project_directory` canonicalises with
`os.path.realpath` instead, so the LONG spelling is what reaches the row.
`tests/test_project_directory.py` asserts that against a real symlink
rather than trusting the reading.

**THE NEW FIELD IS `project_parent_dir`, NEVER `working_dir`.** Three
shipped flows already post `working_dir` with a folder from anywhere on
disk: "open an existing folder", the new-console FAB (it posts `~`), and
clone. Attaching a root restriction to that field would start refusing
folders they have always accepted, which is a worse bug than the one being
fixed. A restriction on a field nothing used to send cannot regress
anything. The server joins the parent to `project_name` itself, so the
client cannot compose a path the server did not check.

**Traversal and symlink escape are ONE check.** The parent goes through
`realpath` BEFORE any comparison, so `..` cannot survive and a symlink
bridge resolves to where it really points. Containment is component-wise,
never `str.startswith`, or `/Users/jsugamelevil` reads as living under
`/Users/jsugamele`. The allowed roots are the projects root plus HOME, and
home is deliberately generous: the owner's projects live under the iCloud
Sync path rather than under `DEFAULT_WORKING_DIR`, so a root set of only
the projects root would refuse the exact folders the folder step exists to
offer. That is a silent way of not shipping the feature.

**A name is REFUSED, never rewritten.** Spaces are legal and stay verbatim
(the owner's own projects have them). `/`, `\`, NUL, control characters, a
leading dot, `.` and `..`, and anything over 255 bytes come back as an
inline sentence. A sanitiser that turned `a/b` into `a-b` would make a
folder the user did not ask for and cannot find. An existing EMPTY target
directory is fine; a non-empty one refuses.

"clone from github" does NOT have this defect: it has collected a parent
directory since it shipped (`web/src/lib/launchpad/CloneModal.svelte`,
`modal-clone-parent`; it was `launchpad.js` until slice 6).

## A session's theme, and the two stores that hold one

There are TWO durable theme stores and they are keyed on different
things. `pinned_themes.json` (`Settings.get_pinned_themes_path`) is keyed
on the bare tmux NAME and records a theme the user pinned to ONE session.
`<working_dir>/.cc.theme` is keyed on the DIRECTORY and records the
default a PROJECT carries, which is what gives a checkout its colours
before any session exists and the only one of the two a user can commit.
Both are wanted; neither may silently override the other.

| Piece | File |
|---|---|
| The ladder, pure | `src/core/session_theme_resolution.py` |
| Both stores, and the ladder's one caller | `src/core/session_manager.py` (`resolve_project_theme`) |
| `PATCH /sessions/{name}/theme` | `src/api/routes.py` (`_apply_session_theme`) |
| Painting it, client side | `client/js/theme-navigation.js` (`applyForTarget`) |

**THE PIN WINS, AND IT SHIPPED THE OTHER WAY ROUND UNTIL 2026-09-10.**
`resolve_project_theme` read the dotfile FIRST, so the three paths that
seed `Session.pinned_theme` - create, adopt and the boot re-adopt - each
threw away a pin that was sitting on disk the whole time. A pinned theme
did not survive a server restart, and two sessions running out of one
repo folder (routine on this box) could never hold two different themes.
The rule is the one `session_agent_evidence` already states: a value
written ABOUT this session outranks a value written about the place it
happens to live. A default that beats an explicit choice is not a
default, it is an override.

**AND THE READ ORDER IS ONLY HALF OF IT. THE PATCH USED TO WRITE BOTH
STORES.** That is the mechanism by which pinning session B rethemed
session A: the dotfile is folder-wide, so a per-session control was
writing a shared value. The theme PATCH now writes the pin alone, and
`migrate_pinned_theme_to_dotfile` is GONE for the same reason - it
ferried one session's pin into the folder-wide file, and its original
job (carrying a v0.6.x pin forward) is moot once the pin store is read
first. Setting a project default is a separate, deliberate act through
`set_project_theme`, and it has no UI control yet, which is a known gap
rather than an oversight.

**A PIN NOW OUTLIVES ITS TMUX SESSION, which is a policy change that came
with the read order.** The `_lifespan_tmux_reconcile` pass used to drop
every `pinned_themes` entry absent from the live listing. That was free
while the map was a decaying fallback and is DATA LOSS now it is the
durable record: this app re-mints tmux names from project slugs, so the
name is coming back, and the entry only ever exists because a human
picked a colour. `discard_pinned_theme` on the explicit close is the one
removal path. Note the asymmetry with the OWNERSHIP prune in the same
pass, which stays: an ownership record claims a session is running, so a
measured zero contradicts it; a pin claims only what to paint if the name
returns, which a measured zero does not contradict at all.

`_save_pinned_themes` takes a `.bak` of the pre-write bytes first, like
`Settings.update_settings_config`. `_load_pinned_themes` starts from an
EMPTY map when it cannot parse the file, so without that backup one
corrupt read plus one pin would write the empty map over every pin the
user has. No migration was needed for the inversion and nobody's screen
changed colour on upgrade: an existing dotfile was written by a PATCH
that wrote both stores, so the pin map already held the same value.

## The status lights, and what they are allowed to claim

Full model in `docs/session-status.md`. The eight states are `working`,
`working_subagent`, `question`, `notice`, `finished_unread`, `idle`,
`dead` and `unknown`. `UserPromptSubmit`/`PreToolUse`/`PostToolUse` move to
`working`; `SubagentStart` with no matching `SubagentStop` to
`working_subagent`; `PermissionRequest` to `question` and `Notification`
to `notice`; `Stop` to `finished_unread` while unread, `idle` once seen;
tmux's `#{pane_dead}` to `dead`; everything else is `unknown`, which is a
real answer and never `idle`.

**FIVE COLOURS ON ONE LIGHT, AND THE ENVELOPE IS GONE.** The owner's
rule, 2026-09-08, verbatim: "if the session is fully stopped waiting for
a response, then yellow. if it's still working but needs something from
me, make it light blue", over "red if the connection is disconnected,
grey if the session is idle, green if there is activity", plus "finished
turn waiting on me to look at should be a green outline and grey filled
dot". GREEN is `working` / `working_subagent`. YELLOW is `question` AND
the startup gate's `awaiting_startup_prompt` - both are fully stopped and
the user's answer to both is the same. LIGHT BLUE is `notice` alone, the
only state that is working AND asking for you. GREY is `idle` and
`unknown`, told apart by SHAPE (`unknown` is drawn hollow) rather
than by a louder colour. RED is `dead` and a dropped WebSocket. And
`finished_unread` is a crisp green ring around a CLEARED centre. THE
EIGHT INNER STATE NAMES STAY EIGHT - only the paint collapses onto five
hues, because the accessible label still has to say which state it is and
colour was never allowed to be the only signal.

**THE GREY FILL IN THAT RING WAS WITHDRAWN, and the two hollow lights now
share one recipe.** Shipped, the ring put a mid-grey `done` dot inside the
green band and it read as two lights stacked. The owner's 2026-09-09
correction, verbatim: "it should look like the 'status not measured' dot,
but the outline should be green instead of light grey with the dark grey
center". So `--led-fill: transparent` is declared in ONE rule naming both
`[data-inner='unknown']` and `[data-outer='unread']`, and the dot's
`background` reads that token rather than `--led-ink`. Two copies of
"clear the middle" would drift into one state showing the real background
and the other showing a grey somebody picked, so the count of that
declaration is asserted. Note the trap the token also closes: the legacy
`.status-dot.status-led` compat block outranks `[data-outer='unread']` and
sits later in the file, so a `background: var(--led-ink)` there silently
refills both hollow states on every surface. CLEARING A FILL MOVES PAINT,
NOT GEOMETRY - measured at 8x device scale before and after, all nine
(inner, outer) pairs painted an IDENTICAL extent to the hundredth of a
pixel, so `--led-lit-scale` is untouched.

**THE KEY IS SEVEN ROWS, ONE PER LIGHT, NOT ONE PER STATE.** It carried
nine and the owner asked for "one entry per colour": two rows showed the
same yellow and two the same red, which sends a reader looking up a dot
hunting for a difference the light cannot show them. Yellow is now
"stopped, waiting on you", red is "dead / disconnected session", and green
and grey each appear twice ONLY because a solid dot and an outline are two
different things on screen. THE STATE MACHINE DID NOT CHANGE: the four
collapsed states still exist and the dot's own `title` / `aria-label`
still say which of each pair it is, which makes those labels load-bearing
rather than decorative. `tests/test_status_key.node.mjs` pins the count,
that every hue has a row, that no two rows draw the same light, and that
the collapsed pairs resolve to one colour in the STYLESHEET while their
words still differ.

The unread ENVELOPE ICON went with it, from the sidebar row menu and the
launchpad card. It was also the manual mark-unread control, so its click
and keyboard handlers went too. Unread TRACKING is untouched: `Stop` still
sets it, a WS terminal binding still clears it, `src/core/unread_store.py`
still keys on the instance, and `PATCH /sessions/{name}/unread` still
exists with nothing in the UI calling it. The green ring is the only thing
saying it now, which is why it is drawn as a REAL RING - transparent
centre, 2.5px inset band - and not as the blurred wash every other halo
wears. THE FILL WAS THE TRAP: the halo pseudo-element paints ABOVE the
element background, which IS the dot, so an opaque disc renders
`finished_unread` as a solid green blob with no grey in it. Measured in a
6x render before it shipped.

**ONE LIT DIAMETER FOR EVERY STATE, and the element box was never the
thing that varied.** Measured 2026-09-09, all forty (inner, outer) pairs
reported a 9.0px ELEMENT box - which is exactly why 190 green suites had
never caught what the owner could see. The HALO was sized per state and
drawn partly OUTSIDE its own box by a spread `box-shadow`, so the lit
object came out at three diameters: about 14.7px for `active`, 15.3px for
`unread` (that block set its own scale), and an invisible halo for every
resting state, which therefore reads at the bare 9px dot. One working
session in a column of quiet ones read about 60 percent wider than its
neighbours. `--led-lit-scale` is now declared ONCE on `.status-led` and
overridden by no state, and the glow is a RADIAL GRADIENT rather than a
spread shadow - a gradient fades out AT the box edge, so the halo's
painted extent IS its declared box and can be held to a number; a spread
shadow paints beyond the element by definition and never could.
`scripts/verify_status_led_geometry.py` measures the whole matrix in a
real Chromium across three themes and two viewports, because the
divergence was in what the box RESOLVES to once a per-state override and
a pseudo-element's own shadow are composed, and no CSS read composes
those.

**THE GROUP HEADER'S ROLL-UP IS THE ROW COMPONENT, and its yellow `(n)`
badge is gone** (2026-09-09, "to be clear remove the yello (1)").
`session-status-summary.js` folds the children to an (inner, outer) pair
and hands it to `StatusLed.ledHtml`, so a header takes the finished-turn
ring exactly as a row does. Nothing replaced the count: the ring already
says there is something in here for you, and two indicators for one fact
is how they come to disagree. The plain count pill saying how many
conversations a folded section hides is a DIFFERENT control and stays.

**THE LIGHTS FINALLY HAVE WORDS**, in `client/js/session-status-key.js` -
a foldable legend at the foot of the sidebar, collapsed by default on
`cloude.statusKey.open`. Every swatch is a real `ledHtml`, never a
drawing of one, so the legend cannot show a colour the app does not
paint. It replaced the "N remembered positions are held for sessions not
currently listed" note, which named bookkeeping no reader could act on;
the remembered slots themselves are untouched and still stamped on the
list element as `data-order-missing`.

**BELOW THE KEY SITS THE APP'S OWN VERSION, ONE COMPONENT FOR BOTH
PLACEMENTS IT APPEARS IN.** `client/js/version-footer.js` renders a
small grey `<span class="version">` and both surfaces call it: the
sidebar footer (right after the status key, its own `.version-footer`
block) and the home screen's bottom bar chip
(`renderHomeBarVersion()` in `web/src/lib/launchpad/home-chrome.ts` since
slice 7, which only owns a mount point). It reads `<meta name="cloude-app-version">`, stamped once at
serve time by `src/main.py` from the SAME resolver `GET /api/v1/version`
calls (`src/core/version.py::resolve_version()`) - not a second fetch of
that endpoint, because the value cannot change while the page is open
and the Electron tray already polls that endpoint every 20 seconds for
its own reason. **AN UNRESOLVED VERSION RENDERS `"version unknown"`, NOT
A BLANK CHIP.** Before this file existed, an empty meta tag made the
home bar's chip vanish (`.home-bar__version:empty { display: none }`,
now removed) - which read as a missing control, not as "the build could
not be determined", and defeated the one thing a version footer is for.

**A DROPPED SOCKET IS THE ONE SIGNAL THE SERVER CANNOT REPORT**, so it
lives in `client/js/session-transport.js`, written from `terminal.js`'s
`ws.onopen` / `ws.onclose` and read by the sidebar rows and the launchpad
cards on their way into `dotHtml`. This browser holds a socket to at most
ONE session, so **every other session answers `unknown`** - a sidebar full
of red because one socket dropped would be the fabricated-measurement
mistake this whole model exists to avoid. A DELIBERATE close CLEARS the
record rather than marking it disconnected. `dead` and `disconnected`
share the red, so the LABEL is the only thing separating them and the two
must never be paraphrases: "dead - the process exited" against
"disconnected - no live connection to this session".

**`question` AND `notice` ARE TWO STATES BECAUSE A PERMISSION PROMPT
STOPS THE AGENT AND A NOTIFICATION DOES NOT.** They were one state named
`question` until 2026-09-08. A `PermissionRequest` halts claude mid-turn
until a human answers a yes/no; a `Notification` is claude asking to be
looked at while nothing is blocked. Collapsed, a chatty session painted
exactly like a parked one, so the state that most needed acting on
stopped standing out - the false-urgency twin of this project's
false-green problem. They are TWO INDEPENDENT BOOLEANS,
`permission_open` and `notice_open`, not one field with three values:
hooks arrive unordered and duplicated, so a `Notification` landing either
side of the `PermissionRequest` it accompanies must not be able to move
the blocking claim. `permission_open` is read first, so a session holding
both answers `question`. Both are cleared by the same three events
(`UserPromptSubmit`, `PreToolUse`, `Stop`) because what resolves either
is the user showing up. On the LED the split is now VISIBLE rather than
only recorded: `question` is inner `waiting-permission` and paints yellow
with the startup gate, `notice` is its own inner state and paints light
blue. Light blue over a third warm hue because the pair has to survive
red-green colourblindness - under protanopia and deuteranopia the green
desaturates toward a pale khaki while a blue at this wavelength stays
plainly blue. Summary priority for the header's INNER dot is
**permission > input > working > unread > done > dead > unknown**, and
`notice` still buckets as `input` - the colour split is a rendering
decision on the ROW, not a re-ranking. The `done` bucket means "finished
and already read" and renders the grey `idle` dot. The header's RING is
NOT looked up on the winning bucket: it is folded separately, from
activity across the whole group, so a group holding one parked session
and one busy one paints the parked dot inside a breathing ring rather
than hiding the work behind the more urgent light.

**A SESSION WAITING ON ITS OWN SUB-AGENTS IS NOT WAITING ON THE USER, AND
NEITHER `Stop` NOR `Notification` MAY SAY IT IS.** claude fires `Stop`
when the MAIN turn ends whether or not the background agents it launched
are still running, and it raises a `Notification` in that same state, so
a pane reading "Waiting for 2 background agents to finish" was raising
both a "Your turn" and a "wants your attention" card. That is the
false-urgency twin of the `question`/`notice` fold above: a summons to a
session that wants nothing. The gate is one condition in
`claude_event_hook` (`src/api/routes.py`) reading
`SessionManager.subagent_depth`, a passthrough to the count
`SessionActivityTracker` already keeps for `working_subagent`; nothing new
is stored and the state machine is untouched, so a suppressed `Stop`
still flips unread and still resolves its status. Only the interruption
is skipped.

**IT REFUSES TO RAISE; `toast_auto_ack.py` ANSWERS WHAT WAS RAISED. THE
TWO CANNOT DOUBLE-CLEAR.** They are on opposite sides of the same
handler and touch different state. The gate is a pure read of
`subagent_depth` taken BEFORE `record_hook_event`, and its only effect is
to skip the `raise_toast` call for `Stop` and `Notification` - it clears
nothing, acks nothing and writes nothing. `auto_ack_toasts` runs after
the event is recorded and only ever moves an ALREADY OPEN toast to
`answered`, keyed by KIND and bounded by the event's own instant. A toast
the gate suppressed was never opened, so there is nothing for the ack to
find; a toast the gate allowed is acked exactly once, by the same
kind-keyed rule that survives a duplicate or a reorder. Order is what
makes that safe and it is deliberate: ack what is open first, then decide
whether to raise.

**`PermissionRequest` IS NEVER SUPPRESSED, AT ANY DEPTH**, because it is
a HARD BLOCK - claude has stopped mid-turn and cannot continue until a
human answers - which is the one case where a busy session genuinely is
waiting on the user. That is the whole exception, and it is the negative
control the tests turn on: a suppression rule that quietly grew to cover
it would pass every positive test and strand claude behind a yes/no
nobody was told about.

**THE DEPTH IS READ BEFORE THE EVENT IS APPLIED, and that ordering is the
whole mechanism.** `Stop` RESETS `subagent_depth` to 0, so a gate reading
the count afterwards answers 0 every time and can never fire. It also
cannot be built on `SubagentStop`, which on a turn with no subagent in it
arrives about 1.5s AFTER the `Stop` (the punchlist 4 measurement above) -
an event that has not landed yet can neither confirm nor deny anything.
And it FAILS TOWARD NOTIFYING: an unknown session, a dropped
`SubagentStart`, or a read that threw all leave the count at 0 and the
toast is raised exactly as before. Silence is bought only with a POSITIVE
count, because a missed "your turn" is a worse failure than a spurious
one.

**THAT SAME FOLD NOW PICKS THE ONE TOAST CARD A SESSION GETS.** The toast
stack coalesced on (kind, session) until 2026-09-09, so one session
produced one card per kind - a "wants your attention" card AND a "Your
turn" card, about the same session; four cards for two sessions, measured.
`client/js/toast.js` keys the group on the SESSION alone, and
`client/js/toast-session-group.js` READS `SUMMARY_PRIORITY` out of
`session-status-summary.js` to pick which pending event that card shows.
It declares only the join from a hook event name to a bucket -
`PermissionRequest` to `permission`, `StartupPrompt` and `Notification`
to `input`, `Stop` to `unread`, anything unrecognised to `input` (the
same refusal-to-assume-harmless as `SEVERITY_DEFAULT`) - with toast.js's
own severity breaking a tie INSIDE a bucket so a blocking startup prompt
is not displaced by chatter. THERE IS NO SECOND RANKING; if the fold is
unavailable the module groups NOTHING rather than inventing one. The
pick is a pure FOLD over what is held, which is what makes the card
upgrade in place, refuse to downgrade, and survive the same hook event
twice. The `xn` badge counts the WINNER'S KIND, never the session's pile
- it sits beside the winner's title and would otherwise put a 7 next to a
sentence that happened once - while the dismiss control, the "Dismiss
all" disclosure and the overflow row all count RECORDS. The attachment
receipt (`client/js/attachment-toast.js`) is deliberately outside this
grouping: no server record, retired by the prompt being SENT, so it keeps
a card of its own. Full model in `docs/session-status.md`.

**A CLOSING HOOK EVENT IS NOT A HEARTBEAT ON ITS OWN, and that was
punchlist 4.** Measured twice by `tests/test_led_real_hooks.py` on claude
2.1.265: on a turn with NO SUBAGENT IN IT, `SubagentStop` arrives about
1.5s AFTER `Stop`. `Stop` had just cleared `last_tool_event_ts` to say the
turn was over, `record_event` stamped it again, and a finished session
painted `working` for the full 120s - `finished_unread` lasted a second
and a half and `idle` was UNREACHABLE. The rule now: an event that CLOSES
something stamps only when something was open for it to close.
**`SubagentStop` NEVER STAMPS the heartbeat: it says work ENDED, so the
only thing it moves is `subagent_depth`, and it moves that with the floor
at 0.** It first shipped gated on `subagent_depth > 0` instead, and THE
GATE IS NOT THE CLAIM IT STANDS FOR - a duplicated `SubagentStart`
delivered after `Stop` raises the depth off the floor by itself, so the
duplicated `SubagentStop` behind it passed the gate and stamped, at its
own arrival time, ratcheting the expiry out on every further pair.
`PostToolUse` cannot take a blanket refusal (it is the only event some
legitimate turns emit late), so it keys on a `turn_open` boolean that
every OPENING event sets and `Stop` clears, and is refused ONLY when a
`Stop` was POSITIVELY seen and nothing has opened since - never having
seen a `Stop` is not evidence the turn ended. Opening events still stamp
unconditionally, so a stray `SubagentStart` after `Stop` still buys ONE
bounded window keyed on itself; what no `SubagentStop` can do is extend
it.

**A DEAD PANE DROPS OFF THE LIVE LIST AND BELONGS IN RECENT.** The
owner's call, verbatim 2026-09-08: "they go into recent, they can
disappear." A session whose process died has stopped, so its row leaves
`GET /sessions/list` rather than lingering there wearing a dead light,
and a restart from Recent is a resume. `dead`/`off` stays in the LED
vocabulary but is GALLERY-ONLY - no live endpoint is meant to carry a
dead row to the client. A round that read the same measurement as a bug
and made a husk KEEP its row, painted dead, was overruled and reverted
(`ba2aa5d`), and `tests/test_led_real_hooks.py` holds the line against a
real killed pane. CLOSED 2026-09-10: `remain-on-exit` keeps the husk's
tmux session in the listing, and `session_lifecycle` reaps on ABSENCE
from that listing, so the row used to leave the live list without ever
arriving in Recent. `src/core/session_pane_death.py` is the second reaper
rung, keyed on a MEASURED `#{pane_dead}` of exactly `"1"` read out of the
COMPLETE `list-panes -a` the launcher pass already pays for, on the
socket the reconcile is about, for a row whose creation epoch matches -
no listing, a partial one, a socket mismatch, an unreadable field or a
re-minted name all answer `unknown` and reap nothing, because refusing is
free and one wrong reap costs a live session. It ADDS NO TMUX CALL: the
pane probe was already being taken a few lines below and is simply taken
before the reaper instead. It writes the SAME FOUR COLUMNS as the absence
rung and differs only in `lifecycle_source`, which is `pane_dead` rather
than `tmux_missing`. STILL OPEN: the tmux HUSK is deliberately NOT
killed, so the dead session keeps its name and the next session for that
project is still uniquified to `<name>-2`; freeing the name means killing
a tmux session, which needs the owner's explicit yes.

**A VIEW CLEARS AN OPEN `permission`, AND AN OPEN ONE IS VERIFIED
AGAINST THE PANE AFTER 20 SECONDS.** Measured 2026-09-09,
`cloude_Media_Compression` painted `question` over a pane holding no
dialog because the flag was set on `ses_949a8585` while the claude in
that pane posts its spawn-time `adopted:cloude_Media_Compression`, so
every clearing hook landed on a different tracker key and nothing
reachable could retire it; the toast path already remaps that split and
the activity tracker does not. So `session_view_clears` now clears
`permission_open` too, and while the flag is open past
`PERMISSION_TAIL_GRACE_SECONDS` the listing pass takes ONE `capture-pane`
and clears it when claude's dialog is not on screen - marker present
keeps, marker absent clears and logs `permission_flag_cleared_no_dialog`,
an UNREADABLE tail keeps, and the markers were read off two real dialogs
(`Do you want to ...?`, `❯ 1. Yes`, `Esc to cancel · Tab to amend`)
rather than guessed. See `src/core/session_permission_verify{,_apply}.py`.

**AND A PANE THAT IS GONE CLEARS IT TOO, BUT ONLY ON A READING THAT
ACTUALLY HAPPENED.** A claim left open at the instant its pane died could
never be retired - no `capture-pane` can run against a corpse - so
`_session_info_for`'s `LIVENESS_GONE` arm clears it with no capture at
all, on the way to dropping the row. The trap is that
`resolve_listing_liveness` answers `gone` by TWO roads and only one is a
measurement: a COMPLETE listing from the backend's OWN socket naming the
session and reporting `#{pane_dead}` dead, or a falsy `exists`, which for
tmux came from `is_alive()` and therefore returns the same False for "no
such session" as for "tmux is missing, timed out, or errored". Only the
first passes `pane_alive=False`; the second passes `None`, which the seam
treats as no reading and which KEEPS the flag. The asymmetry is not
fussiness: the dropped row beside it self-heals on the very next poll,
while a cleared flag is reopened by nothing short of a brand new
`PermissionRequest`, so one timed-out probe would silently retire a
dialog the user never answered. `session_pane_death.pane_death` states
the same discipline for the REAPER and is deliberately not reused here,
because it requires the STORED row's `tmux_created_epoch` and this pass
holds no trustworthy one; `listing_proves_alive`, already computed on the
line above for `exists`, is the rule that IS reused.

**A tmux `running` pane maps to `unknown`, NOT `working`.** It means only
"the foreground command is not a bare shell", which is equally true of an
agent mid-tool-call and one at an empty prompt, and the fallback carries no
timestamp so nothing could expire the claim. Measured 2026-09-08: 15 of 19
live sessions report a claude VERSION STRING as `pane_current_command`, so
that branch is the common case and all 15 were reporting a permanent
`working` on no evidence. Hook-fed `working` still expires after 120s.

**AND THAT LEFT `unknown` AS THE COMMON READING, SO A RESTING CLAUDE IS NOW
SEEDED FROM EVIDENCE THAT OUTLIVES THE PROCESS.** `SessionActivityTracker` is
in-memory and nothing hydrated it, so a restart left every session on the
tmux tier: measured on live 2026-09-08 22:24Z, 19 live panes and 15 painting
`unknown`. Ten had NEVER fired a hook and never will - hand-started without
the hook env, last assistant turns dated 2026-07-16 and 2026-08-24, alive at
an idle prompt for weeks. `src/core/session_status_seed.py` is the ladder
(records in `_records`, cache in `_store`, the two reads and the seam in
`_read`): rung A is `sessions.activity_state` judged by
`activity_persist.restore_state` and read on the FULL INSTANCE TRIPLE, the
same WHERE clause `write_state` writes on, because a name-scoped read answers
for whichever epoch sorts newest; rung B is the last decidable record of the
bound transcript, walked BACKWARDS through the one bounded reader
(`claude_title_sync.read_tail_records`, now extracted so there is exactly
one) so the newest evidence wins. **IT MAY CLAIM REST AND MAY NEVER CLAIM
`working`**: a file carries no heartbeat, so a `working` seeded from one
could never be expired - the identical defect the paragraph above just fixed,
one tier down. A sidechain `end_turn` is UNDECIDABLE (a subagent finishing
inside a live turn), and so is a slash-command envelope, which is what the
measurement forced: claude intercepts `/rename` before it becomes a prompt
but still writes a pseudo-`user` record about it, and reading those as
prompts pinned the only two sessions the ladder refused at in-flight while
both sat at an empty prompt. Wired at the boot re-adopt, after
`POST /sessions/adopt`, and at ONE seam in `_session_info_for` reached only
while the answer is still `unknown` on a pane measured LIVE, so a seed can
add an answer and never overwrite a measured one. A hook retires it
instantly (the seam is gated on `hooks_seen`), which is also what makes it
idempotent - a seed is a cached READING, not an event. Read-only against the
live DB and the real corpus before shipping: **all 15 unknowns would read
`idle`**, every one via rung B, 0.27 ms median each. The negative control is
separate and load-bearing, because a matcher that always finds something is
worse than useless: over 400 sampled transcripts it splits 172 `at_rest` / 70
`in_flight` / 158 `no_marker`. Full model in `docs/session-status.md`.

**AND A HOOKLESS SESSION NOW READS ITS OWN TRANSCRIPT FOR WORK, because an
mtime is a TIMESTAMP and the objection above was about a RECORD** - measured
2026-09-09, only 6 of 19 live sessions had ever fired a hook, and three of
the other thirteen had touched their transcript inside 36 minutes while
painting the same rest as ones last touched in July;
`src/core/session_transcript_status{,_read}.py` is rung 0 of the same ladder
(mtime inside `WORKING_HEARTBEAT_TIMEOUT_SECONDS` -> `working`, carrying an
`expires_at` that `display_state` enforces so the 60s seed cache cannot
stretch it; a turn end NEWER than the one its instance-keyed ledger already
holds -> `finished_unread` plus ONE auto-unread claim, where FIRST SIGHT IS A
BASELINE so a restart never re-lights the fleet), gated on `hooks_seen` and
NOT on the hook token store, which holds 33 entries for 19 live sessions
including every adopted pane. **A VIEW NOW CLEARS AN OPEN `notice` AND NEVER
AN OPEN `permission`** (`src/core/session_view_clears.py`, reached from the
WS bind and from mark-read): a `Notification` is a message to the user and
survived a 46-minute visit on BHPP, while a `PermissionRequest` is a blocking
fact about the agent that looking at does not answer. `status_source`
(`hook` / `transcript` / `seed_row` / `tmux` / `none`,
`src/core/session_status_source.py`) rides the `/sessions/list` wrapper and
renders in the TOOLTIP ONLY, and `client/js/session-header-led.js` finally
puts the same LED beside the session name in the terminal header.

**Unread is keyed on the INSTANCE**, `<tmux_name>@<#{session_created}>`,
because a name is reused and a flag from a killed session reappeared on its
successor. Set on `Stop` and by the user's control, cleared when a WS
terminal binds. An unmeasurable epoch degrades to the legacy name key.
**THE EPOCH HAS ONE SOURCE, `src/core/unread_identity.py`, AND IT IS THE
LIVE TMUX LISTING** - set, clear and read all reach it through
`SessionManager._unread_epoch`, because two derivations for one key are
two keys the moment they disagree and a clear on a key nobody wrote can
never be undone by clicking. It refuses the DB row's recorded epoch and
the session_id-keyed `_instance_epochs` alike; its name-keyed cache is a
memo of the tmux measurement, refreshed by every listing.
**AND THE CLEAR ONLY HAPPENS IF A SOCKET ACTUALLY OPENS.** Measured
2026-09-09: a session entered in a BACKGROUNDED tab opened none, because
`waitForFontsAndLayout` ended on bare `requestAnimationFrame` awaits that
a browser never runs for an unpainted tab, suspending
`connectWebSocket()` before `openWebSocket()`. No socket means no
`onclose`, so no reconnect rung fires either: the terminal sat on
"Connecting to terminal..." for 35 minutes and resumed the instant the
tab was painted. THERE WERE THREE such waits, not one - the sidebar
rejoin and the adopt path each carry their own, ABOVE what was then a
`setTimeout(..., 500)` scheduling the connect (that delay is gone; see
"The connect is measured, not slept" below), so fixing only the first
changed nothing and only a live re-check found that. A FOURTH was found
in `launchpad.js`'s `_returnToActiveRunningSession` and closed the same
way; the session fetch and the terminal entry both sit below it.
`client/js/terminal-layout-wait.js` races every wait against a timer - a
layout wait may DELAY a connect, never CANCEL one - and
`tests/test_terminal_layout_wait.node.mjs` fails the build if a bare rAF
await reappears in `terminal.js`.

**IT IS ONE FLAG, AND EVERY WRITER AND READER MUST MEASURE THE EPOCH.**
The owner's rule, verbatim: "when clicking a tab, the session is marked
read. if i want it unread i click unread." So `auto` and `manual` are two
writers of one state: opening the tab clears BOTH (it used to spare
`manual`), and so does clearing the control, through `UnreadStore.clear`.
Both writers now resolve a measured epoch and `/sessions/list` reads with
the `created_at_epoch` on its own bulk tmux probe rather than the
`_instance_epochs` cache, which is EMPTY for every session predating the
process and composed the legacy bare-name key - so a flag written under
the instance key was on disk and invisible to the endpoint. And the LED
finally receives it: `SessionStatusUI.dotHtml(status, signals)` takes
`unread` and `startup_gate` as a second argument, no live caller passed
it, and an unread `idle` session therefore painted a `steady` halo on
every surface. Full model in `docs/session-status.md`.

**`finished_unread` VERSUS `idle` IS DERIVED FROM THE UNREAD FLAG AT
RESOLVE TIME, BY ONE FUNCTION, ON EVERY PATH** - `derive_read_state`
(`src/core/session_status.py`), called from the hook tracker's resolve,
the tmux fallback, the seed's `display_state`, the transcript ladder's
rung 3 and the assembled answer in `_session_info_for`, so a saved
`finished_unread` becomes `idle` the moment the flag clears and
`activity_persist.write_state` stores only the base state. It shipped as
a one-directional rule - adding unread to an `idle` and never removing it
from a stored `finished_unread` - which is a cache rather than a
derivation, and measured on live 2026-09-09 the owner opened
`cloude_daily-briefing` and got `finished_unread` beside `unread: false`
from `status_source: seed_row`, a green dot over a session he had just
read.

**THE OUTER RING CARRIES ACTIVITY AND THE FINISHED TURN, AND THE OWNER
SETTLED THAT ON 2026-09-09.** `working` breathes; a live-but-stopped turn
(`question` / `notice` / the startup gate) breathes too, because the turn
is still open; a finished turn nobody has read takes `unread`, a crisp
STILL green ring; a read session at rest takes `steady`, lit and still in
its own dot's grey; a dead pane or a lost transport takes `off`, no ring
at all; an unmeasured one takes `dim`. The INNER dot carries the session's
state. MOTION is the load-bearing distinction: `active` is the only state
that animates, so a light that MOVES is a session that is moving.

That ruling settled a same-day reversal, and the reversal is HISTORY, not
a live rule. Both lines of this project were fixing one report - "the ring
around some of the leds are not gray, which means there should be
background tasks. i dont think those few have any background tasks" - and
fixed it opposite ways within hours. One retired the outer `unread` state
and its `--led-color-unread` hue and moved unread onto the inner dot
alone; the other kept the ring and simply stopped it breathing. The owner
picked the ring, so `unread` IS an outer state, `--led-color-unread` DOES
exist, and the `done` bucket stays in the summary priority. Anything in
this file or in `docs/session-status.md` that reads as though unread lives
on the inner dot is describing the branch that lost; fix it rather than
working around it (gotcha 8).

**The LED is two independent rings** (`client/js/status-led.js`): an inner
dot for the chat's status AND an outer ring for activity and attention,
so "a parked session with work still running behind it" is sayable on a
group header. `dotHtml` delegates to it, so every surface renders the
same component - and every surface must PASS IT SIGNALS (`unread`,
`startup_gate`, `status_source`, `transport`), not just the status
string, or the finished-turn ring, the disconnected red and the
provenance tooltip can never render. A WORKING session is solid green and
BREATHING whatever its unread flag says, and `unknown` never takes the
GREEN ring at all (it takes the faint grey `dim` one): that green is a
claim a turn FINISHED here, and neither of those two measured one.

**THE VOCABULARY IS TAUGHT, NOT GUESSED AT.**
`client/js/session-status-key.js` is the legend at the foot of the
sidebar, and it describes the model above - nine inner states resolving
onto five hues, plus the one two-part treatment. A nine-state colour
vocabulary with no legend is a vocabulary nobody learns. If the legend and
the light ever disagree, the light is not the thing to change quietly: one
of them is wrong and a user has already learned the wrong one.

BOTH RINGS ARE ONE ELEMENT: the inner is the span's `background-color`
and the outer is a four-layer `box-shadow` on that same span (an optional
hollow rim inside the dot, a hard `0 0 0 1.5px` ring, a low-alpha feather
at the same spread that softens the ring's own edge, then a blurred
glow), with every alpha mixed into the shadow colour by `color-mix`
rather than an element `opacity` that would fade the fill too. There is
NO pseudo-element, and there may not be one: the halo used to be an
`::after`, and the browser pixel-snaps that box's position and size
independently of the dot's box, so whenever the dot landed on a
fractional x/y - routine in a flex row, or wherever a text baseline puts
an inline box on a half pixel - the two circles came apart by a device
pixel. Symmetric `inset` fixed the halo's own internal symmetry and NOT
this, because the drift was between two boxes. A box-shadow is painted
from the element's own border box, so concentric is the only geometry it
can have.

**ONE LIT DIAMETER FOR EVERY STATE**, and no per-state rule may touch a
geometry token. The halo used to be sized per state, so the LIT object
came out at three different diameters (9.0, about 14.7 and 15.3px) and
only the two loud ones were visible - in a sidebar where one session is
working and the rest are at rest, that paints one dot 60 percent wider
than its neighbours, which is what the owner reported. Under the
one-element composition the five geometry numbers are declared once and
never overridden, so the rule holds by construction rather than by every
state remembering to agree. `unread` is the state that used to break it.

`idle` (read, at rest) has its own grey fill, `--led-color-idle`, and
sits under a still ring in that same grey, so opening a tab reads as
visibly calmer than leaving it unread - a green ring becoming a grey one
AND a recessed centre becoming a solid grey dot, two changes rather than
one. See `docs/session-status.md`.

**THE ROW'S CONTROLS LIVE IN A KEBAB MENU, AND RESTART IS ONE OF THEM.**
They were folded into a per-row three-dot kebab in `cddc823`; one line of
this project unfolded them again on 2026-09-08 back to inline pin and
close, deleting `client/js/session-row-menu.js`, its gesture module and
`session-row-menu.css`, and removing restart from a live row along with
them. **That was not taken, 2026-09-09.** The kebab stays, right-click
and long-press still open it, and `data-row-status` stays ON THE KEBAB,
which is where `session-sidebar-clicks.js` reads it to hand the restart
picker a measured status. THOSE TWO FILES GO THE SAME WAY OR THE MERGE
COMPILES AND LIES: point the read at the row while the kebab is what
carries the attribute and `runRestart` gets `null`, so every restart
reports "unknown" instead of what was measured. Nothing throws; the
picker just stops knowing anything.

Keeping the menu also keeps the two things its removal would have cost,
both of which were named honestly on the branch that removed it: FILING A
SESSION INTO A GROUP keeps a pointer route (the picker still opens on `g`
over a focused row, on Alt+Arrow across a band edge, and by dragging onto
a group header, but on a phone the menu entry is the only one of those a
thumb can reach), and RESTARTING A LIVE SESSION stays reachable, which is
gate 1 under "Replacing what is running".

**THE GROUP HEADER IS OURS TOO**: a fixed `--sidebar-gutter` span holding
the count FIRST so every group name starts at the same x, the count as
accent-coloured tabular-nums text rather than an oval pill, a kebab on
the pinned and other bands as well as on named groups so the menu column
is a straight line, and no numeric unread badge - the roll-up LED carries
the same finished-turn ring the rows do, and two indicators for one fact
is how they end up disagreeing.

## The transcript archive the app maintains

The app keeps a byte-exact archive of this machine's Claude Code
transcript corpus (`~/.claude/projects`) inside its own `cloude.db`. It
is a background loop, started second-to-last in `lifespan()` (only the
database integrity scheduler starts after it) and stopped first on
shutdown, and it is fail-soft in exactly the way `ensure_db_migrated`
and `claude_hooks.ensure_hook_settings` are: boot never waits on it and
never fails because of it.

| Piece | File |
|---|---|
| One incremental pass, start to finish | `src/core/corpus_ingest_service.py` |
| The scan plan and the two DB fingerprints it rests on | `src/core/corpus_ingest_scan.py` |
| Scan cache + liveness artifact on disk | `src/core/corpus_ingest_state.py` |
| The background loop | `src/core/corpus_ingest_task.py` |
| The read-only status object | `src/core/corpus_status.py` |
| `GET /corpus/status`, `POST /corpus/ingest` | `src/api/corpus_routes.py` |

Four things worth knowing before you touch it.

**A steady-state pass must stay invisible.** It is measured at about 40 ms
over a 400-file archive and about one second of `stat` calls over the
real 19,065-file corpus. Two shortcuts buy that, and BOTH refuse
themselves rather than guess: the scan cache skips a file only when its
size, its mtime and the hash the database holds all agree, and the
incremental hash query is only used while the `install_id` matches and
`max_archive_id` has not gone backwards. If you add work to the pass,
measure it against those numbers.

**A skipped rooting pass is a named state, not zeros.** `report.rooting`
carries `status: ran` or `status: skipped_unchanged`. Do not "simplify"
it back to a bare count dict; a reader would then be unable to tell
"rooted nothing" from "did not look".

**Liveness is published on every terminating path, including failures**,
and its AGE is the signal. An ingester that dies looks exactly like one
finding nothing new, so `var`-style artifacts live under
`<state_dir>/corpus-ingest/` and `GET /corpus/status` reports the age of
`latest.json` with four outcomes: `current`, `stale`, `never_ran`,
`cannot_determine`.

**It maintains the ARCHIVE, not the v16 message model.** The message
model refuses a `source_ref` it has already ingested, on purpose, which
makes it the wrong layer for transcripts that grow while the app watches
them. The status endpoint still reports that model's gate findings
read-only, and says `model_not_populated` rather than "0 findings" when
it holds nothing.

`CLOUDE_CORPUS_INGEST=0` switches the loop off; it defaults OFF under
`CLOUDE_TEST_MODE` so a pytest run never reads the developer's real
corpus. `CLOUDE_CORPUS_ROOT` relocates the corpus,
`CLOUDE_CORPUS_INGEST_INTERVAL` the sleep between passes.

## The daily database integrity check

`PRAGMA integrity_check` is a MAINTENANCE OPERATION, NOT A LIVENESS PROBE, and
that distinction cost the project real time. `GET /api/v1/version` used to run
it synchronously inside its own coroutine on every request. The Electron tray
polls that endpoint every 20 seconds (`macOS/main.js`, `INTERVAL_MS = 20000`)
and the pragma re-verifies every page of every B-tree, so on a 4.5 GB
`cloude.db` the event loop was blocked for roughly 14 of every 20 seconds on an
idle machine, and the stall grew with the file. Wrapping it in a thread would
have freed the loop and still burned those seconds of disk three times a
minute, forever, which is why it was rejected.

| Piece | File |
|---|---|
| Run one check and publish the verdict | `src/core/db_integrity.py` |
| Read the verdict and decide what may be said | `src/core/db_integrity_status.py` |
| The background loop | `src/core/db_integrity_task.py` |
| The cheap per-request probe | `src/core/db_health.py` |
| Atomic write / tolerant read, shared with the ingester | `src/core/json_artifact.py` |

**The request path is now one connect plus one small SELECT**, plus one read of
a small JSON file. Measured at 0.46 ms median against a 310 MB database where
the pragma took 112 ms, a 215x difference that widens with the file. Do not put
a pragma back on it; `tests/test_db_integrity_verdict.py` booby-traps every
binding of the helper and fails the build if one appears.

**Measured on live after the deploy, 2026-09-07**, against the real 4.5 GB
file: p99 **14,505.7 ms to 13.3 ms**, p50 30.5 to 5.2 ms, the 20.0s cadence of
14.5s stalls GONE, and the share of the window stalled 86.5 percent to 0.0
percent. The measurement to trust is that the SAMPLE COUNT TRIPLED at an
unchanged poll rate, because that is independent of the timings: more samples
come back only if the loop is free to answer them. **13.3 ms is NOT settled.**
Later polls read p99 64-72 ms and most recently 66-73 ms. Still three orders of
magnitude better than the broken state and with no stall pattern, but about
five times that figure and NOT attributable; the corpus ingester was active
during the later runs, which is a hypothesis that was not tested. Re-measure on
a quiet box before quoting a number.

**The diagnosis is worth keeping for its shape: it was a REQUEST HANDLER ON A
TIMER, not a background task.** Several passes looking for a periodic
server-side loop found nothing, because nothing looped; the Electron tray
polled. When you are chasing a periodic stall, read what POLLS as well as what
loops. It was confirmed twice independently before any fix was written: py-spy
returned 17 of 17 stalled dumps byte-identical, and the static call chain
agreed.

**The cached verdict carries two facts, so it has two fields.** `verdict` is
`ok` / `failed` / `cannot_determine`; `freshness` is `current` / `stale` /
`never_ran` / `cannot_determine`, the same four-value vocabulary
`src/core/corpus_ingest_state.py` uses, reused rather than re-invented.
`verdict` reads `ok` ONLY when a check actually ran AND its record is inside
the freshness window, so "never checked" can never render as "checked and
sound". A recorded `failed` still degrades `data.status` exactly as the live
pragma did; `cannot_determine` deliberately does not, because not having looked
is not a fault.

`CLOUDE_DB_INTEGRITY_CHECK=0` switches the loop off; it defaults OFF under
`CLOUDE_TEST_MODE` so a pytest run never walks the developer's real database.
`CLOUDE_DB_INTEGRITY_CHECK_INTERVAL` overrides the daily interval, and the
staleness window is derived from it (two intervals) rather than hardcoded. The
loop also asks the artifact whether a check is due before its first run, so
restarting this menubar app all day does not re-walk the file each time.

## Secret scanning

`./scripts/install-secret-hook.sh` installs a pre-commit hook that refuses a
commit staging credential material; `./scripts/uninstall-secret-hook.sh`
removes it. `.git/hooks` is not version controlled, so the installer is the
distribution mechanism and has to be run once per clone.

`src/core/message_model_secrets.py` is the single source of truth for what
counts as a secret, shared with the transcript message model. Add a detector
there and a case to `tests/test_secret_detectors.py`; never write a second set
of patterns. No matched value is ever printed, logged or stored, by any path.

The hook runs a second gate after that scanner passes: gitleaks, against the
same `.gitleaks.toml` config CI runs. Installed via Homebrew on mac-mini-m4
(version 8.30.1, matching the version CI pins). A missing gitleaks binary does
not refuse the commit, it prints a NOTE that the second gate did not run.

Audit the tree with `./venv/bin/python3 scripts/scan_secrets.py`. Exit 2 means
could-not-scan and is not a pass. Full detail in `docs/secret-scanning.md`.

## Upgrading an install

`docs/upgrade-with-claude.md` is the runbook, and `/upgrade`
(`.claude/commands/upgrade.md`) is the entry point. The one rule that matters:
take `./scripts/upgrade-baseline.sh` BEFORE touching anything, because you
cannot verify a migration without a record of what the data was, and that is
the step everyone skips. `./scripts/upgrade-verify.sh` exits 2 when a check
could not be evaluated; 2 is not 0.

## Refreshing the local install on a new version

Adam's rule: every time there is a new version, his local copy gets
refreshed to it, so he is always running the latest code. Write down the
mechanics, because every one of them is a way the refresh silently does
not happen, and each has already cost time on this machine.

**There are two launch modes and they rsync from different places.** The
packaged app (`/Applications/Cloude Code.app`) rsyncs from the bundle's own
`Contents/Resources`, so launching it REVERTS any unreleased repo change.
Dev mode (`npm start` / `electron .` from `macOS/`) rsyncs from the REPO
ROOT instead. Both write into the same derived copy, at
`~/Library/Application Support/cloude-code-menubar/server/`, which is what
the server actually executes - so the launch mode is what decides which
code Adam ends up running, and the two can drift apart for a long time
with nothing on screen saying so. Measured 2026-09-10: the installed
bundle read version 1.0.33 while `macOS/package.json` already said 1.2.1,
and the gap was invisible because Adam was running dev mode off the repo.

**The version lives in exactly one place, `macOS/package.json`.** There is
no root `package.json` and no second version literal to grep for. The web
client's own version comes from a `{{VERSION}}` token that `src/main.py`
substitutes at serve time, via `src/core/version.py::resolve_version()`.

**A refresh is kill, relaunch, verify, in that order, or it only looks like
one.**
- macOS has no `setsid`. `setsid nohup npm start &` fails with "command not
  found" and starts nothing while reading as success. Use
  `nohup npm start > /tmp/cloude-menubar.log 2>&1 & disown` instead.
- Killing Electron does not kill its Python child. The old server keeps its
  port and keeps serving the OLD code, a health check on that port still
  answers 200, and it reads as a successful deploy of nothing. Kill both
  processes and confirm the port is free before relaunching.
- Verify against the DERIVED copy, never the repo, and never trust a
  matching timestamp as proof: rsync PRESERVES MTIME, so the file dates
  lining up proves nothing about whether a fresh sync happened. Grep the
  derived file for the actual code change instead.

**Sessions survive this by design**, because they live on the dedicated
`tmux -L cloude` socket, not inside the Electron/Python process being
restarted. A refresh is safe to do with live work in progress, and
`tmux -L cloude list-sessions` reporting the same session count before and
after is one of the checks that proves the restart did not touch them.

A refresh is not done until all four of these are true: the port answers,
the derived copy at
`~/Library/Application Support/cloude-code-menubar/server/` contains the
new code (grepped, not timestamp-checked), `tmux -L cloude list-sessions`
reports an unchanged session count, and the reported version matches
`macOS/package.json`.

## Imported conversations

`scripts/import_transcript_sessions.py` gives every real Claude Code
conversation a `sessions` row. DRY RUN BY DEFAULT. Measured 2026-09-08:
1,486 transcripts against 43 rows; it wrote 895 ARCHIVED rows into 12
existing and 59 CREATED archived projects, so nothing lands on a screen
until "show archived" is on. Four things stay out, each a NAMED outcome:
a cwd under `/private/tmp`, `/tmp` or `/var/folders` (the ONLY exclusion,
and it is about the path - `fstest` and `llmScratch` work is real and
imports); 319 files with no `cwd` anywhere (`file-history-snapshot`
bookkeeping); 224 `agent-<id>.jsonl` SUBAGENT runs, whose records report
the PARENT's `sessionId` - which is why identity is the FILE STEM; and
the older of two transcripts for one uuid split by a cwd spelling.

**NOT ALL OF IT IS THE OWNER'S TYPING, AND THE LISTS NOW SAY SO.** The
owner's rule, verbatim: "lists should always just be mine. the rest can
be found in the archive explorer." `sessions.kind` (schema v25) carries
three words and never a fourth: `interactive` / `automated` / `unknown`.
Measured over the 895 imported rows 2026-09-08 and applied on live: 320
interactive, 270 automated, 305 unknown. `GET /sessions/records` and
`GET /sessions/recent` exclude `kind='automated'` by default;
`include_automated=true` returns it and no UI sets that. `/archive` reads
the transcript archive and never `sessions`, so nothing here can hide a
transcript from the explorer.

**ONLY A FACT THE MACHINERY WROTE MAY SAY `automated`.** Two rungs, both
emitted by the thing that did the automating: a `<scheduled-task ...>`
tag around the prompt (259 rows), and `entrypoint: sdk-cli`, the headless
SDK path (11). Interactive is reached by `entrypoint` `cli` or
`claude-desktop` (266), a `planContent` record (30), or a `custom-title`
/ `mode` record (24). Title shape, turn count and prompt wording are NOT
in the ladder: 28 rows titled "Implement the following plan: ..." read as
delegated work and every one is a HUMAN approving a plan in the TUI,
while 3 scheduler runs are titled "Urbackup completion proof" and a title
rule misses all three. `src/core/session_kind.py` owns the ladder;
`scripts/classify_session_kind.py` is the operator entry point, DRY RUN
BY DEFAULT, and it prints those negative controls on every run.

**THE 305 UNKNOWNS ARE AN ERA, NOT A GAP, AND THEY STAY IN THE LISTS.**
Every one was written by claude <= 2.1.77, which predates the
`entrypoint` field; the earliest confirmed scheduler run is 2.1.121 and
the earliest confirmed headless run is 2.1.198. The corpus holds NO
confirmed automated run from that era to derive a marker from. NULL and
`unknown` both list, because every reader excludes on `kind='automated'`
ALONE - not having looked is not evidence of automation.

An imported row has no `tmux_name`, epoch, `agent_type` or `model`, none
of it invented, so `GET /sessions/restart/preview` cannot ADDRESS it.
`session_imported_restart.py` + `imported_restart_routes.py` are the path
that can: keyed on `session_uuid`, a restart CREATES a session with
`--resume <uuid>` and `reuse_session_id` on the imported row. The launch
directory is MEASURED across every spelling, because `--resume` finds the
file only under the slug of the LITERAL cwd; a measured absence refuses,
`unchecked` never does.

## The two session-scoped menus, and where each one lives

They are split by JOB and the rule is learnable: one moves content across
the terminal's boundary, the other configures the session. They share
their plumbing (`client/js/fab-menu.js` builds the dropdown,
`client/js/anchor-popover.js` places it) and nothing else.

| Control | Rows | Surface |
|---|---|---|
| `#terminalToolsBtn` | copy output, paste from clipboard, attach file | floating button, bottom row slot 0, **phone only** |
| `#sessionEditorBtn` | session theme, detach session | a button in the header's `.controls` row, beside the file editor |
| `#slash-commands-btn` | opens `#slash-commands-modal`: every slash command, grouped, with a description and a starred-favorites row, live-filterable | floating button, bottom-left corner, **phone only** |

**THE TOOLS BUTTON IS MOBILE ONLY, ON THE D-PAD'S BREAKPOINT.** One media
query in `terminal-tools.css` hides the trigger AND its menu above 769px,
which is the same line `styles.css` already uses to make
`.dpad-float-button` touch-only. They sit in the same row, and two
controls in one row that vanish at two different widths is how that row
ends up with a hole at some third width nobody tested. The app's OTHER
"mobile" number, `MOBILE_MAX_PX = 700` in `session-sidebar-pin.js` and
`config-drawer-pin.js`, answers a different question - is there room to
dock a panel - and is deliberately not reused. It is pure CSS because a
JS width check paints the button on the first frame and removes it once
the script runs.

**AND DESKTOP LOSES TWO OF THE THREE ROWS, WHICH IS RECORDED RATHER THAN
PAPERED OVER.** Traced before the change shipped: `paste from clipboard`
is fully covered on a desktop (xterm's own cmd+V, plus the capture-phase
handler in `terminal.js` that uploads a pasted FILE and injects its path).
`copy output` - the whole-scrollback sheet - and `attach file` - the file
picker - have NO other desktop entry point: `CopyOutput.open` has exactly
one caller and the hidden `#cloude-image-attach-input` is clicked from
exactly one row, and there is no drag-and-drop handler anywhere in
`client/`. cmd+C still copies a mouse selection, which is a different
job. Adding replacement desktop UI is a separate decision.

**THE SESSION EDITOR IS A HEADER BUTTON, AND THE TOP-RIGHT RAIL IS GONE.**
It was a 45px FAB pinned over the terminal's top-right corner until the
owner asked for it "up into the menu next to the folder one". The move is
a MOVE: it carries `.btn-icon`, the class `#configEditorBtn` and the
kebab carry, so its size, gap, hover, focus and tooltip come from the
header rather than from anything written for it. `.session-editor-fab`,
the `--fab-top-edge` token and its `ios-chrome.css` safe-area pair were
all DELETED, not overridden - an orphan token is how a retired layout
gets revived by accident.

**SCOPE IS THE ONE THING THAT MOVE COULD LOSE, AND IT IS AN ALLOW-LIST
NOW.** `.controls` mounts on every screen, including the launchpad and
the archive where "session theme" and "detach session" name nothing. The
floating version got its scoping from a DENY-LIST in
`terminal-tools.css` naming the three sessionless screens, and that list
had already had to be amended once - when the archive screen arrived and
the FAB painted a 45x22px overlap across its Export label.
`client/css/session-editor-header.css` names the ONE screen instead
(`body:has(#terminal-screen.active)`), so a fourth sessionless screen
cannot leak it. That file declares `display` and nothing else; a colour
in it would be a header button restyled somewhere the header cannot see.

**THE HOME HEADER'S CENTRING SURVIVED BECAUSE THE BUTTON IS HIDDEN
THERE.** `.header--home` centres the launcher title against
`--home-header-flank-w`, a token mirroring `.controls`' real width, and
`header-menu.js` is explicit that a third INLINE control is a layout fact
rather than a list entry. This one is `display: none` on the home screen,
so the token needs no new branch. Change that gate and you have to
revisit the token. Measured in headless Chrome at 330px: the four header
controls occupy x 140-318 of a 330px header at `--control-size` 40 - the
480px breakpoint's value, not the 768px one - with no overflow, and the
title elides into what is left.

`tests/test_mobile_only_fab_and_header_editor.node.mjs` RESOLVES the
cascade at a given width rather than grepping the source, so it answers
"is the button on screen at 330px" instead of "does the file contain this
string". It carries a control (the d-pad, unchanged) and refuses loudly
on any selector its small matcher cannot read.

**A THIRD FLOATING CONTROL FOLLOWED THE SAME RULE: `#slash-commands-btn`,
THE ROUND "/" BUTTON, BOTTOM-LEFT.** The owner's request, verbatim: "this
button needs to be removed on desktop view just like the clipboard one."
`client/css/slash-commands-fab.css` is the same one media query, same
769px line, hiding the button AND `#slash-commands-modal` - the panel it
opens - so a hidden trigger never leaves a still-reachable panel behind.
It is its own small file rather than an addition to `styles.css` (already
over this project's line-count guideline) or to
`slash-command-chips.css` (styles the favourites row INSIDE the modal,
not the modal or its trigger).

**DESKTOP LOSES SOMETHING REAL HERE, NOT NOTHING.** Typing `/` straight
into the terminal still reaches claude's own CLI, which is a genuine
slash-command entry point - but it is not the same feature. The modal
this button opens lists every available command GROUPED, each with a
short description, plus the user's starred favourites and live filtering
as they type; typing `/` in the terminal gives none of that on its own.
Hiding it was the explicit ask, so it is hidden regardless - this is
recorded so the gap is a known decision rather than a surprise.

`tests/test_mobile_only_fab_and_header_editor.node.mjs` proves the
button's own visibility the same way it proves the tools FAB's, by
resolving the cascade. It CANNOT do that for `#slash-commands-modal`
through the same element-matching path: modelling the modal with its
real classes (`modal`, `active`) trips the resolver's selector grammar on
unrelated descendant-combinator rules in `styles.css` (`.modal
.modal-overlay`, `.slash-commands-modal-content .modal-header`) purely
because "modal" is a common substring, not because anything is wrong. So
that one assertion reads the flattened CSS text directly instead - the
same style `tests/test_terminal_tools_menu.node.mjs` already uses for the
tools FAB's menu - and confirms the `#slash-commands-modal` rule exists
exactly once, sits inside a `(min-width: 769px)` block, and carries
`display: none !important`.

<<<<<<< HEAD
## The string layer, and the one catalog rule

Every user-visible string comes from ONE catalog that BOTH clients read. Full
model in `.claude/notes/i18n-design.md`; the rule is that there is no second
table, ever, for any reason.

| Piece | File |
|---|---|
| The default catalog, data only | `client/js/i18n/catalog.en.js` |
| Plural selection and interpolation, PURE | `client/js/i18n/format.js` |
| The pseudo-locale, derived from en | `client/js/i18n/pseudo.js` |
| The locale registry, where a second locale is added | `client/js/i18n/catalogs.js` |
| Locale ladder, `t()`, missing-key behaviour | `client/js/i18n/runtime.js` |
| Publishes `window.CloudeI18n` and `window.CloudeLabels` | `client/js/i18n/boot.js` |
| Shared sentence assembly, one per screen | `client/js/labels/` |
| The reactive accessor for Svelte | `web/src/lib/i18n/index.svelte.ts` |

**THE CATALOG IS DATA, NOT CODE, AND THAT IS LOAD-BEARING.** No functions in
values, no template literals, no TypeScript in the file. It is read by the
legacy browser client, the Svelte bundle, vitest and the node suite, so a value
that can RUN is a value that can reach for something one of those four does not
have. It also has to convert to a Python dict by inspection, because the server
emits user-visible prose too and bringing it into this same key namespace later
is only cheap while that stays true. Server strings are OUT of scope today for a
reason that is about data rather than effort: toast bodies are STORED, so
translating at write time is wrong and translating at read time is a schema
change.

**KEYS NAME WHAT A STRING MEANS, NEVER WHERE IT APPEARS.**
`session.summary.none`, never `sidebar.groupheader.emptylabel`. Slices 2 to 7 of
the Svelte migration rewrite the screens these strings sit on, and a key that
names a screen dies with it. Keys are FLAT and dotted so `grep -rn` finds every
use across both trees, and because a nested catalog invites
`t('session.status.' + key)`, which makes the extraction guard impossible to
write.

**NO LIBRARY, AND CSP IS WHY, NOT TASTE.** Every ICU MessageFormat runtime
compiles a message into a function and `script-src 'self'` refuses
`new Function` and `eval`. `Intl.PluralRules` and `Intl.NumberFormat` are
already in the browser and already correct for every locale CLDR covers. A
plural message is an object keyed by CLDR category with `other` mandatory;
interpolation is `{name}` and one replace pass, with no expressions inside the
braces, because a mini-language in a message is the road back to a compiler.
**THE ZERO CASE IS CHOSEN BY THE CALLER, NOT BY THE PLURAL RULE**:
`Intl.PluralRules('en').select(0)` is `other`, so a plural set alone renders
"0 sessions", which is grammatical and is still the wrong copy. "no sessions" is
a DIFFERENT message.

**A MISSING KEY RENDERS THE KEY ITSELF, LOUDLY, AND NEVER THROWS.** An empty
string is invisible and loses a label for a release; `???` is visible and
unattributable; the key names itself, so a screenshot of the bug is the fix. It
is reported on `console.error` in production too, deduped so a key missing on a
two-hundred-row list logs once. The same rule covers a missing runtime: a legacy
caller with no `globalThis.CloudeI18n` gets keys back and NEVER a second copy of
the strings, because a fallback table is the dual path this exists to prevent
and a fallback that works is one nobody notices is being used.

**ORDERING IS GUARANTEED BY THE SPEC, NOT BY LUCK.** `boot.js` is a same-origin
`<script type="module">` in `client/index.html`, above the bundle's tag. Module
scripts are deferred and run in document order, so `window.CloudeI18n` exists
before `app.js` evaluates and before `DOMContentLoaded`. The classic scripts
above both run FIRST, which is why every legacy consumer reaches for `t()` at
RENDER time and never while it is being defined. It is kept out of the Svelte
bundle deliberately: copy must not depend on the newest thing, and nothing about
the legacy tree's strings changes on the day slice 7 deletes `launchpad.js`.
The Svelte tree ADOPTS that instance rather than building one, because two
instances are two current locales.

**LOCALE IS BROWSER-LOCAL, THROUGH A LADDER, AND THAT IS A DECISION.**
`localStorage['cloude.locale']`, then `navigator.languages` prefix-matched, then
`en`. Not a server setting, because it must resolve SYNCHRONOUSLY at first paint
and a setting arriving on an async config fetch paints the wrong language and
then flips. The ladder is the seam: a server preference later is one rung at the
top plus a `setLocale()` when config lands.

**TWO GUARDS, BECAUSE NEITHER COVERS THE OTHER'S GAP, AND IT WAS MEASURED.**
The pseudo-locale (derived from en, so it cannot go stale) wraps and LENGTHENS
every string; `coverage.test.ts` requires each rendered sentence to be a
balanced bracketed span AND to be built from an exact count of catalog messages,
and separately scans the ported sources for literals that read like sentences.
Mutation-proven 2026-09-10: a literal returned at the top level fails all three
checks, but **a literal interpolated INTO another message passes the span check**
because the outer message wraps it, and is caught only by the count assertion
and the source scan. `PORTED_FILES` in that test is the list a slice APPENDS TO;
a file not on it is not covered.
=======
## One navigation generation, and what a completion is allowed to write

**A COMPLETION MAY ONLY WRITE TO SHARED UI STATE WHILE ITS NAVIGATION IS
CURRENT.** `client/js/navigation-generation.js` is the whole mechanism: a
monotonic counter, `begin(target)` / `current()` / `isCurrent(token)` /
`keep(token, what)`, no dependencies, loaded first in `index.html`. Every
entry path captures a token SYNCHRONOUSLY at the user gesture, before its
first await, and checks it immediately before the write it cannot take
back. A stale token DISCARDS, silently, with a debug log - never a retry,
never an error, and never `Router.rejectTarget()`'s banner, which means
"this URL names nothing" and not "you went somewhere else".

**A COUNTER, NOT A TARGET IDENTITY.** Click a session, click away, click
back: comparing session ids lets the FIRST click's in-flight work satisfy
the third, and the screen it would paint into was torn down in between.
`tests/test_navigation_generation.node.mjs` drives that exact sequence
against the shipped sidebar module.

**THE ENTRY PATHS ARE PROVABLY ALL OF THEM, because two functions are the
choke point.** `TerminalController.connectToSession` and
`reconnectToExistingSession` have EXACTLY ONE caller each -
`App.showTerminal` and `App.returnToExistingTerminal` - so the complete
set of ways into a session is the callers of those two plus the screen
changes that leave one. Six declare an intent: the conversation sidebar's
`activateRow`, the launcher's `_returnToActiveRunningSession`, the five
launchpad gestures that dispatch `session-created`
(`_handleAttachRunningSession`, `createConsoleSession`,
`_createNewSessionInner`, `connectToExistingSession`, `selectProject`),
`SessionRestartReturn.reopen`, `ToastNavigate.go`, and the router's
`deliverTargetToLaunchpad`. `App.showLaunchpad` and `App.showAuth` begin
one too, because LEAVING a session is a navigation and is the half that
is easy to forget - but ONLY when `currentScreen` is already set. A BOOT
PAINT IS NOT A NAVIGATION: `Router.init()` runs while `App.init()` is
still awaiting `verifyToken()`, so on a cold load of `/session/<name>`
the router has already declared the deep link's intent and
`openProjectByName` is already resolving it by the time App paints the
launcher, and an unconditional bump there would supersede the very target
the user typed.

**THE TWO `App` ENTRIES READ THE GENERATION AND NEVER BEGIN ONE, and the
asymmetry is the design.** Bumping the counter inside `showTerminal`
would let a caller that ALREADY lost the race mint itself a fresh win a
few awaits later. The five `session-created` dispatchers carry their
token in `detail.nav` and `app.js`'s ONE listener is the only thing that
checks it, so a seventh dispatcher cannot invent a different rule; a
dispatcher carrying no token falls through to `showTerminal`'s own read,
which is exactly the pre-existing behaviour.

**NOT ON A SYNCHRONOUS PATH.** A check between a gesture and a write with
no await between them costs a comparison, buys nothing, and tells the next
reader there was a race where there was none. That is why
`ThemeNavigation.applyForTarget()` takes no token: it is synchronous, and
the staleness it could suffer is its CALLER's, guarded at the top of
`showTerminal` / `returnToExistingTerminal`. The themes registry's own
replay gate (`6f79e90`) is untouched and deliberately re-resolves on drain
rather than replaying a captured id.

**THE TERMINAL RECORDS THE TOKEN IT BOUND UNDER**, as `_navToken`, and
`_navCurrent(what)` is the one predicate every deferred action in that
file asks. It gates the connect on both entry paths through
`_connectWhenReady` - a session switch landing before the socket opens
must not let the older connect open one the newer then has to abandon
mid-handshake - and it is the definition of "old" for the write queue and
the reconnect scheduler below. A missing module answers TRUE: the token is
a correctness guard, never a dependency, and a load-order accident must
not stop the terminal working.

**AND THE INPUT DIRECTION IS THE SAME RULE, ONE LAYER DOWN.**
`bd9a2b2` and `terminal-frame-guard.js` keep one session's OUTPUT out of
another's terminal. `client/js/terminal-input-ownership.js` is the INPUT
half, which is worse: output in the wrong pane is confusing, input in the
wrong pane RUNS A COMMAND. The unambiguous case was the file paste -
`terminal.js` intercepts it, uploads the blob and inserts the returned
absolute path, and nothing between those two checked the user was still
where they started, so an upload finishing after a switch inserted a path
into a DIFFERENT agent's prompt.

**CLAIM AT THE GESTURE, CHECK AT THE WRITE**, and that is the half that
is easy to get backwards. `claim()` taken at COMPLETION time reads
exactly like a check and is a no-op, because by then the session HAS
changed and the value compared is itself - the same shape as the
`ensure_pipe_pane` guard whose only exercised caller set the flag it
checked. Five paths take a ticket, and every one has an await, a network
round trip, or an open panel between the gesture and the write: the
desktop paste interceptor, the attach-file picker's `change` handler,
`pasteFromClipboard`, the paste fallback SHEET (it stands on screen while
the user finds their clipboard) and the slash commands MODAL (nothing
closes it on a session switch, so a pick made after one used to run in the
pane the user left).

**THE KEYBOARD, THE SHIFT+ENTER CHORD, THE D-PAD AND `_writeSynthetic`
TAKE NONE, deliberately.** There is no await between the key and
`ws.send`, and the socket is swapped synchronously by the session entry
paths, so the socket held at the write IS the session's. The copy sheet
takes none either and that was MEASURED rather than assumed: `CopyOutput`
reads the xterm buffer and writes the SYSTEM clipboard, and never writes
into the terminal at all. `tests/test_input_ownership.node.mjs` pins both
absences, so a later decorative check has to argue with a test.

**A STALE TICKET DROPS AND SAYS SO.** It never queues and never replays -
the user meant that paste for the session they were in, and delivering it
later out of context is not better than dropping it. The report goes
through `Terminal#_showStatusPill`, which routes to `FabMenu.notify`, the
app's single status-pill path; a seventh toast shape would be the bug.
`Terminal#insertText(text, ticket)` is the ONE write point for every
text-shaped path and is the last line of defence, and `injectText` checks
the ticket BEFORE its "clipboard is empty" and "terminal not connected"
reports, because those would be misleading answers to "why did my paste
vanish". A dropped upload also raises no attachment card.

**AND THE WRITE QUEUE IS BOUNDED AND IS RELEASED ON A SWITCH.**
`Terminal#enqueue` pushed every incoming chunk with no size or count
limit, and `flush()` re-scheduled itself while the queue had anything in
it - so bytes that arrived for the OLD session were still being written
after navigation began, and the `term.reset()` that followed raced a write
xterm had already accepted. That is the half-cleared screen showing the
previous session's tail. `client/js/terminal-write-queue.js` is the
policy; terminal.js keeps the queue.

**THE TWO HALVES OF THE QUEUE ARE DIFFERENT THINGS, and the teardown turns
on that.** Bytes still in `this.queue` are OURS - nobody has seen them and
they belong to the outgoing session - so they are discardable. Bytes
already handed to `term.write()` belong to XTERM, and resetting under an
accepted write is undefined. So `_releaseQueueForSwitch()` is two steps in
one order: discard what is ours, then AWAIT the in-flight write's own
callback, and only then reset. NO TIMER - guessing when a write finished
is how you reset under one anyway, and if the callback never arrives the
terminal is being torn down regardless. It runs only when the reconnect
buffer's plan is not `keep`, because a `keep` is the SAME session and its
bytes are still its own. `_writeInFlight` is cleared in exactly ONE place,
inside that callback, and a test counts it: a second clear would let a
switch wait forever on a resolver nobody calls.

**A BYTE BUDGET, NOT A CHUNK COUNT**, because chunk sizes vary by four
orders of magnitude between a keystroke echo and a `cat` of a large file.
`MAX_QUEUED_BYTES` is 4 MiB, the SAME number the server-side viewer queues
use - one number in the system beats two separately tuned ones - and the
point of the bound is to make the worst case FINITE, not fast.
`MARKER_RESERVE` (128 bytes) is held back so the drop marker itself fits
INSIDE the ceiling; without it the queue lands a marker's worth over on
every shed, and a bound that does not hold is a number nobody can reason
from.

**DROP FROM THE FRONT, WHOLE CHUNKS, AND SAY SO.** The newest output is
what the user is looking at, so shedding the tail would throw away the
very thing the pressure is producing. Whole chunks because slicing to hit
the budget exactly would cut an escape sequence in half, which does not
corrupt one cell - it puts the VT parser into a state that garbles
everything after. Whole chunks are not a guarantee of alignment either
(one sequence can straddle two frames), which is exactly why the drop is
ANNOUNCED: a terminal that silently loses ANSI bytes lies, and that is
worse than a slow one. `_queuedBytes` is a running total rather than a
re-sum, so admission is O(1) per chunk instead of growing precisely when
the queue is longest. The scrollback follow decision is still sampled
BEFORE the write, where `terminal-scroll.js` put it, and a test pins that
it did not move.

**AND THE AUTO-RECONNECT LADDER NEVER RECONNECTED, WHICH WAS MEASURED
BEFORE ANYTHING WAS CHANGED.** `attemptReconnect()` set
`isReconnecting = true`, charged the budget and scheduled
`connectWebSocket()`, whose first line was
`if (this.isReconnecting) { this.stopReconnecting(); return; }` - so the
retry it had just fired hit that guard, RETURNED without opening a socket,
and `stopReconnecting()` put the budget back to zero on its way out.
Driven against the shipped class: one timer, ZERO sockets, budget 0, and
the user saw `reconnecting, attempt 1 of 5` then silence, not even the
failure message, because `attemptReconnect()` was never re-entered.
Present since the initial commit (`a82cb57`). It is why the 4404 and
outage recoveries were bolted on beside the general mechanism: they call
`reconnectToExistingSession` directly and never went through it. Full
model in `docs/reconnect.md`; the rules are in
`client/js/terminal-reconnect-policy.js`.

**TWO QUESTIONS, TWO COUNTERS, ONE WRITER EACH.** `reconnectAttempts` was
zeroed in five places and compared in one, and any reset on a path that
also schedules a retry makes the ceiling unreachable - `stopReconnecting()`
is called from the exhaustion branch ITSELF, so five failures printed the
message and handed out five more attempts, forever. It is the BUDGET now
and `_resetRetryBudget()` is the only thing that zeroes it, for two named
reasons: initialization success, and a different session being bound
(which is not a reset of one counter but the start of another's - a fresh
session must not inherit an exhausted budget). `_attemptsSinceProgress` is
the BACKOFF and every attempt moves it; one counter for both forced a
choice between a budget that never fills and a delay that never grows.

**THE BUDGET IS SPENT ONLY BY A MEASURED FAILURE**, the socket never
opening. An UNKNOWN outcome costs nothing and neither does a pane measured
`awaiting_startup_prompt`: not having measured a success is not evidence
of failure, and charging for one gets a healthy session on a slow machine
declared unreachable. Same asymmetry as `resolve_startup_gate` rung 5
versus rung 7. The cost, stated rather than hidden: a server that accepts
and immediately closes is retried forever - but the backoff still reaches
its 16s ceiling, so it is a slow poll and not a spin, and declaring a
healthy session dead is the worse failure.

**INITIALIZATION SUCCESS IS THE FIRST BYTES.** The socket opening, the
dimension handshake completing and the pane sending something are three
different facts and only the third proves the session is talking - a pane
on its folder-trust dialog opens a perfectly good socket and says nothing.
The outcome reuses the server's `ready` / `awaiting_startup_prompt` /
`unknown` vocabulary rather than inventing a fourth spelling, and `ready`
still claims only "not blocked on a startup prompt", never "healthy". The
unreachable message is said ONCE and stays said; `_unreachableReported`
clears on the same evidence that refills the budget.

**FOUR NAMED BRANCHES, ONE SCHEDULER.** `_scheduleRecovery(closeCode)`
replaces three guard clauses that sat in front of a mechanism none of them
ever reached: `refresh_auth` (4401), `re_resolve_by_name` (4404, once per
episode), `wait_for_server` (an abnormal close `ServerRestartWatch`
recognises) and `retry_same_id`. And a reconnect carries the navigation
token: sixteen seconds is ample time to move to another session, so a
retry stands down rather than opening a socket nobody is looking at.
`terminal-reconnect-policy.js` is a REAL DEPENDENCY of terminal.js - a
sandbox without it takes the plain retry for every close, which is how
`tests/test_restart_reconnect.node.mjs` started failing on a harness gap
rather than a code change.

## The connect is measured, not slept, and the pane says when it can hear

Four things sat between a click and a usable terminal, and every one of
them was a guess about time rather than a reading of a condition.

**THE 500 ms BEFORE THE CONNECT WAS WAITING FOR A CSS TRANSITION THAT
DOES NOT EXIST.** Two unconditional half-second timers scheduled
`connectWebSocket()`, one on each entry path, and the comment above one
of them justified it verbatim as giving "the terminal screen transition
time to settle". There is no such transition. `.screen` swaps on
`display: none` / `display: flex` (`client/css/styles.css`), and
`display` is not an animatable property, so the class toggle fires no
`transitionend` on `#terminal-screen`, on any ancestor or on any
descendant. Every rule in all 49 stylesheets whose selector can match
`.screen`, `#terminal-screen`, `.terminal-container` or `#terminal` was
resolved before this was changed and NONE declares a `transition` or an
`animation`; the two `body.session-sidebar-pinned .screen` /
`body.config-drawer-docked .screen` padding rules carry comments saying
their transitions were deliberately removed so the geometry lands in the
same frame the class toggles. **A `transitionend`-based readiness gate
would therefore have waited forever on an event that cannot fire**, which
is gotcha 9 wearing a different hat, and it was the obvious design.

Nothing server-side needed the delay either: `_register_session` writes
`sessions[id]` before both the create and the adopt responses are built,
so a client can never hold an id the WebSocket route's 4404 check cannot
find, and `pipe-pane` is started inside `TmuxBackend.start()` before that
same response returns, so an earlier attach cannot miss pane output.

**WHAT IS REAL IS THE MEASUREMENT, AND IT IS NOW ASKED FOR.** The fit
sequence was `guardedFit`, sleep 50 ms, `guardedFit` again - the second
attempt existing because the first might have been taken before layout
settled, which is a real concern answered with a guess.
`client/js/terminal-readiness.js` retries on `guardedFit`'s own verdict
instead: stop the instant it is satisfied, give up on a bound, warn and
connect anyway. Measured deterministically (no server, no browser, so no
contention): **0.157 ms when the guard is satisfied first try**, against
the 50 ms that was spent unconditionally; **125 ms when the condition
clears at 120 ms**, which the old code could not react to at all; and
**511 ms in the worst case**, because `BOUND_MS` is deliberately the
500 ms it replaces, so the degraded path costs exactly what shipped. The
xterm load wait moved into the same module and answers in **0.388 ms**
when the bundle is already there.

**DO NOT REMOVE THE BOUND.** An unbounded wait for a measurement turns a
stylesheet that never arrives into a session that never opens, and the
server's dimension handshake reshapes the pane on the first real paint
regardless - the same path a rotation already takes. Every wait in that
module is polled on a TIMER and never on a frame, for gotcha 9's reason.

**`terminal.ready` IS THE ONE POSITIVE STATEMENT THAT THE PANE CAN TAKE
INPUT, AND THE WINDOW BEFORE IT IS DEAF RATHER THAN SLOW.** The attach
handshake in `src/api/websocket.py` opens the socket, asks the client for
its dims, and sits in a receive loop that DISCARDS every binary frame
arriving before that reply. So "the socket is open" and "the pane can
hear" have never been the same fact, and nothing on the wire said which
one you had: a keystroke typed during a connect was destroyed by the
server with no trace, and one typed before the socket existed was
destroyed by the client's own `readyState === OPEN` check.

The message is sent ONCE, after the dims handshake, after the settle,
after `paint_on_attach` and after any configured startup command. Sent
earlier it would be exactly as useless as no message, and it would look
like it worked. It is **NEVER WITHHELD** - a startup command that failed
does not make the pane unable to receive input - so it carries
`startup_command` (`issued` / `none` / `failed` / `unknown`) rather than
gating on it, and `flush_pending_terminal_command` returns that word
instead of `None` because it swallows its own write failures by design.
`failed` and `none` must never collapse: one means the prompt is bare
because nothing was asked for, the other because what was asked for did
not happen.

**IT IS ADDITIVE, AND THAT PROTECTS ONLY ONE DIRECTION.** Nothing waits
for a reply and nothing is gated on the client having read it, so an old
client behaves exactly as it did before the message existed. A NEW CLIENT
AGAINST AN OLD SERVER is the other direction and is the worse failure:
without a bound it would hold every keystroke forever, a terminal that
silently accepts no input with nothing on screen saying why. So
`READY_TIMEOUT_MS` (4 s, armed from the socket OPENING) delivers the held
batch and falls through to passing input straight on. DELIVERED, not
dropped - the socket is open and the user typed those bytes for this pane.

**THE PRE-READY BUFFER IS KEYED BY CONNECTION GENERATION, NOT BY SESSION
ID** (`client/js/terminal-input-buffer.js`). A reconnect to the SAME
session is a NEW connection, and input typed before a socket dropped must
not be replayed into the one that replaces it; a session id cannot
express that and a monotonic counter can. It is deliberately NOT the
navigation generation, which does not move on a reconnect. No local echo,
ever: painting held input would show the user text the pane has not
received, and if the batch is later rejected the terminal is lying about
a command that never ran.

**64 KiB, AND OVERFLOW REJECTS THE WHOLE UNSENT BATCH**, announced
exactly once - not the newest, not the oldest, because half a command
line is a DIFFERENT command the shell will happily run. That is the
opposite rule from `terminal-write-queue.js`, which sheds its oldest
chunks and carries on, and the asymmetry is the point: output is a record
of what already happened, so a gap in it is a gap in a transcript; input
is an instruction that has not happened yet, so a gap in it is a
different instruction and no marker makes that safe. An ambiguous
disconnect DISCARDS and never replays, because re-sending what we cannot
prove was delivered risks running a command twice.

**THE RESIDUAL COST, SAID OUT LOUD:** a keystroke typed after the dims
handshake but before `terminal.ready` is now held until the paint, where
it used to sit in the socket and be processed when `receive_messages`
started. That is bounded by the attach settle plus one `capture-pane`,
and it buys back everything typed DURING the handshake, which the server
was destroying outright.

**AN ISOLATED CHUNK NO LONGER WAITS A FRAME.** `enqueue` scheduled every
chunk on `requestAnimationFrame`. That frame coalesces a BURST, which is
real and worth keeping; paying it for a single chunk with nothing to
coalesce with costs up to a whole frame on the keystroke echo. It now
writes straight through when no write is outstanding and falls back to
the frame when one is, so the second chunk of a burst waits and the
re-schedule merges everything into one `term.write` per frame exactly as
before. `flush` re-raises `flushing` when it re-schedules, so that flag
means "scheduled OR in flight" and a chunk arriving in the gap between
the write callback and its frame cannot write UNDER a flush already on
its way. `flush` also refuses on a null terminal now: that window existed
before and was one frame further away.

**ONE OWNER FOR THE MEASUREMENT, ONE FOR THE SHIP.** There were nine
`fitAddon.fit()` call sites across five files. Every measurement now goes
through `TerminalMetrics.guardedFit` - including `currentGrid`, whose raw
fit fed the pane's BIRTH geometry, and the `request_dims` handshake - and
every ship goes through `TerminalLayout`'s coalescer or one of two
explicitly named handshake sites. Four raw fits remain and all four are
named in `tests/test_fit_ownership.node.mjs`: the two inside `guardedFit`,
which ARE the measurement, and three module-missing fallbacks where an
unfitted terminal is worse than an unguarded one. That test COUNTS rather
than times, because a duplicate fit that happens to be fast is still a
duplicate.

**THE SLASH PALETTE IS NOT A PROPERTY OF THE SOCKET.** Both entry paths
did `await SlashCommandsModal.init(...)` on the line above the connect,
and `init` makes two server round trips. `client/js/slash-commands-boot.js`
starts it and is never awaited; it carries the navigation token, because
a palette fetched for session A landing after the user is in B would
populate B's menu with A's agent's commands, and a slash command run in
the wrong pane RUNS A COMMAND. One fetch per working directory; a failure
is NOT cached as an answer.

**AND TWO MORE 500 ms TIMERS WERE WAITING FOR SOMETHING THAT HAD ALREADY
HAPPENED.** `detachAndOpenProject` and `detachAndCreateNew` both slept
after `await window.API.detachSession()` to "let the server finish
clearing its backend handles". It already has: `detach_session` awaits
`detach_current_session`, which awaits the idle watcher's stop and the
reader task's cancellation before the handler returns, so the response the
client had already awaited IS the completion signal. Both copies went;
fixing one of a pair is how the other survives. Each re-open now has its
own `try`/`catch`, because the timer used to ESCAPE the surrounding block
and an error in the re-open was an unhandled rejection.

**THE WALL-CLOCK END-TO-END NUMBERS ARE NOT SETTLED.**
`scripts/perf/run_baseline.py --sessions 1 --quick` was run four times
either side of this change on a box at load average 11 to 27 with 45
concurrent agent processes, and `session entry`, `session switch` and
`launch` are single samples per run there: they spanned 763 ms to
10,480 ms for one arm of one metric, a 13x spread, so nothing in that
group supports a conclusion in either direction. Typing echo has n=4 and
moved the right way (p50 warm 22.1 / 21.3 ms before against 19.0 /
11.2 ms after) but on that box that is corroboration, not proof.
RE-MEASURE ON A QUIET MACHINE before quoting any figure from this
paragraph, and prefer the deterministic numbers above, which no amount of
load can move.
>>>>>>> 6012467

## Gotchas that have cost real time

1. **Wrapper vs `.session`.** Described above. When a field reads as missing,
   check which level you are on before you go looking in the backend.
2. **Hook events are unordered, duplicated and droppable.** A state machine that
   assumes ordering works on your machine and drifts in the field. Floor the
   counters, make every transition idempotent.
3. **An adopted session is not a launcher "project".** Deep-link resolution walks
   launcher projects first, then live/adopted sessions
   (`client/js/router.js`, `Launchpad.openProjectByName()`). Resolving only
   against projects made a deep link spawn a duplicate session next to the one
   the user was already in. Unresolvable targets go through `rejectTarget()`, one
   banner, one `replaceState` back to `/`, never a silent bounce.
4. **The tmux socket is load-bearing.** Anything that shells out to `tmux`
   without `-L cloude` is talking to the user's personal tmux server. That is how
   you kill someone else's work.
4b. **A session id is not a tmux name, and deriving one from the other loses
   sessions.** `build_backend` with no `session_name` rebuilds
   `cloude_<slug(session_id)>`, which for an adopted id yields
   `cloude_adopted_cloude_Foo` - a name no socket has ever carried. It then fails
   the liveness test and `_clear_stale_metadata` throws the pointer away (it
   keeps the owned set; see `OwnedTmuxLedger.drop_session_pointer`). Pass the
   STORED `tmux_session`, and keep the derivation as the fallback for pre-field
   metadata.
5. **A uuid on the row is not evidence a transcript exists, and a missing
   transcript is not evidence the conversation is gone.** Five rows on the
   developer's box hold a phantom uuid minted by `--fork-session` while the
   real conversation lives on an archived twin row. Check the twin before
   telling anyone their history is lost.
6. **cwd spelling splits a session in two.** `~/Development` is a symlink into
   iCloud and Claude Code derives its transcript directory from the LITERAL cwd
   string, so two spellings of one directory make two transcript directories,
   two project rows and, as above, two session rows. Always write the long
   iCloud spelling, in code and in documents. **Qualified 2026-09-08:** the
   historic split in the data is real, and claude 2.1.263 resolves symlinks
   before slugging its transcript path, so `--resume` now finds a transcript
   from either spelling of the cwd and a NEW split cannot originate from
   claude itself. It is not fully fixed, though - this app's own project
   creation kept WRITING the short symlinked spelling into `working_dir`
   until `a4eeef1` closed that path today.
7. **`if (pinned) apply()` with no else leaves the last session's theme on
   screen.** A pinned theme bled across session switches because three
   copy-pasted restores in `app.js` and two session-entry paths each applied a
   theme and never reset one. A missing else is not a missing feature, it is
   state left over from the previous thing. There is now ONE total function,
   `applyForTarget()` in `client/js/theme-navigation.js`, and every navigation
   goes through it. Fixed in `a6b6b91`.
8. **A stale doc is worse than no doc.** A missing doc sends the next agent to
   read the code; a confidently wrong one sends it to write a bug. If you change
   behavior this file describes, update this file in the same change. If you find
   a claim here that reality contradicts, fix it and say so in the commit.
9. **A bare `await requestAnimationFrame` never resolves in a hidden tab.**
   A browser does not paint a backgrounded tab, so it never runs that
   tab's rAF callbacks; anything awaiting one hangs there permanently, not
   just slowly. `waitForFontsAndLayout()` suspended `connectWebSocket()`
   before it ever opened a socket, and two other call sites
   (`reconnectToExistingSession`, the adopt path) carried their own copies
   of the same bare wait, so fixing the first one alone changed nothing -
   only a live re-check in an actually-backgrounded tab caught the other
   two. Anything that must happen for a background tab (a websocket
   connect, a state clear, a save) must not wait on a frame; race it
   against a timer instead, the way `client/js/terminal-layout-wait.js`
   does, so the wait can delay the work but never cancel it.
10. **A synthetic hook aimed at a row id can set a tracker flag the pane's
    own claude can never clear, when that claude holds an adopted id.**
    `cloude_Media_Compression`'s pane process presents
    `CLOUDECODE_SESSION_ID=adopted:cloude_Media_Compression` on every real
    hook it fires, because tmux fixed that env var into the process at
    spawn and cannot rewrite a running one. A test's synthetic
    `PermissionRequest` landed on `ses_949a8585` instead - the id
    `tmux show-environment` hands back, and the one a script naturally
    reads - with no `toast_session_id_remapped` line, because the toast
    path only remaps when it recognizes the split; every REAL clearing
    hook from that pane kept arriving under the adopted id and clearing a
    key nothing was set on. The row painted `question` over a pane with no
    dialog open, indefinitely. The fix in `dfddbdc` does not chase a
    second remap: it re-verifies an open `permission_open` against the
    PANE itself once it has sat open past 20 seconds, on the theory that
    two ids can drift apart but the pane cannot lie about its own screen.
    Any new tracker flag keyed on a session id needs the same question
    asked of it: can this id and the pane's own id ever diverge, and if
    they do, is there a way back to ground truth that does not depend on
    either id being the right one.
