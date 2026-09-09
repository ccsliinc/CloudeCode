# Session status: one state model, two rings

What the lights mean, what moves them, and where each fact is stored. This
is the single source of truth for the status model; if code and this file
disagree, one of them is a bug.

## The vocabulary lives in one file

Every status string this app can show is spelled once, in
`src/core/session_status.py`. `src/core/session_activity.py` imports them
and owns the state MACHINE; it defines no string literals of its own. The
client mirrors the same set in `client/js/session-status-ui.js`.

## The states

| state | what it claims | what moves it there |
|---|---|---|
| `working` | the agent is doing tool work | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` |
| `working_subagent` | the same, inside a spawned subagent | `SubagentStart` with no matching `SubagentStop` |
| `question` | BLOCKED on the user: a yes/no nobody has answered | `PermissionRequest` |
| `notice` | claude wants attention and is NOT blocked | `Notification` |
| `finished_unread` | a turn ended and nobody has looked | `Stop`, plus the unread flag |
| `idle` | alive, at rest, already seen | `Stop`, or a bare-shell pane |
| `dead` | the pane's process exited | tmux `#{pane_dead}` = 1 |
| `unknown` | NOT MEASURED | anything else, including a live pane with no hook signal |

`unknown` is a first-class answer, not a failure mode. "I did not look"
and "I looked and found rest" are different claims and must never render
the same way.

### Why `question` and `notice` are two states, not one

They were one state until 2026-09-08, and that state was named `question`
because it carried both `PermissionRequest` and `Notification`.

**A permission prompt stops the agent. A notification does not.** A
`PermissionRequest` means claude has halted mid-turn and will make no
further progress until a human answers a yes/no. A `Notification` means
claude is asking to be looked at - it is idle at a prompt, or it has
something to say - and nothing is blocked by the user not looking. Those
are different amounts of urgency and different actions, and the single
`question` state asserted the louder of the two for both.

The cost of collapsing them is a light that cries wolf: a chatty session
firing notifications painted exactly like one genuinely parked on a
permission dialog, so the state that most needs acting on stopped being
the state that stands out. That is the false-urgency twin of this
project's recurring false-green problem, and the fix is the same shape -
say only what was measured.

**Both are cleared by the same three events** (`UserPromptSubmit`,
`PreToolUse`, `Stop`), because what resolves either one is the user
showing up, and those are the events that measure it.

**They are two independent booleans**, `permission_open` and
`notice_open`, not one field with three values. Hooks arrive unordered
and duplicated: a `Notification` landing after the `PermissionRequest` it
accompanies must not be able to downgrade the blocking claim, and one
landing before it must not be resurrected when the permission clears.
Two flags read in a fixed order converge on the same answer whatever
order the events arrive in, and applying either event twice is a no-op.

**Precedence:** `question` outranks `notice` in the same window;
`notice` outranks `working`. A stopped session is the most actionable
thing on the screen, and work that proceeds without the user is the least
of the three.

**The toasts say it too.** `_hook_event_presentation` in
`src/api/routes.py` titles a `PermissionRequest` **needs your permission**
and a `Notification` **wants your attention**. The split is only worth
having if it reaches the surface the user actually reads, and the toast is
that surface on a phone.

## The rules that keep it honest

**tmux is the only thing that can see a pane die.** The dead check runs
first and outranks every hook signal. Hooks cannot observe a dead process,
so nothing else may report `dead`.

**`dead` IS GALLERY-ONLY: a dead pane drops off the live list and belongs
in Recent.** The owner's call, verbatim 2026-09-08: "they go into recent,
they can disappear." A session whose process died has stopped, so
`_session_info_for` drops its row from `GET /sessions/list` rather than
leaving it in the sidebar wearing a dead light, and a restart from Recent
is a resume. The `dead` row in the table above and the `dead`/`off` LED
state below stay documented and stay implemented - they are what the
archive and the attachable-session decorator render - but no live
endpoint is meant to carry a dead row to the client. A round that read
the same measurement as a bug and made a husk KEEP its row, painted dead,
was overruled and reverted (`ba2aa5d`);
`tests/test_led_real_hooks.py::test_a_killed_pane_leaves_the_live_list_rather_than_painting_dead`
holds the line against a real killed pane.

STILL OPEN, and the test records it rather than asserting it:
`remain-on-exit` keeps a husk's tmux SESSION in the listing, and
`src/core/session_lifecycle.py` reaps on ABSENCE from that listing, so the
row leaves the live list without yet arriving in Recent. Closing that
needs a reaper rung keyed on a MEASURED `#{pane_dead}` - a new durable
writer, in the one module whose entire premise is never writing a verdict
nobody measured, so it is its own change and not a footnote to this one.

