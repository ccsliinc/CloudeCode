# TODO — closing out the open issue board

Repo: Adoom666/CloudeCodeDev. 53 open at start, 48 now.
- 11 are ccsliinc's (their draft PRs) — not ours
- 8 carry `blocked` (waiting on ccsliinc PR #19, Adam's ruling): #31 #32 #35 #36 #37 #50 #51 #58
- the rest are ours

## Done and merged to master

- [x] #55 split toast.js -> toast-grouping / toast-render / toast-lifecycle (b932252)
- [x] #6  CLAUDE.md spelling prohibition + all 27 docs indexed (53ed219)
- [x] #56 perf harness can now measure settings open (53ed219)
- [x] #57 local server subsystem documented as retained dead code (53ed219)
- [x] #59 both stale test failures FIXED at root cause. Suite 5656/2 -> 5758/0 (53ed219)

## In flight

- [ ] #65 pinned theme overridden by folder .cc.theme
- [ ] #8 #9 #10 #16 navigation generation token chain (terminal.js)
- [ ] #30 file-tree scan off the event loop
- [ ] #42 inventory durable browser preferences (phase 5 prerequisite)

## Held — needs Adam

- #64 CI disabled deliberately. Adam's own comment on the issue says do not close it.
  Now documented in CLAUDE.md + docs/ci.md. Left open per his instruction.
- #66 home card overflow menu: touches client/js/launchpad.js, which ccsliinc's
  svelte migration (#11 PR#23, #76 PR#77) is actively rewriting. Real collision.

## Note for every agent from here on

docs/ are now PINNED by tests/test_docs_index.py in both directions. Any new doc
must get a row in CLAUDE.md's docs index or that test fails.

## Agent findings

(append below, format: [AGENT] [TIME]: finding)

[ORCH] 2026-09-10 19:07: full suite on merged master read 3 failed / 5769 passed.
All three drive the REAL tmux socket with a 6.0s wall-clock deadline in _wait_for.
Box was at load average 19.7 with 11 concurrent pytest processes from parallel
agents. Verified: the same two fail identically at base commit 53ed219, which was
measured 0 failed on a quiet box. test_tmux_backend_respawn passes in isolation.
This is contention, not a regression. A clean full-suite number is OWED on a quiet
box. Candidate follow-up: the real_tmux marker added for #59 should cover
tests/test_session_restart_wrapper_choice.py, whose 6s deadline is the tightest
in the real-tmux family.

[ORCH] 2026-09-10 19:20: NEGATIVE CONTROL for the entry above. The #42 branch
changed only docs/ui-preferences-inventory.md and one CLAUDE.md table row, zero
code, and its own full-suite run read 5753 passed / 5 failed / 18 skipped. The
failures were in session-restart-wrapper, state-dir-resolution, tmux-respawn and
tmux-pipe-rotation. A branch that changed no code cannot have caused them, so the
real-tmux failure family under concurrent agents is CONFIRMED contention rather
than any of today's work. The clean re-measure on a quiet box is still owed.

[BANNER-FIX] 2026-09-10: fixed the sticky/alarming #deep-link-error notice.
D1 (sticky): Router.clearError() now accepts an optional navigation-generation
token; App.showTerminal/returnToExistingTerminal pass their (read-only) nav
token, App.showLaunchpad passes a snapshot taken BEFORE its own begin() call.
clearError() refuses to clear when the banner's raise-generation is not
strictly less than the token, which is what stops a rejection's own bounce
from silencing itself (proved by a negative control that strips the guard from
a copy of the source and shows the same scenario then clears).
D2 (undismissable/permanent): added a close button (#deep-link-error-dismiss,
always-unconditional clear) and an 8s auto-dismiss timer that resets rather
than stacks on re-raise.
D3 (false death claim in toast-navigate.js): moved alreadyAttachedTo() to run
BEFORE the listing fetch (keyed on the toast's own exact tmux session name -
safe against name collision because this app uniquifies colliding tmux names
at create time, so a dead session and its uniquified replacement never share
one name string - verified against that exact scenario in the new test file).
A non-array listing payload now returns false without calling announceMissing,
instead of being reported as a confirmed death. NOTE: per the coordinator's
mid-task correction, the specific incident that prompted this ("cloudecode is
no longer running") was a REAL death (cloude_cloudecode's pane genuinely died;
cloude_cloudecode-2 was a distinct, later, uniquified session) - the fix here
addresses the ordering/malformed-payload defects, not a false report in that
incident.
D4 (styling): moved the inline `background:#c00` alarm-red styling out of
index.html into client/css/deep-link-notice.css, reusing the existing
--color-info/--color-info-bg/--color-info-border tokens (same combo as
.auth-info elsewhere in styles.css) so it now reads as a calm, theme-aware
informational strip instead of an error bar. Position preserved: still an
in-flow block at the top of <body>, above .header - never moved into
.terminal-container.
Files: client/js/router.js, client/js/toast-navigate.js, client/js/app.js,
client/index.html, client/css/deep-link-notice.css (new),
tests/test_deep_link_notice.node.mjs (new, 10 tests, all passing).
Regression check: tests/test_navigation_generation.node.mjs (15/15),
tests/test_toast_dismiss/_reconcile/_stacking/_click_single_navigation/
_history_render/_attachment_toast.node.mjs all still pass unchanged.
Full python suite NOT run (box under load per orchestrator instruction) - a
clean-box run is still owed for this branch, same as the entries above.

## [TOAST-GUARD-FIX] section

[TOAST-GUARD-FIX] [2026-09-11T03:31:55Z]: Confirmed the live diagnosis by
reading the code: `SessionManager.auto_ack_toasts` guarded the stale-id remap
on `session_id not in self._pending_toasts` (does this session have any
recorded toasts) instead of `session_id not in self.sessions` (is this
session unknown to me). A live, registered session with an empty toast
bucket - the common case, since most hook events fire on a session that has
never raised a toast - fell into `_live_session_id_for_stale_id`, found its
own tmux name in `_hook_tmux_names`, and matched itself. That is the 339
`toast_session_id_remapped` events with `stale_id == live_id` measured on
live, zero genuine remaps. Fixed by changing the guard to `if session_id not
in self.sessions:`. File: src/core/session_manager.py (`auto_ack_toasts`,
around what was line 3248, now shifted a few lines by added docstring
prose).

[TOAST-GUARD-FIX] [2026-09-11T03:31:55Z]: Added defence-in-depth to
`_live_session_id_for_stale_id` itself: a loop match onto the caller's own
id is now treated as no match (no log, loop keeps scanning for a genuinely
different live session sharing the tmux name, then returns None). Both
current callers (`record_toast`, `auto_ack_toasts`) already guard on the id
being absent from `self.sessions`, so this cannot fire from them today -
this hardens the shared resolver for any future caller. File:
src/core/session_manager.py (`_live_session_id_for_stale_id`).

[TOAST-GUARD-FIX] [2026-09-11T03:31:55Z]: Permission-flag safety net fix.
Read `pane_alive`'s only production source: `_session_info_for` computes
`True if liveness == LIVENESS_LIVE else None` and, critically, already
returns None (drops the whole row) on `LIVENESS_GONE` BEFORE the permission
verify call is ever reached - so `False` never reached
`should_capture_permission_tail` in production, even though the pure
function's `Optional[bool]` signature and docstring already anticipated it.
This is a wiring gap, not a type-expressiveness gap. Closed it three ways:
(1) added `PERMISSION_CLEARED_PANE_DEAD` verdict constant in
src/core/session_permission_verify.py; (2) added a branch in
`session_permission_verify_apply.verify_open_permission` that, on
`pane_alive is False` (measured dead, never confused with `None`/unknown),
clears an open permission claim directly with NO tail capture (nothing left
to read) and logs `permission_flag_cleared_pane_dead`; `None` still falls
through to the unchanged cost-gate path and KEEPS the flag; (3) wired
`pane_alive=False` into the one call site, inside `_session_info_for`'s
`LIVENESS_GONE` branch in src/core/session_manager.py, right before the
existing `return None` that drops the row from the list - this is NOT a
reaper rung and does not change whether/when the row disappears from
`/sessions/list`, it only retires the in-memory tracker flag so a stuck bit
cannot resurface if the same row is ever recreated onto a new tmux
instance. Updated one pre-existing test
(tests/test_session_permission_verify.py::test_the_seam_refuses_a_dead_or_unmeasured_pane)
that had asserted the OLD (buggy) contract - both `None` and `False` kept
the flag forever - split into two tests, one unchanged for `None`, one new
for `False` asserting the clear.

[TOAST-GUARD-FIX] [2026-09-11T03:31:55Z]: Test results - ran only the
directly related fast suites (not the full python suite; box is under load,
a clean-box full run is still owed): 151 passed in
tests/test_permission_verify_pane_dead.py,
tests/test_toast_stale_id_self_remap.py, tests/test_session_permission_verify.py,
tests/test_permission_verify_cost.py, tests/test_toast_auto_ack.py,
tests/test_toast_cross_session.py, tests/test_toast_lifecycle.py,
tests/test_toast_supersede.py, tests/test_hook_toast_subagent_suppression.py.
Widened to every tests/test_toast*.py plus test_permission_verify_pane_dead.py,
test_toast_stale_id_self_remap.py, test_session_permission_verify.py,
test_permission_verify_cost.py, test_led_real_hooks.py: 126 passed, 9 skipped
(real-hook tests skip without CLOUDE_REAL_HOOK_TESTS=1 / no tmux+claude), 0
failed.

[TOAST-GUARD-FIX] [2026-09-11T03:31:55Z]: Negative controls were actually
mutated and watched go red, not just written: (a) temporarily set the
auto_ack_toasts guard to `if False:` (never remap) - test
`test_genuinely_stale_id_still_remaps_and_acks` failed as expected, all
other tests in that file still passed; reverted, all green again. (b)
temporarily widened the new permission branch from `pane_alive is False` to
`pane_alive is not True` (collapsing measured-dead and unknown into one
clear-on-both branch, the exact anti-pattern being guarded against) - test
`test_unmeasured_pane_liveness_keeps_the_open_permission_flag` failed as
expected, the measured-dead test still passed; reverted, all green again.

[TOAST-GUARD-FIX] [2026-09-11T03:31:55Z]: Did not touch
src/core/session_lifecycle.py and added no reaper rung keyed on pane_dead,
per the explicit constraint. The one call-site wiring change (passing
pane_alive=False into the existing verify_open_permission helper from
inside _session_info_for's pre-existing LIVENESS_GONE branch) was necessary
for the fix to be reachable in production at all - flagged explicitly in the
session report as an interpretation beyond the literal file/line named in
the brief, since without it the fix would be dead code.

## [LAG-FIX] event loop stalls on GET /sessions/list

[LAG-FIX] [2026-09-11T03:45:00Z]: DIAGNOSIS CONFIRMED WITH A CONTROL. Interleaved
A/B, 409 paired samples over 90s: the app's /health read p50 74.8ms / p99 1262ms
while an idle asyncio server in a separate process, sampled at the same instants
on the same box, read p50 1.2ms / p99 30.7ms with zero samples over 250ms. So the
machine's load is not the cause and the app's own event loop is blocked.
/sessions/list measured p50 291ms; /health sampled INSIDE a listing window
measured p50 211ms against 48ms outside one.

[LAG-FIX] [2026-09-11T03:45:00Z]: THE PER-PASS COST IS NOT REGRESSED. Both
ceiling tests still pass (tests/test_listing_pass_datastore_cost.py, the 4N+2
datastore bound; tests/test_listing_subprocess_cost.py). The 2026-09-09 work
genuinely cut what one pass costs. What it never did was cut HOW MANY passes run,
or move any of them off the loop.

[LAG-FIX] [2026-09-11T03:45:00Z]: THE MULTIPLIER WAS 15. Fifteen established
connections (5 Brave, 2 Electron, 7 python) each poll this endpoint every 5s from
BOTH the sidebar and the launchpad, so the measured stall signature had a period
of about 0.85s rather than 5s and the passes overlapped almost continuously.
Every one of those callers was paying for a full synchronous pass to receive an
identical answer.

[LAG-FIX] [2026-09-11T03:45:00Z]: PART 1 SHIPPED - src/core/single_flight.py.
While a pass is in flight a concurrent caller awaits THAT pass. It is NOT a cache
and must never become one: a caller arriving after a pass completes gets a fresh
pass, because a remembered list paints a session alive after its pane died. The
pass is owned by an independent asyncio.Task and every caller awaits it through
asyncio.shield, so cancelling one caller (a phone locking its screen) cancels only
that caller's wrapper and the remaining awaiters still get their result. A failure
reaches every caller awaiting that flight and leaves nothing parked behind.
Wired at src/api/routes.py list_sessions, which is the only production caller of
list_session_infos.

[LAG-FIX] [2026-09-11T03:45:00Z]: THE ONLY BEHAVIOUR CHANGE IS FEWER PASSES, and
the pass's own side effects (the permission re-verify capture, the transcript
unread claim, the settled-state write) are already throttled per session rather
than per poll, so running fewer passes cannot skip one.

[LAG-FIX] [2026-09-11T03:45:00Z]: PART 2 NOT SHIPPED, AND THE REASON IS A DURABLE
FILE. Moving the synchronous body into asyncio.to_thread is FEASIBLE on three of
the four axes and unsafe on the fourth. Safe: no asyncio touch anywhere in the
synchronous region (swept session_manager.py:4688-5365 plus every helper module,
zero hits; the one await, _flush_startup_toasts at :5391, is after the loop);
every SQLite connection is created and closed inside one call
(_writable_datastore_connection, session_manager.py:5638, returns a fresh
db.connect each time, nothing cached on self or at module level), so the default
check_same_thread=True is harmless because no connection would cross a thread; and
all three tmux calls are blocking subprocess.run through _run_tmux_sync
(tmux_backend.py:581) and _run_listing (:1493), which is exactly the kind of work
a thread is for.

[LAG-FIX] [2026-09-11T03:45:00Z]: WHAT IS UNSAFE IS SHARED MUTABLE STATE, AND IT
IS NOT ONE CONTAINER. The listing pass WRITES, and the event loop writes the same
things from the hook endpoint (routes.py:2305 claude_event_hook), the WS bind
(websocket.py:308) and the unread route (routes.py:1543). The worst one is
durable: UnreadStore._save builds a FIXED temp filename,
src/core/unread_store.py:94, tmp = self._path.with_suffix(suffix + '.tmp'), then
os.replace. The pass writes that file (session_transcript_status_read.py:382
store.set_flag) and so does the Stop branch of record_hook_event
(session_manager.py:2838). Two concurrent _save calls interleave their json.dump
into ONE temp file before either rename, which corrupts the unread state on disk.
The worst in-memory one is a two-field invariant written in two statements:
session_activity.py:688-689 clears permission_open then permission_opened_at while
:402-404 sets them in the opposite order, so a torn interleave leaves
permission_open true with no stamp, and permission_open_since (:708) reads both as
one fact. Eight more read-modify-write spans behind those: _pending_toasts rebuilt
and rebound (session_manager.py:2409-2422) against a hook-side append (:2634), the
_pending_startup_toasts drain-and-rebind (:5488-5489), the once-per-instance
claim_toast check-then-set (session_startup_gate_ledger.py:315-320) whose record
object can be replaced underneath it by record_hook (:122-123), the seed store's
due-then-remember (session_status_seed_read.py:408-414), and
TranscriptTurnLedger.observe (session_transcript_status_read.py:252-261).

[LAG-FIX] [2026-09-11T03:45:00Z]: THE SMALLEST CORRECT WAY TO MAKE THE MOVE SAFE
is to split the pass rather than to add locks. Every expensive thing in it is a
READ (tmux list-panes, tmux capture-pane, the row reads) and every unsafe thing in
it is a WRITE. A measurement phase that opens its own connections, spawns its own
subprocesses and touches no shared container is safe in a thread by construction;
an apply phase that performs every mutation stays on the loop, where it is already
correct today. That is the config_files.list_subtree pattern applied properly, and
it is a real refactor of a 400-line function rather than a one-line await. Locking
each container instead would mean a lock held across a subprocess and a SQLite
open, which is the stall moved rather than removed. Note the coalescer does help a
future attempt: it makes pass-versus-pass impossible, so only pass-versus-loop
would remain.

[LAG-FIX] [2026-09-11T03:45:00Z]: SEPARATELY, unread_store.py:94 IS A LATENT
DEFECT TODAY, independent of any threading decision. The app already runs
_mark_closed_in_datastore and other work through run_in_threadpool, and a fixed
temp name is one concurrent writer away from a truncated unread file whichever
thread arrangement it is reached from. A unique temp name (pid plus a random
suffix, as config_writer already does) is the one-line fix and was NOT made here
because it is outside this brief.

[LAG-FIX] [2026-09-11T03:45:00Z]: TESTS. tests/test_single_flight.py, 12 passed,
structural and never timed: every wait is an asyncio primitive or a count of loop
turns, so load can make them slow and cannot make them wrong. Each of the four
properties carries a negative control that reproduces the wrong implementation
inline, and each control was WATCHED GOING RED against a deliberately mutated
single_flight.py - never coalescing (5 red), joining a finished flight (the
ordering-independent guard test, 1 red), a true cache (3 red), keeping a failed
flight parked (1 red), and a bare await instead of asyncio.shield (the
cancellation test, 1 red). tests/test_listing_pass_datastore_cost.py and
tests/test_listing_subprocess_cost.py still pass (7). 105 more passed across the
route-adjacent suites. A FULL SUITE NUMBER IS OWED ON A QUIET BOX - this one was
at load average about 250 and the full run was not attempted.

## [UNREAD-TEMP-FIX] unread store temp filename

[UNREAD-TEMP-FIX] [2026-09-11T05:10:00Z]: CONFIRMED, AND IT IS LATENT, NOT
REACHABLE TODAY. The prior report (logged above as [LAG-FIX]) reproduced on (a)
and (b) and was overstated on (c). (a) UnreadStore._save built a FIXED temp name,
verbatim: `tmp = self._path.with_suffix(self._path.suffix + ".tmp")` - one shared
filename for every writer of unread_state.json, the same shape config_writer.py
was written to end for config.json. (b) FIVE distinct call paths write it, not
two: the Stop branch of SessionManager.record_hook_event (session_manager.py:2834)
from the async hook route; SessionManager.set_manual_unread (:2038) from the async
PATCH /sessions/{name}/unread; session_transcript_status_read._claim_unread (:384)
from the listing pass; session_view_clears.clear_view_state (:153) from the
WebSocket bind and from mark-read; and the boot reconcile's prune (:1504).

[UNREAD-TEMP-FIX] [2026-09-11T05:10:00Z]: (c) THE CORRUPTION CANNOT HAPPEN TODAY
and the report should not have implied it could. _save contains NO await - the
open, the json.dump, the fsync and the os.replace are one synchronous block - and
every one of the five writers runs on the single uvicorn event loop. Every route
in src/api is `async def` (checked: there is not one sync `def` handler), no
asyncio.to_thread, run_in_executor or threading.Thread path reaches the store, so
two saves cannot interleave. What makes it worth fixing anyway is that the
serialisation is a property of TODAY'S THREADING, not of this module: the pending
move of the listing pass into a worker thread activates it, and that move was
already held back partly for this.

[UNREAD-TEMP-FIX] [2026-09-11T05:10:00Z]: THE FIX. src/core/unread_store.py only.
New module-level `_unique_tmp_path(path: Path) -> Path` applying the same
pid-plus-random-suffix rule config_writer._replace_atomically already uses, rather
than a second spelling of it. NOT shared as a common helper: config_writer's
version is private, is bound to the config.json boundary, and does the json.dump
itself, so importing it would have meant taking its logging level (warning) and
its key ordering too - and the brief was to preserve this store's write sequence,
fsync placement and `logger.error("failed_to_save_unread_state", ...)` exactly. A
local helper was the smaller, more faithful change. No lock added, no caller
touched, no restructuring.

[UNREAD-TEMP-FIX] [2026-09-11T05:10:00Z]: CLEANUP IS NOW REQUIRED, NOT OPTIONAL.
A fixed temp name self-limited to ONE orphan that the next write overwrote; a
unique name would drop a fresh corpse into the state directory on every failure.
The except branch unlinks it, guarded by OSError only (FileNotFoundError is an
OSError, and it is reached only when os.replace did not run). The pre-existing
blanket `except Exception` on _save was left alone: it is outside this brief and
the brief was explicit about preserving the error handling.

[UNREAD-TEMP-FIX] [2026-09-11T05:10:00Z]: STILL OPEN, SAME SHAPE, DELIBERATELY
NOT TOUCHED. Three more fixed-`.tmp` writers remain in session_manager.py -
_save_pinned_themes and the two beside it at :1817, :1932 and :2231 - plus
config_files_io.py:99. They are the identical latent defect and were left out of
scope rather than folded into an unrelated change. json_artifact.py,
hook_tokens.py and tmux_server_config.py already use tempfile.NamedTemporaryFile
and are fine.

[UNREAD-TEMP-FIX] [2026-09-11T05:10:00Z]: TESTS. New
tests/test_unread_store_temp_name.py, 7 passed, and every assertion OBSERVES the
temp path by spying on os.replace inside the module rather than importing the
implementation's format string - a test that read the constant would agree with it
whatever it said, including a fixed one. NEGATIVE CONTROL WATCHED GOING RED: with
_unique_tmp_path mutated back to `path.with_suffix(path.suffix + ".tmp")`, three
tests failed naming the defect (two writes reusing one name, two store instances
sharing one name, and the legacy name `unread_state.json.tmp` reappearing);
reverted and all 7 green again. Targeted run of the unread-touching suites plus
the config-writer boundary guard: 146 passed. Wider run over every tests/*.py
mentioning "unread": 2075 passed, 9 skipped, 0 failed. A FULL SUITE NUMBER IS
OWED ON A QUIET BOX - this one was at load average about 250 and the full run was
not attempted.

[UNREAD-TEMP-FIX] [2026-09-11T05:10:00Z]: ONE FLAKE, NOT ATTRIBUTED TO THIS
CHANGE, RECORDED SO NOBODY CHASES IT TWICE. The first wide run reported 3 failures
in tests/test_state_dir_resolution.py, all on the get_session_metadata_path
parametrisation. The identical command was re-run twice afterwards and passed both
times (2075 and 2077 passed, 0 failed), and the same set WITHOUT this change's new
test file also passed clean (2067). That file is already named in CLAUDE.md as
carrying environmental failures. Treat a lone failure there on a loaded box as
noise and re-run before investigating.

[IDLE-NAG] 2026-09-11T00:00:00Z: Suppressed claude's idle-nudge Notification
(measured on ses_63beb976: Stop followed by Notification at +60.1s, twelve
consecutive times, with no sub-agent involved). New pure function
`session_activity.idle_notification_should_suppress(permission_open, turn_open,
stop_seen)` reuses the existing `turn_open` flag - suppresses a Notification only
when a Stop was positively seen, nothing has reopened the turn since, and no
permission is open. Wired via `SessionActivityTracker.should_suppress_idle_notification`
-> `SessionManager.should_suppress_idle_notification` -> a new gate in
`claude_event_hook` (src/api/routes.py), checked only for event_kind == "Notification",
read BEFORE record_hook_event, right after the existing sub-agent gate. Returns
`{"ok": true, "toast_suppressed": "turn_closed"}` and logs `hook_toast_suppressed_turn_closed`.
State machine untouched (record_hook_event still runs; notice_open still flips).
Fails toward notifying on an unknown session, no Stop ever seen, a reopened turn,
an open permission, or a read that throws.
Three pre-existing tests in tests/test_hook_toast_subagent_suppression.py
(test_the_latch_expires_and_the_notification_is_raised,
test_a_session_that_never_had_subagents_is_unaffected,
test_an_unreadable_latch_still_notifies) were exercising exactly the plain
Stop-then-Notification case this fix now correctly suppresses; each got one
extra monkeypatch line neutralizing the new gate so that file keeps testing the
sub-agent-specific latch in isolation - no assertions were rewritten.
New test file tests/test_hook_toast_idle_nudge_suppression.py, 15 tests, all
passing. Mutation-tested two negative controls and watched them go red: (1)
widening the route's gate to also cover PermissionRequest failed
test_permission_request_always_raises_even_after_a_clean_stop; (2) dropping the
`stop_seen` requirement from the pure function failed
test_pure_function_refuses_when_any_one_condition_fails[kwargs2]. Both mutations
reverted immediately after confirming red, verified back to clean via py_compile
and a full re-run (281 passed, 9 skipped).
Ran, not the full suite (box load ~250): the above plus test_session_activity.py,
test_hook_driven_status.py, test_toast_auto_ack.py, test_toast_lifecycle.py,
test_toast_supersede.py, test_toast_cross_session.py,
test_toast_carries_session_identity.py, test_session_notification_mute.py,
test_claude_hooks.py, test_toast_stale_id_self_remap.py, test_led_real_hooks.py -
281 passed, 9 skipped, 0 failed. A full-suite number (`venv/bin/python3 -m pytest -q`)
is owed on a quiet box; not run here given load.

[HUSK-REAPER] [2026-09-10]: Closed the `STILL OPEN` item under CLAUDE.md's "A DEAD PANE DROPS OFF THE LIVE LIST AND BELONGS IN RECENT". A session whose pane died stayed `lifecycle='running'` forever, because `remain-on-exit` keeps the husk LISTED and the only reaper argues from ABSENCE. The row was therefore in no group the user can see: gone from the live list, never arriving in RECENT.
[HUSK-REAPER] [2026-09-10]: New pure module `src/core/session_pane_death.py` holds the whole rule with no I/O. It answers `dead` ONLY on a `#{pane_dead}` of exactly "1", from a COMPLETE pane listing, taken from the socket the reconcile is about, for a row whose creation epoch matches the stored one. Eleven other paths answer `unknown` and reap nothing. Vocabulary reused from `session_respawn` (`PANE_DEAD`/`PANE_ALIVE`/`PANE_UNKNOWN`), not re-minted.
[HUSK-REAPER] [2026-09-10]: ZERO new subprocesses. `TmuxBackend.list_pane_status_all` already carries `#{pane_dead}` AND `#{session_created}` in its `list-panes -a` format string, and `list_attachable_sessions` was already calling it a few lines BELOW the reaper. The only change is that it is now called a few lines ABOVE it. Pinned by `test_the_reap_adds_no_tmux_subprocess_of_its_own`, which counts tmux invocations rather than timing anything.
[HUSK-REAPER] [2026-09-10]: The reap does EXACTLY what the absence reap does - the same four columns (`lifecycle`, `lifecycle_source`, `lifecycle_checked_at`, `updated_at`), in the same single writer function, so there is one reap behaviour and not two. It does NOT delete, does NOT touch `archived_at`, `origin`, `session_uuid`, `last_seen_running_at` or `tmux_session_id`, does NOT unregister the in-memory session, and does NOT kill the tmux session. Project binding, title, pinned theme, unread flag and group filing all ride on the row and are untouched. `lifecycle_source='pane_dead'` is the only thing that distinguishes it from `tmux_missing`.
[HUSK-REAPER] [2026-09-10]: `status_map_from_listing` added to `src/core/session_status_map.py` and used by BOTH construction sites, so "the socket travels with the listing" is stated once. It also carries `refused_rows` through as `complete`, which the hand-rolled version at the attachable site did not.
[HUSK-REAPER] [2026-09-10]: Four separate mutations were run and watched go red, then reverted: gate always returns dead (44 of 53 failed), the `complete` gate removed (3 failed), the socket gate removed (3 failed), the epoch gate removed (2 failed). The always-dead mutation also fails the real-tmux test, by reaping the live control session beside the husk.
[HUSK-REAPER] [2026-09-10]: RECOMMENDATION, NOT IMPLEMENTED - the tmux husk is left alive, so it keeps squatting its name and the next session for that project is still uniquified (`cloude_cloudecode-2`). Freeing the name means killing a tmux session, which destroys the dead pane's final screen that `remain-on-exit` exists to preserve. Needs the owner's explicit yes.
[HUSK-REAPER] [2026-09-10]: FOUND, NOT FIXED - `tests/conftest.py` derives the `real_tmux` marker from a fixed list of socket-guard symbol names that does NOT include `derive_test_socket`, so `tests/test_recreate_gate_real_tmux.py` runs in the FAST loop despite driving a real tmux server. The conftest's own comment says the derivation "may over-include and must never under-include". One line fixes it (add `derive_test_socket` to `_SOCKET_GUARD_NAMES`); left alone as a shared-file change outside this task.

[ISSUE-39] [2026-09-11]: Claimed via PR #104 (Adoom666/CloudeCodeDev), branch feat/39-toast-render-batch, linkage confirmed on first poll. Client-side render batching shipped: ToastManager._scheduleRender() (client/js/toast-render.js) coalesces any number of add/dismiss/updateLocal calls in one synchronous burst into ONE call to _render(). client/js/toast-render-batch.js is the frame-or-timer scheduler (races requestAnimationFrame against a 32ms setTimeout fallback per gotcha 9), loaded via a new script tag in client/index.html right before toast.js.
[ISSUE-39] [2026-09-11]: add() still refreshes a known id in place, unchanged. A version-aware skip/replace/discard rule was written and then REMOVED before commit: `Toast` (src/models.py) carries no `version` field, so the rule was inert today and would have armed itself the moment anyone added one, with no server-side test in this tree to catch a mistake. If the server half is ever built - a `version` on the Toast model, incremented on supersession in session_manager.py, returned by the backfill and list endpoints in src/api/routes.py - the client rule goes in with it, in the same change, with tests on both sides.
[ISSUE-39] [2026-09-11]: New test tests/test_toast_render_batch.node.mjs (8 cases): burst-add collapses to one render pass, a second burst after a flush gets its own single pass, dismissAll collapses to one render pass, the batch still flushes when rAF never fires (hidden tab), a committed NEGATIVE CONTROL proving a bare-rAF-only scheduler never flushes in that same scenario, grouping/winner-pick/xn-badge semantics unchanged under batching, the attachment receipt still renders as its own card, and a supersession reusing an id refreshing that card in place. Manually mutated the shipped client/js/toast-render-batch.js to strip the timer fallback (bare rAF only) and confirmed exactly the two hidden-tab-dependent tests went red, then reverted and reconfirmed green.
[ISSUE-39] [2026-09-11]: Extended tests/lib_toast_dom_stub.mjs to also load toast-render-batch.js into the shared sandbox so every existing toast suite exercises the real wiring; its stub requestAnimationFrame is synchronous so all existing suites remain byte-identical in observable timing (schedule() resolves synchronously under that stub, same as calling _render() directly before this change). Ran all 20 node suites that mention "toast": 100% pass, no regressions. Full python suite NOT run (box load ~250 per instruction); owed on a quiet box.
[ISSUE-39] [2026-09-11]: docs/notifications.md updated: file table (toast-render.js description, new toast-render-batch.js row, toast-lifecycle.js description), tests table (new suite), and a new "Rendering many toasts at once (issue #39)" section explaining the batching mechanism.
