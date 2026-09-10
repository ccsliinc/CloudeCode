# Cloude Code

Drive a Mac's live Claude Code sessions from a phone. A FastAPI server owns real
tmux sessions on the Mac, streams the PTY over a WebSocket, and paints it into
xterm.js in a browser. The session runs whether anyone is watching or not, which
is the whole point and the source of most of the interesting design.

Read this before writing code here. It is orientation first, conventions second.

## Stack

| Layer | What | Where |
|---|---|---|
| Backend | Python 3.12, FastAPI, uvicorn, pydantic models | `src/` |
| Logging | structlog, event-name first arg, kwargs for context | everywhere |
| Terminal | tmux (live backend) driving a PTY, xterm.js client-side | `src/core/tmux_backend.py`, `client/js/terminal.js` |
| Frontend | vanilla JS, no framework, NO build step for `client/` | `client/` |
| Desktop shell | Electron wrapper (has its own `package.json`) | `macOS/` |
| State | JSON on disk (`config.json`), plus one SQLite file for refresh tokens | `src/config.py`, `src/core/refresh_store.py` |

`client/` is served straight off disk under `/static`. There is no bundler, no
transpile, no `client/package.json`. A file you add there is live on reload, so
it must be valid in the browser as written. Run `node --check` on every JS file
you touch.

## Architecture, the parts that shape everything else

**tmux is the live backend. `PTYBackend` is legacy.** The `SessionBackend` ABC is
at `src/core/session_backend.py:32` and has two implementations, each in its own
file: `TmuxBackend` (`src/core/tmux_backend.py:163`) is the one that runs, and
`PTYBackend` (`src/utils/pty_session.py:293`) is the legacy path. Only the ABC
lives in `session_backend.py`; do not go looking for the subclasses there. Write
against tmux; do not build new behavior on the PTY path.

**Sessions live on a dedicated tmux socket, `tmux -L cloude`.** That socket is
separate from the user's own tmux server, which is why our sessions survive a
server restart and why we can never accidentally kill a user session. Sessions we
create are named `cloude_*`. Constants: `DEFAULT_SOCKET_NAME` (`src/core/tmux_backend.py:84`) and
`SESSION_PREFIX` (`:87`). Address sessions by socket + name, never by prefix
guessing.

**Created vs adopted is a real distinction, not a detail.** Cloude Code can
attach to a tmux session it did not create. A TRULY external one - no row for
its instance triple - gets an id of `adopted:<tmux-name>` and is absent from
`owned_tmux_sessions`. Anything that parses, matches, displays or routes on a
session id has to handle both shapes. Strip the prefix to recover the tmux name;
do not assume the id is a clean display string.

**AN ADOPTION RESOLVES THE ID, IT DOES NOT MINT ONE, and the difference is the
hook path.** `adopt_external_session` opened with the literal
`adopted_id = f"adopted:{name}"` until 2026-09-08. That is wrong for a session
the app already has a row for. `get_env_for_spawn` puts `CLOUDECODE_SESSION_ID`
into the pane at `new-session` time, so the agent inside presents its
create-time id on every hook POST for life, with a token bound to THAT id;
registering the same live pane under an invented id makes `validate_hook_token`
answer False and `routes.py` return **403 - not 410**, so grepping for the
stale-session code finds nothing and the hook path looks healthy. Measured:
94 refusals in four minutes for one session. `src/core/session_adopt_identity.py`
now resolves the id through the boot re-adopt's OWN ladder
(`session_boot_readopt_plan.resolve_session_id`, imported rather than rebuilt,
so the two paths cannot name one pane two things), keyed on the instance triple
via `session_store.get_instance`.

Note it is NOT "a row exists, so reuse its id": `persist_adoption` records the
sighting BEFORE the id is resolved, so a row exists for every adoption by then.
The derived rung is reached because a fresh `observed` row carries no
`legacy_session_id` and no hook-token mapping.

**ONE PANE IS ONE REGISTRATION, so the adopt teardown keys on the tmux NAME.**
While the id was always `adopted:<name>`, "the registration for this id" and
"the registration for this pane" were the same question. Resolving the id made
them different, and keying the teardown on the id alone leaves the other one
behind. Measured on live minutes after the re-key shipped: the rehydrated
`session_metadata.json` entry held `cloude_Agent_-_Cloude_Code` as
`adopted:cloude_Agent_-_Cloude_Code`, the browser's adopt correctly re-keyed to
`ses_fb8dd410`, and `GET /sessions/list` returned **22 rows for 21 live tmux
sessions** - one pane, two backends, two tailers on one FIFO.
`_registered_ids_for_tmux_name` is what enforces the rule. Note this was caught
only because the deploy was verified against `/sessions/list` rather than
against the `boot_readopt_complete` log line, which was perfect.

**AND A RECOVERED ID MUST NOT BE RE-MINTED A TOKEN.** `_mint_hook_token`
REPLACES the token it holds for an id. Called on a re-keyed id it revokes the
credential the running agent is holding and cannot be handed a replacement for,
so the 403 storm returns wearing the correct session id and every log line looks
right. A re-keyed adoption calls `_keep_hook_token` instead, which re-binds the
tmux name and leaves the secret alone; a derived id still mints exactly as
before.

**AND WHEN A MINT DOES LAND ON A RUNNING AGENT, IT IS NOW RECOVERABLE
ONCE.** The rule above is the prevention; this is the net under it,
because the failure is invisible from inside the pane and cost 4h24m of
dead hooks on 2026-09-08. Traced to the millisecond: a derived-id adopt
minted at 16:16:40.633984Z, the first `hook_post_rejected_invalid_token`
for that id landed 130 ms later at 16:16:40.763005Z, and 4,325 followed
until the owner restarted the pane by hand at 20:40:23Z. The same id was
being ACCEPTED minutes before (`toast_recorded` 16:11:28Z), so it was a
rotation, not a misconfiguration. `src/core/hook_token_recovery.py` keeps
a bounded IN-MEMORY ring of tokens this process minted and then replaced;
on a rejection, `SessionManager.recover_hook_token` accepts a value ONLY
if this server minted it for THAT id on THAT pane and superseded it, then
re-binds the store to what the running process holds, logs
`hook_token_rebound_from_superseded` once, and NEVER MINTS - minting is
the defect, and a recovery that minted would revoke the credential again
while every log line read correctly. `RECOVERY_NO_MATCH` (searched, not
found) is kept apart from `RECOVERY_UNAVAILABLE` (nothing to search, or
the pane binding is unknown); both refuse, but only the first says
anything about the token. THE NEGATIVE CONTROL IS THE LOAD-BEARING TEST:
a recovery that accepted broadly would pass the positive test perfectly
and be a credential bypass. In memory only is deliberate - a mint plus a
restart is not recoverable this way, and the restart already has its own
answer.

**AND A RESTART IS THE ONE MOMENT A LIVE PANE'S ENV CAN BE CORRECTED.**
tmux copies the SESSION environment into a pane's process at spawn, so
`CLOUDECODE_SESSION_ID` and `CLOUDECODE_HOOK_TOKEN` cannot be pushed into
a process already running - which is why a hand restart was what ended
the storm above. `TmuxBackend.respawn` takes `spawn_env` and issues
`set-environment` BEFORE `respawn-pane`, and the boot re-adopt does the
same for the next process in each pane. Ordering is the whole claim, so
`tests/test_respawn_refreshes_pane_env.py` proves it against REAL tmux by
having the respawned process write its own inherited value: a mock
asserting two calls happened in order would only be testing its own
arrangement.

**BOOT HOLDS EVERY SURVIVING SESSION, not just the last one.** It used to
rehydrate the ONE session in `session_metadata.json`; measured 2026-09-08, 21 live
sessions and zero held. `src/core/session_boot_readopt{,_plan}.py` now re-adopts
every instance whose row says `origin` is `created` or `adopted`, keyed on the
triple. The ID IS RECOVERED, NOT MINTED: the hook-token store's `tmux_names` map is
the only durable record of the `CLOUDECODE_SESSION_ID` injected into the pane, so
reversing it is what stops the hook route answering 410. A name with no row stays
adoptable, an unreadable table yields `cannot_determine` and holds nothing, and the
pass is SCHEDULED, never awaited - uvicorn binds at the lifespan `yield`, so an
awaited pass is dead port (measured: 1.2 ms to bind, versus 49 ms awaited and 945 ms
serial). It takes its own listing because `discover_existing` carries no epoch.
A session the legacy metadata-driven reconcile registers first (PT-IMC, measured
2026-09-08) is skipped here as `SKIP_ALREADY_HELD` by NAME before an epoch is ever
resolved for it; `_record_epoch_for_already_registered` fills `_instance_epochs`
from this pass's own listing anyway, because that gap is what left the status seed
ladder unable to identify the instance for the life of the process.

**EVERY SESSION BELONGS TO A PROJECT, AND THE ROW IS WHERE THAT LIVES.**
The owner's rule, verbatim: "all sessions belong to projects, the root folder
... its impossible to not have a project." Nothing in memory carries it - the
`Session` model (`src/models.py:138`) has no project field and `SessionInfo`
ships none, so `/sessions/list` cannot lose a project and cannot restore one.
The launchpad tree reads `project_id` / `project_attribution` off
`GET /sessions/records`, joined to the live session by tmux name plus epoch in
`_buildProjectSessionGroups` (`client/js/launchpad.js:3878`), and it tests
`attribution === 'none'` BEFORE it looks at `project_id`. So a row carrying
both an id and `none` renders under "no project" while holding a perfectly good
one, which is what the owner saw. The invariant is enforced in
`src/core/session_project_binding.py` and nowhere else: `resolve_project_binding`
is the ladder (as-written match, then the same path canonicalised, then a minted
project, then `none` for a scratch dir, then `unknown`), and `columns_to_write`
is the rule that **THE PAIR MOVES TOGETHER OR NEITHER MOVES**. It is called from
`persist_adoption` (`session_adopt_persist.py`, `allow_create=False` - re-entering
a session is not a moment to invent a project) and from `persist_creation`
(`session_create_persist.py`, `allow_create=True`), while `create_project`
(`project_writes.py`) adopts the project-less live rows already under its new
root, which is punchlist 16 closed from both directions.

Two things caused this and both are worth keeping. First, a HALF-WRITE:
`claim_instance` applies each column "only when not None", so a derived
`(None, 'none')` skipped the id and wrote the attribution ALONE - the row kept
its project and acquired a value contradicting it. "Only when not None" reads
as conservative and is not, when the columns are a pair. Second, a SPELLING the
lexical matcher cannot cross: `project_attribution.attribute` refuses to resolve
symlinks, correctly, so a session probed at `/Users/jsugamele/Development/...`
could never match a project declared at the iCloud path that same directory
resolves to. Canonicalising is a FALLBACK RUNG, tried only after the as-written
match fails, so a project declared at a symlink still collects the sessions
declared there. Measured 2026-09-08: rows 7 and 8 held projects 1 and 2 beside
`none`, row 45 held NULL from the create race, and 3 of 22 running sessions
rendered project-less.

**IT HELD ZERO ON ITS FIRST REAL BOOT, and the cause is worth keeping.** The
pass builds an OWNED backend (`build_backend`, not `TmuxBackend.for_external`)
and calls `attach_existing(needs_pipe_setup=True)`. That reached
`ensure_pipe_pane`, whose guard was `not self._running and not self._is_external`
- and `_running` is not set until the BOTTOM of `attach_existing`. So both halves
were true for every owned session: 20 failures, all `"backend not running"`, all
inside one millisecond, before a single tmux command was issued.

**A guard whose only exercised caller sets the flag it checks has never been
tested.** Until the boot re-adopt, the sole caller reaching that branch was the
external adopt path, where `for_external` sets `_is_external=True` and the guard
CANNOT fail. 4874 green tests had never observed it raise, because
`tests/test_boot_readopt.py` is hermetic and its `FakeBackend.attach_existing`
has no guard to fail. The fix threads intent explicitly -
`ensure_pipe_pane(attaching=True)`, passed only from inside `attach_existing`,
after `is_alive()` and the `#{pane_dead}` probe have both answered. It does not
set `_running` early: that would make the backend claim it was streamable across
four tmux round trips and leave the claim standing on an object whose setup
raised. `tests/test_boot_readopt_real_tmux.py` covers it against a REAL backend
on a real throwaway socket, because a double cannot reproduce a guard.

