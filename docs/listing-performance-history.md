# The listing pass, the attach path and the pipe reader: the performance record

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

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

**AND THE 150 ms ATTACH SETTLE IS NOW PAID ONLY WHEN A RESIZE ACTUALLY
WENT OUT.** The handshake slept 150 ms on every attach so a `SIGWINCH`
raised by the handshake resize could reach the pane's foreground process
before the capture stomped its buffer. That is the right thing to wait
for when a resize happened, and pure latency when the browser comes back
at the geometry the pane is already at, which is the common reconnect.
`src/api/attach_settle.py` is the rule and it has THREE outcomes, not
two: the pane's own `#{pane_width}`/`#{pane_height}` measured EQUAL to
the negotiated grid skips both the resize and the pause; measured
DIFFERENT resizes and settles as before; and anything else - the probe
refused, the backend cannot be asked, the client sent no dims, the resize
raised - settles as before. **A READING THAT DID NOT HAPPEN IS NOT A
READING OF NOTHING**: treating unknown as unchanged would leave the
pane's grid disagreeing with the browser, invisibly, until the user
typed. Both sleep sites go through the one function; the degraded branch
that never got client dims can never take the fast path, by construction.

**COMPARE AGAINST THE PANE, NEVER AGAINST THE NEGOTIATOR'S CACHE, and
that is why this costs a probe at all.** `TerminalSizeNegotiator` forgets
a session the moment its last client disconnects, so on the very common
close-tab-reopen-tab attach it has NO record and reports the size as
changed - keying the settle on its return alone would never once take the
fast path. Worse, a value it did remember says nothing about a pane an
adopt, a restart or an external `resize-window` has since moved.
Measured on tmux 3.6a at load average 14: the probe costs p50 9.85 ms,
the `resize-window` plus `refresh-client` pair it also skips costs p50
22.81 ms of BLOCKING event-loop time, and the whole resize-and-settle
segment on an identical-geometry attach went **p50 152.2 ms to 12.5 ms**.
A changed geometry still measures p50 186.7 ms, which is the point.
`tests/test_attach_settle_skip.py` proves the refusal against a REAL
backend whose tmux session has been killed, because a double asked to
return None proves only that someone wrote `return None`; its timing
claims are made by RECORDING the sleeps rather than by a wall clock,
which on a loaded box would either flake or be too loose to prove
anything.

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

**THE TAIL READ WAS CLAIMED TO BE FREE IN STEADY STATE AND IT WAS NOT, AND
THAT SENTENCE IS WHY THE TERMINAL LAGGED.** `should_capture_tail` gates the one
`capture-pane` on alive + past the grace window + no hook, and this file used to
say that set "on a working box is the empty set". It is not. The hook record
lives in `StartupGateLedger`, which is IN-MEMORY and per server process, so a
session that fired its last hook before this process started has none and never
acquires one. Measured 2026-09-09 on the owner's box: **13 of 13 live sessions,
all healthy, took a capture on every 5s listing poll, forever.** The fourth
refusal closes it - a reading younger than `STARTUP_TAIL_RECHECK_SECONDS` (30s)
stands instead of being re-taken, the ledger carries the verdict
(`record_tail_read` / `last_tail_match` / `tail_age_seconds`), and
`resolve_startup_gate` consults that remembered verdict ONLY at rung 5, where
the alternative is refusing. Only a RE-look is throttled: an instance with
nothing on record is read immediately, so a session parked on its trust dialog
since birth is detected exactly as promptly as before. A throttle without the
remembered verdict would flap the row between a measured answer and `unknown`
on alternating polls, which is worse than the cost it saves. Do not move that
capture up into the unconditional path.