**Hook events are unordered, duplicated and droppable.** Every consumer in
`session_activity.py` is idempotent: last-write-wins booleans, counters
floored at zero (`subagent_depth = max(0, depth - 1)`), and an unknown
event kind is a documented no-op rather than an error. Applying the same
event twice, or two events in the wrong order, converges on the same state
a correctly-ordered stream would reach.

**A CLOSING EVENT IS NOT A HEARTBEAT ON ITS OWN**, and that was punchlist
item 4. Measured on claude 2.1.265 by `tests/test_led_real_hooks.py`,
twice: on a turn with **no subagent anywhere in it**, `SubagentStop`
arrives about 1.5s AFTER `Stop` (Stop+38.96s, SubagentStop+40.46s).
`Stop` had just cleared `last_tool_event_ts` to say the turn was over and
`SubagentStop` stamped it again, so the heartbeat re-armed and a finished
session painted `working` for the full 120s. `finished_unread` was visible
for about a second and a half and **`idle` was unreachable in between** -
the light claiming work nothing can see, this time through the hook
stream rather than through the tmux fallback that was fixed for the same
lie. The punchlist recorded it as "activity reads working for minutes
after a resume".

**The rule: `SubagentStop` never stamps the heartbeat.** It reports that
work ENDED, so the only thing it may move is `subagent_depth`, and it
moves that with the floor at 0. At depth 0 it moves nothing at all and
logs `subagent_stop_without_start` at debug.

It first shipped gated on `subagent_depth > 0` instead - stamp only when
a subagent was open to close - and **the gate is not the claim it stands
for**. Hooks are duplicated: a duplicated `SubagentStart` delivered after
`Stop` raises the depth off the floor by itself, and the duplicated
`SubagentStop` behind it then passes the gate and stamps, through the
very guard meant to refuse it. Worse, it stamps at its OWN arrival time,
so every further duplicated pair pushes the expiry out again - a ratchet
with no ceiling, driven entirely by strays. A guard keyed on a number the
stream it distrusts can move is not a guard. Refusing outright loses
nothing: a subagent FINISHING is not work happening now, so if the turn
really is still running the parent's next `PreToolUse` / `PostToolUse`
re-arms the heartbeat within one tool call.
(`tests/test_session_activity.py::test_a_duplicated_subagent_pair_after_stop_cannot_ratchet_the_heartbeat`)

`PostToolUse` cannot take the same blanket refusal - it is the only event
some legitimate turns emit late - and it has no counter to key on
(parallel tool calls and a droppable `PreToolUse` would desynchronise
one), so it keys on a `turn_open` boolean that every OPENING event
(`UserPromptSubmit`, `PreToolUse`, `SubagentStart`) sets and `Stop`
clears. Opening events still stamp unconditionally - there is nothing
they could be late for - so a stray `SubagentStart` after `Stop` still
buys ONE bounded window keyed on itself. What no `SubagentStop` can do is
extend it.

**The refusal is narrow, which is what makes it a measurement.**
`PostToolUse` is refused ONLY when a `Stop` has POSITIVELY been seen for
this session and no opening event has landed since. Never having seen a
`Stop` - a fresh session, a server restarted mid-turn - is not evidence
the turn ended, so that case still stamps. The remaining hole is a turn
whose `UserPromptSubmit` AND `PreToolUse` were both dropped, leaving only
a `PostToolUse`: it costs one under-claimed `working`, corrected by the
next opening event. Under-claiming is the safe direction.

**A missing `Stop` is handled by a timeout, not by detection.** A
tool-use heartbeat is trusted for `WORKING_HEARTBEAT_TIMEOUT_SECONDS`
(120s). Past that, no `working` is claimed. 120s is longer than a
realistic single tool call (a slow fetch, a long test run) so the light
does not flicker mid-turn, and short enough that a dead process does not
read as busy for the rest of the day.

**A persisted state is judged by its age.** `src/core/activity_persist.py`
stamps every write and refuses a perishable state (`working`,
`working_subagent`, `question`) older than the live timeout plus a small
grace. A stale `working` is a lie about right now, so it returns
not-measured rather than the stored value and rather than `idle`.

## The tmux fallback, and the claim it is not allowed to make

A session with NO hook signal at all falls back to tmux's pane
classification. That tier maps as follows, and the first row is the one
that changed:

| tmux says | means | maps to |
|---|---|---|
| `running` | the foreground command is not a bare shell | `unknown` |
| `idle` | the foreground command is a bare shell | `idle`, or `finished_unread` when unread |
| `dead` | the pane's process exited | `dead` |
| `unknown` | the query failed | `unknown` |

`running` used to map to `working`, and that was a claim tmux cannot
support. It means only "some non-shell process is in the foreground",
which is equally true of an agent mid-tool-call and one parked at an empty
prompt. The fallback carries no timestamp either, so unlike the hook tier
nothing could ever expire the claim.

