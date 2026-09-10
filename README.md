# The coordination protocol

Two teams work the CloudeCode codebase and neither one stops for the other.

| Party | GitHub | Their remote in your clone |
|---|---|---|
| `ccsliinc` | ccsliinc/CloudeCode | `origin` |
| `adoom666` | Adoom666/CloudeCodeDev | `adamdev` |

`adamdev` is the shared dev repo and the only place the two lines meet.
This branch, `coord`, is an ORPHAN branch on that repo. It carries no code at
all, so anything here can be published without shipping, compiling or testing
anything.

Read this once. It takes two minutes. Then use `scripts/coord.sh`.

## Why this exists

On 2026-09-09 and again on 2026-09-10 we found out what the other side had
built only by running `git fetch`. Both times the work had already landed.
Nothing here is about permission or ownership. It is about finding out BEFORE
instead of AFTER.

## The merge conflicts were the CHEAP problem

This is the single most important thing in this document, and it is measured
rather than theoretical.

When the two lines were merged on 2026-09-10, **only two files conflicted in
git, and both of them were docs.** Every code file merged automatically. If
merge conflicts were the problem, there was barely a problem.

The expensive collisions that week were not textual at all. Git could not see
any of them:

- He moved unread onto the OUTER ring. We had moved it onto the INNER dot.
- He kept dead rows on the live list with a restart surface. We had moved dead
  rows to Recent.
- He replaced the kebab menu with inline icons and dropped restart. We had just
  built the kebab.
- His new instance index and status map sit beside our unread identity and
  status seed modules, solving adjacent problems two different ways.

And the worst one, because it is the one nothing flagged: **our TypeScript port
of the LED went silently stale because his rewrite touched a DIFFERENT file.**
Nothing conflicted. The rebase looked clean. The port was wrong. Only a parity
suite caught it.

So:

> **File level claims prevent merge conflicts, which turned out to be cheap.
> Intent plus approach prevents design divergence, which was expensive.**

That is why every claim must carry an approach, and why a contradiction between
two approaches counts as an overlap even when the two parties share no file.

## The layout

```
README.md              you are reading it. the only file both parties edit.
now/<party>.md         what that party is on RIGHT NOW. overwritten in place.
log/<party>.md         what that party LANDED. newest first, append only.
settled/<party>.md     design decisions that party treats as already ruled on.
claims/<party>-<slug>.md   one small file per claim, each carrying its APPROACH.
notes/<party>-<slug>.md    free prose addressed to the other party.
```

**Every file except this README carries its writer's name in its own path.**
That is the whole merge-safety design, and it is not a style preference. Git
merges two additions of DIFFERENT paths into one directory with no conflict at
all. It conflicts on two edits to overlapping line ranges of the SAME file.
So partitioning the write set by filename makes a cross-party conflict
structurally impossible rather than merely unlikely.

This README is the one exception. It is shared because it needs agreement
anyway, and it changes about never. If both parties edit it in the same window,
it WILL conflict, and that conflict is a feature: it means the two of you
changed the rules at the same time and should talk.

## The merge safety was simulated, not asserted

Four runs in throwaway repos on 2026-09-10, each able to fail:

| what | result |
|---|---|
| both parties add a claim, prepend their own log, rewrite their own now; merge B into A | clean, exit 0, zero conflicted files |
| the same, merged the other direction, A into B | clean, exit 0, zero conflicted files |
| **negative control:** both parties edit the same line region of the shared README | **CONFLICT on README.md, exit 1** |
| **known weak spot:** ONE party prepends to its OWN log from two worktrees | **CONFLICT on log/ccsliinc.md, exit 1** |

The negative control is the load-bearing one. A harness that reports clean
because it never actually exercised git's conflict detection looks identical to
a correct result, so the shared file was made to conflict on purpose.

**The weak spot is real and is not fixed by the naming rule.** Partitioning by
writer protects ccsliinc against adoom666. It does NOT protect ccsliinc against
ccsliinc writing from two worktrees at once, because that is the same file. The
mitigations are that `coord.sh` takes a lock across the whole clone so two local
worktrees cannot write at the same instant, and that you should `coord.sh sync`
before and after writing so the divergence window is seconds rather than hours.
If you do diverge anyway, resolve it by hand in the checkout; both entries are
wanted and the resolution is always "keep both".

Claims and notes do not have this problem at all, because each one is its own
file. That is why the things that MUST merge cleanly live in directories.

## The rules

**Write your `now/<you>.md` when you start a work session.** Two or three
lines. Which branch, which area, roughly how long. This is the single highest
value file in the protocol and it costs ten seconds.

**File a claim before you start work in an area someone could collide with.**
Backend module, client screen, a plan document, a migration. Not for a typo fix.
If you are unsure, file one; a spurious claim costs nothing and an unfiled one
cost us two days.

**Log what LANDED, once it landed.** Commit shas, what shipped, what broke.
Newest at the top of your own log file.

**Push coordination whenever you write it, not when your code is ready.** That
is the entire reason this is a separate branch. `scripts/coord.sh sync` fetches,
rebases and pushes and touches no code branch. Do it more often than feels
necessary.

