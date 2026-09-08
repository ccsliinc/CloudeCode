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
| `question` | blocked ON THE USER | `Notification`, `PermissionRequest` |
| `finished_unread` | a turn ended and nobody has looked | `Stop`, plus the unread flag |
| `idle` | alive, at rest, already seen | `Stop`, or a bare-shell pane |
| `dead` | the pane's process exited | tmux `#{pane_dead}` = 1 |
| `unknown` | NOT MEASURED | anything else, including a live pane with no hook signal |

`unknown` is a first-class answer, not a failure mode. "I did not look"
and "I looked and found rest" are different claims and must never render
the same way.

## The rules that keep it honest

**tmux is the only thing that can see a pane die.** The dead check runs
first and outranks every hook signal. Hooks cannot observe a dead process,
so nothing else may report `dead`.

**Hook events are unordered, duplicated and droppable.** Every consumer in
`session_activity.py` is idempotent: last-write-wins booleans, counters
floored at zero (`subagent_depth = max(0, depth - 1)`), and an unknown
event kind is a documented no-op rather than an error. Applying the same
event twice, or two events in the wrong order, converges on the same state
a correctly-ordered stream would reach.

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

## Unread

**Set** on `Stop` (the `auto` flag), and by the user's explicit control
(the `manual` flag). A session is unread if either is set.

**Cleared** when a WS terminal actually binds to the session
(`SessionManager.mark_session_viewed`) - the strongest "the user is
looking at this" signal the server has, deliberately stronger than merely
appearing in a poll response. That clears `auto` only. A conversation the
user pinned unread for followup stays flagged after they open it, until
they clear it themselves.

**Stored** server-side, not in `localStorage`, because the user drives
this from a phone and a desktop and the flag has to follow them.

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
`working`, `waiting-permission`, `waiting-input`, `done`, `dead`,
`unknown`.

**Outer halo** (`data-outer`), activity and attention:
`active` (breathing), `steady` (lit, still), `unread` (its own hue,
breathing), `off` (dead, no halo at all), `dim` (not measured).

They are set separately and every combination renders. No rule in the
stylesheet reads one to decide the other.

### The mapping

`StatusLed.ledStateFor({activity_status, unread, startup_gate})` is the
ONE place the server vocabulary becomes a pair of rings.

| activity_status | startup_gate | unread | inner | outer |
|---|---|---|---|---|
| `dead` / `stopped` | any | any | `dead` | `off` |
| any | `awaiting_startup_prompt` | any | `waiting-input` | `active` |
| `question` | any | any | `waiting-input` | `active` |
| `working` / `working_subagent` / `running` | any | no | `working` | `active` |
| `working` / `working_subagent` / `running` | any | yes | `working` | `unread` |
| `finished_unread` | any | any | `done` | `unread` |
| `idle` | any | no | `done` | `steady` |
| `idle` | any | yes | `done` | `unread` |
| `unknown` / absent / unrecognised | any | no | `unknown` | `dim` |
| `unknown` / absent / unrecognised | any | yes | `unknown` | `unread` |

Order matters: `dead` outranks everything (an unread flag must not paint a
corpse as something to go and read), then anything blocking on the user,
then activity. `unread` rides the halo independently of all of it.

`waiting-permission` is in the vocabulary and is NOT reachable from live
data today: the server collapses `Notification` and `PermissionRequest`
into one `question` state, so both render `waiting-input`. Separating them
needs a new server-side signal. It is listed rather than omitted so the
component's full intended set is visible and a gallery can enumerate it.

### Motion

`active` and `unread` breathe on a 2s ease-in-out cycle, opacity and scale
together, on the HALO only - the dot itself never animates, so the state
colour stays at full strength at every point in the cycle. `steady` is lit
and still. `off` has no halo. Under
`prefers-reduced-motion: reduce` the glow stays and the pulse stops; the
active/resting distinction moves entirely into opacity.

The five state colours plus the unread hue are named tokens declared
exactly once, at the top of `status-led.css`. A theme that wants a
different palette redefines `--led-color-*`, never these rules.

### Rolling a group up

`client/js/session-status-summary.js` folds a set of sessions into one LED
plus an unread count. Priority: **waiting > working > unread > done > dead
> unknown**.

Waiting outranks working because it is blocked on the user and will stay
that way; working resolves on its own. Dead sits BELOW done deliberately -
a group with one corpse and nine busy sessions must not read as dead. An
EMPTY group is `unknown`, not `done`: nothing to measure is not the same
as measured-and-quiet.

Each child is bucketed from the LED state it already resolved to, not from
its raw `activity_status`, so a header cannot disagree with the rows under
it.

## A silent degradation worth knowing about

A hook POST with a stale token is rejected at
`src/api/routes.py` and logged as `hook_post_rejected_invalid_token`.
Nothing surfaces it to the user. The session then has no hook signal at
all, falls into the tmux tier above, and its light goes quiet - which
looks exactly like a session that is genuinely idle.

Measured 2026-09-08 in the live server log: 5,841 such rejections, 3,055
from `adopted:cloude_Agent_-_Cloude_Code` and 2,757 from a single other
session, `ses_68c185ce`. This is not fixed here and is worth its own
punchlist item: the honest treatment is for a session whose hooks are
being rejected to report `unknown` with a reason, rather than to look
calm.
