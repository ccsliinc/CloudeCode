# The terminal client: navigation generation, input ownership, the connect, search and the two menus

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

## The two session-scoped menus, and where each one lives

They are split by JOB and the rule is learnable: one moves content across
the terminal's boundary, the other configures the session. They share
their plumbing (`client/js/fab-menu.js` builds the dropdown,
`client/js/anchor-popover.js` places it) and nothing else.

| Control | Rows | Surface |
|---|---|---|
| `#terminalToolsBtn` | copy output, paste from clipboard, attach file, search | floating button, bottom row slot 0, **phone only** |
| `#sessionEditorBtn` | session theme, detach session | a button in the header's `.controls` row, beside the file editor |
| `#slash-commands-btn` | opens `#slash-commands-modal`: every slash command, grouped, with a description and a starred-favorites row, live-filterable | floating button, bottom-left corner, **phone only** |

**THE TOOLS BUTTON IS MOBILE ONLY, ON THE D-PAD'S BREAKPOINT.** One media
query in `terminal-tools.css` hides the trigger AND its menu above 769px,
which is the same line `styles.css` already uses to make
`.dpad-float-button` touch-only. They sit in the same row, and two
controls in one row that vanish at two different widths is how that row
ends up with a hole at some third width nobody tested. The app's OTHER
"mobile" number, `MOBILE_MAX_PX = 700` in `session-sidebar-pin.js` and
`config-drawer-pin.js`, answers a different question - is there room to
dock a panel - and is deliberately not reused. It is pure CSS because a
JS width check paints the button on the first frame and removes it once
the script runs.

**AND DESKTOP LOSES TWO OF THE THREE ROWS, WHICH IS RECORDED RATHER THAN
PAPERED OVER.** Traced before the change shipped: `paste from clipboard`
is fully covered on a desktop (xterm's own cmd+V, plus the capture-phase
handler in `terminal.js` that uploads a pasted FILE and injects its path).
`copy output` - the whole-scrollback sheet - and `attach file` - the file
picker - have NO other desktop entry point: `CopyOutput.open` has exactly
one caller and the hidden `#cloude-image-attach-input` is clicked from
exactly one row, and there is no drag-and-drop handler anywhere in
`client/`. cmd+C still copies a mouse selection, which is a different
job. Adding replacement desktop UI is a separate decision.

**THE SESSION EDITOR IS A HEADER BUTTON, AND THE TOP-RIGHT RAIL IS GONE.**
It was a 45px FAB pinned over the terminal's top-right corner until the
owner asked for it "up into the menu next to the folder one". The move is
a MOVE: it carries `.btn-icon`, the class `#configEditorBtn` and the
kebab carry, so its size, gap, hover, focus and tooltip come from the
header rather than from anything written for it. `.session-editor-fab`,
the `--fab-top-edge` token and its `ios-chrome.css` safe-area pair were
all DELETED, not overridden - an orphan token is how a retired layout
gets revived by accident.

**SCOPE IS THE ONE THING THAT MOVE COULD LOSE, AND IT IS AN ALLOW-LIST
NOW.** `.controls` mounts on every screen, including the launchpad and
the archive where "session theme" and "detach session" name nothing. The
floating version got its scoping from a DENY-LIST in
`terminal-tools.css` naming the three sessionless screens, and that list
had already had to be amended once - when the archive screen arrived and
the FAB painted a 45x22px overlap across its Export label.
`client/css/session-editor-header.css` names the ONE screen instead
(`body:has(#terminal-screen.active)`), so a fourth sessionless screen
cannot leak it. That file declares `display` and nothing else; a colour
in it would be a header button restyled somewhere the header cannot see.

**THE HOME HEADER'S CENTRING SURVIVED BECAUSE THE BUTTON IS HIDDEN
THERE.** `.header--home` centres the launcher title against
`--home-header-flank-w`, a token mirroring `.controls`' real width, and
`header-menu.js` is explicit that a third INLINE control is a layout fact
rather than a list entry. This one is `display: none` on the home screen,
so the token needs no new branch. Change that gate and you have to
revisit the token. Measured in headless Chrome at 330px: the four header
controls occupy x 140-318 of a 330px header at `--control-size` 40 - the
480px breakpoint's value, not the 768px one - with no overflow, and the
title elides into what is left.