**THE LISTING PASS USED TO RUN ENTIRELY ON THE EVENT LOOP, SO ITS COST WAS
TERMINAL LATENCY. ITS EXPENSIVE READS NOW RUN IN A WORKER THREAD.** This is
the rule the two paragraphs above and the section below all serve, and the
history is kept because every cost-reduction round in this section was aimed
at it. `list_session_infos` was `async def` whose body was entirely
SYNCHRONOUS, so for as long as it ran the server did nothing else at all: it
could not read the tmux pipe carrying terminal output, could not spawn the
`send-keys` that delivers a keystroke, and could not answer another request.
Measured 2026-09-09, 13 live sessions: **27 tmux subprocesses and 1008 ms per
pass** (one bulk `list-panes -a` at 282 ms, then `has-session` x13 at 377 ms
and `capture-pane` x13 at 349 ms), polled every 5s by the sidebar and again by
the launchpad. The user reported it as typing lag and as a sidebar click taking
two seconds; the click's own endpoint measured **45-64 ms**, so essentially all
of that two seconds was queueing. The control that proved the mechanism is
`GET /sessions/records`, which does its work in a threadpool: its own cost is
5.8 ms and its p99 was 161 ms, all of it spent waiting to be served.

**THE PASS IS THREE STAGES NOW, AND THE ORDER IS THE CLAIM.** SNAPSHOT on the
loop (`_listing_snapshot`, copying the names and the socket out of the live
dictionaries into tuples), GATHER in `asyncio.to_thread`, then the per-row loop
back on the loop, UNCHANGED. `src/core/listing_gather.py` is the thread body
and `src/core/listing_prefetch.py` the name-keyed decorations. Measured with 4
live sessions, **13 of the pass's 17 SQLite connections** now open off the
loop, along with the one bulk `tmux list-panes -a`. The file drawer's shallow
read, in the paragraph below, is the worked example this copies.

**EVERY WRITE DELIBERATELY STAYED ON THE LOOP, AND THE REASON IS NOT
TIDINESS.** Twelve of them - the activity tracker's signals, the unread epoch
memo, the permission-verify and startup-gate ledgers with their once-per-instance
toast claims, the status seed's cache and the durable
`_persist_settled_activity_state` write - are each a READ-MODIFY-WRITE against
in-memory state the hook route mutates on the loop at the same time. The
permission pair is the one that makes a torn read SILENT rather than loud:
`permission_open` and `permission_opened_at` are SET in one order and CLEARED
in the opposite one, so a thread reading them mid-transition sees a coherent
looking half-state and no exception is raised anywhere. Moving those needs an
APPLY stage that re-validates at write time, in the manner of
`config_writer.commit`'s fresh read inside the lock. That is a real refactor of
a 400-line function and **A PARTIAL, CORRECT IMPROVEMENT BEATS A COMPLETE,
RACY ONE.**

**AND THE SINGLE-FLIGHT COALESCER IS WHY TWO GATHERS CANNOT OVERLAP.**
`src/core/single_flight.py` makes a caller asking for a listing while one is
in flight AWAIT that pass rather than start its own, which it was built for a
different reason (15 polling clients were each paying for an identical answer,
giving the endpoint a measured period of about 0.85 s rather than 5 s). It
matters here too: with the loop free during a gather, without it a second
request would start a SECOND thread reading the same rows.

**THE SAFETY PROPERTY IS A TEST, NOT AN AUDIT, BECAUSE A BOUND METHOD CARRIES
`self`.** `ListingReaders` hands the thread bound methods and nothing else,
which narrows what `listing_gather` itself can reach and narrows NOTHING about
what a reader's own body may grow into: a `self.sessions` read added inside
`_label_for_tmux_name` would put a live container back in the thread and no
signature would say so. So `tests/test_listing_off_the_loop.py` wraps the six
live containers (`sessions`, `backends`, `_instance_epochs`, `pinned_themes`,
`_hook_tmux_names`, `_activity_tracker`) in thread recorders, drives the REAL
`_listing_readers()` bundle through `asyncio.to_thread`, and fails naming the
container and the thread. It carries its own negative control, and that control
was WATCHED GOING RED against a live read injected into a real reader before it
shipped.

**THE FILE DRAWER'S TREE SCAN WAS THE SAME DEFECT ON A SECOND PATH, AND IT
WAS NOT A SUBPROCESS OR A SQLITE PROBLEM.** `GET /config-files/tree` was an
`async def` calling `config_files.list_tree` directly, a recursive filesystem
walk, so opening the file drawer stalled every terminal in the app for the
length of the walk. The cost is `stat` SYSCALLS and nothing else: measured
2026-09-10 against this repository's own working directory, **1621 nodes,
6501 `stat` calls against 93 directory reads** - about four `stat`s per node,
because `_build_node` asked `is_dir()` three times and the sort key asked
`is_file()` once. Against `~/.claude`: 1112 nodes, 4551 `stat`s. Warm wall
time 264 to 477 ms per open. **A subprocess count or a connection count would
have passed before the fix and proved nothing**, which is the sibling
listing's lesson applied in the other direction.