**Measured 2026-09-08 on the reference box:** of 19 live sessions, 15
report a claude VERSION STRING as `pane_current_command` (`2.1.259`,
`2.1.261`, `2.1.263` - the binary renames its own process) and only 4
report `zsh`. So this branch is the common case, not the exotic one an
older note in `session_status.py` assumed, and every one of those 15
sessions was reporting a permanent, unexpiring `working` on no evidence.
That is the stale `working` recorded on the punchlist as lasting minutes
after a resume: it did not last minutes, it lasted until a hook arrived to
overrule it.

## Seeding at boot, and why it may only ever claim rest

The fallback above is honest and it is not enough. `SessionActivityTracker`
is an in-memory dict that nothing hydrates at boot or at adopt, so a
restart leaves every surviving session with no hook signal, and a pane
running claude has no tmux answer either. **Measured on live 2026-09-08
22:24Z: 19 live panes, 15 painting `unknown`.** Ten of them had never
fired a hook and never will - they were started by hand, without the hook
environment, and their last assistant turns are dated 2026-07-16 and
2026-08-24. They had been sitting at an idle prompt for weeks and the
light could not say so. The owner's complaint, verbatim: "on the homepage
and sidebar many status unknown."

So a second source of evidence is consulted, one that OUTLIVES the
process. `src/core/session_status_seed.py` is the pure ladder,
`session_status_seed_records.py` reads what a transcript record means,
`session_status_seed_store.py` is the cache, and
`session_status_seed_read.py` does the two reads and holds the seam.

**IT MAY CLAIM REST. IT MAY NEVER CLAIM WORK.** That asymmetry is the
whole design and it is not a conservatism knob. Rest is self-evidencing: a
conversation whose last record ends a turn is at rest until something
appends to it, and nothing has, which is exactly why
`activity_persist.PERISHABLE` excludes `idle`. Work is a claim about right
now and it needs a heartbeat to expire it. Hooks carry one; a file on disk
does not. A `working` seeded from a transcript could never be expired by
anything, so it would be a permanent lie the moment it was wrong - the
identical defect that had a raw tmux `running` painting 15 sessions busy
on no evidence, one tier further down.

The rungs, in order. Each names what it MEASURED.

| Rung | Evidence | Answers |
|---|---|---|
| A | `sessions.activity_state` / `activity_state_at` for THIS instance | that state, if `restore_state` still trusts it |
| B | the last decidable record of the bound transcript | `idle` when it ends a turn; nothing otherwise |
| C | a bare shell pane | `idle` already, before this ladder is reached |
| D | everything else | `unknown`, which is a real answer |

**Rung A is read on the full instance triple**, `(tmux_socket, tmux_name,
tmux_created_epoch)` - byte-for-byte the WHERE clause
`activity_persist.write_state` writes on. A tmux name is reused the moment
its owner dies, so two rows can carry one name at once, and a name-scoped
read answers for whichever epoch sorts newest, which is a different
question. No epoch means no instance was identified, and that is refused
outright rather than guessed at. A stale PERISHABLE state
(`working`/`question`/`notice`) is refused; a stale `idle` or
`finished_unread` is kept.

**Rung B walks the tail BACKWARDS and stops at the first decidable
record**, so the newest evidence wins. An old end-of-turn can never
outrank a newer prompt - the same ordering the startup gate uses when it
reads a hook before it reads the scrollback, and for the same reason: old
evidence is stale evidence. It reads through the one bounded reader this
codebase has, `claude_title_sync.read_tail_records` (64 KB, 0.27 ms median
against the real corpus).

Three record shapes end a turn: `system`/`turn_duration`,
`system`/`stop_hook_summary`, and an assistant whose `message.stop_reason`
is `end_turn` or `stop_sequence`. A user prompt, a `tool_result`, and an
assistant that stopped on `tool_use` are in flight and seed nothing.
Everything else is UNDECIDABLE and the walk continues - collapsing that
third value into either of the other two is how a ladder starts inventing
boundaries.

**A SIDECHAIN RECORD IS UNDECIDABLE**, and it is the subtle one. A record
with `isSidechain` true belongs to a SUBAGENT running inside the parent's
turn, so its `end_turn` says the subagent finished and says nothing about
the conversation the user is watching. Reading one as rest would paint
idle over the longest-running work there is.

**A SLASH COMMAND IS NOT A PROMPT**, and the live measurement is what
forced that rung. claude intercepts slash commands before they become
prompts - which is why no hook event carries a `/rename` - but it still
writes a pseudo-`user` record about one, wrapped in `<command-name>` /
`<local-command-caveat>` envelopes whose own text says "DO NOT respond to
these messages". Read as prompts, those pinned two sessions at in-flight
forever while both sat at an empty `>`. They are now UNDECIDABLE, not
rest: the walk continues to a boundary claude really wrote, so a slash
command can never manufacture an idle either.

