# Subsystem compare: SESSION SIDEBAR

BASE ba2aa5d, OURS v1.1 (d392aeb), HIS adamdev/master (0d1a12c). Read-only compare, nothing checked out.

**Headline: the two sides went opposite directions on the row's controls, and his side carries two real defects our side does not.** He deleted the row kebab and put pin and close back inline; we kept the kebab and rebuilt the GROUP HEADER instead (count gutter, coloured count, kebab on every band). His delete took the manual mark-unread control out of the entire UI, and his group header roll-up LED reads a field the sidebar rows do not carry.

## Conflict expectation

`git merge-tree --write-tree v1.1 adamdev/master` conflicts on exactly three of my files:

| File | Merge result |
|---|---|
| client/js/session-sidebar-rows.js | CONFLICT (content) |
| client/js/session-sidebar-groups.js | CONFLICT (content) |
| client/js/session-sidebar-group-actions.js | CONFLICT (content) |
| client/js/session-sidebar-clicks.js | auto-merges, and that is the hazard, see below |
| client/js/session-sidebar.js | auto-merges clean |
| client/css/session-sidebar-groups.css | auto-merges clean |

**The silent one is clicks.js.** His hunk moves the restart picker's status read from the kebab's `data-row-status` to the row's; ours edits a different hunk (recreate). Git merges both with no marker. If the rows.js conflict is then resolved OUR way, the kebab still carries `data-row-status` and nothing stamps it on the row, so `runRestart` hands the picker `null` and every restart says "unknown" instead of the measured state. Resolve rows.js and clicks.js as one decision or the merge compiles and lies.

## Behaviour faults, named

**1. His removal of mark-unread contradicts the owner's own rule.** `unreadToggleHtml` and every caller are gone at HIS rev: `git grep setSessionUnread adamdev/master -- client/js` returns api.js alone. CLAUDE.md at OURS records the owner verbatim: "when clicking a tab, the session is marked read. if i want it unread i click unread." His rationale (the LED now paints unread, so the envelope is redundant) is sound about the INDICATOR and removes the CONTROL with it. Ours keeps it in the row kebab and in launchpad.js. This is not taste; it deletes a stated capability.

**2. His group header roll-up LED is grey for every section.** `summarizeStates` passes the raw row into `StatusLed.ledStateFor`, which reads `activity_status`. A sidebar row carries the field as `status` (session-sidebar-fetch.js:140 at his rev assigns `activity_status` INTO `status`). So `activity_status` is undefined on every child and every header folds to `unknown`. Pre-existing at BASE; ours fixed it with `signalsFor` in session-status-summary.js, which reconciles the two spellings in one place and is documented and exampled. His side did not touch it.

**3. His side lost the last pointer route to the group picker on a phone.** He records this honestly in the group-actions header comment: with the row menu gone, `g` on a focused row and Alt+Arrow need a keyboard, so dragging onto a header is the only touch route left. It breaks that file's own stated rule that drag is never the only way to do anything. Ours keeps `rowMenuItemHtml` and the kebab entry.

## Per-file

**client/js/session-sidebar-rows.js (499 lines both sides, CONFLICT)**
Ours: passes a full `signals` object to `dotHtml` (unread, startup_gate, status_source) and adds `statusSource` to `signature()` so a status that stops being hook-fed repaints its tooltip. Keeps the kebab.
His: reverts to inline pin plus `SessionRowActions.html`, stamps `data-row-status` on the row, swaps `missingNoteHtml` for a `footerHtml` (status key plus version), adds a `transport` signal, and passes unread into `dotHtml` too.
Verdict: **OWNER DECIDES.** Both fixed the same real bug (unread never reached the LED). The rest is a product fork. Question: do you want pin and close back as inline icons on every row, undoing your own "fold the icons a thin 3 dots up and down sub menu", or keep the kebab?

**client/js/session-sidebar-groups.js (ours 362, his 321, CONFLICT)**
Ours: `menuButtonHtml` extracted, kebab on pinned and other via `data-group-menu-band`, count moved into a fixed `--sidebar-gutter` span placed FIRST, numeric unread badge dropped from the header, docstring records why the header gets `rows` even when folded.
His: doc-only change, recording that the numeric unread badge went and the ring now carries it.
Verdict: **SAME INTENT on the badge, KEEP OURS overall.** Both dropped the unread badge; only ours implements the layout the owner asked for.

**client/css/session-sidebar-groups.css (ours 441, his 422, auto-merges)**
Ours: adds the `.session-sidebar-group__gutter` rule and strips the count's `border-radius` and `background` down to accent-coloured tabular-nums text.
His: comment-only edits explaining that the row overflow menu was deleted.
Verdict: **KEEP OURS.** His comments describe a deletion we are not taking; drop them if the kebab stays.

