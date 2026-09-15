# Session status: one state model, two rings

What the lights mean, what moves them, and where each fact is stored. This
is the single source of truth for the status model; if code and this file
disagree, one of them is a bug.

## The vocabulary lives in one file

Every status string this app can show is spelled once, in
`src/core/session_status.py`. `src/core/attention/` imports them and owns the
state MACHINE; it defines no string literals of its own, and
`attention/display.py` is the single place a verdict becomes one of those
names. The client mirrors the same set in `client/js/session-status-ui.js`.

## The states

**NOTHING ANNOUNCES A STATE. EVERY ROW BELOW IS A READING**, taken on a
2 second tick and on every listing pass. The app installs no Claude Code hooks
(`docs/DECISIONS.md`, "Zero hooks", 2026-09-13).

| state | what it claims | what is read to get there |
|---|---|---|
| `working` | the agent is doing tool work | the registry says `busy` or `shell` (`attention/registry_read.py`) |
| `working_subagent` | the same, waiting on its own background agents | the turn-end record's `pendingBackgroundAgentCount`, the async-launch ledger, or a queued task notification newer than the last turn end (`attention/transcript_facts.py`) |
| `question` | BLOCKED on the user: a yes/no nobody has answered | the transcript ends on an unanswered `AskUserQuestion` or `ExitPlanMode`, or the registry says `waiting` and the pane shows a dialog |
| `notice` | claude wants attention and is NOT blocked | the registry's `waitingFor` names an elicitation, a sandbox request, a worker request or an open dialog |
| `finished_unread` | a turn ended and nobody has looked | the registry says `idle`, the turn-end record is the last word with nothing pending, the transcript has been quiet 3s, and the unread flag is set |
| `idle` | alive, at rest, already seen | the same reading, with the unread flag clear |
| `dead` | the pane's process exited | tmux `#{pane_dead}` = 1 |
| `unknown` | NOT MEASURED | every refusal: no registry record, a stale one, an unreadable one, two records claiming one pane, or tiers that disagree |

`unknown` is a first-class answer, not a failure mode. "I did not look"
and "I looked and found rest" are different claims and must never render
the same way. The resolver contains no `or 0` and no `||` default for this
reason: a count that was not written is None, None satisfies no rung, and the
session lands on `unknown`, which raises nothing.

### Where each fact is stored

Four tiers, in precedence order. The full rung table is
`docs/session-status-model.md` chart 2; the code is
`src/core/attention/resolve.py`, which is pure and opens no file.

| Tier | The file or query | What it is allowed to answer |
|---|---|---|
| registry | `~/.claude/sessions/<pid>.json`, written by stock Claude Code and rewritten IN PLACE on every status change: `status`, `waitingFor`, `sessionId`, `cwd`, `tmux`, `pid`, `startedAt`, `version` | `busy`, `needs_user`, and it is the ONLY tier that may originate rest |
| transcript | the tail of `~/.claude/projects/<slug>/<uuid>.jsonl`, 256 KB window | background agents pending, a queued re-invoke, an unanswered blocking tool at the end of the file, the newest real user prompt |
| pane | the last block of `capture-pane` text | that a dialog is on screen. NEVER that a session is finished, by any path |
| tmux | `#{pane_dead}` | alive, dead, or could not tell |

Three facts are durable and are NOT in the tiers above, because they are ours
rather than claude's: the unread flag (`UnreadStore`, keyed on the tmux
instance), `sessions.activity_state` with its stamp (`activity_persist.py`,
written on every reading), and `sessions.last_work_at` (the session and project
sort key, stamped on a new user prompt or an edge into busy). The hook token
store also stays: it is our own ledger of which tmux names we launched, read by
the boot re-adopt, and it was never a hook.

**The registry is written ON CHANGE, so silence is not doubt.** A session that
genuinely went idle two days ago carries a two-day-old `idle` stamp precisely
because nothing has happened since. A heartbeat that stops means the writer
died; a write-on-change record that stops means the writer had nothing to say.
Reading the second as the first makes the app LESS certain the longer a session
stays correctly at rest. So an old stamp alone may not defeat rest when the
transcript corroborates it, and a stale stamp that NOTHING corroborates still
refuses (`resolve.py`, rung 8 and the narrowed rule (c)).

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

