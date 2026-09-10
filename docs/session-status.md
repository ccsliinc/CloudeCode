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

### The legend, in one place

**THE DOT IS THE STATE AND WHETHER IT HAS BEEN READ; THE RING IS
ACTIVITY.** Green `done` means finished and unread, grey `idle` means
finished and read, and only a session with something RUNNING in it
breathes. See "The LED: two independent dimensions" below.

The words a user reads live in `STATUS_LABELS`
(`client/js/session-status-ui.js`) and nowhere else; every surface gets
them through `dotHtml`, so they cannot drift between the sidebar, the
launchpad and the terminal header.

| state | tooltip |
|---|---|
| `question` | waiting for permission |
| `notice` | wants your attention |
| `working` | working |
| `working_subagent` | working - a subagent is active |
| `finished_unread` | done - unread |
| `idle` | idle - read, nothing running |
| `dead` | dead - process exited |
| `unknown` | not measured |

`idle` used to read "idle - waiting at the shell", which was wrong about
four fifths of the sessions it described: measured 2026-09-09, 15 of 19
live panes were running claude, not a shell. `idle` means the light has
nothing to report - read, and nothing running - and a bare shell is only
one of the ways to get there. `unknown` used to read "status unknown",
which sounds like a fault; it is a measurement that was not taken.

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

**ONE TOAST CARD PER SESSION, and it shows the same thing the LED would.**
Until 2026-09-09 the toast stack coalesced on (kind, session), so one
session produced one card per kind: a "wants your attention" card AND a
"Your turn" card, side by side, about the same session. Measured on the
owner's screen that day, four cards for two sessions plus a "Dismiss all
(9)" row. `client/js/toast.js` now keys the group on the SESSION alone and
`client/js/toast-session-group.js` picks which pending event that card
shows, by READING `SUMMARY_PRIORITY` out of
`client/js/session-status-summary.js` - the same fold, in the same order,
that the sidebar group headers and the launchpad top bar already use.
There is no second ranking; the join is only from a hook event name to
one of that fold's buckets:

| toast kind | bucket | why |
|---|---|---|
| `PermissionRequest` | `permission` | Claude is stopped on a yes/no |
| `StartupPrompt` | `input` | parked on a startup prompt; the same bucket its `waiting-input` LED folds into |
| `Notification` | `input` | wants a look, is not blocked; matches where the `notice` LED buckets |
| `Stop` | `unread` | "your turn": a finished turn nobody has looked at |
| anything else | `input` | an unknown kind is treated exactly as a Notification, never as the least interesting thing |

Severity breaks a tie INSIDE a bucket, so a `StartupPrompt` keeps the card
from a chatty `Notification` and with it the severity-3 cap exemption and
`role="alert"`.

**THE CARD UPGRADES AND CANNOT DOWNGRADE, because the pick is a fold and
not a variable.** A permission prompt landing on a session already showing
"your turn" re-answers the fold on the SAME group key, so the same card
element becomes the permission card; a `Stop` landing on a session showing
a permission prompt changes nothing. Hook events arrive unordered,
duplicated and droppable, and a fold over what is currently held is
idempotent against all three - a running "current worst" variable would
not be.

**THE BADGE COUNTS THE KIND ON THE CARD, NOT THE PILE.** `×5` sits against
the winner's title, so it is read as "this sentence, five times"; a
session holding one permission prompt and six finished turns must not
paint "needs your permission ×7". How many records the x will actually
clear is a different number and the dismiss control states it in words
("Dismiss 7 notifications for this session"). For the same reason the
"Dismiss all" disclosure and the overflow row's worst-severity label count
RECORDS at that severity, never whole groups.

**The attachment receipt is deliberately NOT in this grouping.** It is a
browser-raised card describing what is staged in the prompt buffer, with
no server record, retired by the prompt being SENT rather than by the user
showing up. It keeps its own card, still coalesced per session, so a
session can show one status card and one receipt.

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
| 0 | the transcript AS IT STANDS NOW: its mtime, and its newest turn end | `working` / `finished_unread` / `idle`, and nothing else may |
| A | `sessions.activity_state` / `activity_state_at` for THIS instance | that state, if `restore_state` still trusts it |
| B | the last decidable record of the bound transcript | `idle` when it ends a turn; nothing otherwise |
| C | a bare shell pane | `idle` already, before this ladder is reached |
| D | everything else | `unknown`, which is a real answer |

## Sessions without hook plumbing

**Measured on live 2026-09-09, f77a978: only 6 of 19 live sessions had
ever fired a hook.** The other thirteen were started by hand without the
hook environment, so the state machine above will never hold a signal for
them and their light rested entirely on rung B, which can say `idle` and
nothing else. Three of those thirteen had touched their transcript inside
the previous 36 minutes and painted exactly the same rest as sessions
last touched in July. A session doing work is the one thing a status
light exists to show, and for two thirds of the fleet it could not show
it.

`src/core/session_transcript_status.py` is the ladder that closes it
(pure), with its reads and its turn ledger next door in
`session_transcript_status_read.py`. It is reached ONLY through the seed
seam, which runs only while `SessionActivityTracker.hooks_seen` is False,
so a hooked session is never touched by it: hooks are that session's
truth and the first hook of the process retires the seed for good.

**An mtime is a TIMESTAMP, and that is why rung 0 may claim work when
rung B may not.** The objection above is about the CONTENT of a record,
which says what happened and carries no clock of its own; it is not an
objection to a file's modification time. A claim built on an mtime is
expired by the same `WORKING_HEARTBEAT_TIMEOUT_SECONDS` a hook heartbeat
uses, so a transcript that stops growing stops claiming work within one
window whether or not anything else ever happens. `StatusSeed` carries
`expires_at` and `display_state` refuses a seed whose claim has run out,
which matters because the seed cache holds a reading for up to sixty
seconds - without it, a `working` measured at the end of its window would
be served for another minute.

