# The history and archive browser: scope

Claimed by issue #173, draft PR #174, on `feat/173-history-archive` off
`adamdev/master` at `917835f` (1.4.4).

This is a SCOPE. Where a number appears it was measured on 2026-09-13 and
the command that produced it is given, so the next reader can re-take it
rather than trust it. Where something is an inference it says so.

**PARTS OF IT HAVE SINCE BEEN BUILT, AND THE SENTENCE THAT USED TO STAND HERE
SAID OTHERWISE.** It read "Nothing in it has been built", which was true the
day it was written and is not true now. Built since: slice 1 of section 8.2,
the `app-screen` surface and the history browser's registration through it, on
`feat/173-slice1-app-screen` at `dc58507`, NOT yet merged; the search index of
section 2.5, merged; and the database split of section 6, merged. Each is
marked where it appears. Read a section's own marker rather than this header.

**RECONCILED, 2026-09-15.** This document existed in two divergent families
that split at `49fd571`, and NEITHER was a superset. The long family
(`4c7bac7`, `04adb19`, on `feat/173-history-archive` and
`feat/173-slice1-app-screen`) carried the revised full-Svelte-migration plan
that issue #173 and PR #174 quote. The short family (`5ff3d50`, `6f9aec2`, on
`feat/173-archive-db-split` and the branches merged into `0eb81f0`) predated
that revision and independently corrected two things the long family still had
wrong: section 2.5's search gap, and section 6's claim about cross-database
foreign keys. This file is the union: the long family's plan, plus every
correction from the short family, plus the four places where the repository at
`0eb81f0` had moved past both of them. The divergence was flagged publicly on
issue #173; this is the follow-through.

**REVISION, 2026-09-13.** Section 8 replaced a seam-only migration
recommendation with a FULL Svelte migration, on the owner's ruling and on
information the first pass did not have: the fifty rendering modules are not
going to be left alone, and migrating before modifying is cheaper than the
reverse. Section 5, the away bar, is PARKED on his call and is no longer
scheduled. Everything else stands.

**ADDITION, 2026-09-13.** Section 10 captures what would have to be true for
the history browser to become a standalone project, split into what is FREE
NOW and what is EXPENSIVE LATER. It is a capture, not a plan, and it adds five
things to the slices, all of which are free. It also **corrects the server-side
module count this document has carried from the start**: the family is 68
modules and 22,750 lines, not 44 and 14,087.

**If you read only one section, read 2.0.** The background ingester fills
`transcript_archives` and the browser reads the `message_*` tables, and those
tables are empty. That is why the history browser shows nothing, and it is what
"clean and finish up history" actually means.

Two claims in the first draft of this document were wrong and are corrected in
place rather than quietly removed, because a stale scope is worse than no
scope: the archive is ON for the owner, not off (section 2.1), and the app's
own state is 716 KiB rather than the 7 MB first reported (section 6).

The owner's three rulings this document serves, verbatim:

> "we will make my away bar into a plugin. it will go with the archive
> browser that a seperate part."

> "yes do it all. we need to plugin surfaces anyway. the history browser
> should be done first, the away bar is second. the whole history browser can
> be a plugin in reality."

> "we can seperate the database out? that may be the better option? i also
> want to make sure we are still ingesting regularly."

---

## 1. What exists today

The archive browser is not greenfield. It is the largest self-contained
feature in this application and it already works.

| measured | figure | command |
|---|---|---|
| client modules matching `archive` | **54** | `git ls-tree -r --name-only adamdev/master client/js \| grep -ci archive` |
| lines in those, plus `api-archive.js` | **17,387** | `wc -l client/js/*archive*` |
| server modules matching `archive` or `corpus` BY NAME | **43** | `git ls-tree -r --name-only adamdev/master src \| grep -ciE 'archive\|corpus'` |
| lines in those | **13,928** | `wc -l $(git ls-files src \| grep -iE 'archive\|corpus')` |
| server modules in the family IN FACT | **68** | `archive_* + transcript_* + message_* + corpus_*` |
| lines in those | **22,750** | see section 10.1 |
| test files for it | **72**, of which **39** are node suites | `ls tests/ \| grep -icE 'archive\|corpus'` |
| stylesheets | **14** | `ls client/css/archive-*.css` |
| modules under `web/src` touching it | **0** | `git ls-tree -r --name-only adamdev/master web/src \| grep -ciE 'archive\|corpus'` |

Two figures from the original brief were slightly off and are corrected here:
the Svelte tree is **152 files, 29 of them `.svelte`**, against **224 files**
under `client/js`, not 137 against 221.

### What it does

Four URL routes, owned by `client/js/archive-deeplink.js` and parsed on the
way in by `client/js/router.js`, which delegates rather than carrying its own
regexes:

```
/archive                    root, the rail loaded, nothing selected
/archive/p/<id>             project <id>, transcript list loaded
/archive/t/<id>             transcript <id> open in the reader
/archive/t/<id>/l/<n>       transcript <id>, scrolled to line <n>
```

Behind them: a navigation rail over hosts, corpora and projects, with fuzzy
find and a merged-project view; a transcript list with filtering; a reader
that renders raw JSONL lines with virtualisation and a body-size gate; a chat
view that folds those lines into turns, blocks and sub-agent runs; full-text
search with a scan budget and an opaque resume cursor; an export path; a
secret mask; keyboard navigation with a help overlay; and a project overlay
table that lets a human rename, group and hide projects in the browser
without touching the corpus.

Server side there are TWO stores and that distinction is the whole of section
2.0: a byte-exact transcript archive (`transcript_archive.py`,
`transcript_archives` plus `transcript_records`) storing gzipped originals with
per-line derived offsets, which is what the background ingester fills; and a
v16 message model (the sixteen `message_*` tables), a separate and stricter
normalised layer, which is what `src/api/archive_routes.py` and its five
sibling routers actually read. They are not the same store and only one of them
is populated.

### The entry point

Exactly one, by design: the `#archiveBtn` icon in the header, wired by
`header-menu.js` and revealed only once `ArchiveEntry.ensure()` has MEASURED
the server as having the archive switched on. The launchpad row that used to
sit beside it was removed on purpose ("dont waste page space") and
`tests/test_archive_entry_points.node.mjs` pins its absence. That is not a
regression from the Svelte migration and was checked rather than assumed.

`client/js/terminal-search-deep-dive.js` is a second caller: the Deep dive
button in the terminal search panel opens the archive at the project matching
the pane's working directory. So their search work already depends on this
area, which is worth knowing before either side changes the seam.

---

## 2. What is actually missing or broken

The owner said "clean and finish up history", which implies known gaps. These
were found by reading and by measuring. They are ordered by how much they cost
him, and the first one is the whole answer.

### 2.0 THE HEADLINE: the ingester fills one store and the browser reads a different, empty one

This is the finding. Everything else in this section is small beside it.

There are TWO transcript stores in `cloude.db`, built at different times for
different jobs:

- the **archive layer**, `transcript_archives` plus `transcript_records`, which
  holds byte-exact gzipped originals with per-line derived offsets
- the **v16 message model**, the sixteen `message_*` tables, which holds a
  normalised, deduplicated, block-level model

**The background ingester writes ONLY the archive layer.** Its own docstring
says so under a heading that exists to stop exactly this misreading:

> "WHAT THIS DOES NOT DO, STATED SO THE ABSENCE IS NOT MISREAD. It does not
> populate the v16 message model (`message_transcripts` / `message_bodies` /
> `message_appearances`). That model has no re-ingest path for a file that
> GREW ... which makes it the wrong layer for a live corpus whose transcripts
> grow while the app watches them."

**The browser reads ONLY the message model.** Measured: **22 of the 44 server
modules** reference `message_*` tables, and the navigation rail's own queries
are `FROM message_hosts`, `FROM message_corpora`, `FROM message_projects` and
`COUNT(*) FROM message_transcripts` (`src/core/archive_hierarchy.py:84-155`).
Not one module in the browse, read, search, turn, export or overlay path
references `transcript_archives` or `transcript_records`.

**And the message model is empty.** Measured on the static
`cloude.db.bak-v25-20260910T154341Z` backup, read-only:

```
message_transcripts       0 rows
message_bodies            0 rows
message_content_blocks    0 rows
message_appearances       0 rows
```

against `transcript_archives` at **22,828 rows and 3,703,771,340 bytes** of
compressed transcript, ingested correctly, every fifteen minutes, for months.

**So the history browser is switched on, reachable from the header, and shows
an empty rail, while 3.7 GB of correctly ingested transcripts sit in a table
family it never reads.** That is "the feature is broken" and "the feature is
unreachable" looking identical from outside, which is `archive-entry.js`'s own
sentence about a different symptom of the same disease.

The application already KNOWS and says so in a place nobody joined up.
`corpus_status.py:128` reports `model_not_populated` rather than "0 findings",
and its comment reads: "The archive ingester does not write to this table, so
on an install where only the archive runs the honest answer is
`model_not_populated`, and saying '0 findings' there would be a green light
nobody earned." Every individual statement in this system is honest. Nobody
put them next to each other.

#### The three ways out

**Fix A, the stopgap: run `scripts/message_model_corpus_run.py`.** It ingests
the whole of `~/.claude/projects` into a fresh v16 model straight from the
.jsonl files and proves each one byte-exact. This would make the browser show
something today, which is what unblocks measuring the UI at real scale
(section 2.3). It is a stopgap and not the answer, because the model "refuses
a `source_ref` it has already seen, deliberately", so the view goes stale the
moment a transcript grows and the only repair is another manual full run.

**Fix B, the real work: repoint the browse and read path at the archive
layer.** 22 server modules, and the client above them is unchanged because the
route shapes do not move. This is what makes the feature self-maintaining,
because the archive layer is the one built for a corpus that grows while the
app watches it. **This is the substance of "finish history" and should be
scoped as its own sequence of issues.**

