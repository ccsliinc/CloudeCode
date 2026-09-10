# ccsliinc: behaviours we rely on

Ported 2026-09-10 from `wants/ccsliinc.md` on the `coord` branch, which the
work protocol supersedes. The rule and the reasoning live in
`docs/KEPT-BEHAVIOURS.md`, and the owner's ruling behind it is in
`docs/DECISIONS.md`. The `disliked` section from the original is kept below and
is still stated as preference, not instruction.

Every entry carries `paths`, `anchors` and `tests`, and
`scripts/check_kept_behaviours.py` fails a build when a declared anchor leaves
the tree. `tests: none` is the honest record of a behaviour nothing holds and is
never a failure; there is one, and it is the one that nearly died.

## kept

Behaviours we rely on and would notice losing. Adding something beside one of
these is always fine. Removing one is not ours or yours to do alone.

### restart on a live row
paths: client/js/session-sidebar-rows.js client/js/session-sidebar-clicks.js client/js/session-row-menu.js client/js/session-row-menu-items.js
anchors: restartable | data-row-menu-status
tests: tests/test_session_row_menu_superset.node.mjs tests/test_session_row_menu_dispatch.node.mjs
Restarting a session from its row, with the picker seeing the row's MEASURED
status rather than null. The menu TRIGGER is where that status comes from: our
own kebab spelled it `data-row-status` and the 2026-09-10 reconcile moved us
onto adam's trigger, which spells it `data-row-menu-status`. When the kebab went
and the read moved to the row without anything stamping it there, every restart
reported "unknown" instead of the measured state, and git merged both halves
with no marker. Keep a route to restart, and keep whatever stamps the status it
reads. The anchor is the CURRENT spelling on purpose: an anchor on the retired
one would keep matching the comment that explains the move.

### the manual mark-unread control
paths: client/js/session-row-menu.js client/js/session-row-menu-items.js client/js/session-sidebar-clicks.js client/js/launchpad.js src/config.py src/main.py web/src/lib/plugins/mark-unread/index.ts
anchors: mark-unread | show_mark_unread_control
tests: tests/test_session_row_menu_superset.node.mjs tests/test_unread_led_one_field.node.mjs
The owner's rule, verbatim: "when clicking a tab, the session is marked read. if
i want it unread i click unread." The LED painting unread is an INDICATOR and
does not replace the CONTROL. It already ships behind
`ui.show_mark_unread_control`, default on, so turning it off is a setting rather
than a deletion.

### group filing from the row itself
paths: client/js/session-sidebar-group-actions.js client/js/session-row-menu.js client/js/session-row-menu-items.js
anchors: move-to-group
tests: tests/test_session_row_menu_superset.node.mjs tests/test_sidebar_group_menu_stacking.node.mjs
`rowMenuItemHtml` is the last POINTER route to the group picker. With it gone,
`g` on a focused row and Alt+Arrow both need a keyboard and dragging onto a
header is the only touch route left, which breaks that file's own stated rule
that drag is never the only way to do anything. Phones have no keyboard.