**Read the other side at the START of every work session.** One command:
`scripts/coord.sh status`. It prints both `now` files, every claim, and any
overlap.

## What a claim is, exactly

A claim is a SOFT LOCK. It says: "I am editing these paths this week. If you
edit them too, one of us is going to rewrite the other's work."

It does NOT say: this is mine, you need my permission, or I got here first
therefore I win. There is no priority field, on purpose.

Header, flat `key: value` so both an agent and a human can read it with no
parser:

```
---
party: ccsliinc
id: ccsliinc-listing-perf
title: session listing performance
branch: release/1.2.1
opened: 2026-09-10
refreshed: 2026-09-10
expires: 2026-09-13
status: active
paths: src/core/session_manager.py src/core/session_instance_index.py
---
```

Then, and this is the required part, an `## approach` section:

```
## approach

bulk one tmux listing per pass and index it by the instance triple, so the
per-session decorators read an in-memory row instead of shelling out.
assumes a listing may only vouch for its own socket; an absent row from
another socket is not evidence of death.
expects to change: nothing in the status vocabulary, only where the row
comes from.
```

Three or four lines. Cover the design direction you are taking, the invariant
or model your work assumes, and anything you expect to change about SHARED
semantics: a state machine, a key, a rendering contract, a vocabulary.

There is no template and no form to fill in, because a template is a thing
people fill in without thinking. Write it the way you would tell the other
engineer over a beer.

Then plain prose underneath in `## detail`: what you are doing, why, and what
you would happily hand over.

`paths` is a space separated list of globs. `*` matches across `/` here, so
`src/core/session_*.py` works as written and you never need `**`.

`status` is `active`, `paused` or `done`. `paused` is real and means "I intend
to come back to this, do not assume it is free". It is also the first thing you
should offer up when the other side wants that area.

## Settled decisions

`settled/<you>.md` is a short, newest first list of design decisions that have
already been ruled on, usually by the owner.

It exists because an agent starting fresh has no memory of a ruling it was not
present for, and will happily redesign it. Example, real: on 2026-09-09 the
owner ruled that the outer ring means activity and nothing else, and that unread
rides the inner dot. An agent that has not seen that ruling will look at a grey
inner dot and "fix" it back onto the ring.

Keep entries to a few lines: what was decided, when, and by whom. This is not a
changelog. It is the list of things the other side should not spend a day
reversing by accident.

## Expiry

**A claim expires 72 hours after it was last refreshed.** Re-run the same
`coord.sh claim` command to refresh it; `opened` is preserved and `expires`
moves.

Why 72 hours: the collisions we actually had were 24 to 48 hours apart, so a
window much longer than that means every claim is always live and the signal
degrades into noise. Shorter than 72 and you would be refreshing every morning,
and a ritual people skip is a protocol people abandon. 72 covers a weekend.

**Nothing deletes an expired claim.** Expiry is computed when the file is read.
`coord.sh status` renders an expired claim as `EXPIRED_OR_DONE` and stops
counting it as an overlap, and the prose stays there as history. A background
job that deleted files on this branch would be a second unsupervised writer,
and it would race.

## The overlap detector was proved to fire, and proved to stop firing

A matcher that always reports "no overlap" looks exactly like a correct one, so
it was tested against a claim built from adoom666's real plan, measured
2026-09-10 against 1,478 tracked files:

- With his claim live, it reported **three overlaps**: `session_manager.py`
  against our listing work, four `client/js/session-*.js` files against our row
  menu, and `session-recent-visibility.js` against the paused migration.
- **The load-bearing detail:** his glob was `src/core/*_manager.py` and ours was
  the literal `src/core/session_manager.py`. Those two strings look nothing
  alike. They were matched because the detector expands both against the real
  file list and intersects the RESULTS. A string comparison would have reported
  nothing and been quietly wrong.
- Setting that same claim's `expires` three days into the past dropped it to
  zero overlaps while still rendering it in the claim list as
  `EXPIRED_OR_DONE`. So expiry actually releases an area, and the prose stays.

## When two claims overlap

`coord.sh status` reports an overlap by expanding both claims' globs against
the real tracked file list and intersecting the results. It compares FILE SETS,
not glob strings, because `src/core/session_*.py` and `src/core/*_manager.py`
look nothing alike and both hit `session_manager.py`.

**There are two kinds of overlap and only one of them is machine detectable.**

A PATH overlap is what the script finds. A DESIGN overlap is when the other
party's approach contradicts a model your work assumes, and it counts exactly
the same even when you share no file at all. Read every `## approach` and every
`settled/` entry in `coord.sh status` output; if one of them would reverse
something your branch depends on, you have an overlap. All four of the
expensive collisions listed at the top of this document were design overlaps
with no shared file.

**An overlap of either kind is the signal working, not an error.**

1. STOP. Do not start on the intersection.
2. Do not edit the other party's claim. Do not negotiate with the other agent.
   Two agents trading ownership over an async channel with a 72 hour horizon
   will either livelock or both yield. The humans have out of band bandwidth;
   route it there.
