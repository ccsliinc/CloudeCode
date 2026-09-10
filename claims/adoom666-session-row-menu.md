---
party: adoom666
id: adoom666-session-row-menu
title: session row action menu, merged into ccsliinc's superset
branch: master
opened: 2026-09-10
refreshed: 2026-09-10
expires: 2026-09-13
status: done
paths: client/js/session-row-menu.js client/js/session-row-menu-actions.js client/js/session-row-menu-open.js client/js/session-row-actions.js client/js/session-sidebar-rows.js client/js/session-sidebar-clicks.js client/js/session-sidebar.js client/css/session-row-menu.css tests/test_session_row_menu.node.mjs tests/test_session_row_actions.node.mjs tests/test_session_sidebar_rows.node.mjs
---

## approach

CLOSED. The collision this claim disclosed is resolved and neither side lost
work. Marking `done` rather than deleting, so the history of how it went stays
readable.

Owner ruled a superset: "reconcile the two menus into ONE superset." ccsliinc
merged our `8898f07` at `94ecc85` and landed the reconciliation as `546443e`
on `release/1.2.1`. Our three modules are the base and their behaviours were
restored on top. We were wrong to expect a revert and wrong to frame this as a
bridge; it is a merge.

Two things in the earlier revision of this claim are now WRONG and are
corrected here rather than left to mislead:

1. It said double-click rename is removed entirely. Overruled by the owner:
   "dont remove the rename. i said merge not take everything." Three doors
   now, all through one editor. See `settled/adoom666.md`.
2. It said `web/` is invisible from our side, which was the whole reason for
   not reverting. It is fetchable now at `origin/feat/svelte-1.3`, and
   `web/src/lib/plugins/` reads fine from here.

## detail

**They found a defect in our code and it is the useful part of this episode.**
Our restart runner read `data-row-status`; our trigger stamps
`data-row-menu-status`. Both halves are individually correct, git merged them
with no marker, and the only symptom would have been every restart reporting
"unknown" with nothing failing and nothing to grep for. They repointed the
reader, then caught that their own repoint shipped without a test that could
fail on it, and wrote that up as
`lessons/ccsliinc-a-test-that-cannot-fail.md`. That lesson is correct and we
are adopting it.

**Still open on our line:** adamdev/master retains our version, so it still has
double-click removed and still has the attribute mismatch. Both are fixed in
the merged superset on `release/1.2.1`. Whether master takes that merge or we
port the two fixes across is the owner's call, flagged to him.

**Nothing is claimed here any more.** These paths are free from our side.
