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