**Claude Code lifecycle hooks feed the status machine.** `src/core/claude_hooks.py`
merges a managed hook block into `~/.claude/settings.json` (marked
`# cloudecode-managed`, idempotent, atomic write, bails rather than clobbering an
unparseable file). Hooks POST to a loopback-only endpoint authenticated by an
env-injected shared token. Events: `Stop`, `Notification`, `PermissionRequest`
(these three also raise a toast), plus `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `SubagentStart`, `SubagentStop` (activity state only).
**AND THREE OF THEM ANSWER TOASTS AS WELL AS RAISING THEM**: a prompt
submitted from ANY client fires `UserPromptSubmit` wherever it was typed, so
`src/core/toast_auto_ack.py` acks that session's open toasts as `answered`
(`PreToolUse` acks only a permission; `Stop` acks a permission or a notice and
NEVER the "your turn" it just raised, by KIND so the rule survives a duplicate
or a reorder, and never a toast raised after the event's own instant). Clients
drop the card on the `toast.ack` frame or, on a socket-less screen, when the
poll reconciles the open set - see `docs/notifications.md`.

Hook events arrive **unordered, and may be duplicated or dropped.** Every
consumer in `src/core/session_activity.py` is therefore idempotent: last-write-
wins booleans and floored counters (`subagent_depth = max(0, depth - 1)`). If you
add a hook consumer, it has to survive the same event twice and a missing pair
half. Never increment without a floor, never assume a `Stop` follows the
`UserPromptSubmit` you saw.

**Security posture.** CSP is stamped on every response by the middleware in
`src/main.py`. As of 2026-08-16 there is **no third-party origin in any
directive**: the baseline is `default-src 'self'` with `frame-ancestors 'none'`,
and `https://cdn.jsdelivr.net` has been removed from `script-src`, `style-src`
and `font-src`. It used to sit in all three because xterm.js 5.3.0, its CSS and
its fit / webgl / unicode11 addons loaded straight from the CDN in
`client/index.html`. They are now vendored under `client/vendor/xterm/`.
`style-src` still carries `'unsafe-inline'` and must keep it: xterm addons set
inline style attributes on nodes they manage, and the terminal renders blank
without it. Inline **styles** are therefore permitted; inline **script** and
`eval` are not.

**Why the CDN removal was a correctness fix, not only hardening.** A remote
xterm asset is one content blocker away from breaking the terminal for
everybody. Brave Shields on a phone dropped enough of it that xterm ran but
`xterm.css` did not apply, so the character cell was measured wrong, `FitAddon`
derived a bogus cols/rows from it, and `sendResize` reflowed the real tmux pane
to a grid matching nothing on screen. The symptom was a terminal that rendered
garbage on the device while the desktop and the desktop mobile emulator both
looked perfect, which is exactly what you would least suspect a CDN of. Nothing
the terminal needs may be loaded off-origin again. `tests/test_no_remote_assets.py`
fails the build if a third-party URL reappears in `client/index.html`.

New third-party libraries get **vendored** under `client/vendor/<lib>/` and
served from `/static`, with a `VERSION.md` beside the files recording version,
upstream source URL and sha256, plus a refresh script under
`scripts/<lib>-vendor/`. CodeMirror 6 and xterm are the worked examples
(`scripts/xterm-vendor/fetch.sh` re-downloads the pinned versions and hard-fails
on a hash mismatch). Do not add a host to the CSP, do not weaken
`frame-ancestors 'none'`, do not introduce inline script or `eval`, and do not
read `style-src 'unsafe-inline'` as license to widen anything further.

**THE ATTACH CAPTURE CARRIES THE CURSOR, BECAUSE `capture-pane`
SERIALISES CELLS AND NEVER CURSOR STATE.** `capture_visible_screen()`
(`src/core/tmux_backend.py`) appends an explicit `ESC[row;colH` read from
tmux's `#{cursor_x}` / `#{cursor_y}` via `pane_cursor_position()`. Without
it the client's cursor lands wherever the last captured character was
written, which is where the pane's cursor is only by coincidence.
Measured on a real Claude Code pane 2026-09-08: the pane's cursor sat on
row 8, inside its input box, while the capture ran to row 13, because the
box's bottom border, the path line and the mode line all sit BELOW the
prompt. The client was left five rows too low.

That was survivable on the ALTERNATE screen and is fatal on the NORMAL
one, which is now the shipped case because `disable_alternate_screen`
defaults on and is the only thing that makes scrollback exist. Captured
over a real keystroke, a normal-screen frame is
`ESC[38D ESC[4B \r ESC[38C ESC[4A X ...` and contains ZERO absolute
positioning, so a wrong starting cursor is never recovered from; the
alternate-screen renderer re-anchors with `ESC[H` and `ESC[r;cH` every
frame and silently corrects the client on the next keypress. The
normal-screen renderer also steps over runs of spaces with `ESC[nG`
rather than writing them, so the row it lands on is not even erased,
which is why the user's typed sentence appeared painted ON TOP of the
input box's bottom border with the border showing through the word gaps.

Rows line up one to one: `paint_on_attach` sends `ESC[H ESC[2J` first and
`-S 0` starts at the first VISIBLE row, so tmux's 0-based `#{cursor_y}`
is client row `y + 1`. **A cursor that cannot be read appends nothing** -
leaving the client where the text ended is the old behaviour, and an
invented `(0, 0)` would move every session to the top-left while looking
like a working feature.

**THE REPORTED "INPUT LAG" WAS THAT SAME DEFECT, NOT A THROUGHPUT
PROBLEM, AND THE NUMBERS SAY SO.** Claude Code diffs against its OWN
model of the screen, so the bytes it emits are identical no matter where
the browser's cursor is: a mispositioned cursor cannot make a repaint
bigger. Measured on a throwaway socket, per keystroke on the normal
screen: 52 bytes at an idle prompt, about 650 while the thinking spinner
animates. With the UI parked at the bottom of the viewport the pane
scrolled 4 lines over 10 keystrokes, not once per keystroke. And
`HISTORY_LIMIT` at 50000 does not reach the attach at all - the attach
paints ONE viewport through `paint_on_attach`, never `scrollback_lines`
and never the history. What the user actually experienced was measured
end to end by replaying a real pane's capture into a second real pane and
then feeding it that pane's own keystroke bytes: with the cursor
uncorrected, one typed `H` landed on the mode line at row 12 instead of
the input box at row 8; with it corrected the two panes agreed cell for
cell. You type, nothing appears where you are looking, a later full
redraw dumps it all at once. That is indistinguishable from lag from the
user's seat.

The residual cost of the normal screen is FLICKER on redraw, not latency,
and it is the price of having scrollback at all;
`AuthConfig.session.disable_alternate_screen` is the switch and turning
it off costs every line of history. Note this was NOT A/B'd between
renderers: Claude Code 2.1.215 on the developer's box reports
`alternate_on=0` even with no env var and no settings key, so a
fullscreen comparison could not be produced. The fix costs one extra
tmux round trip per attach, 9.8 ms median against 17.5 ms for the capture
beside it. `tests/test_capture_cursor_real_tmux.py` proves the claim with
a real second pane rather than a substring assertion, because asserting
the bytes end in `ESC[3;6H` proves only that the string was formatted.

**Config writes are atomic and backed up.** Copy the pattern in
`Settings.update_settings_config()` (`src/config.py`): write the `.bak` of the
pre-write bytes first, then temp file, `fsync`, `os.replace`. A half-written
`config.json` costs the user their whole setup, so there is no "just dump the
JSON" shortcut anywhere in this codebase.

## The `/sessions/list` shape

`GET /sessions/list` returns `SessionInfo` objects (`src/models.py`), and the
fields sit on **two different levels**:

- On the wrapper: `activity_status`, `unread`, `startup_gate`, `tmux_session`,
  `agent_type`, `agent_family`, `agent_family_source`, `agent_wrapper_label`,
  `pinned_theme`, `session_backend`, `recent_logs`, `local_servers`, `stats`
- On the nested `.session`: `id`, `pty_pid`, `working_dir`, and the rest of the
  `Session` model

Reading `info.id` or `info.session.unread` gives you `undefined` silently, and it
looks exactly like "the backend didn't send it". This is the single most
repeated bug in the project. Check the level before you debug the endpoint.

**Three fields describe the agent, and they answer three different questions.**
`agent_type` is the raw stored value: a wrapper id (`claude-chrome`) or a bare
family name (`shell`). `agent_family` plus `agent_family_source` are the
DISPLAY-time resolution of it (`src/core/agent_family_display.py`), and the
source is what keeps a fingerprinted guess from rendering like a launch fact.
`agent_wrapper_label` is the wrapper's configured label
(`src/core/agent_wrapper_display.py`), `null` whenever no configured wrapper can
be named - a fingerprinted value, a bare family name, or an id config no longer
carries. `AttachableSession` carries the same three, resolved by the same
functions, so a launchpad row merged from either endpoint agrees about itself.

**A GUESS MUST NEVER OUTRANK A RECORD, and the ordering lives in one place.** A
live session has two sources for `agent_type`: the in-memory `Session` and
`sessions.agent_type` on its row. `_session_info_for` used to read the row only
when the in-memory value was EMPTY, and that is wrong for an ADOPTED session -
every live session is re-adopted after a server restart, the adopt path
fingerprints the pane and stores the bare family token, so a session launched as
`claude-chrome` came back holding `claude` and painted `~claude` (the dashed
"guessed" pill) beside a row that recorded the exact wrapper. Measured on the
owner's box 2026-09-08: row 43, `agent_type='claude-chrome'`,
`agent_family_source='launched'`. `session_agent_evidence.choose_agent_evidence`
is now the only thing that picks between the two, as a four-rung ladder:
in-memory launch, then the row, then the in-memory fingerprint, then nothing.
The row beats the fingerprint because nothing writes an inference into
`sessions.agent_type` - `persist_fingerprint_family` writes `agent_family` and
deliberately leaves that column alone.

**`startup_gate` answers a DIFFERENT question from `activity_status`: has this
session started at all?** A freshly launched claude parked on its folder-trust
dialog is a live pane, running a real process, with a pid tmux reports happily -
and it has fired NO hook, so every field beside it reads healthy and the row
painted a green `Connected` dot over a session waiting for a keypress. That is
punchlist 19. `activity_status` describes what a RUNNING agent is doing; this
says whether it is running. Three values, `ready` / `awaiting_startup_prompt` /
`unknown`, resolved by `src/core/session_startup_gate.py` (the PURE ladder) with
its state and its one tmux read next door in
`src/core/session_startup_gate_ledger.py`, and rendered by
`client/js/session-startup-gate.js` as `needs a keypress` on the sidebar row and
the launchpad card, plus a `StartupPrompt` toast claimed ONCE per instance.

**The signal is the ABSENCE of a hook, and it was measured.** Controlled
experiment, 2026-09-08, claude 2.1.263, throwaway `tmux -L cloude-test` socket
with the hook POSTs pointed at a local listener: launched in an UNTRUSTED
directory the pane sat alive on the trust dialog for 35.8s and the listener got
ZERO POSTs; the dialog was answered at +34s and the first hook, `SessionStart`,
landed 1.76s later. Launched in the same directory once trusted, three runs,
`SessionStart` landed 0.49s / 0.50s / 0.41s after pane birth. So a hook is
positive proof startup finished, and `STARTUP_HOOK_GRACE_SECONDS = 20` is forty
times the normal cost of getting one.

**A HOOK OUTRANKS THE SCROLLBACK, and the rung order is the whole design.** tmux
does not erase the trust dialog when it is answered, so a session that answered
it an hour ago still has the marker text in its tail. Reading the text first
would pin that session at `awaiting_startup_prompt` forever, which is why
`resolve_startup_gate` tests the hook before it ever looks at the text. Old
scrollback is STALE EVIDENCE. Rung 5 (no tail captured) refuses with `unknown`
while rung 7 (tail read, nothing matched) answers `ready` - the same asymmetry
the transcript-presence guard uses, for the same reason. `ready` claims only
"not blocked on a startup prompt", NOT "healthy": a pane measured dead answers
`ready` here, and `activity_status` is what says it died.

**Steady state costs nothing, because the tail is only read when the cheap
signals already point at a stuck session.** `should_capture_tail` gates the one
`capture-pane` on alive + past the grace window + no hook, which on a working
box is the empty set. Do not move that capture up into the unconditional path.

**The ledger is keyed by the tmux INSTANCE, not by `session_id`, and that is not
interchangeable with `SessionActivityTracker.hooks_seen`.** A confirmed live
restart (`respawn-pane -k`) keeps the session_id AND the epoch and moves only the
pane pid, so `StartupGateLedger` keys on (epoch, pane_pid) and drops the whole
record - first-hook time and toast claim together - when either is MEASURED to
move. A null never resets, or the ledger would reset every poll and re-toast
forever. And every hook kind feeds it, not just `SessionStart`: hooks are
droppable, and a session whose `SessionStart` was lost but whose `PreToolUse`
landed is plainly past its prompt. Feeding it one event kind would rebuild the
one-shot-channel-with-no-retry defect that cost this project sixteen conversation
ids.

Note for anyone touching `src/core/agent_fingerprint.py`: its
`^\s*❯\s*1\.\s*Yes, I trust this folder` pattern CANNOT fire on claude 2.1.263.
The live capture shows no option numbers and the cursor on "No, exit", so the
options read `❯ No, exit` then `  Yes, I trust this folder`. The startup gate
matches the sentence text instead, for exactly that reason.

**`unknown family` on a row whose record says `not_launched` is DATA, not a bug,
AND IT IS NOW FILLED FROM THE PANE'S OWN PROCESS.** The shape is
`agent_type` NULL beside `agent_family_source='not_launched'`: the
`auto_start_claude:false` plus a hand-sent claude command case named under
"Restarting a session" above. Both halves of the record are true - the app
really did open a bare shell and really did start no agent - and neither can
say what the human then typed into the pane. Re-measured 2026-09-08 on the
owner's box: 12 rows carry that shape (it read 27 of 40 earlier; the
population moves, re-measure rather than quoting either), and none of the 19
live panes does, because every live row already carries a wrapper id.

