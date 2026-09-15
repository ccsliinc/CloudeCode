# The archive screen and the shell: the contract between them

Issue #175 rebuilds the whole application shell: a new top nav
(HOME / SESSIONS / TOOLS / PROJECTS / SKILLS / USAGE), a two-section left
sidebar (MAIN: Home, Sessions, Agents, Projects, Tools, Archive, Compute;
SYSTEM: Activity, Files, Integrations, Settings) and a new ANSI and
demoscene visual identity on a dark ground in green and cyan. `Archive` is
a first-class sidebar item in it, so the archive browser gets a permanent
home rather than a bolted-on screen.

This document is the interface between those two pieces of work. Its job is
two-directional:

- somebody building the new shell can mount the archive screen without
  reading a line of the archive's internals;
- the archive screen can survive a re-skin without a rewrite.

**It is not a plan and it is not a scope.** The plan is
`docs/history-archive-scope.md`, which argues for the surface and orders
the nine migration slices. This is the INTERFACE, written against the code
that has actually landed.

**Why this is its own file rather than a section of the scope doc.** Three
reasons, stated so the choice can be argued with. First, they have
different lifespans: a scope is finished when the work it scopes ships, and
this contract has to outlive the migration because it is what the NEXT
re-skin reads. Second, they have different readers: somebody mounting the
archive into a new shell should not have to read 1,700 lines of migration
plan to find out which element id to provide, and burying it there is how a
contract goes unread. Third, the scope doc is already past this project's
own 500-line guideline by more than a factor of three, and adding to it
makes that worse. The scope doc's section 3 now points here.

## How to read a claim in here

Everything written in the present tense is traced to a file, and where it
is a claim about behaviour rather than about text, to a test or to a
measurement taken for this document. Anything that does not exist yet is
labelled **PROPOSED** and is never written in the present tense. If you
find a present-tense claim here that the code contradicts, the doc is
wrong: fix it in the same change, per gotcha 8.

**Where the two scope-doc families disagreed, this document does not
choose silently.** The reconciled scope doc records the divergence in its
own header. One disagreement is live and relevant here: the scope's
section 3 describes a surface design that slice 1 changed in four named
places while building it. **Slice 1 is what shipped, and this document
describes slice 1.** The four differences are listed in "Where this
differs from the scope" at the end.

## Status: what exists, and where

| Piece | State | Where |
|---|---|---|
| The `app-screen` surface type | BUILT, not merged | `web/src/lib/plugins/types.ts` on `feat/173-slice1-app-screen` at `dc58507` |
| The host walk and lifecycle | BUILT, not merged | `web/src/lib/plugins/screens.ts`, same branch |
| The grant enforcement | BUILT, not merged | `web/src/lib/plugins/screen-api.ts`, same branch |
| The archive's registration | BUILT, not merged | `web/src/lib/plugins/history/`, same branch |
| The archive's BODY (rail, list, reader, chat) | LEGACY vanilla JS | `client/js/archive-*.js`, 53 modules, 16,864 lines, present at `0eb81f0` |
| The archive's stylesheets | LEGACY, NOT ported | `client/css/archive-*.css`, 12 files, 4,444 lines, present at `0eb81f0` |

**`web/src/lib/plugins/history/` is not on the merged head.** At `0eb81f0`
the `web/src/lib/plugins/` directory holds `builtin.ts`, `registry.ts`,
`types.ts`, `session-card-actions.ts` and `mark-unread/` and nothing else.
If you are reading the merge base and cannot find the files this document
cites, that is why; check out `feat/173-slice1-app-screen`.

**The slice 1 contract is complete and exercised; the thing behind `mount`
is still legacy.** `history/screen.ts` says so in its own header:
`mount` and `show` hand the route to `client/js/archive-screen.js`, and
`hide` takes the container off screen. Slice 3 replaces the body of those
three functions with a Svelte mount without the host learning anything.
That is the point of having a contract at all.

---

# Part 1. What the archive screen needs FROM a shell

Eight things. Each is a real dependency today, not a wish list.

## 1.1 A mount point, addressed by id

The screen declares `screenId`, a string, on its `AppScreen` payload
(`web/src/lib/plugins/types.ts`). The archive declares
`SCREEN_ID = 'archive-screen'` (`web/src/lib/plugins/history/screen.ts`).

The host resolves it. `ScreenHost.getElement(id)` is the seam
(`web/src/lib/plugins/screens.ts`), and `web/src/main.ts` implements it as
`document.getElementById(id)`. The element in the shipped shell is
`client/index.html:805`:

```html
<div id="archive-screen" class="screen"></div>
```

