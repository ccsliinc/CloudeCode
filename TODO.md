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

[webui-performance-plan] [2026-09-09]: Saved the DAR-reviewed Web UI performance and session action menu plan to /Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/docs/webui-performance-and-session-menu-plan.md at the owner's request. Implementation remains pending; this task saved the plan only.

[webui-performance-plan] [2026-09-09]: Added the owner's requirement that all themes and durable app settings persist globally across computers and browsers to /Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/docs/webui-performance-and-session-menu-plan.md. Includes server authority, cross-client updates, explicit browser-preference migration, scoped override behavior, concurrent-write protection, and independent-browser validation. Focused DAR passed with its config-serialization and theme-consent clarifications incorporated. Documentation only; implementation remains pending.

[webui-performance-plan] [2026-09-09]: Added the reported SNES terminal palette reset on session re-entry to /Users/Adam/Dropbox/My Projects/Cloude Code Repos/Dev/cloudecode/docs/webui-performance-and-session-menu-plan.md. Read-only reproduction with the real registry/navigation code confirmed that applySession('claude') overwrites the restored SNES xterm palette while app chrome stays SNES. Planned a shared theme-resolution fix for both entry paths and initial terminal construction, with real xterm pixel checks covering re-entry, fallback, reset, and opacity. Focused correctness and validator-agent reviews passed for the plan. Documentation only; no application fix, deployment, or new browser-rendered validation performed.

## Web UI performance and session menu plan (2026-09-10)
Spec: docs/webui-performance-and-session-menu-plan.md. Deployment is OUTSIDE this
plan's authorization: agents commit and push, nobody restarts the app.

Already done before this plan started: concurrent listing (c8ef6a8), attachable
index (a4eff35), kqueue tail wakeup (2b1fcb9) which closes plan item 7's first
experiment.

### Wave 1 (parallel, file-fenced) - ALL FOUR LANDED
- [x] theme-restore: shipped in 6f79e90. One resolution, one writer
      (paintTerminalScope), pin and agent are two inputs. 15 node checks plus 8
      real-Chromium checks, both red on the pre-fix tree.
- [x] session-menu: shipped in 8898f07 plus 074b381, merged into ccsliinc's
      superset per docs/DECISIONS.md. Note double-click rename was RESTORED by
      the owner's ruling; the plan's bullet to remove it is overruled.
- [x] mute-backend: shipped in 46e7aca. Schema v26, unknown SUPPRESSES, both
      gates plus the drain-time policy generation check, 41 tests.
- [x] perf-harness: shipped in 67f3dc8. Baseline in
      docs/perf-baseline-2026-09-10.md.

Contract shared by session-menu and mute-backend, as shipped:
  PATCH /api/v1/sessions/records/{session_uuid}/notifications  body {"muted": bool}
  returns {"muted": bool, "policy_generation": int}
  SessionInfo wrapper gains `notifications_muted: bool` (absent reads as false).

### Everything remaining is now filed as GitHub issues

Filed 2026-09-10 on Adoom666/CloudeCodeDev after cross-referencing the plan
against the tree. Do not track remaining plan work here; the issues are the
spec and a draft PR is the claim. See .claude/skills/work/.

Live failure modes, take these first:
  #5  the pipe rotation never re-points the read fd, so a terminal goes silent
      after 24 hours or 10 MiB. p0.
  #6  CLAUDE.md never says the Cloude spelling is deliberate, and hides 22 of
      26 docs. p0.

Plan phases, parent issue then children:
  #7  phase 1 remainder      children #8 #9 #10 #16
  #17 phase 2 waits          children #20 #21 #24 #25 #26 #27 #28
  #29 phase 3 remainder      children #30 #31 #32
  #33 phase 4 events         children #34 #35 #36 #37 #38 #39 #40
  #41 phase 5 ui_preferences children #42 #43 #44 #45 #46
  #47 phase 6 startup        children #48 #49 #50 #51 #52 #53
  #54 phase 7 control-mode experiment, standalone. The kqueue half shipped in
      2b1fcb9 and is closed.