The fix is two halves and the ORDER matters. First
`await asyncio.to_thread(config_files.list_subtree, ...)`, which is what
actually stops the stall; second an optional `depth`, so the levels nobody
expands are never walked. Interleaved A/B in one process, so the same load
hit both arms: the walk ON the loop stalled a concurrent coroutine for
**372.8 ms p50, tracking its own 374.1 ms wall time almost exactly** - the
handler's duration IS the stall - while in a thread the same walk's wall time
was unchanged and the stall fell to **101.5 ms p50 against a 50.0 ms idle
control on a box at load average 33**, no longer tracking the wall time at
all. THE RESIDUAL IS NOT SETTLED: that box was heavily contended and the
control's own noise floor is half the post-fix figure, so re-measure on a
quiet machine before quoting 101.5 ms as this path's cost.

The second half is measured in SYSCALLS, which do not care what else the box
is doing. One open of the drawer, both roots: **8363 `stat` calls and 365
directory reads before, 245 and 2 after**, a 34x reduction, because a client
sending `depth=1` never asks for a level nobody expanded. Expanding five
directories by hand still costs only **1667**, 20 percent of what a single
open used to cost unconditionally. The offload removed the STALL and the
shallow read removed the WORK: shipping only the second would still block the
loop for whatever the shallow read costs, which is why that order is the one
the issue specified.

**`children_loaded` IS THE THREE-OUTCOME RULE REACHING `children`.** An empty
`children` list used to mean BOTH "read, genuinely empty" AND "stopped at the
depth cap" - a conflation that predates shallow reads and that shallow reads
would have made routine. `TreeNode.children_loaded` is True only when the
directory was actually enumerated, and a client tests `=== false`, never
falsiness, so a server that omits the field reads as loaded and an old client
sending no `depth` still gets the whole tree. **CONTAINMENT IS RE-CHECKED ON
EVERY EXPANSION**, through the same `resolve_safe_path` that `read_file` uses:
component-wise `Path.relative_to` after `resolve()`, never a string prefix,
so `/Users/jsugamelevil` is not inside `/Users/jsugamele`. That makes a
per-level read STRICTER than the recursive walk, which descends through a
symlink without re-resolving it. See `src/core/config_files_tree_request.py`
(the pure request rules), `client/js/config-editor-lazy.js` (the expansion and
its three outcomes) and `tests/test_config_files_shallow.py`, whose
loop-blocking test is STRUCTURAL rather than timed - a stand-in walk parks
until a coroutine beside it releases it, so it can only pass off the loop and
cannot flake on load - and which carries the negative control proving that
harness detects a walk that IS on the loop.

**A SECOND SUBPROCESS MUST NEVER ASK WHAT THE BULK ROW ALREADY SAYS, BUT ONLY
THE POSITIVE HALF OF THAT ROW IS EVIDENCE.** `backend.is_alive()` is
`tmux has-session`, and `list-panes -a` in the same pass already enumerates
every live session BY NAME. `src/core/session_status_map.py` is where the fact
that makes the row usable travels with the data: `StatusMap` is a `dict`
subclass carrying `complete`, so every existing consumer and every plain-dict
test double is untouched. **The asymmetry is the design.** A completed listing
that NAMES a session proves it exists, so `listing_proves_alive` returns True
and the probe is skipped. A listing that does not name it proves much less - it
covers only the socket the probe was bound to and it is one moment in time - so
it returns False meaning "not established", and `_session_info_for` still runs
`is_alive()` for exactly those rows. **Trusting the negative was tried and it
was wrong**: it dropped every row whose backend the listing could not see,
which four `tests/test_session_rename.py` cases caught immediately and which in
production would delete a LIVE session off the sidebar. Costing the probe only
for rows about to be dropped costs nothing in steady state, where all 13
sessions are in the listing. `tests/test_listing_subprocess_cost.py` pins it
against REAL tmux by COUNTING subprocesses rather than timing anything: the
count is the defect exactly, and a wall clock on a loaded box would either flake
or be too loose to prove anything.