`tests/test_mobile_only_fab_and_header_editor.node.mjs` RESOLVES the
cascade at a given width rather than grepping the source, so it answers
"is the button on screen at 330px" instead of "does the file contain this
string". It carries a control (the d-pad, unchanged) and refuses loudly
on any selector its small matcher cannot read.

**A THIRD FLOATING CONTROL FOLLOWED THE SAME RULE: `#slash-commands-btn`,
THE ROUND "/" BUTTON, BOTTOM-LEFT.** The owner's request, verbatim: "this
button needs to be removed on desktop view just like the clipboard one."
`client/css/slash-commands-fab.css` is the same one media query, same
769px line, hiding the button AND `#slash-commands-modal` - the panel it
opens - so a hidden trigger never leaves a still-reachable panel behind.
It is its own small file rather than an addition to `styles.css` (already
over this project's line-count guideline) or to
`slash-command-chips.css` (styles the favourites row INSIDE the modal,
not the modal or its trigger).

**DESKTOP LOSES SOMETHING REAL HERE, NOT NOTHING.** Typing `/` straight
into the terminal still reaches claude's own CLI, which is a genuine
slash-command entry point - but it is not the same feature. The modal
this button opens lists every available command GROUPED, each with a
short description, plus the user's starred favourites and live filtering
as they type; typing `/` in the terminal gives none of that on its own.
Hiding it was the explicit ask, so it is hidden regardless - this is
recorded so the gap is a known decision rather than a surprise.

`tests/test_mobile_only_fab_and_header_editor.node.mjs` proves the
button's own visibility the same way it proves the tools FAB's, by
resolving the cascade. It CANNOT do that for `#slash-commands-modal`
through the same element-matching path: modelling the modal with its
real classes (`modal`, `active`) trips the resolver's selector grammar on
unrelated descendant-combinator rules in `styles.css` (`.modal
.modal-overlay`, `.slash-commands-modal-content .modal-header`) purely
because "modal" is a common substring, not because anything is wrong. So
that one assertion reads the flattened CSS text directly instead - the
same style `tests/test_terminal_tools_menu.node.mjs` already uses for the
tools FAB's menu - and confirms the `#slash-commands-modal` rule exists
exactly once, sits inside a `(min-width: 769px)` block, and carries
`display: none !important`.

## Terminal search, and why the rail reads the buffer, not the transcript

**FOUR CHORDS, AND ONE OF THEM WAS REFUSED.** Cmd+F / Ctrl+F opens the
panel (or refocuses it if already open), Cmd+G / Ctrl+G jumps to the next
match with Shift for the previous one, and Escape closes it. Ctrl+S was
the obvious pick for "search" and it is REFUSED outright: it is already
claude's own `chat:stash` chord, and inside a plain shell it is XOFF,
which freezes the terminal's output until Ctrl+Q unfreezes it. Ctrl+F
opens ONLY on the normal buffer, never the alternate one, because Ctrl+F
is page-down in vim and in `less`; Ctrl+G is bound ONLY while the panel is
already open, because the rest of the time it is readline's own abort
keystroke. `web/src/lib/terminal-search/search-keys.ts` is the ladder
that resolves all of this from a raw keydown.

**THE PROMPT RAIL READS BUFFER CELLS, NEVER THE TRANSCRIPT, BECAUSE THE
TWO DO NOT LINE UP ONE TO ONE.** `client/js/terminal-prompt-scan.js`
detects a submitted prompt by its CELL SIGNATURE - claude's own caret,
U+276F, sitting in column 0 over palette background 237 with palette
foreground 239, with any wrapped continuation row carrying that same
background and no caret - and never by reading text, because claude
prints that same caret glyph in other chrome and a user's markdown `>`
quote is not a prompt. A resumed conversation replays turns the buffer
never held, a repaint redraws a prompt that is already on screen, and the
buffer is trimmed at 50000 lines while the transcript is not - so a rail
tick built from the transcript can point at a row that does not exist in
this buffer. Measured on one live pane: **65 prompts on screen against 40
typed prompts in the transcript**, the gap made of exactly those repaints
and replays. The rail folds an adjacent repainted duplicate into one tick
and skips a bash-mode `!` row outright, because that is claude's shell
passthrough rather than a prompt.

**A HISTORY LOAD ONTO A LIVE BUFFER MUST SEND `ESC[3J`, NOT JUST
`ESC[2J`.** `ESC[2J` erases only the visible viewport; the saved
scrollback lines survive it, so a history paint that used only `ESC[2J`
would leave the OLD scrollback sitting behind the newly painted one and
every prompt tick and every search hit would double.
`TerminalScrollbackPaint.paint(shim, b64, 'history', {clearScrollback:
true})` is the switch that prefixes `ESC[3J` (erase the SAVED lines) ahead
of the usual reset, and `client/js/terminal-history-load.js` is its only
caller for this path. The load goes through that paint module directly
and NEVER through `terminal-write-queue.js`'s bounded 4 MiB path: a queue
shed under pressure writes its drop marker into what is about to become
permanent scrollback, which is a worse defect than a slow load. The
rejoin capture that runs on reconnect now carries a cursor restore too
(`src/core/scrollback_replay.py::with_cursor_restore`), while the startup
gate's own tail probe deliberately does not, because that would add one
more `tmux capture-pane` call to a probe that already runs on every
session on every 5 second listing poll.

**A HARD-WRAPPED TOKEN CAN BEAT THE SEARCH ADD-ON AND STILL HIT THE
RAIL.** The vendored `client/vendor/xterm/xterm-addon-search.js` rejoins
`isWrapped` rows before matching, so a term claude's own renderer split
across a hard wrap will not match as one string in the search panel. The
prompt rail is unaffected by that limit, because it folds a prompt's own
continuation rows itself rather than asking the search add-on to do it.

**THE HEADER BUTTON AND THE TOOLS-MENU ROW ARE EXACT COMPLEMENTS AT
769px, NOT A DUPLICATE.** `#terminalSearchBtn` in the header is
desktop-only; the `search` row inside `#terminalToolsBtn`'s menu is
phone-only; there is no width at which both or neither is reachable. A
FIFTH always-on header control was rejected for the same reason the
existing four are capped at `--control-size` 40 at 330px: it would push
the session title under its own readable floor. Cmd+F and Ctrl+F work at
every width regardless of which button is on screen.

**A SILENT BASH 3.2 NO-OP, FIXED.** `scripts/xterm-vendor/fetch.sh` used
`declare -A` associative arrays to record what it had downloaded and
verified. macOS ships bash 3.2, where `declare -A` is not a hard error -
the script kept running, printed a pass, and had downloaded and verified
NOTHING. Fixed 2026-09-12 with a plain newline-delimited list and an
explicit count guard, which needs no bash 4 feature at all.

**"DEEP DIVE" HANDS A HIT TO THE ARCHIVE, AND THE BUTTON IS HIDDEN WHEN
THE ARCHIVE CANNOT ANSWER IT.** `client/js/terminal-search-deep-dive.js`
builds `/archive/p/<id>?q=<term>` through `ArchiveDeeplink.build` and
navigates with `App.showArchive`, the same route a manual archive visit
uses. The project id comes from `GET /api/v1/archive/projects/for-cwd`,
which lives entirely INSIDE the `MESSAGE_ARCHIVE.enabled` guard and 404s
when the archive is switched off - so the deep-dive control checks for
that and hides itself rather than linking to a page that would 404.

**THE TOOLS MENU'S FOUR ROWS ARE PINNED BY NAME, NOT BY COUNT.**
`tests/test_terminal_tools_menu.node.mjs` asserts its `ENTRY_IDS`
(`toolCopyOutput`, `toolPasteClipboard`, `toolAttachImage`, `toolSearch`)
against the real rendered menu with `assert.deepEqual`, so a row added,
removed or reordered fails by naming which one moved rather than by a
bare count mismatch.

## One navigation generation, and what a completion is allowed to write

**A COMPLETION MAY ONLY WRITE TO SHARED UI STATE WHILE ITS NAVIGATION IS
CURRENT.** `client/js/navigation-generation.js` is the whole mechanism: a
monotonic counter, `begin(target)` / `current()` / `isCurrent(token)` /
`keep(token, what)`, no dependencies, loaded first in `index.html`. Every
entry path captures a token SYNCHRONOUSLY at the user gesture, before its
first await, and checks it immediately before the write it cannot take
back. A stale token DISCARDS, silently, with a debug log - never a retry,
never an error, and never `Router.rejectTarget()`'s banner, which means
"this URL names nothing" and not "you went somewhere else".

**A COUNTER, NOT A TARGET IDENTITY.** Click a session, click away, click
back: comparing session ids lets the FIRST click's in-flight work satisfy
the third, and the screen it would paint into was torn down in between.
`tests/test_navigation_generation.node.mjs` drives that exact sequence
against the shipped sidebar module.

**THE ENTRY PATHS ARE PROVABLY ALL OF THEM, because two functions are the
choke point.** `TerminalController.connectToSession` and
`reconnectToExistingSession` have EXACTLY ONE caller each -
`App.showTerminal` and `App.returnToExistingTerminal` - so the complete
set of ways into a session is the callers of those two plus the screen
changes that leave one. Six declare an intent: the conversation sidebar's
`activateRow`, the launcher's `_returnToActiveRunningSession`, the five
launchpad gestures that dispatch `session-created`
(`_handleAttachRunningSession`, `createConsoleSession`,
`_createNewSessionInner`, `connectToExistingSession`, `selectProject`),
`SessionRestartReturn.reopen`, `ToastNavigate.go`, and the router's
`deliverTargetToLaunchpad`. `App.showLaunchpad` and `App.showAuth` begin
one too, because LEAVING a session is a navigation and is the half that
is easy to forget - but ONLY when `currentScreen` is already set. A BOOT
PAINT IS NOT A NAVIGATION: `Router.init()` runs while `App.init()` is
still awaiting `verifyToken()`, so on a cold load of `/session/<name>`
the router has already declared the deep link's intent and
`openProjectByName` is already resolving it by the time App paints the
launcher, and an unconditional bump there would supersede the very target
the user typed.

**THE TWO `App` ENTRIES READ THE GENERATION AND NEVER BEGIN ONE, and the
asymmetry is the design.** Bumping the counter inside `showTerminal`
would let a caller that ALREADY lost the race mint itself a fresh win a
few awaits later. The five `session-created` dispatchers carry their
token in `detail.nav` and `app.js`'s ONE listener is the only thing that
checks it, so a seventh dispatcher cannot invent a different rule; a
dispatcher carrying no token falls through to `showTerminal`'s own read,
which is exactly the pre-existing behaviour.

**NOT ON A SYNCHRONOUS PATH.** A check between a gesture and a write with
no await between them costs a comparison, buys nothing, and tells the next
reader there was a race where there was none. That is why
`ThemeNavigation.applyForTarget()` takes no token: it is synchronous, and
the staleness it could suffer is its CALLER's, guarded at the top of
`showTerminal` / `returnToExistingTerminal`. The themes registry's own
replay gate (`6f79e90`) is untouched and deliberately re-resolves on drain
rather than replaying a captured id.

**THE TERMINAL RECORDS THE TOKEN IT BOUND UNDER**, as `_navToken`, and
`_navCurrent(what)` is the one predicate every deferred action in that
file asks. It gates the connect on both entry paths through
`_connectWhenReady` - a session switch landing before the socket opens
must not let the older connect open one the newer then has to abandon
mid-handshake - and it is the definition of "old" for the write queue and
the reconnect scheduler below. A missing module answers TRUE: the token is
a correctness guard, never a dependency, and a load-order accident must
not stop the terminal working.

**AND THE INPUT DIRECTION IS THE SAME RULE, ONE LAYER DOWN.**
`bd9a2b2` and `terminal-frame-guard.js` keep one session's OUTPUT out of
another's terminal. `client/js/terminal-input-ownership.js` is the INPUT
half, which is worse: output in the wrong pane is confusing, input in the
wrong pane RUNS A COMMAND. The unambiguous case was the file paste -
`terminal.js` intercepts it, uploads the blob and inserts the returned
absolute path, and nothing between those two checked the user was still
where they started, so an upload finishing after a switch inserted a path
into a DIFFERENT agent's prompt.

**CLAIM AT THE GESTURE, CHECK AT THE WRITE**, and that is the half that
is easy to get backwards. `claim()` taken at COMPLETION time reads
exactly like a check and is a no-op, because by then the session HAS
changed and the value compared is itself - the same shape as the
`ensure_pipe_pane` guard whose only exercised caller set the flag it
checked. Five paths take a ticket, and every one has an await, a network
round trip, or an open panel between the gesture and the write: the
desktop paste interceptor, the attach-file picker's `change` handler,
`pasteFromClipboard`, the paste fallback SHEET (it stands on screen while
the user finds their clipboard) and the slash commands MODAL (nothing
closes it on a session switch, so a pick made after one used to run in the
pane the user left).

**THE KEYBOARD, THE SHIFT+ENTER CHORD, THE D-PAD AND `_writeSynthetic`
TAKE NONE, deliberately.** There is no await between the key and
`ws.send`, and the socket is swapped synchronously by the session entry
paths, so the socket held at the write IS the session's. The copy sheet
takes none either and that was MEASURED rather than assumed: `CopyOutput`
reads the xterm buffer and writes the SYSTEM clipboard, and never writes
into the terminal at all. `tests/test_input_ownership.node.mjs` pins both
absences, so a later decorative check has to argue with a test.

**A STALE TICKET DROPS AND SAYS SO.** It never queues and never replays -
the user meant that paste for the session they were in, and delivering it
later out of context is not better than dropping it. The report goes
through `Terminal#_showStatusPill`, which routes to `FabMenu.notify`, the
app's single status-pill path; a seventh toast shape would be the bug.
`Terminal#insertText(text, ticket)` is the ONE write point for every
text-shaped path and is the last line of defence, and `injectText` checks
the ticket BEFORE its "clipboard is empty" and "terminal not connected"
reports, because those would be misleading answers to "why did my paste
vanish". A dropped upload also raises no attachment card.

**AND THE WRITE QUEUE IS BOUNDED AND IS RELEASED ON A SWITCH.**
`Terminal#enqueue` pushed every incoming chunk with no size or count
limit, and `flush()` re-scheduled itself while the queue had anything in
it - so bytes that arrived for the OLD session were still being written
after navigation began, and the `term.reset()` that followed raced a write
xterm had already accepted. That is the half-cleared screen showing the
previous session's tail. `client/js/terminal-write-queue.js` is the
policy; terminal.js keeps the queue.

**THE TWO HALVES OF THE QUEUE ARE DIFFERENT THINGS, and the teardown turns
on that.** Bytes still in `this.queue` are OURS - nobody has seen them and
they belong to the outgoing session - so they are discardable. Bytes
already handed to `term.write()` belong to XTERM, and resetting under an
accepted write is undefined. So `_releaseQueueForSwitch()` is two steps in
one order: discard what is ours, then AWAIT the in-flight write's own
callback, and only then reset. NO TIMER - guessing when a write finished
is how you reset under one anyway, and if the callback never arrives the
terminal is being torn down regardless. It runs only when the reconnect
buffer's plan is not `keep`, because a `keep` is the SAME session and its
bytes are still its own. `_writeInFlight` is cleared in exactly ONE place,
inside that callback, and a test counts it: a second clear would let a
switch wait forever on a resolver nobody calls.

**A BYTE BUDGET, NOT A CHUNK COUNT**, because chunk sizes vary by four
orders of magnitude between a keystroke echo and a `cat` of a large file.
`MAX_QUEUED_BYTES` is 4 MiB, the SAME number the server-side viewer queues
use - one number in the system beats two separately tuned ones - and the
point of the bound is to make the worst case FINITE, not fast.
`MARKER_RESERVE` (128 bytes) is held back so the drop marker itself fits
INSIDE the ceiling; without it the queue lands a marker's worth over on
every shed, and a bound that does not hold is a number nobody can reason
from.

**DROP FROM THE FRONT, WHOLE CHUNKS, AND SAY SO.** The newest output is
what the user is looking at, so shedding the tail would throw away the
very thing the pressure is producing. Whole chunks because slicing to hit
the budget exactly would cut an escape sequence in half, which does not
corrupt one cell - it puts the VT parser into a state that garbles
everything after. Whole chunks are not a guarantee of alignment either
(one sequence can straddle two frames), which is exactly why the drop is
ANNOUNCED: a terminal that silently loses ANSI bytes lies, and that is
worse than a slow one. `_queuedBytes` is a running total rather than a
re-sum, so admission is O(1) per chunk instead of growing precisely when
the queue is longest. The scrollback follow decision is still sampled
BEFORE the write, where `terminal-scroll.js` put it, and a test pins that
it did not move.

**AND THE AUTO-RECONNECT LADDER NEVER RECONNECTED, WHICH WAS MEASURED
BEFORE ANYTHING WAS CHANGED.** `attemptReconnect()` set
`isReconnecting = true`, charged the budget and scheduled
`connectWebSocket()`, whose first line was
`if (this.isReconnecting) { this.stopReconnecting(); return; }` - so the
retry it had just fired hit that guard, RETURNED without opening a socket,
and `stopReconnecting()` put the budget back to zero on its way out.
Driven against the shipped class: one timer, ZERO sockets, budget 0, and
the user saw `reconnecting, attempt 1 of 5` then silence, not even the
failure message, because `attemptReconnect()` was never re-entered.
Present since the initial commit (`a82cb57`). It is why the 4404 and
outage recoveries were bolted on beside the general mechanism: they call
`reconnectToExistingSession` directly and never went through it. Full
model in `docs/reconnect.md`; the rules are in
`client/js/terminal-reconnect-policy.js`.

**TWO QUESTIONS, TWO COUNTERS, ONE WRITER EACH.** `reconnectAttempts` was
zeroed in five places and compared in one, and any reset on a path that
also schedules a retry makes the ceiling unreachable - `stopReconnecting()`
is called from the exhaustion branch ITSELF, so five failures printed the
message and handed out five more attempts, forever. It is the BUDGET now
and `_resetRetryBudget()` is the only thing that zeroes it, for two named
reasons: initialization success, and a different session being bound
(which is not a reset of one counter but the start of another's - a fresh
session must not inherit an exhausted budget). `_attemptsSinceProgress` is
the BACKOFF and every attempt moves it; one counter for both forced a
choice between a budget that never fills and a delay that never grows.

**THE BUDGET IS SPENT ONLY BY A MEASURED FAILURE**, the socket never
opening. An UNKNOWN outcome costs nothing and neither does a pane measured
`awaiting_startup_prompt`: not having measured a success is not evidence
of failure, and charging for one gets a healthy session on a slow machine
declared unreachable. Same asymmetry as `resolve_startup_gate` rung 5
versus rung 7. The cost, stated rather than hidden: a server that accepts
and immediately closes is retried forever - but the backoff still reaches
its 16s ceiling, so it is a slow poll and not a spin, and declaring a
healthy session dead is the worse failure.

**INITIALIZATION SUCCESS IS THE FIRST BYTES.** The socket opening, the
dimension handshake completing and the pane sending something are three
different facts and only the third proves the session is talking - a pane
on its folder-trust dialog opens a perfectly good socket and says nothing.
The outcome reuses the server's `ready` / `awaiting_startup_prompt` /
`unknown` vocabulary rather than inventing a fourth spelling, and `ready`
still claims only "not blocked on a startup prompt", never "healthy". The
unreachable message is said ONCE and stays said; `_unreachableReported`
clears on the same evidence that refills the budget.

**FOUR NAMED BRANCHES, ONE SCHEDULER.** `_scheduleRecovery(closeCode)`
replaces three guard clauses that sat in front of a mechanism none of them
ever reached: `refresh_auth` (4401), `re_resolve_by_name` (4404, once per
episode), `wait_for_server` (an abnormal close `ServerRestartWatch`
recognises) and `retry_same_id`. And a reconnect carries the navigation
token: sixteen seconds is ample time to move to another session, so a
retry stands down rather than opening a socket nobody is looking at.
`terminal-reconnect-policy.js` is a REAL DEPENDENCY of terminal.js - a
sandbox without it takes the plain retry for every close, which is how
`tests/test_restart_reconnect.node.mjs` started failing on a harness gap
rather than a code change.

## The connect is measured, not slept, and the pane says when it can hear

Four things sat between a click and a usable terminal, and every one of
them was a guess about time rather than a reading of a condition.

**THE 500 ms BEFORE THE CONNECT WAS WAITING FOR A CSS TRANSITION THAT
DOES NOT EXIST.** Two unconditional half-second timers scheduled
`connectWebSocket()`, one on each entry path, and the comment above one
of them justified it verbatim as giving "the terminal screen transition
time to settle". There is no such transition. `.screen` swaps on
`display: none` / `display: flex` (`client/css/styles.css`), and
`display` is not an animatable property, so the class toggle fires no
`transitionend` on `#terminal-screen`, on any ancestor or on any
descendant. Every rule in all 49 stylesheets whose selector can match
`.screen`, `#terminal-screen`, `.terminal-container` or `#terminal` was
resolved before this was changed and NONE declares a `transition` or an
`animation`; the two `body.session-sidebar-pinned .screen` /
`body.config-drawer-docked .screen` padding rules carry comments saying
their transitions were deliberately removed so the geometry lands in the
same frame the class toggles. **A `transitionend`-based readiness gate
would therefore have waited forever on an event that cannot fire**, which
is gotcha 9 wearing a different hat, and it was the obvious design.

Nothing server-side needed the delay either: `_register_session` writes
`sessions[id]` before both the create and the adopt responses are built,
so a client can never hold an id the WebSocket route's 4404 check cannot
find, and `pipe-pane` is started inside `TmuxBackend.start()` before that
same response returns, so an earlier attach cannot miss pane output.

**WHAT IS REAL IS THE MEASUREMENT, AND IT IS NOW ASKED FOR.** The fit
sequence was `guardedFit`, sleep 50 ms, `guardedFit` again - the second
attempt existing because the first might have been taken before layout
settled, which is a real concern answered with a guess.
`client/js/terminal-readiness.js` retries on `guardedFit`'s own verdict
instead: stop the instant it is satisfied, give up on a bound, warn and
connect anyway. Measured deterministically (no server, no browser, so no
contention): **0.157 ms when the guard is satisfied first try**, against
the 50 ms that was spent unconditionally; **125 ms when the condition
clears at 120 ms**, which the old code could not react to at all; and
**511 ms in the worst case**, because `BOUND_MS` is deliberately the
500 ms it replaces, so the degraded path costs exactly what shipped. The
xterm load wait moved into the same module and answers in **0.388 ms**
when the bundle is already there.

**DO NOT REMOVE THE BOUND.** An unbounded wait for a measurement turns a
stylesheet that never arrives into a session that never opens, and the
server's dimension handshake reshapes the pane on the first real paint
regardless - the same path a rotation already takes. Every wait in that
module is polled on a TIMER and never on a frame, for gotcha 9's reason.

**`terminal.ready` IS THE ONE POSITIVE STATEMENT THAT THE PANE CAN TAKE
INPUT, AND THE WINDOW BEFORE IT IS DEAF RATHER THAN SLOW.** The attach
handshake in `src/api/websocket.py` opens the socket, asks the client for
its dims, and sits in a receive loop that DISCARDS every binary frame
arriving before that reply. So "the socket is open" and "the pane can
hear" have never been the same fact, and nothing on the wire said which
one you had: a keystroke typed during a connect was destroyed by the
server with no trace, and one typed before the socket existed was
destroyed by the client's own `readyState === OPEN` check.

The message is sent ONCE, after the dims handshake, after the settle,
after `paint_on_attach` and after any configured startup command. Sent
earlier it would be exactly as useless as no message, and it would look
like it worked. It is **NEVER WITHHELD** - a startup command that failed
does not make the pane unable to receive input - so it carries
`startup_command` (`issued` / `none` / `failed` / `unknown`) rather than
gating on it, and `flush_pending_terminal_command` returns that word
instead of `None` because it swallows its own write failures by design.
`failed` and `none` must never collapse: one means the prompt is bare
because nothing was asked for, the other because what was asked for did
not happen.

**IT IS ADDITIVE, AND THAT PROTECTS ONLY ONE DIRECTION.** Nothing waits
for a reply and nothing is gated on the client having read it, so an old
client behaves exactly as it did before the message existed. A NEW CLIENT
AGAINST AN OLD SERVER is the other direction and is the worse failure:
without a bound it would hold every keystroke forever, a terminal that
silently accepts no input with nothing on screen saying why. So
`READY_TIMEOUT_MS` (4 s, armed from the socket OPENING) delivers the held
batch and falls through to passing input straight on. DELIVERED, not
dropped - the socket is open and the user typed those bytes for this pane.

**THE PRE-READY BUFFER IS KEYED BY CONNECTION GENERATION, NOT BY SESSION
ID** (`client/js/terminal-input-buffer.js`). A reconnect to the SAME
session is a NEW connection, and input typed before a socket dropped must
not be replayed into the one that replaces it; a session id cannot
express that and a monotonic counter can. It is deliberately NOT the
navigation generation, which does not move on a reconnect. No local echo,
ever: painting held input would show the user text the pane has not
received, and if the batch is later rejected the terminal is lying about
a command that never ran.

**64 KiB, AND OVERFLOW REJECTS THE WHOLE UNSENT BATCH**, announced
exactly once - not the newest, not the oldest, because half a command
line is a DIFFERENT command the shell will happily run. That is the
opposite rule from `terminal-write-queue.js`, which sheds its oldest
chunks and carries on, and the asymmetry is the point: output is a record
of what already happened, so a gap in it is a gap in a transcript; input
is an instruction that has not happened yet, so a gap in it is a
different instruction and no marker makes that safe. An ambiguous
disconnect DISCARDS and never replays, because re-sending what we cannot
prove was delivered risks running a command twice.

**THE RESIDUAL COST, SAID OUT LOUD:** a keystroke typed after the dims
handshake but before `terminal.ready` is now held until the paint, where
it used to sit in the socket and be processed when `receive_messages`
started. That is bounded by the attach settle plus one `capture-pane`,
and it buys back everything typed DURING the handshake, which the server
was destroying outright.

**AN ISOLATED CHUNK NO LONGER WAITS A FRAME.** `enqueue` scheduled every
chunk on `requestAnimationFrame`. That frame coalesces a BURST, which is
real and worth keeping; paying it for a single chunk with nothing to
coalesce with costs up to a whole frame on the keystroke echo. It now
writes straight through when no write is outstanding and falls back to
the frame when one is, so the second chunk of a burst waits and the
re-schedule merges everything into one `term.write` per frame exactly as
before. `flush` re-raises `flushing` when it re-schedules, so that flag
means "scheduled OR in flight" and a chunk arriving in the gap between
the write callback and its frame cannot write UNDER a flush already on
its way. `flush` also refuses on a null terminal now: that window existed
before and was one frame further away.

**ONE OWNER FOR THE MEASUREMENT, ONE FOR THE SHIP.** There were nine
`fitAddon.fit()` call sites across five files. Every measurement now goes
through `TerminalMetrics.guardedFit` - including `currentGrid`, whose raw
fit fed the pane's BIRTH geometry, and the `request_dims` handshake - and
every ship goes through `TerminalLayout`'s coalescer or one of two
explicitly named handshake sites. Four raw fits remain and all four are
named in `tests/test_fit_ownership.node.mjs`: the two inside `guardedFit`,
which ARE the measurement, and three module-missing fallbacks where an
unfitted terminal is worse than an unguarded one. That test COUNTS rather
than times, because a duplicate fit that happens to be fast is still a
duplicate.

**THE SLASH PALETTE IS NOT A PROPERTY OF THE SOCKET.** Both entry paths
did `await SlashCommandsModal.init(...)` on the line above the connect,
and `init` makes two server round trips. `client/js/slash-commands-boot.js`
starts it and is never awaited; it carries the navigation token, because
a palette fetched for session A landing after the user is in B would
populate B's menu with A's agent's commands, and a slash command run in
the wrong pane RUNS A COMMAND. One fetch per working directory; a failure
is NOT cached as an answer.

**AND TWO MORE 500 ms TIMERS WERE WAITING FOR SOMETHING THAT HAD ALREADY
HAPPENED.** `detachAndOpenProject` and `detachAndCreateNew` both slept
after `await window.API.detachSession()` to "let the server finish
clearing its backend handles". It already has: `detach_session` awaits
`detach_current_session`, which awaits the idle watcher's stop and the
reader task's cancellation before the handler returns, so the response the
client had already awaited IS the completion signal. Both copies went;
fixing one of a pair is how the other survives. Each re-open now has its
own `try`/`catch`, because the timer used to ESCAPE the surrounding block
and an error in the re-open was an unhandled rejection.

**THE WALL-CLOCK END-TO-END NUMBERS ARE NOT SETTLED.**
`scripts/perf/run_baseline.py --sessions 1 --quick` was run four times
either side of this change on a box at load average 11 to 27 with 45
concurrent agent processes, and `session entry`, `session switch` and
`launch` are single samples per run there: they spanned 763 ms to
10,480 ms for one arm of one metric, a 13x spread, so nothing in that
group supports a conclusion in either direction. Typing echo has n=4 and
moved the right way (p50 warm 22.1 / 21.3 ms before against 19.0 /
11.2 ms after) but on that box that is corroboration, not proof.
RE-MEASURE ON A QUIET MACHINE before quoting any figure from this
paragraph, and prefer the deterministic numbers above, which no amount of
load can move.