Loose ends:
  #55 toast.js is 1307 lines against a 1000-line guideline
  #56 the perf harness cannot measure settings open
  #57 document the local server subsystem as intentionally retained dead code
  #58 the sidebar and the home card disagree about renaming a detached session
  #59 two machine-local test failures and real-tmux flakes

Known overlaps with ccsliinc's open draft PRs, flagged in comments on each
affected issue and NOT resolved by either party: #11 / PR 23 deletes
client/js/launchpad.js at slice 7, which #35 #36 #50 #51 #58 all edit; #12 /
PR 19 restructures src/core/session_manager.py, which #31 #32 #37 all change;
#13 / PR 22 moves menu action availability onto a plugin registry, which
contradicts the approach in #36 and #58. Adam is the tie-breaker.

[mute-backend] [2026-09-10T04:35Z]: durable notification mute shipped server-side.
  Schema v25 -> v26 adds `sessions.notifications_muted` and
  `sessions.notification_policy_generation`, both nullable with NO default and NO
  backfill - the absence of a decision on a row IS "unmuted", so existing rows,
  new sessions and forks all start unmuted for free, and the mute survives a
  server restart and a `respawn-pane -k` because both keep the row.
  `src/core/session_notification_policy.py` is the in-memory projection every gate
  reads (hydrated once at boot in `src/main.py` BEFORE the router starts and before
  the app serves), with three values where `unknown` SUPPRESSES - deliberately the
  opposite posture from the sub-agent toast gate, because a failed read may not
  answer "not muted". Web alerts are gated in `claude_event_hook` immediately above
  the sub-agent gate (`toast_suppressed: notifications_muted`), covering every toast
  kind INCLUDING PermissionRequest; external pushes are gated twice in
  `NotificationRouter` (at emit so a muted session cannot evict other sessions'
  alerts from the bounded queue, and at drain where the policy GENERATION is
  checked, which is what stops an alert queued before a mute/unmute cycle from
  escaping after it). Muting acknowledges nothing: `record_hook_event` runs above
  the gate, so a muted PermissionRequest still leaves the session blocked and
  reporting `question`, and a muted Stop still flips unread.
  `PATCH /api/v1/sessions/records/{session_uuid}/notifications` takes
  `{"muted": bool}` plus an optional expected `(tmux_name, tmux_created_epoch)` and
  answers 409 rather than muting whatever holds a reused name now; it returns
  `{"muted", "policy_generation"}` read back from the row. `SessionInfo` gains
  `notifications_muted` on the WRAPPER (per the /sessions/list shape rule) and
  `SessionRecord` gains it plus the generation. 41 new tests in
  `tests/test_session_notification_mute.py`. Full suite: 5369 passed / 12 failed,
  the same 12 as the pre-change baseline (8 `test_session_row_controls_render` and
  2 `test_js_syntax_scan_coverage` belong to the concurrent client-side menu work;
  `test_nuke_sandbox` and `test_version_probe` are environmental). NOT DEPLOYED.