| Rung | What it measured | Answers |
|---|---|---|
| 1 | the transcript file was written inside the heartbeat window | `working`, carrying an expiry |
| 2 | a turn end NEWER than the one already recorded for this pane | `finished_unread`, and sets the auto unread flag ONCE |
| 3 | the turn end already recorded | `finished_unread` while unread, `idle` once a view cleared it |
| 4 | mid-turn when last written, and that was longer ago than a heartbeat | nothing; the session stays `unknown` |
| 5 | no transcript, or one that could not be read | nothing, and the two are named separately |

**FIRST SIGHT OF A TURN END IS A BASELINE, NOT AN INSTRUCTION.** Rung 2
is written as "newer than the one already recorded", never "not yet
recorded", and that is load-bearing. The turn ledger is in memory, so a
server restart empties it; a first-sighting claim would light every
hookless session on the box unread on every restart, including
conversations that ended in July. The first reading for an instance
records the timestamp and claims nothing. `claude_title_sync` applies the
same rule to a `custom-title` for the same reason.

The ledger is keyed on the tmux INSTANCE (`<tmux_name>@<epoch>`, composed
by `UnreadStore.compose_key` rather than re-spelled), its baseline only
ever moves FORWARD, and only the two turn-end rungs may move it - rung 1
carries a timestamp too, but it is a file mtime and not a turn boundary,
and recording it would push the baseline past turn ends nobody observed.

**Why the gate is `hooks_seen` and not the hook token store.** Membership
in `hook_tokens.json` looks like the stronger gate and is not one:
measured on live 2026-09-09 it holds 33 entries against 19 live tmux
sessions, and every externally adopted pane is in it, because an adopt
mints a token for a pane it never spawned into. A token proves this app
minted one; it does not prove a hook can ever arrive. Gating on it would
have refused the ladder to exactly the sessions it was built for.

## Where a status came from

`GET /sessions/list` carries `status_source` beside `activity_status` on
the WRAPPER. Five values, defined once in
`src/core/session_status_source.py`, in descending strength of evidence:

| Value | Meaning |
|---|---|
| `hook` | Claude Code's own lifecycle hooks are live for this session this run. The agent said what it was doing. |
| `transcript` | Measured off the conversation file: its mtime, or the last decidable record in its tail. |
| `seed_row` | Restored from `sessions.activity_state`, judged still worth something by `restore_state`. |
| `tmux` | tmux alone: a dead pane, a bare shell, or the honest `unknown` a non-shell foreground process earns. |
| `none` | Nothing answered. Said out loud rather than left blank. |

**It is rendered in the tooltip and nowhere else** - `via hooks`, `via
transcript` - by `SessionStatusUI.labelWithSource`. It never changes a
colour, a class or a shape. One status with two appearances would undo
the single vocabulary the light rests on, and a user cannot be expected
to learn a second colour axis meaning "how sure are we". The source is
DERIVED FROM THE RUNG THAT ANSWERED, never from what the caller believed,
so a status and its provenance can only travel together.

## The light in the terminal header

The sidebar row, the launchpad card and the project tree all painted an
LED; the terminal header - the surface on screen the whole time you are
working in a session - showed only the name, so the status of the session
you were IN was the one status you had to open a list to read.
`client/js/session-header-led.js` puts the same light beside the title,
rendered through `SessionStatusUI.dotHtml` rather than its own markup, so
it inherits the two-ring model, the colours and the legend copy and
cannot drift from the other surfaces.

It is fed by the sidebar's own poll (one call site in
`_fetchAndRender`) reading the SAME merged row the list just painted. That
poll runs only while the drawer is open, so the module also arms a
fallback timer at the same cadence which stands down whenever the sidebar
is polling: AT MOST ONE POLLER, EVER. With no session attached it fetches
nothing and removes the light, because a light left under a header that
now names the launchpad is a claim about something that is not on screen.

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

### Read and unread are DERIVED, never stored

`finished_unread` and `idle` are ONE resting state seen through ONE flag,
and which of the two a session is, is decided at resolve time by
`session_status.derive_read_state` - the single function every source runs
through. Two directions, not one: no path may answer `finished_unread`
while the flag is False, and a session at rest whose flag IS set must
answer `finished_unread`.

**MEASURED ON LIVE 2026-09-09 at 5e13cb1.** The owner opened the
daily-briefing tab and nothing changed. `/sessions/list` for
`cloude_daily-briefing` answered `activity_status: finished_unread` beside
`unread: false`, with `status_source: seed_row`: the WebSocket bind had
cleared the flag exactly as designed, and the durable row still held the
word `finished_unread` stamped before the view. The seed path returned it
verbatim and the green dot stayed green over a session that had been read.

Each source had its own half of the rule and one of them had only the half
that ADDS unread. **A one-directional derivation is not a derivation, it
is a cache** - and a cache of a fact that moves is a lie with a timestamp.

The callers, all of them applying the same pure function:

| where | what it derives |
|---|---|
| `SessionActivityTracker.resolve` | the hook path's resting tail |
| `session_activity.map_tmux_fallback` | the tmux-only path (attachable rows too) |
| `session_status_seed.display_state` | the durable row and the transcript seed |
| `session_transcript_status.resolve_transcript_status` | the hookless ladder, rung 3 |
| `SessionManager._session_info_for` | the assembled answer, against the flag as it stands |

