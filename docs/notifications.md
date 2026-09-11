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
`toast.js`'s lifecycle half (`client/js/toast-lifecycle.js`) announces
each dismissal as a `cloude:toast-dismissed` CustomEvent so the ring
hears it without the toast module gaining a hard dependency on the
poller.

**IT IS A SUPPRESSION, NEVER AN ACK.** Nothing in the ring talks to the
server. If the ack genuinely FAILED, the record is still unacked
server-side, the ring forgets it after 60 seconds, and the toast comes
back - which is correct, because it was never dismissed. Making the
suppression permanent would turn a failed write into a notification the
user never sees again.

## A prompt from any client answers the session's toasts

The owner's ask, verbatim: "on the toasts, if its waiting on me and i
type into this browser or a remote control session, the toasts should be
removed, we can tell because i think when a new prompt is sent it should
trip a hook." He is right about the hook. `UserPromptSubmit` fires
whenever a prompt is submitted to the agent, whoever typed it and
wherever - the browser terminal, a remote control session, or the
keyboard attached to the Mac. So it is a fact about THE USER SHOWING UP,
and a notification asking the user to show up is answered the moment
they do.

`src/core/toast_auto_ack.py` is the pure rule set;
`SessionManager.auto_ack_toasts` applies it; the hook route calls it once,
right after `record_hook_event`.

| Hook event | Toast kinds it answers | Why that set |
|---|---|---|
| `UserPromptSubmit` | `Stop`, `PermissionRequest`, `Notification`, `StartupPrompt` | the user typed, so nothing is still waiting on them |
| `PreToolUse` | `PermissionRequest` only | a tool about to run proves a permission was granted, and proves nothing else |
| `Stop` | `PermissionRequest`, `Notification`, `StartupPrompt` | an agent cannot end a turn while blocked, and the turn a notice belonged to is over |

**A `Stop` NEVER ACKS A `Stop` TOAST, AND THAT IS STRUCTURAL RATHER THAN
POSITIONAL.** `Stop` both RAISES the "your turn" card and answers others,
so the obvious defect is a Stop eating the card it just created. It would
be tempting to rely on call order - ack before recording, and the new
toast cannot be seen - but that guarantee survives only until someone
moves a line, and it fails outright for a DUPLICATED Stop, whose
predecessor's card is a real unacked record by the time the duplicate
arrives. Excluding the KIND makes the property hold for every ordering,
every duplicate and every future call site. Only the user turning up
clears a "your turn", which is `UserPromptSubmit`, or a click.

**THE CUTOFF IS THE EVENT'S OWN INSTANT, NOT THE ACK'S.** Hook events are
unordered, duplicated and droppable, so the moment the code RUNS says
nothing about when the thing it describes HAPPENED. The route stamps
`received_at` at the top of the handler, before any state is mutated, and
a toast whose `created_at` is later than that is never answered by that
event. A prompt redelivered late must not clear a notice about something
that happened after the user typed - that would destroy a record the user
never saw, which is worse than a card that lingers.

Idempotence falls out of `ack_toast` refusing a second ack: the same
event delivered ten times acks on the first and does nothing nine times,
so no duplicate frames, no duplicate log lines, no history churn.

**THE LED AND THE CARD AGREE BECAUSE THEY ARE FED BY THE SAME EVENTS.**
`src/core/session_activity.py` already clears `permission_open` and
`notice_open` on exactly `UserPromptSubmit`, `PreToolUse` and `Stop`, so
no new clearing path was added - the auto-ack simply matches the set that
was already there. `tests/test_toast_auto_ack.py` asserts it through the
public resolver rather than trusting the reading, because a session
showing a "needs permission" light with no card is the same lie as a card
with no light, pointing the other way.

## Removing a card, not only adding one

`ToastManager.backfill` has only ever ADDED. That was correct while the
only thing that could close a toast was a click here (which removes the
card locally) or a click in another tab (which arrives as a `toast.ack`
frame). Neither is true now that the server closes toasts by itself, and
a surface holding no socket for the raising session - the launchpad, the
archive, a terminal attached somewhere else - has no frame to hear it on.

So there are two channels, and the fast one is an optimisation:

* **`toast.ack` frame.** The auto-ack broadcasts the SAME frame a click
  produces, from the same session-scoped fan-out, so an attached terminal
  drops the card instantly. One dismissal protocol, not two.
* **The poll, which is the floor.** `client/js/toast-global-poll.js` now
  applies the server's open set in BOTH directions each tick:
  `backfill(fresh)` adds, `ToastManager.reconcileOpen(list, {since})`
  removes.

