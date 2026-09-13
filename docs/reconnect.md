# Reconnect, sleep and wake

What the terminal does when the browser comes back, and what the user is
allowed to decide about it.

## What a reconnect repaints, before any of this

There are two re-attach paths and they behave differently. Know which one
you are looking at before debugging either.

**The websocket re-attach** (`src/api/websocket.py`). The server sends
`request_dims`, the client answers with a `pty_resize`, the server applies
it, waits about 150 ms for SIGWINCH to reach the pane, and then paints the
pane's VISIBLE SCREEN (`src/api/ws_startup_paint.py`) - or, for a
full-screen TUI, sends Ctrl+L and lets the app redraw itself. No history is
replayed on this path at all. That is deliberate: a capture taken at the
pane's previous geometry paints as shrapnel at the new one.

**The launchpad / sidebar rejoin** (`GET /sessions?include_scrollback=1`).
The server pre-resizes the pane to the client's grid and captures
`tmux capture-pane -p -e -J -S -<session.scrollback_lines>`, default 10000
lines, and hands it over as `initial_scrollback_b64`. The client then asks
`client/js/terminal-reconnect-buffer.js` what to do with it:

- `keep` when the SAME session id is being re-attached and xterm's buffer
  already holds content. The reset and the capture paint are both skipped,
  because the bytes on screen came from this very pane and beat the
  capture.
- `replace` otherwise: `term.reset()`, then paint the capture.

Note what tmux can actually give back. Claude Code draws in place on the
ALTERNATE SCREEN, where `history_size` is 0, so a capture of one of those
panes is a single frame - the current one - and nothing before it. For a
normal shell pane the capture really does reach back through history.

So the app decides alone about what to repaint, and does not narrate the
gap. That is the shipped behaviour and it is deliberate as of
2026-09-13; see the section below for what used to sit here.

## The away bar, removed 2026-09-13

**THERE IS NO WAKE PROMPT ANY MORE. Do not rebuild one without asking.**

Between punchlist item 1 and 2026-09-13 the app showed an inline overlay
after a measured absence of 60 seconds or more, reading `away N min` and
offering three answers: show full history, show summary, just continue.
The owner asked for it to go - verbatim, "get rid of this notification" -
and the whole feature was deleted, client and server. Removed with it:

| what | where it lived |
|---|---|
| the rules, the thresholds and every sentence | `client/js/terminal-away-gap.js` |
| the heartbeat, the element and the three actions | `client/js/terminal-away-bar.js` |
| the overlay stylesheet | `client/css/terminal-away-bar.css` |
| the facts behind the summary | `src/core/session_away_report.py` |
| `GET /api/v1/sessions/away/summary` | `src/api/away_routes.py` |
| the per-device remembered answer | `localStorage` key `cloude.away.lastChoice` |

**NOTHING WAS LOST, WHICH IS WHY THIS WAS SAFE.** The bar's only
irreplaceable action was "show full history", and the session search
feature (`web/src/lib/terminal-search/`, with
`client/js/terminal-history-load.js`) pulls the full tmux history itself,
on demand, whenever the user opens it. The summary read three facts the
server already publishes elsewhere: the toast records
(`GET /sessions/{id}/toasts`), the activity signal (surfaced as
`activity_status` on `/sessions/list`) and one `#{alternate_on}` probe.

**ONE DECLARATION OUTLIVED THE FEATURE.**
`client/css/terminal-away-bar.css` was where
`.terminal-container { position: relative }` was declared, and the search
panel and prompt rail depend on it - `.terminal-container` is a flex
column, so an in-flow child of it steals rows from `#terminal`, the
ResizeObserver reads that as a real geometry change, tmux raises SIGWINCH
and claude answers with `ESC[2J`, erasing the alternate screen. Everything
over the pane is therefore `position: absolute`, which needs the pane to
be a containing block or the overlay resolves against `#terminal-screen`
and spans the docked sidebar. That single declaration moved into
`client/css/styles.css`, beside the rest of `.terminal-container`, and is
guarded by `tests/test_terminal_container_containing_block.node.mjs`.

**A WEBSOCKET DROP WITH THE USER PRESENT NEVER RAISED A BAR ANYWAY**, and
still raises nothing. That was never an absence: you saw it happen, and
the reconnect buffer kept your screen across it. The keep rule below is
untouched by any of this and always was.

## The retry ladder, and what an attempt is allowed to claim