`_session_info_for` re-applying it is not belt and braces for its own
sake: the seed path can SET the flag on the way past (a newly measured
turn end), so the assembled answer is derived after that write. The
function is idempotent, so running it over a value a source already
derived cannot change it.

**THE COLUMN HOLDS THE BASE STATE.** `activity_persist.write_state`
collapses the pair back to `idle` on the way into
`sessions.activity_state`, because the flag is durable in a store of its
own and a row that records the projection records an answer nothing
rewrites when the user opens the tab. Rows written before this still carry
the old spelling and are reconciled on read by the same function, which is
why the fix needed no migration.

**THE ONE RUNG THAT IS NOT DERIVED IS THE ONE THAT SETS THE FLAG.** The
transcript ladder's rung 2 has just MEASURED a turn end newer than
anything recorded, and reports `claim_turn_end_at` so the seam writes the
auto flag. Deriving there against the flag as it stood BEFORE that
measurement would answer `idle` about a turn that finished unseen. Every
other rung reads the flag; that one moves it.

### A view clears an open `notice` AND an open `permission`

Both paths route through `src/core/session_view_clears.py` so there is
one definition of what looking at a session resolves.

**Measured on live 2026-09-09: the session named BHPP painted the
terracotta `notice` light for 46 minutes ACROSS A VISIT.** The owner
opened the tab, read it, left, and the light was still asking for
attention. `notice` is set by claude's `Notification` hook (the one it
fires after about sixty seconds of waiting for input), it outranks the
heartbeat, and the only things that cleared it were `UserPromptSubmit`,
`PreToolUse` and `Stop` - all three the AGENT doing something. None of
them is the user showing up, and "come and look at me" is a claim only
the user can answer.

**`question` was deliberately untouched by a view until 2026-09-09, and
what changed is worth keeping.** The old argument: a `PermissionRequest`
means claude is STOPPED until a human answers a yes/no, so it is a fact
about the agent rather than a message to the user, glancing at it does
not answer it, and clearing it on a view would turn the one light meaning
"this cannot proceed without you" into one meaning "you looked at it".
That reasoning is sound and it was still protecting the wrong thing.

**Measured on live 2026-09-09: `cloude_Media_Compression` painted the
permission light over a pane holding no dialog at all**, for over an hour
and across a visit. Its tail read a settings warning, a typed prompt line
and `bypass permissions on`. The flag had been set on session id
`ses_949a8585`, while the claude actually running in that pane was
measured - in its own process environment - to hold
`CLOUDECODE_SESSION_ID=adopted:cloude_Media_Compression`, a spawn-time
value tmux cannot rewrite into a running process. The hook token store
held tokens for BOTH ids against the one tmux name, so nothing was
rejected and no log line looked wrong; the pane's own `UserPromptSubmit`
and both its later `Stop` events simply landed on a different tracker key.
**NOTHING REACHABLE FROM THAT PANE COULD EVER RETIRE THE FLAG.** The
toast path already survives this exact split (it remaps a stale id onto
the live one before it stores or acks); the activity tracker does not.

A claim no observation can retire is not a careful claim, it is a stuck
bit. So the flag now has three retirement paths instead of one: the hook
events that answer it (unchanged, and still the fastest when the ids line
up), the user viewing the session, and the pane being read and found to
hold no dialog.

### An open `permission` is verified against the pane after 20 seconds

`src/core/session_permission_verify.py` is the ladder,
`session_permission_verify_apply.py` the seam that runs it from the
listing pass, before `resolve()` so the corrected flag produces the
status rather than a second place patching one.

While `permission_open` has been set for longer than
`PERMISSION_TAIL_GRACE_SECONDS` (20) on a pane measured LIVE, the listing
pass takes ONE `capture-pane` for that session and looks for claude's
permission dialog. The gate (`should_capture_permission_tail`) is the
same shape as the startup gate's, and for the same reason: in steady
state the set it admits is EMPTY, so a healthy box pays nothing. Do not
move that capture into the unconditional path.

Three outcomes, and only one clears:

| Pane read | Marker | Verdict |
|---|---|---|
| yes | present | keep `question` - the hook was right |
| yes | absent | clear `permission_open`, log `permission_flag_cleared_no_dialog` once |
| no | n/a | KEEP. Not having managed to look is not evidence of absence |

The markers were **measured, not guessed** - a real `claude` on a
throwaway tmux socket with a `permissions.ask` rule in its own settings
file, 2026-09-09, versions 2.1.265 and 2.1.266. Two wordings were
captured because assuming one would have shipped a matcher that misses
the other: the Bash prompt asks `Do you want to proceed?` and the Write
prompt asks `Do you want to create note2.txt?`, so a matcher keyed on the
literal first string answers "no dialog" for every file operation. What
IS identical across both is the option block (`❯ 1. Yes` / `2. No` -
NUMBERED, unlike the trust dialog) and the footer `Esc to cancel · Tab to
amend`. Any of the three keeps the flag.

The direction of error is deliberate. A false positive keeps a flag that
is already set, which costs nothing new; a false negative paints a
blocked session as idle. So the matcher is broad, and the negative
controls in `tests/test_session_permission_verify.py` are the load-
bearing tests - a matcher that always finds something would pass every
positive case and clear nothing, forever. The stamp that dates the claim
is written on the False -> True transition ONLY, so a repeating
`PermissionRequest` cannot push the grace window out indefinitely.

Nothing here can INVENT a permission: only a hook opens this claim, and
the pane may only close it.

No time expiry was added either. The owner's rule, verbatim: "a session
left alone should not go gray. if i dont focus the tab it keeps its
color." A notice is cleared by a person, not by a clock.

Only the READ direction is a view. Marking a session UNREAD is the user
saying "come back to this", which is the opposite of having looked, so it
moves nothing else.

