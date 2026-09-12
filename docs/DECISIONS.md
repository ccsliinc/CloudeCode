# Decisions

Standing rulings. Adam owns the code and is the sole tie-breaker; a ruling he
gives either developer binds both. Record one here when you receive it, or it
is invisible to the other side.

This file lands through a pull request on purpose. A misremembered ruling gets
human review before it binds every agent, and a file is diffable and blameable
where a chat message is not.

Each entry names the repo it applies to. A ruling about one repo is not a
ruling about another.

---

## The session listing pass: our semantics, their file layout
**2026-09-11, scope: all repos, ruled by Adam as code owner and sole
tie-breaker**

Verbatim: "yes, reply with the correction and take their proposals."

Both lines rewrote the session listing pass independently, in the same week,
neither knowing about the other. Our side added `src/core/listing_gather.py`,
`src/core/listing_prefetch.py`, `src/core/single_flight.py` and 45 lines in
`src/core/session_status_map.py` (`f0e07de`); their `feat/backend-decomposition`
line restructures `src/core/session_manager.py` and moves the call sites of
`list_session_infos` out to `src/api/session_crud_routes.py` and
`src/core/sessions/toast_inbox.py`. Confirmed on 2026-09-11: our three new
modules are absent from `feat/backend-decomposition`, so they merge onto it
without a single conflict, on top of code whose surrounding structure their
line has already moved. A clean merge here is not evidence the result is
correct.

**We own the listing pass semantics. They own where the code lives.** They take
our version of what the pass does and re-run their listing cost ceilings
against it once they fold it in. Files to watch on both sides:
`src/core/session_status_map.py`, `src/core/session_manager.py`,
`src/core/listing_gather.py`, `src/core/listing_prefetch.py`,
`src/core/single_flight.py`, `src/api/routes.py`.

## Announce a version bump before you make it
**2026-09-11, scope: all repos, ruled by Adam as code owner and sole
tie-breaker**

Verbatim: "yes, reply with the correction and take their proposals."

Both sides set the next minor version to 1.3.0 within 22 minutes of each other
on 2026-09-11, neither tagged, neither published, caught only because someone
happened to check. Adam's rule: **whoever is about to bump a version says so
before they do it.** A version number carries no file path and no design
approach, so nothing in the existing claim-and-overlap protocol could have
flagged the collision; this closes that gap the same way a claim closes a
file-path collision.

## Free issues are grabbed author first, then priority
**2026-09-11, scope: CloudeCodeDev, ruled by Adam as code owner and sole
tie-breaker**

Verbatim: "i just want to throw a priority order of your own issues should be
worked on first and then the other ones should be taken next, so :
Adoom666 P0>p1>p2... then ccliinc P0>p1>p2 etc"

Grab order across free issues, the ones with no linked PR, is now the author
first and the priority label second: everything `Adoom666` filed in `p0`, `p1`,
`p2` order, then everything `ccsliinc` filed in that same order. An issue
carrying no priority label sorts after `p2` inside its own author's group, and
an issue from any other author sorts after both of them. This replaces sorting
on the priority label alone, which is what the protocol did until today.

The login in the quote is a typo. The other developer is `ccsliinc`, which is
what the author field on the issues themselves says.

**Authorship sets ORDER, not OWNERSHIP.** It decides which free issue gets
reached for first and nothing beyond that. It reserves nothing, it gives the
author no veto, and it does not make an issue theirs to keep: any agent may
still work any free issue, and a draft PR is still the only thing that makes
one taken. The two rules that say so, "the author does not own it" under
filing and "no assignee-as-claim" under what was rejected, both stand
unchanged.

`.claude/skills/work/SKILL.md` carries the order, the two edge cases and the
command that produces the list, and `work.sh free` prints that same list, so
this binds both parties and both sides need to pull it.

## Both update checkers point at Adam's main repo
**2026-09-10, scope: all repos**

Verbatim: "1. use adams main repo."