It is EMPTY. Everything inside it is written by JavaScript at mount time.
A new shell owes the archive one element with that id and nothing in it.

**A missing container is a warned no-op, never a throw.**
`deliverRoute` warns by name and returns false
(`screens.ts`). That is `mount.ts`'s existing rule carried through: a
container that has not been written yet is a normal early-boot state, and
a silent return would make a misspelled `screenId` look like a screen that
chose to render nothing.

**The host's record of a mount keys on the ELEMENT, not on the id.**
`deliverRoute` compares `held.container === container` and remounts when
they differ. A shell that replaces its container wholesale (a re-render, a
route-driven teardown) therefore gets a fresh `mount` rather than a `show`
against detached nodes. That behaviour is deliberate and a new shell may
rely on it.

## 1.2 A `.screen` and `.active` visibility convention, or a replacement for it

**This is the single hardest shell dependency the archive has, and it is
three coupled facts.**

First, the layout. `client/css/styles.css:1242` declares:

```css
.screen        { display: none; flex: 1; overflow: auto; min-height: 0; }
.screen.active { display: flex; }
```

`client/css/archive-screen.css` then declares only the DIFFERENCE:

```css
#archive-screen {
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    background: var(--color-bg-page);
    color: var(--color-fg);
}
```

It sets no `display`, no `flex`, no `min-height`. Its own comment says so:
"The screen div itself is a flex item of the app shell (`.screen` in
styles.css sets `flex: 1; overflow: auto; min-height: 0`)". So a shell
that does not supply those four declarations gives the archive a block box
with content-sized height, and the three-column grid inside it collapses.

Second, the toggle. `web/src/lib/plugins/history-host.ts::setVisible` adds
and removes the literal class `active` on the container, and says why:
that is what `App.hideAllScreens()` strips and what `showArchive()` adds,
"so a screen hidden here and a screen hidden by the legacy controller are
in the same state".

Third, and this is the one that bites: **the archive's document-level
keyboard handler gates itself on that same class.**
`client/js/archive-screen.js:341`:

```js
function onKeydown(ev) {
    if (!shell || !shell.root.classList.contains('active')) return;
```

The listener is attached once, at wire time
(`client/js/archive-screen.js:193`,
`document.addEventListener('keydown', onKeydown)`), and there is **no
`removeEventListener` anywhere in that file** (measured: `grep -n
removeEventListener client/js/archive-screen.js` returns nothing). The
`.active` check is the ONLY thing that stops the archive's key map from
firing while the archive is off screen.

**So a shell that hides screens some other way inherits a live global key
handler.** Hide the archive with `hidden`, with `display: none` on a
wrapper, by unmounting a parent, or by a framework's own conditional
render, and `j`, `k`, `/`, `e` and the rest keep resolving to archive
actions while the user is looking at a terminal.

Two ways out, and a new shell must pick one deliberately:

- **Keep the convention.** Supply `.screen` and `.screen.active` with the
  four declarations above, and let the host keep toggling `active`. Cheapest,
  and nothing in the archive changes.
- **PROPOSED: give the surface an explicit visibility signal.** The
  `AppScreen` lifecycle already has `hide()`; it is called
  (`screens.ts::hideScreen`) and the archive's implementation only calls
  `host.setVisible(container, false)`. Routing the key handler's gate
  through that call instead of through a class read would sever the
  dependency. This does not exist; it is one line in `history/screen.ts`
  and one in `archive-screen.js`, and it is worth doing before the re-skin
  rather than after.

## 1.3 Route ownership, and the URL shape

The screen owns **one leading path segment** and both directions of every
URL under it.

`routePrefix` is that segment, declared with no slashes
(`types.ts`). The archive declares
`ARCHIVE_ROUTE_PREFIX = 'archive'` and `ARCHIVE_PREFIX = '/archive'`
(`web/src/lib/plugins/history/route.ts:66,69`).

**The host matches the prefix component-wise BEFORE calling `parse`.**
`screens.ts::ownsPath` splits the path and compares the first segment for
exact equality, never `startsWith`, so `/archived-thing` cannot reach the
screen that owns `/archive`. Same rule `src/core/project_directory.py`
applies to paths for the same reason. The screen's own `parse` still
answers `no-match` for a foreign path, so this is a second guard rather
than a replacement for the first.

**The prefix is unique across the registry.** A second contribution
claiming a taken prefix is refused whole-plugin, the same way a duplicate
contribution id is (`registry.ts`, changed for this in `dc58507`). A new
shell does not have to police this.

The four URL forms the archive owns, verbatim from
`ROUTE_PATTERNS` (`history/route.ts:108`), matched in this order:

| View | Pattern | Example |
|---|---|---|
| `line` | `/archive/t/<id>/l/<n>` | `/archive/t/5767/l/142` |
| `transcript` | `/archive/t/<id>` | `/archive/t/5767` |
| `project` | `/archive/p/<id>` | `/archive/p/48` |
| `root` | `/archive` | `/archive` |

Ids are bare non-negative decimal integers, enforced by the anchored
`[0-9]+` in each pattern and by `isNumericId` on the building side
(`route.ts:133`).

**The query string is an ALLOWLIST, not a denylist.**
`QUERY_ALLOWLIST = ['q', 'scope']` (`route.ts:82`). A parameter invented
later is dropped by default rather than published by default, which is
what keeps an opaque 147-character resume cursor out of a shared link.
A new shell must not append its own query parameters to an archive URL and
expect them to survive a round trip.

**`parse` answers three ways, never two** (`types.ts::ScreenRouteResult`):

- `ok` with a route;
- `no-match`, meaning "not my path, keep looking";
- `cannot-determine`, meaning "it IS my path and it is malformed". This
  **stops the host's walk** (`screens.ts::walkScreens`) and must produce a
  visible, specific error naming the offending segment. A silent redirect
  to the prefix root tells the sender their link was fine and shows the
  recipient something else. `session_ref` "journal" belongs to fourteen
  different transcripts; that measurement is why this token exists.

**`buildPath` is the inverse and may return `null`.** It never returns a
fallback path (`types.ts`): handing back the prefix root for an
unbuildable route is the same silent redirect, moved to the other end.

**A throwing or off-contract screen is contained, and degraded to
`no-match`.** `walkScreens` wraps `enabled()` and `parse()` in try/catch,
validates the returned shape with `isWellFormed`, and on any failure logs a
named refusal and KEEPS WALKING. The choice of `no-match` over
`cannot-determine` is the whole of the containment: `cannot-determine`
stops the walk, so mapping a throw onto it would take navigation down for
every screen behind the bad one while reading correct in the log. A new
shell inherits this for free and should not add a second guard.

## 1.4 How it claims and releases the screen

Four calls, and `hide` is not `unmount`.

| Call | When | Contract |
|---|---|---|
| `mount(container, route, context, api)` | first time this screen is shown, per page life | may not be called twice for one container; a mount that throws is NOT recorded, so the next visit gets a fresh `mount` rather than a `show` against a half-built object |
| `show(route)` | every route change within the screen while already mounted | separate from `mount` precisely so a deep link to a line number does not remount the reader and lose its position |
| `hide()` | the user left | the screen STAYS MOUNTED; the host hides it |
| `hideVisibleScreen()` | the host is about to show something no plugin owns | host-side, returns the id hidden or null |

**Exactly one plugin screen is visible at a time.** `screens.ts` holds a
module-level `visible: string | null` and `deliverRoute` hides the previous
one before showing the next.

**Unmounting on leave is refused, on the record.** `screens.ts` states the
reason: it would throw away the reader's scroll position, the rail's loaded
state and the transcript list's filter, all of which the user expects back.
A new shell that wants to reclaim memory needs a new lifecycle call, not a
reinterpretation of `hide`.

**A shell that navigates somewhere no plugin owns must call
`hideVisibleScreen()`.** Without it, leaving a plugin screen by a route the
plugin never sees leaves that screen believing it is still on display, and
in the archive's case leaves its key handler armed (see 1.2). The legacy
shell reaches this through `window.CloudeWeb.screens.hideVisible`
(`web/src/main.ts`).

## 1.5 Back and forward

**The shell owns `popstate`. The archive does not listen for it.**
`client/js/router.js:623` registers the only `popstate` listener that
concerns screens, and `router.js`'s own header says so at line 39: "We also
listen for `popstate` so browser back/forward re-triggers".

The inbound path is one function for every entry, by design
(`router.js:135`): "the ONE place a screen route becomes a screen, so a
fresh load, a popstate and a post-login delivery take the identical path".
It calls `window.CloudeWeb.screens.parse(path, search)` and then
`window.CloudeWeb.screens.deliver(screenId, route)`, which reaches
`deliverRoute` and therefore `show(route)` on an already-mounted screen.

So back and forward inside the archive arrive as `show`, not as `mount`.
A new shell must preserve that or the reader remounts on every Back press.

Outbound, the archive writes the address bar itself, through
`ScreenShellHost.pushPath` (`history/screen.ts`), which the browser host
implements as `window.history.pushState`
(`history-host.ts`). Two rules ride on it:

- **A failed `pushState` is not a failed navigation.** The History API
  throws in a sandboxed iframe; `history-host.ts` catches it and returns
  false, and the screen still opens. A wrong address bar is strictly a
  smaller problem than not opening.