**THE SIBLING LISTING'S COST WAS NOT SUBPROCESSES, AND ASSUMING IT WAS WOULD
HAVE MISSED IT.** `/sessions/attachable` was already down to TWO tmux calls in
steady state - its per-row pane fingerprint is cached per instance triple - so a
subprocess count would have passed before any fix and proved nothing. What grew
with the row count was SQLITE CONNECTIONS: the title, the durable row id and the
recorded launch are three columns of ONE row under ONE key, and each was fetched
by its own function opening its own connection. Measured 2026-09-09 with 11
rows: **33 connections, about 33 ms of a 55 ms pass**, roughly 60 percent of it.
`src/core/session_instance_index.py` reads them in one `SELECT` and answers every
row from memory; the pass now opens the datastore **3 times regardless of row
count** (`owned_tmux_instances`, `reconcile_lifecycle`, and the index), measured
at **52-61 ms to 24-35 ms warm**. The two SELECTION RULES differ and both are
preserved: `label_for_instance` asks for `ORDER BY id DESC LIMIT 1` while the
other two take an unordered `fetchone()`, so the index keeps the FIRST row for
identity and launch and the LAST for the title. Collapsing them would be a silent
change in the duplicate case nobody looks at. **Measure what is actually wrong,
not what the last fix happened to be.**

**AND THE SAME PASS OPENS A SQLITE CONNECTION PER ROW, WHICH IS THE HALF
HIS INDEX DID NOT REACH.** `session_instance_index` was wired to
`/sessions/attachable` only. `/sessions/list` has the identical shape one
layer down: the status seed ladder's
`session_status_seed_read.read_instance_row` opens its OWN connection, per
session, for four columns off the row found by the SAME instance triple
the index already keys on. Measured in-process against real tmux with 19
live panes, one pass: **95 datastore opens before, 77 after** - the index
costs one and saves one per session - and the synchronous pass itself
**58.9 ms p50 / 68.4 p99 to 49.7 / 57.2**. Trust the COUNT, not the
milliseconds: that timing is a warm local database with no rows in it, and
the live figure it is meant to explain is 270.1 ms p50 against 418.5 p99
with a no-op `/health` inflating from 45.3 ms quiet to 181.9 ms while a
listing is in flight. **THE COST IS A BURST, NOT A DRIP**, and saying so
accurately is the point: `seeded_display` re-derives at most once per 60s
per session, so about one poll in twelve reaches the read - but the seeds
warm together and therefore EXPIRE together, so the shape is N synchronous
opens landing inside ONE pass, which is what a p99 is made of.

**`InstanceIndex` NOW CARRIES `complete`, AND THAT IS WHAT MAKES IT SAFE TO
READ FROM.** An empty index is harmless for a DECORATION - a missing title
renders as nothing, exactly what the per-row read produced when the
datastore would not open - and is NOT harmless for the seed, where `None`
means "this instance could not be identified" and would blank the status
ladder for every session in the pass. So `complete` is True only when a
query actually RAN, a real answer of zero rows included, and the seam reads
the index only then; anything else falls through to the connection it was
always opening. Same discipline as `StatusMap.complete`, same sentence
underneath it: a reading that did not happen is not a reading of nothing.
The four seed columns join the FIRST-row group in the duplicate-triple
rule, because `read_instance_row` also took an unordered `fetchone()`.
**AND THE INDEX IS SKIPPED WHEN NOTHING CAN USE IT**, which is his own
`2b1fcb9` correction applied to this path: the seam is reached only inside
`if not hooks_seen(session_id)`, so a box where every session has fired a
hook would pay one connection to answer nobody. `hooks_seen` is a
NECESSARY condition and not a sufficient one, so that gate may over-include
and must never under-include.

