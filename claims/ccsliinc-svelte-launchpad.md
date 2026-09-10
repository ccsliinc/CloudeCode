---
party: ccsliinc
id: ccsliinc-svelte-launchpad
title: svelte migration of client/js/launchpad.js, slices 2 to 7
branch: feat/svelte-1.3
opened: 2026-09-10
refreshed: 2026-09-10
expires: 2026-09-13
status: paused
paths: client/js/launchpad.js client/js/session-recent-visibility.js client/js/project-list-render-guard.js client/js/project-create-folder.js web/src/lib/launchpad/*.ts web/src/lib/launchpad/*.svelte web/src/lib/mount.ts web/src/main.ts web/vite.config.ts
---

# svelte migration of client/js/launchpad.js, slices 2 to 7

## approach

dismantle the 6,000 line launchpad singleton in seven slices, one section at a
time, legacy and svelte coexisting until slice 7 deletes the file. each slice
moves a named set of methods, ports its node tests to vitest, and mounts through
ONE seam (web/src/lib/mount.ts). legacy class names and element ids are kept
verbatim so all 26 themes and the existing css apply unchanged.

the invariant we assume: THE 62 NODE TESTS UNDER tests/*.node.mjs ARE THE SPEC.
a slice may delete a test file only once its assertions exist in vitest. we port
line by line and do not rewrite while moving.

expects to change SHARED semantics at slice 7 and not before: window.Launchpad
becomes a thin typed shim exported from the bundle carrying exactly twelve
members. until then client/js/launchpad.js is still live and still the fallback.
anything that adds new code to launchpad.js is adding to a file with a delete
date on it.

## detail

Plan: `.claude/notes/svelte-migration-launchpad.md`.

Slice 1 (the attribution prompt) is DONE and landed as `36a8a18`. Slices 2 to 7
are **PAUSED, not abandoned**, because `release/1.2.1` took priority.

Remaining slices, in order, with the risk we assessed:
2. recent sessions section (~604 lines) - medium
3. the store (~820 lines, no visual change) - HIGH, the one to review hardest
4. the project tree (~900 lines) - medium
5. the running sessions list (~1,100 lines) - medium
6. modals and flows (~1,560 lines) - medium
7. the shell, and launchpad.js is deleted (~900 lines) - HIGH

**This claim is `paused` on purpose and that is a meaningful state.** It means
we intend to come back, not that the area is free. It is also the first thing we
would offer up: if adoom666 wants any of slices 2 to 7, or wants to take the
migration wholesale, say so and we will mark it `done` and get out of the way.

**What we would rather not have happen silently:** large new features written
INTO `client/js/launchpad.js`. Every line added there is a line slice 7 has to
port and a line that ages the plan. If you need a new launchpad feature this
week, that is fine and expected; just say so here so slice 4/5/6 can absorb it
rather than discover it.

## update 2026-09-10

`feat/svelte-1.3` is now published to `adamdev` and `origin` at `d6801cb`.
Until today it existed only in local worktrees, so `web/` was invisible to
adoom666 and this claim named paths nobody on that side could open. That
was our gap, not theirs.

Still `paused` and still meaningful: we intend to come back to slices 2 to
7, and the offer stands to mark it `done` and get out of the way if
adoom666 wants any of them. The read-first paths are listed in
`claims/ccsliinc-session-row-menu.md`; the plan is
`.claude/notes/svelte-migration-launchpad.md` on that branch.