**Where it is wired.** Warmed at the end of the boot re-adopt
(`session_boot_readopt.py`, beside `sweep_live_sessions`) and after
`POST /sessions/adopt`, so the FIRST listing after a restart is already
right. Applied at the one seam in `SessionManager._session_info_for`,
reached ONLY while the answer is still `unknown` and the pane was measured
LIVE - so a seed can add an answer and can never overwrite a measured one.

**A live hook always wins, immediately.** The seam is gated on
`SessionActivityTracker.hooks_seen`, so the first hook event of the
process retires the seed for good: there is no expiry to wait out and no
value to clear. That gate is also what makes seeding idempotent. A seed is
a cached READING of durable evidence, not an event applied to a state
machine, so re-deriving it any number of times converges on the same
answer - unlike the hook consumers, which had to be made idempotent by
hand.

**The periodic re-seed, and its one honest direction.** A hand-started
claude has no hook plumbing at all, so its light would freeze at whatever
the first seed said for the life of the process. The seam re-derives rung
B every `SEED_REFRESH_INTERVAL_SECONDS` (60s; about 6ms a minute for a
fleet of twenty). Re-deriving can move a session from `idle` back to
`unknown` when the transcript grows an in-flight record, which is correct:
a growing transcript is evidence the rest claim has expired, NOT evidence
of work. Polling a file more often does not make it a heartbeat. A session
with live hook signal is never re-seeded.

**Measured read-only against the live database and the real corpus before
this shipped:** all 15 of the sessions painting `unknown` would read
`idle`, every one of them via rung B, dated by its own transcript - the
oldest 2026-04-23, the newest 2026-09-08. Per-session cost 0.27ms median,
1.09ms max. The negative control that matters is separate, because a
matcher that always finds something is worse than useless: over 400
randomly sampled transcripts the ladder splits 172 `at_rest` / 70
`in_flight` / 158 `no_marker`, so it demonstrably refuses.


## Unread

ONE FLAG, TWO WRITERS. The owner's rule, verbatim: "when clicking a tab,
the session is marked read. if i want it unread i click unread. it allows
me to know whats waiting." So `auto` and `manual` are two writers of the
SAME user-visible state, not two states.

**Set** on `Stop` (the `auto` flag), and by the user's explicit control
(the `manual` flag). A session is unread if either is set.

**Cleared**, BOTH sub-flags together, by either of two events: a WS
terminal binding to the session (`SessionManager.mark_session_viewed` -
the strongest "the user is looking at this" signal the server has), or
the user clearing the control (`PATCH /sessions/{name}/unread` with
`false`). Both go through `UnreadStore.clear`, which drops the pair in
one write.

The manual flag used to survive being viewed, on the theory that a
followup pin outranks a glance. The owner's rule is the opposite and the
simpler contract: opened means read. And clearing only the half the user
happened to have set would leave a `Stop`-flagged row unread while the
control the user just clicked reported itself off - a dead control.

**Stored** server-side, not in `localStorage`, because the user drives
this from a phone and a desktop and the flag has to follow them.

### One flag, one key, or it is two flags

THE EPOCH COMES FROM TMUX AND NOTHING ELSE, and since 2026-09-09 it comes
through exactly one function. `src/core/unread_identity.py` owns the
question; `SessionManager._unread_epoch` is the only caller in that file,
and the set (`Stop`), the other set (the manual control), the clear
(`mark_session_viewed`) and the read (`_session_info_for` and the
attachable listing) all go through it. Two derivations for one key is two
keys the moment they disagree, and a clear that lands on a key nobody
wrote leaves a flag no click can ever clear while every layer in between
reads correct.

The two answers it deliberately refuses are the ones that used to compete
with it. `_instance_epochs` is keyed by session_id and seeded from the
create / adopt / boot-readopt paths out of the DATABASE ROW, so it is
empty for every session predating the process and otherwise answers "what
did this process decide when it first saw this handle", not "what does
tmux say now". A row's recorded epoch answers what the epoch WAS when the
row was written. Only the live listing answers the question the key asks.

The memo behind `unread_identity.resolve_epoch` is a MEMO OF THAT
MEASUREMENT, not a second source: every value in it was read out of a tmux
listing, it is keyed by tmux NAME rather than by session_id, and every
listing the manager performs refreshes it (`remember` / `remember_listing`),
so a recycled name cannot keep its predecessor's epoch for longer than one
poll. A probe is spent only on a miss, which is what keeps this callable
from the hook path. A failed probe changes nothing - a transient tmux
failure is not evidence an epoch moved - and an unmeasurable epoch
degrades to the legacy bare-name key rather than minting a second entry.

### Opening the tab only marks it read if a WebSocket actually opens