**client/js/session-sidebar-group-actions.js (ours 500, his 452, CONFLICT)**
Ours: routes `[data-group-menu-band]` to the new band menu and exports `showMenu`, `announce`, `repaint` for it to reuse.
His: deletes `rowMenuItemHtml` (48 lines) and documents the phone regression that leaves.
Verdict: **KEEP OURS.** Note ours sits at exactly 500 lines, which is the cap, not headroom. Anything further in this file has to be split the way the band menu was.

**client/js/session-sidebar-clicks.js (ours 428, his 366, auto-merges)**
Ours: wires the recreate path with two success words (`ok` for respawn, `status === 'started'` for recreate) and resolves the durable uuid only when exactly one record carries the name.
His: deletes `onMarkUnreadClick`, claims the status-key click, and re-points the restart status read at the row.
Verdict: **MERGE BOTH, carefully.** Take our recreate block; take his status-read change ONLY if his rows.js wins. Do not take his mark-unread deletion.

**client/js/session-sidebar.js (ours 499, his 474, auto-merges)**
Ours: adds `activeTmuxName()` so the terminal header LED reads the same answer the list does.
His: drops the keyboard handler and the `missing` argument that went with the removed toggle and note.
Verdict: **MERGE BOTH.** Independent edits. Note ours is at 499 lines, one under the cap.

**client/js/session-sidebar-band-menu.js (ours only, 61 lines)**
Ours: the reserved-band kebab menu, split out precisely because inlining it pushed group-actions past 500. Invents no action, offers fold/unfold as a second route to the chevron. `node --check` passes.
Verdict: **BOTH, no conflict.** Nothing on his side occupies this file.

**client/js/session-sidebar-fetch.js (ours only)**
Ours: threads `status_source` through `mergeLiveRow` unconditionally, and drives the terminal header LED off the same merged rows.
Verdict: **BOTH, no conflict.** His side leaves this file untouched in the sidebar cluster.

## Tests

**Both sides shipped regression cover; his is broader, ours is more targeted at the shared bug.**
Ours, new in this cluster: `test_unread_led_one_field.node.mjs`, `test_status_legend_and_header_led.node.mjs`, plus a 44-line block appended to `test_sidebar_groups_rename.node.mjs` that asserts the band kebab on pinned AND other, the gutter wrapper, the bare `<span class="session-sidebar-group__count">3</span>`, that no `border-radius` or `background` survives on the count rule, and that `--sidebar-gutter` is declared in styles.css. That last pair is the right shape: it fails if someone reintroduces the pill.
His, new in this cluster: `test_session_row_inline_controls.node.mjs` (successor suite, accounts for all four menu items by name), `test_session_row_controls_render.py` (real browser geometry), `test_status_key.node.mjs`, `test_version_footer.node.mjs`, `test_session_transport.node.mjs`, plus rewrites of `test_session_sidebar_rows.node.mjs` (+179/-108), `test_sidebar_sessions.node.mjs` (+56) and `test_sidebar_group_menu_stacking.node.mjs`.
Neither side has a test that would have caught fault 2 above: nothing asserts a group header LED against rows spelled `status`. Ours fixes the code, his does not, and no suite on either side fails if it regresses. Add one.

## Structure

**His is a net deletion, ours is net additive, and both respect the 500-line rule but ours has no room left.**
His cluster: +347/-384 across 14 files, deleting three modules (session-row-menu.js, its gesture module, its stylesheet). Ours: +421/-53 across 9 files, adding one 61-line module. Every file on both sides is under 500 except ours at exactly 500 (group-actions) and 499 twice. Ours reuses `showMenu`/`announce`/`repaint` rather than reimplementing a positioned menu, which is the DRY move. His deletion removes an entire menu widget and its z-index coordination, which is genuinely simpler if the product decision goes his way.

## Docs

**Both sides document in the same change; his prose is better maintained.** His deleted-feature comments say where each capability went and name the phone regression rather than hiding it. Ours documents the gutter, the count and the band menu at the point of change and quotes the owner. Neither side updated CLAUDE.md's sidebar prose in this cluster.

## What the owner sees

Ours: count first in a fixed gutter so every group name starts at the same x, the count as accent-coloured text instead of an oval, a kebab on pinned and other so the menu column is a straight line, no numeric unread badge, and a header roll-up LED that actually reflects its rows. His: rows with pin and close back as inline icons, no three-dot menu anywhere, a status-light key and version at the foot of the list, and group headers unchanged from BASE with a roll-up that reads grey.
