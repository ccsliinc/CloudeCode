# Notifications: toasts, where they come from, and what dismissing one means

This describes the toast pipeline end to end after the 2026-09-08 change
that made raising GLOBAL and left dismissing PER SESSION (punchlist items
7 and 8). The status lights are a different question and live in
`docs/session-status.md`; a toast says "come and look at this now", a
status light says "here is what this session is doing".

## The two axes, and why they are two

**RAISING IS GLOBAL. DISMISSING IS PER SESSION.** Those are independent
axes and it is easy to fix one by breaking the other, which is why they
are named separately everywhere in the code and asserted separately in
`tests/test_toast_cross_session.py`.

- **Raise** = a toast reaches the browser at all. It must, whatever
  session the user happens to be looking at, because the whole point of
  a notification is that it is about something you are NOT watching.
- **Dismiss** = the user is done with this record. It applies to the ONE
  record, in the ONE session that raised it. Typing into session A is
  evidence about session A and says nothing about session B.

## What used to filter toasts to the session on screen

Two filters, both at the transport layer, and fixing either alone would
have left the bug in place.

1. **The WebSocket.** `toast.new` is fanned out only to sockets bound to
   the raising session (`src/api/routes.py`, in its own words: "toasts
   for session A never leak"). A browser holds ONE terminal socket,
   bound to the session on screen, so a toast for any other session had
   no transport to arrive on.
2. **The attach backfill.** `client/js/terminal.js` calls
   `GET /sessions/{id}/toasts` for the ATTACHED session only, and only
   at WebSocket open.

Between them, a session that needed attention while the owner was
elsewhere was silent - and the launchpad and archive screens, which hold
no terminal socket at all, were deaf to notifications entirely.

## What raises them now

`GET /api/v1/toasts` returns every session's records, newest first,
undismissed by default. `client/js/toast-global-poll.js` polls it every
10 seconds from whatever screen the user is on and feeds the result into
the SAME `ToastManager.backfill` the attach path already used.

**A POLL RATHER THAN A WIDER BROADCAST, deliberately.** Widening the
WebSocket fan-out would push every session's toast frames down the one
terminal socket and make `terminal.js` filter them, which couples
notification delivery to the terminal transport - the coupling that
caused this bug. It would also still leave the socket-less screens deaf.

**BOTH PATHS FEED ONE MODEL.** The WebSocket stays the fast path for the
session on screen; the poll is the catch-all for every other session.
Both end in `ToastManager.add()`, which dedupes on `toast.id`, so a
record arriving by both routes renders once.

## What dismissing does, and the race it introduced

`ToastManager.dismiss()` acks with `toast.session_id` - the toast's OWN
session, never the one on screen - and `POST /toasts/{id}/ack?session_id=`
walks only that session's bucket. So acking session B's toast id while
naming session A leaves B's record untouched. That endpoint always
answers 200; the isolation lives in the storage walk, not in a status
code, and `tests/test_toast_cross_session.py` asserts the resulting
STATE rather than the code.

`dismissForSessionActivity(sessionId)` (fired when the user types into a
session) and `dismissBySession(sessionId)` are both scoped to one
session and stay that way. `dismissAll()` is the deliberate, explicit,
broad counterpart.

**THE ONE NEW DEFECT THE POLL COULD HAVE INTRODUCED**, and the guard for
it: `dismiss()` removes the id from its model immediately and fires the
ack asynchronously. A poll tick whose request left the browser BEFORE
that ack landed comes back holding a snapshot in which the toast is
still unacked, and feeding that through `add()` would resurrect the card
the user just dismissed, in front of them.
`client/js/toast-dismissed-ring.js` is a bounded, expiring set of
locally dismissed ids that the poller filters every result through.
`toast.js` announces each dismissal as a `cloude:toast-dismissed`
CustomEvent so the ring hears it without the toast module gaining a hard
dependency on the poller.

**IT IS A SUPPRESSION, NEVER AN ACK.** Nothing in the ring talks to the
server. If the ack genuinely FAILED, the record is still unacked
server-side, the ring forgets it after 60 seconds, and the toast comes
back - which is correct, because it was never dismissed. Making the
suppression permanent would turn a failed write into a notification the
user never sees again.

## Clicking a toast

A card is now usually about a session that is NOT on screen, so clicking
it goes there. `client/js/toast-navigate.js` resolves the toast's
`session_id` against `GET /sessions/list` and hands the REAL row to
`App.returnToExistingTerminal`, which enters through
`ThemeNavigation.applyForSession`.

**IT RESOLVES A ROW, IT DOES NOT SYNTHESISE ONE.** The toast carries
enough to NAME a session and not enough to ENTER one: `pinned_theme` and
`tmux_session` ride on the SessionInfo WRAPPER, not on the toast, and an
object assembled from the toast would carry no pin - so entering a
pinned session from a toast would paint the previous session's theme
(CLAUDE.md gotcha 7, already paid for once).

The dismiss button calls `stopPropagation`, so dismissing never
navigates. **The click never acks:** reading a notification is not
answering it.

A session that has since died is said out loud through `Router.showError`,
the app's one error banner, rather than the click silently doing nothing.

## Where the history lives, and what it may not claim

`GET /api/v1/toasts/history?limit=100&offset=0` pages back through every
record, dismissed and open, newest first. It is reachable from the
settings gear, `notifications` tab, beneath the channel fields - a slot
in the screen already titled "notifications", not a new navigation
pattern.

**THE RECORDS ARE IN MEMORY AND NOWHERE ELSE.** There is no toast table
and no json store. Everything lives in
`SessionManager._pending_toasts`, a dict keyed by session id, with an
asymmetric retention rule:

| | retention |
|---|---|
| unacked | kept without limit - dropping one would lose a notification nobody saw |
| acked | last 50 PER SESSION (`_TOAST_ACKED_CAP`); older ones fall off the tail |
| a wiped session | its whole bucket goes |
| a server restart | everything goes |

So the history is a history of THIS SERVER RUN. The response carries
`storage: "process_memory"` and the empty state says so in words,
because an empty list after a restart means "the record was lost", not
"nothing ever happened".

**THE OUTCOME IS TWO-VALUED, AND THAT IS A LIMITATION, NOT A DESIGN.**
The original ask wanted three outcomes distinguished - answered by the
user, auto-dismissed by typing into the session, and swept by "dismiss
all" - because "I answered it" and "it got swept" are different facts.
The `Toast` model carries `acknowledged` as a bare boolean and NOTHING
records which act set it, so a row says `dismissed` or `open` and
nothing else. A guessed reason on a page whose only job is to be trusted
about what happened would be worse than the missing column. See the open
items below.

## The files

| Piece | File |
|---|---|
| Flatten, order and page the record set (PURE) | `src/core/toast_history.py` |
| `GET /toasts`, `GET /toasts/history` | `src/api/toast_routes.py` |
| Record, supersede, ack, prune | `src/core/session_manager.py` |
| Per-session list/create/ack routes | `src/api/routes.py` |
| Render the stack, coalesce, cap, dismiss | `client/js/toast.js` |
| The two cross-session API calls | `client/js/api-toasts.js` |
| The cross-session poll | `client/js/toast-global-poll.js` |
| Stop a dismissed card coming back | `client/js/toast-dismissed-ring.js` |
| Click a toast, go to its session | `client/js/toast-navigate.js` |
| What a history row CLAIMS (PURE) | `client/js/toast-history-render.js` |
| The settings-panel slot | `client/js/toast-history-panel.js` |
| Styling | `client/css/toast.css`, `client/css/toast-history.css` |
| Tests | `tests/test_toast_cross_session.py`, `tests/test_toast_history_render.node.mjs` |

## Open items

1. **No durable store.** A restart clears the history. A table would fix
   it and needs a schema migration through `session_manager` and the db
   modules; the read view above is deliberately built over existing
   state, as the handoff scoped it.
2. **The dismissal REASON is not recorded**, so the three-way outcome the
   owner asked for cannot be rendered. It needs a reason threaded through
   `POST /toasts/{id}/ack` into `SessionManager.ack_toast` and a column on
   the record.
3. **A duplicate hook event after a dismissal mints a NEW toast.**
   Supersession never returns an ACKED record (by design - an acked card
   is one the user dealt with), so a `Stop` delivered twice with the ack
   in between pops a second card. Correct for a genuinely new turn, wrong
   for a duplicated delivery, and the two are indistinguishable at the
   record level today. Hook events are documented as duplicated and
   droppable, so this is a real case and not a theoretical one.
4. **No cap on the cross-session stack.** The owner asked whether toasts
   stack unboundedly across 20+ sessions. The client's visible cap and
   coalescing bound what is DRAWN (`client/js/toast.js`), and the server's
   supersession bounds repeated `Stop`s per session, but nothing bounds
   distinct sessions. Measure it on a box with twenty live sessions
   before deciding whether it needs one.