**Fix C, rejected with its reason: give the message model a re-ingest path.**
That would reverse a documented design decision made on purpose ("so that
nothing is ever silently overwritten"), in the layer whose whole value is that
it does not silently overwrite. It is a design change wearing the clothes of a
wiring fix.

**Recommendation: A now, B as the work, C never.**

One caveat stated rather than assumed: the two stores are not obviously
isomorphic. The message model carries roles, block types, models, compact
subtypes and secret findings as interned dimensions; the archive layer carries
derived per-line scalars. **Before committing to Fix B, an implementation agent
must map every column the 22 modules read onto something the archive layer can
answer, and name what it cannot.** It is possible the honest answer is a third
thing: a derived view over the archive layer that fills the gap. That is a
measurement, not a guess, and it has not been taken.

### 2.1 The archive flag, corrected

An earlier reading of this had the archive switched OFF for the owner. **That
was wrong and is corrected here.** The repository's own `config.json` has no
`message_archive` block, but that is a development config and is not the
install he runs. The running server is PID 58924, `python -m src.main`, cwd
`/Users/jsugamele/Library/Application Support/cloude-code-menubar/server`,
version 1.4.0, and its `config.json` carries `{"enabled": true}`. The flag is
on, the routes are mounted, and the header control is visible.

The flag's default stays `False` and must not be changed. Turning the feature
on creates a schema and starts a thread that indexes the user's private
conversations; nobody gets that by upgrading. `cannot_determine` gates CLOSED,
and that stays too.

**This correction is the reason section 2.0 matters.** If the flag had been
off, "the browser shows nothing" would have had a one-line explanation. It is
on, so it does not.

### 2.2 The ingester is healthy, and that half is answered

Verified independently rather than taken on report. `latest.json` in the state
directory, read 2026-09-13, written 436 seconds earlier:

```
discovered              19,581
bytes_ingested          34,465,274
could_not_read          0
discovery_unreadable    0
discovery_unrecognised  10,699
```

The `discovery_unrecognised` figure looks alarming and is not. Every sampled
path is non-transcript bookkeeping: `sessions-index.json`, `*.meta.json`,
`*.desktop-released.json`, and `memory/` directories. That is correct
classification, not a failure. Nothing here needs fixing.

### 2.3 The corpus is far larger than anything the UI was measured against

Measured against the static `cloude.db.bak-v25-20260910T154341Z` backup file,
read-only, so the live database was never opened:

| | |
|---|---|
| `transcript_archives` rows | **22,828** |
| compressed bytes held | **3,703,771,340** (3.45 GiB) |
| raw bytes represented | **26,372,918,875** (24.56 GiB) |
| `transcript_records` rows | **9,145,196** (reported by the coordinator, consistent with the above) |
| `transcript_root_decisions` rows | **23,023** |
| `sessions` rows | **940** |
| `projects` rows | **79** |

`archive-entry.js`'s own description says "21,039 transcripts". The number is
now 22,828 and climbing at roughly one ingest pass every fifteen minutes.
Nothing in the browser has been measured at this size since. The search scan
budget and the virtual list are the two places where that matters, and both
need a measurement before anyone calls this finished.

### 2.4 Search can return an incomplete answer and the UI does not obviously say so

`archive_search.py` carries a scan budget and returns `budget_exhausted` with
an opaque 147-character resume cursor. `archive-deeplink.js` correctly refuses
to put that cursor in a URL, for good reasons it states at length. What has
not been checked is what the user is TOLD when a search stops early. A search
that silently returns a partial result set is the same class of defect as a
green dot over a dead session. **Action: read `archive-search-render.js` and
confirm the exhausted state is rendered as a named refusal, not as an empty
tail.**

**ANSWERED, AND NEITHER DOC FAMILY SAID SO.** Both families left this open
while the branch under them closed it, which is the exact shape of a stale
doc. Two facts, each traced. First, the exhausted state IS distinguishable
from an empty answer in the client:
`tests/test_archive_search_zero_hits.node.mjs` exists for that one question,
opening "A ZERO-HIT `budget_exhausted` MUST NOT LOOK LIKE A ZERO-HIT
`complete`", and asserts the two differ on every rendered channel. Second,
the state is now unreachable on the shipped path at all: one index query
covers the scope, so nothing can stop short, and
`tests/test_archive_search_budget.py::test_the_byte_and_transcript_budgets_can_no_longer_bind`
pins that as a REGRESSION GUARD rather than as a description. The vocabulary
word stays in `src/core/archive_search.py` because a caller's branch on it is
still correct, and `src/api/archive_search_routes.py` still documents four
scan statuses rather than two.

### 2.5 A recorded known gap in the search JOIN

**ANSWERED, 2026-09-13, and the answer is NARROWED rather than closed.** See
`docs/archive-search-index.md`. The gap was that the JOIN drops appearance
rows with a NULL `body_id` - 1 of 3,125,122, the line that failed to parse at
ingest. That row still has no body, and now it also has no content block, so
it is still a CANNOT DETERMINE rendered as an absence. What changed is that it
is now REPORTABLE: `meta.coverage` counts every body in scope that is outside
the index and says why, in four named reasons, and an EMPTY page over a scope
holding any of them carries a named `unevaluated` entry.

The larger finding is that the gap named here was not the important one. The
matcher itself was wrong: `INSTR(body_json, needle)` searched the whole jsonl
record, so `claude-opus-4` returned **33,805 bodies of which 165** hold it in
real message text. Search now matches the extracted content blocks through an
FTS5 index. 36.8 percent of bodies carry no message text at all and are
correctly unsearchable; that is the coverage block's whole reason to exist.

### 2.6 The database is 5.2 GB and the app's own state is a rounding error

See section 6. This is the owner's question and it is a real one.

### 2.7 Nothing on the Svelte side knows the archive exists

Zero modules under `web/src` reference it. That is a statement of fact rather
than a defect today, but it is the reason section 7 exists.

---

## 3. Surface 5: `app-screen`

### Why a fifth surface at all, and why now

`web/src/lib/plugins/types.ts` sets the bar itself:

> "A fifth surface arrives with its first consumer or not at all: a surface
> with no reader is a guess about a screen nobody has written yet, and this
> project has paid for that shape before."

The history browser is that consumer, and it is the best one this registry
will ever get. Adam has separately ruled that building surfaces is now a goal
rather than a cost, so the surface does not have to justify itself on
economics. It still has to justify its SHAPE, which is what this section does.

None of the four existing surfaces fits. `session-card-action` is a menu item,
`launchpad-panel` is a component in a named container on one screen,
`sidebar-item` is a row, `status-source` is an opinion about a dot. A screen
with its own URL namespace is a different kind of thing.

**THE SHIPPED SHAPE OF THIS SURFACE, AND WHAT A SHELL OWES A SCREEN MOUNTED ON
IT, LIVE IN `docs/archive-shell-contract.md`.** This section is the DESIGN
ARGUMENT for the surface and stays as written; that document is the INTERFACE,
written against the code slice 1 actually landed, and it is what whoever
rebuilds the application shell for issue #175 reads instead of this one. The
two differ in four named places, because slice 1 changed four things about this
design while building it.

### The surface is EXTRACTED, not invented

`client/js/router.js` already has the shape. It owns inbound URL parsing, it
delegates the pattern set to the feature that owns those paths, it stashes an
unresolved target until authentication completes, and it refuses to redirect
on a malformed link. Its own comment says so:

> "ONE owner, and this file delegates. If archive-deeplink.js is ..."

So the payload type promotes what router.js already asks for. It does not
invent a routing model.

### The payload

Written in the house style of `SurfacePayloads`, to be added beside the
existing four rather than replacing any of them.

```ts
/**
 * A whole screen with its own URL namespace, mounted into the shell.
 *
 * Description: THE THIRD KIND OF THING A PLUGIN CAN BE. A
 *   `session-card-action` is a control, a `launchpad-panel` is a
 *   component in somebody else's screen, and this is a screen. It owns
 *   one path prefix, both directions of the URL for everything under
 *   it, and one container element.
 *
 *   BOTH DIRECTIONS, DELIBERATELY. `parse` reads the address bar and
 *   `buildPath` writes it. A feature that owned only the inbound half
 *   would leave the outbound half somewhere else, and the two would
 *   drift: the screen would show one thing and the address bar another,
 *   which is the failure `archive-screen.js` and `router.js` split
 *   between them today and have to coordinate by hand.
 *
 *   `parse` ANSWERS THREE WAYS AND THAT IS LOAD-BEARING. `no-match`
 *   means this is not our path at all and the host should keep looking.
 *   `cannot-determine` means it IS our path and it is malformed, which
 *   must produce a visible, specific error. A silent redirect to the
 *   prefix root tells the sender their link was fine and shows the
 *   recipient something else. See `archive-deeplink.js`, which measured
 *   why: `session_ref` "journal" belongs to fourteen different
 *   transcripts.
 */
export interface AppScreen<Route = unknown> {
    /**
     * The single leading path segment this screen owns, with no
     * slashes, e.g. 'archive'. Unique across the registry: a second
     * contribution claiming a taken prefix is refused the same way a
     * duplicate contribution id is, and for the same reason.
     */
    readonly routePrefix: string;
    /** The id of the container element in `client/index.html`. */
    readonly screenId: string;
    /** Label for whatever control opens it. Never empty. */
    readonly title: string;
    /**
     * Read the address bar. `search` is the raw query string, and a
     * screen that reads it MUST allowlist rather than denylist: a
     * parameter invented later is then dropped by default instead of
     * published by default.
     */
    parse(path: string, search: string): ScreenRouteResult<Route>;
    /** Write the address bar. The inverse of a successful `parse`. */
    buildPath(route: Route): string;
    /**
     * Put the screen in its container. Called at most once per page
     * life. Goes through `mount.ts` and nothing else.
     */
    mount(container: Element, route: Route, context: PluginContext): void;
    /**
     * A route change WITHIN this screen while it is already mounted.
     * Separate from `mount` because a deep link to a line number must
     * not remount the reader and lose its position.
     */
    show(route: Route): void;
    /** The screen is being left. It stays mounted; the host hides it. */
    hide(): void;
    /**
     * API path prefixes under `/api/v1` this screen is granted. See
     * section 4. An empty array is a screen that talks to no server.
     */
    readonly apiPrefixes: readonly string[];
}

/** What `parse` may answer. Three outcomes, never two. */
export type ScreenRouteResult<Route> =
    | { readonly ok: true; readonly route: Route }
    | { readonly ok: false; readonly token: 'no-match' }
    | { readonly ok: false; readonly token: 'cannot-determine';
        readonly reason: string };
```

`SurfacePayloads` gains `'app-screen': AppScreen`, and `PluginSurface` gains
the string. Nothing else in `types.ts` changes.

### Lifecycle

1. At registration the host records `routePrefix -> contribution`. A duplicate
   prefix is refused loudly, whole-plugin, exactly as `registry.ts` refuses a
   duplicate contribution id today.
2. On navigation the host walks registered screens in registry order and calls
   `parse`. The first `ok` wins. A `cannot-determine` STOPS the walk and
   surfaces its reason: a malformed path belonging to a known prefix must not
   fall through to another screen that happens to accept it.
3. First `ok` for a screen: the host looks up `screenId`, and if it is not in
   the document it warns and does nothing (`mount.ts`'s rule, unchanged).
   Otherwise it calls `mount(container, route, ctx)`.
4. Subsequent `ok` for the same screen: `show(route)`.
5. Leaving: `hide()`. **NOT `unmount`.** Unmounting on leave throws away the
   reader's scroll position, the rail's loaded state and the transcript list's
   filter, all of which the user expects back. The screen element is hidden
   the way every other screen in this app is hidden.
6. `enabled(context)` on the `Contribution` is consulted before any of this.
   The archive reads `message_archive` there, which is where its hand-rolled
   `/features` probe in `archive-entry.js` goes to die.

### Deep links, which already have a contract to satisfy

`archive-deeplink.js` is already pure, already exports its patterns in a
deliberate order, already refuses `session_ref` in a URL, already allowlists
the query string, and is already covered by
`tests/test_archive_deeplink.node.mjs` and
`tests/test_archive_deeplink_start_line.node.mjs`. It becomes `parse` and
`buildPath` almost verbatim. **That is the strongest evidence this surface is
the right shape: the hardest part of it already exists and needs renaming, not
designing.**

`archive-crumb.js` and `archive-crumb-resolve.js` build the breadcrumb from a
route and are the existing outbound half; they feed `buildPath`.

### What the host gives up

Today `router.js` hardcodes `ARCHIVE_PREFIX = '/archive'` and a helper called
`deliverArchiveRoute`. After this it holds a list. The risk is that a bug in
the generic walk breaks a route that a hardcoded branch could not. Mitigation
is a straight port of the existing deeplink suites against the new walk,
plus one new negative test: a registered screen whose `parse` throws must be
skipped with a logged refusal and must not take down navigation for the
others.

---

## 4. Data access, which is the genuinely hard part

Three options were considered.

**(A) The plugin calls `window.API` or `fetch` directly.** What
`api-archive.js` does today. Cheapest, and unbounded: a module that can call
`/archive/transcripts` can call `/sessions/respawn`. Acceptable for
first-party code and a non-starter for the third-party authors #126 exists to
invite.

**(B) The host builds a typed client and injects it.** Better, and it does not
generalise. Every new plugin would need the host to write its bespoke client,
which puts the host back in the business of knowing about each plugin. That is
precisely the dependency direction a module boundary exists to reverse.

**(C) A declared capability, granted by the surface. RECOMMENDED.** The
contribution declares `apiPrefixes: readonly string[]`. The host builds a
fetch function scoped to exactly those prefixes and puts it in the context.
The plugin never sees `window.API`.

C is cheap here because the choke point already exists:
`api-archive.js::callEnvelope` is the one function every archive call goes
through, and it already takes the path as its first argument. So the capability
is one wrapper around one existing function, not a rewrite.

Two rules on it, both following this codebase's existing habits:

- **A path outside the grant is a NAMED refusal, logged, never a silent
  failure and never a 404.** A 404 from a capability check is
  indistinguishable from a broken server, and the person debugging it will go
  looking in the wrong half of the application.
- **The grant is checked against the path as the host resolves it**, after any
  normalisation, so `/archive/../sessions/respawn` cannot cross it. Containment
  is component-wise, never `startsWith`, for the same reason
  `project_directory.py` says so: `/api/v1/archived-thing` must not pass a
  grant for `/api/v1/archive`.

### First-party versus third-party

**Identical mechanism, different review.** The grant is data either way. What
differs is who approves it: ours is approved in code review, a third party's is
printed on its catalog card so a human reads "this plugin will call
/api/v1/archive/*" before enabling it.

That is a sentence #126 needs and cannot write for itself, because it has no
real plugin that has declared a real grant. This work hands it one. Worth
saying to them explicitly: the surface design gets tested against a substantial
feature instead of against a menu item, which is the difference between a
capability model that works and one that was reasoned about.

---

## 5. Surface 6: `terminal-overlay`, PARKED

**The away bar is dropped for now, on the owner's call, and this section is
kept as a sketch rather than deleted.** Verbatim: "we dont need the away bar
right now. we can check in the future if something better fits in."

**It was dropped because the honest finding below said their reasoning was
right for the pane in front of you.** That is worth recording: the analysis
that would have justified rebuilding it is the analysis that stopped it being
rebuilt, and it saved the work rather than costing it. The fleet question
(#172's U78, "while-you-were-away report across the whole swarm") is PARKED,
not dead: search cannot answer it by construction, and if it comes back it
comes back as that rather than as the old bar.

So `terminal-overlay` is not scheduled and is not designed to implementable
depth. What follows is the sketch, kept because the measurement in it is
expensive to re-derive and because six other backlog items would use this
surface.

### The one non-negotiable, recovered from the deleted module

`client/js/terminal-away-bar.js`, deleted in `2bac78b`, carried this, and it
is a measurement rather than a preference:

> "IT IS AN OVERLAY, NOT A ROW. `.terminal-container` is a flex column and an
> in-flow child of it takes rows away from `#terminal`. The ResizeObserver
> reads that as a real geometry change, ships a pty_resize, tmux raises
> SIGWINCH and claude answers with `ESC[2J`, which on the alternate screen
> erases the entire visible conversation. A bar that wiped the screen it is
> asking you about would be a very good joke and a very bad feature.
> `#localServersContainer` paid for this lesson already."

So the surface must make that structurally impossible rather than documented.

### The shape

- **The HOST owns positioning.** The plugin supplies a component and a `slot`
  from a closed set: `'top' | 'bottom' | 'left-rail' | 'right-rail'`. The host
  mounts it into a container it created, positioned out of flow, with
  pointer-events managed by the host. The plugin never sets `position`, and a
  plugin stylesheet that does is a test failure, checked by resolving the
  cascade the way `tests/test_mobile_only_fab_and_header_editor.node.mjs`
  already does rather than by grepping for a string.
- **Session identity is a live accessor, never a cached prop.**
  `search-host.ts` states the rule: "The xterm terminal is REPLACED on a
  session swap and `term.reset()` wipes handler slots, so every accessor
  resolves through `window` at the moment it is called. A field holding 'the
  terminal' is a field describing the session the user left." The context
  carries `sessionId()` and `term()` as functions.
- **The host fires the existing `session-destroyed` event.** `mount-search.ts`
  already listens for it and closes. Overlays get the same.
- **This is also an extraction.** `web/src/lib/terminal-search` already mounts
  `SearchPanel` and `PromptRail` over the pane through `ensurePanel` without
  disturbing the grid. That is a working, shipped, tested precedent for
  exactly this surface, and it should be refactored ONTO the surface rather
  than sitting beside it, or there will be two ways to put something over a
  terminal.

### What else would legitimately mount here

Named so the surface is designed as a surface and not as away-bar plumbing.
From their own backlog: **#168** (time travel scrub, "one slider over the
terminal"), **#148** (modified files rail), **#149** (repo and branch badge in
the terminal footer), **#46** and **#47** from #172 (context-pressure gauge,
burn-rate alarm), **U50** (secrets radar). Six candidates, five of them theirs.
That is the evidence the surface is general.

### The honest assessment of the away bar itself

**Their reasoning for deleting it is correct for the case it covers, and we
are not rebuilding what they removed.** For one pane you are looking at, the
real bytes with search over them beat a derived paragraph, and "a summary that
can disagree with the pane is a summary that will" is right.

What search cannot answer, by construction, is the FLEET question: nineteen
sessions ran overnight, which of them want me. Search is per-pane and
per-terminal. That is #172's U78, "while-you-were-away report across the whole
swarm", and it is a different feature wearing the old one's name.

Three of the four facts the old report carried are still not derivable from
scrollback:

1. **Coverage.** `session_away_report.py` kept `complete` /
   `partial_server_restarted` / `unknown` because the toast store is in memory
   and a restart during the window leaves a bucket that is indistinguishable
   from a quiet session. Scrollback cannot tell you that the record was thrown
   away.
2. **Last activity time.** The activity tracker keeps it in memory and
   publishes only the derived `activity_status`.
3. **Whether the pane is on the alternate screen**, which decides whether
   "full history" means history. See the open question below.

**So the away bar comes back smaller and aimed differently, and it adds less
than it used to.** Said now rather than after it is rebuilt.

### The open question that decides how much less

`session_away_report.py` carried:

> "tmux keeps no scrollback for a pane on the alternate screen, so a 'full
> history' replay of one is the CURRENT SCREEN and nothing before it. Every
> Claude Code session is one of these."

If that is still true, then `ced4fab`'s full history load on a Claude Code pane
gives you one viewport, and search over it searches one screen, and their
replacement does not cover the case the bar existed for.

It may well be stale. Our line sets `AuthConfig.session.disable_alternate_screen`
on by default, which makes panes normal-screen and makes scrollback real, and
CLAUDE.md records that claude 2.1.215 reported `alternate_on=0` with no env var
and no settings key at all.

**This must be MEASURED before anything is built.** It is not arguable from
either side's source. The measurement is: attach to a real pane on a throwaway
`tmux -L cloude-test` socket running a real claude, run the history load
`ced4fab` shipped, and count how many lines come back against how many the pane
has produced. If it returns one screen, the away bar is a restoration. If it
returns real history, the away bar is only the fleet report and should be
scoped accordingly.

---

## 6. Separating the database

The owner asked: "we can seperate the database out? that may be the better
option?"

**The answer is yes, with one real obstacle that has to be decided rather than
discovered.**

### The case for

Measured on the static `cloude.db.bak-v25-20260910T154341Z` backup (5,143,568,384
bytes) so the live file was never opened:

- `transcript_archives` holds **3,703,771,340 bytes** of compressed blob, which
  is **72 percent of the whole file** before its 9.1 million `transcript_records`
  rows and the entire `message_*` family are counted.
- `sessions` is **940 rows** and `projects` is **79 rows**. Measured with
  `dbstat` over that same backup, **the archive family including its indexes is
  5,142,831,104 of 5,143,564,288 bytes, which is 99.99 percent of the file.
  Everything else, every app table plus every app index plus the schema, is
  733,184 bytes.** That is 716 KiB. The app is carrying a five gigabyte
  database to hold under a megabyte of irreplaceable state.
- The breakdown, largest first: `transcript_archives` 3,732,221,952,
  `transcript_records` 972,886,016, its uuid index 310,726,656, its autoindex
  115,597,312, `transcript_root_decisions` 6,311,936. Then `sessions` at
  450,560 and `projects` at 36,864, and nothing else above 50,000.
- The live `cloude.db` is 5.2 GB, and beside it on disk sit a 4.8 GB
  `.bak-v25` and a 5.1 GB `.online-backup.db`: **15.1 GB of disk to protect
  single-digit megabytes of state.** That is a stronger argument than the
  single-file one, and it is measurable today.
- The daily integrity check walks the whole file. On a 7 MB state database the
  cache that CLAUDE.md describes at length would stop mattering.

### The obstacle: three foreign keys cross the boundary, and they are enforced

SQLite `ATTACH` permits cross-database SELECT and JOIN. It does **not** permit
a FOREIGN KEY to reference a table in another attached database, and the
refusal is HARD rather than silent. Measured on sqlite 3.53.4, both databases
in WAL mode, `PRAGMA foreign_keys=ON`, on a throwaway pair of files:

```
CREATE TABLE arch.t(sid INTEGER REFERENCES main.sessions(id))
  -> OperationalError: near ".": syntax error
CREATE TABLE arch.t2(sid INTEGER REFERENCES sessions(id))
  -> OperationalError: no such table: arch.sessions
```

So the constraint cannot be expressed at all. It does not become an unenforced
declaration that looks right and does nothing, which would have been the worse
outcome. This app applies `PRAGMA foreign_keys=ON` to **every connection it
hands out** (`src/core/db.py`, `CONNECTION_PRAGMAS`), so these are enforced
constraints today and not documentation.

> **CORRECTED 2026-09-13, and the correction matters more than the claim.**
> The second line above is WRONG, and wrong in the dangerous direction. The
> unqualified form is **ACCEPTED at DDL time**; `no such table: arch.sessions`
> is raised at **DML time**, on every INSERT, forever. The reference binds to
> `arch.sessions`, which was proven rather than inferred: after creating an
> `arch.sessions`, a value present only there was accepted and a value present
> only in `main.sessions` was refused with FOREIGN KEY constraint failed. And
> `PRAGMA arch.foreign_key_check` returns EMPTY on such a table.
>
> So the reassurance in the paragraph below it does not hold: the constraint
> CAN be expressed, and what you get is a table that accepts DDL, passes every
> integrity check, and can never be written to. A migration copying the DDL
> verbatim would report success and leave a dead archive. Only a real write
> detects it. See `docs/history-archive-db-split.md` and
> `src/core/archive_db_ddl.py`.
>
> **RE-MEASURED INDEPENDENTLY 2026-09-15, sqlite 3.53.4, and it reproduces in
> every clause.** Two files, `PRAGMA foreign_keys=ON`, the archive ATTACHed as
> `arch`. The QUALIFIED form
> `CREATE TABLE arch.tq (sid INTEGER REFERENCES main.sessions(id))` is refused
> at DDL time with `OperationalError: near ".": syntax error`. The UNQUALIFIED
> form `CREATE TABLE arch.t (... sid INTEGER REFERENCES sessions(id))` is
> ACCEPTED, and the first `INSERT` into it raises
> `OperationalError: no such table: arch.sessions`. Then, after creating an
> `arch.sessions` holding only the value 99 while `main.sessions` holds only
> 7: inserting 99 is ACCEPTED and inserting 7 is refused with
> `IntegrityError: FOREIGN KEY constraint failed`, which is what proves the
> reference binds to the ARCHIVE side rather than to the app side.
>
> **AND BOTH INTEGRITY PRAGMAS PASS IT, NOT JUST ONE.**
> `PRAGMA arch.foreign_key_check` returns the empty list AND
> `PRAGMA arch.integrity_check` returns `ok`, on the table whose every write
> is already doomed. The short family named only `foreign_key_check`; the
> second pragma is the one a maintenance job is more likely to be running, so
> it is worth naming too.
>
> The negative control ships:
> `tests/test_archive_db_split.py::test_an_unstripped_cross_database_reference_is_the_silent_trap`
> asserts all three facts against real sqlite and passes. That is why
> `strip_crossing_references` is mandatory and why its caller must PROVE the
> strip worked with a real write rather than by reading the DDL back.

Three cross, all pointing from the archive side into the app side:

| constraint | rows populated |
|---|---|
| `transcript_archives.root_session_id -> sessions(id)` | **1,507** |
| `transcript_archives.project_id -> projects(id)` (v15) | **3,160** |
| `transcript_root_decisions.project_id -> projects(id)` (v15) | **3,160** |

They are populated, so this is not theoretical. Splitting the file means those
three become plain `INTEGER` columns with application-level integrity. That is
a real enforced guarantee being given up and it must be an explicit decision.
The rooting path already writes them explicitly rather than relying on cascade,
and the only `ON DELETE CASCADE` in the archive family
(`transcript_records.archive_id`) is entirely archive-internal and survives the
split untouched.

**Nothing crosses the other way.** No app-side table references an archive
table. `sessions.claude_session_uuid` is a bare `TEXT` column, not a foreign
key, which is what makes the whole idea viable.

### Cross-database reads, which survive

The ingester reads app tables to root what it ingests:

- `transcript_corpus_ingest.py:489` and `transcript_archive.py:827`:
  `SELECT id FROM sessions WHERE claude_session_uuid = ?`
- `transcript_corpus_ingest.py:671`: an antijoin `FROM sessions s` for the gap
  report
- `transcript_import_write.py:130,145,157`: reads `projects` and `sessions`

Under `ATTACH` these keep working with a schema qualifier
(`main.sessions`, `archive.transcript_archives`). Under two independent
connections they do not work at all without doing the join in Python.

### ATTACH or two connections

**Recommended: ONE connection with `ATTACH`.** Reasons, in order:

1. The cross-database reads above are real and are on the ingest hot path.
   Two connections turn three SQL joins into Python loops over 22,828 rows.
2. WAL mode is per-database and works fine for both under one connection.
3. It is the smaller diff. `db.py::connect` gains an `ATTACH` and the archive
   DDL gains a qualifier.

**And one thing ATTACH does NOT buy here, stated because the obvious
assumption is wrong.** SQLite's atomic commit across attached databases is
documented as NOT applying when `journal_mode` is `WAL`, and this app sets
`PRAGMA journal_mode=WAL` on every connection. So a transaction spanning both
files is committed per database, and a crash between the two halves can leave a
rooted archive row pointing at a session write that was rolled back, or the
reverse. **Verify this against the sqlite version actually shipped before
relying on either answer**; it is documented behaviour rather than something
measured here, and it is the one claim in this section taken from
documentation rather than from a running database.

Because of that, the rooting write has to be made idempotent and re-runnable
rather than assumed atomic. That is not a large change and the ingester's
existing discipline is already most of the way there, but it must be a
decision. The alternative is to accept the same risk the two-connection option
carries, in which case ATTACH is still preferred on grounds 1 and 2 alone.

The cost of ATTACH is that it does NOT give an independent lock domain: a long
ingest write still holds the shared connection. If that turns out to matter,
the right answer is a second connection **for the ingester only**, doing its
rooting reads through a small in-Python lookup, and that is a later, separable
decision rather than something to pre-build.

### The migration, and whether it is reversible

**It is reversible, and the reverse must be written and tested in the same
change as the forward.** The owner runs this live with 19 sessions on it.

Forward, as a schema-version step:

1. Take the existing pre-migration backup. `db_backup.take_backup` already
   does this and already verifies it.
2. `ATTACH` a new empty `cloude-archive.db`.
3. Create the archive DDL in `archive.`, with the three cross-boundary
   constraints emitted as plain columns.
4. `INSERT INTO archive.<t> SELECT * FROM main.<t>` for each archive table, in
   dependency order.
5. Verify: row counts match table by table, and a sample of blob sha256 values
   round-trips. `transcript_archives.content_sha256` already exists for
   exactly this kind of check.
6. `DROP TABLE main.<t>`.
7. `VACUUM main` to reclaim the space. **This is the expensive step**: it
   rewrites the whole file and needs free disk equal to the result. It can be
   deferred to a separate operator command rather than run inside boot.

Reverse: the same list inverted, and it is genuinely simple because step 4 is
symmetric. The three foreign keys come BACK as constraints on the way in,
which means the reverse migration must fail loudly if any of the 4,667
populated references has been orphaned in the meantime. That is a feature: it
is the integrity check the split gives up, run once.

**Do NOT rebuild from `~/.claude/projects` instead of copying.** The archive is
usually described as rebuildable and `transcript_root_decisions` is not:
**23,023 rows of append-only human and machine attribution decisions**, which
do not exist anywhere else. Losing those loses every rooting decision ever
made. This is the single most important correction in this section.

### What the integrity gate does with two databases

`src/core/db_integrity.py` keys on one path through `db_path_for(state_dir)`
and publishes one artifact through `latest_path(state_dir)`. Its record already
carries a `db_path` field, which is the seam.

Recommended: **one artifact carrying a LIST of per-database verdicts**, not two
artifacts and not a scalar that silently means "the main one". The reason is
the same three-outcome discipline the module already applies: a reader must be
able to tell "the archive was checked and is sound" from "only the state
database was checked", and two independent artifacts make the second case look
like the first. `verdict` for the pair is the WORST of the two, and
`cannot_determine` on one does not become `ok` for the pair.

Practical note: `PRAGMA archive.integrity_check` works on an attached database,
so this is one extra statement, not a second connection.

### Does the ingester move with the archive

**No, and this is the honest answer rather than the tidy one.** The corpus
ingester is 44 Python modules of server-side code. The plugin surface is
browser-side. There is no server-side plugin runtime: #126 keeps it as an open
design question Adam removed from the roadmap. So the ingester stays core, and
it writes across the boundary through the ATTACH.

The consequence, stated plainly: **the history browser is a plugin on the
client and is not one on the server.** Deleting `web/src/lib/plugins/archive`
still ships `archive_routes.py`, the ingester, and the schema. What the module
boundary actually buys is on the client, where it is the thing that stops the
next 54-module feature growing three more inbound call sites into `app.js`.

### Recommendation

**Do it, in this order, and not first.** The split is worth doing and it is not
the thing standing between the owner and a working history browser. Sequence it
after the archive is switched on and after the surface lands, because both of
those are cheap and this one touches 5 GB of the user's data on a live machine.

**BUILT, AND MERGED.** `docs/history-archive-db-split.md` is the companion
that records what was measured once the schema was actually put in front of
the problem, including the two places this section turned out to be wrong.
The code is nine modules at `src/core/archive_db_*.py`
(`attach`, `copy`, `ddl`, `partition`, `schema_target`, `split`,
`split_refusals`, `split_run`, `unsplit`) with the operator entry point at
`scripts/split_archive_db.py`, all present at `0eb81f0`. This section is kept
as written because it is the reasoning the split was decided on; read the
companion for what was actually done.

---

## 7. Is the history browser really a plugin

The owner said "the whole history browser can be a plugin in reality". He
framed it as a question, so here is the check.

### On the merits, yes, and it is the best candidate in the app

Measured: **the entire core application reaches into 31,474 lines of archive
code through exactly three call sites, and all three go through one module.**

```
client/js/app.js:683                 window.ArchiveEntry.close()
client/js/header-menu.js:276         window.ArchiveEntry.open()
client/js/terminal-search-deep-dive.js:66  global.ArchiveEntry
```

It already owns its own URL namespace, its own screen element, its own
stylesheets, its own API singleton (`api-archive.js`, which its own docstring
calls a "SECOND SINGLETON"), and its own feature flag. Nothing else in this
application is that separable, and nothing else would prove as much about the
registry.

### On the word, no, and that matters to whoever implements it

A browser plugin in this codebase is a build-time TypeScript module compiled
into `client/dist/app.js`. #126 says so in its own first paragraph, and the
reason is `script-src 'self'` with no `eval`, which is never relaxed. There is
no loader, no manifest, no runtime install.

So "the history browser is a plugin" means, precisely and only:

- a compile-time module boundary with a declared dependency direction
- a declared route it owns in both directions
- a declared data grant
- a single enable gate
- registered through the same registry that carries mark-unread

It does **not** mean runtime installability, and an implementation agent told
"make it a plugin" without that sentence will spend a week looking for a
loader that cannot exist.

**Proposed word: the history browser becomes the first FEATURE MODULE.** Same
registry, same surface, same `builtin.ts`. The word is proposed because
"plugin" sets an expectation the CSP forbids anything from meeting, and this
project's own rule is that a confidently wrong description sends the next agent
to write a bug.

### Where it lives

**In `builtin.ts`, beside mark-unread.** Not somewhere else. The registry's
whole value is that there is one list of what is registered; a second
registration path is a second place to look when something does not appear. The
module gets its own directory, `web/src/lib/plugins/history/`, the way
`mark-unread/` has one.

### What this is worth telling them

mark-unread proved a plugin can be a menu item. This proves a plugin can be a
substantial self-contained feature with its own screen, routes and data, and it
forces the capability model in section 4 to be real rather than theoretical.
That is a direct contribution to #126, which currently has to design a
third-party permission story with no example to design against.

---

## 8. The Svelte migration, which is the work

**This section replaced an earlier recommendation and the reversal is recorded
rather than quietly made.** The first pass recommended porting only the seam
and leaving the fifty rendering modules in vanilla, on the grounds that it
bought the whole architectural benefit at about 5 percent of the porting cost.
That was right for the inputs it had and wrong for the real ones. The owner
overruled it, verbatim:

> "well i want to get it running on svelte and i have many changes for it. so
> i want to get the module work going. this is something i really want and i
> want to be able to build upon it in the future."

**The missing input was that the fifty modules are not going to be left
alone.** The seam-only argument rests entirely on the rendering being frozen.
It is not: there are many changes planned and this area is meant to be built on
for a long time. Modifying fifty vanilla modules and then migrating them is
strictly more work than migrating them and then modifying them, and it pays the
hybrid tax twice. So the recommendation is withdrawn, and this is a **full
migration**.

The rule that governed the launchpad migration governs this one and is not
negotiable: **each slice deletes its legacy code in the SAME commit. There is
no dual path at any point.** That rule is what kept the last one honest, and
issues #110, #116, #118 and #121 are all what the exceptions cost.

### 8.0 The prerequisite, which is not a slice

**Nothing here starts until the browser renders the corpus.** Section 2.0: the
browser reads `message_*` and the ingester fills `transcript_archives`, and the
message tables are empty. Another agent is on that now, working from this
document.

This is a sequencing rule with a hard reason: **a migration of a screen that
renders nothing cannot be verified.** Every slice below is checked by driving
the real screen and comparing against what the vanilla version did with the
same data. With no data, every one of those checks passes vacuously, which is
`docs/LESSONS.md`'s "a test that cannot fail is not evidence" applied to a
whole screen at once.

What step 1 produces is the **baseline**: a screen rendering 22,828 real
transcripts, captured before a single module moves, and that recording is what
each slice is diffed against.

### 8.1 The inventory, grouped by what it actually does

All 54 modules, 17,387 lines, none unassigned. Re-derived 2026-09-13, not
quoted.

| group | modules | lines |
|---|---|---|
| routing and the way in | 4 | 1,161 |
| the API client | 1 | 523 |
| the shell, its panes, the script loader | 6 | 1,405 |
| state, keys, format | 4 | 1,310 |
| the navigation rail | 9 | 3,063 |
| the transcript list | 4 | 1,325 |
| the reader and the virtual list | 10 | 3,321 |
| the chat view | 9 | 2,947 |
| search, export, outcome, mask | 7 | 2,332 |
| **total** | **54** | **17,387** |

Beside them, 12 stylesheets totalling 4,444 lines. **They are not ported.**
Slices reuse the existing class names and stylesheets exactly as the launchpad
slices did, Tailwind is layout only, and no colour literal appears anywhere,
only `var(--color-*)`. Rewriting 12 stylesheets while porting 17,387 lines of
logic doubles the risk and puts 26 themes in play for no gain. Revisit after
the last slice, or never.

### 8.2 The nine slices, ordered by risk and verifiability

The ordering is NOT by file count and not smallest-first. It is: **the thing
most likely to be wrong in design goes first, while it is still cheap to
change.** Then the things that unblock verification of everything after them.
Then the bulk, in dependency order. Then the security-sensitive parts last,
when everything around them is stable.

---

**Slice 1. The `app-screen` surface, and the way in. 4 modules, 1,161 lines.**

Moves: `archive-deeplink.js` (469), `archive-entry.js` (311),
`archive-crumb.js` (260), `archive-crumb-resolve.js` (121) into
`web/src/lib/plugins/history/`. Adds `app-screen` to `types.ts`, the prefix
table and the navigation walk to `registry.ts`, and the registration to
`builtin.ts`.

Deleted in the same commit: those four modules; the `ARCHIVE_PREFIX`,
`parseArchivePath` and `deliverArchiveRoute` block in `client/js/router.js`;
and the three inbound call sites (`app.js:683`, `header-menu.js:276`,
`terminal-search-deep-dive.js:66`), which become one registry lookup each.

**THIS IS THE SLICE THAT PROVES THE SURFACE, AND IT IS FIRST FOR THAT REASON
ALONE.** It exercises every part of the `app-screen` contract at once:
`routePrefix`, all three `parse` outcomes, `buildPath` on the way out,
`screenId`, and `mount` / `show` / `hide`. If the surface is the wrong shape,
1,161 lines is what it costs to find out, and the other eight slices have not
been written yet. Putting the rail or the reader first would mean discovering a
bad contract with 6,000 lines already committed to it.

It is also the slice with the **lowest code risk and the highest design risk**,
which is the correct thing to do first.

Verified by:
- Porting `test_archive_deeplink.node.mjs`,
  `test_archive_deeplink_start_line.node.mjs`,
  `test_archive_crumb_resolve.node.mjs` and `test_archive_entry_points.node.mjs`
  to Vitest. These are already pure and already good, and the deeplink suite
  already proves the PATTERN ORDER saves it rather than proving the anchoring
  does. Keep that property; it is the best test in the archive suite.
- **Driving the real screen.** Paste each of the four URL shapes and confirm the
  screen and the address bar agree. Paste `/archive/t/notanumber` and confirm a
  visible, specific error naming the segment, and confirm the URL is NOT
  rewritten to `/archive`.
- **The negative control, which is the load-bearing test.** A registered screen
  whose `parse` throws must be skipped with a logged refusal, and navigation
  must still work for every other screen. A walk that took the whole router
  down with one bad plugin would pass every positive test.
- A second negative control: a second contribution claiming a taken
  `routePrefix` must be refused whole-plugin and logged, the way `registry.ts`
  already refuses a duplicate contribution id.

---

**Slice 2. The granted client. 1 module, 523 lines. No visual change.**

Moves `api-archive.js` into `history/client.ts` and puts the `apiPrefixes`
enforcement in the host. The plugin stops seeing `window.API`.

Deleted same commit: `api-archive.js` and its `<script>` tag.

Second in order because **everything after it depends on the data path, and a
no-visual-change slice is the cheapest place to get a security control wrong
and notice.**

Verified by:
- `test_archive_api_calls.node.mjs` ported.
- **The negative control, which is the entire point of the slice**: a call to a
  path outside the grant is refused, named and logged, and the refusal is
  distinguishable from a 404. A test that only proves the granted paths work
  would pass identically against no enforcement at all.
- Containment is component-wise: assert that a grant for `/api/v1/archive`
  refuses `/api/v1/archived-thing` and refuses `/api/v1/archive/../sessions/respawn`.

---

**Slice 3. The shell, its panes, and the end of the script loader. 6 modules,
1,405 lines.**

Moves `archive-screen.js` (499), `archive-screen-views.js` (155),
`archive-screen-shell.js` (119), `archive-screen-tools.js` (101),
`archive-pane-resize.js` (394).

**`archive-loader.js` (137) is DELETED AND NOT PORTED.** It is the same-origin
script loader from closed issue #48, which exists to lazy-load the archive
family so the app does not parse 17,387 lines on boot. Vite does code splitting
natively, so the whole module and the problem it solves both go away. That is a
real, measurable win from this migration and it belongs in the record.

Verified by: `test_archive_pane_resize.node.mjs`,
`test_archive_controls_trimmed.node.mjs`, `test_archive_full_page_mode.node.mjs`
and `test_archive_header_icon.node.mjs` ported; plus **driving the resize
handle and full-page mode at 330px and at desktop width**, because pane
geometry is the class of thing a unit test agrees with and a browser does not.
Plus one measurement: boot-time bytes parsed before and after the loader is
deleted.

---

**Slice 4. State, keys, format. 4 modules, 1,310 lines.**

Moves `archive-state.js` (359), `archive-keys.js` (386),
`archive-keys-help.js` (191), `archive-format.js` (374). Creates the store the
remaining five slices render from.

Verified by: `test_archive_keys.node.mjs` and `test_archive_format.node.mjs`
ported, plus **driving every key the help overlay documents** and asserting the
overlay and the handler come from the same source. A key shown in help and
bound to nothing is exactly the shape `session-status-key.js` exists to
prevent on the status lights.

---

**Slice 5. The navigation rail. 9 modules, 3,063 lines.**

`archive-nav.js` (493), `-info` (471), `-row` (466), `-order` (447), `-card`
(437), `-merged` (273), `-fuzzy` (242), `-drill` (135), `-tree` (99).

First of the bulk slices because it is the first thing on screen: if it is
wrong, you see it immediately rather than three slices later.

Verified by: `test_archive_nav_cards`, `test_archive_nav_list`,
`test_archive_nav_merged_cache`, `test_archive_nav_names` and
`test_archive_nav_order` ported, plus a **browser diff against the slice-0
baseline recording**: the same corpus, the same rail, the same order, the same
counts.

---

**Slice 6. The transcript list. 4 modules, 1,325 lines.**

`archive-tlist-row.js` (483), `archive-transcript-list.js` (439),
`archive-tlist-filter.js` (276), `archive-row-cache.js` (127).

Verified by: the tlist suites ported, plus **the first real scale check**: the
list rendered over the full 22,828 transcripts, with the filter driven, and
the numbers recorded. Closed issue #52 ("reuse archive row nodes when the
visible window is unchanged") is a performance property that a port can silently
lose; assert it survives rather than assuming Svelte's keyed each does it.

---

**Slice 7. The reader and the virtual list. 10 modules, 3,321 lines.**

`archive-reader.js` (605), `archive-screen-reader.js` (499),
`archive-line-render.js` (497), `archive-virtual-list.js` (493),
`archive-body-cache.js` (421), `archive-reader-dom.js` (201),
`archive-body-gate.js` (191), `archive-reader-paging.js` (152),
`archive-reader-select.js` (137), `archive-reader-body.js` (125).

**The largest and the highest-risk slice, and it is deliberately seventh.** A
virtualised list over a 233 MB transcript is the kind of code where a port that
looks correct is off by a row, and it should land on a shell, a store, a rail
and a list that are all already proven.

Verified by: `test_archive_line_render`, `test_archive_body_size_gates`,
`test_archive_offset_units`, `test_archive_body_bounds` ported, plus **a real
scroll drive over the largest transcript in the corpus**, comparing rendered
line numbers against `transcript_records.line_no` from the database rather than
against the component's own idea of what it rendered. Plus a frame-cost
measurement against the baseline.

---

**Slice 8. The chat view. 9 modules, 2,947 lines.**

`archive-chat-view.js` (489), `-subagents` (457), `-block` (414), `-screen`
(406), `-turn` (352), `-info` (270), `-stack` (219), `-estimate` (185),
`-clicks` (155).

Verified by: `test_archive_chat_render.node.mjs`,
`test_archive_chat_view.node.mjs` and the turn and subagent suites ported, plus
a browser diff against the baseline on a transcript that **actually contains
sub-agent runs**, since the fold is the part most likely to be silently wrong
and the part a synthetic fixture will not exercise.

---

**Slice 9. Search, export, outcome, mask. 7 modules, 2,332 lines.**

`archive-outcome-view.js` (499), `archive-export.js` (488),
`archive-search-render.js` (316), `archive-mask.js` (301),
`archive-search.js` (263), `archive-fuzzy.js` (239), `archive-outcome.js` (226).

**Last on purpose, for two reasons.** The mask is a security control: it is the
thing that keeps a credential out of a rendered transcript, and it should move
when everything around it is stable rather than while the reader underneath it
is in flux. And search is the module most likely to change shape from step 1's
data repoint, so porting it early risks porting it twice.

Verified by: `test_archive_mask.node.mjs` and
**`test_archive_mask_refusal.node.mjs`**, which is already the negative control
this whole area needs and must be ported first and unchanged, plus
`test_archive_export_states`, `test_archive_outcome_classify` and
`test_archive_outcome_prose`. Plus the honest-search check from section 2.4:
drive a search to `budget_exhausted` and confirm the user is told.

---

### 8.3 What happens to the 72 test files

They are not deleted and they are not left behind. Per slice:

- **The 39 node suites** read the vanilla source or build a DOM around it. Each
  is ported to Vitest **in the slice that moves its subject**, in the same
  commit, and the node file is deleted in that commit. A node suite left
  pointing at a deleted module is exactly issue #118, which this line is
  already paying for once.
- **The 33 Python suites** test the server and are **untouched by this
  migration**, except where step 1's repoint changes what they assert. They are
  that agent's concern, not a slice's.
- **Two fixtures**, `tests/archive_fixture.py` and
  `tests/archive_turn_fixture.py`, are server-side and stay.
- **A suite is ported, never rewritten from its subject.** Rewriting a test
  against the new implementation is how a port ships a behaviour change with a
  green run. Where a node suite asserts on markup that genuinely changes, the
  ASSERTION is updated and the CASE is kept, and the commit message says which
  and why.

**And the standing warning from `docs/LESSONS.md`, which this migration is the
most likely thing in the repo to trip:** "if a test constructs its input and
its expectation from one source, it proves nothing." The launchpad migration
shipped changes unit tests could not see because the tests handed in a recorder
and asserted what was asked for rather than what happened. **So every slice
above names a real-screen check as well as a suite, and the real-screen check
is the one that counts.** A slice whose only evidence is a green Vitest run is
not verified.

### 8.4 Where the 22 server modules sit

They sit **underneath slice 2 and nowhere else.** The client talks to
`/api/v1/archive/...` and does not know which tables answer. So step 1 can
repoint 22 modules from `message_*` to the archive layer without touching a
single slice, provided the **route shapes and the envelope shapes do not
move**.

That proviso is the whole coordination surface, and it is one sentence rather
than a schedule: **if step 1 needs to change a response shape, it must land
before the slice that consumes it, and it must say so.** Concretely, the rail
shapes gate slice 5, the transcript list shapes gate slice 6, the line and body
shapes gate slice 7, the turn shapes gate slice 8, and the search and export
shapes gate slice 9.

**Read what that agent lands before finalising any slice past 2.** Their work
is in flight as this is written and this document has not seen it.

### 8.5 What "build upon it in the future" needs

This is the actual reason for doing the migration now rather than later, so it
is stated rather than implied. Four things the migration must leave behind, or
the next feature pays for the port a second time.

**1. A named mount point for a new view, not a new screen.** The archive has
three views today (rail, list, reader) plus the chat view over the reader.
A fourth, a fifth and a timeline (#172's U77, "event-stream timeline of a
session, built from the transcript already ingested into the archive") are
plainly coming. So slice 3 gives the shell a `views.ts` array of
`{id, label, component}` in display order, the same shape section 6 of
`.claude/notes/svelte-migration-launchpad.md` prescribed for panels, and the
shell renders from that array. Adding a view is then one entry, not a new
branch in a switch.

**2. The feature module's PUBLIC SHAPE is the `Plugin` object and nothing
else.** Everything inside `web/src/lib/plugins/history/` is private to it. What
the app may rely on is: the id, the contributions, the `routePrefix`, and the
`apiPrefixes`. No other module may import from inside the directory, and that
is checkable in one grep, so it should be a test. The moment something outside
imports `history/reader/VirtualList.svelte`, the boundary is gone and nobody
will notice until the next port.

**3. Per-line and per-turn decoration must be an extension point, not a
branch.** The most likely shape of "many changes" here is wanting to put
something beside a line or a turn: a diff link, a cost figure, a secret
warning, a jump to the live session. If slices 7 and 8 render decorations from
a list the way the session row menu renders its items, that is one array entry
later. If they inline them, every one is a new conditional in a 500-line
component. **This is the single highest-value thing the migration can leave
behind** and it costs almost nothing to do while the components are being
written anyway.

**3b. An import-direction test, pinned in slice 1.** Nothing outside
`history/` imports into it, nothing inside it imports from `launchpad/`,
`sessions/` or `terminal-search/`. Thirty lines, written once, and it is what
keeps items 1 and 2 above true in a year. Section 10.5 explains why this is the
highest-value free item in the whole scope.

**4. The store is one store, keyed by route.** Not four stores per endpoint.
The launchpad migration's KISS section made this call and it held. A second
store is how two parts of one screen come to disagree about which transcript is
open.

What this deliberately does NOT build: no manifest schema, no loader, no
consent flow, no settings page, no third-party anything. Those belong to #126
and building them here would be inventing a catalog inside a screen migration.

### 8.6 What would make this a bad idea, stated so it can be checked

The door stays open in both directions, so here is what would reopen it.

**If the slice-0 repoint turns out to need the client to change shape**, then
the migration is porting a moving target and slices 5 through 9 should wait for
it to settle. That is a real possibility: section 2.0 says the two stores are
not obviously isomorphic. **The signal is step 1 changing an envelope shape
rather than only a query.** If that happens, slices 1 to 4 still stand, because
nothing in them depends on a response body.

**If the virtual list in slice 7 cannot be ported without a measurable
regression**, keeping that one module in vanilla behind the Svelte shell is a
defensible outcome and is not a failure of the plan. It is the one piece where
the framework is not obviously an improvement. Say so with numbers if it
happens rather than shipping a slower reader quietly.

Nothing else looks like a trap. The area is genuinely self-contained, the
routing is already pure, the tests are unusually good, and the stylesheets are
staying put.

### What "finished" means here, separated from "is Svelte"

**"Finished" means the owner can open the history browser on his own machine,
find a conversation from any of the 22,828 ingested transcripts, read it,
search it, link to it, and have the link work when he pastes it.** Nothing in
that sentence mentions a framework, and today it fails at the first clause for
the reason in section 2.0: the browser reads an empty store.

Specifically:

1. **The browser reads a store the background ingester actually fills**, so
   opening it shows the corpus rather than an empty rail. Section 2.0. Until
   this is true, nothing else in this list can even be observed.
2. The archive stays ON for him and the header control stays visible because
   the server was measured as enabled, not assumed.
3. Every gap in section 2 is closed or is recorded here as a decided non-goal
   with its reason.
4. Search tells the truth when it stops early.
5. The browser has been measured at 22,828 transcripts, not at whatever it was
   built against.
6. The `app-screen` surface exists, the archive is registered through it, and
   the three inbound call sites have become one registry lookup.
7. The capability grant is enforced, with a test that proves a REFUSAL rather
   than a test that proves the grant.
8. The database separation question is answered in writing, whether or not the
   split ships.

**"Is Svelte" is a SECOND definition of done and both are wanted, in order.**
The owner has ruled he wants the migration, so it is not optional. But the two
must not be collapsed, because collapsing them is how step 2 gets started
before step 1 has made it verifiable:

- **Done (feature)** is the eight items above. It is reached by step 1 and by
  the three small items beside it, and it is reachable with every line of the
  screen still in vanilla.
- **Done (module)** is the nine slices of section 8 landed, every node suite
  ported, every legacy module deleted in the commit that replaced it, and the
  four things in 8.5 left in place so the next feature is cheap.

A history browser that is Svelte and shows an empty rail is not finished by
either definition, and it is the outcome to guard against.

---

## 9. The sequence, which is now fixed

Three steps, in this order, and the order is a ruling rather than a preference.

**Step 1. Connect the browser to its data.** Section 2.0. Another agent holds
this now. Fix A as a same-day stopgap so the UI can be seen at all, then the
column mapping study, then Fix B. **It is first and it is not negotiable,
because a migration of a screen that renders nothing cannot be verified**, and
because its output is the baseline recording every slice below is diffed
against.

**Step 2. The full Svelte migration, as a feature module.** Section 8. Nine
slices, ordered by risk and verifiability rather than by size. Slice 1 proves
the `app-screen` surface and is first for that reason alone; slice 2 proves the
`apiPrefixes` grant with a refusal test; slices 3 to 9 are the bulk, with the
virtual list seventh and the secret mask last. Each slice deletes its legacy
code in the same commit, ports its own node suites to Vitest in that commit,
and is proven by driving the real screen and not only by a green Vitest run.

**Step 3. Separate the archive database.** Section 6. Independent of both of
the above and can run in parallel with either, since it moves tables and
changes no route. Forward and reverse in the same change, the three foreign
keys resolved explicitly, the integrity gate carrying a list, and the migration
COPYING rather than re-ingesting because `transcript_root_decisions` holds
23,023 human decisions that exist nowhere else.

**Not scheduled:** the `terminal-overlay` surface and the away bar. Section 5.

Each slice in step 2 is a thing one agent can pick up, claim with a draft PR
and close on its own, per the work protocol. None of them is a container.

Alongside them, three small items that are not slices and do not block
anything. **TWO OF THE THREE ARE NOW CLOSED**, and this sentence listed all
three as open for two days after they were not:

- search telling the truth when it stops early (section 2.4): **closed.**
  `budget_exhausted` is unreachable on the index path and is pinned by
  `tests/test_archive_search_budget.py`, and the zero-hit distinction is
  pinned by `tests/test_archive_search_zero_hits.node.mjs`.
- the recorded `archive_search.py:107` known gap (section 2.5): **closed,
  narrowed rather than eliminated.** See `docs/archive-search-index.md`.
- re-measuring the browser at 22,828 transcripts (section 2.3): **still
  open**, and slice 6 does it anyway.

**Step 3 above is also done**: the split shipped, and its record is
`docs/history-archive-db-split.md`. Step 1 and step 2 are what remain, and
step 2 has one slice landed of nine.

## 10. Standing it up alone, some day

The owner, verbatim: "also this can realistically in the future be a standalone
project. not needed right now, but it probably already is close".

**This is a capture, not a plan, and nothing in it adds work to the nine
slices** except where it is genuinely free and says so. "Not needed right now"
is a constraint on this section, not a hedge. What follows is an honest read on
how close it actually is, and then the only list that matters: what is **free
now** because the code is being touched anyway, against what is **expensive
later** once it has set.

### 10.1 How close is it really

**On the client, closer than he thinks. On the server, further, and the
distance is in one specific layer.**

**First, a correction to a figure this document has carried since its first
draft.** The server side is not 44 modules. That number came from
`grep -iE 'archive|corpus'`, which misses every `transcript_*` and most
`message_*` module. Measured properly:

| group | modules | lines |
|---|---|---|
| browse, read, search, export (`archive_*`) | 33 | 10,043 |
| ingest and import (`corpus_*`, `transcript_*`) | 16 | 6,029 |
| the v16 message model (`message_*`) | 20 | 6,960 |
| **total** (one module counted in two groups) | **68** | **22,750** |

So the extraction surface is **68 modules and 22,750 lines, not 44 and
14,087.** The original figure undercounts it by a little over half. The nine
slices are unaffected, because they are client-side, but any estimate of a
standalone split that used 44 was wrong by that much.

**The client is genuinely close and this is the cheapest good news in the
document.** All 54 modules together reach for exactly **eight host globals**:

```
 17 refs / 9 modules   window.API
 11 refs / 4 modules   window.ModalStack
  6 refs / 1 module    window.App
  6 refs / 1 module    window.ModuleLoader
  4 refs / 1 module    window.Router
  2 refs / 1 module    window.Auth
  2 refs / 1 module    window.ModuleFamilies
  2 refs / 1 module    window.NavigationGeneration
```

Four of those eight are touched by exactly one module each, and **the nine
slices already remove five of them as a side effect of work that is happening
anyway**: `window.API` becomes the granted client in slice 2, `window.Router`
and `window.App` are severed in slice 1 when `archive-entry.js` goes,
`window.ModuleLoader` and `window.ModuleFamilies` disappear in slice 3 when
`archive-loader.js` is deleted rather than ported. **What is left after slice 3
is `ModalStack`, `Auth`, and `NavigationGeneration`**, and two of those three
are single-module, single-purpose reaches. That is a very short list for
17,387 lines of client code.

**On the server the browse half is also close, and the ingest half is not.**
Measured by import direction across the whole family:

**Archive reaching OUT into CloudeCode**, twelve distinct targets. Eight are
shared infrastructure that a standalone project would simply own a copy of:
`src.core.db` (11 imports, the connection helper), `src.core.trail_entry` (5),
`src.config` (3), `src.core.db_models` (3), `src.core.json_artifact` (1),
`src.core.claude_project_dirs` (1, and that one arguably belongs WITH the
archive since it is Claude Code's transcript-path slug rule). `src.api.auth`
(7) is a real host dependency and is section 10.4.

**The four that are genuine coupling are all in one layer**, and this is the
single most useful sentence in the section: `src.core.project_writes`,
`src.core.project_store`, `src.core.claude_title_sync` and
`src.core.session_kind` are imported by `project_archive.py`,
`transcript_project_root.py`, `transcript_import_facts.py` and
`transcript_import_write.py`. **Every one of them is in the rooting and import
path, and not one of them is in the browse path.** The thing that reads and
renders a transcript does not know CloudeCode exists. The thing that decides
which SESSION a transcript belongs to obviously does, and cannot not.

**CloudeCode reaching IN to the archive**, seventeen targets, of which most are
bookkeeping that a split dissolves: `main.py` mounting five routers,
`db_steps.py` importing six DDL modules, and the feature flag read in three
places. **Two are real and both are worth naming now:**

1. **`src/core/secret_scan.py` imports `src.core.message_model_secrets`.** The
   secret detectors are a deliberate single source of truth shared between the
   repository's own secret scanner and the transcript message model. CLAUDE.md
   says so on purpose. **This module belongs to both projects and is the
   clearest genuine ambiguity in the whole family.** It is also the easiest to
   resolve, because it is pure pattern matching with no state: whichever side
   keeps it, the other vendors it or depends on it as a tiny package.
2. **`src/core/session_project_binding.py` imports `canonical`,
   `git_top_level` and `is_scratch` from `src.core.transcript_import_paths`.**
   CloudeCode's session-to-project binding depends on the archive's path
   canonicalisation rules. That is the wrong direction for a split and it is
   the one inward dependency that would actually have to be moved rather than
   deleted. It is small: three pure functions.

**One trap, found while measuring and worth recording because the name invites
it.** `src/core/project_archive.py` is NOT part of this. It archives a
PROJECT, the soft retirement of a shelf in the launcher, and has nothing to do
with transcripts. Anything that globs `*archive*` on the server picks it up and
is wrong. It stays with CloudeCode.

**Honest summary of distance.** The browse half, 33 modules and 10,043 lines,
is close to free-standing today. The message model, 20 modules, is
self-contained by construction. The ingest and import half, 16 modules, is
entangled with session and project state **and should be**, because rooting a
transcript to a session is definitionally a CloudeCode question. So the split
is not "lift 68 modules out". It is "lift 53, and decide what the other 15
become". That is a real project and it is not a weekend, but it is also not a
month of untangling, because the entanglement is concentrated rather than
spread.

### 10.2 The data boundary, and whether this changes the split

**It does not change the design and it does strengthen the argument, which is
worth saying because a second independent reason to do something is not the
same as a better reason.**

Section 6 already recommends separating the archive into its own database file,
on size, backup asymmetry and boot cost. A standalone project needs its own
store by definition, so this is the same recommendation reached from a second
direction. Nothing in section 6's design changes: same `ATTACH`, same three
foreign keys to resolve, same copy-not-re-ingest rule because
`transcript_root_decisions` holds 23,023 decisions that exist nowhere else.

**One thing it does sharpen.** Section 6 treats dropping the three cross-boundary
foreign keys as a cost. Under this lens it is partly a benefit: those three keys
(`transcript_archives.root_session_id`, `transcript_archives.project_id`,
`transcript_root_decisions.project_id`) are exactly the schema-level expression
of "this archive belongs to a CloudeCode session", and a standalone browser
would need them to be soft references anyway. So the split is not only making
them unenforceable, it is converting them into the interface. Say that in the
migration's commit message rather than apologising for losing a constraint.

**Sequencing is unchanged.** Step 3, after the data connection and the slices.
Doing it earlier for standalone reasons would be optimising for a thing the
owner has explicitly said is not needed now.

### 10.3 The ingester, which is the part that decides weekend or month

**A standalone history browser needs transcripts to arrive. There are two
honest answers and they cost very differently.**

**Answer A: it takes the ingest half with it.** The 16 `corpus_*` and
`transcript_*` modules go, and it gains its own scheduler. That is the clean
product: point it at `~/.claude/projects` and it works for anyone, with no
CloudeCode anywhere. The cost is the four genuine couplings in 10.1, all in the
rooting path, so what it actually loses is the ability to say "this transcript
belongs to session X". For a standalone browser that is not a loss, it is a
feature it never had.

**Answer B: it takes only the browse half, and the corpus arrives some other
way.** Smaller, and it makes the product a viewer over a database somebody else
fills, which is a much weaker thing.

**A is right, and the split inside those 16 modules is already visible.** The
rooting and attribution code (`transcript_project_root.py`,
`transcript_import_facts.py`, `transcript_import_write.py`, and
`project_archive.py` which is not in the family at all) is CloudeCode's. The
discovery, hashing, byte-exact archiving and scan-plan code
(`corpus_ingest_service.py`, `corpus_ingest_scan.py`, `corpus_ingest_state.py`,
`corpus_ingest_task.py`, `transcript_corpus_discover.py`, `transcript_archive.py`)
is the browser's, and none of it imports session or project state.

**The ambiguous ones, named now because they are what decides the estimate:**

- `transcript_corpus_ingest.py` (684 lines) is BOTH. It ingests, which is the
  browser's, and it roots against `sessions` and `projects`, which is
  CloudeCode's. It is the single file where the two jobs are mixed, and
  splitting it is the largest single piece of work in any extraction.
- `transcript_import_paths.py` is the one CloudeCode already imports FROM
  (10.1). Its three pure functions would most naturally move to CloudeCode and
  be re-imported, or become a shared two-hundred-line package.
- `message_model_secrets.py` belongs to both, as above.

**That is the whole ambiguity: three modules.** Everything else partitions on
inspection. **So the honest estimate is closer to a weekend than a month**, and
the reason is that the entanglement is three files rather than a diffuse
pattern. If someone tells you otherwise later, this measurement is the thing to
re-take.

### 10.4 What it genuinely needs from the host

Five candidates. For each: sever, or define as an interface now.

**Auth. DEFINE AN INTERFACE, and it is already half defined.** Seven archive
routers import `src.api.auth.require_auth` as a FastAPI dependency. That is
already the right shape: a dependency injected at the router, not auth logic
inside archive code. A standalone project supplies its own `require_auth` and
changes nothing else. **Nothing to do. It is already standalone-shaped by
accident**, and that is the cheapest kind of good news.

**Themes. SEVER, and it costs nothing because the coupling is a convention, not
an import.** The 12 archive stylesheets use `var(--color-*)` and existing class
names, and the slices explicitly keep doing that. A standalone project ships a
default token set and the same stylesheets work. Nothing imports a theme.

**The string catalog. DEFINE AN INTERFACE, cheaply, and only if a slice is
touching the string anyway.** `web/src/lib/i18n` exists. A feature module that
hardcodes English is not extractable without a pass over every component.
Routing strings through the existing catalog as each slice is written is nearly
free; going back afterwards is a full re-read of 17,387 ported lines.

**The status model. SEVER. It is not used.** No archive module imports
`StatusLed` or the session status machinery. The archive has its own outcome
vocabulary in `archive-outcome.js`. Already clean.

**Navigation. ALREADY BEING SEVERED, by slice 1.** That is what the
`app-screen` surface is: `routePrefix`, `parse`, `buildPath`, `mount`. A
standalone project implements four functions of host and the feature module
does not change. **The surface designed in section 3 for plugin reasons turns
out to be exactly the extraction seam, which is a coincidence worth noticing
rather than a plan.**

### 10.5 Free now versus expensive later

**This is the section. Everything above is evidence for this list.**

**FREE NOW, because the code is being rewritten anyway. Fold these into the
slices and do not treat them as extra scope.**

1. **An import-direction test, pinning `history/` as a leaf.** Nothing outside
   `web/src/lib/plugins/history/` may import from inside it, and nothing inside
   it may import from `web/src/lib/launchpad/`, `sessions/` or
   `terminal-search/`. It pins the dependency arrow **outward-only: the module
   may depend on the host's published seams, the host may depend only on the
   `Plugin` object.** Cost: one test file, about thirty lines, written once in
   slice 1. **This is the single highest-value item here.** During a rewrite it
   is nearly free; afterwards it is near impossible, because by then there are
   violations and each one is an argument.
2. **Strings through the i18n catalog as each component is written.** Cost:
   minutes per slice. Later: a full pass over every ported line.
3. **Keep the four host globals out of the new components.** Slices 1, 2 and 3
   already remove five of the eight. The free part is simply not introducing new
   ones: any host reach goes through the `PluginContext` or the granted client,
   never `window`. Cost: zero, it is the design already.
4. **Name the three ambiguous server modules in their own docstrings.** One
   paragraph each in `transcript_corpus_ingest.py`, `transcript_import_paths.py`
   and `message_model_secrets.py` saying which project it would belong to and
   why. Cost: fifteen minutes, and it is the thing nobody can reconstruct in a
   year.
5. **Do not let a slice add a NEW import from archive code into session or
   project state.** Today there are four and they are all in the rooting path.
   Free to preserve, expensive to unwind.

**EXPENSIVE LATER, and deliberately NOT done now. Listed so the cost is known
rather than discovered.**

- **Splitting `transcript_corpus_ingest.py`.** 684 lines mixing ingest and
  rooting. Real work, no benefit today, and the file is not otherwise being
  touched. **Optional, and not recommended now.**
- **Moving `transcript_import_paths`' three functions out of the archive
  family.** Would remove CloudeCode's one wrong-direction dependency. Small,
  but it touches `session_project_binding.py`, which is their area and is
  exactly the kind of unasked-for tidying the work protocol warns about.
  **Optional. Raise it with them rather than doing it.**
- **A package boundary for `message_model_secrets`.** Only worth it at
  extraction time.
- **Extracting the server at all.** 68 modules. Not now.

### 10.6 Would it be a real product

**Yes, and the reason is specific rather than enthusiastic: the addressable
set is everyone who uses Claude Code, not everyone who uses CloudeCode.**

CloudeCode's premise is driving live sessions from a phone. The archive
browser's premise is reading what already happened, and that corpus exists on
the machine of every Claude Code user whether or not they have ever wanted a
phone client. On this machine alone that is **22,828 transcripts, 26.4 GB raw**,
accumulated as a by-product, with no tool that reads it. The corpus is a
documented on-disk format the browser already parses, so the product needs
nothing from CloudeCode to be useful to a stranger.

It is also **not a product that only makes sense inside this app**, which is
the test that matters. The one thing it would lose standalone is the session
rooting, and that is precisely the part a stranger with no CloudeCode sessions
would never use.

**So the honest answer to "is any of this worth an hour of extra effort" is:
the five free items in 10.5 are worth it, and nothing else is yet.** Item 1
alone, the import test, is worth more than the other four together, and it is
thirty lines in slice 1. The expensive items stay on this page and off the
schedule until the owner says otherwise.

## 11. Open questions

1. PARKED with the away bar: does a full-history load reach past one screen on
   a Claude Code pane? See section 5. If the fleet report is ever picked up,
   this is the first thing to measure and it is not arguable from either
   side's source.
2. Does the ingester ever want its own connection, or is ATTACH enough
   forever? Section 6 recommends ATTACH and names the condition under which
   that changes.
3. Does `db_integrity` carry a list or grow a second artifact? Section 6
   recommends a list and gives the reason.
4. PARKED with the surface: should the `terminal-search` slice be refactored
   onto `terminal-overlay` if it ever lands? It is their code and the question
   is theirs.
6. **Live, and the only one that can change section 8.** Does step 1's repoint
   change any response SHAPE, or only the query behind it? Only a shape change
   reaches the client, and section 8.6 says which slices it would hold up.
   Whoever holds step 1 should answer this in their own issue rather than
   leaving it to be discovered by a slice.
5. Does `ui-flags.js` gain a key for this, or does `enabled(context)` read
   `message_archive` from `/features` directly? The two are different shapes
   and only one should exist.