3. Surface both claim files to your human, verbatim.
4. The humans decide. Each side records the outcome by editing ITS OWN claim:
   narrowing `paths`, setting `status: paused`, or adding a line of prose.
5. **If your human is not around, keep working on the parts of your claim that
   do NOT intersect, and leave the intersection alone.** Nothing in this
   protocol may block you.

## What NEVER to do

- **Never edit the other party's files.** `coord.sh` refuses, and so should you
  by hand. Their `now`, their `log`, their `claims/`, their `notes/`.
- **Never push to `upstream`** (Adoom666/CloudeCode). Its push URL is set to the
  broken sentinel `DISABLED_do_not_push_to_Adoom666_CloudeCode` on purpose.
  Do not push there and do not repair it. Push to `origin` and `adamdev` only.
  This is the owner's standing rule and it predates this document.
- **Never rewrite history on a shared branch.** Not `coord`, not `master`, not a
  release branch.
- **Never force push anything.** If `coord.sh sync` cannot rebase, resolve it in
  the checkout by hand.
- **Never put code on this branch.** It is an orphan branch for a reason.

## If only one side uses this

That is a supported outcome, not a degraded one.

- If the other party never writes here, `coord.sh status` says so plainly:
  "no now/<party>.md on the coord branch". It does not render an empty section
  that reads like they are idle.
- Our own claims and log are worth having on day one with zero cooperation:
  five worktrees and a fleet of agent sessions share one memory of what is
  claimed and what shipped.
- The read side is deliberately trivial so the other party can benefit without
  adopting anything: one `git fetch`, one directory of small markdown files, no
  tooling required.

Nothing here ever blocks work waiting on a reply.

## The commands

```
scripts/coord.sh init     create the local coord branch and its checkout
scripts/coord.sh status   both sides' current work, all claims, any overlap
scripts/coord.sh now      replace your current-work file (reads stdin)
scripts/coord.sh claim    open or refresh a claim (reads stdin)
scripts/coord.sh log      prepend a landed entry to your log (reads stdin)
scripts/coord.sh note     write a note to the other party (reads stdin)
scripts/coord.sh settled  record a decision that is already ruled on (reads stdin)
scripts/coord.sh sync     fetch, rebase and push this branch
```

Exit codes: `0` did the job, `2` usage error, `3` cannot determine, `4` refused,
`5` a git operation failed. `3` is not `0`; a status that could not compute
overlap says so instead of reporting none.

You can also just `cd` into the checkout and read the files. The script is a
convenience, not a gate. `coord.sh status` prints the checkout path every run.

## Worked example: the collision that is live right now

This is not hypothetical. It is the state of both repos on 2026-09-10.

**What adoom666 is about to do.** `docs/webui-performance-and-session-menu-plan.md`
landed on `adamdev/master` as `4ae4b71`, and `46e7aca` (durable session mute)
followed it an hour later. The plan has two halves: web UI performance, and a
three dot session action menu replacing the live session X.

**What ccsliinc is already mid-flight on.** Both halves, separately:

- `release/1.2.1` carries five commits of session listing performance
  (`c8ef6a8`, `a4eff35`, `2b1fcb9`, `402526f`, `3837f24`) touching
  `src/core/session_manager.py`, `src/core/session_instance_index.py`,
  `src/core/pipe_wakeup.py`, `src/core/session_status_map.py`.
- `feat/svelte-1.3` carries `2d43339`, which re-seats the session row menu onto
  a typed build time plugin registry under `web/src/lib/plugins/`, with mark
  unread as its first plugin.

**The overlap is exact, not thematic.** His plan step 3 says "correct listing
completeness and delimiter parsing before trusting absence; a partial listing
must never remove a live session". Our `402526f` is titled "a bulk listing may
only vouch for its own socket". Same defect, two people, two repos, at the same
time. His plan also says "avoid repeated connections and per-session queries
where bulk evidence exists", which is what `session_instance_index.py` is.

**What the protocol does with that.** Three claims are on file from ccsliinc
(`ccsliinc-listing-perf`, `ccsliinc-session-row-menu`, `ccsliinc-svelte-launchpad`),
each naming its real paths and its branch. `coord.sh status` intersects them
against any claim adoom666 files. A note, `notes/ccsliinc-to-adoom666-webui-plan.md`,
says concretely what has already landed in those two areas, which paths we would
rather not have rewritten this week, and which parts we would happily hand over.

**And the design half, which is the half that actually cost us.** Our claim on
the session row menu states its approach out loud: the row menu is being
re-seated onto a typed build time plugin registry, and mark unread is its first
plugin. His plan states his: replace the kebab with a shared three dot menu
carrying five labelled actions and a mute. Those two are not the same design,
they share the same surface, and **the file lists barely intersect** - his work
is mostly `src/core/` and `client/js/`, ours is mostly `web/src/lib/plugins/`.
A path-only protocol would have reported no overlap and been technically
correct, which is exactly how the LED port went stale.

**What it does not do.** It does not stop him. It does not assign the area to
us. It gives the two humans the one thing they did not have on either of the
previous two collisions: the information, before the work.