The clear hangs off the WS bind, so anything that stops the socket from
opening stops the session being marked read. Measured on live 2026-09-09:
a session entered in a BACKGROUNDED browser tab never opened one at all.
`TerminalController.connectWebSocket()` awaited
`waitForFontsAndLayout()`, which ended on two bare
`await new Promise(requestAnimationFrame)` calls, and a browser does not
run rAF for a tab it is not painting. The connect suspended inside that
await, before `openWebSocket()` - and because no socket existed there was
no `onclose`, so no rung of the auto-reconnect ladder could fire either.
The terminal sat on "Connecting to terminal..." (the string set on the
line above the await) and the row kept an unread halo nothing could
clear. The suspended connect completed the instant the tab was painted,
35 minutes later.

FIXING ONE OF THEM WAS NOT ENOUGH, and only re-verifying on live caught
it. `reconnectToExistingSession` (the sidebar row click) and the adopt
branch of `connectToSession` each carried their own bare double-rAF
await, and both sit ABOVE the `setTimeout(() => this.connectWebSocket(),
500)` in the same async function - so the connect was not merely
suspended, it was never SCHEDULED.

`client/js/terminal-layout-wait.js` is the rule now: a layout wait may
DELAY a connect, never CANCEL one. Every wait there is raced against a
timer, because `setTimeout` fires in a background tab and rAF does not,
and a timed-out wait is reported rather than thrown - the caller connects
on the geometry it has and the resize handshake corrects the grid on the
first real paint, the same path a rotation already takes.

### The key is the INSTANCE

`src/core/unread_store.py` keys on `<tmux_name>@<#{session_created}>`.

Keyed on the tmux NAME alone, a flag set on a killed session reappeared on
the next session to take that name, pointing the user at a `Stop` that
happened in a conversation that no longer exists. Keyed on `session_id` it
would not survive a detach. The creation epoch is what separates two
instances of one name, and it is the same identity rule
`sessions.tmux_created_epoch` uses throughout `src/core` - reused, not
re-invented.

A restart in place keeps the flag: `respawn-pane -k` replaces the pane's
PROCESS, while `#{session_created}` belongs to the SESSION and does not
move (measured on tmux 3.7c). So the flag survives exactly the operation
the user thinks of as "restart" and is dropped exactly when the session is
genuinely a new one.

An epoch that could not be measured is an UNKNOWN instance, not a new one.
It composes to the bare name, which is also the legacy key shape, so an
unmeasurable epoch degrades to the old behaviour instead of minting a
second entry. A store written before the re-key still answers, and
migrates to the composite key on the next write rather than being
duplicated.

## The LED: two independent dimensions

`client/js/status-led.js` and `client/css/status-led.css`.

One flat dot had to answer two questions at once - what is the chat doing,
and does it want my attention - and could not. `finished_unread` exists as
a whole extra state only to say "done, and also unread", and there was no
way at all to say "working, and also unread". Two rings say both.

**Inner dot** (`data-inner`), the chat's own status:
`working`, `waiting-permission`, `waiting-input`, `idle`, `done`, `dead`,
`unknown`.

`idle` was added 2026-09-09. Owner's report, verbatim: "i need the lights
to go idle, (i think thats gray) when i click on a tab. there needs to be
a read/idle color." Before this, a session that had been read (server
`activity_status: 'idle'`) painted the same green `done` fill as one that
had NOT (`finished_unread`) - only the outer ring told them apart, which
is too subtle to register at a glance. `idle` is a neutral grey
(`--led-color-idle`), a solid dot (not the hollow `unknown` treatment -
one is a measurement, the other is the absence of one), and pairs with
outer `off` so a read session reads as calm and at rest rather than as a
dimmer copy of `done`.

**Outer ring** (`data-outer`), activity and attention:
`active` (breathing), `steady` (lit, still), `unread` (its own hue,
breathing), `off` (no ring at all - dead, or read-and-at-rest), `dim` (not
measured).

They are set separately and every combination renders. No rule in the
stylesheet reads one to decide the other.

### One element, and why there is no pseudo-element

BOTH RINGS ARE PAINTED ON ONE SPAN. The inner ring is its
`background-color`; the outer ring and its glow are two layers of ONE
`box-shadow` on that same span - a hard `0 0 0 var(--led-ring-width)`
spread ring, then a blurred layer beyond it. There is no `::after`, and
there may not be one.

The halo WAS an `::after`, and that is what the owner kept seeing. A box
gets its position and its size pixel-snapped by the layout engine, and
snapped independently of its parent's box, so whenever the dot itself
landed on a fractional x or y - routine inside a flex row, or wherever a
text baseline puts an inline box on a half pixel - the halo's box rounded
one way and the dot's rounded the other, and the two circles came apart by
a device pixel. Giving the halo a single symmetric `inset` (2026-09-08)
fixed its own INTERNAL symmetry, so its left and right offsets could no
longer disagree, and did not fix this at all: the drift was BETWEEN TWO
BOXES, not inside one. The owner's report after that shipped, verbatim:
"the circles are still not lining up properly. can we do the same with
only one icon?"

