# Toasts, launchpad, terminal, shell: ours (v1.1) vs his (adamdev/master)

BASE ba2aa5d. Conflict expectation from one `git merge-tree --write-tree v1.1 adamdev/master`:
CONFLICT in `client/index.html`, `client/js/launchpad.js`, `client/js/toast.js`. Auto-merges clean:
`client/css/styles.css`, `client/js/api.js`, `client/js/terminal.js`,
`tests/test_project_list_render_guard.node.mjs`, `tests/test_terminal_reconnect_buffer.node.mjs`.

**Headline: the two sides fixed different halves of the toast system and barely collide.** He fixed
what a toast SAYS (one card per session, honest counts, no summons to a busy session). We fixed where
a toast LIVES (raised globally, answered by hooks, reconciled by poll, clickable to navigate). The one
real disagreement is that his branch deleted every mark-unread control in the app.

---

## client/js/toast.js  ->  MERGE BOTH (conflict, resolvable)

His: `_groupKeyFor` / `_pick` / `_countBySeverity` added, `_groups()` re-keyed from (kind, session) to
session alone with the winner chosen by `SUMMARY_PRIORITY` read live from session-status-summary.js.
`_renderDismissAll` now counts CARDS, badge counts same-kind only, dismiss button counts records.
Plus attachment receipts (`updateLocal`, `dismissKindForSession`, `SURVIVES_TYPING`).

Ours: `reconcileOpen(openToasts, {since})` plus an `_addedAt` stamp, so a poll-only surface can drop a
card the server auto-acked; a `cloude:toast-dismissed` CustomEvent so the global poller can suppress a
just-dismissed id; click-the-card-to-navigate on `_renderCard` with `stopPropagation` on dismiss.

Verdict: SAME FILE, DIFFERENT INTENT. Take his `_groups()` fold wholesale, take ours whole. Two
mechanical fixups: our navigate handler reads `newest`, which his rename makes `winner`; and the card
carries `dataset.sessionId` from the winner, which is still one session because his key is the session.
His fold is correct under the unordered/duplicated/dropped rule: `_groups()` is a pure fold over the
held set, so a card upgrades to a permission and a late duplicate `Stop` cannot take it back.
One risk to name: two distinct PermissionRequests on ONE session now collapse to one card, and the
second command string is not on screen. Claude blocks on one at a time, so this is a latent risk
rather than a measured defect, but the BASE comment removed by his change is the one that warned about it.

Tests: his 29 in test_toast_stacking + 23 in test_toast_dismiss + 33 in test_attachment_toast. Ours 12
in test_toast_reconcile + 17 in test_toast_cross_session + 18 in test_toast_auto_ack + 19 in
test_toast_history_render. Both ship regression coverage for their own change. Neither side's tests
touch the other's code.

Size: BASE 784 lines. His 1017, ours 916, merged roughly 1150. Already past the budget, both extracted
new modules rather than only growing it (his toast-session-group.js 244, attachment-toast.js 482; ours
toast-global-poll.js 219, toast-navigate.js 131, toast-dismissed-ring.js 139, toast-history-panel.js
256, toast-history-render.js 215). The merged file wants a follow-up extraction of `_renderCard`.

## His server-side toast fix (no file of ours touches it)  ->  KEEP HIS

`0d1a12c` suppresses the Stop and Notification toast when `SessionManager.subagent_depth` is positive,
read BEFORE the event is applied because Stop resets the depth. PermissionRequest is never suppressed
at any depth, and that is the negative control the 15 tests in test_hook_toast_subagent_suppression.py
turn on. Fails toward notifying. This is orthogonal to our `toast_auto_ack.py` (his refuses to raise,
ours answers what was raised). DIFFERENT INTENT -> BOTH.

## client/js/terminal.js  ->  MERGE BOTH (auto-merges)

His: `setupWebSocketHandlers` and `handleWebSocketMessage` now ask `TerminalFrameGuard.accepts(...)`
before any frame touches xterm, and `_noteUserInputToSession` passes the sent bytes to
`dismissForSessionActivity(sessionId, data)`.

Ours: three bare double-rAF waits replaced by `TerminalLayoutWait` inside `connectToSession`,
`reconnectToExistingSession` and `waitForFontsAndLayout` (gotcha 9, the backgrounded tab that never
opens a socket).

