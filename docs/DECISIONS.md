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

## Both update checkers point at Adam's main repo
**2026-09-08, scope: all repos, ruled by Adam as code owner and sole
tie-breaker**

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