- **Leaving the archive pushes `/` explicitly, and does NOT call
  `history.back()`.** `history/screen.ts::close` records why: Back returns
  the user to whatever preceded the archive, which is nicer when they
  arrived by clicking and wrong when they arrived by typing the URL, where
  there is no such entry and Back leaves the app entirely. A deterministic
  push to `/` never strands anyone.

**A new shell whose nav is not path-based still has to keep the path
truthful.** The archive's URL is the identity of what is on screen; a nav
that changes the view without changing the path means a refresh lands
somewhere else.

## 1.6 Keyboard focus and Escape

**Escape is an ORDERED LADDER of five rungs and the shell owns only the
first.** `client/js/archive-keys.js`, header, verbatim in structure:

1. a modal is open: the modal owns it. `resolve()` returns `null` and
   leaves it to `client/js/modal-stack.js`, which already routes Escape to
   the top overlay. Two owners for one key is how a modal closes and the
   screen behind it also navigates.
2. the filter has text: clear the filter.
3. a search is showing: dismiss the search results.
4. on a narrow viewport: go back one pane.
5. otherwise: **nothing. Escape does NOT leave the archive screen**,
   because an accidental Escape throwing away a 3,416-row paging position
   is a hostile default.

**The load-bearing instruction for a new shell is rung 5.** Do not bind
Escape globally to "close the current screen", "go back", or "return to
home". It will fire under rungs 2, 3 and 4 as well and it contradicts rung
5 outright.

**`window.ModalStack` is a required host global, not an optional one.** The
archive references it 11 times across `archive-export.js`,
`archive-keys-help.js`, `archive-nav-info.js` and `archive-screen.js`. It
is what makes rung 1 work: `archive-keys-help.js` says explicitly that it
"adds no Escape listener of its own" because `ModalStack` already routes
Escape to the top overlay.

The published object is exactly
`window.ModalStack = { push, pop, depth, isTop, BODY_LOCK_CLASS, COVERED_CLASS }`
(`client/js/modal-stack.js:199`). The archive calls
`push(overlayEl, { onEscape })`, `pop(overlayEl)` and `depth()`; a shell
that replaces the modal system owes it at least those three, and should not
drop `isTop` or the two class constants without checking the rest of the
app. Note that `ModalStack` also records and restores the previously
focused element when a modal closes, which is the ONLY focus restoration
anywhere in this path and is worth keeping.

**A key is never claimed while a text field has focus, except Escape and
Enter.** `context.inTextField` is measured by the caller
(`archive-screen.js:345` reads `tagName` and `isContentEditable`) and
passed in; `archive-keys.js::resolve` is pure and reads no DOM. A shell
that adds its own single-letter shortcuts needs the same measurement or
they will fire while somebody types in the archive's filter.

**Focus itself is NOT in the contract, and that is a gap.** There is no
`focus()` on `AppScreen` and nothing in `screens.ts` moves focus on mount
or show. See Part 4.

## 1.7 The breadcrumb, which today is not a shell contribution at all

**What IS.** The archive paints its own breadcrumb INSIDE its own
container. `.archive-screen__crumb` is declared in
`client/css/archive-screen.css` as a `flex: 0 0 auto` row at the top of
`#archive-screen`, and its own comment calls it "the archive's title row".
It is painted by `renderCrumb`
(`web/src/lib/plugins/history/crumb-render.ts`), reached from the legacy
screen body through `window.CloudeWeb.archive.renderCrumb`
(`web/src/main.ts`).

There is no breadcrumb field on `AppScreen`. The only thing the surface
publishes for a shell to render is `title`, a string
(`types.ts`), which the archive sets to `LABEL = 'message archive'`
(`history/screen.ts`).

**The vocabulary a shell would need already exists and is worth reusing
rather than re-deriving**, all in `web/src/lib/plugins/history/crumb.ts`
and `route.ts`:

- `CrumbSegment { text, kind }` where `kind` is `'name' | 'ref' |
  'unknown'`. Three outcomes per segment, and the middle one is the
  interesting one: a REFERENCE standing in for a name is labelled as such
  (`REF_PREFIX = 'ref '`) rather than presented as a name.
- `PROJECT_UNKNOWN = 'project NOT NAMED YET'` and
  `SESSION_UNKNOWN = 'session NOT NAMED YET'`. A deep link paints its
  crumb before the header request resolves, so for a beat the app genuinely
  does not know what it is showing, and it says so. Filling that beat with
  `transcript 5767` was the old behaviour and it is the false-green shape:
  an unknown rendered as a fact.
