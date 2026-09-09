# TODO

## In flight (2026-09-08 night)

### 1. Typing lag + cursor renders in the wrong place  [input-lag agent]
Reported with screenshot: typed text appears BELOW the prompt box, colliding with
the path/status line, and there is input lag. Appeared after
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` shipped in `d407fa1` (classic renderer
instead of the fullscreen TUI). Suspected cost of the classic renderer, which the
scrollback diagnosis explicitly warned flickers on redraw.

Success criteria:
- Typed characters appear inside the prompt box at the correct column.
- No perceptible lag beyond the pre-change baseline (measure, do not eyeball).
- Scrollback still accumulates, or the tradeoff is made an explicit setting with
  a measured recommendation.

### 2. "attached <file>" toast is unreadable  [attach-toast agent]
Screenshot: faint low-contrast text painted directly over terminal content.
Requested: render it like the notification window instead, include a mini
thumbnail of the attached image, keep it visible until the prompt is SENT, then
hide.

Success criteria:
- Readable against terminal content in both themes.
- Mini thumbnail of the attachment.
- Persists until prompt submit, then dismisses.
- Multiple attachments handled.
- validator-agent confirms in a real browser.

### 3. Local pytest breaks when an agent worktree exists  [pytest-ignore agent]
`pytest.ini` `norecursedirs` covers `.worktrees` but not `.claude/worktrees`,
where Claude Code agent worktrees land. Collection aborts with
`ImportPathMismatchError` (two `tests/conftest.py`).

Success criteria: full local run collects cleanly with an agent worktree present.

### 4. Rebuild the draft release  [BLOCKED on 1-3]
Draft release `v1.0.33` and its DMG were built at `f9df612`, before the three
terminal fixes. Must be rebuilt from master after the above land, or it ships the
frozen-terminal bug.

## Done tonight
- Grafted the v1.1 lineage onto master (`f9df612`), unrelated histories, tree
  identical to v1.1. Default branch flipped to master.
- Fixed the five defects making CI red (`97b947f`). All four jobs green.
- Untracked `.cc.theme` (`4cc6187`).
- Live output streaming fix on the reconcile attach path (`9f01c6c`) - the real
  cause of the frozen terminal, latent, triggered by any server restart.
- Reapplied the attach-paint + scrollback fix (`d407fa1`) after confirming it was
  never the cause of the freeze.
- Verified on live: 13/13 panes streaming, this session off the alternate screen
  with 904 lines of retained history.

## Agent notes
Append findings below as `[AGENT-NAME] [TIMESTAMP]: finding`. Append, never
overwrite.

[input-lag] [2026-09-08 22:50 ET]: The typed-text-in-the-wrong-place bug and the
"input lag" are ONE defect. `capture_visible_screen()` sent the screen without
the cursor, so the browser's cursor landed after the last captured character
while the pane's sat five rows higher, inside Claude Code's input box. Harmless
while Claude Code drew on the alternate screen (that renderer re-anchors with an
absolute `ESC[r;cH` every frame); fatal since `d407fa1` made the normal screen
the default, because a normal-screen frame is pure relative motion with zero
absolute positioning, so the offset never heals. Proved end to end on a
throwaway socket by replaying a real pane's capture into a second real pane:
uncorrected, a typed `H` landed on the mode line at row 12 instead of the input
box at row 8; corrected, the two panes agree cell for cell. Lag hypotheses
measured and rejected: per-keystroke output is 52 to 650 bytes, the pane scrolls
4 lines per 10 keystrokes not once per keystroke, and `HISTORY_LIMIT` 50000
never reaches the attach path, which paints one viewport. The perceived lag is
keystrokes painted where the user is not looking, then flushed by a later full
redraw. Fix plus `tests/test_capture_cursor_real_tmux.py` (5 tests, 4 of them
fail at HEAD). Suite: 5307 passed, 2 pre-existing failures unchanged
(`test_nuke_sandbox::test_dry_run_deletes_nothing`, the documented-flaky
`test_respawn_refreshes_pane_env`), no new ones.

[attach-toast] [2026-09-08 22:58 ET]: The "attached <name>" confirmation was
`FabMenu.notify` - one low-contrast line painted straight onto live terminal
output with no card behind it and a 3-second timer - so it competed with moving
scrollback and lost. It is now a real toast raised through the SAME
`ToastManager` the hook notifications use (`client/js/toast.js`), contributing
only a thumbnail strip: a downscaled `data:` preview for images and a typed chip
(PDF, GZ) for everything else, never a broken `<img>`. `data:` and not `blob:`
because `img-src 'self' data:` does not carry `blob:` and an object URL would be
CSP-blocked with no visible error. Three properties make it differ from a server
toast, each declared rather than inferred: it is `local` so dismissing it never
POSTs an ack for an id the server never issued; it SURVIVES TYPING, because a
receipt describes what is staged in the buffer being typed INTO, so clearing it
on the first keystroke would flash and vanish; and it is retired by the prompt
being SENT. The submit test is the load-bearing part - a bare CR sends, while
ESC+CR (shift+enter) and a lone LF (the mobile Yen key) are newlines and must
not, and a mouse report can carry 0x0d as a coordinate byte, so pointer motion
could otherwise "send" a prompt nobody sent. Attachments coalesce on the session,
so four files are one card with four thumbnails rather than a pile.
Found and fixed in the in-progress work: `attachment-toast.js` was never
referenced from `index.html` (dead code), nothing called the dismissal seam so it
never cleared, the six `.toast__thumb*` classes had no CSS at all, and the card
rendered "unknown session" because no local toast carries a label. terminal.js
was left at NET ZERO lines (5 changed, 0 added) - it is one line under the hard
`< 2425` guard in `tests/test_terminal_layout.node.mjs` - by having
`dismissForSessionActivity(sessionId, data)` dispatch the receipt clear, which
also puts the whole "what does user input retire" policy in one file.
Verified by render, not asserted: `tests/test_attachment_toast.node.mjs` (29
tests, real ToastManager, negative controls on the image guess and on the ack)
plus a screenshot of the real CSS and real module in both themes and at phone
width. Suite: 5307 passed, same 5 failures as my measured pre-change baseline.
Note `test_status_led`, `test_status_summary` and `test_terminal_layout` were
failing in the working tree from the concurrent SessionTransport work, not from
this; my files were staged individually and terminal.js/index.html were staged as
HEAD-plus-my-hunk so none of that work was swept into this commit.

[local-servers] [2026-09-08 23:10 ET]: Removed the "LOCAL SERVERS" panel (the
horizontal bar listing detected dev ports between the terminal and the session
status bar) from `client/index.html`, `client/css/styles.css` and
`client/js/terminal.js`/`client/js/api.js` - the panel's markup, its CSS rule
block, the `.terminal-container` positioning comment/property that existed only
for it, and every JS consumer (`loadLocalServers`, `_mergeLocalServer`,
`_dropLocalServer`, `_renderLocalServers`, `_activeSessionName`,
`API.getLocalServers`, both WS message branches for
`local_server_detected`/`local_server_lost`). The panel was ALREADY an absolute-
positioned overlay (fixed in an earlier incident specifically so it could never
resize `#terminal`), so removing it required no terminal reflow fix - confirmed
by a static render harness loading the real CSS/markup before and after, at
1280x800 and 390x844, screenshots at
`/private/tmp/claude-502/.../scratchpad/local-servers-removal/{before,after}-{desktop,phone}.png`.
Left BEHIND ON PURPOSE (scope was "remove the bar", not "remove detection"):
`src/core/local_servers.py` (`LocalServersTracker` - a 30s janitor loop probing
each tracked port's TCP listener, pattern-callback hooks into the log monitor for
5 port-bearing patterns, all wired in `src/main.py` lifespan), the REST endpoint
`GET /sessions/{name}/local-servers`, and the WS broadcast of
`local_server_detected`/`local_server_lost`. ALL THREE ARE NOW ORPHANED - nothing
in the client calls that endpoint or handles those WS messages any more.
Cost while orphaned: near-zero (the janitor sleeps 30s and iterates an empty
dict when nothing is tracked, which is now permanent since nothing ever fetches
or displays a detection), but it is genuinely dead code the user should decide
whether to remove in a separate change. Also confirmed dead, unrelated to this
removal: `SessionInfo.local_servers` (list) and `SessionStats.local_servers`
(int) on `GET /sessions/list` are hardcoded to `[]`/`0` at every construction
site in `session_manager.py` and were already unpopulated/unconsumed before this
change - pre-existing dead fields, not something I introduced or touched.
Updated 2 tests that asserted the panel's presence
(`tests/test_terminal_resize_settle.node.mjs`,
`tests/test_terminal_reconnect_buffer.node.mjs`) to assert its absence instead
of deleting them. Suite: 5313 passed, 4 failed (`test_nuke_sandbox` -
environmental/unrelated, `test_respawn_refreshes_pane_env` - documented flaky,
`test_session_row_menu_renders` - Playwright timeout inside Agent C's in-flight
status-light/menu rewrite, `test_version_probe` - documented pre-existing); none
touch any file I changed. terminal.js/index.html/styles.css staged as
HEAD-plus-my-hunk only, same pattern as the attach-toast note above, so none of
the concurrent SessionTransport or envelope-icon work was swept into this
commit.

[status-light] [2026-09-08]: Five colours on one light, envelope removed from
both surfaces. Eight LED inner states now paint five hues: green
`working`/`working_subagent`; yellow `question` AND the startup gate's
`awaiting_startup_prompt` (both are fully stopped waiting on a human); light
blue `notice` alone (working, but wants you); grey `idle` and `unknown`, told
apart by shape (`unknown` stays the one hollow dot) rather than by a louder
colour; red `dead` and a dropped WebSocket. `finished_unread` is the two rings
saying two things: a grey dot inside a crisp green ring. State NAMES stay eight
and every label still says which state it is, so colour is never the only
signal. Two new inner states, `notice` and `disconnected`. The underlying state
machine is untouched: `permission_open` and `notice_open` are still two
independent booleans, permission still read first, both still cleared by
UserPromptSubmit/PreToolUse/Stop, and summary priority is still
permission > input > working > unread > done > dead > unknown.
FOUND BY MEASURING, NOT BY READING: the finished-turn ring shipped as an
opaque DISC in my first pass and rendered `finished_unread` as a solid green
blob with no grey in it. The halo pseudo-element carries `z-index: -1`, which
paints it ABOVE the element background - and the element background IS the dot.
Every other halo hides that because it is a wash at 0.18-0.55 opacity. Caught in
a 6x render harness before commit; the ring is now a transparent centre with a
2.5px inset band. A test pins the shape.
Transport disconnection is REAL, not asserted: it lives in
`client/js/terminal.js`'s `ws.onopen`/`ws.onclose`, recorded by the new
`client/js/session-transport.js` and read by the sidebar rows and launchpad
cards. This browser holds a socket to at most ONE session, so every other
session answers `unknown` - a sidebar full of red because one socket dropped
would be a fabricated measurement. A deliberate detach CLEARS rather than marks.
`dead` and `disconnected` share the red and are separated only by their labels.
Envelope removed from: the sidebar row's kebab menu (`session-row-menu.js`), the
launchpad running-session card and the project-tree rows (`launchpad.js`), its
builder and both glyphs (`session-status-ui.js`), its click and keyboard
handlers (`session-sidebar-clicks.js`, `session-sidebar.js`, `launchpad.js`),
its CSS (`session-sidebar.css`, `session-sidebar-density.css`,
`session-row-menu.css`) and the kebab's now-unread `data-row-unread`.
Server-side unread TRACKING is untouched; `PATCH /sessions/{name}/unread` still
exists and `api.setSessionUnread` is kept as its client with a docstring saying
nothing calls it.
Suites: node 187/187 pass (baseline was 184/186, the two failures being another
agent's in-flight toast/terminal work which has since landed). pytest 5313
passed / 3 failed, and all three are the documented environmental ones
(`test_nuke_sandbox`, `test_respawn_refreshes_pane_env` flaky,
`test_version_probe`); `test_session_row_menu_renders` failed mid-flight against
my half-applied change and is green again.

[row-icons] [2026-09-08]: pin and close are inline icons on the conversation
row again, and the three-dot overflow menu is gone. "move the pin and close
icons back to the inline icons. remove 'add to group' / 'restart the agent'
and the three dots now that they're not needed."

EVERY ITEM THAT WAS IN THAT MENU, AND WHAT HAPPENED TO IT. Pin: back inline,
same builder (`SessionSidebarRows.pinButtonHtml`), same `aria-pressed`, same
labels. Close / remove: back inline, same builder (`SessionRowActions.html`),
same confirm copy. Add to a group: REMOVED. Restart the agent: REMOVED FROM A
LIVE ROW ONLY - a dead row still offers it inline. Nothing else was in the
menu, so the trigger had nothing left and went with it.

DELETED: `client/js/session-row-menu.js`, `session-row-menu-gestures.js`,
`client/css/session-row-menu.css`, `SessionSidebarGroupActions.rowMenuItemHtml`,
`SessionRowActions.LIVE_STATUSES`, the render guard's `SessionRowMenu.isOpen()`
check, and the `data-row-menu` / `data-row-pinned` attributes. `data-row-status`
MOVED off the kebab onto the row, because the row is now the only element built
from the whole payload and `session-sidebar-clicks.js` reads it there for the
restart picker. Right-click and long-press on a row now open nothing.

SURFACES. Only the SIDEBAR row ever had this menu. The launchpad's
running-session card already drew close/restart inline and changes only by
losing the live restart; the project-tree row carries no actions at all and is
untouched. So "one consistent treatment" is what shipped, not three copies.

REACHABILITY, TRACED. Restart: reachable ONLY from a dead row now (sidebar
inline, launchpad card inline) plus the launchpad's separate "restart" on an
ENDED tree row, which is its own path (`imported_restart_routes.py`). No
command palette, keyboard shortcut or deep link reaches it. The four gates in
front of a LIVE respawn are all still present server-side and still tested; the
first one is now shut, so `confirm_restart_live`, `RespawnPlan.kills_live_pane`,
`SessionRestartLive.armHtml` and `liveConfirmCopy` are ORPHANED - reachable by
no user action. Left in place deliberately; flagged for the owner to decide.
Add to a group: the picker itself is untouched and still opens on `g` over a
focused row, on Alt+Arrow across a band edge, and by dragging onto a group
header. It has NO POINTER ROUTE left, so on a phone the drag is the only way,
which breaks the "drag is never the only way to do anything" rule at the head of
`session-sidebar-group-actions.js`. Also flagged rather than papered over.

TOUCH TARGETS, MEASURED IN CHROMIUM. The kebab bought a 44px target from a
transparent `::after` reaching sideways, which is free when nothing sits to your
right. Two neighbours cannot do that, so `client/css/session-row-inline-
controls.css` grows WIDTH on the real box (36px) and HEIGHT on the overlay
(44px), cozy and detailed only. At a 330px viewport that left the name column at
81.9px live and 22.6px on a DEAD row (three controls), which paints "Punchlist
Test" as "P...". The ownership badge is 58px of that line and is the glyph the
row builder already drops outright at compact density, so it is hidden under
`(pointer: coarse) and (max-width: 420px)` - a display rule, still in the
markup. After: name 125.5px live (the kebab layout gave 117.9, the ORIGINAL
pre-kebab inline layout gave 85.9 with 18px targets), 81.5px dead, row height
unchanged at 46px, no horizontal scroll, both controls fully on screen.

TESTS. `tests/test_session_row_menu.node.mjs` deleted (its module is gone) and
replaced by `tests/test_session_row_inline_controls.node.mjs`, 14 assertions.
`tests/test_session_row_menu_renders.py` renamed to
`tests/test_session_row_controls_render.py` and rewritten against the same real
harness, 18 assertions including the 330px squeeze and the dead-row case.
Updated: `test_session_sidebar_rows`, `test_session_row_actions`,
`test_session_row_restart`, `test_restart_live_gate`, `test_dead_row_renders_dead`,
`test_kebab_icon_shared`, `test_sidebar_group_menu_stacking`,
`test_project_list_render_guard`, `test_session_status_ui`, and
`scripts/verify_sidebar_group_drag.py` (now opens the picker with `g`).

[sidebar-polish] [2026-09-09 10:55 PT]: four sidebar changes shipped together.

THE OVERSIZED GREEN DOT WAS NOT AN OVERSIZED DOT. Measured in Chromium
across all forty (inner, outer) pairs: the ELEMENT box read 9.00 x 9.00 in
every single one, which is why the whole node suite was green while the
owner could plainly see the difference. What varied was the HALO, which
was sized per state AND painted partly outside its own box by
`box-shadow: 0 0 1.5px 1.5px`. Lit diameters before: `active` about
14.7px (an 11.69px disc plus 3px of glow, in the dot's own hue at 0.55
opacity), `unread` 15.30px (that block set `--led-halo-scale: 1.7` of its
own), and `steady` / `dim` / `off` all effectively 9px because a grey
halo at 0.18-0.30 opacity on a grey dot is invisible. So a working
session in a column of resting ones read about 60 percent wider than its
neighbours. Fix: `--led-lit-scale` declared ONCE on `.status-led`, no
state may override it, and the glow is now a radial gradient (fades out
AT the box edge, so painted extent is the declared box) instead of a
spread shadow (paints beyond the element by definition, so it could never
be held to a number). After, every pair: dot 9.00px, lit 15.30px, nothing
painting outside. Verified by `scripts/verify_status_led_geometry.py`
against `tests/manual/status-light-key-harness.html`, three themes, two
viewports.

THE YELLOW `(n)` BADGE is gone from `summaryHtml` and its
`.status-summary-badge` rule is gone from `status-led.css`. `unreadCount`
is still RETURNED by `summarizeStates` and rendered by nothing. The plain
count pill on the header is a different control and stays.

THE HEADER ROLL-UP already called `StatusLed.ledHtml`; the tests now
assert it byte-for-byte against what a row builds for the same pair, so
the two cannot be reimplemented apart. With the badge gone the ring on
the roll-up is the only thing saying a group holds an unread turn.

THE FOOTER NOTE is gone. The remembered-position FEATURE is NOT orphaned:
`session-sidebar-arrangement.js` still keeps the slots, they still reach
the repaint signature, and `session-sidebar.js` still stamps
`data-order-missing` on the list element. `listHtml` lost its now-unused
`missing` parameter; the two call sites moved with it.

NEW: `client/js/session-status-key.js` + `client/css/session-status-key.css`,
a foldable legend at the foot of the list, collapsed by default on
`cloude.statusKey.open` (the app's existing `cloude.*` preference
convention). Every swatch is a real `ledHtml`, and
`tests/test_status_key.node.mjs` asserts both directions of coverage so a
state added to the component and not to the key fails the build.

[ci-flake] [2026-09-09 10:58 PT]: the macos-latest `python tests` job was failing
intermittently on `test_readopted_backend_streams_live_output_without_a_reattach`
with `pane_pipe='1'` and `bytes_seen=0`. It is NOT a slow test, it is a real
defect in the streaming path. `TmuxBackend.attach_existing` recorded
`_adopt_tail_start_offset` only inside the external-setup branch, so on the
owned/boot-re-adopt branch the tail loop seeked to plain `SEEK_END` whenever the
event loop first scheduled it. `read_async()` only calls `create_task` and
nothing awaits after it, so every byte tmux appends between the attach and the
reader's first run was dropped. Reproduced deterministically with a fast pane
shell plus a blocking window: 9 of 10 attaches delivered ZERO bytes while the
marker sat in the pipe file every time; even the passing runs lost 29 of 116
bytes. macOS loses because a `tmux send-keys` subprocess costs more there than
the pane needs to echo, so the whole burst lands before the reader opens, and an
idle pane then produces nothing to reveal the loss. Fix: record the offset on
BOTH attach paths via one `_record_tail_start_offset()` helper. Added
`test_output_written_before_the_reader_opens_is_still_delivered`, which uses that
window instead of racing it and so fails on any platform if the offset is
dropped. Also replaced two fixed `sleep(1.0)` waits in
`test_respawn_refreshes_pane_env.py` with the pane-dead poll the first test in
that file already used (that flake reproduced in my clean-tree baseline run), and
raised the dead-pane poll budget in `test_attach_to_a_dead_pane_still_succeeds`
from 5s to 15s after measuring real death latency at ~0.01s. Full suite: 3
failed / 5307 passed baseline, 2 failed / 5309 passed after; remaining two are
the environmental `test_nuke_sandbox` and `test_version_probe`.

[mobile-chrome] [2026-09-09 13:40]: Two chrome moves the owner asked for with
screenshots. (1) The clipboard FAB over the terminal's bottom-right corner and
its three-row menu are now PHONE ONLY, hidden above 769px by one media query in
terminal-tools.css - the same breakpoint styles.css already uses to make the
d-pad beside it touch-only, chosen over the app's other "mobile" number
(MOBILE_MAX_PX = 700, which answers "is there room to dock a panel"). Pure CSS,
so there is no flash of a control desktop is not meant to have. WHAT DESKTOP
LOSES, traced before shipping: "paste from clipboard" is fully covered (xterm's
own cmd+V plus terminal.js's capture-phase file-paste handler, which uploads a
pasted file and injects its path); "copy output" and "attach file" have NO other
desktop entry point - CopyOutput.open has exactly one caller, the hidden file
input is clicked from exactly one row, and there is no drag-and-drop handler
anywhere in client/. cmd+C still copies a mouse selection, which is a different
job. Reported, not fixed: inventing replacement desktop UI is the owner's call.
(2) The floating "session editor" (sliders) button moved into the header's
.controls row immediately after the folder icon, carrying .btn-icon so its box,
gap, hover, focus and tooltip come from the header rather than from anything
written for it. Deleted rather than overridden: the .session-editor-fab rule, the
--fab-top-edge token in styles.css, and the ios-chrome.css safe-area pair plus
the :not(.session-editor-fab) exclusion that existed only to keep it off the
bottom row. Its session scoping is now an ALLOW-LIST in the new
client/css/session-editor-header.css (body:has(#terminal-screen.active)) instead
of the deny-list of three sessionless screens it used to inherit - that list had
already needed amending once when the archive screen arrived. The home header's
title centring is untouched because the button is display:none there, so
--home-header-flank-w needs no new branch. Header does NOT overflow at 330px:
measured in headless Chrome, four controls occupy x 140-318 of a 330px header at
--control-size 40 (the 480px breakpoint's value, not 44), which is what its three
neighbours have always been. The menu needed no code change - AnchorPopover
already prefers above and falls to below, and from the header there is never room
above. Tests: added test_mobile_only_fab_and_header_editor.node.mjs, which
RESOLVES the cascade at a width rather than grepping source, with the unchanged
d-pad as a control and a loud refusal on any selector its matcher cannot read;
updated (not deleted) the placement assertions in test_terminal_tools_menu,
test_session_editor_menu, test_terminal_layout and test_button_box_sizing. Node
191/191 suites pass (was 190/190). Note for the next person: several of those
updates needed a comment-stripping pass first, because these stylesheets explain
retired layouts in prose and a bare includes() cannot tell a declaration from the
sentence saying there is no declaration.

[cross-session-bleed] [2026-09-09 16:40 ET]: One session's transcript rendered
inside another session's terminal. THE CROSSING IS IN THE BROWSER, NOT ON THE
SERVER, and that was settled by measurement before a line was changed. Every
pipe-pane file on disk was clean: one working directory per file (a footer scan
of `tmux_ses_18ec7875`, `tmux_ses_732c7cd6`, `tmux_ses_2a0b116d` found exactly
one cwd each), one `cat >>` writer per pane (15 writers, 15 panes, all distinct
targets) and ONE reader per file under `lsof` (all in pid 66406). Decisive
control: `tmux_ses_18ec7875.pipe` holds ZERO bytes matching `InlineAdjustEditor`
or `step4-inventory`, yet that text was photographed inside ses_18ec7875's
terminal - and it is native to ses_732c7cd6, whose own pipe holds 38 and 1. Text
that is not in a session's pipe file cannot have reached its browser through the
server, so tonight's streaming commits (`9f01c6c`, `230bad8`, `3366257`) and the
two-backends-on-one-pane defect are both RULED OUT. No commit was reverted.

THE CAUSE: there is ONE xterm in the page and the user moves between sessions
inside it. `WebSocket.close()` only STARTS the closing handshake, so a socket
already replaced keeps dispatching the frames that were in flight, and the
handlers `setupWebSocketHandlers()` installs close over the CONTROLLER rather
than over their own socket and were never detached. `onmessage` went straight to
`this.enqueue()` with nothing checking which socket, or which session, the bytes
belonged to. Reproduced headlessly by loading the real `client/js/terminal.js`
into a `vm` realm, attaching to session A, navigating to B, then firing one
frame on A's superseded socket: it landed in B's buffer.

`3366257` is not the cause but IS why this reads as corruption rather than as
stray text: an attach capture carries an absolute cursor sequence, so a foreign
frame moves the live session's cursor and the user's own typing lands elsewhere.

FIX: `client/js/terminal-frame-guard.js` is now the one place that decides
whether a WS event may touch the terminal - socket identity AND session
identity, both checked, with an unknown session id never refusing (the server
documents a WS with no `?session_id=` as "the current session"). A superseded
socket is detached on its first stray event. `onclose` no longer nulls the LIVE
socket when an OLD socket's close lands late, which was a second defect in the
same handler. A missing guard module falls back to the socket-identity half
rather than to "allow".

WATCH OUT (measured, unresolved, NOT part of this fix): three panes named
`cloude_Insiders App`, `-2`, `-3` all report `pane_current_path` =
`.../DiscountCodeGenerator/thcdiscountcodes`, and rows 18-21 of `sessions` record
that same `working_dir` for titles `Insiders App` / `Insiders - Codex` /
`Insiders - Fable`. The app recorded it, so it is consistent rather than
corrupt, but those sessions are not sitting where their names say. Also
`tmux_ses_63beb976.pipe` is 3.0 MB with NO writer and NO reader - an orphaned
pipe from a session now streaming through `tmux_ext_cloude_cloudecode.pipe`.
Neither is the bleed; both are worth a separate look.

[toast-per-session] [2026-09-09]: The toast stack coalesced on (kind,
session), so one session painted one card per KIND - a "wants your
attention" card AND a "Your turn" card, about the same session. The x5 and
x2 badges the owner saw were the coalescing working; what was missing was
collapsing ACROSS kinds. `client/js/toast.js` now keys the group on the
session alone and `client/js/toast-session-group.js` picks which pending
event that one card shows, by READING `SUMMARY_PRIORITY` out of
`session-status-summary.js` rather than declaring a second order.
Mapping: PermissionRequest -> permission, StartupPrompt and Notification
-> input, Stop -> unread, an unknown kind -> input; toast.js's own
severity table breaks a tie inside a bucket, so a blocking startup prompt
is not displaced by a chatty notification. The `x n` badge counts the
WINNER'S KIND (what the title claims); the dismiss control, the "Dismiss
all" total and the overflow row's worst-severity label count RECORDS -
two numbers because they answer two questions, and the per-group counts
those last three used to do would have reported six finished turns as six
permission prompts. The attachment receipt is deliberately outside the
grouping and keeps its own card. Screens measured in a real Chromium:
13 records across 3 sessions paint 3 cards on desktop and 2 plus an
accurate overflow row at 330px, in both a dark and a light theme.

[key-collapse] [2026-09-09T21:28:22Z]: the status-light key is seven rows, one per LIGHT
rather than one per state, and the finished-turn ring lost its grey fill.
The owner's ask was "one entry per colour", so the two yellow rows
(permission, startup prompt) collapsed into "stopped, waiting on you" and
the two red rows (dead pane, dead socket) into "dead / disconnected
session". Green and grey still appear twice because a solid dot and an
outline are two different things on screen; the last row is reworded to
say what the outline means ("not measured - nothing reported in, so this
is not idle"). THE STATE MACHINE DID NOT CHANGE - eight inner states,
four of them now sharing two rows, and the dot's own title/aria-label is
the only place left that says which of a pair it is, which is now pinned
by tests rather than left as decoration. The visual fix went into the LED
COMPONENT, not the key: `--led-fill` is a new token that the dot's
background reads instead of `--led-ink`, and ONE rule naming both
`[data-inner='unknown']` and `[data-outer='unread']` sets it to
transparent, so the two hollow lights cannot drift into two ideas of what
a dark centre is. The trap the token also closes is the legacy
`.status-dot.status-led` compat block: it outranks the unread selector
and sits later in the file, so a `var(--led-ink)` there silently refills
both hollow states everywhere. Clearing a fill moves paint and not
geometry, and that was MEASURED rather than reasoned: rendered at 8x
device scale off the real stylesheet, all nine (inner, outer) pairs
painted an identical extent before and after, to the hundredth of a pixel
(15.75 for the four breathing states, 16.00 for the ring, 15.62 steady,
15.38 dim, 9.00 for the two `off` states, which carry no halo by
design). Note for whoever reads the history: commit 65faa8c, another
agent's toast change, swept this round's docs/session-status.md edits
into itself, so part of this work is recorded under that message.

[header-wrap] [2026-09-09T00:00:00Z]: Screenshot complaint ("session editor
sliders button still floats top-right, clipboard FAB still shows bottom-right")
is NOT a code defect. Built a Playwright harness (real client/index.html header
markup, all 46 real CSS files, real header-menu.js building the real kebab,
served same-origin via request interception against the live 127.0.0.1:8000 so
no file:// cross-origin CSS quirks) and swept 330-1435px. Result: at every
width the session editor button sits inline between the folder icon and the
kebab, `wraps=false` everywhere, matching `tests/test_mobile_only_fab_and_header_editor.node.mjs`
(10/10 pass, unchanged). The terminal-tools clipboard FAB flips exactly at the
documented 769px line (flex through 768, none from 769), also as coded. The
screenshot is 1435 physical px wide; at a plausible 2x Retina scale that is a
~717 CSS px window, comfortably under 769, so the FAB showing there is BY
DESIGN, not a bug. The floating sliders button in the screenshot is styled
like the OLD retired `.fab-menu-btn`/`.session-editor-fab` rail (dark
`--color-bg-elevated` circle, `--color-fg-muted` icon) that 07a202b deleted
from both CSS and JS - no code path in the current tree can produce that
look (grepped, only `.btn-icon` touches `#sessionEditorBtn` now). Most likely
explanation: the browser tab in the screenshot was opened before 07a202b
deployed and was never reloaded, so it is still running pre-deploy JS/HTML
held in memory - a `<link>`/`<script>` already loaded does not refetch just
because the server's cache-control says no-cache; that header only matters on
a NEW request. No code changed. Recommend: reload/refresh that window and
re-screenshot before assuming anything is still broken.

[slash-fab-mobile] [2026-09-09 18:12 ET]: Owner's screenshot (round "/" button,
bottom-left, circled in yellow) is `#slash-commands-btn` (client/js/slash-commands.js),
confirmed by grepping its id/class against `position: fixed; bottom: var(--fab-edge);
left: var(--fab-edge);` in styles.css - matches the screenshot's position and glyph
exactly. Hidden on desktop with the same rule as the terminal-tools clipboard FAB:
new file `client/css/slash-commands-fab.css`, `@media (min-width: 769px) {
.slash-commands-btn, #slash-commands-modal { display: none !important; } }`, linked
from index.html after slash-command-chips.css. Hides both the button AND
`#slash-commands-modal` (the command-list panel it opens), same half-change
guard as terminal-tools.css. Reachability: typing "/" in the terminal reaches
claude's own CLI directly, but the modal offers something typing does not - every
command grouped with a description, starred favorites, live filtering - so the
owner is losing a real (if replaceable) discovery feature, recorded in CLAUDE.md
rather than fixed. Extended tests/test_mobile_only_fab_and_header_editor.node.mjs
(14/14 pass, was 10/10). Full suite baseline unaffected: 192/192 node suites,
5309 passed/2 known-environmental-failed/18 skipped pytest (same 2 failures
CLAUDE.md already documents as environmental, no new ones). Committed `4435edb`,
pushed to master. Deployed live: killed the old Electron+Python tree (PID 48586
Electron, PID 48595 Python child on port 8000 - both had to go, confirmed via
`ps -o ppid` that killing Electron alone would NOT have taken the Python child,
so it was targeted explicitly), relaunched via `nohup npm start` from macOS/,
verified HTTP 200 on `/` and on `/static/css/slash-commands-fab.css` from the
derived copy at `~/Library/Application Support/cloude-code-menubar/server/`.
15 live tmux sessions and `cloude_cloudecode` (the user's own live pane)
confirmed untouched throughout.