**Neither is a stored flag any more.** They were two booleans set and cleared
by hook events; they are now two REASONS on a verdict that is re-derived from
disk on every reading. `needs_user(question | permission | plan_approval)`
paints `question`; `needs_user(input)` paints `notice`. Nothing has to be
cleared, because nothing was stored: the moment the evidence stops saying a
dialog is open, the next reading stops saying it too. The whole class of
stuck-flag defect this section used to document is gone with the flags.

**Precedence comes from the rung order, not from reading one boolean before
the other.** An unanswered `AskUserQuestion` or `ExitPlanMode` at the end of
the transcript is rung 2, above both background-agent rungs, so a session
blocked on a question while its agents run answers `question` and not
`working_subagent`. A registry `waitingFor` that only names a soft request is
rung 5c, below the pane confirmation at rung 5.

**Precedence:** `question` outranks `notice` in the same window;
`notice` outranks `working`. A stopped session is the most actionable
thing on the screen, and work that proceeds without the user is the least
of the three.

**The toasts say it too.** The toast presentation titles a
`PermissionRequest` **needs your permission** and a `Notification` **wants your
attention**. The two kinds outlived the hooks they were named after: the
watcher raises a `PermissionRequest` on an edge into
`needs_user(question | permission | plan_approval)` and a `Notification` on an
edge into `needs_user(input)`. The split is only worth
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
There is no second ranking; the join is only from a toast kind to one of that
fold's buckets:

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
a permission prompt changes nothing. Records arrive out of order, more than
once and sometimes not at all - a browser holds two delivery paths for the same
toast, the socket and the poll - and a fold over what is currently held is
idempotent against all three, where a running "current worst" variable would
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
was overruled and reverted (`ba2aa5d`). The real-hook harness that held this
line with a live killed pane went with the hooks; the rule stands as the
owner's ruling and `_session_info_for` still drops the row.

STILL OPEN, and the test records it rather than asserting it:
`remain-on-exit` keeps a husk's tmux SESSION in the listing, and
`src/core/session_lifecycle.py` reaps on ABSENCE from that listing, so the
row leaves the live list without yet arriving in Recent. Closing that
needs a reaper rung keyed on a MEASURED `#{pane_dead}` - a new durable
writer, in the one module whose entire premise is never writing a verdict
nobody measured, so it is its own change and not a footnote to this one.

**A GUESS MUST NEVER OUTRANK A RECORD, AND AN ABSENCE IS NEVER A VALUE.**
This is the rule the whole resolver is built around. Over the 50.8 hours to
2026-09-13T18:24Z, 410 of 459 attributable "your turn" and "session done"
toasts, 89.3 percent, fired while the session's own turn-end record said
background agents were still pending. Every one of them was a missing number
read as zero. The count now comes from
`system`/`turn_duration`.`pendingBackgroundAgentCount`, **which is OMITTED
when it is zero** (measured across 300 turn ends on Claude Code 2.1.266: 236
positive, 64 omitted, 0 null, 0 zero), so absent and zero must be told apart or
the defect comes straight back.

**A SESSION WAITING ON ITS OWN BACKGROUND AGENTS IS NOT WAITING ON THE USER.**
That was the claim the old sub-agent counter was built to make, and it could
not: `CLOUDECODE_SESSION_ID` is a pane-wide environment variable, so the parent
and every background agent posted under one id and the counter was mislabeled
before it was ever incremented. Five passes hardened it and the false rate did
not move. See `docs/LESSONS.md`, "A counter fed by a mislabeled key cannot be
fixed by ordering", and `docs/status-led-history.md` for the hook-era
heartbeat record in full, including the `SubagentStop` ratchet.