[theme-restore] 2026-09-10 00:20Z: A session pinned to snes lost its terminal
  palette on re-entry because the TERMINAL HAD TWO WRITERS. Reproduced at tip
  (`d407fa1`) against the shipped snes/claude manifests before touching any
  production code: picking snes gave xterm background `#3A3A40` / cyan
  `#3CC4B5`, and leaving plus returning gave `#1e1e1e` / `#11a8cd` while
  `<html data-theme>` still read `snes`. `theme-navigation.js` painted the
  session pin, then `app.js` called `Themes.applySession(agent_type)` and the
  agent's manifest won because it ran last. A second symptom was visible at
  the moment of the pick: the xterm palette was snes while
  `#terminal-screen[data-session-theme]` was still `claude`, so the palette
  and the CSS scope had disagreed all along.
  The pin and the agent are now two INPUTS to one resolution rather than two
  paints: `Themes.applySessionScope({pinnedTheme, agentType})` records both and
  `resolveTerminalThemeId()` ranks them (valid pin, then valid agent, then the
  global theme). `paintTerminalScope()` is the only writer of the terminal's
  CSS scope and its xterm palette, and it moves both together, so a var the
  outgoing theme owned is removed rather than orphaned. The page paint now
  passes `forXterm:false` inside a session, so there is no intermediate flash.
  `applyGlobal()` records an in-session pick as that session's pin and repaints
  through the same writer, which is what makes a picker change survive leaving
  and returning. `terminal.js` seeds a new xterm from
  `getActiveTerminalManifest()` rather than `getActiveGlobal()`: on first
  attach the terminal is built AFTER the paint, so the page's palette was
  being used to seed it. The replay gate now defers a BOOLEAN and re-resolves
  on drain instead of replaying a captured theme id, so a paint that waited out
  a replay cannot repaint a theme the user has since navigated away from.
  The agent fallback is unchanged: an unpinned session still wears its agent's
  theme, and a null or unknown agent still hands the terminal to the global
  theme. The background-opacity adapter remains the only opacity transform.
  Measured: `tests/test_terminal_theme_survives_agent.node.mjs` (15 checks
  against the real registry, navigation and app) goes 12-red on the pre-fix
  tree and green after; `tests/test_terminal_theme_survives_agent_renders.py`
  (8 checks in real Chromium against a real xterm canvas) goes 4-red pre-fix
  and green after, the decisive one rendering `(30, 30, 30)` where the snes
  manifest says `(58, 58, 64)`. Both pre-fix controls were run against a
  complete `git archive HEAD client` tree, because a first attempt that copied
  only four files silently dropped the opacity adapter and produced one
  failure that was an artifact of the harness rather than evidence.
  Node: 194 of 194 suites pass (baseline 192 of 192; one suite added here, one
  by concurrent work). NOT DEPLOYED.