**FOUR PER-ROW READERS REMAIN ON THIS PASS AND ARE STILL DELIBERATELY NOT
FOLDED IN; THREE OF THEM MOVED OFF THE LOOP INSTEAD.** Measured and
attributed by caller, 19 sessions: `_restored_activity_state` 19,
`_identity_for_live_name` 19, `_label_for_tmux_name` 19,
`_owned_instances_from_db` 19. Every one is NAME-KEYED with a recency rule
("the newest instance of this name") while the index is keyed on the full
instance triple, so answering them from it would be a silent behaviour
change in the duplicate-name case nobody looks at. THAT IS STILL TRUE and
nothing was folded in. What changed is WHERE the first three run: they are
the body of `build_listing_prefetch`, called once per name in the gather
thread, with the same queries and the same selection rules, so it is a
change of where the work happens and never of what it answers.

**THE FOURTH, OWNERSHIP, STAYS ON THE LOOP, AND AN ADOPTION IS THE REASON.**
`is_owned_tmux_name` is a two-rung ladder, the in-memory
`owned_tmux_sessions` set then the datastore, and an ADOPTION MOVES ONLY THE
DATASTORE - `adopt_external_session` says so in its own docstring, and the
only three `.add` sites are the boot backfill, create and rename. So the
datastore is exactly the rung an adoption lands on, and it is the rung a
prefetch would freeze. Freeing the loop is what makes an adoption able to
land WHILE the gather runs at all, so prefetching this one would drop
`created_by_cloude` off a freshly adopted row for a whole poll cycle - the
threading change would have INTRODUCED that race. It cost 4 of the pass's 17
datastore opens at 4 sessions, so the other three carry the clear majority of
the saving, and leaving it on the loop makes the staleness question GONE
rather than documented. A test that faked the adoption by calling
`owned_tmux_sessions.add` was green while vouching for nothing, and is
replaced by one driving the DATASTORE rung through a real pass.

`tests/test_listing_pass_datastore_cost.py` pins the ceiling at the EXACT
measured `4N + 1` with NO headroom, re-measured 2026-09-11 over three
consecutive runs, and its failure message names WHICH reader grew. The spare
open it used to carry meant the alarm was simply off while the pass sat under
the bound. **Raising that bound is re-introducing the defect with the alarm
switched off.** Note what it does and does not measure: it counts
CONNECTIONS, which stopped being the same thing as STALLS the moment 13 of
the 17 moved into a thread. `tests/test_listing_off_the_loop.py` is the file
that proves WHERE they run.

**THE PERMISSION VERIFY WAS CHECKED AND ITS GATE WAS ALREADY RIGHT, WHICH
IS WORTH KEEPING BECAUSE THE OBVIOUS READ WAS WRONG.**
`verify_open_permission` is a third potential per-row `capture-pane` on
this pass, and the expectation was that it carried the startup gate's
defect. It does not, and the difference is the DIRECTION of the refusals.
`should_capture_tail`'s "no hook on record" is FAIL-OPEN: the ledger is
in-memory, so a missing record makes it PASS, which is how 13 of 13
healthy sessions captured on every poll forever.
`should_capture_permission_tail` is FAIL-CLOSED at every rung - no open
claim, no stamp, no capture - so a box with no dialog on any pane spends
nothing here, measured over six sessions rather than asserted. What WAS
real is the RE-look: both verdicts that KEEP the flag leave the gate
passing next poll, so a genuinely open claim paid one subprocess every 5s
until a human answered it. `PERMISSION_TAIL_RECHECK_SECONDS = 30` bounds
that and nothing else. **THE LEDGER IS KEYED ON THE CLAIM,
`(session_id, permission_opened_at)`, NOT ON THE SESSION**: a new
`PermissionRequest` carries a new stamp, finds no record and is read at
once, so the throttle can never delay the FIRST look at a claim - which is
the only thing that catches a flag no reachable event can retire, the
adopted-id stuck bit of gotcha 10. A session-keyed record would have
delayed exactly that case, silently. A window opens only after a capture
ACTUALLY happened, so a refusal cannot throttle the first real look once a
pane comes back.