The manual flag used to survive being viewed, on the theory that a
followup pin outranks a glance. The owner's rule is the opposite and the
simpler contract: opened means read. And clearing only the half the user
happened to have set would leave a `Stop`-flagged row unread while the
control the user just clicked reported itself off - a dead control.

**THE CONTROL ITSELF IS OPTIONAL, THE STATE IS NOT.** One line of this
project deleted the mark-unread control from the whole client on the
grounds that the LED's green ring already says a session is unread. The
owner kept it and put it behind a setting instead,
`ui.show_mark_unread_control` in `config.json` (default true, reported on
`GET /api/v1/features`, gated in exactly one place -
`SessionStatusUI.markUnreadHtml` returns `''` and every surface loses it
together). The INDICATOR and the CONTROL are two different things: the
ring says a turn is waiting, the control is how the user says one is.

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
line above the await) and the row kept its unread light with nothing able
to clear it. The suspended connect completed the instant the tab was painted,
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

## Muting a session's notifications

**A mute is a delivery preference, and nothing else.** "mute
notifications" on the session action menu suppresses the ALERTS a session
raises; it changes no status, answers no question, and acknowledges
nothing. The state model above is untouched by it: a muted session still
records every hook event, still resolves to `question` when it is blocked
on a permission prompt, still flips unread on a `Stop`, and still paints
its LED exactly as it would have. What is skipped is the interruption.

**NO CLIENT CONTROL SHIPS ON THIS BRANCH YET, and that is a pending owner
decision rather than an oversight.** Everything described in this section is
server side and reachable only through
`PATCH /sessions/records/{session_uuid}/notifications`. The "mute
notifications" item named above lives in a session row action menu that
release/1.2.1 did NOT take, because that menu also drops restart from a live
row and the owner settled that surface the other way on 2026-09-09 (see
`.claude/TODO.md`, "1.2 merge decisions (owner)", decision 3). Until the
owner rules, a mute can be set by the endpoint and by nothing the user can
click. Do not describe the menu item as present.

| Piece | File |
|---|---|
| The three-value policy, the generation rule, and the in-memory index | `src/core/session_notification_policy.py` |
| The durable columns and their one writer | `src/core/session_store.py` (`set_notification_mute`), schema v26 |
| The web-alert gate | `src/api/routes.py`, in `claude_event_hook` beside the sub-agent gate |
| The external-push gate | `src/core/notifications/router.py` |
| `PATCH /sessions/records/{session_uuid}/notifications` | `src/api/routes.py` |

**It lives on the row, which is the only thing that survives both
restarts.** `sessions.notifications_muted` (schema v26). A server restart
re-reads it at boot; a session restart (`respawn-pane -k`) keeps the row
by construction, because the pane's PROCESS is replaced and the tmux
session, its name and its creation epoch are not. Nothing is backfilled
and nothing copies the column, so existing rows, new sessions and forks
all start unmuted - the absence of a decision on a row IS the answer,
because a mute can only ever be recorded there.

**Two gates, and each has a different job.** The hook route refuses to
RAISE a web alert for a muted session: no toast is recorded and nothing
is broadcast. Because `record_toast` is also what feeds the push router,
that alone stops the external push for hook-driven events - and the
router gates again at drain time, which is where the GENERATION is
checked and where the `IdleWatcher`'s own events are caught.

**`PermissionRequest` IS muted, and this is the one place the mute gate
differs from the sub-agent gate beside it.** That gate exempts permission
prompts because a session waiting on its own background agents genuinely
does still want the user when claude blocks. A mute is the user answering
that in advance, for this session, so exempting a kind from it would mean
the control does not do what its label says. What must NEVER follow is
acknowledging the permission: claude is still stopped mid-turn and the
row still reports `question`. A mute that quietly marked it answered
would strand the agent behind a yes/no nobody was ever shown.

**The generation is a counter, not a clock, and it is what stops a
backlog.** Every policy change steps
`sessions.notification_policy_generation` by one - mute and unmute alike,
because what it dates is the POLICY. A queued notification carries the
generation it was raised under, and the dispatcher refuses anything that
is not current. So an alert raised while the session was noisy cannot
arrive after the user mutes, and unmuting resumes FUTURE alerts without
replaying what was suppressed: the backlog is not held and skipped, it
was queued under a generation that no longer exists. A no-op request does
not step it, or a client re-sending the state it already had would
invalidate live alerts each time.

**A failed policy read never answers "not muted", and that is deliberately
the opposite posture from the sub-agent gate.** That gate FAILS TOWARD
NOTIFYING, because a missed "your turn" is worse than a spurious one and
its silence would be bought with no evidence. Here the user has already
asked for silence, and guessing they did not mean it sends a push to a
phone that cannot be recalled. So the policy has three values -
`muted` / `unmuted` / `unknown` - and `unknown` SUPPRESSES while logging
`notification_policy_unknown` every time.

`unknown` is narrow by construction: it means the ONE bulk hydration
query has never succeeded. A session with no row is not unknown, it is
definitively unmuted, and a missing database FILE hydrates empty rather
than failing - a fresh install has no rows, so nothing can be muted.

**The policy is resolved BEFORE any producer starts.** `src/main.py`
hydrates the store and attaches it to both the router and the
`SessionManager` before `NotificationRouter.start()` and before the app
serves a request. Resolving it lazily would leave a window in which a
muted session's alerts escaped, and the user would learn about it only
from notifications they had asked not to receive.