- `hasNumericId(parts)` exists so a test can assert the ABSENCE of a
  database primary key in a crumb, rather than trusting nobody
  reintroduces one.
- `CRUMB_ROOT_LABEL = 'ARCHIVE'`, `CRUMB_SEPARATOR = '>'`
  (`route.ts:72,75`).
- `crumb-resolve.ts` answers `name` / `unresolved` / `cannot_determine`
  for a project id, which is the same three-outcome discipline.

**PROPOSED.** A shell with a top nav and a sidebar plausibly wants to
render the trail itself rather than have the screen draw one inside its own
box. That needs a `crumb(route): readonly CrumbSegment[]` on `AppScreen`,
or the shell has two breadcrumbs stacked. It does not exist. See Part 4.

## 1.8 Data access, and availability

**The grant.** The screen declares `apiPrefixes`, and the host builds the
client. The archive declares
`API_PREFIXES = ['/archive', '/features']` (`history/screen.ts`),
with the reason recorded: `/features` is NOT under `/archive` because the
server mounts it whether the archive is on or off, and that is the entire
reason "off" is distinguishable from "broken".

`deliverRoute` calls `createScreenApi(screen.apiPrefixes ?? [], host.transport,
id)` and passes the result as the fourth argument to `mount`
(`screens.ts`). The screen adopts it, replacing whatever client its
factory was built with (`history/screen.ts::mount`), which is what makes
the grant the HOST's decision rather than the plugin's.

**A refusal is never a 404.** `ScreenApi.call` rejects with a
`GrantRefusedError` before any request leaves the browser
(`types.ts`, `screen-api.ts`). A 404 is a resolved response carrying a
status; the two are structurally different rather than differently worded,
so a caller that only catches can still tell them apart.

**One transport adapter, and the bug that proves why.**
`web/src/lib/plugins/api-transport.ts` exists because `api.js` sets
`baseURL` to `/api/v1` and prepends it, while `ScreenApi` resolves every
path to an absolute one before checking the grant, so `/features` went out
as `/api/v1/api/v1/features` and the archive's availability probe answered
`unknown` against a server reporting `enabled`. Every unit suite passed,
because every suite handed the granted client a recorder and asserted the
path it was ASKED for. It was found by driving the real page against a real
server (`dc58507` commit message). A new shell that supplies its own
transport must not re-introduce a second base-path convention.

**Availability is a three-state MEASUREMENT, not a flag.**
`web/src/lib/plugins/history/availability.ts` declares
`STATE_ENABLED`, `STATE_DISABLED`, `STATE_UNKNOWN` and probes
`FEATURES_PATH = '/features'`. Two consequences a shell must respect:

- **`Contribution.enabled()` is ALWAYS TRUE for this screen and is NOT the
  availability gate** (`history/index.ts`, with the reasoning in place).
  A deep link to `/archive` on a server with the archive switched off must
  still reach THIS screen so that it can say the archive is off. Returning
  false would make the path fall through to the launcher, which is the
  silent redirect the whole route design refuses.
- **`unknown` does not refuse.** `history/screen.ts::openRoute` refuses
  only on a DEFINITE `disabled`, and its comment says why: nothing was
  measured, and turning "I could not tell" into a refusal is the same false
  verdict in the other direction.

A sidebar that wants to hide or disable its `Archive` item should read the
measured state through `window.CloudeWeb.archive.state()` /
`.onResolved(fn)` (`web/src/main.ts`), and must render the third state as a
third thing rather than folding it into "off".

---

# Part 2. What the archive screen must NOT assume

Stated as rules, with what is true today beside each, because two of them
the archive currently breaks.

**1. It must not assume any shell class name.** VIOLATED TODAY:
`history-host.ts::setVisible` writes the literal `active`, and
`archive-screen.js:341` reads it. See 1.2. Everything else in the archive
is scoped under `#archive-screen` or an `archive-` prefixed class, so this
is the whole of the violation and it is two lines.

**2. It must not assume the current header.** Partially true today. The
archive's entry button lives in `client/js/header-menu.js`, and
`tests/test_archive_header_icon.node.mjs` asserts it there, but the archive
screen itself does not read the header: the exit path calls
`host.showLauncher()` through the injected `ScreenShellHost`
(`history/screen.ts`), not a header API. A new shell supplies its own
entry point and its own back affordance, and reaches the screen through
`window.CloudeWeb.archive.open()` / `.openRoute(route)` / `.close()`
(`web/src/main.ts`). Those four are the doors; there is exactly one
implementation behind them so two doors cannot drift to two destinations.