**AND A LISTING MAY ONLY VOUCH FOR THE SOCKET IT WAS TAKEN FROM.**
`listing_proves_alive` replaces a `backend.is_alive()` that probed THE
BACKEND'S OWN socket with a lookup in a listing taken from the PROBE'S. As
merged, neither was compared. A tmux session NAME is not unique across
sockets and this app mints names from project slugs, so a name present on
the probe's socket would have vouched for a dead session held by a backend
pinned elsewhere - a green `Connected` dot over a corpse, this project's
recurring failure. `StatusMap` now carries the socket the listing came
from, read off the probe so it can never claim one it did not come from,
and the function takes the socket the caller is asking ABOUT. Unstated on
either side, or a mismatch, REFUSES - and a refusal costs exactly the
pre-fix probe, so refusing too often is free and answering across sockets
is not. `tests/test_listing_liveness_socket_scope.py` measures it on two
real throwaway sockets with one name alive on A and killed on B, and
reproduces the PRE-FIX rule inline so the file fails if the old behaviour
returns rather than only checking that a keyword argument exists. Its
positive control is load-bearing: a backend on the listing's own socket
must still skip its probe, or a fix that refused everything would pass.

**THE PIPE READER WAKES ON THE APPEND NOW, AND THE 20ms IS A BACKSTOP.**
`TmuxBackend._tail_loop` used to `asyncio.sleep(0.02)` on every empty read, which
made that interval a FLOOR ON KEYSTROKE LATENCY - the echo lands at a uniformly
random point in the window, so it was seen about half an interval late on every
keystroke. `src/core/pipe_wakeup.py` registers the pipe fd with kqueue
(`EVFILT_VNODE`, `NOTE_WRITE | NOTE_EXTEND`) and hands the KQUEUE DESCRIPTOR to
asyncio's own selector via `loop.add_reader`, so no thread is spent per session
and no dependency is added. Measured interleaved A/B in one process, so the same
load hit both arms, 100 keystrokes each through a real tmux pane: **p50 26.10 ->
12.31 ms, p90 60.20 -> 28.44, p99 141.32 -> 77.59**, with idle CPU across 11 idle
panes **0.97% against 0.98% of one core** - indistinguishable, which is the only
reason this was kept rather than reverted.

Three things about it are load-bearing. **The backstop is the safety argument**:
an event-driven reader that misses an event does not read late, it STOPS reading,
so every wait is still bounded by the same 20ms and the worst case is exactly the
behaviour it replaces. **The latch is not optional**: the loop reads, gets
nothing, and only THEN waits, so an append landing in that gap was already
notified - `_pending_data` catches it, or the unlucky keystrokes would each cost
a full backstop. And **it is one Future plus one timer, never
`asyncio.wait_for(event.wait(), timeout)`**, which reads better and costs an
extra Task per idle cycle; that version measured idle CPU going the wrong way.
Linux has no `select.kqueue`, so CI runs the plain-sleep fallback, and
`tests/test_pipe_wakeup.py` covers both. Its wake tests hand `wait` a FIVE SECOND
timeout and allow half a second, so a pass cannot have come from the timer.

**A TEST THAT TIMES A SUBPROCESS STARTING IS NOT TIMING WHAT IT CLAIMS.** Those
wake tests flaked once in a full run at load average 14 and passed the same suite
minutes later. The cause was in the test: `Popen` returns when the fork succeeds,
not when `sh` has exec'd `cat` and opened the file, so bytes written before that
sit in a pipe buffer producing no append and no notification. The fixture now
warms up and waits for the file to actually grow before anything is measured. If
you write a latency test against a real process, prove the process is live first.

---

## Carried forward 2026-09-13 from a concurrent session

Written into CLAUDE.md by another session while this carve-out was in progress,
kept here verbatim.

  defect with the alarm switched off. **`GET /themes` MOVED OFF THE LOOP THE
  SAME WAY** (`src/api/themes_routes.py::_scan_both_roots`): it was an
  `async def` whose body walked both theme roots and sha256'd every declared
  `effects.js` on the loop, with the launchpad awaiting it before it painted, so
  the roots are now snapshotted on the loop, the scan and the digests run in
  `asyncio.to_thread`, and the sort and cross-root dedup apply back on the loop
  with the response unchanged. `tests/test_themes_off_the_loop.py` proves it
  STRUCTURALLY - a stand-in scan that parks until a coroutine beside it releases
  it, so it can only pass off the loop - plus a thread-identity check over a real
  scan and the negative control that shows the harness can detect a scan that is
  still on the loop.
