# The web/ build, the launchpad Svelte migration and the string layer: the record

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

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
| Its tests, incl. the equivalence proof | `web/src/lib/StatusLed.parity.test.ts` (the proof), `StatusLed.behaviour.test.ts`, `StatusLed.drift-guard.test.ts`, sharing `led-legacy-fixture.ts` |
| Slice 1's tests | `web/src/lib/launchpad/attribution.test.ts` |
| Slice 2's tests | `web/src/lib/launchpad/recent{,-actions,-chrome,-visibility}.test.ts`, `no-delete-wording.test.ts` |
| The emitted bundle, COMMITTED | `client/dist/app.js`, `client/dist/app.css` |
| Prove the committed bundle is current | `scripts/web-build-check.sh` |
| The terminal search panel and prompt rail (new UI on a still-legacy screen, not a launchpad slice) | `web/src/lib/terminal-search/{SearchPanel,PromptRail,PromptTick}.svelte`, `search-controller.svelte.ts`, `rail-model.svelte.ts`, `search-keys.ts`, `count-label.ts`, `search-host.ts`, `types.ts`, `mount-search.ts` |
| Its framework-free logic, kept in `client/js` on purpose | `client/js/terminal-prompt-scan.js`, `terminal-search-engine.js`, `terminal-history-load.js`, `terminal-search-deep-dive.js`, `client/vendor/xterm/xterm-addon-search.js` |

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
port agrees with what the porter remembered:
`web/src/lib/StatusLed.parity.test.ts`
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

**SEVEN SLICES DONE IS NOT A FINISHED MIGRATION, AND READING IT THAT WAY IS
THE MISTAKE THIS PARAGRAPH EXISTS TO STOP.** What those seven slices finished
is the LAUNCHPAD: the home screen, the launcher, the project tree and the
session lists. The rest of the app is still the hand-written tree, and it is
the larger half. Measured at `v1.4.0` and again at `b5de919`, identical at
both: 137 files under `web/src` (26 `.svelte`, 110 `.ts`, and `app.css`)
against 221 files under `client/js`, every one of them `.js` (205 at the top
level, 16 in `labels/`, `icons/`, `i18n/` and `themes/` - a bare
`ls client/js/*.js` answers 205 and silently misses the subdirectories), and
`client/index.html` loaded 155 `<script>` tags by hand beside the one
`<script type="module" src="/static/dist/app.js">` at the bottom of it.
Re-measured 2026-09-12 after the terminal search work landed: **152 files
under `web/src`** (29 `.svelte`, 122 `.ts`, and `app.css`) against **226
files under `client/js`** (210 at the top level, still 16 in the same four
subdirectories), and `client/index.html` now loads **159 `<script>` tags** by
hand. The bundle grew with it: `client/dist/app.js` is **220,084 bytes**
and `client/dist/app.css` is **4,960 bytes**. `client/js/launchpad.js` is
gone; `client/dist/app.js` and `client/dist/app.css` are committed.

**STILL VANILLA, AND NOT SCHEDULED**: the terminal and everything around it
(`client/js/terminal.js` and its family), the toasts
(`client/js/toast.js` and the modules beside it), the sidebar row menus
(`client/js/session-row-menu.js`), the restart picker
(`client/js/session-restart-picker.js`), the settings panels
(`client/js/settings-panel.js`, `settings-sections.js`) and the archive
screens. So the answer to "is the client Svelte now" is NO - it is BOTH, and
the first question about any client change is which tree owns that screen.

**AS OF 2026-09-12, ALL NEW UI GOES IN `web/`, EVEN ON A SCREEN THAT IS STILL
LEGACY.** The owner's ruling, verbatim: "full send into svelt. let's not fuck
around." That does not undo the paragraph above: a screen that is still
vanilla stays vanilla, and porting one wholesale is still "legacy or
compiled, never half of each." What changed is what a BRAND NEW control on
that screen is built in. It is Svelte from the day it is conceived, whatever
tree the rest of the screen lives in - the "never half of each" rule governs
a PORT, not a new addition sitting beside unported code.