**A READING TAKEN AT A BOUNDARY IS NOT A READING.** At the end of a turn the
evidence LAGS: claude writes the turn-end record 25 ms after the model stops
and updates its own status 7 ms after that. At a blocked moment the evidence
LEADS: the `AskUserQuestion` tool call is written before the status moves to
`waiting`. So a verdict that was decided by the pane or by the shape of the end
of the file must be seen TWICE, at least `SETTLE_SECONDS` (1.5) apart, and rest
additionally needs `DONE_QUIET_SECONDS` (3) of transcript silence
(`attention/ledger.py`). A different verdict arriving in between resets the
settle.

**A FLICKER THROUGH `unknown` FREEZES THE ENTRY.** `unknown` is a failure to
observe, not an observation of a different state, so it changes nothing at all:
not the confirmed verdict, not a settle in progress, not what has already been
raised. Without that rule a session answering busy, then unknown for one tick
because a file was mid-rewrite, then busy again, manufactures a second busy
edge out of nothing.

**A persisted state is judged by its age.** `src/core/activity_persist.py`
stamps every write and refuses a perishable state (`working`,
`working_subagent`, `question`) older than the live timeout plus a small grace.
A stale `working` is a lie about right now, so it returns not-measured rather
than the stored value and rather than `idle`.

## The tmux fallback, and the claim it is not allowed to make

tmux is the weakest tier and the only one that can see a pane die. Its
classification maps as follows:

| tmux says | means | maps to |
|---|---|---|
| `running` | the foreground command is not a bare shell | `unknown` |
| `idle` | the foreground command is a bare shell | `idle`, or `finished_unread` when unread |
| `dead` | the pane's process exited | `dead` |
| `unknown` | the query failed | `unknown` |

`running` used to map to `working`, and that was a claim tmux cannot
support. It means only "some non-shell process is in the foreground",
which is equally true of an agent mid-tool-call and one parked at an empty
prompt. The fallback carries no timestamp either, so nothing could ever expire
the claim.

**Measured 2026-09-08 on the reference box:** of 19 live sessions, 15
report a claude VERSION STRING as `pane_current_command` (`2.1.259`,
`2.1.261`, `2.1.263` - the binary renames its own process) and only 4
report `zsh`. So this branch is the common case, not the exotic one an
older note in `session_status.py` assumed.

**WHERE THIS MAP STILL RUNS.** Not on the live status path: chart 2 of
`docs/session-status-model.md` owns that, and a live session is resolved from
the four tiers. `map_tmux_fallback` is now reached only from
`SessionManager.list_attachable_sessions`, whose rows have no running process
bound to them, so there is no registry record and no live transcript to read.
tmux plus the stored unread flag is genuinely all there is for such a row.

**THE ONE VALUE tmux MAY STILL OVERRIDE ON A LIVE ROW IS `dead`.**
`attention/display.py` consults `tmux_status` for exactly that one string, and
only when the verdict is `unknown`. Letting tmux's `idle` through would turn
"nothing readable said anything" into "this session is finished", which is the
false green the whole package exists to remove.

## The transcript seed, and what replaced it

**This tier is retired.** Until 2026-09-13 a session that had never fired a
hook was lit by a separate ladder that re-read its transcript and could claim
rest but never work: `session_status_seed.py`, `session_status_seed_records.py`,
`session_status_seed_store.py` and `session_status_seed_read.py`, gated on
`SessionActivityTracker.hooks_seen`. It existed because most sessions on the box
had no hook plumbing at all - measured 2026-09-09, only 6 of 19 live sessions
had ever fired one - and their lights could not say anything.

With no hooks anywhere, there is no hooked case to be a fallback FROM. Every
session now goes down the same four tiers, and the transcript is one of them
rather than a consolation prize for sessions the hook path could not see.
`session_status_seed_read.read_instance_row` survives as a plain bulk row
reader: the listing pass calls it for `claude_session_uuid` and `working_dir`,
which is how a row's transcript file is located. The status it used to return
is not consulted.

The full record of that ladder, its measurements and the rules it earned lives
in `docs/status-led-history.md`. Two of those rules were kept and moved into
the resolver rather than re-derived, and both are still load bearing:

- **FIRST SIGHT IS A BASELINE, NOT AN INSTRUCTION.** The first reading of an
  instance records what it saw and claims nothing. `AttentionLedger` applies it
  to every verdict, which is what stops a restart from raising a toast for every
  session that has been sitting finished since last night.