[session-menu] 2026-09-10T09:55Z: Session action menu shipped. A live session row (sidebar and home card) now draws a vertical three-dot trigger where its close X was; the X is gone and `close session` is an item inside the menu. Pin stays inline. A DEAD row is untouched - inline restart and remove, no menu - and `SessionRowActions.offersMenu` is the single predicate deciding which of the two a status gets, so a row can never draw both or neither. Five items with shortcut letters: rename (R), fork session (F), new session in folder (N), mute/unmute notifications (M), close session (C) below a separator.
[session-menu] 2026-09-10T09:55Z: Double-click rename removed completely - the dblclick listener in session-sidebar.js, `deferActivation` and `onDblClick` in session-sidebar-rename.js, and the 250 ms hold in session-sidebar-clicks.js. That hold was the measured cost of the gesture and it was paid on EVERY click on a renameable row name. F2 and the home card's title pencil are untouched.
[session-menu] 2026-09-10T09:55Z: Identity is captured at PAINT time into the trigger's data attributes and read back once when the menu opens. Measured in a browser: the list can be rebuilt from a different payload under an open menu and the item still acts on the row that was clicked (tests/test_session_row_menu_renders.py::test_a_repaint_under_an_open_menu_cannot_redirect_an_action).
[session-menu] 2026-09-10T09:55Z: Mute uses PATCH /api/v1/sessions/records/{session_uuid}/notifications with {"muted": bool}, keyed on the durable record resolved from GET /sessions/records at ACTIVATION time - opening the menu still costs no request. The label is optimistic with a rollback on failure. `notifications_muted` is now carried through both live merges (session-sidebar-fetch.js and launchpad.js); an ABSENT field reads as not muted, which is the old-server case and the safe direction.
[session-menu] 2026-09-10T09:55Z: `project-list-render-guard.js` consults `SessionRowMenuOpen.isOpen()` again. The check was removed with the old kebab on 2026-09-08; without it a poll repaint under an open menu leaves the body-mounted panel anchored to a trigger that no longer exists.
[session-menu] 2026-09-10T09:55Z: MEASURED, and it changed the design - a refusal sentence on an unavailable item stretched the panel to 730px, because a grid track sizes to its content. Capped at min(320px, 100vw - 16px) so `white-space: normal` on the reason actually wraps. Screenshot evidence in the scratchpad, not the repo.
[session-menu] 2026-09-10T09:55Z: OPEN ITEM - `scripts/verify_sidebar_rename.py` still drives `page.dblclick` on a row name. It is a manual verify script, not collected by pytest, so nothing fails; it will simply no longer reproduce a rename. It should be moved to F2 or to the menu item.
[session-menu] 2026-09-10T09:55Z: OPEN ITEM - `SessionSidebarRows.renameState` gates on `session_id` (a live backend) while the home card's `_renameVerdict` accepts any tmux name. The two surfaces therefore disagree about whether a detached session can be renamed, and each surface's menu agrees with the control beside it rather than with the other surface. Pre-existing; the menu inherits it rather than causing it.
[perf-baseline] 2026-09-10T10:30Z: Measurement harness built for spec item 1 ("Establish measurements and fix interaction races") plus the Validation and delivery section. `scripts/perf/` boots an ISOLATED, real `src.main:app` on a throwaway tmux socket and free port (never the live `cloude` socket), drives it with a real Chromium via Playwright, and proves terminal echo through xterm's own `onRender` paint callback rather than a parser event - see `scripts/perf/perf_browser.py`'s module docstring for why that distinction is load-bearing. Every session it creates is `agent_type=shell` (no real `claude` binary, no LLM turns), which is what lets typing/switching/launch be measured deterministically and separately from agent-startup latency, per the plan's own requirement to measure those separately. `venv/bin/python3 scripts/perf/run_baseline.py --sessions 1,10,50` reproduces it end to end in one command; `--quick` collapses repetition counts for a fast run.
[perf-baseline] 2026-09-10T10:30Z: Baseline recorded to docs/perf-baseline-2026-09-10.md, raw samples in scripts/perf/perf-baseline-raw.json. Against the plan's four targets at N=1/10/50 (this run's numbers, captured under heavy concurrent machine load - see the doc's methodology note for why the absolute figures should be re-measured on an idle box before being used to judge a later phase): deterministic terminal echo (warm) FAILs at all three N (120.5/121.0/51.4 ms p95 against a 50 ms target); warm switch with unchanged geometry PASSes at N=1 (163.4 ms) and FAILs at N=10/50 (285.7/871.4 ms against 200 ms); menu-open FAILs at all three N (37.3/145.9/702.6 ms against one 60 Hz frame, 16.7 ms); local-hook-to-visible-toast is unmeasured at N=1/10 and FAILs at N=50 (140.8 ms against 100 ms). Idle CPU stayed under 3% and RSS under 105 MB at every N measured; a direct `SELECT COUNT(*) FROM sessions` against the isolated database stayed under 30 ms even under load.
[perf-baseline] 2026-09-10T10:30Z: OPEN ITEM - `settings open, cold/warm` reads unmeasured in every run: `#settingsBtn` was measured to still report "not visible" to a forced Playwright click immediately after the preceding UI interaction, even after adding an explicit visibility wait ahead of the click (the same fix resolved an equivalent failure on the notification-toast step). Needs its own investigation, tracked as P1 in the delivering agent's final report.
[perf-baseline] 2026-09-10T10:30Z: Smoke coverage added to the normal suite: tests/test_perf_stats.py (pure percentile math, no server, sub-second) and tests/test_perf_harness_smoke.py (boots the isolated server for real, skips by name when tmux or Playwright is unavailable, and proves one real keystroke reaches onRender). Both pass.

## Agent findings

[META] 2026-09-10T18:40Z: #6 - premises confirmed and both numbers had already moved. 214 files carry the "Cloude" spelling (issue said 213), and 23 of 27 files in `docs/` were unreachable from CLAUDE.md (issue said 22 of 26; `docs/LESSONS.md` had been added since it was filed). CLAUDE.md now opens with the spelling prohibition, above `## Stack`, naming the four things a rename actually breaks: the `tmux -L cloude` socket, the `cloude_*` session prefix, `cloude.db` plus `~/Library/Application Support/cloude-code-menubar/`, and the Electron bundle id `com.cloudecode.menubar`. A routing table for all 27 docs follows it, each with a one-line "read it when". No occurrence of `Cloude` was changed anywhere.

