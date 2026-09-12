# Adam round 2 review: `887b8fc..adamdev/master` (tip `2b1fcb9`)

Adversarial read against our `release/1.2` (`344da42`, v1.2.0, live). 15 files, +2276/-41. Written 2026-09-10 from the main repo while its tree sits on `feat/svelte-web`. NOT COMMITTED; nothing in the tree was modified.

## 1. Per commit: what changes, what is claimed, MEASURED or ASSERTED

**Every performance claim in this series is measured in its own commit message, with before/after numbers and a named negative control. That is the rare case.**

- **`7e4f09b` docs sha256.** README hash only. No claim.
- **`202de53` toast.** New `ToastManager._isActiveSession` and `dismissForSessionEntry()`; `add()` early-returns for the active session; `SessionSidebar.setActiveSession` calls the new dismisser; name-click routed through the existing `dismissGroup`. `local: true` (attach receipt) exempt. ASSERTED, correctly so for a UX change; covered by `test_toast_dismiss.node.mjs`.
- **`c8ef6a8` listing blocks the event loop.** Removes two per-row tmux subprocesses from `_session_info_for`. (a) `_build_tmux_status_map` returns a `StatusMap` dict subclass carrying `complete`, and `exists=` becomes `listing_proves_alive(status_map, name) or backend.is_alive()`. (b) `should_capture_tail` gains a fourth refusal (`tail_age_seconds` vs `STARTUP_TAIL_RECHECK_SECONDS = 30`); `StartupGateLedger` grows `record_tail_read` / `last_tail_match` / `tail_age_seconds`; `resolve_startup_gate` grows `remembered_match`, consulted ONLY at rung 5 so the throttle cannot flap the row to `unknown`. MEASURED: 13 sessions, 27 subprocesses, 1008 ms per pass, split 282 list-panes / 377 has-session / 349 capture-pane, with queueing evidence beside it (`/health` p99 249 ms; `/sessions/records`, 5.8 ms of real work, p99 161 ms). He also lists what he ruled out BY MEASUREMENT rather than assumption.
- **`a4eff35` index plus pipe wakeup.** Item 1: `session_instance_index.py` (`InstanceIndex`, `build_instance_index`, `InstanceFacts`) collapses three per-row SQLite opens in `list_attachable_sessions` into one SELECT, wired via `SessionManager._instance_index_for_listing`. MEASURED: 11 rows, 33 connections, 33 ms of a 55 ms pass; opens `3+3N -> 3`; warm pass 52-61 ms to 24-35 ms. The message records that his going-in premise was WRONG and that a subprocess count would have passed before any fix. Item 2: `pipe_wakeup.py` (`PipeWaiter`) wakes `TmuxBackend._tail_loop` on kqueue `NOTE_WRITE|NOTE_EXTEND` instead of a bare 20 ms sleep. MEASURED interleaved A/B, 100 keystrokes each through a real pane: p50 26.10 -> 12.31 ms, p90 60.20 -> 28.44, p99 141.32 -> 77.59; idle CPU 0.97 vs 0.98 percent over 11 idle panes. Records a rejected alternative, a test flake he traced to his own fixture, and one defect he did NOT fix (`_maybe_rotate`'s docstring claims an fd re-point no code performs).
- **`2b1fcb9` skip the index when there are no rows.** Reverses part of his own previous commit: `/sessions/attachable` returns ZERO rows on a settled box, so the wrapper opened a connection to learn it had nothing to do. Checks the names first. MEASURED, and a self-correction, which is the strongest signal in the series.

**The benchmark test is real and would catch a regression, not pass forever.** `tests/test_listing_subprocess_cost.py` counts SUBPROCESSES and DATASTORE OPENS against REAL tmux on a throwaway socket, never wall clock. Hard assertions: `has-session == 0`, `len(calls) < 2N`, first-pass `capture-pane == LIVE_SESSIONS` (the negative control against a fix that merely stopped looking), second-pass `capture-pane == 0`, `first == second` (no flap), `datastore opens <= MAX`, plus a companion asserting every decoration survives. All three original cases are stated to fail on the shipped code. `requires_tmux`-skipped, which is our existing pattern.

## 2. Our tree: the defect is PRESENT, measured on live

**We have both halves of `c8ef6a8`'s defect verbatim, plus two of our own on the same pass, and the live box shows the head-of-line blocking directly.**

On `release/1.2`: `list_session_infos` (`session_manager.py:4929`) is an `async def` whose body is fully synchronous but for a trailing `await self._flush_startup_toasts()`; `_session_info_for` still passes `exists=backend.is_alive()` per row; `should_capture_tail` (`session_startup_gate.py:203`) is byte-identical to his pre-fix version, carrying our CLAUDE.md sentence "on a working box that set is empty" which his measurement falsifies (the ledger is in-memory per process, so a session whose last hook predates this process never acquires one).

MEASURED ON LIVE, mac-mini-m4:8000, 1.2.0, 19 sessions, read-only, over loopback from the mini. Bearer minted on the box from the install's TOTP secret; negative control in the same pass, bogus bearer returns 401.

| endpoint | n | p50 | p90 | p99 | min/max |
|---|---|---|---|---|---|
| `/api/v1/sessions/list` | 12 | **270.1 ms** | 387.5 | **418.5** | 228.8 / 418.5 |
| `/api/v1/sessions/records` (threadpool) | 8 | 41.0 | 43.6 | 51.9 | 35.1 / 51.9 |
| `/api/v1/health` (no-op) | 10 | 94.4 | 143.2 | 481.6 | 63.3 / 481.6 |
| `/api/v1/sessions/attachable` | 6 | 93.0 | 98.4 | 145.8 | 49.6 / 145.8 |

One endpoint being slow does not prove the LOOP is blocked, so the decisive run polls the no-op while a listing is in flight:

| `GET /health` | p50 | p99 | max | n |
|---|---|---|---|---|
| quiet | 45.3 ms | 303.6 | - | 15 |
| during `/sessions/list` | **181.9 ms** | 214.0 | 224.0 | 11 |

A no-op inflating 4x and capping at roughly one listing pass is head-of-line blocking, not slow work. The quiet baseline is itself contaminated by the app's own 5 s poller, so 45.3 ms overstates quiet and the real gap is wider. Expected cost here is 1 + 19 + up to 19 = 39 subprocesses per poll, against his 27 at 13 sessions. `/sessions/attachable` returns ZERO rows on our box too, independently reproducing the finding behind `2b1fcb9` on our data.

**Two extra costs are ours alone and he fixes neither.** `session_permission_verify_apply.verify_open_permission` is a third potential per-row `capture-pane`, and the seed ladder's `read_instance_row` (`session_status_seed_read.py:151`) opens its own connection PER ROW via `manager._writable_datastore_connection()`, beside `_restored_activity_state` and a transcript tail read. That is the `3+3N` shape `InstanceIndex` fixes, on `/sessions/list`, which his index does not cover. The 60 s seed cache bounds it; it does not remove it.

## 3. Collision with our status work

**No double derivation. `session_status_map` derives LIVENESS despite the name, and our ladders are untouched.**

`StatusMap` / `listing_proves_alive` answer only "does the completed bulk listing NAME this session", feeding `exists=` into our existing `resolve_listing_liveness`. They never touch `activity_status`, `status_source`, unread, or any epoch key. `session_instance_index` serves `list_attachable_sessions` alone. So CLAUDE.md's "two derivations of one key are two keys the moment they disagree" is NOT triggered: `unread_identity` stays the single source of the unread epoch and `_session_info_for` still reads `unread_identity.epoch_of_row(row)` off the same bulk row.

**The one thing to reconcile by hand is his gap, not ours.** `listing_proves_alive` trusts the POSITIVE half of a listing taken from ONE probe, while `backend.is_alive()` runs `has-session` on THAT BACKEND'S socket. He argues the socket mismatch as a reason not to trust the negative; it is equally a reason the positive can be wrong, since a name present on the probe's socket would vouch for a dead session held by a backend pinned elsewhere. Single-socket per process today, so it is narrow, but it is an unstated precondition. Functions: `listing_proves_alive`, `_build_tmux_status_map`, the `exists=` expression in `_session_info_for`.

Three of ours want a follow-up round rather than a change here: `session_status_seed_read.read_instance_row`, `_restored_activity_state`, `session_permission_verify.should_capture_permission_tail`.

## 4. `pipe_wakeup.py` versus our pipe handling

**Safe. It never goes near the guard that bit us.**

Confined to `TmuxBackend._tail_loop`: `PipeWaiter(fd)` wraps the fd the loop already opened, and `waiter.wait(PIPE_IDLE_POLL_SECONDS)` replaces `asyncio.sleep(0.02)` on the empty-read branch only. `ensure_pipe_pane`, `attach_existing` and the boot re-adopt's `needs_pipe_setup` are NOT touched, so the `attaching=True` history is not in play. It sets up no pipe and issues no tmux command.

Three things make it fail-safe, all in the code rather than the message: the 20 ms sleep stays a BACKSTOP, so a lost notification costs exactly the old latency and can never stall; `_pending_data` latches an append landing between an empty read and the wait, which is the real race; and every failure path (no kqueue, loop refuses the descriptor, kernel refuses the fd, constructed outside a running loop) leaves `watching` False on the plain sleep. `close()` runs BEFORE `os.close(fd)` in the `finally`, correct ordering. Cost is one kqueue fd plus one `add_reader` per session, 19 extra descriptors on live.

Nits, not blockers: `if "kq" in dir() and kq is not None` should be a `kq = None` above the `try`; and `_on_kqueue_readable` falls through to set `_pending_data` and resolve the waiter after `_detach()`, one harmless spurious wake.

## 5. Toast changes versus our toast machinery

**Complementary, with one interaction to decide rather than discover.**

His changes are entirely client-side. `toast_auto_ack.resolve_auto_acks` acks by KIND on the server from hook events; `dismissForSessionEntry` dismisses the CARD with `syncToServer: true` onto the same idempotent endpoint. `session_view_clears` already clears `notice_open` on WS bind, so his dismissal is the visual half of a rule we implemented server-side. No overlap in mechanism.

The interaction: `add()` now DROPS a toast for the active session, while our `StartupGateLedger.claim_toast` is once per instance and the server has already recorded it open. A suppressed card is therefore recorded, unacked and unrenderable; our `reconcileOpen` only REMOVES cards the server has closed, so it will not re-materialise it. For a permission or startup prompt on the session the user is looking at, silence is the intent. Say it out loud in TODO rather than leaving it to be found.

## 6. Verdict

| Commit | Verdict | Reason |
|---|---|---|
| `7e4f09b` docs sha256 | **TAKE** | README hash only, zero risk. |
| `202de53` toast | **TAKE** | Client-only, complementary to our auto-ack, tested; record the suppressed-toast interaction. |
| `c8ef6a8` listing perf | **TAKE WITH CHANGES** | Fixes a defect we measurably have. Change: make `listing_proves_alive` require the probe's socket to equal the backend's socket (carry `socket` on `StatusMap`, compare in `_session_info_for`) so the positive half cannot vouch across sockets. |
| `a4eff35` index + wakeup | **TAKE WITH CHANGES** | Both halves measured A/B. Change: hoist `kq = None` above the `try` in `_try_watch`; then file a follow-up applying `InstanceIndex` to `read_instance_row` / `_restored_activity_state` on `/sessions/list`, where our cost actually is. |
| `2b1fcb9` skip empty index | **TAKE** | Self-correction removing a net cost; our box also returns zero attachable rows. |

**OWNER DECIDES on one thing:** whether `STARTUP_TAIL_RECHECK_SECONDS = 30` is an acceptable worst case for noticing a session that becomes stuck LATER (claude quit and hand-restarted inside a pane whose `pane_pid` does not move, so nothing invalidates the ledger record). First looks are unthrottled, so a freshly launched session parked on its trust dialog is caught on the first poll past the grace window exactly as now.

## 7. Merge dry run

`git merge-tree --write-tree release/1.2 adamdev/master` -> tree `13194929f0ac8976bd0e76df0e2b105a880aa934`.

**TWO conflicting files, both documentation: `CLAUDE.md` and `README.md`.**

Every code file auto-merges, including `src/core/session_manager.py`, `client/js/toast.js` and `client/js/session-sidebar.js`. Textually clean is not semantically clean: our `_session_info_for` grew `verify_open_permission`, the seed ladder and `derive_read_state` in regions his hunks do not overlap, so the merged function still needs reading end to end. The `CLAUDE.md` conflict is substantive: he rewrites the "steady state costs nothing" claim his own measurement falsified, and we rewrote adjacent status-light prose in the same round, so the resolution must keep BOTH corrections rather than pick a side.