**3. It must not assume the current sidebar.** True today. Nothing under
`client/js/archive-*.js` or `client/css/archive-*.css` references the
session sidebar.

**4. It must not assume it owns the viewport.** True today, and measured
for this document: across all 12 archive stylesheets there is **no
`position: fixed`, no `100vh`, no `100vw` and no `100dvh`**. The six
`position: absolute` declarations that exist
(`archive-chat.css:57`, `archive-panes.css:46,69`,
`archive-reader.css:122`) are all inside archive-owned positioned
ancestors. `#archive-screen` is a flex ITEM that fills what the shell gives
it. The only `z-index` in the family is `archive-panes.css:59`, value 2,
and `archive-nav-info.css` explicitly notes that `ModalStack` rewrites the
z-index per overlay rather than the archive picking one.

**5. It must not assume fixed pixel chrome above or beside it.** True
today, by the same measurement.

**6. It must not assume the 12 stylesheets survive.** They are 4,444 lines
and they are NOT ported by any of the nine slices
(`docs/history-archive-scope.md` section 8.1). Anything a shell reads out
of them is reading something scheduled for replacement.

**7. It must not reach a host global it did not declare.** VIOLATED TODAY
by the legacy body, and pinned going forward for the migrated part.
Measured for this document over all 53 `client/js/archive-*.js` modules
plus `client/js/api-archive.js`, 54 files in total, the archive reaches
exactly **eight** non-archive globals:

| Global | References | Fate |
|---|---|---|
| `window.API` | 17 | removed by slice 2 (the granted client) |
| `window.ModalStack` | 11 | SURVIVES, required of the shell (see 1.6) |
| `window.ModuleLoader` | 6 | removed by slice 3 (`archive-loader.js` is deleted, not ported) |
| `window.App` | 6 | removed by slice 1 (now `ScreenShellHost`) |
| `window.Router` | 4 | removed by slice 1 |
| `window.NavigationGeneration` | 2 | SURVIVES |
| `window.ModuleFamilies` | 2 | removed by slice 3 |
| `window.Auth` | 2 | SURVIVES |

That count re-confirms the figure `docs/history-archive-scope.md` section
10 carries. Three survive the nine slices: `ModalStack`, `Auth`,
`NavigationGeneration`.

For the migrated part the rule is already enforced rather than asserted:
`web/src/lib/plugins/history/import-direction.test.ts` fails the build if
anything outside `history/` imports past `history/index`, if anything
inside imports from `launchpad/`, `sessions/` or `terminal-search/`, or if
anything inside reaches a host global. Its first run failed on two files
that only MENTIONED `window.API` in a comment, so it reads code rather than
prose. `web/src/lib/plugins/history-host.ts` is the one module that knows
both that `window.App` exists and that a history screen wants a
`ScreenShellHost`, and it lives OUTSIDE `history/` for exactly that reason.

---

# Part 3. The theming seam, and what a re-skin actually costs

## The seam

**Colour and typography plug in at the theme token layer, and that layer is
already the only thing the archive stylesheets use.**

Measured for this document across all 12 `client/css/archive-*.css` files:

| | Count |
|---|---|
| `var(--token)` references | **553** |
| hex colour literals | 11 |
| `rgb()` / `rgba()` / `hsl()` literals | 5 |

And the 16 literals are almost all not what they look like. Eleven are
either inside comments recording a measured contrast ratio
(`archive-nav-card.css:53-57`) or are FALLBACKS inside a token reference,
`color-mix(in srgb, var(--color-bg, #1e1e1e) 80%, transparent)`
(`archive-nav-card.css:84,94`, `archive-tlist.css:185,200,221`). **Exactly
two are real un-tokenised colours**, both in `archive-nav-info.css`: a
modal scrim at line 35, `rgba(0, 0, 0, 0.5)`, and a drop shadow at line 63,
`rgba(0, 0, 0, 0.55)`.

The tokens are the app's own, not archive-private. The ten most used:

| Token | Uses |
|---|---|
| `--color-accent` | 83 |
| `--color-fg-muted` | 71 |
| `--font-mono` | 63 |
| `--color-border` | 60 |
| `--color-fg` | 40 |
| `--radius-md` | 30 |
| `--color-bg-elevated` | 21 |
| `--radius-sm` | 18 |
| `--color-warning` | 18 |
| `--color-bg-hover` | 18 |

They are defined on `:root` in `client/css/styles.css` (for example
`--color-bg-page` at line 30, `--color-fg-muted` at 41, `--color-accent` at
50, `--radius-md` at 129) and overridden per theme in
`client/css/themes/<id>/theme.json` under a `cssVars` object. There are 26
bundled themes; `gameboy/theme.json` carries 70 `cssVars`, and a spot check
of four themes found all eight of the archive's most-used tokens defined in
every one of them.