- **The key is the tmux INSTANCE**, `UnreadStore.compose_key(tmux_name, epoch)`,
  never the session id. Gotcha 4b and gotcha 10 are both about those two
  diverging.
- **One bounded tail reader**, `claude_title_sync.read_tail_records`, still the
  only one in the codebase. `attention/transcript_facts.py` is built on it at a
  256 KB window for THIS caller alone, because 3 of 9 live transcripts had their
  newest turn-end record beyond 64 KB while mid-turn, and every line is parsed
  under its own try/except so a torn last write costs one line and not the read.

The seed's own rung table, its measurements and its negative controls are in
`docs/status-led-history.md`. Nothing here reads them any more.

## Where a status came from

`GET /sessions/list` carries `status_source` beside `activity_status` on
the WRAPPER. Six values, defined once in
`src/core/session_status_source.py`, in descending strength of evidence:

| Value | Meaning |
|---|---|
| `registry` | `~/.claude/sessions/<pid>.json`, the file claude keeps about itself and rewrites on every status change. The agent's own word, read passively off disk. |
| `pane` | A dialog matched in pane text we actually read. It can only ever say the session is waiting on a human. |
| `transcript` | Measured off the conversation file: its mtime, or the last decidable record in its tail. |
| `seed_row` | Restored from `sessions.activity_state`. The constant stays and the live path no longer writes it: the transcript seed it named was retired on 2026-09-13 with the hooks it was a fallback for. |
| `tmux` | tmux alone: a dead pane, a bare shell, or the honest `unknown` a non-shell foreground process earns. |
| `none` | Nothing answered. Said out loud rather than left blank. |

**`hook` WAS A SIXTH VALUE AND IS GONE.** It meant "Claude Code's own
lifecycle hooks are live for this session this run", and the listing
reported it whenever an in-memory counter fed by those hooks had
answered. `CLOUDECODE_SESSION_ID` is a PANE-WIDE environment variable, so
the parent agent and every background agent it launched posted under one
session id and the counter was mislabeled at its source; the listing now
resolves the four passive tiers above (`src/core/attention/`) and nothing
can write `hook` any more. Both clients keep a `via hooks` tooltip entry
for it on purpose, so a browser holding a response cached from before the
swap still renders correctly.

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
| `attention/display.py::to_display` | the one state a verdict can reach at rest |
| `session_activity.map_tmux_fallback` | the tmux-only path (attachable rows) |
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
attention. `notice` was a flag set by claude's `Notification` hook, and the
only things that cleared it were `UserPromptSubmit`, `PreToolUse` and `Stop` -
all three the AGENT doing something. None of them is the user showing up, and
"come and look at me" is a claim only the user can answer. The flag is gone
(the state is now re-read from the registry's `waitingFor` on every tick, so it
retires itself when claude stops waiting), and the VIEW CLEAR stays: it is what
answers a toast the user has now seen, and it is the user's half of the
contract.

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
bit. The flag it describes is gone: the claim is re-derived from disk on every
tick, so it retires itself the moment the evidence stops saying a dialog is
open. Two of its three retirement paths survive as rules rather than as
clearing code - the user viewing the session, and the pane being read and found
to hold no dialog, which is rung 5's veto.

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
| yes | present | `needs_user`, and the pane is the strongest confirmation there is |
| yes | absent | VETO a registry `waiting` nothing else corroborates, log it once |
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

Nothing here can INVENT a permission: the pane tier may only ever CONFIRM that
a dialog is on screen, and there is no path in `attention/resolve.py` from a
pane read to a finished turn. The verifier is now consulted as rung 5, where a
pane measured clear VETOES a registry `waiting` that nothing else corroborates,
and a pane that could not be read leaves the verdict failing toward the user.

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
poll. A probe is spent only on a miss, which is what keeps this callable from
a per-tick path. A failed probe changes nothing - a transient tmux
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
nothing. The state model above is untouched by it: a muted session is still
read on every tick, still resolves to `question` when it is blocked on a
permission prompt, still flips unread when its turn ends, and still paints its
LED exactly as it would have. What is skipped is the interruption, never the
record.