**IT NEVER RECONNECTED, and that was measured before anything was
changed.** `attemptReconnect()` set `isReconnecting = true`, charged the
budget and scheduled `connectWebSocket()`, whose first line was
`if (this.isReconnecting) { this.stopReconnecting(); return; }`. So the
retry the scheduler had just fired hit that guard, RETURNED without
opening a socket, and `stopReconnecting()` put the budget back to zero on
its way out. Driven against the shipped class: one timer, ZERO sockets,
budget 0, and the only thing the user saw was `reconnecting, attempt 1 of
5` and then silence - not even the failure message, because
`attemptReconnect()` was never re-entered. Present since the initial
commit. It is why the 4404 and outage recoveries were bolted on beside the
general mechanism: they call `reconnectToExistingSession` directly and
never went through it.

**TWO QUESTIONS, TWO COUNTERS, ONE WRITER EACH.** `reconnectAttempts` is
the BUDGET - have we told the user this session is unreachable yet - and
only `_resetRetryBudget()` ever zeroes it. `_attemptsSinceProgress` is the
BACKOFF and every attempt moves it. One counter for both forced a choice
between a budget that never fills and a delay that never grows. The
backoff is exponential from 1s to a 16s ceiling; the 500 ms before the
FIRST connect is a screen-settle delay and is unrelated.

**THE BUDGET IS SPENT ONLY BY A MEASURED FAILURE**, which is the socket
never opening: the server did not answer. An attempt whose outcome is
UNKNOWN costs nothing, and neither does a pane measured to be sitting on
its startup prompt. Not having measured a success is not evidence of
failure, and charging for one is how a slow machine or an untrusted folder
gets a healthy session declared unreachable - the same asymmetry
`resolve_startup_gate` uses at rung 5 versus rung 7. The cost of that
choice, stated rather than hidden: a server that accepts a socket and
closes it immediately, forever, is retried forever. The backoff still
reaches its ceiling, so it is a slow poll and not a spin, and declaring a
healthy session dead is the worse failure.

**INITIALIZATION SUCCESS IS THE FIRST BYTES, NOT THE SOCKET OPENING.**
Three different facts are in play - the socket opening, the dimension
handshake completing, and the pane sending something - and only the third
proves the session is talking. A pane parked on its folder-trust dialog
opens a perfectly good socket and says nothing. The outcome is named with
the server's own three-value vocabulary, `ready` /
`awaiting_startup_prompt` / `unknown`
(`src/core/session_startup_gate.py`), reused rather than given a fourth
spelling, and `ready` claims only "not blocked on a startup prompt", never
"healthy".

**THE UNREACHABLE MESSAGE IS SAID ONCE AND STAYS SAID.** Silence on an
unreachable session is worse than a message; a message that repeats on
every further close is worse than either. `_unreachableReported` keeps it
to one and is cleared by the same thing that refills the budget.

**FOUR NAMED BRANCHES, ONE SCHEDULER.** `_scheduleRecovery(closeCode)`
replaces three guard clauses that sat in front of a general mechanism none
of them ever reached. `refresh_auth` on 4401, `re_resolve_by_name` on 4404
at most once per disconnect episode, `wait_for_server` on an ordinary
abnormal close that `ServerRestartWatch` recognises, and `retry_same_id`
for everything else. A missing `ServerRestartWatch` degrades to the plain
retry rather than throwing inside `onclose`.

**A RECONNECT CARRIES THE NAVIGATION IT WAS SCHEDULED FOR.** The delay
reaches sixteen seconds, which is ample time to move to another session,
so a retry checks the navigation token before it connects and stands down
if the user has gone elsewhere. See `client/js/navigation-generation.js`.

## Known gaps

- Nothing narrates a gap. Coming back after two hours away, the app
  repaints on its own rules and says nothing about what happened while you
  were gone. That is the owner's call (above), not an oversight.
- Pulling the full tmux history on an alternate-screen pane replaces the
  browser's kept buffer with a single captured frame, because
  `history_size` is 0 there. The trade is real: for a Claude Code session
  the browser's buffer is usually the better record.

## Files

| piece | file |
|---|---|
| What a reconnect may do to the buffer | `client/js/terminal-reconnect-buffer.js` |
| What an attempt measured, what it costs, and which recovery a close asks for | `client/js/terminal-reconnect-policy.js` |
| The budget, the backoff, the scheduler and the four branches | `client/js/terminal.js` |
| Tests | `tests/test_reconnect_scheduling.node.mjs`, `tests/test_terminal_container_containing_block.node.mjs` |