**So the seam for a colour re-skin is a theme manifest, or a `:root`
override, and nothing else.** A new ANSI and demoscene identity in green
and cyan can repaint every one of those 553 sites by redefining the tokens.
That is genuinely cheap, and it is the answer this document is most
confident about.

## Where a re-skin is expensive, stated without softening

**1. Geometry is hard-coded, and it is 556 numbers.** The same 12 files
carry **556 `px` values** and **11 `@media` blocks**. None of the spacing,
sizing, pane widths, row heights or breakpoints goes through a token: there
is no `--space-*` or `--size-*` scale in use here. A re-skin that only
changes colour is cheap; a re-skin that changes DENSITY, rhythm or the
shape of a row is 556 edits across 4,444 lines, and the files this touches
are the ones slice 3 through slice 9 are going to replace anyway. **Doing
geometry work on these stylesheets before the slices land is work done
twice.**

**2. Two breakpoints are duplicated in CSS and in JavaScript and are
required to agree by hand.** `archive-screen.css`'s own header states it:
900px is the three-column to one-column collapse, 700px is the reader's
metadata wrap, and "`archive-screen.js` names 900 as `NARROW_MAX_PX`; the
two must agree, which is why each states the number rather than either
implying it". It is worse than two places: `client/js/archive-pane-resize.js:65`
declares its own `var NARROW_MAX_PX = 900` and its comment says it "mirrors
NARROW_MAX_PX in archive-screen.js". **Three copies of 900.** A new shell
that changes the width at which the archive collapses has to change all
three, and nothing fails if it changes only one.

**3. The narrow layout is driven by a DOM attribute the screen writes.**
`archive-screen.js` writes `data-pane` on `#archive-screen` from the ROUTE,
and `archive-screen.css:343-353` shows exactly the pane that attribute
names below 900px. This is a good design, stated in the file as "narrow is
one state rendered differently, not a second state machine", and a re-skin
must preserve the attribute contract rather than route around it with its
own responsive rules.

**4. One normative rule a re-skin may not quietly drop.**
`archive-screen.css`, marked NORMATIVE from design doc C.5: the outcome
blocks do not shrink into icons at any width. On a 375px screen a
`cannot_determine` still renders the words COULD NOT EVALUATE and its
reason text, wrapped. Compressing the third outcome into a glyph
reintroduces the exact indistinguishability the design exists to prevent,
on the viewport where people skim hardest. A visual identity that
icon-ifies dense rows must carve this out.

**5. Two colours are not on the seam.** The scrim and the shadow named
above. On a dark ANSI ground a 50 percent black scrim over an already dark
surface is close to invisible. Two lines, but they are two lines a token
sweep will not find.

## The honest summary

**Re-theming the archive's COLOUR and TYPE is cheap: 553 of 569 colour and
font sites already go through app-wide tokens, and the mechanism is the
existing 26-theme manifest system.** Re-theming its LAYOUT is expensive:
556 hard-coded pixel values, 11 media queries and a breakpoint constant
copied into three files. The cheap half should be done now. The expensive
half should wait for slices 3 through 9, which delete these stylesheets,
because doing it first is doing it twice.

---

# Part 4. What the `app-screen` surface is missing for a new shell

Everything in this part is **PROPOSED**. None of it exists in
`web/src/lib/plugins/types.ts` at `dc58507`. It is listed because a shell
with a persistent top nav and a persistent sidebar asks questions of a
mounted screen that the legacy shell never asked.

**1. A breadcrumb contribution.** `AppScreen` publishes `title` and nothing
else a shell can render as location. The archive draws its own trail inside
its own box (1.7). A shell that draws a trail in its chrome will show two.
Proposed shape: `crumb(route): readonly CrumbSegment[]`, reusing the
`CrumbSegment` vocabulary that already exists in `history/crumb.ts`
including its `unknown` kind, because a shell-rendered crumb has exactly
the same "the fact has not arrived yet" beat.

**2. A focus contract.** Nothing in `screens.ts` moves focus on `mount` or
`show`, and `AppScreen` has no `focus()`. A shell whose nav is keyboard
reachable needs to know where focus lands when a screen is entered, and
where it returns when the screen is left. Today this is undefined, which
means it is whatever the browser does.

The narrow case IS handled and is worth not mistaking for the general one:
`client/js/modal-stack.js` records the previously focused element on `push`
and restores it on `pop`, so focus survives opening and closing an archive
modal. Nothing does the equivalent for entering and leaving the SCREEN.
That is an accessibility gap as much as a shell one.