**THE CONTROL IS THE ROW'S ACTION MENU.** "mute notifications" is one of
the eight items in a session row's three-dot menu, and it is the only one
of them with no other owner, so its request lives in the menu's own action
module: `PATCH /sessions/records/{session_uuid}/notifications` with
`{muted}`, keyed on the DURABLE record because tmux reuses names. The
label states the result and flips with the row, so a muted session offers
"unmute notifications". See `client/js/session-row-menu.js` (the item
table) and `client/js/session-row-menu-actions.js` (`runToggleMute`).

The menu is a reconciled superset settled by the owner on 2026-09-10:
rename, mark unread, move to group, fork session, new session in folder,
mute, then restart and close below a separator. Pin stays inline. A DEAD
row draws inline restart and remove and no menu at all.

| Piece | File |
|---|---|
| The three-value policy, the generation rule, and the in-memory index | `src/core/session_notification_policy.py` |
| The durable columns and their one writer | `src/core/session_store.py` (`set_notification_mute`), schema v26 |
| The web-alert gate | `src/core/attention/raise_gate.py`, consulted by the watcher before it raises |
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

**Two gates, and each has a different job.** `attention/raise_gate.py` refuses
to RAISE a web alert for a muted session: no toast is recorded and nothing is
broadcast. Because `record_toast` is also what feeds the push router, that alone
stops the external push - and the router gates again at drain time, which is
where the GENERATION is checked. An UNREADABLE policy suppresses, which is the
opposite posture from every refusal in the resolver, and deliberately: silence
there is only ever bought with evidence, silence here was bought in advance by
an instruction.

**`PermissionRequest` IS muted, and it is the ONLY thing that suppresses one.**
The resolver never suppresses a permission-class notification: a session waiting
on its own background agents is answered by the rung order, not by a gate. A
mute is the user answering that in advance, for this session, so exempting a
kind from it would mean
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

Every tier can fail quietly, and each failure has to land on `unknown` rather
than on a confident answer. These are the ones that will actually happen.

**A Claude Code version that stops writing the registry.** The file
`~/.claude/sessions/<pid>.json` is undocumented. `claude agents --json` prints
the same data and IS documented, and it is the cross-check. If a future version
stops writing the file, or writes a status outside the four this app knows, the
reader answers `REG_UNREADABLE` or the resolver falls to its last rung, and the
session goes `unknown`: no toasts, no lights that claim anything. It degrades to
saying nothing, never to saying something false.
`registry_version_unseen` is logged once per unrecognised version string.

**A version too old to write the background-agent count.** Below 2.1.241 the
turn-end record carries no `pendingBackgroundAgentCount`, so the count is
UNKNOWN rather than zero, the async-launch ledger answers in its place, and rest
is unreachable for that session. State the floor rather than guessing under it.

**A record that has not been updated for a long time.** The registry is written
on change, so age is not decay. A stamp older than
`REGISTRY_STALE_AFTER_SECONDS` (900) may SUSTAIN a verdict the ledger already
holds and may never ORIGINATE rest on its own. Measured on this Mac, three live
sessions carried `idle` stamps 37.3, 98.5 and 37.3 hours old while their own
transcripts recorded the turn ending with nothing pending, which is why the
transcript is allowed to corroborate an old stamp.

**Two claude processes in one pane.** The index refuses
(`unknown(ambiguous_pane)`) and raises nothing. Picking one of two records at
random is how a session gets told about another session's question.

**A straggler hook from a claude started before the upgrade.** It keeps POSTing
to a route that no longer exists, gets a 404 in a few milliseconds, and nothing
happens: the curl carries no failure flag, so it exits 0 and claude logs
nothing. It stops when that process restarts. See `docs/notifications.md`.

The hook token store's own failure mode - a mint landing on a running agent, and
the 4,325 rejections it produced on 2026-09-08 - is recorded in
`docs/session-identity-history.md`. The store stays (the boot re-adopt reads it)
and the route that could reject a token is gone, so that degradation can no
longer occur.