A box-shadow is not a box. It is painted from the element's own border box,
at that box's own subpixel position, so it cannot be snapped to a different
grid than the fill it surrounds. Concentric stops being something a rule
arranges and becomes the only geometry available. Nothing in this component
may reintroduce a second box, and nothing may take it out of flow.

TRANSPARENCY LIVES IN THE COLOUR, NOT IN `opacity`. The old halo was its
own element and could carry its own `opacity` without touching the dot. One
element cannot - `opacity` would fade the state colour at the centre too -
so every alpha is mixed into the shadow's own colour with
`color-mix(in srgb, <hue> <alpha>, transparent)`, which this app's
stylesheets already use. Hue and alpha stay separate tokens
(`--led-ring-ink`, `--led-ring-alpha`, `--led-glow-alpha`) so a theme can
restyle one without the other.

THE HOLLOW `unknown` RIM IS A SHADOW LAYER, NOT A SECOND DECLARATION.
There is one `box-shadow` property on the element and the outer ring needs
it, so an inner-state rule declaring its own would silently erase the outer
ring for that one state and the two dimensions would stop being
independent. `--led-inset-ring` carries it as a layer instead, defaulting
to a no-op `inset 0 0 0 0 transparent` so the layer count never changes.
For the same reason `off` zeroes the ring and glow ALPHAS rather than
setting `box-shadow: none`, which would take the rim with it.

THE LEGACY REFEREE MAY NOT RESET `box-shadow`. `.status-dot.status-led` is
two classes and beats every rule in the component, so a reset there would
blank the outer ring on every LED in the app. The legacy shadows it used to
cancel are single-class rules in `status-dot.css`, which loads BEFORE
`status-led.css`, so source order already handles them. Its `animation`
reset survives, scoped off the two breathing states with `:not()` - a
blanket reset ties with the breathing rule at (0,2,0) and wins on order,
which would kill the pulse everywhere.

### The mapping

`StatusLed.ledStateFor({activity_status, unread, startup_gate})` is the
ONE place the server vocabulary becomes a pair of rings.

| activity_status | startup_gate | unread | inner | outer |
|---|---|---|---|---|
| `dead` / `stopped` | any | any | `dead` | `off` |
| any | `awaiting_startup_prompt` | any | `waiting-input` | `active` |
| `question` | any | any | `waiting-permission` | `active` |
| `notice` | any | any | `waiting-input` | `active` |
| `working` / `working_subagent` / `running` | any | no | `working` | `active` |
| `working` / `working_subagent` / `running` | any | yes | `working` | `unread` |
| `finished_unread` | any | any | `done` | `unread` |
| `idle` | any | no | `idle` | `off` |
| `idle` | any | yes | `done` | `unread` |
| `unknown` / absent / unrecognised | any | no | `unknown` | `dim` |
| `unknown` / absent / unrecognised | any | yes | `unknown` | `unread` |

Order matters: `dead` outranks everything (an unread flag must not paint a
corpse as something to go and read), then anything blocking on the user,
then activity. `unread` rides the OUTER RING independently of all of it.

