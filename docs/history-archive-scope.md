# The history and archive browser: scope

Claimed by issue #173, draft PR #174, on `feat/173-history-archive` off
`adamdev/master` at `917835f` (1.4.4).

This is a SCOPE, not an implementation. Nothing in it has been built. Where
a number appears it was measured on 2026-09-13 and the command that produced
it is given, so the next reader can re-take it rather than trust it. Where
something is an inference it says so.

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
| server modules matching `archive` or `corpus` | **44** | `git ls-tree -r --name-only adamdev/master src \| grep -ciE 'archive\|corpus'` |
| lines in those | **14,087** | `wc -l $(git ls-files src \| grep -iE 'archive\|corpus')` |
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

## 5. Surface 6: `terminal-overlay`, sketched

Specified after the history browser lands, per the ordering ruling. Sketched
now because the away bar's requirements are what will shape it and they are
known today.

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

## 8. Vanilla, Svelte, or in between

54 modules, 17,387 lines, zero Svelte. Three options.

### Option A: port the archive browser to Svelte as the next slice family

**Cost, honestly.** The launchpad migration was seven slices for one screen.
The archive is bigger than the launchpad: 54 modules against the launchpad's
one 3,000-line file plus its satellites, with a virtual list, a body-size gate,
a resize-able pane, a fuzzy finder, a mask and a keyboard layer, all of which
are the kind of code that is expensive to port and cheap to break. 72 test
files would need porting or rewriting with them, 39 of them node suites that
read the vanilla source as text.

**Benefit.** It ends the hybrid for this area. The hybrid cost real money this
week: merges repeatedly landed changes in vanilla files the Svelte side had
stopped calling, and issues #110, #116, #118 and #121 are all that same defect
in four different disguises.

### Option B: extend it in vanilla and migrate later

**Cost.** It grows the vanilla side while the project's direction is the other
way, and every month makes the eventual port bigger.

**Benefit.** It is what "finish the history browser" actually asks for. None of
the gaps in section 2 is a rendering problem, and not one of them gets easier
in Svelte.

### Option C, RECOMMENDED: migrate the SEAM, not the screen

Port exactly the parts the surface needs and leave the rendering alone.

Concretely, what moves to `web/src/lib/plugins/history/`:

- `index.ts`, the `Plugin` and its `app-screen` contribution
- `routes.ts`, a port of `archive-deeplink.js` (it is already pure, already
  exported in a deliberate order, already covered by two suites)
- `client.ts`, the granted-fetch wrapper around what `api-archive.js` does
- `mount.ts`, which calls into the existing vanilla `ArchiveScreen` through the
  one seam

What stays vanilla, for now: all 50-odd rendering modules, unchanged, called by
the mount.

**Why this and not A.** It buys the entire architectural benefit, which is the
module boundary, the route ownership, the capability grant and the single
enable gate, at roughly 5 percent of the porting cost. It leaves the screen
working the whole time, which matters because the screen is what the owner
asked to be finished. And it makes the eventual full port a sequence of small
independent slices behind a boundary that already exists, instead of one
seven-slice project.

**Why this and not B.** Because the boundary is the thing the owner actually
asked for, and it is the part that does not get cheaper by waiting.

**The rule the launchpad migration set stands and applies to every later
slice: each slice deletes its legacy code in the SAME commit. No dual path.**
Option C does not violate that, because it is not a dual path: the vanilla
rendering has exactly one caller after the seam moves, and the seam it used to
have is deleted in the same commit.

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

"Is Svelte" is item 9 and it is explicitly NOT required for "finished". A
history browser that works and is vanilla is finished. A history browser that
is Svelte and shows an empty rail is not.

---

## 9. Suggested issue sequence

Each is a thing one agent can pick up, claim and close on its own, per the work
protocol. None is a container.

0. **Make the browser show the corpus that is already ingested.** Section 2.0.
   Fix A (`scripts/message_model_corpus_run.py`) as a same-day stopgap so the
   UI can be seen at all, then the column-by-column mapping study, then Fix B
   as its own sequence. **This is the top item and nothing else here is
   observable until it is done.**
1. ~~Switch the archive on for the owner.~~ Already on. See section 2.1.
2. **Measure the browser at 22,828 transcripts**, once item 0 makes that
   possible. The rail, the transcript list, the virtual list and the search
   budget. Record the numbers.
3. ~~**Search tells the truth when it stops early**, plus the
   `archive_search.py:107` known gap: close it or record it.~~ **Done,
   2026-09-13.** It cannot stop early any more - one index query covers the
   scope, so `budget_exhausted` is unreachable and there is a test pinning
   that. The refusals that replaced it are an unbuilt index, an untokenizable
   query, and the coverage gap. See `docs/archive-search-index.md`.
4. **Add the `app-screen` surface** to `types.ts`, `registry.ts` and the host
   walk in `router.js`, with the negative test for a throwing `parse`.
5. **Register the archive through it**, porting `archive-deeplink.js` to
   `routes.ts` and collapsing the three inbound call sites.
6. **The granted fetch**, with the refusal test.
7. **Measure whether full scrollback reaches past one screen** on a real
   claude pane. Decides the shape of item 9.
8. **Separate the archive database**, forward and reverse, with the three
   foreign keys resolved and the integrity gate carrying a list.
9. **The `terminal-overlay` surface, and the away bar on it**, scoped by
   whatever item 7 measured.

Items 0 through 3 are "finish history", and item 0 is most of it. Items 4
through 6 are "make it a module". Items 7 through 9 are the away bar. Item 8 is
independent of all of them and can run in parallel at any time.

---

## 10. Open questions

1. Does a full-history load reach past one screen on a Claude Code pane? See
   section 5. Must be measured, not argued. Decides whether the away bar is a
   restoration or a smaller, different feature.
2. Does the ingester ever want its own connection, or is ATTACH enough
   forever? Section 6 recommends ATTACH and names the condition under which
   that changes.
3. Does `db_integrity` carry a list or grow a second artifact? Section 6
   recommends a list and gives the reason.
4. Should the `terminal-search` slice be refactored onto `terminal-overlay`
   when that surface lands? It is their code. Our view is yes, or there will
   be two ways to put something over a terminal, but that is a question for
   them.
5. Does `ui-flags.js` gain a key for this, or does `enabled(context)` read
   `message_archive` from `/features` directly? The two are different shapes
   and only one should exist.