[META] 2026-09-10T18:40Z: #6 - the issue's open question ("should a test enforce the docs index") is answered yes and shipped as `tests/test_docs_index.py`, on the `tests/test_no_remote_assets.py` precedent it names. Two directions: a `docs/*.md` file missing from CLAUDE.md fails, and a CLAUDE.md reference to a `docs/*.md` that is gone fails. Negative control run both ways - an empty `docs/zz-negative-control.md` made it fail, removing it made it pass. Wildcard tokens are skipped, or the sentence describing the rule (`docs/*.md`) would fail the rule.

[META] 2026-09-10T18:40Z: #64 - PREMISE IS HISTORICAL, THE ACTION WAS ALREADY TAKEN, and the owner ruled the issue stays open. Verified with `gh workflow list --all`: `tests` (353508702), `secret scan` (353508699) and `release` (353508697) all read `disabled_manually`; `Claude Code Review` and `Claude Code` are still `active`. That matches the owner's own comment on the issue ("P25 - kill the CI") which also says, verbatim, "Not closing this issue. It stays open as the record that CI is off on purpose and as the place to note it coming back." NOT CLOSED, deliberately. No billing setting was touched and no workflow file was changed. What was missing was that the fact lived only in a GitHub comment, so it is now written into CLAUDE.md ("How we work here") and into `docs/ci.md`, with the three `gh workflow enable` commands to reverse it.

[META] 2026-09-10T18:40Z: #59 - BOTH MACHINE-DEPENDENT FAILURES ARE DIAGNOSED AND FIXED, neither by skipping and neither by weakening an assertion. This was the issue's own open question and it is the bit worth keeping. (1) `test_version_probe.py::test_current_version_empty_when_unresolvable`: `CLOUDE_APP_VERSION` is rung 1 of `src/core/version.py::resolve_version` and ignores the `root` argument entirely, and it is exported in the developer's shell as `0.8.1`, so the test failed locally with `assert '0.8.1' == ''` and passed in CI where nothing exports it. Cleared with `monkeypatch.delenv` for that one test, and a new test asserts the override outranks the directory so the rung has coverage instead of being a trap. (2) `test_nuke_sandbox.py::test_dry_run_deletes_nothing`: `nuke.sh` falls through to the `python3` on PATH, which on this box is the Xcode-bundled Python 3.9 (`sys.prefix` under `/Applications/Xcode.app/...`); its framework is inside a read-only bundle, so CPython redirects bytecode caching to `$HOME/Library/Caches/com.apple.python/<mirrored path>`, and HOME is the sandbox. The dry run deleted nothing and still grew the manifest by 49 directories. Fixed with `PYTHONDONTWRITEBYTECODE=1` in the sandbox env, which suppresses only `.pyc` writing, so anything `nuke.sh` itself creates in HOME is still measured.

[META] 2026-09-10T18:40Z: #59 - CLAUDE.md's stated baseline was stale in the way the issue said. It named `test_home_write_guard.py::test_guard_refuses_the_real_claude_settings_path_by_name` as failing; measured today it PASSES, and the real pair was nuke_sandbox plus version_probe. Confirmed by running all four candidate files together: 2 failed, 46 passed, and the two that failed were not the two CLAUDE.md named.

[META] 2026-09-10T18:40Z: #59 - `real_tmux` marker added, registered in `pytest.ini` and APPLIED AUTOMATICALLY by `tests/conftest.py::pytest_collection_modifyitems`. 115 of 5776 collected tests carry it; `-m real_tmux` selects 115, `-m "not real_tmux"` deselects exactly those 115. It is derived from two signals a real-tmux test cannot avoid (its module imported `tests/socket_guard.py`, or it requested the `tmux_test_socket` fixture) rather than from a hand-maintained file list, which would be wrong the first time somebody added a test without knowing the list existed. It deliberately over-includes: marking a fast test costs a little coverage in a loop that was never a full verification, while missing one puts a load-sensitive flake back into the fast loop. NO SKIP, NO TIMEOUT CHANGE, NO ASSERTION TOUCHED - a plain `pytest` run collects and runs exactly what it did before. No timeout was raised anywhere; the issue's warning that a timeout long enough never to flake is also long enough to hide a real hang is the reason.