**Keyed by the INSTANCE, so a reused name cannot be targeted.** The live
gate resolves `(tmux_name, #{session_created})` to the durable
`session_uuid` and reads the policy from that - the same identity rule
unread uses, for the same reason. The name-only fallback is reached ONLY
when the epoch is genuinely unavailable: a known epoch that is absent
from the index answers about that instance and nothing else, so a
successor session cannot inherit its predecessor's silence. The row
action carries the same protection from the other side, as an optional
`expected_tmux_name` / `expected_tmux_created_epoch` on the PATCH body
that answers 409 when the list it was fired from is stale.

**On the wire it is `SessionInfo.notifications_muted`, on the WRAPPER**
(and `SessionRecord.notifications_muted` for rows with no live backend).
It is the DISPLAY answer, so it is True only when the row was read and
says muted: an unreadable policy paints as unmuted while still
suppressing, because painting "muted" would claim a setting is in force
that nobody has looked at.

## The LED: two independent dimensions

`client/js/status-led.js` and `client/css/status-led.css`.

One flat dot had to answer two questions at once - WHAT STATE the chat is
in, and WHETHER ANYTHING IS RUNNING in it - and could not. An agent stopped
on a permission prompt is a live turn making no progress; a conversation
that ended an hour ago and one mid-tool-call are both "not blocked". Two
rings say both.

**THE TWO RINGS ANSWER TWO QUESTIONS.** The INNER dot is the session's
own state. The OUTER ring is activity and attention: breathing means
something is running right now, steady means lit and still, `unread` is
the crisp green finished-turn ring, off means nothing at all, dim means
nothing was measured.

**UNREAD RIDES THE RING, and the owner settled that on 2026-09-09.** Two
lines of this project fixed the same reported defect - a ring pulsing on
sessions with nothing running in them, "the ring around some of the leds
are not gray, which means there should be background tasks. i dont think
those few have any background tasks" - and fixed it in opposite ways. One
retired the outer `unread` state and moved unread onto the inner dot; the
other KEPT the ring, stopped it breathing, and made it a still green. The
owner chose the ring. MOTION is what carries the original complaint now:
`active` is the only state that animates, so a light that MOVES is a
session that is moving, and a resting session's ring takes its own dot's
grey. Do not reintroduce the inner-dot-unread model - it was decided
against, not forgotten.

**Inner dot** (`data-inner`), the chat's own status:
`working`, `waiting-permission`, `waiting-input`, `notice`, `idle`,
`done`, `dead`, `disconnected`, `unknown`.

`idle` was added 2026-09-09. Owner's report, verbatim: "i need the lights
to go idle, (i think thats gray) when i click on a tab. there needs to be
a read/idle color." Before it, a session that had been read (server
`activity_status: 'idle'`) painted the same dot as one that had not, and
only the ring told them apart. `idle` is a neutral grey
(`--led-color-idle`), a SOLID dot - not the hollow `unknown` treatment,
because one is a measurement and the other is the absence of one - and it
pairs with a steady ring in that same grey. So opening a tab changes two
things at once: the green ring becomes grey, and the recessed centre
becomes a solid grey dot.

