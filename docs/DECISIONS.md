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