[META] 2026-09-10T18:40Z: #57 - all premises verified against the tree and one of them corrected. The tracker is fully wired (`src/main.py:537-539` construct/attach/start, `:776-777` stop, `src/api/routes.py:2614` the route, `:963` a clear on session destroy) and has no client consumer: grepping `client/` finds only the three cautionary comments about `#localServersContainer` plus one unrelated CSS accent comment. The four hardcoded-empty sites are confirmed at `session_manager.py:4845` and `:5167` and `routes.py:1459` and `:1461`. CORRECTION TO THE ISSUE'S STATED COST: it says the janitor "runs a periodic janitor probing ports on every session forever". It does not. `_janitor_loop` re-probes only ports ALREADY TRACKED, state is in-memory and starts empty every boot, and a port is tracked only after a pane actually prints one, so on a box where nothing printed a port the cost is one wakeup every 30 seconds and zero probes. That is in the CLAUDE.md paragraph so the owner can judge the keep-or-drop question with the real number. No code changed.

[META] 2026-09-10T18:40Z: #56 - ROOT CAUSE FOUND AND IT IS NOT A RACE AND NOT AN APPLICATION DEFECT, so nothing is filed against the app. `#settingsBtn` is not in the header row: `client/js/header-menu.js` re-parents it (with `logoutBtn`) into `#header-menu-panel` in `_fold()`, `applyLayout()` calls `_fold()` UNCONDITIONALLY at every width ("an overflow, not a responsive fold any more", its own module docstring), and the panel is built with `panel.hidden = true`. So the button genuinely has no box until the kebab is opened, for Playwright and for a human alike. That is why `wait_for_selector(state="visible")` did not help, why `force=True` could not (force bypasses hit-testing, not "has no box at all"), and why it failed in EVERY run rather than intermittently. The harness step was measuring an interaction nobody can perform. `run_baseline.py` now clicks `#header-menu-toggle` first, OUTSIDE the timed callback, because `measure_visible_box` stamps t0 then runs the action and billing the menu's own animation to "settings open" would stop the number being about settings. No forced click was introduced. `perf_browser.click_tolerant`'s docstring, which cited this as a timing gap, is corrected in the same change, with the general lesson: this helper turning "I could not click that" into a silent pass is what let a WRONG SELECTOR look like a slow one for a whole baseline, so when a step reports no measurement at all, suspect the selector before the clock.

[META] 2026-09-10T21:10Z: #56 - MEASURED, TWICE, AND THE GAP IS CLOSED. `settings open` read `n/a / n=0` in every column of the 2026-09-10 baseline; after the fix, two consecutive N=1 --quick runs on a box at load average 19-28 both produced real numbers for both cells (run A cold 38.6 ms / warm 157.1 ms, run B cold 81.4 ms / warm 41.9 ms) and neither logged a `settings_open_*` step failure. Repetition mattered: the original failure happened in EVERY run, so one success would have proved nothing, and two further harness defects only appeared on the SECOND pass. The overflow open has to be IDEMPOTENT (the toggle toggles, and header-menu.js collapses the panel when a control inside it is clicked, so an unconditional click can shut the menu instead of opening it) and it has to key on `#settingsBtn` rather than on the panel; and `_close_settings` has to WAIT for `#settings-panel-body` to actually be hidden, because the modal overlay sits over the header and a re-open while it is still on screen clicks the overlay. The spread between the two runs is machine load, which is why those figures are recorded as proof the step measures and NOT written into the baseline table. OPEN ITEM: a clean 1/10/50 non-quick baseline on an IDLE box is still owed. docs/perf-baseline-2026-09-10.md says so rather than carrying load-inflated numbers, which is the defect that document's own methodology note already warns about.