The first case is the terminal's search panel and prompt rail, a wholly new
feature dropped onto the still-vanilla terminal screen
(`client/js/terminal.js` and its family are untouched otherwise): Svelte
components under `web/src/lib/terminal-search/` -
`SearchPanel.svelte`, `PromptRail.svelte`, `PromptTick.svelte` - plus the
pure and reactive modules beside them, `search-controller.svelte.ts`,
`rail-model.svelte.ts`, `search-keys.ts`, `count-label.ts`, `search-host.ts`,
`types.ts` and the mount seam `mount-search.ts`. It mounts through the SAME
one mount path every launchpad slice uses (`web/src/lib/mount.ts`, into
`#terminal-container`, the id `client/index.html` already gives the
terminal's own container) and is published on `window.CloudeWeb` as
`mountTerminalSearch`, `openTerminalSearch`, `toggleTerminalSearch`,
`terminalSearchIsOpen` and `unmountTerminalSearch` (`web/src/main.ts`).

Logic that has nothing to do with rendering a component stays
FRAMEWORK-FREE, in `client/js`, exactly where it would have lived before this
ruling: `client/js/terminal-prompt-scan.js` (reads xterm buffer cells
directly), `client/js/terminal-search-engine.js`,
`client/js/terminal-history-load.js`,
`client/js/terminal-search-deep-dive.js`, and the vendored
`client/vendor/xterm/xterm-addon-search.js`. None of those touch the DOM as
a component, so porting them into Svelte would buy nothing and cost a
rewrite of code that is already plain functions.

**THE STATUS LED IS THE ONE THING THAT LIVES IN BOTH TREES AT ONCE, ON
PURPOSE, AND IT IS NOT A DUPLICATION BUG.** `client/js/status-led.js` is still
loaded by `client/index.html` and still paints every legacy surface, while
`web/src/lib/led.ts` paints the compiled rows, and the contract between them
is BYTE-IDENTICAL OUTPUT proven by `web/src/lib/StatusLed.parity.test.ts`
against the
real legacy file in a `vm` sandbox. Delete or edit one of them alone and half
the app's lights change while the other half does not, which the parity test
is there to make loud. See "The `web/` build" above.

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
call site per surface, no dual path. `tests/test_session_restart_identity.node.mjs`
stubbed that NAMESPACE rather than `Launchpad._restartRecentSession`, because
stubbing the old method name would assert against a function nothing calls,
which is the quietest way for a test to stop testing. THAT SUITE IS GONE - a
later slice deleted it along with the surface it drove, and this pass did not
find a one-to-one successor for it under `web/src`. The lesson is what is
being kept here, not the file.

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
failed. THAT SUITE IS GONE TOO, deleted in `90a9e87` along with the legacy
render guard it drove; the measurement is kept because the mechanism is. The call site tests for the bundle and `console.error`s when it is
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
never ran - it surfaced in `tests/test_project_list_render_guard.node.mjs`,
since deleted in `90a9e87`, looking exactly like a repaint bug. A BARE `window` reference also THROWS
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
(`src/config/ui.py::UIConfig`, served on `GET /api/v1/features`). 1.2.1 then
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

---

## Carried forward 2026-09-13 from a concurrent session

These paragraphs were written into CLAUDE.md by another session while this
carve-out was in progress. They are kept here verbatim; CLAUDE.md carries the
rule in short form.

### Static asset keys, and the cancelled serve-time bundle

Two halves were planned 2026-09-13. **Half 2 - concatenating the legacy
`<script>` and `<link>` tags into serve-time bundles - was built and then CUT
the same day, because the owner is rebuilding the front end from scratch in
Svelte and a bundle whose only value dies with the current `client/js` tag
soup is throwaway.** The code was removed cleanly. Nothing under
`/static-bundle/` exists in the tree, and no rule anywhere should describe it
as shipped. **Half 1 shipped: content-keyed URLs and the cache headers.** It
survives the front-end rewrite untouched, because it keys whatever the served
HTML references and holds no opinion about what that HTML looks like.

- **OUTPUT NAMES ARE FIXED, `app.js` and `app.css`, no content hash**, because
  `client/index.html` is hand-maintained and names them. The cache correctness
  that buys is now a CONTENT KEY IN THE QUERY rather than a blanket refusal to
  cache, and the two rules are different - do not read one as the other.
  `src/core/static_asset_keys.py` rewrites the shell AT SERVE TIME so every
  same-origin `/static/` `src` and `href` carries `?v=<short sha256 of that
  file's bytes>`, and `NoCacheStaticFiles` (`src/main.py`) answers
  `public, max-age=31536000, immutable` for a `.js`/`.css` request whose key
  still matches. **EVERYTHING ELSE KEEPS `no-cache, must-revalidate`**: no key
  at all (a runtime `fetch`, a lazily injected `module-families.js` script, a
  theme's CSS, a theme's `effects.js` via `import()`) and, deliberately, a key
  that no longer matches - a bookmarked URL from an older build REVALIDATES
  rather than being told a year-long lie nobody can retract from the field.
  `index.html` itself is never immutable, because it is what hands out every
  other key. **Nothing is committed and there is no build step**: a key is
  derived from the file on disk and memoised on its `(size, mtime_ns)`, so
  editing a file and reloading serves it under a new URL with no restart.
- **THE MEASURED RESULT, IN HEADLESS CHROMIUM, 2026-09-13**: a fully warm
  cache was paying **218 conditional GETs answered 304** on every page load -
  65,400 bytes of pure header traffic for content already on the machine.
  After, **211 of the 218 assets are reused with zero bytes and no round
  trip**, and only **7 still revalidate**. A COLD load is unchanged at 218
  requests, by design - that was half 2's job and half 2 was cut. The seven
  that remain are the ES module graph `client/js/i18n/boot.js` imports
  (`i18n/runtime.js`, `i18n/format.js`, `i18n/catalogs.js`,
  `i18n/catalog.en.js`, `i18n/pseudo.js`, `labels/session-summary.js`,
  `icons/glyphs.js`), which are `import` specifiers INSIDE a JavaScript module
  rather than `src` attributes in HTML, so a serve-time HTML rewrite cannot see
  them - they are correct as they stand, since they always revalidate and can
  never go stale. Full method, the before/after servers, the CDP-versus-
  `transferSize` negative control and the cold-load table are in
  `/Users/Adam/Dropbox/llmScratch/perf-audit/static-assets.md`.
- **THE REWRITE'S OWN COST WAS PROFILED, NOT ASSUMED**, because it runs inside
  the `/` handler and its cost is terminal latency for everyone - the same
  defect class this file already records for the integrity pragma and the
  config-tree walk. `resolve()` is a `realpath` syscall walk done once per
  referenced URL; memoising it on `(url, client_dir)` took the median `/`
  request from **16.66 ms to 1.38 ms**. The first request of a process would
  still pay 27.6 ms to hash every referenced file, so
  `static_asset_keys.warm()` runs at import time in `src/main.py`, beside the
  existing `warm_static_gzip_cache()`, fail-soft: an unreadable shell costs the
  optimisation and never the boot.
- **WHY HALF 2 WAS CUT RATHER THAN SHIPPED.** It concatenated `/static/js/**`
  in shell order into `/static-bundle/legacy-N.js` and `/static/css/*.css` the
  same way, dropping 159 script tags and 52 stylesheet links to 12 and 3,
  refusing to fold in a file carrying a top-level `'use strict'` directive
  prologue, `import()`, `import.meta`, `document.currentScript`, or a
  `type="module"` / `defer` / `async` / `nomodule` tag, and refusing a CSS
  file outside `/static/css/` or carrying a relative `url()`, `@import` or
  `@charset`. All of that measured cleanly and worked. It was cancelled
  anyway, the same day, because the owner is rebuilding the entire front end
  in Svelte: every one of those 159 tags is `client/js`, which is on its way
  out, so a bundle for it is a bundle for code that will be deleted. The code
  was removed rather than left disabled, so this paragraph is the only record
  of it - a cancelled approach written down with its reason is useful, and a
  doc describing shipped code that is not in the tree is worse than no doc.
- **FILES**: `src/core/static_asset_keys.py` (the keys, the two memos, the
  HTML rewrite, the boot warm); `tests/test_static_asset_keys.py` (28 cases,
  every positive paired with a negative control); `src/main.py`
  (`NoCacheStaticFiles` asks that module for the header, `_render_index_html`
  runs the rewrite, the gzip cache keys on the rendered bytes rather than the
  template's stat); `src/core/static_serving.py` (an optional `fingerprint`
  argument so the precompression cache keys on the rendered output, not
  `index.html`'s mtime - without it, editing any asset serves a gzip of the
  PREVIOUS shell pointing at keys that no longer exist). `client/index.html`
  and everything under `client/js` and `web/` are UNCHANGED.

### The launchpad first paint fans out

- **THE SIX REQUESTS FAN OUT, AND THE FIRST PAINT IS ONE ROUND TRIP DEEP.** They
  were always six and they used to go out one at a time, each waiting on an
  answer it took no input from: `loadProjects` awaited `/projects`, then its two
  argument-free sidecars, and only then did `loadHomeScreen` start the merge,
  which awaited `/sessions/attachable`, then `/sessions/list`, then
  `/sessions/records`. **FIVE round trips in front of the first row; ONE now.**
  Only two dependencies are real and both survive: the JOIN needs the records
  AND the live rows, and the back-compat `getCurrentSession` may only be sent
  once `/sessions/list` has been SEEN to answer nothing. `Promise.all` is
  refused for the two session probes - it discards the second answer the moment
  the first fails, collapsing "one endpoint is down" into "neither ran" - so
  `running.ts::settled` captures each outcome separately and they are still
  classified one at a time, attachable first. `first-paint-fanout.test.ts` pins
  the DEPTH, not the count: it withholds every answer, releases the whole
  outstanding set at once and counts the releases. **A FETCH COUNT WOULD HAVE
  PASSED BEFORE THE FIX AND PROVED NOTHING.** Pinned at 1, with the old shape
  pinned at 5 beside it and a serial control that must report 6; the assertion
  was watched going red at 3 against the reverted store. Two of the five waves
  lived in `main.ts`, so the sequencer's order is pinned as a source shape too.