**Outer ring** (`data-outer`), activity and attention:
`active` (breathing - something is running), `steady` (lit and still),
`unread` (a crisp, still green ring around a recessed centre), `off` (no
ring at all - a dead pane, or a transport we have lost), `dim` (not
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
reset survives, scoped off the one breathing state with `:not()` - a
blanket reset ties with the breathing rule at (0,2,0) and wins on order,
which would kill the pulse everywhere.

### Five colours, nine states

Asked for on 2026-09-08, in the owner's words: "if the session is fully
stopped waiting for a response, then yellow. if it's still working but
needs something from me, make it light blue", over "red if the connection
is disconnected, grey if the session is idle, green if there is activity",
plus "finished turn waiting on me to look at should be a green outline and
grey filled dot". The grey fill was withdrawn on 2026-09-09 - see the
cleared centre below - and the quote is left whole because the ask it
records is still the ask.

The nine inner state NAMES stay nine (`idle` joined them on 2026-09-09). Only the paint collapses onto
five hues, and the accessible label still says which state it is, because
colour was never allowed to be the only signal here.

| colour | states | token |
|---|---|---|
| green | `working`, `working_subagent` | `--led-color-working` -> `--color-success` |
| yellow | `question`, `awaiting_startup_prompt` | `--led-color-permission` / `--led-color-waiting` -> `--color-warning` |
| light blue | `notice` | `--led-color-notice` -> `--color-info` |
| grey | `idle`, `done`, `unknown` | `--led-color-idle` / `--led-color-unknown` -> `--color-fg-muted` |
| red | `dead`, transport disconnected | `--led-color-dead` / `--led-color-disconnected` -> `--color-danger` |
| green ring, cleared centre | `finished_unread` | `--led-color-unread` ring, `--led-fill: transparent` |

Four things about that table are load-bearing.

**Yellow is STOPPED, light blue is NOT.** `question` is a
`PermissionRequest` that halted the agent mid-turn; the startup gate is a
pane parked on the folder-trust dialog. Both are fully stopped and the
user's answer to both is the same, so they paint the same yellow and keep
separate names and separate labels. `notice` is a `Notification`: the
agent is still working and merely wants a look. That is the
`question` / `notice` split of earlier the same day, now visible on the
light rather than only in the data.

**Light blue has to survive red-green colourblindness.** Under both
protanopia and deuteranopia the green (`#4ade80`) desaturates toward a
pale yellow-khaki while a blue at this wavelength (`#4fc1ff`) stays
plainly blue. A third warm hue would have failed that.

**Grey at rest and grey unmeasured are told apart by SHAPE.** `idle` and
`unknown` take the same hue on purpose - neither is interesting to look at
and neither may be dressed up as a measured healthy state - and `unknown`
is drawn hollow. Colour would have ranked them; shape does not.

**THE TWO HOLLOW LIGHTS SHARE ONE RECIPE.** `unknown` and the
finished-turn ring both clear the centre of the dot so the row background
shows through, and they do it in a single rule naming both states
(`--led-fill: transparent` in `status-led.css`). That is the owner's
2026-09-09 correction: the ring shipped with a mid-grey FILLED centre and
read as two lights stacked, and the ask was "it should look like the
'status not measured' dot, but the outline should be green instead of
light grey with the dark grey center". Two copies of "clear the middle"
would be free to drift into one state showing the real background and the
other showing a grey somebody picked, so the count of that declaration is
asserted in `tests/test_status_led.node.mjs`. The two are told apart by
HUE ALONE - a grey 2px rim on the 9px dot for `unknown`, the same 2px
rim in green for the ring - never by the centre. Same construction, one
different token, which is precisely what the owner asked for.

The permission orange this replaced (`--color-status-pending`, `#ffa500`)
sat too close to the red the dead light takes. At nine pixels an orange
and a red in the same list read as one colour.

### The envelope ICON is gone, the control is not

`finished_unread` used to be carried by an unread ENVELOPE ICON beside the
row name on the sidebar and the launchpad. That icon is gone and the green
ring is what says it now: one fact, one indicator, in one vocabulary.

THE MANUAL CONTROL IS A DIFFERENT THING AND STILL SHIPS. The ring SAYS a
session is unread; the control is how the user MAKES one unread, which is
the owner's rule verbatim - "if i want it unread i click unread". It lives
in the row's kebab menu and on the launchpad card, behind
`ui.show_mark_unread_control` (default true). Unread TRACKING is untouched
either way: `src/core/unread_store.py` still keys on the instance, `Stop`
still sets it, binding a WS terminal still clears it, and
`PATCH /sessions/{name}/unread` still exists and is still called.

### The mapping

`StatusLed.ledStateFor({activity_status, unread, startup_gate, transport})`
is the ONE place the server vocabulary becomes a pair of rings.

| transport | activity_status | startup_gate | unread | inner | outer |
|---|---|---|---|---|---|
| `disconnected` | any | any | any | `disconnected` | `off` |
| other | `dead` / `stopped` | any | any | `dead` | `off` |
| other | any | `awaiting_startup_prompt` | any | `waiting-input` | `active` |
| other | `question` | any | any | `waiting-permission` | `active` |
| other | `notice` | any | any | `notice` | `active` |
| other | `working` / `working_subagent` / `running` | any | any | `working` | `active` |
| other | `finished_unread` | any | any | `done` | `unread` |
| other | `idle` | any | no | `idle` | `steady` |
| other | `idle` | any | yes | `done` | `unread` |
| other | `unknown` / absent / unrecognised | any | any | `unknown` | `dim` |

Order matters. A dead TRANSPORT outranks everything: nothing we are
showing is fresh once the socket is down, so the light may not keep
asserting the last status it happened to see. Then `dead` (an unread flag
must not paint a corpse as something to go and read), then anything
blocking on the user, then activity, then rest.

`working` does NOT take the unread ring: it is working, and the ring says
so. The unread turn behind it is still counted by the group fold, which
reads the row's own flag rather than the colour of a light
(`summarizeStates`).

THE `idle` + `unread: true` ROW IS DEFENSIVE, NOT NORMALLY REACHABLE. The
server derives this pair from the flag on every path (see "read and unread
are derived, never stored" above), so a well-formed row never carries both
at once. If one ever arrives contradictory, the row renders identically to
`finished_unread` (`done` / `unread`) rather than the grey `idle` dot -
the unread flag is the louder, more urgent claim, and
`session-status-summary.js`'s group rollup depends on it: its `unread`
bucket is inner `done`, so a row that disagreed would make the header lie
about its own child (`tests/test_status_summary.node.mjs`, "a single-child
group renders the same LED state as that child").

THE GROUP HEADER FOLDS THE TWO DIMENSIONS SEPARATELY, for the same reason
a row keeps them apart. Its inner dot is the highest-priority state among
the members (permission > input > working > unread > done > dead >
unknown); its ring is folded across the WHOLE group - `active` if any
member has an open turn, `unread` if none does and something in there is
unread, `dim` when nothing was measured, `steady` for a group at rest that
has been read, `off` otherwise. So a group holding one parked session and
one busy one paints the parked dot inside a breathing ring, which is both
facts at once. ACTIVITY OUTRANKS UNREAD on that ring, because the ring
carries both and only one can be painted: a breathing ring expires on its
own, a green unread ring does not.

It folds the group's member ROWS from the merged list rather than anything
in the DOM - which is what lets a COLLAPSED group, whose rows are
deliberately not in the markup, still report - and those rows spell the
state `status`, not `activity_status`, so
`session-status-summary.js signalsFor()` reconciles the two names in one
place; reading only the server's spelling made every header on live paint
`unknown/dim` at 880247f, an empty group and a group of twelve idle
sessions alike.

THE SIGNALS ARGUMENT IS NOT OPTIONAL AT A CALL SITE THAT HAS A ROW.
`SessionStatusUI.dotHtml(status, signals)` takes `unread`, `startup_gate`,
`status_source` and `transport` as a second argument because a bare status
string cannot express any of them, and until 2026-09-08 no live caller
passed it. The flag reached the row, was fingerprinted by both repaint
signatures and forced a repaint - and was dropped at the last inch, so an
`idle` unread session rendered identically to one with nothing waiting on
it. `tests/test_unread_led_one_field.node.mjs` renders one
`/sessions/list` row through the sidebar row, the launchpad card and the
project-tree row and fails if any of the three disagrees.

Two rows changed with the five-colour pass and both are deliberate.
**A working session is solid green whatever its unread flag says** - the
unread halo is now the green finished-turn ring, and a ring claiming a
turn ended, around a session that is mid-turn, is two contradictory claims
on one light. **`unknown` never takes the ring either**, for the same
reason in its stronger form: the ring asserts that a turn FINISHED here,
and nothing was measured.

### Transport: the one signal the server cannot report

`client/js/session-transport.js`. Every other signal here is a fact about
the session, measured on the Mac and shipped down `/sessions/list`.
"Disconnected" is a fact about the BROWSER: the WebSocket in
`client/js/terminal.js` closed. It is written from `ws.onopen` and
`ws.onclose` and read by `session-sidebar-rows.js` and `launchpad.js` on
their way into `dotHtml`.

This browser holds a socket to at most ONE session, so **every other
session answers `unknown`, never `connected` and never `disconnected`**. A
sidebar full of red because one socket dropped would be exactly the
fabricated-measurement mistake this whole model exists to avoid. A
DELIBERATE close clears the record rather than marking it disconnected:
"you left it" and "we lost it" are different facts and only one is worth
painting red.

`dead` and `disconnected` share the red, so the LABEL is the only thing
separating them, and the two must never be paraphrases: "dead - the
process exited" against "disconnected - no live connection to this
session".

### Motion

`active` is the only state that breathes, on a 2s ease-in-out cycle. The
keyframes animate the GLOW LAYER of the box-shadow only - its spread and
its alpha, both off the one `--led-glow-rest` fraction so it shrinks and
dims together and reads as a glow swelling rather than a light
flickering. The fill stays at full strength at every point in the cycle,
and the hard ring is byte-identical at both ends of the animation, so it
is the shape that says where the LED ends.

`unread` DOES NOT BREATHE, and that is the point of keeping it. An
outline that pulses stops reading as an outline at nine pixels, and the
defect both lines of this project were fixing was a ring pulsing on a
session with nothing running in it. Motion is therefore a signal in its
own right: a light that moves is a session that is moving.

NOTHING IN THE ANIMATION MOVES THE ELEMENT. No transform, no width, no
margin, no inset - `box-shadow` is a paint-only property, so the dot's own
box is identical at every frame and the LED cannot drift against the text
it sits beside. That is the same guarantee the one-element rewrite bought
statically, held across time. (It costs a repaint per frame rather than a
composited transform; the repainted region is about 18px square, and the
alternative is a second box.)

`steady` is lit and still: a session at rest that has been read, its ring
in its own dot's grey. `off` has no ring and no glow at all, for a dead
pane or a transport we have lost - a corpse must not glow. Under
`prefers-reduced-motion: reduce` the ring and glow stay and the pulse
stops - the base rule already paints the full lit value, so killing the
animation is the whole of it, and the reduced-motion block must NOT
restate the shadow or the two would drift apart. The active/resting
distinction lives entirely in the ring and glow alphas.

Every state colour is a named token declared exactly once, at the top of
`status-led.css`, and every one defers to a palette token all of
`client/css/themes` already declares. A theme that wants a different
palette redefines `--led-color-*`, never these rules.

### Sizing

**ONE LIT DIAMETER FOR EVERY STATE.** Everything the component paints, in
any state, fits inside the same circle. States differ in colour, alpha
and fill. They never differ in size.

Under the one-element composition that is true BY CONSTRUCTION rather
than by every state rule remembering to agree: the five geometry numbers
(`--led-size` 9px, `--led-ring-width` 1.5px, `--led-ring-feather-blur`
1px, `--led-glow-blur` 6px, `--led-glow-spread` 1.5px) are declared once
on `.status-led` and **no `[data-inner]` or `[data-outer]` rule may
override any of them**. `unread` is the state that used to break the
rule, by sizing its own halo, and its rule now sets colour, alpha and the
inset rim only.

Every call site renders at the 9px default: the sidebar row
(`session-sidebar-rows.js`) and the launchpad card (`launchpad.js`) both
call `dotHtml()` with no `size`. A surface that needs a different size
passes `size` to `ledHtml()`, which scales `--led-size`.

**Why that had to be written down.** Until 2026-09-09 the halo was sized
per state AND drawn partly outside its own box, so the LIT object came
out at three different diameters while the ELEMENT box measured 9px in
every one of them - which is exactly why no CSS-text test caught it:

| state | halo box | painted outside it | what a reader sees |
|---|---|---|---|
| `active` | 11.69px | a 1.5px spread glow | about 14.7px, saturated |
| `unread` | 15.30px (own override) | nothing | 15.3px ring |
| `steady` | 11.69px | a glow at 0.30 opacity | 9px - grey on a grey dot |
| `dim` | 11.69px | a glow at 0.18 opacity | 9px |
| `off` | 11.69px | nothing, opacity 0 | 9px |

The bottom three are invisible on a real row, so in a sidebar where one
session is working and the rest are at rest, that one dot read about 60
percent wider than its neighbours. That is what the owner reported.

Earlier configurations, if you are tracing a regression: 1.3x halo plus a
1.5px spread glow put the lit object at about 14.7px with a hard-edged
11.7px core; 1.7x/0.3x put it at about 21px; the original 2.6x/0.62x put
it at about 35px, larger than the row text itself. The breathing
keyframes move the GLOW's alpha and spread only, never past the resting
value, so the tokens are the true maximum rather than a floor the
animation overshoots.

`scripts/archive/verify/verify_status_led_geometry.py` measures the
(inner, outer) pairs in a real Chromium, across themes and viewports.
A CSS-text read cannot do that job: the divergence was in what the box
RESOLVES to once a per-state override is composed. Note the script was
written against the pseudo-element construction that preceded the
one-element rewrite; re-read it before trusting a run.

### Rolling a group up

`client/js/session-status-summary.js` folds a set of sessions into one
LED. Priority: **permission > input > working > unread > done > dead >
unknown**.

**The roll-up IS the row component.** `summaryHtml` picks an (inner,
outer) pair and hands it to `StatusLed.ledHtml`, the same builder every
row uses, so a header takes every treatment a row takes - including the
green ring around a cleared centre for a finished turn nobody has read. It
is not a header-shaped dot, and building one would be how the two come to
disagree.

**The ring is folded across the whole group, not looked up on the
winning bucket** (`outerFor`), so a group holding one parked session and
one busy one paints the parked dot inside a breathing ring. Activity
outranks unread there, because the ring carries both and only one can be
painted.

**There is no numeric unread badge beside it.** A yellow `(n)` pill used
to carry the unread count on every group header; it was removed on
2026-09-09 at the owner's request ("to be clear remove the yello (1)")
and nothing replaced it. The ring already says there is something here
for the user, and two indicators for one fact is how two indicators end
up disagreeing. `summarizeStates` still RETURNS `unreadCount`, which is a
measured property of the fold; nothing renders it. The plain count pill
on the header is a different control - it says how many conversations a
folded section is hiding - and stays.

`permission` is a session stopped on a yes/no; `input` is one that wants
the user's eyes (a `notice`, or a startup prompt nobody has answered)
without being stopped. Permission leads because it is the only bucket
guaranteed to make no progress at all until a human acts - a header that
hoisted a chatty notification over a parked session would point the user
at the wrong row. Both outrank working because they are about the user
and will stay that way; working resolves on its own. `idle` (the grey
read-and-at-rest dot) sits below `unread` - the louder of the two rest
states - and above `dead`, so a group with one unread and ten
read-and-idle sessions still bubbles unread, and a group of nothing but
idle sessions reads idle rather than falling all the way to unknown. Dead
sits BELOW both deliberately - a group with one corpse and nine busy
sessions must not read as dead. An EMPTY group is `unknown`, not `done`:
nothing to measure is not the same as measured-and-quiet.

Each child is bucketed from the INNER dot it already resolved to, not from
its raw `activity_status`, so a header cannot disagree with the rows under
it. The unread COUNT is read off each row's own flag rather than off the
colour of a light, so a working session with an older unread turn is still
counted even though its dot says `working`.

**The `input` bucket holds two hues and its RANK did not move.** Since the
five-colour pass, `waiting-input` is yellow (stopped on a startup prompt)
and `notice` is light blue (still working). They stay in one bucket -
that priority is the product decision - but the header has to paint one of
them, so it paints yellow if any member is stopped and light blue when
every member is a notice. A header that painted the stopped yellow over a
group holding nothing stopped would be claiming something nobody measured,
and a header that disagreed with its only child is a bug the suite guards.

`disconnected` buckets with `dead`: they paint the same red and rank the
same way. No group feeds one in today - children come from a REST listing,
which has no socket.

### The key, and why the lights finally have words

`client/js/session-status-key.js` renders a foldable legend at the foot
of the session sidebar. Collapsed by default; the fold rides
`cloude.statusKey.open` in localStorage, the same `cloude.*` convention
the pin and the density preference use, and an unreadable or absent value
means collapsed rather than an error.

It exists because the LED is now the ONLY thing on a row saying what a
session is doing - the envelope is gone and there is no text badge beside
it - and its meaning lives in a `title` nobody hovers on a phone.

**Every swatch is a real LED.** `itemHtml` calls `StatusLed.ledHtml` with
the same (inner, outer) pair the rows resolve to, so the key cannot show
a colour, a size or a shape the app does not paint. A hand-drawn legend
would be a second implementation of the component, and this project has
already paid for two stylesheets drawing one dot.

**SEVEN ROWS, ONE PER LIGHT.** It carried nine until 2026-09-09, one per
inner state, and the owner asked for "one entry per colour": two rows
showed the same yellow and two showed the same red, which sends a reader
looking up a dot on their screen hunting for a difference the light
cannot show them. The rows, top to bottom, in the same urgency order the
group-header fold uses:

| light | row |
|---|---|
| yellow | stopped, waiting on you |
| light blue | still working, but needs your attention |
| green | working |
| green ring | done, unread |
| grey | idle |
| red | dead / disconnected session |
| grey outline | not measured - nothing reported in, so this is not idle |

Green and grey each appear twice and that is not a breach of the rule:
a solid dot and an outline are two different things on screen, which is
exactly what the last row exists to explain. **THE STATE MACHINE DID NOT
CHANGE.** There are still eight inner states, `waiting-permission` and
`waiting-input` still paint one yellow, `dead` and `disconnected` still
paint one red, and the component's own `title` and `aria-label` still say
WHICH of each pair a given dot is. Collapsing the rows made those labels
load-bearing rather than decorative, so
`tests/test_status_key.node.mjs` now pins that the collapsed pairs really
do resolve to one colour in the stylesheet AND that their words still
differ. It also asserts the count, that every hue the component can paint
has a row, and that no two rows draw the same light.

It sits where the sidebar's "N remembered positions are held for sessions
not currently listed" note used to, removed the same day: it named
bookkeeping no reader could act on. **The remembered positions themselves
are untouched** - `session-sidebar-arrangement.js` still keeps those
slots, they still reach the repaint signature, and
`session-sidebar.js` still stamps the count on the list element as
`data-order-missing`. Only the sentence went.

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