**3. An explicit visibility signal, replacing the `.active` class read.**
See 1.2. This is the single highest-value item in this list, because
without it a new shell silently inherits a live global key handler, and the
symptom (keys doing archive things on a terminal screen) is nowhere near
the cause.

**4. A sidebar identity.** `Archive` is a first-class sidebar item in the
#175 design. The `sidebar-item` surface exists (`types.ts`) and carries
`label`, `icon` and `run`, and its own docstring calls it UNPROVEN and the
thinnest of the four. Nothing connects a `sidebar-item` to an `app-screen`:
there is no way for a shell to ask "which sidebar row corresponds to the
screen currently visible" and paint it selected. Proposed: either an
optional `sidebarItemId` on `AppScreen`, or let the shell match on
`visibleScreen()` against a contribution id it already knows.

**5. A declared availability state on the surface itself.** The archive's
three-state gate is private to `history/availability.ts` and is reached by
the legacy tree through the ad-hoc `window.CloudeWeb.archive.state()` seam.
A shell that wants to disable a sidebar row for an unavailable screen has
no surface-level way to ask. Proposed:
`availability?(): 'enabled' | 'disabled' | 'unknown'` on `AppScreen`, with
the existing rule that `unknown` is a third rendering and never folded into
`disabled`.

**6. A route-change notification outward.** The screen writes the address
bar itself through `ScreenShellHost.pushPath`. A shell whose chrome
reflects location (a highlighted nav item, a trail, a document title) is
not told. Today it would have to listen for `popstate`, which does not fire
for a `pushState` the screen itself made.

**7. Nothing says what a screen owes on a THEME change.** Themes are a
separate, older, working system (`types.ts` says so explicitly, and
`client/css/themes/<id>/theme.json` is the mechanism). For CSS tokens that
is fine, they cascade. For a screen that has measured a colour in
JavaScript, or rendered to a canvas, there is no hook. The archive does not
do either today, so this is a forward-looking gap rather than a live one.

---

# Where this differs from the scope document

`docs/history-archive-scope.md` section 3 is the DESIGN ARGUMENT for the
surface and predates slice 1. Slice 1 changed four things while building
it, each recorded in the file that carries it and in `dc58507`'s message.
**This document describes slice 1.** The four:

1. **The granted client is a fourth argument to `mount`, not a field on
   `PluginContext`.** That context is shared with four surfaces that
   declare no grant, and putting a client on it would hand them either an
   ungranted one, which is the unbounded access the design exists to
   refuse, or one that throws for four surfaces out of five.
2. **`enabled(context)` is NOT the availability gate, and the scope's
   sentence about the `/features` probe "going to die" there is wrong.**
   `PluginContext.flags` reads an absent key as ON, which is backwards for
   a feature whose routes 404 when it is off, and the gate has three states
   where a flag has two. The probe moved to `history/availability.ts`
   intact.
3. **The grant's ENFORCEMENT landed in slice 1 rather than slice 2**,
   because `apiPrefixes` is part of this payload and a
   declared-but-unenforced grant is decoration.
4. **The host matches `routePrefix` component-wise before calling `parse`**,
   so a screen never sees a path outside its own namespace.

---

# Quick reference for a shell implementer

What you owe the archive:

- one empty element with `id="archive-screen"`;
- that element laid out as `display: flex; flex: 1; overflow: auto;
  min-height: 0` while visible, and hidden while not, by adding and
  removing the class `active` on it (until item 3 of Part 4 lands);
- ownership of `/archive` and everything under it handed to the screen, in
  both directions;
- a `popstate` listener that re-parses and delivers, so Back arrives as
  `show` and not as `mount`;
- `hideVisibleScreen()` whenever you navigate somewhere no screen owns;
- a `window.ModalStack` with `push(el, {onEscape})`, `pop(el)` and
  `depth()`;
- Escape left alone globally;
- a transport that does not double-prefix `/api/v1`.

What you get:

- `window.CloudeWeb.screens` = `{ parse, deliver, hideVisible, visible }`;
- `window.CloudeWeb.archive` = `{ open, openRoute, close, ensure, state,
  reason, onResolved, buildPath, syncUrl, renderCrumb, tracker, resolver,
  STATE_ENABLED, STATE_DISABLED, STATE_UNKNOWN }`;
- a screen that contains its own failures: a throwing `parse`, a throwing
  `mount`, a throwing `show`, a throwing `hide` and an off-contract return
  value are each logged by name and leave navigation working for everything
  else.

Both seams are declared in `web/src/main.ts`, and both are reached at CALL
time and never at parse time, because the bundle is a deferred module and
the legacy scripts are classic ones.