`src/core/session_agent_infer.py` is the ladder,
`session_agent_infer_apply.py` the per-session seam and
`session_agent_infer_sweep.py` the fleet pass. **THE EVIDENCE IS THE PANE'S
PROCESS**: the claude command line in its process tree (one `ps -A`, walked
with `claude_resume_argv`'s existing traversal rather than a second one),
because that is the only thing that can tell `claude-chrome` from
`claude-skip-permissions` - they fire identical hooks, print identical banners
and differ only in their flags. `#{pane_current_command}` CORROBORATES and
never creates: it answers the family when its basename is literally `claude`,
and the claude VERSION STRING that 15 of 19 live panes report there selects no
rung at all.

**A HOOK IS NOT THE TRIGGER, AND ASSUMING IT WAS ALMOST SHIPPED A RUNG THAT
COULD NEVER FIRE.** tmux copies `CLOUDECODE_SESSION_ID` and
`CLOUDECODE_HOOK_TOKEN` into a pane's process AT SPAWN, so a claude a human
typed into an already-running pane has neither and never announces itself.
Measured 2026-09-08: 10 of the hand-started `not_launched` sessions have never
fired a hook and never will - which is exactly the population this feature
exists for. So the read is driven three ways: `sweep_live_sessions` at the END
of the boot re-adopt pass and after an adoption, plus the per-session hook path
for a session that DOES carry the env. A hook remains the STRONGEST evidence
where it exists (it proves a claude is running before anything is read); its
ABSENCE is simply not evidence of absence. The sweep costs TWO subprocesses for
the whole fleet, and only if a row needs them - the row gate runs first, so a
box whose sessions all carry an `agent_type` spends no `ps` at all. There is no
periodic re-sweep yet, which is the known gap.

**THE ANCHOR GATE IS WHY THIS CANNOT ALWAYS FIND SOMETHING.** A wrapper is
named only when the observed argv carries at least one distinguishing flag AND
exactly one configured claude-family wrapper passes that same set - equality,
not subset, or a wrapper passing `--dangerously-skip-permissions` would claim
a pane running that plus `--chrome`. Empty agreeing with empty is the absence
of evidence, not two facts agreeing. Measured against the owner's real five
wrappers: `cld`, `cldl` and `claude-skip-permissions` all reduce to the same
single flag, so 16 of the 19 live panes tie three ways and get the bare family
`claude`, and only the 3 running `--chrome` resolve to a wrapper id.

The value is stored with `agent_family_source='inferred_process'`, a SIXTH
family source that renders as the dashed guess pill, never the solid one. It
is kept apart from `fingerprint` because the two were measured differently: a
process read is the stronger guess, which is why it is the one guess allowed
to name a wrapper, and it is still a guess. Writing it broke the premise
`session_agent_evidence` was built on ("nothing writes an inference into
`agent_type`"), so the row's source now travels with its value through
`identity_for_live_name`, `choose_agent_evidence` and `stored_launch_for` -
read one without the other and a guess paints solid.

**AN INFERENCE IS NOT INTENT, so `session_agent_infer.restart_agent_type`
keeps it out of the respawn ladder entirely.** `session_respawn.py` is
unchanged: `RESPAWN_SHELL` still fires on an empty `#{pane_start_command}`,
which is this whole population, and it fires BEFORE `agent_command` is
consulted - so filling `agent_type` could never have changed that rung anyway.
What it could have changed is an ADOPTED session with a real recorded start
command, silently moving it off `RESPAWN_REPLAY` on a guess, and that is what
`restart_agent_type` refuses. The restart picker's explicit choice remains the
only thing that overrides the gate.

The write happens at most once per pane: the WHERE clause requires
`agent_type` empty and the source not `launched`, which the first success makes
false, and an in-process memo keyed on the tmux INSTANCE keeps a `ps` off the
`PreToolUse` path. Steady state on a healthy box is one indexed SELECT per pane
per server process and no subprocess at all.

## How we work here

- **Every function documented**: one-line description, typed inputs, typed
  output, and an example when the usage is not obvious. Types belong in the
  Python signature, not only in the docstring.
- **DRY, single source of truth, named constants.** No magic strings. A literal
  like the hook marker or the socket name lives in exactly one module and gets
  imported.
- **New logic goes in new focused modules.** These files are already past the
  500-line guideline and should not grow: `client/js/terminal.js`,
  `client/js/launchpad.js`, `client/js/app.js`, `client/css/styles.css`,
  `src/config.py`, `src/api/routes.py`, `src/core/session_manager.py`. Edit them
  when the change belongs there; do not use them as the default landing spot.
- **No bare `except:` and no blanket `except Exception:`** that swallows. Catch
  the specific error, log it with structlog context, or re-raise. If you
  deliberately swallow, a comment says why (see the History-API guard in
  `client/js/router.js` for the shape).
- **Production ready.** No mocks, no placeholders, no test endpoints left behind.
- **`python3`, never `python`.** Tests: `venv/bin/python3 -m pytest -q` from the
  repo root. System python3 has no fastapi. Current baseline, re-measured
  2026-09-09 at the 1.2 merge (v1.1 + adamdev/master 887b8fc), is
  **5625 passed / 2 failed / 21 skipped**, against **5610 / 2 / 21** for
  v1.1 alone measured in the same checkout minutes earlier - so the merge
  added 15 tests and no failures. Two failures remain, both environmental
  and pre-existing:
  `test_home_write_guard.py::test_guard_refuses_the_real_claude_settings_path_by_name`
  and `test_version_probe.py::test_current_version_empty_when_unresolvable`.
  The third this file used to name,
  `test_state_dir_resolution.py::test_get_state_dir_default_is_never_under_the_system_temp_dir`,
  now PASSES; it was never fixed on purpose, so treat it as environmental
  in both directions rather than as a guarantee.
  A CHECKOUT WITH NO `config.json` MANUFACTURES A FAKE FAILURE SET, and it
  is a big one: 19 failed plus 26 errored in a fresh `git worktree`, every
  one of them an app that could not start (401s from the test client,
  FileNotFoundError from the route tests), and every one of them clearing
  the moment the file is put back. `config.json` is gitignored, so a new
  worktree never has it. Copy one in before you measure anything, and do
  not attribute a failure to a code change until you have reproduced the
  same run on the base commit in the same directory.
  Your job is to add no NEW ones. Watch for a broken environment
  manufacturing a fake baseline: a `venv` symlink pointing at a
  `venv.nosync` directory that no longer exists lets the suite limp
  along and undercount silently, rather than failing outright. If the
  numbers you see look nothing like these, check the symlink and rebuild
  the venv from `requirements.txt` before trusting the count. **That is not
  hypothetical: it happened.** The baseline this file carried before
  2026-09-08 read 4647 passed / 13 skipped and was stale by an order of
  magnitude for exactly that reason. **One test in this suite is measured
  FLAKY under a full run** (`test_respawn_refreshes_pane_env.py::test_the_session_environment_itself_is_updated`
  failed once alongside 3 passes in isolation, both runs on the same tree
  minutes apart) - it drives the real `cloude` tmux socket, which is the
  same class of flakiness INFRA-49 already names. A lone failure there
  without a code change behind it is not a new regression; re-run before
  chasing it. Node: **197 tracked suites, all 197 passing** (re-counted
  2026-09-09 at the 1.2 merge; v1.1 alone had 193, of which 2 failed).
  `test_archive_full_page_mode.node.mjs`, the one long-standing node
  failure this file used to name, is FIXED and now passes. The piped-stdin CLI helper for
  the real-hook harness lives at `tests/helpers/led_state_for.mjs`, outside
  the `tests/*.node.mjs` glob the CI loop runs, because it is not a suite and
  exits non-zero when run with no input - which is what it used to be
  reported as, from `tests/led_state_for.node.mjs`, before the move.
- **`CLOUDE_REAL_HOOK_TESTS=1` opts in to `tests/test_led_real_hooks.py`**, which
  launches a REAL `claude` in a throwaway tmux socket and asserts the status LED
  against hooks it actually fired. It is off by default because it spends real
  Claude turns and about 50 seconds; without the variable (or without tmux /
  claude / node) every test in it skips with a reason naming what went
  unmeasured.
- **`node --check`** every JS file you touch, before you claim it works.
- **Stage files by name** when committing. No `git add -A`.
- **Voice**: no em-dashes, no en-dashes, no emojis, anywhere, including commit
  messages. UI copy is lowercase and plain.
- **Push only to `origin` (ccsliinc/CloudeCode) or `adamdev` (Adoom666/CloudeCodeDev). NEVER to `upstream` (Adoom666/CloudeCode).** Owner's rule, 2026-09-08. The `upstream` push URL is set to `DISABLED_do_not_push_to_Adoom666_CloudeCode` on the owner's clone so a push there fails by construction; re-apply that with `git remote set-url --push upstream DISABLED...` on any fresh clone.

## Restarting a session, and picking what it comes back as

`POST /sessions/respawn` revives a pane whose PROCESS exited. It can ALSO
replace a running one, but only when the request says so:
`resolve_respawn_plan` answers `RESPAWN_NOT_DEAD` for a live pane unless
`live_restart_confirmed=True`, and tmux itself refuses `respawn-pane`
without `-k`. See "Replacing what is running" below.

**The ladder gates on tmux's `#{pane_start_command}`, and the empty case is
the trap.** Empty means the pane was born a bare shell, so a restart lands on
`RESPAWN_SHELL` and hands back a LOGIN SHELL rather than the agent - silently,
for a real subset of the sessions on a working box, because
`sessions.agent_type` lands NULL for every session created with
`auto_start_claude:false` plus a hand-sent claude command.

| Piece | File |
|---|---|
| The ladder, the projection, and pane liveness | `src/core/session_respawn.py` |
| Which conversation it comes back on | `src/core/session_resume_target.py` |
| Shape the preview the picker reads | `src/core/session_restart_preview.py` |
| Validate an `agent_type` choice, and persist it | `src/core/session_agent_choice.py` |
| `GET /sessions/restart/preview` | `src/api/restart_routes.py` |
| The panel, and the reopen afterwards | `client/js/session-restart-picker.js`, `client/js/session-restart-return.js` |
| The option list, extracted so the picker stays under 500 lines | `client/js/session-restart-options.js` |
| Keep the row keyed on its instance after a kill | `src/core/session_instance_rekey.py` |
| The arm control and the kill confirmation | `client/js/session-restart-live.js` |
| What the user is told about the conversation | `client/js/session-restart-continuity.js` |
| Recreate a session whose tmux is GONE | `src/core/session_recreate.py` |
| Is the tmux session still on the socket | `src/core/session_recreate_presence.py` |
| `GET /sessions/recreate/preview`, `POST /sessions/recreate` | `src/api/recreate_routes.py` |

**A SESSION WHOSE TMUX IS GONE HAS NO PANE TO RESPAWN INTO, AND THAT WAS A
DEAD END UNTIL 2026-09-08.** The respawn ladder reads a PANE, so a row whose
tmux SESSION was killed outright - the server restarted, the machine rebooted,
the name is simply absent from `tmux -L cloude list-sessions` - answers
`cannot_determine`. Honest, and the only way back was a fresh session built by
hand, which loses the row and with it the project binding, the title, the pinned
theme, the unread key and the group filing. `src/core/session_recreate.py`
closes it as punchlist item 22's remaining half: a new tmux session, in the
conversation's own directory, under the wrapper the user picked, with
`--resume <uuid>`, recorded onto the EXISTING row through
`create_session(reuse_session_id=...)`. It decides only the one fact it owns -
presence - and calls `plan_imported_restart` for the transcript guard, the
directory spelling, the wrapper and the three conversation words, so the two
create-a-session paths cannot drift.

**THE GATE IS A MEASURED ABSENCE, AND `is_alive()` CANNOT PROVIDE ONE.** It
runs `has-session` and returns a bool, so "no such session" and "tmux is
missing, timed out, or errored" are the same False; recreating on that would
spawn a second tmux beside a healthy one and rebind the row onto the newcomer,
leaving the pane the user is talking to alive and unreferenced. So the
measurement is a LISTING (`discover_existing()`, whose `ok` and `complete`
already carry the discipline) and `session_recreate_presence.tmux_presence`
keeps three outcomes apart: `gone` only when a COMPLETE listing ran and the
name is not in it, `present` reported as the ladder's own `not_dead`, and
`unknown` for a listing that did not run, one that ran with rows the parser
refused, or a name outside the `cloude_` namespace the listing does not cover.
Only `gone` may act. `tests/test_recreate_gate_real_tmux.py` measures the
transition against a real throwaway socket, because a double agrees with
whatever it was built to agree with.

**ADDRESSED BY `session_uuid`, NOT BY THE TMUX NAME, and that was caught rather
than designed.** The first draft resolved the row by name plus greatest epoch;
`tests/test_no_name_keyed_session_identity.py` failed it, correctly - a name is
reusable and this app re-mints them, so "the newest row with this name" is a
recency guess, and a wrong answer rebinds a DIFFERENT session's row. The routes
now take the durable key and read the tmux name OFF the row. The client bridges
its own gap the same way: the sidebar addresses rows by name, so
`SessionRestartOptions.recreateTarget` returns a uuid only when EXACTLY ONE
record carries that name and null otherwise. A refusal costs the user the offer,
which is what they had before the feature existed; a guess would cost them a
session.

**THE ROW IS RE-KEYED, NOT REPLACED.** The new tmux session is a new instance,
so `session_restart.rebind_instance` moves the triple while holding
`sessions.id` fixed. Group filing rides along because `session_group_membership`
has keyed on `session_uuid` since v24 - the v8 table it replaced keyed on
`tmux_name`, which is the landmine an earlier design of this feature would have
walked into. The SAME tmux name is asked for so name-scoped per-device browser
state survives, and it is free by construction because the gate only passes on a
measured absence; the create path still uniquifies on collision, so the name
actually taken is REPORTED rather than assumed.

**A PREDICTION IS NEVER A PERMISSION, and that is why the preview reports the
rung twice.** `resolve_respawn_plan` short-circuits on `not_dead` BEFORE it
reads the start command, so on its own it can only tell you a running session
is running - not what it would come back AS, which is the only interesting
question about the idle-but-alive sessions a user actually wants to restart.
So the tail of the ladder is factored into `_rung_from_start_command` and
reached two ways: `resolve_respawn_plan` through the probe gate AND the
liveness gate, `project_restart_rung` through the probe gate only. There is
still ONE ladder. `unchanged` is what a restart does now, `projected` is what
it would come back as, `pane_state` (`dead` / `alive` / `unknown`) is liveness
on its own. A UI badge may read `projected`; only `unchanged` / `actionable_now`
may enable a button. Wire the badge to the button and every live session
becomes restartable.

**`agent_type` on the respawn request is an ID, never a command.** It is
validated against `agents.wrappers` and an unconfigured id is a 400.
`Settings.get_agent_command` deliberately falls back to the default wrapper for
an unknown type, which is right for a launch and wrong for a picker - a user
who asks for `claude-chrome` and silently gets `claude-skip-permissions` has
been lied to. Validate through `session_agent_choice.validate_agent_choice`
first; never call `get_agent_command` with a user-supplied id directly.

**An explicit choice outranks the `pane_start_command` gate; nothing else
does.** The gate exists because a STORED `agent_type` is not evidence of
intent. A wrapper picked in this request, after the user was shown what it
would do, is different evidence. It does NOT outrank `not_dead` or a probe that
did not answer. The verdict stays `RESPAWN_AGENT`; `RespawnPlan.chosen` and a
different sentence carry the distinction rather than a sixth kind.

**A RESTART MEANS A RESUME, ON EVERY RUNG THAT CAN.** The owner's
definition, 2026-09-07, verbatim: "restart on recent is really just
resume. restart on open is close and resume session so it loads a new
wrapper or new claude binary." ONE semantic, two mechanics: a dead row has
no process to kill so its restart IS a resume, and a live row has its pane
killed first, the kill existing only so the pane picks up a new wrapper or
a new claude binary. Both come back on the SAME conversation.

`f95a9ed` made that true only on the REPLAY rung, by accident of what tmux
had written down. The AGENT rung re-derives its command through
`Settings.get_agent_command`, which carries no `--resume`, so a restart
there started a FRESH conversation wearing the old session's name.
`sessions.claude_session_uuid` now reaches that command as
`extra_args=['--resume', <uuid>]`, built once by
`session_resume_target.resume_extra_args` and passed to all FOUR command
resolutions in a restart request - the stored agent's and every wrapper
offer's, on the action side and on the preview side. Building it in one
place is what makes the preview's predicted command and the action's
actual command the same string by construction. NEVER concatenate the flag
onto a resolved command: `get_agent_command` returns
`zsh -c 'source ~/.zshrc ...; cld'` and an appended argument lands outside
that quoting, handed to zsh instead of to claude.

**The resume drops claude's own `--name`, and that is a known gap, not a
bug fix waiting to be noticed.** `resume_extra_args` carries `--resume
<uuid>` only, so a restarted session comes back without whatever name
claude itself had been given (`--name`, `/rename`). The app's own row title
survives regardless, because it lives in `sessions.title`, not in claude's
argv. Open item: reuse `claude_title_sync`'s read of the transcript's last
`custom-title` to reapply the name on a resume the same way it already
detects one.

**A MISSING uuid IS A NAMED OUTCOME, NOT A SILENT FRESH START.**
`RespawnPlan.conversation` and the preview's `conversation` field carry
`resumed` / `none_recorded` / `unknown`, the SAME three words
`RestartSessionResponse.conversation` has used since the restart route
shipped, reused rather than re-invented. `none_recorded` means the row was
READ and holds no conversation, so the session comes back WITHOUT its
history - a legitimate restart, said out loud rather than performed
quietly. `unknown` means the row could not be read: no `--resume` is
injected and nothing claims a resume, because an unknown is never a yes.
The value is DERIVED FROM THE ARGV - a command carrying a `--resume` reads
`resumed` whatever the caller believed - so the claim can never outrun the
command. The rung sentence the picker renders verbatim carries the clause,
and `SessionRestartLive.liveConfirmCopy` names it before anything dies.

Note the asymmetry, it is deliberate: an unreadable ROW degrades the claim
and never refuses, while a MEASURED missing TRANSCRIPT refuses outright.
Not having looked is not evidence of absence; having looked and found
nothing is.

**A REPLAY CAN RESUME A CONVERSATION, and that is guarded.** `RESPAWN_REPLAY`
hands tmux back its own `#{pane_start_command}`, and measured on the owner's
box 2026-09-07, 3 of 19 live sessions carry an explicit `--resume <uuid>` in
theirs. So a replay can re-run a resume, and a resume against a deleted
transcript exits instantly, leaving a dead pane the row still calls running -
the incident this project already paid for. `resume_uuid_in` extracts the uuid,
`refuse_if_transcript_missing` turns a DEFINITE absence into
`RESPAWN_TRANSCRIPT_MISSING`, and the filesystem lookup lives in
`src/core/session_transcript_presence.py` so the ladder stays pure. THE
GUARD COVERS THE AGENT RUNG TOO now that it resumes, on the dead path as
well as the live one: the check in `TmuxBackend.respawn` keys on
`plan.resume_uuid` and is not gated on liveness. TWO CONVERSATIONS CAN BE
IN PLAY AT ONCE - the replay rung resumes what tmux recorded, the agent
rung resumes what the ROW says - so the preview passes presence verdicts
as `presence_by_uuid`, keyed by the uuid each was measured for. One
verdict applied to both would refuse a restart nobody measured.
`unchecked` NEVER refuses - not having been able to look is not evidence a file is gone, and
refusing on it would break restart on every machine whose corpus lives somewhere
the checker was not told about. The PREVIEW applies the same guard; a preview
that skipped it would promise a replay the restart then declines.

**Replacing what is running: `respawn-pane -k`, and the four gates in
front of it.** The owner's two calls (2026-09-07) were "same tmux should
be fine" and "yes resume the same session", so this is not
close-and-recreate. It kills the pane's process and respawns it in the
same pane, same tmux name, same row - and because no row is minted,
project attribution, pinned theme, unread state, group filing and
sidebar position all stay put without anything re-carrying them. It also
sidesteps rather than fixes the `session_group_members` primary-key
defect, which keys on `tmux_name`.

It is DESTRUCTIVE and irreversible, so it is gated four times and no
gate is derivable from a prediction. **ALL FOUR GATES ARE IN FORCE AND
THE CONTROL IS REACHABLE**, which is the owner's 2026-09-09 call: the
row's kebab menu stays and restart stays on it. One line of this project
folded the row's controls back to inline pin and close and removed
restart with the menu; that was not taken. See "The row's controls" under
the status lights.

1. `actionsFor` offers restart on a row whose status we POSITIVELY know
   is live. `unknown` still gets close alone.
2. The picker's arm checkbox (`SessionRestartLive.armHtml`, always
   emitted unchecked, takes no argument) is what unlocks the choices. `optionsHtml` derives
   `disabled` from `actionable_now` ALONE, so a live pane paints every
   radio locked whatever it projects.
3. `App.showConfirmModal` with `SessionRestartLive.liveConfirmCopy`,
   which names the
   bare-shell outcome AND what happens to the conversation. Measured
   2026-09-08: 18 of 22 live sessions have an empty `pane_start_command`,
   so an UNPICKED restart comes back a login shell for 82 percent of them
   (it read 15 of 19 on 2026-09-07; the population moves, re-measure
   rather than quoting either). That warning is what makes this safe to
   ship. Note the whole sentence: an explicit wrapper choice OVERRIDES
   the gate (`session_respawn.py:542`), so only an unpicked restart lands
   on the shell rung.
4. `confirm_restart_live` on the request. `RespawnPlan.kills_live_pane`
   is the ONLY thing that makes anything pass `-k`, and it is set only
   when the pane was measured alive AND the caller confirmed AND the
   rung is actionable. `project_restart_rung` has no liveness input, so
   a projection cannot set it. `refuse_if_transcript_missing` BUILDS its
   refusal rather than copying, so a missing transcript cannot kill.

`activity_status` informs all of this and refuses none of it - it reads
`working` for about four minutes after a resume.

**Identity is MEASURED across the kill, not assumed.** `#{session_created}`
belongs to the SESSION and `-k` replaces the pane's PROCESS, so on tmux
3.7c the instance triple does not move (measured 2026-09-07: same epoch,
same `pane_id`, new `pane_pid`). Fourteen queries in `src/core` key on
that triple exactly and all read the same column, so they break or hold
together. `TmuxBackend.respawn` therefore reads the epoch either side and
`session_instance_rekey.reconcile_instance_epoch` answers `unchanged` /
`rekeyed` / `cannot_determine`, re-keying the row on the OLD triple if it
ever does move. `cannot_determine` is not `unchanged`; a reading that did
not answer is not evidence nothing moved.

**Respawn writes exactly one column, and only when asked.** On a restart
verified alive with a picked wrapper, `sessions.agent_type` is updated on the
row keyed by the instance triple. Nothing else - a respawn is still not a fork
and never touches a lineage column. With no `agent_type` it issues no write at
all. A restart that FAILED records nothing, and `agent_type_persisted` says so
rather than letting a stuck choice look saved.

## The conversation id, and how a row loses it

`sessions.claude_session_uuid` is the id a restart resumes: the row's copy of a
transcript uuid. Do not conflate it with the instance triple, a pin id or a
project name. Everything in this section was traced to file and line on 2026-09-08 and
shipped in `8dd54a8`. **Note that `8dd54a8` is committed but not deployed at
the time of writing**, so a live install may still be showing the old
behaviour.

| Piece | File |
|---|---|
| Second chance at correlation when the hook writes nothing | `src/core/session_lineage_recovery.py` |
| How Claude Code actually slugifies a working directory | `src/core/claude_project_dirs.py` |
| The correlation ladder itself | `src/core/claude_transcript_correlate.py` |
| Propose a uuid for a row that lacks one | `src/core/session_uuid_backfill.py` |
| What counts as evidence, and what only corroborates | `src/core/session_uuid_backfill_rules.py` |
| Render the proposal for a human | `src/core/session_uuid_backfill_report.py` |
| The operator entry point, DRY RUN BY DEFAULT | `scripts/backfill_claude_session_uuid.py` |

**A ONE-SHOT CHANNEL WITH NO RETRY IS THE WHOLE PROBLEM.** On the create path
the uuid had exactly ONE writer, Claude Code's `SessionStart` hook. An empty
POST body becomes `{}` at `routes.py:2108`, `session_manager.py:4341` returns
`LINEAGE_UNRESOLVED`, and nothing is written. The live log holds 25 such
failures across 20 distinct sessions, and 16 of 39 rows carried no uuid at all.
Contrast the other hook events, which repeat: that is precisely why
`last_work_at` self-heals on the next event and the uuid never did. If you add
a field fed by a hook, ask which of the two kinds of event feeds it, and give
the one-shot kind a recovery path rather than a log line.

**A FALLBACK THAT CANNOT FIRE IS NOT A FALLBACK, AND IT IS INVISIBLE.**
`slugify_project_dir` mapped only `/` and `.`. The real rule replaces
EVERYTHING outside `[A-Za-z0-9-]` with a single `-`, verified against 908 of
919 live transcripts. Every path on the developer's machine contains a space
and two tildes, so every slug the ladder built was wrong and the fallback had
NEVER ONCE SUCCEEDED there. It looked exactly like a fallback that was never
needed. A ladder rung that has never been observed to fire is unmeasured, not
proven.

**A RECORDED uuid IS NOT EVIDENCE A TRANSCRIPT EXISTS.** Rows fall into three
groups, not two: over 39 rows, 16 absent, 18 sound, and 5 PHANTOM, holding a
uuid with no file behind it. All 5 phantoms collide with a sibling row, because
the correct uuid is already held by the twin that the cwd spelling trap split
off. The mechanism is `--fork-session`: it MINTS A NEW uuid, `SessionStart`
records the new one, and the forked transcript may never materialise. So the
picker can say "no transcript for <uuid>" perfectly truthfully about a uuid
that has nothing to do with the conversation the user is in, while the real
73 MB transcript sits on the archived twin. A message can be locally correct
and lead every reader to the wrong conclusion.

**Both cwd spellings must be resolved in BOTH directions.** Forward, by
slugifying every spelling found in a HOME symlink scan; and backward, from each
transcript's own recorded cwd, canonicalised. Backward is not optional: 754 of
919 transcripts sit in a directory that disagrees with their own recorded cwd.

**Evidence is counted in independent FAMILIES, and weak signals corroborate
rather than create.** Two matcher defects were caught by CONTROLS, not by
reading the code, and both would have shipped looking right. Directory
agreement was clearing a two-signal bar as one fact corroborating itself. And
the negative control, a row pointed at a project that does not exist while real
transcripts are present, returned `ambiguous` instead of `no_candidate` because
timing alone counted as evidence; an anchor gate now lets timing and title
corroborate a candidate and never create one. **A matcher that always finds
something is worse than useless**, so a negative control is mandatory for
anything in this family.

**`agent_type` is a SEPARATE failure, do not fold them together.** A crosstab
over all 39 rows finds 14 with `agent_type` NULL and a hook-written uuid. The
two are independent, and the `agent_type` persistence gap is still its own open
item.

## Naming a session, and the one name rule

ONE NAME PER SESSION, LAST RENAME WINS FROM EITHER SIDE. It lives in three places
- `sessions.title` (the browser), claude's own name (`--name`, `/rename`) and the
jsonl's `custom-title` record, where the two writers MEET. See
`src/core/claude_title_sync.py` (tail reader + rules), `claude_title_sync_apply.py`
(the seam, run from the hook route on every event), `claude_rename.py` (push out).
**NO HOOK EVENT CARRIES A `/rename`** - claude intercepts slash commands before
they become prompts - so the pane's name is only readable by READING THE
TRANSCRIPT. Last 64 KB only, 0.274 ms median against a 244 MB file, because this
runs on `PreToolUse`; an older rename reads `no_record` and changes nothing.
`sessions.claude_title` stops being dead weight and becomes the marker that makes
the sync idempotent under duplicated events.
**FIRST SIGHT OF A TITLE IS A BASELINE, NOT AN INSTRUCTION**: `custom-title` has
no timestamp, so it cannot be ordered against the label already on the row.
**A BOUND uuid IS NOT EVIDENCE A TRANSCRIPT EXISTS** and the push paid for it -
14:47:41Z 2026-09-08, a rename logged `claude_rename_pushed` and delivered
nothing because the file appeared 2m33s later, `--resume` exited 1, stderr went to
DEVNULL. `decide_push` now defers on a MEASURED absence only (`unchecked` still
sends) and `spawn_oob_rename` reaps and logs. STILL OPEN: a deferred push is
never retried; `title != claude_title` is the marker a retry would key on.
**The plain create endpoint was the one creator passing no label**, so only
launchpad sessions launched claude with no `--name`; `CreateSessionRequest.label`
closes it, and an absent label leaves the command line byte-identical.

## Where a new project's folder comes from

A project's directory is `sessions.working_dir`, and it is permanent: the
row carries it, the launcher lists it, and the archive derives a
transcript directory from it. So the create path is the one place that can
poison every downstream reader, and until 2026-09-08 it did.

| Piece | File |
|---|---|
| Compose, validate and create the directory | `src/core/project_directory.py` |
| The folder step, and the pure rules behind it | `client/js/project-create-folder.js` |
| Where it is wired in | `src/api/routes.py` (`create_session`), `client/js/launchpad.js` (`_createNewSessionInner`) |

**"START EMPTY" HAD NO FOLDER STEP AT ALL.** The chain was "+" > new
claude project > start empty > provider > name this project > create
session, and nothing in it ever asked where the project should live. The
client posted a name and no `working_dir`, so `SessionManager.create_session`
fell through to `work_path = settings.get_working_dir() / session_id` and a
project the user named `Punchlist Test` was created at
`.../ses_5a756046`. That is not a folder anyone chose, recognises, or can
find later, and it was written into the row as the project's home. The
fallback is still there for an old client, but it now logs at warning
level: it went unnoticed for as long as it did precisely because it was
silent.

**THE SECOND DEFECT WAS IN THE SAME LINE, AND IT IS GOTCHA 6.** That path
was built with `Path.expanduser()`, which expands `~` and stops. It does
NOT resolve symlinks, so `~/Development` stayed the SHORT spelling of a
directory that really lives in iCloud, and a short spelling is how one
directory becomes two projects. `project_directory` canonicalises with
`os.path.realpath` instead, so the LONG spelling is what reaches the row.
`tests/test_project_directory.py` asserts that against a real symlink
rather than trusting the reading.

**THE NEW FIELD IS `project_parent_dir`, NEVER `working_dir`.** Three
shipped flows already post `working_dir` with a folder from anywhere on
disk: "open an existing folder", the new-console FAB (it posts `~`), and
clone. Attaching a root restriction to that field would start refusing
folders they have always accepted, which is a worse bug than the one being
fixed. A restriction on a field nothing used to send cannot regress
anything. The server joins the parent to `project_name` itself, so the
client cannot compose a path the server did not check.

**Traversal and symlink escape are ONE check.** The parent goes through
`realpath` BEFORE any comparison, so `..` cannot survive and a symlink
bridge resolves to where it really points. Containment is component-wise,
never `str.startswith`, or `/Users/jsugamelevil` reads as living under
`/Users/jsugamele`. The allowed roots are the projects root plus HOME, and
home is deliberately generous: the owner's projects live under the iCloud
Sync path rather than under `DEFAULT_WORKING_DIR`, so a root set of only
the projects root would refuse the exact folders the folder step exists to
offer. That is a silent way of not shipping the feature.

**A name is REFUSED, never rewritten.** Spaces are legal and stay verbatim
(the owner's own projects have them). `/`, `\`, NUL, control characters, a
leading dot, `.` and `..`, and anything over 255 bytes come back as an
inline sentence. A sanitiser that turned `a/b` into `a-b` would make a
folder the user did not ask for and cannot find. An existing EMPTY target
directory is fine; a non-empty one refuses.

"clone from github" does NOT have this defect: it has collected a parent
directory since it shipped (`launchpad.js`, `modal-clone-parent`).

## The status lights, and what they are allowed to claim

Full model in `docs/session-status.md`. The eight states are `working`,
`working_subagent`, `question`, `notice`, `finished_unread`, `idle`,
`dead` and `unknown`. `UserPromptSubmit`/`PreToolUse`/`PostToolUse` move to
`working`; `SubagentStart` with no matching `SubagentStop` to
`working_subagent`; `PermissionRequest` to `question` and `Notification`
to `notice`; `Stop` to `finished_unread` while unread, `idle` once seen;
tmux's `#{pane_dead}` to `dead`; everything else is `unknown`, which is a
real answer and never `idle`.

**FIVE COLOURS ON ONE LIGHT, AND THE ENVELOPE IS GONE.** The owner's
rule, 2026-09-08, verbatim: "if the session is fully stopped waiting for
a response, then yellow. if it's still working but needs something from
me, make it light blue", over "red if the connection is disconnected,
grey if the session is idle, green if there is activity", plus "finished
turn waiting on me to look at should be a green outline and grey filled
dot". GREEN is `working` / `working_subagent`. YELLOW is `question` AND
the startup gate's `awaiting_startup_prompt` - both are fully stopped and
the user's answer to both is the same. LIGHT BLUE is `notice` alone, the
only state that is working AND asking for you. GREY is `idle` and
`unknown`, told apart by SHAPE (`unknown` is drawn hollow) rather
than by a louder colour. RED is `dead` and a dropped WebSocket. And
`finished_unread` is a crisp green ring around a CLEARED centre. THE
EIGHT INNER STATE NAMES STAY EIGHT - only the paint collapses onto five
hues, because the accessible label still has to say which state it is and
colour was never allowed to be the only signal.

**THE GREY FILL IN THAT RING WAS WITHDRAWN, and the two hollow lights now
share one recipe.** Shipped, the ring put a mid-grey `done` dot inside the
green band and it read as two lights stacked. The owner's 2026-09-09
correction, verbatim: "it should look like the 'status not measured' dot,
but the outline should be green instead of light grey with the dark grey
center". So `--led-fill: transparent` is declared in ONE rule naming both
`[data-inner='unknown']` and `[data-outer='unread']`, and the dot's
`background` reads that token rather than `--led-ink`. Two copies of
"clear the middle" would drift into one state showing the real background
and the other showing a grey somebody picked, so the count of that
declaration is asserted. Note the trap the token also closes: the legacy
`.status-dot.status-led` compat block outranks `[data-outer='unread']` and
sits later in the file, so a `background: var(--led-ink)` there silently
refills both hollow states on every surface. CLEARING A FILL MOVES PAINT,
NOT GEOMETRY - measured at 8x device scale before and after, all nine
(inner, outer) pairs painted an IDENTICAL extent to the hundredth of a
pixel, so `--led-lit-scale` is untouched.

**THE KEY IS SEVEN ROWS, ONE PER LIGHT, NOT ONE PER STATE.** It carried
nine and the owner asked for "one entry per colour": two rows showed the
same yellow and two the same red, which sends a reader looking up a dot
hunting for a difference the light cannot show them. Yellow is now
"stopped, waiting on you", red is "dead / disconnected session", and green
and grey each appear twice ONLY because a solid dot and an outline are two
different things on screen. THE STATE MACHINE DID NOT CHANGE: the four
collapsed states still exist and the dot's own `title` / `aria-label`
still say which of each pair it is, which makes those labels load-bearing
rather than decorative. `tests/test_status_key.node.mjs` pins the count,
that every hue has a row, that no two rows draw the same light, and that
the collapsed pairs resolve to one colour in the STYLESHEET while their
words still differ.

The unread ENVELOPE ICON went with it, from the sidebar row menu and the
launchpad card. It was also the manual mark-unread control, so its click
and keyboard handlers went too. Unread TRACKING is untouched: `Stop` still
sets it, a WS terminal binding still clears it, `src/core/unread_store.py`
still keys on the instance, and `PATCH /sessions/{name}/unread` still
exists with nothing in the UI calling it. The green ring is the only thing
saying it now, which is why it is drawn as a REAL RING - transparent
centre, 2.5px inset band - and not as the blurred wash every other halo
wears. THE FILL WAS THE TRAP: the halo pseudo-element paints ABOVE the
element background, which IS the dot, so an opaque disc renders
`finished_unread` as a solid green blob with no grey in it. Measured in a
6x render before it shipped.

**ONE LIT DIAMETER FOR EVERY STATE, and the element box was never the
thing that varied.** Measured 2026-09-09, all forty (inner, outer) pairs
reported a 9.0px ELEMENT box - which is exactly why 190 green suites had
never caught what the owner could see. The HALO was sized per state and
drawn partly OUTSIDE its own box by a spread `box-shadow`, so the lit
object came out at three diameters: about 14.7px for `active`, 15.3px for
`unread` (that block set its own scale), and an invisible halo for every
resting state, which therefore reads at the bare 9px dot. One working
session in a column of quiet ones read about 60 percent wider than its
neighbours. `--led-lit-scale` is now declared ONCE on `.status-led` and
overridden by no state, and the glow is a RADIAL GRADIENT rather than a
spread shadow - a gradient fades out AT the box edge, so the halo's
painted extent IS its declared box and can be held to a number; a spread
shadow paints beyond the element by definition and never could.
`scripts/verify_status_led_geometry.py` measures the whole matrix in a
real Chromium across three themes and two viewports, because the
divergence was in what the box RESOLVES to once a per-state override and
a pseudo-element's own shadow are composed, and no CSS read composes
those.

**THE GROUP HEADER'S ROLL-UP IS THE ROW COMPONENT, and its yellow `(n)`
badge is gone** (2026-09-09, "to be clear remove the yello (1)").
`session-status-summary.js` folds the children to an (inner, outer) pair
and hands it to `StatusLed.ledHtml`, so a header takes the finished-turn
ring exactly as a row does. Nothing replaced the count: the ring already
says there is something in here for you, and two indicators for one fact
is how they come to disagree. The plain count pill saying how many
conversations a folded section hides is a DIFFERENT control and stays.

**THE LIGHTS FINALLY HAVE WORDS**, in `client/js/session-status-key.js` -
a foldable legend at the foot of the sidebar, collapsed by default on
`cloude.statusKey.open`. Every swatch is a real `ledHtml`, never a
drawing of one, so the legend cannot show a colour the app does not
paint. It replaced the "N remembered positions are held for sessions not
currently listed" note, which named bookkeeping no reader could act on;
the remembered slots themselves are untouched and still stamped on the
list element as `data-order-missing`.

**BELOW THE KEY SITS THE APP'S OWN VERSION, ONE COMPONENT FOR BOTH
PLACEMENTS IT APPEARS IN.** `client/js/version-footer.js` renders a
small grey `<span class="version">` and both surfaces call it: the
sidebar footer (right after the status key, its own `.version-footer`
block) and the home screen's bottom bar chip
(`renderHomeBarVersion()` in `launchpad.js`, which now only owns a mount
point). It reads `<meta name="cloude-app-version">`, stamped once at
serve time by `src/main.py` from the SAME resolver `GET /api/v1/version`
calls (`src/core/version.py::resolve_version()`) - not a second fetch of
that endpoint, because the value cannot change while the page is open
and the Electron tray already polls that endpoint every 20 seconds for
its own reason. **AN UNRESOLVED VERSION RENDERS `"version unknown"`, NOT
A BLANK CHIP.** Before this file existed, an empty meta tag made the
home bar's chip vanish (`.home-bar__version:empty { display: none }`,
now removed) - which read as a missing control, not as "the build could
not be determined", and defeated the one thing a version footer is for.

**A DROPPED SOCKET IS THE ONE SIGNAL THE SERVER CANNOT REPORT**, so it
lives in `client/js/session-transport.js`, written from `terminal.js`'s
`ws.onopen` / `ws.onclose` and read by the sidebar rows and the launchpad
cards on their way into `dotHtml`. This browser holds a socket to at most
ONE session, so **every other session answers `unknown`** - a sidebar full
of red because one socket dropped would be the fabricated-measurement
mistake this whole model exists to avoid. A DELIBERATE close CLEARS the
record rather than marking it disconnected. `dead` and `disconnected`
share the red, so the LABEL is the only thing separating them and the two
must never be paraphrases: "dead - the process exited" against
"disconnected - no live connection to this session".

**`question` AND `notice` ARE TWO STATES BECAUSE A PERMISSION PROMPT
STOPS THE AGENT AND A NOTIFICATION DOES NOT.** They were one state named
`question` until 2026-09-08. A `PermissionRequest` halts claude mid-turn
until a human answers a yes/no; a `Notification` is claude asking to be
looked at while nothing is blocked. Collapsed, a chatty session painted
exactly like a parked one, so the state that most needed acting on
stopped standing out - the false-urgency twin of this project's
false-green problem. They are TWO INDEPENDENT BOOLEANS,
`permission_open` and `notice_open`, not one field with three values:
hooks arrive unordered and duplicated, so a `Notification` landing either
side of the `PermissionRequest` it accompanies must not be able to move
the blocking claim. `permission_open` is read first, so a session holding
both answers `question`. Both are cleared by the same three events
(`UserPromptSubmit`, `PreToolUse`, `Stop`) because what resolves either
is the user showing up. On the LED the split is now VISIBLE rather than
only recorded: `question` is inner `waiting-permission` and paints yellow
with the startup gate, `notice` is its own inner state and paints light
blue. Light blue over a third warm hue because the pair has to survive
red-green colourblindness - under protanopia and deuteranopia the green
desaturates toward a pale khaki while a blue at this wavelength stays
plainly blue. Summary priority for the header's INNER dot is
**permission > input > working > unread > done > dead > unknown**, and
`notice` still buckets as `input` - the colour split is a rendering
decision on the ROW, not a re-ranking. The `done` bucket means "finished
and already read" and renders the grey `idle` dot. The header's RING is
NOT looked up on the winning bucket: it is folded separately, from
activity across the whole group, so a group holding one parked session
and one busy one paints the parked dot inside a breathing ring rather
than hiding the work behind the more urgent light.

**A SESSION WAITING ON ITS OWN SUB-AGENTS IS NOT WAITING ON THE USER, AND
NEITHER `Stop` NOR `Notification` MAY SAY IT IS.** claude fires `Stop`
when the MAIN turn ends whether or not the background agents it launched
are still running, and it raises a `Notification` in that same state, so
a pane reading "Waiting for 2 background agents to finish" was raising
both a "Your turn" and a "wants your attention" card. That is the
false-urgency twin of the `question`/`notice` fold above: a summons to a
session that wants nothing. The gate is one condition in
`claude_event_hook` (`src/api/routes.py`) reading
`SessionManager.subagent_depth`, a passthrough to the count
`SessionActivityTracker` already keeps for `working_subagent`; nothing new
is stored and the state machine is untouched, so a suppressed `Stop`
still flips unread and still resolves its status. Only the interruption
is skipped.

**IT REFUSES TO RAISE; `toast_auto_ack.py` ANSWERS WHAT WAS RAISED. THE
TWO CANNOT DOUBLE-CLEAR.** They are on opposite sides of the same
handler and touch different state. The gate is a pure read of
`subagent_depth` taken BEFORE `record_hook_event`, and its only effect is
to skip the `raise_toast` call for `Stop` and `Notification` - it clears
nothing, acks nothing and writes nothing. `auto_ack_toasts` runs after
the event is recorded and only ever moves an ALREADY OPEN toast to
`answered`, keyed by KIND and bounded by the event's own instant. A toast
the gate suppressed was never opened, so there is nothing for the ack to
find; a toast the gate allowed is acked exactly once, by the same
kind-keyed rule that survives a duplicate or a reorder. Order is what
makes that safe and it is deliberate: ack what is open first, then decide
whether to raise.

**`PermissionRequest` IS NEVER SUPPRESSED, AT ANY DEPTH**, because it is
a HARD BLOCK - claude has stopped mid-turn and cannot continue until a
human answers - which is the one case where a busy session genuinely is
waiting on the user. That is the whole exception, and it is the negative
control the tests turn on: a suppression rule that quietly grew to cover
it would pass every positive test and strand claude behind a yes/no
nobody was told about.

**THE DEPTH IS READ BEFORE THE EVENT IS APPLIED, and that ordering is the
whole mechanism.** `Stop` RESETS `subagent_depth` to 0, so a gate reading
the count afterwards answers 0 every time and can never fire. It also
cannot be built on `SubagentStop`, which on a turn with no subagent in it
arrives about 1.5s AFTER the `Stop` (the punchlist 4 measurement above) -
an event that has not landed yet can neither confirm nor deny anything.
And it FAILS TOWARD NOTIFYING: an unknown session, a dropped
`SubagentStart`, or a read that threw all leave the count at 0 and the
toast is raised exactly as before. Silence is bought only with a POSITIVE
count, because a missed "your turn" is a worse failure than a spurious
one.

**THAT SAME FOLD NOW PICKS THE ONE TOAST CARD A SESSION GETS.** The toast
stack coalesced on (kind, session) until 2026-09-09, so one session
produced one card per kind - a "wants your attention" card AND a "Your
turn" card, about the same session; four cards for two sessions, measured.
`client/js/toast.js` keys the group on the SESSION alone, and
`client/js/toast-session-group.js` READS `SUMMARY_PRIORITY` out of
`session-status-summary.js` to pick which pending event that card shows.
It declares only the join from a hook event name to a bucket -
`PermissionRequest` to `permission`, `StartupPrompt` and `Notification`
to `input`, `Stop` to `unread`, anything unrecognised to `input` (the
same refusal-to-assume-harmless as `SEVERITY_DEFAULT`) - with toast.js's
own severity breaking a tie INSIDE a bucket so a blocking startup prompt
is not displaced by chatter. THERE IS NO SECOND RANKING; if the fold is
unavailable the module groups NOTHING rather than inventing one. The
pick is a pure FOLD over what is held, which is what makes the card
upgrade in place, refuse to downgrade, and survive the same hook event
twice. The `xn` badge counts the WINNER'S KIND, never the session's pile
- it sits beside the winner's title and would otherwise put a 7 next to a
sentence that happened once - while the dismiss control, the "Dismiss
all" disclosure and the overflow row all count RECORDS. The attachment
receipt (`client/js/attachment-toast.js`) is deliberately outside this
grouping: no server record, retired by the prompt being SENT, so it keeps
a card of its own. Full model in `docs/session-status.md`.

**A CLOSING HOOK EVENT IS NOT A HEARTBEAT ON ITS OWN, and that was
punchlist 4.** Measured twice by `tests/test_led_real_hooks.py` on claude
2.1.265: on a turn with NO SUBAGENT IN IT, `SubagentStop` arrives about
1.5s AFTER `Stop`. `Stop` had just cleared `last_tool_event_ts` to say the
turn was over, `record_event` stamped it again, and a finished session
painted `working` for the full 120s - `finished_unread` lasted a second
and a half and `idle` was UNREACHABLE. The rule now: an event that CLOSES
something stamps only when something was open for it to close.
**`SubagentStop` NEVER STAMPS the heartbeat: it says work ENDED, so the
only thing it moves is `subagent_depth`, and it moves that with the floor
at 0.** It first shipped gated on `subagent_depth > 0` instead, and THE
GATE IS NOT THE CLAIM IT STANDS FOR - a duplicated `SubagentStart`
delivered after `Stop` raises the depth off the floor by itself, so the
duplicated `SubagentStop` behind it passed the gate and stamped, at its
own arrival time, ratcheting the expiry out on every further pair.
`PostToolUse` cannot take a blanket refusal (it is the only event some
legitimate turns emit late), so it keys on a `turn_open` boolean that
every OPENING event sets and `Stop` clears, and is refused ONLY when a
`Stop` was POSITIVELY seen and nothing has opened since - never having
seen a `Stop` is not evidence the turn ended. Opening events still stamp
unconditionally, so a stray `SubagentStart` after `Stop` still buys ONE
bounded window keyed on itself; what no `SubagentStop` can do is extend
it.

**A DEAD PANE DROPS OFF THE LIVE LIST AND BELONGS IN RECENT.** The
owner's call, verbatim 2026-09-08: "they go into recent, they can
disappear." A session whose process died has stopped, so its row leaves
`GET /sessions/list` rather than lingering there wearing a dead light,
and a restart from Recent is a resume. `dead`/`off` stays in the LED
vocabulary but is GALLERY-ONLY - no live endpoint is meant to carry a
dead row to the client. A round that read the same measurement as a bug
and made a husk KEEP its row, painted dead, was overruled and reverted
(`ba2aa5d`), and `tests/test_led_real_hooks.py` holds the line against a
real killed pane. STILL OPEN: `remain-on-exit` keeps the husk's tmux
session in the listing, and `session_lifecycle` reaps on ABSENCE from
that listing, so the row leaves the live list without yet arriving in
Recent. Closing that needs a reaper rung keyed on a MEASURED
`#{pane_dead}`, which is a new durable writer and its own change.

**A VIEW CLEARS AN OPEN `permission`, AND AN OPEN ONE IS VERIFIED
AGAINST THE PANE AFTER 20 SECONDS.** Measured 2026-09-09,
`cloude_Media_Compression` painted `question` over a pane holding no
dialog because the flag was set on `ses_949a8585` while the claude in
that pane posts its spawn-time `adopted:cloude_Media_Compression`, so
every clearing hook landed on a different tracker key and nothing
reachable could retire it; the toast path already remaps that split and
the activity tracker does not. So `session_view_clears` now clears
`permission_open` too, and while the flag is open past
`PERMISSION_TAIL_GRACE_SECONDS` the listing pass takes ONE `capture-pane`
and clears it when claude's dialog is not on screen - marker present
keeps, marker absent clears and logs `permission_flag_cleared_no_dialog`,
an UNREADABLE tail keeps, and the markers were read off two real dialogs
(`Do you want to ...?`, `❯ 1. Yes`, `Esc to cancel · Tab to amend`)
rather than guessed. See `src/core/session_permission_verify{,_apply}.py`.

**A tmux `running` pane maps to `unknown`, NOT `working`.** It means only
"the foreground command is not a bare shell", which is equally true of an
agent mid-tool-call and one at an empty prompt, and the fallback carries no
timestamp so nothing could expire the claim. Measured 2026-09-08: 15 of 19
live sessions report a claude VERSION STRING as `pane_current_command`, so
that branch is the common case and all 15 were reporting a permanent
`working` on no evidence. Hook-fed `working` still expires after 120s.

**AND THAT LEFT `unknown` AS THE COMMON READING, SO A RESTING CLAUDE IS NOW
SEEDED FROM EVIDENCE THAT OUTLIVES THE PROCESS.** `SessionActivityTracker` is
in-memory and nothing hydrated it, so a restart left every session on the
tmux tier: measured on live 2026-09-08 22:24Z, 19 live panes and 15 painting
`unknown`. Ten had NEVER fired a hook and never will - hand-started without
the hook env, last assistant turns dated 2026-07-16 and 2026-08-24, alive at
an idle prompt for weeks. `src/core/session_status_seed.py` is the ladder
(records in `_records`, cache in `_store`, the two reads and the seam in
`_read`): rung A is `sessions.activity_state` judged by
`activity_persist.restore_state` and read on the FULL INSTANCE TRIPLE, the
same WHERE clause `write_state` writes on, because a name-scoped read answers
for whichever epoch sorts newest; rung B is the last decidable record of the
bound transcript, walked BACKWARDS through the one bounded reader
(`claude_title_sync.read_tail_records`, now extracted so there is exactly
one) so the newest evidence wins. **IT MAY CLAIM REST AND MAY NEVER CLAIM
`working`**: a file carries no heartbeat, so a `working` seeded from one
could never be expired - the identical defect the paragraph above just fixed,
one tier down. A sidechain `end_turn` is UNDECIDABLE (a subagent finishing
inside a live turn), and so is a slash-command envelope, which is what the
measurement forced: claude intercepts `/rename` before it becomes a prompt
but still writes a pseudo-`user` record about it, and reading those as
prompts pinned the only two sessions the ladder refused at in-flight while
both sat at an empty prompt. Wired at the boot re-adopt, after
`POST /sessions/adopt`, and at ONE seam in `_session_info_for` reached only
while the answer is still `unknown` on a pane measured LIVE, so a seed can
add an answer and never overwrite a measured one. A hook retires it
instantly (the seam is gated on `hooks_seen`), which is also what makes it
idempotent - a seed is a cached READING, not an event. Read-only against the
live DB and the real corpus before shipping: **all 15 unknowns would read
`idle`**, every one via rung B, 0.27 ms median each. The negative control is
separate and load-bearing, because a matcher that always finds something is
worse than useless: over 400 sampled transcripts it splits 172 `at_rest` / 70
`in_flight` / 158 `no_marker`. Full model in `docs/session-status.md`.

**AND A HOOKLESS SESSION NOW READS ITS OWN TRANSCRIPT FOR WORK, because an
mtime is a TIMESTAMP and the objection above was about a RECORD** - measured
2026-09-09, only 6 of 19 live sessions had ever fired a hook, and three of
the other thirteen had touched their transcript inside 36 minutes while
painting the same rest as ones last touched in July;
`src/core/session_transcript_status{,_read}.py` is rung 0 of the same ladder
(mtime inside `WORKING_HEARTBEAT_TIMEOUT_SECONDS` -> `working`, carrying an
`expires_at` that `display_state` enforces so the 60s seed cache cannot
stretch it; a turn end NEWER than the one its instance-keyed ledger already
holds -> `finished_unread` plus ONE auto-unread claim, where FIRST SIGHT IS A
BASELINE so a restart never re-lights the fleet), gated on `hooks_seen` and
NOT on the hook token store, which holds 33 entries for 19 live sessions
including every adopted pane. **A VIEW NOW CLEARS AN OPEN `notice` AND NEVER
AN OPEN `permission`** (`src/core/session_view_clears.py`, reached from the
WS bind and from mark-read): a `Notification` is a message to the user and
survived a 46-minute visit on BHPP, while a `PermissionRequest` is a blocking
fact about the agent that looking at does not answer. `status_source`
(`hook` / `transcript` / `seed_row` / `tmux` / `none`,
`src/core/session_status_source.py`) rides the `/sessions/list` wrapper and
renders in the TOOLTIP ONLY, and `client/js/session-header-led.js` finally
puts the same LED beside the session name in the terminal header.

**Unread is keyed on the INSTANCE**, `<tmux_name>@<#{session_created}>`,
because a name is reused and a flag from a killed session reappeared on its
successor. Set on `Stop` and by the user's control, cleared when a WS
terminal binds. An unmeasurable epoch degrades to the legacy name key.
**THE EPOCH HAS ONE SOURCE, `src/core/unread_identity.py`, AND IT IS THE
LIVE TMUX LISTING** - set, clear and read all reach it through
`SessionManager._unread_epoch`, because two derivations for one key are
two keys the moment they disagree and a clear on a key nobody wrote can
never be undone by clicking. It refuses the DB row's recorded epoch and
the session_id-keyed `_instance_epochs` alike; its name-keyed cache is a
memo of the tmux measurement, refreshed by every listing.
**AND THE CLEAR ONLY HAPPENS IF A SOCKET ACTUALLY OPENS.** Measured
2026-09-09: a session entered in a BACKGROUNDED tab opened none, because
`waitForFontsAndLayout` ended on bare `requestAnimationFrame` awaits that
a browser never runs for an unpainted tab, suspending
`connectWebSocket()` before `openWebSocket()`. No socket means no
`onclose`, so no reconnect rung fires either: the terminal sat on
"Connecting to terminal..." for 35 minutes and resumed the instant the
tab was painted. THERE WERE THREE such waits, not one - the sidebar
rejoin and the adopt path each carry their own, ABOVE the
`setTimeout(..., 500)` that schedules the connect, so fixing only the
first changed nothing and only a live re-check found that.
`client/js/terminal-layout-wait.js` races every wait against a timer - a
layout wait may DELAY a connect, never CANCEL one - and
`tests/test_terminal_layout_wait.node.mjs` fails the build if a bare rAF
await reappears in `terminal.js`.

**IT IS ONE FLAG, AND EVERY WRITER AND READER MUST MEASURE THE EPOCH.**
The owner's rule, verbatim: "when clicking a tab, the session is marked
read. if i want it unread i click unread." So `auto` and `manual` are two
writers of one state: opening the tab clears BOTH (it used to spare
`manual`), and so does clearing the control, through `UnreadStore.clear`.
Both writers now resolve a measured epoch and `/sessions/list` reads with
the `created_at_epoch` on its own bulk tmux probe rather than the
`_instance_epochs` cache, which is EMPTY for every session predating the
process and composed the legacy bare-name key - so a flag written under
the instance key was on disk and invisible to the endpoint. And the LED
finally receives it: `SessionStatusUI.dotHtml(status, signals)` takes
`unread` and `startup_gate` as a second argument, no live caller passed
it, and an unread `idle` session therefore painted a `steady` halo on
every surface. Full model in `docs/session-status.md`.

**`finished_unread` VERSUS `idle` IS DERIVED FROM THE UNREAD FLAG AT
RESOLVE TIME, BY ONE FUNCTION, ON EVERY PATH** - `derive_read_state`
(`src/core/session_status.py`), called from the hook tracker's resolve,
the tmux fallback, the seed's `display_state`, the transcript ladder's
rung 3 and the assembled answer in `_session_info_for`, so a saved
`finished_unread` becomes `idle` the moment the flag clears and
`activity_persist.write_state` stores only the base state. It shipped as
a one-directional rule - adding unread to an `idle` and never removing it
from a stored `finished_unread` - which is a cache rather than a
derivation, and measured on live 2026-09-09 the owner opened
`cloude_daily-briefing` and got `finished_unread` beside `unread: false`
from `status_source: seed_row`, a green dot over a session he had just
read.

**THE OUTER RING MEANS ACTIVITY AND NOTHING ELSE**, restoring the owner's
original spec ("colored and pulsing on activity and steady on done"):
`working` breathes, a live-but-stopped turn (`question` / `notice` / the
startup gate) is lit and still, and every resting or dead state leaves it
off, with the outer `unread` state and its `--led-color-unread` hue
retired. Unread now rides the INNER dot alone - green `done` against grey
`idle` - because a breathing amber ring on a finished conversation read
as background work, which is exactly what the owner reported: "the ring
around some of the leds are not gray, which means there should be
background tasks. i dont think those few have any background tasks."

**The LED is two independent rings** (`client/js/status-led.js`): an inner
dot for the chat's status AND an outer ring for activity and attention,
so "a parked session with work still running behind it" is sayable on a
group header. `dotHtml` delegates to it, so every surface renders the
same component - and every surface must PASS IT SIGNALS (`unread`,
`startup_gate`, `status_source`, `transport`), not just the status
string, or the finished-turn ring, the disconnected red and the
provenance tooltip can never render. A WORKING session is solid green
whatever its unread flag says, and `unknown` never takes the ring at
all: the ring asserts that a turn FINISHED here, and neither of those
measured one.

**UNREAD RIDES THE RING, AND THE OWNER SETTLED THAT ON 2026-09-09.** Two
lines of this project fixed the same reported defect - a ring pulsing on
sessions with nothing running in them, "the ring around some of the leds
are not gray, which means there should be background tasks. i dont think
those few have any background tasks" - and they fixed it in opposite
ways. One retired the outer `unread` state and moved unread onto the
inner dot; this one KEPT the ring, stopped it breathing, and made it a
crisp still green. **The owner chose the ring.** So `unread` is an outer
state, `--led-color-unread` exists, the `done` bucket stays in the
summary priority, and MOTION is what carries the original complaint: only
`active` animates, so a light that moves is a session that is moving.
`client/js/session-status-key.js` is the legend that teaches the
vocabulary, and it describes this model. Do not reintroduce the
inner-dot-unread model - it was decided against, not forgotten.

BOTH RINGS ARE ONE ELEMENT: the inner is the span's `background-color`
and the outer is a four-layer `box-shadow` on that same span (an optional
hollow rim inside the dot, a hard `0 0 0 1.5px` ring, a low-alpha feather
at the same spread that softens the ring's own edge, then a blurred
glow), with every alpha mixed into the shadow colour by `color-mix`
rather than an element `opacity` that would fade the fill too. There is
NO pseudo-element, and there may not be one: the halo used to be an
`::after`, and the browser pixel-snaps that box's position and size
independently of the dot's box, so whenever the dot landed on a
fractional x/y - routine in a flex row, or wherever a text baseline puts
an inline box on a half pixel - the two circles came apart by a device
pixel. Symmetric `inset` fixed the halo's own internal symmetry and NOT
this, because the drift was between two boxes. A box-shadow is painted
from the element's own border box, so concentric is the only geometry it
can have.

**ONE LIT DIAMETER FOR EVERY STATE**, and no per-state rule may touch a
geometry token. The halo used to be sized per state, so the LIT object
came out at three different diameters (9.0, about 14.7 and 15.3px) and
only the two loud ones were visible - in a sidebar where one session is
working and the rest are at rest, that paints one dot 60 percent wider
than its neighbours, which is what the owner reported. Under the
one-element composition the five geometry numbers are declared once and
never overridden, so the rule holds by construction rather than by every
state remembering to agree. `unread` is the state that used to break it.

`idle` (read, at rest) has its own grey fill, `--led-color-idle`, and
sits under a still ring in that same grey, so opening a tab reads as
visibly calmer than leaving it unread - a green ring becoming a grey one
AND a recessed centre becoming a solid grey dot, two changes rather than
one. See `docs/session-status.md`.

**THE ROW'S CONTROLS LIVE IN A KEBAB MENU, AND RESTART IS ONE OF THEM.**
They were folded into a per-row three-dot kebab in `cddc823`; one line of
this project unfolded them again on 2026-09-08 back to inline pin and
close, deleting `client/js/session-row-menu.js`, its gesture module and
`session-row-menu.css`, and removing restart from a live row along with
them. **That was not taken, 2026-09-09.** The kebab stays, right-click
and long-press still open it, and `data-row-status` stays ON THE KEBAB,
which is where `session-sidebar-clicks.js` reads it to hand the restart
picker a measured status. THOSE TWO FILES GO THE SAME WAY OR THE MERGE
COMPILES AND LIES: point the read at the row while the kebab is what
carries the attribute and `runRestart` gets `null`, so every restart
reports "unknown" instead of what was measured. Nothing throws; the
picker just stops knowing anything.

Keeping the menu also keeps the two things its removal would have cost,
both of which were named honestly on the branch that removed it: FILING A
SESSION INTO A GROUP keeps a pointer route (the picker still opens on `g`
over a focused row, on Alt+Arrow across a band edge, and by dragging onto
a group header, but on a phone the menu entry is the only one of those a
thumb can reach), and RESTARTING A LIVE SESSION stays reachable, which is
gate 1 under "Replacing what is running".

**THE GROUP HEADER IS OURS TOO**: a fixed `--sidebar-gutter` span holding
the count FIRST so every group name starts at the same x, the count as
accent-coloured tabular-nums text rather than an oval pill, a kebab on
the pinned and other bands as well as on named groups so the menu column
is a straight line, and no numeric unread badge - the roll-up LED carries
the same finished-turn ring the rows do, and two indicators for one fact
is how they end up disagreeing.

## The transcript archive the app maintains

The app keeps a byte-exact archive of this machine's Claude Code
transcript corpus (`~/.claude/projects`) inside its own `cloude.db`. It
is a background loop, started second-to-last in `lifespan()` (only the
database integrity scheduler starts after it) and stopped first on
shutdown, and it is fail-soft in exactly the way `ensure_db_migrated`
and `claude_hooks.ensure_hook_settings` are: boot never waits on it and
never fails because of it.

| Piece | File |
|---|---|
| One incremental pass, start to finish | `src/core/corpus_ingest_service.py` |
| The scan plan and the two DB fingerprints it rests on | `src/core/corpus_ingest_scan.py` |
| Scan cache + liveness artifact on disk | `src/core/corpus_ingest_state.py` |
| The background loop | `src/core/corpus_ingest_task.py` |
| The read-only status object | `src/core/corpus_status.py` |
| `GET /corpus/status`, `POST /corpus/ingest` | `src/api/corpus_routes.py` |

Four things worth knowing before you touch it.

**A steady-state pass must stay invisible.** It is measured at about 40 ms
over a 400-file archive and about one second of `stat` calls over the
real 19,065-file corpus. Two shortcuts buy that, and BOTH refuse
themselves rather than guess: the scan cache skips a file only when its
size, its mtime and the hash the database holds all agree, and the
incremental hash query is only used while the `install_id` matches and
`max_archive_id` has not gone backwards. If you add work to the pass,
measure it against those numbers.

**A skipped rooting pass is a named state, not zeros.** `report.rooting`
carries `status: ran` or `status: skipped_unchanged`. Do not "simplify"
it back to a bare count dict; a reader would then be unable to tell
"rooted nothing" from "did not look".

**Liveness is published on every terminating path, including failures**,
and its AGE is the signal. An ingester that dies looks exactly like one
finding nothing new, so `var`-style artifacts live under
`<state_dir>/corpus-ingest/` and `GET /corpus/status` reports the age of
`latest.json` with four outcomes: `current`, `stale`, `never_ran`,
`cannot_determine`.

**It maintains the ARCHIVE, not the v16 message model.** The message
model refuses a `source_ref` it has already ingested, on purpose, which
makes it the wrong layer for transcripts that grow while the app watches
them. The status endpoint still reports that model's gate findings
read-only, and says `model_not_populated` rather than "0 findings" when
it holds nothing.

`CLOUDE_CORPUS_INGEST=0` switches the loop off; it defaults OFF under
`CLOUDE_TEST_MODE` so a pytest run never reads the developer's real
corpus. `CLOUDE_CORPUS_ROOT` relocates the corpus,
`CLOUDE_CORPUS_INGEST_INTERVAL` the sleep between passes.

## The daily database integrity check

`PRAGMA integrity_check` is a MAINTENANCE OPERATION, NOT A LIVENESS PROBE, and
that distinction cost the project real time. `GET /api/v1/version` used to run
it synchronously inside its own coroutine on every request. The Electron tray
polls that endpoint every 20 seconds (`macOS/main.js`, `INTERVAL_MS = 20000`)
and the pragma re-verifies every page of every B-tree, so on a 4.5 GB
`cloude.db` the event loop was blocked for roughly 14 of every 20 seconds on an
idle machine, and the stall grew with the file. Wrapping it in a thread would
have freed the loop and still burned those seconds of disk three times a
minute, forever, which is why it was rejected.

| Piece | File |
|---|---|
| Run one check and publish the verdict | `src/core/db_integrity.py` |
| Read the verdict and decide what may be said | `src/core/db_integrity_status.py` |
| The background loop | `src/core/db_integrity_task.py` |
| The cheap per-request probe | `src/core/db_health.py` |
| Atomic write / tolerant read, shared with the ingester | `src/core/json_artifact.py` |

**The request path is now one connect plus one small SELECT**, plus one read of
a small JSON file. Measured at 0.46 ms median against a 310 MB database where
the pragma took 112 ms, a 215x difference that widens with the file. Do not put
a pragma back on it; `tests/test_db_integrity_verdict.py` booby-traps every
binding of the helper and fails the build if one appears.

**Measured on live after the deploy, 2026-09-07**, against the real 4.5 GB
file: p99 **14,505.7 ms to 13.3 ms**, p50 30.5 to 5.2 ms, the 20.0s cadence of
14.5s stalls GONE, and the share of the window stalled 86.5 percent to 0.0
percent. The measurement to trust is that the SAMPLE COUNT TRIPLED at an
unchanged poll rate, because that is independent of the timings: more samples
come back only if the loop is free to answer them. **13.3 ms is NOT settled.**
Later polls read p99 64-72 ms and most recently 66-73 ms. Still three orders of
magnitude better than the broken state and with no stall pattern, but about
five times that figure and NOT attributable; the corpus ingester was active
during the later runs, which is a hypothesis that was not tested. Re-measure on
a quiet box before quoting a number.

**The diagnosis is worth keeping for its shape: it was a REQUEST HANDLER ON A
TIMER, not a background task.** Several passes looking for a periodic
server-side loop found nothing, because nothing looped; the Electron tray
polled. When you are chasing a periodic stall, read what POLLS as well as what
loops. It was confirmed twice independently before any fix was written: py-spy
returned 17 of 17 stalled dumps byte-identical, and the static call chain
agreed.

**The cached verdict carries two facts, so it has two fields.** `verdict` is
`ok` / `failed` / `cannot_determine`; `freshness` is `current` / `stale` /
`never_ran` / `cannot_determine`, the same four-value vocabulary
`src/core/corpus_ingest_state.py` uses, reused rather than re-invented.
`verdict` reads `ok` ONLY when a check actually ran AND its record is inside
the freshness window, so "never checked" can never render as "checked and
sound". A recorded `failed` still degrades `data.status` exactly as the live
pragma did; `cannot_determine` deliberately does not, because not having looked
is not a fault.

`CLOUDE_DB_INTEGRITY_CHECK=0` switches the loop off; it defaults OFF under
`CLOUDE_TEST_MODE` so a pytest run never walks the developer's real database.
`CLOUDE_DB_INTEGRITY_CHECK_INTERVAL` overrides the daily interval, and the
staleness window is derived from it (two intervals) rather than hardcoded. The
loop also asks the artifact whether a check is due before its first run, so
restarting this menubar app all day does not re-walk the file each time.

## Secret scanning

`./scripts/install-secret-hook.sh` installs a pre-commit hook that refuses a
commit staging credential material; `./scripts/uninstall-secret-hook.sh`
removes it. `.git/hooks` is not version controlled, so the installer is the
distribution mechanism and has to be run once per clone.

`src/core/message_model_secrets.py` is the single source of truth for what
counts as a secret, shared with the transcript message model. Add a detector
there and a case to `tests/test_secret_detectors.py`; never write a second set
of patterns. No matched value is ever printed, logged or stored, by any path.

Audit the tree with `./venv/bin/python3 scripts/scan_secrets.py`. Exit 2 means
could-not-scan and is not a pass. Full detail in `docs/secret-scanning.md`.

## Upgrading an install

`docs/upgrade-with-claude.md` is the runbook, and `/upgrade`
(`.claude/commands/upgrade.md`) is the entry point. The one rule that matters:
take `./scripts/upgrade-baseline.sh` BEFORE touching anything, because you
cannot verify a migration without a record of what the data was, and that is
the step everyone skips. `./scripts/upgrade-verify.sh` exits 2 when a check
could not be evaluated; 2 is not 0.

## Imported conversations

`scripts/import_transcript_sessions.py` gives every real Claude Code
conversation a `sessions` row. DRY RUN BY DEFAULT. Measured 2026-09-08:
1,486 transcripts against 43 rows; it wrote 895 ARCHIVED rows into 12
existing and 59 CREATED archived projects, so nothing lands on a screen
until "show archived" is on. Four things stay out, each a NAMED outcome:
a cwd under `/private/tmp`, `/tmp` or `/var/folders` (the ONLY exclusion,
and it is about the path - `fstest` and `llmScratch` work is real and
imports); 319 files with no `cwd` anywhere (`file-history-snapshot`
bookkeeping); 224 `agent-<id>.jsonl` SUBAGENT runs, whose records report
the PARENT's `sessionId` - which is why identity is the FILE STEM; and
the older of two transcripts for one uuid split by a cwd spelling.

**NOT ALL OF IT IS THE OWNER'S TYPING, AND THE LISTS NOW SAY SO.** The
owner's rule, verbatim: "lists should always just be mine. the rest can
be found in the archive explorer." `sessions.kind` (schema v25) carries
three words and never a fourth: `interactive` / `automated` / `unknown`.
Measured over the 895 imported rows 2026-09-08 and applied on live: 320
interactive, 270 automated, 305 unknown. `GET /sessions/records` and
`GET /sessions/recent` exclude `kind='automated'` by default;
`include_automated=true` returns it and no UI sets that. `/archive` reads
the transcript archive and never `sessions`, so nothing here can hide a
transcript from the explorer.

**ONLY A FACT THE MACHINERY WROTE MAY SAY `automated`.** Two rungs, both
emitted by the thing that did the automating: a `<scheduled-task ...>`
tag around the prompt (259 rows), and `entrypoint: sdk-cli`, the headless
SDK path (11). Interactive is reached by `entrypoint` `cli` or
`claude-desktop` (266), a `planContent` record (30), or a `custom-title`
/ `mode` record (24). Title shape, turn count and prompt wording are NOT
in the ladder: 28 rows titled "Implement the following plan: ..." read as
delegated work and every one is a HUMAN approving a plan in the TUI,
while 3 scheduler runs are titled "Urbackup completion proof" and a title
rule misses all three. `src/core/session_kind.py` owns the ladder;
`scripts/classify_session_kind.py` is the operator entry point, DRY RUN
BY DEFAULT, and it prints those negative controls on every run.

**THE 305 UNKNOWNS ARE AN ERA, NOT A GAP, AND THEY STAY IN THE LISTS.**
Every one was written by claude <= 2.1.77, which predates the
`entrypoint` field; the earliest confirmed scheduler run is 2.1.121 and
the earliest confirmed headless run is 2.1.198. The corpus holds NO
confirmed automated run from that era to derive a marker from. NULL and
`unknown` both list, because every reader excludes on `kind='automated'`
ALONE - not having looked is not evidence of automation.

An imported row has no `tmux_name`, epoch, `agent_type` or `model`, none
of it invented, so `GET /sessions/restart/preview` cannot ADDRESS it.
`session_imported_restart.py` + `imported_restart_routes.py` are the path
that can: keyed on `session_uuid`, a restart CREATES a session with
`--resume <uuid>` and `reuse_session_id` on the imported row. The launch
directory is MEASURED across every spelling, because `--resume` finds the
file only under the slug of the LITERAL cwd; a measured absence refuses,
`unchecked` never does.

## The two session-scoped menus, and where each one lives

They are split by JOB and the rule is learnable: one moves content across
the terminal's boundary, the other configures the session. They share
their plumbing (`client/js/fab-menu.js` builds the dropdown,
`client/js/anchor-popover.js` places it) and nothing else.

| Control | Rows | Surface |
|---|---|---|
| `#terminalToolsBtn` | copy output, paste from clipboard, attach file | floating button, bottom row slot 0, **phone only** |
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

## Gotchas that have cost real time

1. **Wrapper vs `.session`.** Described above. When a field reads as missing,
   check which level you are on before you go looking in the backend.
2. **Hook events are unordered, duplicated and droppable.** A state machine that
   assumes ordering works on your machine and drifts in the field. Floor the
   counters, make every transition idempotent.
3. **An adopted session is not a launcher "project".** Deep-link resolution walks
   launcher projects first, then live/adopted sessions
   (`client/js/router.js`, `Launchpad.openProjectByName()`). Resolving only
   against projects made a deep link spawn a duplicate session next to the one
   the user was already in. Unresolvable targets go through `rejectTarget()`, one
   banner, one `replaceState` back to `/`, never a silent bounce.
4. **The tmux socket is load-bearing.** Anything that shells out to `tmux`
   without `-L cloude` is talking to the user's personal tmux server. That is how
   you kill someone else's work.
4b. **A session id is not a tmux name, and deriving one from the other loses
   sessions.** `build_backend` with no `session_name` rebuilds
   `cloude_<slug(session_id)>`, which for an adopted id yields
   `cloude_adopted_cloude_Foo` - a name no socket has ever carried. It then fails
   the liveness test and `_clear_stale_metadata` throws the pointer away. Pass the
   STORED `tmux_session`, and keep the derivation as the fallback for pre-field
   metadata.
5. **A uuid on the row is not evidence a transcript exists, and a missing
   transcript is not evidence the conversation is gone.** Five rows on the
   developer's box hold a phantom uuid minted by `--fork-session` while the
   real conversation lives on an archived twin row. Check the twin before
   telling anyone their history is lost.
6. **cwd spelling splits a session in two.** `~/Development` is a symlink into
   iCloud and Claude Code derives its transcript directory from the LITERAL cwd
   string, so two spellings of one directory make two transcript directories,
   two project rows and, as above, two session rows. Always write the long
   iCloud spelling, in code and in documents. **Qualified 2026-09-08:** the
   historic split in the data is real, and claude 2.1.263 resolves symlinks
   before slugging its transcript path, so `--resume` now finds a transcript
   from either spelling of the cwd and a NEW split cannot originate from
   claude itself. It is not fully fixed, though - this app's own project
   creation kept WRITING the short symlinked spelling into `working_dir`
   until `a4eeef1` closed that path today.
7. **`if (pinned) apply()` with no else leaves the last session's theme on
   screen.** A pinned theme bled across session switches because three
   copy-pasted restores in `app.js` and two session-entry paths each applied a
   theme and never reset one. A missing else is not a missing feature, it is
   state left over from the previous thing. There is now ONE total function,
   `applyForTarget()` in `client/js/theme-navigation.js`, and every navigation
   goes through it. Fixed in `a6b6b91`.
8. **A stale doc is worse than no doc.** A missing doc sends the next agent to
   read the code; a confidently wrong one sends it to write a bug. If you change
   behavior this file describes, update this file in the same change. If you find
   a claim here that reality contradicts, fix it and say so in the commit.
9. **A bare `await requestAnimationFrame` never resolves in a hidden tab.**
   A browser does not paint a backgrounded tab, so it never runs that
   tab's rAF callbacks; anything awaiting one hangs there permanently, not
   just slowly. `waitForFontsAndLayout()` suspended `connectWebSocket()`
   before it ever opened a socket, and two other call sites
   (`reconnectToExistingSession`, the adopt path) carried their own copies
   of the same bare wait, so fixing the first one alone changed nothing -
   only a live re-check in an actually-backgrounded tab caught the other
   two. Anything that must happen for a background tab (a websocket
   connect, a state clear, a save) must not wait on a frame; race it
   against a timer instead, the way `client/js/terminal-layout-wait.js`
   does, so the wait can delay the work but never cancel it.
10. **A synthetic hook aimed at a row id can set a tracker flag the pane's
    own claude can never clear, when that claude holds an adopted id.**
    `cloude_Media_Compression`'s pane process presents
    `CLOUDECODE_SESSION_ID=adopted:cloude_Media_Compression` on every real
    hook it fires, because tmux fixed that env var into the process at
    spawn and cannot rewrite a running one. A test's synthetic
    `PermissionRequest` landed on `ses_949a8585` instead - the id
    `tmux show-environment` hands back, and the one a script naturally
    reads - with no `toast_session_id_remapped` line, because the toast
    path only remaps when it recognizes the split; every REAL clearing
    hook from that pane kept arriving under the adopted id and clearing a
    key nothing was set on. The row painted `question` over a pane with no
    dialog open, indefinitely. The fix in `dfddbdc` does not chase a
    second remap: it re-verifies an open `permission_open` against the
    PANE itself once it has sat open past 20 seconds, on the theory that
    two ids can drift apart but the pane cannot lie about its own screen.
    Any new tracker flag keyed on a session id needs the same question
    asked of it: can this id and the pane's own id ever diverge, and if
    they do, is there a way back to ground truth that does not depend on
    either id being the right one.