`Adoom666/CloudeCode` is the upstream product, and both of this app's update
checkers now consult it. Before today they disagreed: the server checker
already pointed there, and the menubar app pointed at `ccsliinc/CloudeCode`,
so the two could report different answers to the question "what is the latest
release" on the same machine at the same moment.

What changed, exactly:

- `macOS/update-check.js`, `UPDATE_FEED_URL`, moved from
  `api.github.com/repos/ccsliinc/CloudeCode/releases/latest` to
  `api.github.com/repos/Adoom666/CloudeCode/releases/latest`.
- `src/core/update_check.py` was ALREADY correct and is unchanged:
  `FALLBACK_REMOTE` is `https://github.com/Adoom666/CloudeCode.git` and
  `DEFAULT_UPGRADE_COMMAND` opens that repo's releases page.
- `scripts/upgrade.sh` hardcodes no repo at all. It imports the same
  `FALLBACK_REMOTE` through `scripts/upgrade_lib/version_probe.py`, so it
  follows this ruling for free and needed no edit.

**THE CONSEQUENCE, STATED HERE RATHER THAN LEFT TO BE DISCOVERED.** Measured
2026-09-10: `Adoom666/CloudeCode` publishes v1.0.36 as its latest release and
its highest tag, while this line ships 1.2.1. So a 1.2.1 install is now told
the latest release is OLDER than the one it is running.

It does NOT prompt a downgrade, and that was verified in the code rather than
assumed. On the python side `UpdateChecker.refresh` sets
`newer = parsed_latest > parsed_current`, and `(1, 0, 36) > (1, 2, 1)` is
False, so the status reads `current`. On the javascript side
`compareVersions('1.2.1', '1.0.36')` returns 1 and `checkForUpdate` reports
`available` only when that comparison is negative, so the result is
`current`. Both are pinned by tests.

What IS wrong is the figure reported beside that verdict, and the release the
upgrade link opens: a user following it lands on a build older than the one
they are running. Fixing it needs either a release above 1.2.1 on that repo or
the two lines converging on one version scheme, and both are Adam's call. Asked
on `Adoom666/CloudeCodeDev` as issue #69, which states the ruling, the exact
files that changed, this measured consequence, and the open questions.

Note this is a coupling, not just a setting: that repo is now the release feed
for these builds, so anything published there is announced to these users.

## Adam's repo is the primary, ours is the backup, releases stay on ours
**2026-09-10, scope: all repos**

**SUPERSEDED 2026-09-12** by "One repository: Adoom666/CloudeCodeDev", at
the end of this file. Nothing is mirrored to `ccsliinc/CloudeCode` any more and
no release is published there. The text below is kept as the record of what
the rule was.

Verbatim: "you can use his repo as the main. keep mine for backup."

`Adoom666/CloudeCodeDev` (`adamdev`) is the primary development repository.
Work is claimed there by issue plus draft PR, `docs/DECISIONS.md` and
`docs/kept-behaviours/` bind both teams from there, and branches land there
first. `ccsliinc/CloudeCode` (`origin`) is the backup mirror: every branch and
every tag also goes there. `Adoom666/CloudeCode` (`upstream`) stays forbidden.

This SUPERSEDES "Push only to origin and adamdev, never to upstream"
(2026-09-08, below), which named the two as interchangeable targets. Both
remotes are still pushed to; what changed is which one is authoritative.

**Distribution is the exception, and it is deliberate.** Verified with `gh` on
2026-09-10: `CloudeCodeDev` is PRIVATE and its recent releases are all drafts,
while `CloudeCode` is PUBLIC and holds the published downloads, v1.2.0 and
v1.2.1, each an arm64 dmg with a sha256 and a written downgrade procedure,
v1.2.1 marked Latest. So "primary" means development, not distribution, and
public releases stay on ccsliinc's repo. They move only if Adam makes his repo
public and rules that they should; moving them while it is private removes the
download from every existing user.

