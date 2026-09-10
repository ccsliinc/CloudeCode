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
`tmux capture-pane -p -e -J -S -<session.scrollback_lines>`, default 3000
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

So before this feature the app always decided alone, and never said what
had happened during the gap.

## The choice on wake

Punchlist item 1, in the owner's words: expose full-vs-summary as a
deliberate option on wake, do not ship a suppression as the fix.

After a MEASURED ABSENCE of 60 seconds or more
(`TerminalAwayGap.AWAY_THRESHOLD_MS`), an inline bar appears at the top of
the terminal reading `away N min` and offering three answers:

| answer | what it does |
|---|---|
| show full history | replays tmux's capture, bounded by `session.scrollback_lines` (3000 by default), into the live terminal |
| show summary | prints what the server recorded during the window |
| just continue | dismisses; the reconnect keeps whatever it already did |

Under a minute is a blip, not an absence, and raises nothing: today's
behaviour, no prompt. A bar that fired on every wifi hiccup would be
dismissed unread, which is worse than no bar.

**The last answer is remembered per device** in `localStorage` under
`cloude.away.lastChoice`, and it PRE-SELECTS ONLY. The bar is still shown
every time and nothing runs without a press. A remembered choice that
acted on its own would be the silent default this feature exists to
remove, wearing the user's own preference as a disguise.

## How the absence is measured

Not by a visibility event alone. A phone that sleeps may fire nothing at
all: the tab is already hidden and the OS simply suspends the process. So
`client/js/terminal-away-bar.js` runs a HEARTBEAT, stamping the wall clock
every 5 seconds while the page is visible. The gap between the last stamp
and the next tick IS the absence, measured rather than inferred.
`visibilitychange` is wired too because a tab switch does fire it and
answers a beat sooner.

**A websocket that drops and reattaches while you are watching raises no
bar.** That is not an absence: you saw it happen, and the reconnect buffer
already kept your screen across it. This layer never changes that keep
rule; it only offers to do something MORE, afterwards, when asked.

## What the summary is built from

No LLM step and no new event log. `GET /api/v1/sessions/away/summary`
(`src/api/away_routes.py`) reads three things the server already has, and
`src/core/session_away_report.py` assembles them:

- the session's TOAST RECORDS with a `created_at` at or after the window
  start, counted by kind (`Stop`, `PermissionRequest`, `Notification`);
- the live ACTIVITY SIGNAL held by `SessionActivityTracker`:
  `permission_open`, `notice_open`, and the later of `last_tool_event_ts`
  and `last_stop_ts`;
- one tmux probe, `#{alternate_on}`, which is what decides whether "full
  history" means history or means the current frame.

`client/js/terminal-away-gap.js` turns that into the printed lines. The
server ships facts and never sentences, so the app has exactly one
duration formatter rather than two that drift.

Three rules are load-bearing.

**The turn count is a FLOOR, never a total.** `SessionManager.record_toast`
SUPERSEDES an unacked `Stop` toast with the same title in place rather than
appending, so twelve finished turns can be one stored record. The report
therefore counts records, names the coalescing kinds in `coalesced_kinds`,
and the client prints "at least 3 turns finished". Printing it as a total
would be the same class of lie the toast layer already refuses to tell in
the other direction.

**A null is not a false.** `permission_open`, `notice_open` and
`history.mode` are three-valued. The activity tracker is in-memory and a
restart legitimately forgets it; the tmux probe can fail. An unread
permission signal prints as "whether a permission request is open is
unknown", never as silence. Silence there is the claim that sends someone
away from a blocked agent.

**Coverage is its own field, because the toast store dies with the
process.** A bucket emptied by a restart is indistinguishable from a quiet
session. So a window that starts before this process loaded reports
`partial_server_restarted` and the bar says so out loud. `complete` and
`unknown` are the other two. "Nothing happened" and "the record was thrown
away" must never render the same.

## Why the bar is an overlay

`.terminal-container` is a flex column. An in-flow child of it takes rows
away from `#terminal`; the ResizeObserver reads that as a real geometry
change, ships a `pty_resize`, tmux raises SIGWINCH, and claude answers with
`ESC[2J`, which on the alternate screen erases the whole visible
conversation. A bar asking "what should I repaint" must not be able to wipe
the answer on its way in. `#localServersContainer` paid for this lesson
already; see `.local-servers` in `client/css/styles.css`.

The bar's own stylesheet is `client/css/terminal-away-bar.css`, absolutely
positioned inside that container.

## Known gaps

- A websocket drop with the user present raises no bar, by design (above).
  If it ever should, the signal does not exist today: nothing dispatches an
  event on `ws.onopen`, and `client/js/terminal.js` is under a no-growth
  guard.
- "show full history" on an alternate-screen pane replaces the browser's
  kept buffer with a single captured frame. The bar says so before the
  press, in `TerminalAwayGap.historyCaveat`, but the trade is real: for a
  Claude Code session the browser's buffer is usually the better record.

## Files

| piece | file |
|---|---|
| The rules, the thresholds and every sentence | `client/js/terminal-away-gap.js` |
| The heartbeat, the element and the three actions | `client/js/terminal-away-bar.js` |
| The overlay stylesheet | `client/css/terminal-away-bar.css` |
| The facts behind the summary | `src/core/session_away_report.py` |
| `GET /sessions/away/summary` | `src/api/away_routes.py` |
| What a reconnect may do to the buffer | `client/js/terminal-reconnect-buffer.js` |
| Tests | `tests/test_terminal_away_gap.node.mjs`, `tests/test_session_away_report.py` |