### double-click rename, as well as menu rename
paths: client/js/session-sidebar-rename.js client/js/session-sidebar-clicks.js client/js/session-sidebar.js
anchors: onDblClick | addEventListener('dblclick'
tests: tests/test_session_sidebar_rename_gesture.node.mjs
The owner uses it. A menu rename is a fine ADDITION and a poor replacement. This
one nearly went on our own side, not theirs: the merge was about to drop it
purely because an incoming commit intended to.

THE GESTURE IS NOW TESTED, not only anchored. Every other rename test - the
edits-label suite, and even the dispatch suite's own double-click case - calls
`SessionSidebarRename.beginEdit` or `onDblClick` directly, which proves the
editor works and proves nothing about whether a double-click still reaches it,
which is exactly the half that was removed. `test_session_sidebar_rename_gesture.node.mjs`
drives the real `listEl.addEventListener('dblclick', ...)` registered by
`SessionSidebar.init()` - a genuine bubbling event, not a direct call - and
asserts it reaches `beginEdit` for the right session, lands on the same
observable state as F2 and the row menu's rename item, and opens nothing for a
row that cannot be renamed. Mutation-checked: deleting the listener registration,
and separately repointing it at a different function than the other two doors
use, each fail this file's own named tests. The two anchors below are still the
whole STATIC guard: `onDblClick` (the exported handler) and
`addEventListener('dblclick'` (the registration in `session-sidebar.js`). Both
were measured absent from `8898f07`, the commit that deleted the gesture, while
the words "double-click" and "dblclick" both survived in its prose.

### dead rows go to Recent
paths: src/core/session_lifecycle.py src/core/session_manager.py
anchors: session_lifecycle_reaped | _reap_absent_instances
tests: tests/test_ended_session_listing_rule.py tests/test_session_lifecycle_reconcile.py
Owner's call, verbatim 2026-09-08: "they go into recent, they can disappear." A
session whose process died leaves the live list rather than lingering there
wearing a dead light, and a restart from Recent is a resume. A round that made a
husk keep its row painted dead was overruled and reverted (`ba2aa5d`).

### the concentric single-element LED
paths: client/js/status-led.js client/css/status-led.css web/src/lib/StatusLed.svelte web/src/lib/led.ts
anchors: box-shadow
tests: tests/test_status_led.node.mjs
Both rings are ONE element: the inner is the span's background-color and the
outer is a three-layer box-shadow on that same span. There may not be a
pseudo-element. The halo used to be an `::after` and the browser pixel-snaps
that box independently, so the two circles came apart by a device pixel whenever
the dot landed on a fractional x/y. A box-shadow paints from the element's own
border box, so concentric is the only geometry it can have.

### the outer ring carries unread, as a still green ring
paths: client/js/status-led.js client/js/session-status-ui.js client/css/status-led.css web/src/lib/led.ts
anchors: OUTER_STATES | --led-color-unread
tests: tests/test_status_led.node.mjs tests/test_status_key.node.mjs
Ruled 2026-09-09, and the owner picked adoom666's model over ours ("1. his").
`unread` IS an outer state (`OUTER_STATES` at `status-led.js:123`): a finished
turn nobody has read paints a crisp STILL green ring, a read session at rest
takes `steady`, and `active` is the only outer state that animates. The inner
dot carries the session's state, `done` while the green ring is up and `idle`
once it goes. `--led-color-unread` exists and was not retired.

CORRECTED 2026-09-10. The version of this entry ported from `wants/ccsliinc.md`
said the opposite, because `wants/` was written before the ruling and never
updated after it. What we rely on is the RULED model, not the one we proposed.
Do not reintroduce inner-dot unread; it was decided against, not forgotten.

### the strict CSP, with no third-party origin in any directive
paths: src/main.py src/security_headers.py client/index.html tests/test_no_remote_assets.py
anchors: frame-ancestors | default-src
tests: tests/test_no_remote_assets.py
`default-src 'self'`, `frame-ancestors 'none'`, nothing off-origin. This was a
correctness fix and not only hardening: a content blocker dropped enough of the
CDN xterm.css that the character cell was measured wrong, FitAddon derived a
bogus cols/rows and the real tmux pane was reflowed to a grid matching nothing
on screen, on a phone, while desktop looked perfect. New libraries get vendored.
`style-src 'unsafe-inline'` stays and is not licence to widen anything else.

## disliked

Our preferences, stated as preferences. None of these is an instruction to
anyone else, and none of them justifies deleting your work. They are here so you
know what we will grumble about and can decide whether you care.

### files over 500 lines
We would rather see a new focused module than another hundred lines on
`launchpad.js`, `terminal.js`, `app.js`, `routes.py` or `session_manager.py`.
Those five are already past the guideline.

### per-row queries and per-row subprocesses on the listing path
One bulk read per pass, indexed, and the decorators read the index. Measured at
27 subprocesses and about a second a poll for 13 sessions before that changed.
This is a preference about shape; your measurements may beat ours.

### a behaviour removed without a replacement
The one we feel most strongly about, and the reason the rule above exists. If
something is genuinely redundant, we would rather see it default-off behind a
setting for a release than deleted, so the person who relied on it finds a
switch instead of a regression.