Also measured the same day: `CloudeCode` has Issues DISABLED, being a fork, so
it cannot act as a fallback tracker while that holds. `CloudeCodeDev` is the
only issue tracker either side has.

## The row menu is one superset, not two implementations
**2026-09-10, scope: CloudeCodeDev**

Verbatim: "reconcile the two menus into ONE superset."

Both parties built a session row action menu on the same day. Landed as
ccsliinc's `546443e` on their `release/1.2.1`, merged here in `074b381`.
adoom666's three modules are the base; ccsliinc's behaviours were restored
alongside. Neither implementation was thrown away.

## Rename keeps all three doors
**2026-09-10, scope: CloudeCodeDev**

Verbatim: "dont remove the rename. i said merge not take everything."

`8898f07` removed double-click rename entirely and moved rename into the menu.
Overruled. Double-click, F2 and the menu item all call one editor through
`SessionSidebarRename.beginEdit`. The 250ms hold on a click on a renameable
name is the known price of keeping the gesture, not an oversight.

## Adam is the tie-breaker for every party
**2026-09-10, scope: all repos**

Verbatim: "i'm the tie-breaker on everything as i own the code."

An overlap needs one person to see both sides, not a negotiation between two.
Agents have no standing to negotiate with each other; surface both positions
to him verbatim and work the parts that do not intersect meanwhile.

## Work is claimed by draft PR, not by assignee
**2026-09-10, scope: CloudeCodeDev**

Replaces the `coord` orphan branch protocol. See `.claude/skills/work/`.

An assignee is a declaration with nothing behind it; a draft PR has a branch
and a commit. Any agent may pick up any free issue. Ties resolve by lowest PR
number, because that counter is monotonic and server-side, so both parties
compute the same winner without communicating.

The `coord` branch still holds ccsliinc's four claims, their log and their
lessons until they migrate. Nothing new goes there.

## Cross-repo rulings do not travel
**2026-09-10, scope: all repos**

ArgentSI requires protected main, signed commits, squash-merge and npm. None
of that binds CloudeCodeDev, which is a Python project with an unprotected
main by choice. Adam owning both codebases makes him the tie-breaker in both;
it does not make a decision about one a decision about the other.

## ccsliinc's open draft PRs land first; the colliding issues get re-scoped
**2026-09-10, scope: CloudeCodeDev, ruled by Adam as code owner and sole
tie-breaker**

ccsliinc's work is already written. The colliding issues were only filed, not
started. Rebasing written work onto a spec costs more than re-scoping a spec
onto merged work, so the written work goes in first and the filed work is
re-scoped against the tree that results.

Three collisions:

1. PR 23 (svelte migration of `client/js/launchpad.js`, slices 2 to 7) deletes
   that file outright. Issues #35, #36, #50 and #51 all edit it.
2. PR 19 (decompose the python backend god objects into typed collaborators)
   restructures `src/core/session_manager.py`. Issues #31, #32 and #37 touch
   it.
3. PR 22 (the row menu renders from a typed plugin surface registry) moves
   menu action availability onto a plugin registry. This contradicts the
   approach described in issues #36 and #58, even though neither shares a
   file with PR 22. This is the expensive kind of collision: a path-overlap
   check cannot see it, both sides look clean in isolation, and the
   contradiction only surfaces later as a behaviour bug.