THE `idle` + `unread: true` ROW IS DEFENSIVE, NOT NORMALLY REACHABLE. The
server flips a session to `finished_unread` the instant it goes unread and
back to `idle` only once it has been read, so a well-formed row never
carries both at once. If one ever arrives contradictory, the row renders
identically to `finished_unread` (`done` / `unread`) rather than the grey
`idle` dot - the unread flag is the louder, more urgent claim, and
`session-status-summary.js`'s group rollup depends on this: its `unread`
bucket always renders as `{inner: 'done', outer: 'unread'}`, so a row that
disagreed with that fixed pair would make the header lie about its own
child (`tests/test_status_summary.node.mjs`, "a single-child group renders
the same LED state as that child").

THE SIGNALS ARGUMENT IS NOT OPTIONAL AT A CALL SITE THAT HAS A ROW.
`SessionStatusUI.dotHtml(status, signals)` takes `unread` and
`startup_gate` as a second argument because a bare status string cannot
express either, and until 2026-09-08 no live caller passed it. The flag
reached the row, was fingerprinted by both repaint signatures and forced a
repaint - and was dropped at the last inch, so an `idle` unread session
painted a `steady` halo and a `working` one painted `active`. Only
`finished_unread` looked right, and only because that status string
hardcodes the halo. `tests/test_unread_led_one_field.node.mjs` renders one
`/sessions/list` row through the sidebar row, the launchpad card and the
project-tree row and fails if any of the three disagrees.

Both inner waiting states are reachable from live data as of 2026-09-08.
`waiting-permission` is `question` and nothing else - the agent is
stopped. `waiting-input` is `notice` OR the startup gate, which is the
right pairing: both mean "come and look", neither means "approve this".

`waiting-permission` has its own hue, `--led-color-permission`, resolving
to the existing `--color-status-pending` (`#ffa500`). It sits between the
terracotta `--color-accent` that `waiting-input` takes (`#d77757`) and
the red `--color-danger` that `dead` takes (`#ff4444`): hotter than "come
and look", and deliberately NOT a red, because a blocked session is not a
dead one and the two lights must never be confusable at a glance. An
existing palette token was chosen over a new value so no theme has to
learn one.

### Motion

`active` and `unread` breathe on a 2s ease-in-out cycle. The keyframes
animate the GLOW LAYER of the box-shadow only - its spread and its alpha,
both off the one `--led-glow-rest` fraction so it shrinks and dims together
and reads as a glow swelling rather than a light flickering. The fill stays
at full strength at every point in the cycle, and the hard ring is
byte-identical at both ends of the animation, so it is the shape that says
where the LED ends.

NOTHING IN THE ANIMATION MOVES THE ELEMENT. No transform, no width, no
margin, no inset - `box-shadow` is a paint-only property, so the dot's own
box is identical at every frame and the LED cannot drift against the text
it sits beside. That is the same guarantee the one-element rewrite bought
statically, held across time. (It costs a repaint per frame rather than a
composited transform; the repainted region is about 16px square, and the
alternative is a second box.)

`steady` is lit and still (reachable today only from the group-summary
rollup's `done` bucket, kept for that fixed pair - see `session-status-
summary.js` - though not currently produced by a single row through
`ledStateFor`). `off` has no ring and no glow, for a dead pane or a
read-and-at-rest one. Under
`prefers-reduced-motion: reduce` the ring and glow stay and the pulse
stops - the base rule already paints the full lit value, so killing the
animation is the whole of it, and the reduced-motion block must NOT restate
the shadow or the two would drift apart. The active/resting distinction
lives entirely in the ring and glow alphas.

The seven state colours (`idle` added 2026-09-09) plus the unread hue are
named tokens declared exactly once, at the top of `status-led.css`. A
theme that wants a different palette redefines `--led-color-*`, never
these rules.

### Sizing

`--led-size` is 9px by default, and every call site in this app actually
renders at that default: the sidebar row (`session-sidebar-rows.js`) and
the launchpad card (`launchpad.js`) both call `dotHtml()` with no `size`,
so neither passes a per-instance override.

The ring and glow are FLAT PIXEL VALUES around that dot, not fractions of
it, because at this size a flat value reads truer than a proportional one.
`--led-ring-width` (1.5px, widened from 1px on 2026-09-09 - owner's ask:
"lets make the border a little larger") is the hard ring: a zero-blur
spread shadow, so the lit ring's outer diameter is exactly
`size + 2 * width`, which at the 9px default is 12px (was 11px) - three
pixels larger than the dot, and still an INTEGER, so the ring's outer edge
lands on the pixel grid whenever the dot's does.

`--led-ring-feather-blur` (1px) and `--led-ring-feather-fraction` (0.35)
answer the same request's second half - "can we feather it". A hard
`0 0 0 <width>` shadow is a knife-edge: fully the ring colour one device
pixel, fully transparent the next. The feather is a SECOND shadow layer at
the SAME spread as the hard ring (so its own unblurred edge sits exactly
on the ring's outer edge) but blurred and at a fraction of the ring's own
alpha, so the transition happens over a few pixels instead of one. The
fraction multiplies `--led-ring-alpha` rather than carrying its own value,
so it goes to zero automatically wherever the ring does (`off`) - the same
trick `--led-glow-rest` already uses for the breathing trough, reused
rather than re-invented. The feathered ring's own visible reach is
`width + feather-blur/2` = 1.5 + 0.5 = 2px past the dot's edge, comfortably
inside the owner's "about 4px past the dot" ceiling for the ring alone.

`--led-glow-blur` (6px, raised from 4px on 2026-09-09) and
`--led-glow-spread` (1.5px, held fixed) are the soft halo beyond both ring
layers; a blurred shadow reaches `spread + blur/2` past the border box, so
4.5px (was 3.5px), and the whole lit object fades out by about 18px across
(was 16.2px). Raising the blur alone, with the spread untouched, spreads
the SAME amount of light over a wider fade - which is what reads as
"softer", the owner's word, rather than "bigger": a spread increase would
have made the glow read as a larger solid disc instead. The 1.8px growth
in the lit object's overall reach is the documented, accepted cost of that
softer edge, not a silent regrowth of the "glowing is still too big"
problem this geometry originally fixed.

`--led-halo-scale` and `--led-halo-inset` are RETIRED. They sized and
positioned a box that no longer exists.

The owner's original calibration (2026-09-08): "glowing is still to big.
like 1 or 2 px larger than the front circle" - the halo ring itself reads
as only a couple of px bigger than the dot, with the glow adding a further
1-2px on top. Two earlier configs are worth knowing if you are tracing a
regression: 1.7x scale / 0.3x spread (shipped earlier the same day) put
the lit object at about 21px across, still visibly larger than "1 or 2px
more"; before that, 2.6x scale / 0.62x spread put it at about 35px across
at the peak - larger than the row text itself and overlapping neighbours
on the compact sidebar density and on the launchpad cards, which is what
the owner meant by "the breathing is way too big" the first time. The
breathing keyframes move the glow's spread between `--led-glow-rest` (0.4)
and 1 of its resting value - never past it - so the geometry tokens above
are the true maximum rather than a floor the animation overshoots. The
ring and its feather do NOT breathe at all; both are held byte-identical
across the animation, restated in full at both keyframes because a
box-shadow animation interpolates layer by layer.

There is one set of geometry tokens, not one per surface, because every
surface that renders a LED today renders it at the same 9px size. A
surface that needs a different size passes `size` to `ledHtml()` (see
`client/js/status-led.js`), which sets `--led-size`. Note the ring and glow
do NOT scale with it - they are flat pixel values - so a much larger LED
reads as a thinner ring. That is deliberate at the sizes in play and would
need revisiting if a surface ever shipped at, say, 36px.

### Rolling a group up

`client/js/session-status-summary.js` folds a set of sessions into one LED
plus an unread count. Priority: **permission > input > working > unread >
done > idle > dead > unknown**.

`permission` is a session stopped on a yes/no; `input` is one that wants
the user's eyes (a `notice`, or a startup prompt nobody has answered)
without being stopped. Permission leads because it is the only bucket
guaranteed to make no progress at all until a human acts - a header that
hoisted a chatty notification over a parked session would point the user
at the wrong row. Both outrank working because they are about the user
and will stay that way; working resolves on its own. `idle` (added
2026-09-09) sits below `done` - `done` here means "unread", the louder of
the two rest states - and above `dead`, so a group with one unread and ten
read-and-idle sessions still bubbles unread, and a group of nothing but
idle sessions reads idle rather than falling all the way to unknown. Dead
sits BELOW both deliberately - a group with one corpse and nine busy
sessions must not read as dead. An EMPTY group is `unknown`, not `done`:
nothing to measure is not the same as measured-and-quiet.

Each child is bucketed from the LED state it already resolved to, not from
its raw `activity_status`, so a header cannot disagree with the rows under
it.

## A silent degradation worth knowing about

A hook POST with a stale token is rejected at
`src/api/routes.py` and logged as `hook_post_rejected_invalid_token`.
Nothing surfaces it to the user. The session then has no hook signal at
all, falls into the tmux tier above, and its light goes quiet - which
looks exactly like a session that is genuinely idle.

Measured 2026-09-08 in the live server log: 4,325 rejections from
`adopted:cloude_Agent_-_Cloude_Code` and 364 from `ses_68c185ce`, whose
run was on 2026-08-28 and whose pane is long gone.

**The cause was a MINT LANDING ON A RUNNING AGENT, and it is now
recoverable.** `_mint_hook_token` REPLACES the token held for an id. The
same value was baked into the pane's environment at `new-session` time
and is read from there at hook-fire time, so it is fixed for the life of
that process and cannot be re-issued to it: the agent keeps presenting a
credential the store has moved on from, with no retry and no error
surface. Traced to the millisecond - an adopt registered the live pane
under a derived id and minted at 16:16:40.633984Z, and the first
rejection for that id was logged at 16:16:40.763005Z, 130 ms later. The
same id had been ACCEPTED minutes earlier (`toast_recorded` 16:11:28Z,
16:12:56Z), which is what makes this a rotation rather than a
misconfiguration. It ran for 4h24m and ended only when the owner
restarted the pane by hand at 20:40:23Z, so a new process inherited the
current environment.

Two changes close it. `src/core/hook_token_recovery.py` keeps a bounded,
in-memory ring of tokens this process minted and then superseded; when
the route's ordinary validation rejects, `recover_hook_token` accepts a
token ONLY if this server minted it for THAT id on THAT pane and
replaced it, re-binds the store to the value the running process holds,
logs `hook_token_rebound_from_superseded` once, and NEVER mints. A token
matching nothing still rejects, and so does one superseded on a
different pane. Separately, the respawn path and the boot re-adopt now
push the current control variables onto the pane's session environment
BEFORE a new process starts, because tmux copies that environment at
spawn - a write afterwards reaches the next restart instead of this one.

Two bounds worth stating. The ring is in memory only, so a mint followed
by a server restart is not recoverable this way (the restart has its own
answer: the store is reloaded and the boot re-adopt re-keys the pane to
the id its agent presents). And the SURFACING gap is still open: nothing
tells the user that a session's hooks are being rejected, so one that
stays broken still falls to the tmux tier and looks calm. The honest
treatment there is `unknown` with a reason.