Verdict: DIFFERENT INTENT, no overlapping hunks, both. His `terminal-frame-guard.js` (89 lines, pure,
no DOM, 11 tests) fixes a confidentiality bug we do NOT have: session A's bytes rendered into session
B's terminal because `close()` only starts the handshake and the handlers close over the controller,
not the socket. That is the single most valuable thing in his branch for this subsystem. Ours has 12
cases in test_terminal_layout_wait.node.mjs including a guard that fails the build if a bare rAF await
reappears in terminal.js. Net line counts: BASE 2423, his 2411, ours 2422.

## client/js/launchpad.js  ->  MERGE BOTH (conflict, same bug fixed twice)

His changed `renderRunningSessions`, `_bindRunningSessionClicks`, `renderLaunchpadUI`,
`renderHomeBarVersion`, `_endedSessionsForTree`, `_renderTreeSessionRowHtml`.
Ours changed `loadRunningSessions`, `renderRunningSessions`, `_renderRenamePencilHtml`,
`_renderFamilyPillHtml`, `_renderTreeSessionRowHtml`, `_projectListHtml`.

The conflict is the two `dotHtml` call sites (about line 1745 and about 4145) and both sides fixed the
SAME bug there: `dotHtml(status)` was dropping the signals object, so a launchpad LED never saw unread
or the startup gate. His passes `{unread, startup_gate, transport}`; ours passes
`{unread, startup_gate, status_source}`. MERGE: take the union, four signals. His `transport` needs his
session-transport.js; our `status_source` feeds the LED tooltip.

Everything else is disjoint: his version footer and his row-menu-to-inline-controls migration against
our archive icon, family pill and project-count spacing. He is 26 lines net SHORTER on a 6466-line
file; we are 14 longer. Both obey the "new focused modules" rule elsewhere.

## client/index.html  ->  MERGE BOTH (conflict, mechanical)

Both only append to the script and stylesheet lists. He adds attachment-toast, session-transport,
toast-session-group, session-status-key, version-footer, terminal-frame-guard and removes
session-row-menu plus session-row-menu-gestures. We add api-toasts, toast-dismissed-ring,
toast-navigate, toast-global-poll, session-header-led, terminal-layout-wait, terminal-away-gap,
terminal-away-bar, session-sidebar-band-menu, toast-history-render, toast-history-panel. Union both
lists, keep his removals only if his row-menu migration is taken as a whole. Confirmed: his change does
NOT touch the Svelte bundle question, because there is no Svelte bundle on either branch. Ignore that.

## client/css/styles.css  ->  BOTH (auto-merges)

His: deletes the `--fab-top-edge` rail token and the local-servers panel block, net 97 lines shorter.
Ours: adds `--sidebar-gutter`, retunes `.project-node__count` off `margin-left: auto`. Disjoint line
ranges, different intent, no conflict. Note only: our `client/css/terminal-away-bar.css` header comment
cites `.local-servers` as precedent, so his deletion makes that comment stale. One comment edit, not a
dependency.

## client/js/api.js  ->  BOTH (auto-merges)

His: doc note on `markSessionUnread` saying nothing calls it any more, and `getLocalServers` deleted.
Ours: `recreatePreview` and `recreateSession` added for the dead-tmux recreate path. Disjoint.
Taking his `getLocalServers` removal means also taking his index.html and styles.css removals of the
panel; ours still ships it.

## tests/test_project_list_render_guard.node.mjs  ->  MERGE BOTH (auto-merges)

His: rewrites the open-overflow-menu case into an absence assertion plus a source grep that the guard
no longer reaches for the deleted `window.SessionRowMenu`. Good discipline, a stale reference to a
deleted global reads as a live feature.
Ours: one stub line, `archiveIconSvg`, for the home page archive icon. Different lines, take both. His
case is only valid if his row-menu removal ships.

## tests/test_terminal_reconnect_buffer.node.mjs  ->  MERGE BOTH (auto-merges)

His: drops the `loadLocalServers` stub with the panel. Ours: loads terminal-layout-wait.js before
terminal.js so the harness measures the real code path rather than the optional-chaining fallback.
Two-line changes, different lines, take both.

---

## The behaviour one side gets wrong

**His branch deletes mark-unread from the entire UI.** `markUnreadHtml` survives only as an uncalled
helper in session-status-ui.js; his api.js comment states plainly that nothing calls
`markSessionUnread` any more. A grep for `markUnread|mark-unread` across his client returns exactly one
file. Ours returns twelve. That contradicts the owner's verbatim rule recorded in CLAUDE.md at OURS:
"when clicking a tab, the session is marked read. if i want it unread i click unread." His half of the
rule (opening clears it) ships correctly on both branches; the other half has no control left to click.
Everything else he changed in this subsystem is sound and several pieces are better than ours.