**THE REMOVAL GUARD IS `ToastDismissedRing`'S RACE POINTING THE OTHER
WAY.** A poll response describes the server as it was when the request
LEFT. A `toast.new` frame that arrived after that instant is absent from
the response through no fault of its own, and removing it would delete a
card the server does hold. So the poller stamps `startedAt` before the
request goes out and `reconcileOpen` spares any card added at or after
it; the next tick, whose snapshot IS newer than the card, removes it.
Sparing is a delay, never an exemption.

**REMOVALS ARE COMPUTED FROM THE RAW LIST, ADDITIONS FROM THE FILTERED
ONE.** An id the dismissed ring is suppressing is one this browser has
already dropped, so subtracting it from the open set would only make the
server's answer look smaller than it was. And the ring can never
resurrect an auto-acked card: it only ever subtracts.

**RECONCILING NEVER ACKS.** Every id it removes is one the server has
already closed, so a sync-back would be a write with nothing to change,
aimed at a record that may belong to a session this browser is not
attached to. Removal is a rendering fact only.

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

## The external push channels, and why they now go out at once

A toast is raised in the browser. The three EXTERNAL channels - ntfy,
Slack and Pushover - are a separate path: `NotificationRouter` holds a
bounded queue of 100 and a single worker task drains it.

Until #40 that worker awaited the three channels ONE AFTER THE OTHER.
Each channel builds its httpx client with `httpx.Timeout(5.0,
connect=5.0)`, which bounds every PHASE of a request at 5s and the
request as a whole at nothing, so a peer that accepts the connection and
never answers costs 5s per channel and the three of them cost it three
times over. Measured 2026-09-10 against a local blackhole peer, one
queue entry with all three channels configured: **15.075s serially
against 5.018s concurrently**, a ratio of 3.00. Both arms ran in one
process against one peer so the same load hit both, and the figures land
within 1.5 percent of the 3x5s and 1x5s the timeouts predict, which is
what says the box's load average of 20 did not inflate them.

**THAT COST WAS NEVER TERMINAL LATENCY, AND SAYING SO ACCURATELY
MATTERS.** The worker is its own task and every one of those awaits
yields the event loop, so unlike the listing pass this was not stealing
keystrokes. What it was, is HEAD-OF-LINE BLOCKING in a queue that DROPS
THE OLDEST ON OVERFLOW: every entry behind the slow one waited the full
serial cost, and at 100 queued events that converts into notifications
never sent at all. A missed "your turn" is a worse failure than a
spurious one, which is the whole reason this was worth fixing.

**THE QUEUE IS STILL SEQUENTIAL.** Concurrency is WITHIN one entry.
Entries are still drained one at a time, in order, which is what
preserves the rate limit and the ordering the router already promised.
Both mute gates are untouched and both still run: at `emit`, so a muted
session cannot evict another session's alerts from the bounded queue,
and at drain, where the policy GENERATION is checked. Concurrency sits
BELOW the drain gate, so the generation check still runs exactly once
per entry, before any channel is contacted.

**ORDERING BETWEEN CHANNELS IS DELIBERATELY GIVEN UP.** The old code
called ntfy first and said so as a feature, "so a slow Slack request
never delays the snappier ntfy push". Concurrency delivers that properly
rather than by queueing behind it. The RESULT list is still in a fixed
order because `asyncio.gather` preserves argument order; only the order
the network is contacted in is now unspecified, and nothing downstream
ever depended on it.

**ONE CHANNEL MAY NOT TAKE THE OTHERS WITH IT, TWICE OVER.** An
unhandled exception inside a gather CANCELS its siblings, which would
turn one channel's timeout into a dropped notification on every other
channel. So each channel is wrapped individually and reports an outcome
instead of raising, AND the gather still takes `return_exceptions=True`
on top of that, so a defect in the wrapper itself cannot do it either.
Failures are logged per channel with the channel name and the
exception's own type - three channels down is three facts, not one
opaque line.

**THE PER-CHANNEL BOUND IS DERIVED, NOT INVENTED, AND THE POLICY
QUESTION IS STILL OPEN.** `CHANNEL_TIMEOUT_SECONDS = 15.0` is connect
plus write plus read at the channels' own 5s httpx budget, so it is the
longest a channel behaving inside its own configuration can legitimately
take. It therefore NEVER fires on a send that was going to succeed, and
only catches a stall httpx's phase timeouts cannot see: pool exhaustion,
a redirect chain, a channel that stops using httpx. It is a BACKSTOP,
not a decision about when to give up on a notification. Choosing a
SHORTER number would start abandoning sends that would have landed,
which is a policy call for the owner; the router reads it through
`getattr(config, "channel_dispatch_timeout_seconds", ...)` so a config
field can be added without touching the dispatcher.

**A HUNG CHANNEL IS TORN DOWN, NOT JUST STOPPED WAITING ON.**
`asyncio.wait_for` cancels the coroutine when the bound expires. A
timeout that left the hung send running would leak one task per event
while looking, from the return value, exactly like a working bound -
which is why `tests/test_notification_channel_dispatch.py` asserts the
cancellation reached the coroutine rather than only checking the result.