Every listed issue (#31, #32, #35, #36, #37, #50, #51, #58) is labeled
`blocked` and carries a comment naming which PR it collides with and that it
must be re-scoped against the post-merge tree before anyone starts it. #36
and #58 additionally note that their collision with PR 22 is a design
contradiction, not a file overlap, so re-scoping them means revisiting the
approach itself, not just adjusting file paths.

General rule this implies: when filed-but-unstarted work collides with
written-but-unmerged work, the written work has precedence. The filed spec
gets re-scoped onto the shape that results after the written work merges,
rather than the written work being rebased onto the spec.

## Issues are grouped by label, never by a parent issue
**2026-09-10, scope: CloudeCodeDev, ruled by Adam as code owner and sole
tie-breaker**

Verbatim: "converting them to phase:1 through phase 7 labels and update the
skill to make sure stuff like that aren't made again"

Seven issues were titled as phases (#7, #17, #29, #33, #41, #47, #54). Six of
them were pure containers holding child tasks and nothing else, and they are
closed as not planned, each carrying a comment naming the label that replaces
it. Their 32 children are untouched apart from the added label and every one
of them is still open. #54 is titled as a phase but is a fully specified
experiment with its own approach, verification and definition of done, so it
took `phase:7` and stays open rather than being closed with the containers.

The `Part of #N` lines in the child bodies are left in place. They are history
and they resolve to a closed issue carrying the explanation.

General rule this implies: an issue must be independently workable. One agent
picks it up, claims it with a draft PR, and closes it on its own. Group
related work with a label, never with a parent issue. A container inflates the
backlog with an item nobody can action, it cannot close until every child
closes, and `gh issue list --json` has no parent field in gh 2.90, so the
grouping it promised was never queryable from the command line anyway.
`.claude/skills/work/` carries this under "Filing an issue", so it binds both
parties and both sides need to pull it.

## Both update checkers point at Adam's main repo, the implementation record
**2026-09-08, scope: all repos, ruled by Adam as code owner and sole
tie-breaker**

THE SAME RULING AS THE ENTRY AT THE TOP OF THIS FILE, recorded independently
by the other line on the same day and kept here in full rather than folded
into it. Both were written before either side saw the other. Read them
together: the entry above is the ruling and its measured consequence, this
one is what the implementation that shipped actually does, which is a
superset - one named constant plus a config override rather than one moved
literal.

NOTE THE TWO ENTRIES DISAGREE ABOUT THE DATE OF THE RULING, 2026-09-08 here
against 2026-09-10 above. Neither was changed to match the other, because
picking one silently is how a wrong date becomes the record. Both are as
their author wrote them and Adam is the one who can say which is right.

Verbatim: "1. use adams main repo."

Before this ruling the server-side checker (`src/core/update_check.py`,
`FALLBACK_REMOTE` / `DEFAULT_UPGRADE_COMMAND`) and the macOS menu bar
checker (`macOS/update-check.js`, `UPDATE_FEED_URL`) disagreed about which
repository publishes this app: the server side already named
`Adoom666/CloudeCode`, the menu bar side named `ccsliinc/CloudeCode`. Two
checkers on one machine could answer "is this current" two different ways.
They now agree, on `Adoom666/CloudeCode`.

**Consequence, measured rather than assumed, and not yet resolved by this
change.** As of 2026-09-11, `Adoom666/CloudeCode` publishes `v1.0.36` as its
newest tag; this line ships `1.2.1` (`macOS/package.json`). A 1.2.1 install
is therefore told the latest release is OLDER than the one it is running.
It does not offer a downgrade - `UpdateChecker.refresh`'s
`parsed_latest > parsed_current` and `update-check.js`'s
`compareVersions(current, latest)` both resolve that comparison to
"current", and `tests/test_version_and_update_check.py::
test_real_repo_numbers_never_offer_a_downgrade` and
`tests/test_update_check.node.mjs`'s matching case now pin the real
1.2.1-vs-1.0.36 numbers so a future change that WOULD offer an older
release fails a build instead of shipping.

**What this change adds beyond the one-line pointer fix.** The menu bar
checker gained `DEFAULT_RELEASE_REPO` as its single named constant for the
repo identity (mirrored by the About window's "View on GitHub" link,
which previously hardcoded the same string a second time), and an
`updates.remote` override read from config.json - the SAME key
`src/core/update_check.py` already reads for its own origin-vs-fallback
ladder - so a developer running a personal fork can point their own menu
bar checker at their own fork's releases without a second setting to
learn. `Adoom666/CloudeCode` is the safe default because it is the literal
repo this ruling names, and because a packaged build has no git checkout
and nobody is expected to hand-edit config.json for one. The menu bar
checker still does NOT replicate the server side's second rung (falling
back to the checkout's own `git remote get-url origin` before the public
fallback) - that would mean shelling out to git from the Electron main
process for a rung only a developer's own fork would ever exercise, and
the config override above already covers that developer.

**What remains open - these are NOT answered by this change and are
Adam's to decide, per the issue that raised them:**

1. Should `Adoom666/CloudeCode` be the canonical release feed for BOTH
   the `CloudeCodeDev` line and the public `ccsliinc/CloudeCode` line, or
   only one of them?
2. How do the two version schemes reconcile, given the feed is 1.0.36
   while this line is 1.2.1?
3. Does the 1.2.1 line's public distribution stay on `ccsliinc/CloudeCode`
   (the `origin` remote this project's CLAUDE.md documents downloads
   coming from) while the update FEED is `Adoom666/CloudeCode`? If so,
   that split is deliberate and should be written down here once decided,
   rather than left implicit.

## The outer ring carries unread, as a still green ring
**2026-09-09, scope: all repos**

The owner was shown two models and picked adoom666's, over ccsliinc's. Verbatim
answer: "1. his".

Both lines were fixing ONE report - "the ring around some of the leds are not
gray, which means there should be background tasks. i dont think those few have
any background tasks" - and fixed it opposite ways within hours. ccsliinc retired
the outer `unread` state and moved unread onto the inner dot. adoom666 kept the
ring and simply stopped it breathing. The owner picked the ring.

So, quoting the shipped code on `release/1.2.1` rather than any note:

- `client/js/status-led.js:123`:
  `const OUTER_STATES = ['active', 'steady', 'unread', 'off', 'dim'];`
  `unread` IS an outer state.
- A finished turn nobody has read paints `unread`, a crisp STILL green ring. A
  read session at rest takes `steady`. A dead pane or a lost transport takes
  `off`. An unmeasured one takes `dim`.
- MOTION is the load-bearing distinction: `active` is the only outer state that
  animates, so a light that MOVES is a session that is moving, which was the
  whole of the original complaint.
- The INNER dot carries the session's own state. `done` is what a finished turn
  holds while the green unread ring is around it; `idle` is what the dot becomes
  once that ring goes. That pair is what makes the ring's departure visible.
- `--led-color-unread` EXISTS (`client/css/status-led.css:162`, green via
  `--color-success`). It was not retired.

**Do not reintroduce the inner-dot-unread model. It was decided against, not
forgotten**, and the module header says so in those words. Anything in any
document that reads as though unread lives on the inner dot is describing the
branch that lost.

**How this entry was got wrong once, on 2026-09-10, and it is worth keeping.**
ccsliinc first recorded the INVERSE here, citing `settled/ccsliinc.md`, a
2026-09-08 `TODO.md` entry and a CLAUDE.md on a divergent branch. All three are
real and all three predate the ruling: they describe the state before the owner
chose. A dated record is evidence of what was true on that date. An older record
cannot overturn a newer ruling, and three agreeing stale sources are still stale.
Check the date on a record before you let it overturn a later one, and prefer
shipped code to any note.

## A dead pane leaves the live list and goes to Recent
**2026-09-08, scope: all repos**

Verbatim: "they go into recent, they can disappear."

A session whose process died has stopped, so its row leaves `GET /sessions/list`
rather than lingering there wearing a dead light. A restart from Recent is a
resume. `dead` stays in the LED vocabulary but is gallery-only. A round that read
the same measurement as a bug and made a husk KEEP its row, painted dead, was
overruled and reverted (`ba2aa5d`).

## The mark-unread CONTROL is not replaced by the unread INDICATOR
**2026-09-08, scope: all repos**

Verbatim: "when clicking a tab, the session is marked read. if i want it unread i
click unread. it allows me to know whats waiting."

Opening a tab clears the flag; the user's control is how it goes back on. The LED
painting unread is an indicator and does not remove the need for the control. It
ships behind `ui.show_mark_unread_control`, default on, so turning it off is a
setting rather than a deletion.

## Push only to origin and adamdev, never to upstream
**2026-09-08, scope: ccsliinc clones**

On ccsliinc's clone `origin` is `ccsliinc/CloudeCode` and `adamdev` is
`Adoom666/CloudeCodeDev`. The `upstream` remote (`Adoom666/CloudeCode`) has its
PUSH url set to the sentinel `DISABLED_do_not_push_to_Adoom666_CloudeCode` so a
push there fails by construction. Do not repair it, and re-apply it on any fresh
clone. This is a ruling about ccsliinc's remotes and says nothing about anyone
else's.

## `src/config/settings.py` stays over 500 lines
**2026-09-10, scope: ccsliinc CloudeCode**

Verbatim, on being shown the one open question left by decomposition slice S5:
"Leave it it's ok."

`src/config.py` was 2,112 lines and became the 23-module `src/config/` package.
Every method BODY moved out. What `settings.py` still holds is 109 lines of
pre-existing field declarations plus 31 typed entry points averaging 13 lines,
which lands at 632 and over the 500-line guideline. (Re-measured 2026-09-12
at `b5de919`: 620. Still over the guideline, so the ruling is untouched; the
figure is recorded because it moves.)

It stays there. This is a RULING, not an observation, and nobody on either side
is to "fix" it. The class keeps those 31 public names because 111 modules import
from this package and the suite patches the members on the CLASS: 23 sites patch
`state_dir_override`, eight patch `type(sm.settings).get_state_dir`. A name that
stopped resolving there would be invisible to every one of them, which is a
silent breakage rather than a loud one.

Getting under 500 means DELETING the entry points and migrating their roughly 45
callers. That is Rule B of the decomposition plan applied to `Settings`, it is
its own slice, and it is **not scheduled**. It is recorded as a future optional
slice in `.claude/notes/backend-decomposition-plan.md` so that it is a choice
someone makes deliberately rather than a line count someone reacts to.

## Two lines declared 1.3.0 on the same morning; his stands and ours is 1.4.0
**2026-09-11, scope: all repos**

Verbatim: "make ours 1.4 thats fine."

Adoom666 set `macOS/package.json` to 1.3.0 at 09:48 in `6012467` on
`adamdev/master`. ccsliinc set the same field to the same number at 10:10 in
`76de420` on `integration/1.3.0`. Twenty two minutes apart, neither knowing.
Neither was tagged and nothing was published, so nothing downstream had to be
unwound.

HIS 1.3.0 STANDS. Ours becomes 1.4.0, and 1.4.0 CONTAINS his 1.3.0 rather than
racing it: the release folds in `adamdev/master` at `6012467` in full. The
separately planned 1.3.1, which existed to carry his work as a follow-up, is
collapsed into this release and is not cut.

The branch keeps the name `integration/1.3.0`. It is already on both remotes,
the name is a handle rather than a declaration, and renaming a pushed branch
costs more than the tidiness is worth.

### The rule this exists to stop happening again

**WHOEVER IS ABOUT TO BUMP A VERSION SAYS SO FIRST, BEFORE THE COMMIT.** Not
after, and not in the commit body, because by then the other line may already
have taken the number.

The coordination protocol covers file paths and design approach and could not
have caught this: a version number is neither. It is one shared value in one
shared namespace with no lock on it, which is precisely the shape of thing that
needs an announcement rather than a convention. Announcing costs one message;
the alternative is what happened here, which is two releases wearing one number
and a merge to decide which survives.

## The session's own pin outranks its folder's `.cc.theme`
**2026-09-11, scope: ccsliinc CloudeCode, taken from Adoom666's issue #65**

Both lines had a theme precedence order and they disagreed. ccsliinc's read the
dotfile first; Adoom666's inverted it so the per-session pin wins.

HIS IS TAKEN, on merit. `pinned_themes.json` records the theme a user chose for
THIS conversation and `<working_dir>/.cc.theme` records the default the FOLDER
carries. A default that outranks an explicit choice is not a default, it is an
override, and dotfile-first meant every server restart and every boot re-adopt
threw away a pin that was sitting on disk the whole time, while two sessions
running out of one repo could never hold two different themes.

Two things follow from it and are part of the same ruling, so neither is to be
reinstated on its own:

- **The pin-to-dotfile migration is deleted**, on both call sites and in the
  store. It existed to decay the legacy map while the dotfile was the winner.
  Under the inversion the same code writes one session's private choice into a
  folder-wide default that every OTHER session in that directory then inherits.
- **The reconcile no longer prunes a pin whose tmux name is absent from the live
  listing.** Deleting a decaying fallback cost nothing; deleting the durable
  record of a deliberate choice is data loss, and it would have fired for every
  session not running at the moment the reconcile happened.

`PATCH /sessions/{name}/theme` writes the pin and no longer touches the dotfile,
for the same reason.

## One config.json writer, and it is the one that takes the lock
**2026-09-11, scope: ccsliinc CloudeCode**

Both lines independently made config.json have a single writer, and the two
claims are not the same claim. ccsliinc's relocated the atomic write into
`src/config/config_file.py`. Adoom666's `src/core/config_writer.py` takes the
path's lock, reads the file FRESH inside it, and hands the caller that document.

HIS IS TAKEN, because ATOMIC AND SERIALIZED ARE DIFFERENT PROPERTIES and only
one line had the second. Every writer on both sides was atomic, so a crash could
never truncate the file. Two arriving together each merged into the base they had
already read and the second replace threw the first one's block away: the file
was never corrupt and the update was still lost.

`write_config_atomic` is gone. `config_writes.update_settings_config` and
`wrappers.mutate` are mutators passed to `config_writer.commit`, which is what
makes a stale base unrepresentable - a caller cannot supply one because it never
supplies one. `tests/test_one_config_writer.py` fails the build if a second
writer of that file appears.

## The bounded viewer fan-out, on ccsliinc's registry
**2026-09-11, scope: ccsliinc CloudeCode**

Adoom666 bounded the per-viewer outbox (issue #38); ccsliinc moved the
subscriber containers onto `SessionRegistry`. BOTH ARE TAKEN and neither was
dropped: the registry hands out a `BoundedStream`, `publish` is SYNCHRONOUS and
offers rather than awaits, an overflowed viewer is closed and dropped from the
list so the overflow is one event and not a storm, and `forget` closes each
outbox rather than only dropping the list.

The synchronous signature is the load-bearing half. `TmuxBackend._emit_output`
awaits whatever the output handler returns, so a coroutine there puts the tail
loop - the thing reading the pipe that carries every keystroke echo for every
session - one await away from a viewer's outbox.

## NavigationGeneration lands in 1.4.0 rather than as a follow-up
**2026-09-11, scope: ccsliinc CloudeCode**

Adoom666's twelve NavigationGeneration hunks had ZERO references anywhere in
`web/src` after ccsliinc's Svelte rewrite, and `app.js` tests `detail.nav != null`
BEFORE it consults the guard - so every Svelte launch path was dispatching an
event whose stale-navigation guard was silently waived. The absence was measured;
the user-visible consequence is derived from reading the listener rather than
reproduced in a browser.

It ships in this release rather than being tracked. The merge is the one moment
both halves are in one tree, and deferring it means publishing 1.4.0 with a guard
that is present, dispatched, and waived - which is the false-green shape this
project keeps paying for.

## Free issues are taken author first, then priority
**2026-09-11, scope: both parties**

Adoom666 ruled that free issues, the ones with no linked PR, are taken author
first and priority second: everything `Adoom666` filed in p0, p1, p2 order,
then everything `ccsliinc` filed in that same order. ccsliinc adopted it
verbatim in `2ac476a`, merged as `50cf9dc`, so both parties' agents queue the
same list.

Three details of the rule as their file actually states it, kept because they
are the parts a paraphrase drops. An issue with **no priority label sorts
after p2 inside its own author's group**, because it is work nobody has ranked
rather than unranked work, and putting it first would let filing an unlabelled
issue jump the queue. An issue from **any other author sorts after both**
groups. Inside one bucket the **lowest issue number goes first**, the same
created-ascending tie-break the free list used before.

**AUTHORSHIP SETS ORDER, NEVER OWNERSHIP**, and that half is stated on its own
because it is the half an agent drops. Taking a turn in a queue claims nothing
about who may work on the issue.

It lives in `.claude/skills/work/SKILL.md` and `.claude/skills/work/work.sh`.
There is no `docs/adopt-adam-grab-order` file; that path has been referred to
in passing and does not exist.

## A deploy that ships commits past the tag gets a version before it ships
**2026-09-12, scope: all repos**

`v1.4.0` is an annotated tag naming `7da2901`. We then deployed twice more and
never renumbered, so on 2026-09-12 the live install was running `2898b26`,
**26 commits past the tag**, while `macOS/package.json` still read `1.4.0` at
both commits. Verified before writing this: `git rev-list --count
v1.4.0..2898b26` answers 26, and `git show <ref>:macOS/package.json` answers
`1.4.0` at `v1.4.0` and at `2898b26` alike.

Nothing was corrupted by that, and the cost was still real. The number stopped
describing the thing it labelled, which is the same class of fault this project
has now recorded three times. Its sharpest edge here was a cross-party one:
pull request #108 was asking the other party to merge a branch whose version
declaration said 1.4.0 while carrying 26 commits that 1.4.0 does not contain.
A reviewer reading only the declaration would have been reading a false
statement about what they were merging.

### The rule

**A DEPLOY THAT SHIPS COMMITS PAST THE CURRENT TAG GETS A VERSION BEFORE IT
SHIPS, NOT AFTER.** The order is: bump the declaration, commit, tag, push the
tag, then deploy. Not deploy first and reconcile the number later, because the
window between the two is a window in which every surface that reads a version
is lying, and nothing in the system can detect that it is.

This is the other half of the announce rule recorded above under "Two lines
declared 1.3.0 on the same morning". That rule stops two lines TAKING one
number. This one stops one line SHIPPING without taking a number at all. They
fail in opposite directions and neither catches the other's case.

**The check is one command and it is cheap.** Before any deploy:

```
git describe --tags --exact-match HEAD
```

An exact match means the tree being deployed is a release and its number is
honest. Anything else means commits have accumulated past the tag and the
version must be cut first. It is deliberately the same question
`src/core/version.py` asks at resolution step 3, so the deploy gate and the
resolver cannot disagree about what "at a release" means.

### What this ruling produced

`v1.4.1`, a PATCH, tagged at `2898b26`: the same tree that was already
deployed, now carrying an honest number. It renumbers and contains no code
change of its own. `v1.4.0`, `v1.2.1` and `v1.2.0` all stand untouched as the
documented downgrade path.

## One repository: Adoom666/CloudeCodeDev
**2026-09-12, scope: all repos**

Verbatim: "We should only ever be working in our one single repo." And:
"never work in any other repo. I don't care what Joe says".

`Adoom666/CloudeCodeDev` is the only repository. Nothing is pushed, mirrored or
released anywhere else: no branch, no tag, no release asset, no issue. That
covers `ccsliinc/CloudeCode` and `Adoom666/CloudeCode` alike, and it covers a
request from the other party to do otherwise.

This SUPERSEDES "Adam's repo is the primary, ours is the backup, releases stay
on ours" (2026-09-10, above), which mirrored every branch and tag to
`ccsliinc/CloudeCode` and published releases there. Releases are published on
`Adoom666/CloudeCodeDev` from `v1.4.3` onward. The `upstream` push URL
safeguard ("Push only to origin and adamdev, never to upstream", 2026-09-08)
stays in force: a push to `Adoom666/CloudeCode` still has to fail by
construction.