**A PERMISSION REQUEST STILL GETS OUT UNCONDITIONALLY.** Nothing here
suppresses by kind, and it may not: a permission request is a hard block
where the agent has stopped mid-turn and cannot continue until a human
answers. Every rule above fails toward sending, and the test file carries
that as an explicit case with the other two channels broken.

**THERE IS NO RETRY IN THIS PATH AND NOTHING HERE ADDED ONE.** Each
channel is contacted exactly once per entry, so a partial failure cannot
re-send to a channel that already succeeded. That holds because there is
nothing to retry with, not because a check enforces it, so anything that
later adds a retry has to key it on the per-channel results the
dispatcher returns and not on the entry as a whole.

## The files

| Piece | File |
|---|---|
| Fan one event out to every external channel at once | `src/core/notifications/channel_dispatch.py` |
| The bounded queue, both mute gates, the rate limit | `src/core/notifications/router.py` |
| The three channels | `src/core/notifications/ntfy.py`, `slack.py`, `pushover.py` |
| Flatten, order and page the record set (PURE) | `src/core/toast_history.py` |
| `GET /toasts`, `GET /toasts/history` | `src/api/toast_routes.py` |
| Record, supersede, ack, prune | `src/core/session_manager.py` |
| Per-session list/create/ack routes | `src/api/routes.py` |
| The registry (severity, coalesce keys) and the constructor | `client/js/toast.js` |
| Coalesce, cap, severity | `client/js/toast-grouping.js` |
| Render the stack, and schedule a coalesced render pass | `client/js/toast-render.js` |
| The frame-or-timer race a scheduled render runs on | `client/js/toast-render-batch.js` |
| Add, dismiss, reconcile, backfill | `client/js/toast-lifecycle.js` |
| The two cross-session API calls | `client/js/api-toasts.js` |
| The cross-session poll | `client/js/toast-global-poll.js` |
| Stop a dismissed card coming back | `client/js/toast-dismissed-ring.js` |
| Which toasts a hook event ANSWERS (PURE) | `src/core/toast_auto_ack.py` |
| Apply that, and report what changed | `SessionManager.auto_ack_toasts` |
| Click a toast, go to its session | `client/js/toast-navigate.js` |
| What a history row CLAIMS (PURE) | `client/js/toast-history-render.js` |
| The settings-panel slot | `client/js/toast-history-panel.js` |
| Styling | `client/css/toast.css`, `client/css/toast-history.css` |
| Tests | `tests/test_toast_cross_session.py`, `tests/test_toast_auto_ack.py`, `tests/test_toast_history_render.node.mjs`, `tests/test_toast_reconcile.node.mjs`, `tests/test_toast_render_batch.node.mjs`, `tests/test_notification_channel_dispatch.py` |

## Rendering many toasts at once (issue #39)

`_render()` rebuilds the whole visible card set from the model on every
call - the cap, the coalesce counts and the overflow row are all
functions of the whole set - so calling it once per arriving or dismissed
record buys nothing over calling it once per BURST. A 500-record backfill
measured 500 renders and about 173ms of synchronous work, freezing the
tab; a bulk "dismiss all" has the identical shape from the other
direction, because each dismissed card's own 220ms fade-out timer used to
call `_render()` again on its own.

`ToastManager._scheduleRender()` (`client/js/toast-render.js`) coalesces
any number of model changes in one burst into ONE call to `_render()`.
Every lifecycle method that used to render directly - `add`, `dismiss`,
`updateLocal` - now schedules instead. The scheduling itself is
`client/js/toast-render-batch.js`: it races the next animation frame
against a short `setTimeout` fallback, because a bare `await
requestAnimationFrame` never resolves in a hidden tab (CLAUDE.md gotcha
9) and a scheduler built only on rAF would leave a whole backfill
unrendered for as long as the tab stays backgrounded. A wait may DELAY
the flush, never CANCEL it.

## Open items

1. **No durable store.** A restart clears the history. A table would fix
   it and needs a schema migration through `session_manager` and the db
   modules; the read view above is deliberately built over existing
   state, as the handoff scoped it.
2. ~~**The dismissal REASON is not recorded.**~~ CLOSED. `Toast.ack_reason`
   carries it, threaded through `SessionManager.ack_toast`: the human
   paths write `dismissed`, the hook-driven auto-ack writes `answered`.
   A history row reads `open` / `dismissed` / `answered`, and a record
   acked before the field existed carries null and still reads
   `dismissed` - not having recorded which act cleared a toast is not
   evidence it cleared itself. `summarize()` reports `answered` as a
   SUBSET of `dismissed` rather than a sibling, so the count already on
   screen did not silently change meaning.
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
