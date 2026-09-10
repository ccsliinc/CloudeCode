# Backend decomposition plan

Written 2026-09-10 against `release/1.2.1` (tagged v1.2.1, deployed live).
Every number below was measured on that tree today, not recalled. This is a
CLAIM plus PLAN round; no product code was written. Coordination claim:
`claims/ccsliinc-backend-decomposition.md` on the orphan `coord` branch,
pushed to `adamdev` and `origin` at `dc5db2d`.

## 1. What this is, and what it is not

**We are giving the stateful shell a structure, not splitting files into
chunks.** This repo has the right idiom for its DECIDERS already: 71
`src/core/session_*.py` modules, almost all pure ladders that take
measurements and return a verdict (`resolve_startup_gate`,
`resolve_respawn_plan`, `choose_agent_evidence`). That is not the
problem. The problem is that the object which HOLDS the state
and performs the I/O has no members at all: one class of 8,055 lines carrying
36 mutable fields, calling every ladder from inside itself. A mechanical file
split moves methods without moving state, which is how you get two dicts that
disagree. The target is a facade composing seven small collaborators, three
structural protocols as substitution points, and the pure ladders untouched.

## 2. The measurement: `src/core/session_manager.py`

**8,340 lines, one class of 8,055, and 37 percent of it lives in eleven
methods.**

| Fact | Measured | Fact | Measured |
|---|---|---|---|
| File lines | 8,340 | Public methods | 68 |
| Classes | 2 (`ProbeHealth` 22, `SessionManager` 8,055) | Written instance fields | 36 of 127 read |
| Module level functions | 3 | Call sites from `src/` | 85 |
| Methods on `SessionManager` | 136 | Call sites from `tests/` | 490 |
| Constructor signature | `__init__(self)`, no arguments | `SessionManager(` constructions | 108, 107 in `tests/` |
| Test files touching it | 93 | | |

The eleven largest methods are 3,045 lines together, with their line numbers:
`create_session` 499 @3294, `adopt_external_session` 443 @6878,
`_session_info_for` 413 @4784, `__init__` 248 @288, `respawn_session` 244
@7612, `list_attachable_sessions` 243 @6634, `_lifespan_tmux_reconcile` 240
@1337, `record_claude_lifecycle_event` 209 @5485, `record_toast` 196 @2452,
`restart_preview` 155 @7910, `_startup_gate_for` 155 @4628.

By I/O class across all 136 methods: 43 pure, 62 tmux only, 5 database only,
26 both. The 26 that touch both are the ones that cannot be tested without a
real socket AND a real database today, and they are exactly the ones the
protocols in section 5 exist for.

## 3. The state map, which is where the real seams are

**A god object's seams are its state, not its headings.** The 36 written
fields cluster into ten groups with almost no cross traffic.

| Cluster | Fields, each with its count of touching methods |
|---|---|
| Session registry | `sessions` 26, `backends` 24, `_subscribers` 5, `log_buffers` 5, `command_counts` 4, `_last_session_id` 3 |
| Hook token authority | `_hook_tmux_names` 12, `_hook_tokens` 9, `_superseded_hook_tokens` 3, `_hook_tokens_durable` 2 |
| Per-session sidecars | `idle_watchers` 7, `adopt_fifo_offsets` 4, `pending_terminal_commands` 2 |
| Toast inbox | `_pending_toasts` 6, `_pending_startup_toasts` 2 |
| Owned tmux ledger | `owned_tmux_sessions` 10, `_legacy_metadata_needs_backfill` 3, `_boot_listing` 2 |
| Theme store | `pinned_themes` 9, `_theme_accent_cache` 1 |
| Instance identity | `_instance_epochs` 7, `_unread_store` 4, `_unread_epochs` 3 |
| Status evidence | `_activity_tracker` 5, `_startup_gate_ledger` 3 |
| Probe health | `_last_probe_socket` 3, and `_last_probe_ok` / `_reason` / `_detail` 2 each |
| Wiring | `_notification_router` 4, six singles including `_notification_policy_store` and `_boot_readopt_task` |

**`_wipe_session_state` (54 lines, @631) is the god method of the god
object.** It alone touches nine clusters, because teardown has to know every
one. It is therefore the LAST thing to cut, and the thing that proves the
decomposition finished: when every cluster is a collaborator it becomes a
loop. Separately, `ProbeHealth` at line 228 is a dataclass nothing constructs,
with the four probe fields sitting loose beside it. That is a seam somebody
already saw and did not finish.

## 4. Where the danger is, and why it inverts the obvious order

**Every incident CLAUDE.md records from this file lives in the adoption and
hook-token triangle, and every one of them was SILENT.**

- The adoption that minted an id instead of resolving one: 94 hook refusals in
  four minutes, answering 403 rather than 410, so a grep for the stale-session
  code found nothing and the hook path looked healthy.
- The mint that landed on a running agent: 4,325 rejections over 4h24m, ended
  by a human restarting the pane.
- The teardown keyed on the id rather than the tmux name: 22 rows for 21 live
  panes. Caught only because the deploy was verified against `/sessions/list`,
  not against the `boot_readopt_complete` log line, which was perfect.
- The guard whose only exercised caller set the flag it checked: 4,874 green
  tests had never observed it raise, and it failed 20 of 20 owned sessions on
  its first real boot.

That last one is the governing lesson for this whole plan. A green suite is
not evidence when the dangerous path is not exercised by it.

So the ordering is inverted from the tempting one. The hook token cluster is
the TIGHTEST cluster in the file, with the fewest outside readers, and it is
the LAST thing we cut. We cut the clusters whose failure is loud and visible
within one turn first.

## 5. The target structure

**Seven classes, three protocols, and the pure ladders untouched.** New code
lives under `src/core/sessions/`. Nothing in that package may import
`session_manager`, which is the rule that keeps the dependency arrow pointing
one way and kills the function-level imports the file uses today.

### Classes, one mutable cluster each

Every one is a plain class, composed not inherited, with typed attributes and
a docstring per method giving description, inputs, outputs and an example
where the usage is not obvious.

- `SessionRegistry` (`sessions/registry.py`). Owns `sessions`, `backends`,
  `_subscribers`, `log_buffers`, `command_counts`, `_last_session_id`. The
  output fan-out binding lives here, so `_make_output_handler` stops being a
  closure factory on the manager.
- `HookTokenAuthority` (`sessions/hook_token_authority.py`). Owns the four
  token maps. Its API is shaped so the invariant is structural rather than
  remembered: `mint(session_id, tmux_name)` is the ONLY writer of a secret,
  `keep(session_id, tmux_name)` re-binds the name and cannot reach the secret,
  and `recover(session_id, presented)` reads the superseded ring and never
  mints. A re-keyed adoption calling `keep` cannot revoke a credential because
  the code to do so is not on that method.
- `ToastInbox` (`sessions/toast_inbox.py`). Owns both pending maps, plus
  record, ack, prune, supersede and the startup-toast one-shot claim.
- `ThemeStore` (`sessions/theme_store.py`). Owns `pinned_themes` and the accent
  cache, and the dotfile read and write.
- `OwnedTmuxLedger` (`sessions/owned_tmux_ledger.py`). Owns
  `owned_tmux_sessions`, the legacy metadata backfill flag, the boot listing,
  and the atomic metadata write. The `.bak` then temp then `fsync` then
  `os.replace` pattern moves with it verbatim.
- `ProbeHealthRecorder` (`sessions/probe_health.py`). Owns the four probe
  fields and finally CONSTRUCTS the `ProbeHealth` dataclass that already
  exists instead of returning a tuple of loose attributes.
- `AttachmentSidecars` (`sessions/sidecars.py`). Owns `idle_watchers`,
  `adopt_fifo_offsets`, `pending_terminal_commands`. Three per-session dicts
  with one identical lifecycle: set at create or adopt, popped at destroy.

### Protocols, so the tmux and database sides are substitutable

`typing.Protocol`, structural, so a double satisfies it by shape and needs no
base class and no mock framework. The repo already uses `Protocol` in five
modules, so this is not a new idea here.

- `TmuxReader` (`sessions/ports.py`). The READ side of tmux: `list_sessions`,
  `capture_pane`, `pane_status_all`, `is_alive`. A listing test feeds a
  recorded listing. The write side stays on `SessionBackend`, which is a
  genuine is-a with a stable base and remains the one legitimate ABC.
- `SessionRecordStore` (`sessions/ports.py`). The subset of `session_store`
  the manager actually uses: `get_instance`, `claim_instance`, and the
  `record_*` writers. Lets the 26 both-sides methods be tested against an
  in-memory implementation without a real sqlite file.
- `Clock` (`sessions/ports.py`). `now()` and `monotonic()`. Half the incidents
  in CLAUDE.md are timing claims (`STARTUP_HOOK_GRACE_SECONDS = 20`,
  `WORKING_HEARTBEAT_TIMEOUT_SECONDS`, `PERMISSION_TAIL_GRACE_SECONDS`) and
  none of them is testable today without sleeping.

**The danger a protocol introduces, said out loud.** A double agrees with
whatever it was built to agree with. So every protocol gets a conformance test
running the REAL implementation against the same assertions as the double, and
a slice whose only evidence is a double is not proven. This repo paid for that
twice: `tests/test_boot_readopt.py` is hermetic and its `FakeBackend` had no
guard to fail, and `tests/test_respawn_refreshes_pane_env.py` exists because a
mock asserting two calls in order only tests its own arrangement.

### Pure function modules, which is most of the remaining volume

The eleven giant methods are each a decision ladder wrapped in I/O. The
decision half becomes a new pure module in the existing idiom; the I/O half
stays on the facade or on a collaborator. New pure modules:
`sessions/create_plan.py`, `sessions/adopt_plan.py`,
`sessions/info_assembly.py` plus `sessions/measurements.py` (the frozen
dataclass of everything `_session_info_for` reads before it decides anything).

### The facade

`SessionManager` keeps its name, its module path and its 68 public methods.
Its body becomes composition plus delegation. Target under 500 lines; if it
does not fit, the public surface is too wide and that is a separate
conversation with the owner, not a reason to leave a 700-line file.

## 6. The contract that cannot move

**68 public methods, 85 src call sites, 490 test call sites, and ten public
ATTRIBUTES reached from outside.** The attributes are the trap, because Python
has no compile step and a moved dict fails at runtime, in one code path, on
one machine.

Measured external attribute reach: `manager.backends` 10, `manager.sessions`
17 across three spellings, `sm.owned_tmux_sessions` 14 across three spellings,
`sm.pending_terminal_commands` 3, `manager.idle_watchers` 1.

Two hard rules follow.

**Rule A: every slice moves the state, never a copy of it.** The collaborator
holds the one and only dict; the facade exposes it through a property. Two
objects holding one logical state and kept in sync by hand is the shape of the
bug that produced 22 rows for 21 panes. The proof obligation is an identity
assertion, not a value assertion: `manager.sessions is registry.sessions`.

**Rule B: `SessionManager()` keeps taking no required arguments.** 107 test
files construct it bare. Every collaborator is an optional keyword with a
default-constructed value, so injection is available to new tests and
invisible to old ones. A slice that changes the constructor signature is a
107-file commit and stops being independently shippable.

The busiest public methods, which are the ones a regression would be loudest
on: `record_toast` (2 src, 81 test), `get_toasts` (1, 61),
`list_attachable_sessions` (8, 25), `get_session_info` (6, 13),
`record_hook_event` (1, 27), `get_hook_token` (0, 29), `create_session`
(5, 12), `adopt_external_session` (1, 18), `respawn_session` (1, 17).

## 7. The twelve slices

**Smallest and safest first, each independently deployable, each deleting what
it replaces in the same commit.** No slice is split across a release, and a
cluster is either fully moved or not started: a half-moved decomposition is
worse than the god object, because a reader can no longer tell where a field
lives.

### S1. ProbeHealthRecorder
Moves the four probe fields plus `last_probe_health`,
`list_attachable_sessions_with_socket` and `reconcile_lifecycle`'s probe read.
About 60 lines. Constructs the existing `ProbeHealth` dataclass. Public names:
those two plus `tmux_socket_name`. Tests: `tests/test_tmux_listing.py`,
`tests/test_listing_liveness_socket_scope.py`. New:
`tests/test_probe_health_recorder.py`, including that a probe that did not run
reports `cannot_determine` and never `ok`.
Proof: `GET /sessions/list` row count equals
`tmux -L cloude list-sessions | wc -l`, same number before and after.
Risk: lowest in the file, and the warm-up that proves the facade-property
pattern before anything risky uses it. Parallel: yes.

### S2. ThemeStore
Moves `pinned_themes`, `_theme_accent_cache` and nine theme methods, about 250
lines. Public names: `get_pinned_theme`, `set_pinned_theme`,
`discard_pinned_theme`, `get_project_theme`, `set_project_theme`,
`resolve_project_theme`, `migrate_pinned_theme_to_dotfile`.
Tests: `tests/test_project_theme.py`, `tests/test_themes_endpoint.py`,
`tests/test_terminal_theme_survives_agent_renders.py`.
Proof: switch between two sessions with different pinned themes in a browser;
the theme must not bleed, which is gotcha 7 and why this cluster is worth
isolating. Risk: low. Parallel: yes.

### S3. ToastInbox
Moves both pending maps, `record_toast` (196), `ack_toast`, `auto_ack_toasts`,
`get_toasts`, `_prune_toasts`, `_find_supersedable_toast`,
`_flush_startup_toasts`. Public names: the four listed. Tests: 142 existing
call sites across `tests/test_toast_auto_ack.py` and neighbours, the
best-covered cluster in the file, which is why it moves early.
New: a test that a duplicated `Stop` acks by KIND and never acks the toast the
same event just raised, a rule currently expressed only in prose.
Proof: raise a real permission prompt in a live pane, watch the card appear
and drop on the `toast.ack` frame. Risk: low. Parallel: yes.

### S4. Log buffers and command counts
Moves `log_buffers`, `command_counts`, `get_recent_logs`, `add_log_entry` into
`SessionRegistry`'s first half. About 40 lines. Deliberately separate from S7
so the registry lands in two pieces. Tests: `tests/test_session_backend.py`.
Risk: lowest. Parallel: yes.

### S5. AttachmentSidecars
Moves `idle_watchers`, `adopt_fifo_offsets`, `pending_terminal_commands` and
their four accessors, cutting three clusters out of `_wipe_session_state`.
Public names: `idle_watcher`, `adopt_fifo_start_offset`,
`consume_adopt_fifo_offset`, `flush_pending_terminal_command`, and the
attribute `manager.idle_watchers`.
New: a test that the FIFO offset is consumed exactly ONCE, and that a restart
cannot replay a pending terminal command, the in-memory-only rule the
constructor comment states and nothing asserts.
Proof: restart the server, confirm zero `hook_post_rejected_invalid_token` in
the following ten minutes. Risk: low, but it is the first slice touching
create and adopt, so the first to need the live boot check. Parallel: yes.

### S6. OwnedTmuxLedger
Moves `owned_tmux_sessions`, the backfill flag, `_boot_listing`,
`_load_session_metadata`, `_save_session_metadata`, `_write_metadata_atomic`,
`_clear_stale_metadata`, `is_owned_tmux_name`, `owned_tmux_instances`.
Public names: `owned_tmux_instances`, `is_owned_tmux_name`, and the attribute
`manager.owned_tmux_sessions` (14 external readers).
Tests: `tests/test_boot_readopt.py`, `tests/test_boot_readopt_real_tmux.py`,
`tests/test_session_row_reuse.py`.
Mutation that must turn a test red: make `_write_metadata_atomic` skip the
`.bak`. If nothing goes red, the atomic-write rule is undefended.
Proof by measurement: after a restart, `boot_readopt_complete`'s held plus
skipped must equal the live tmux session count, AND `GET /sessions/list` must
return exactly that many rows. Both, because the log line was perfect the day
the listing returned 22 for 21.
Risk: medium. This is the first slice on the boot path.
Parallel: yes.

### S7. SessionRegistry
Moves `sessions`, `backends`, `_subscribers`, `_last_session_id`,
`_register_session`, `_make_output_handler`, `subscribe_output`,
`unsubscribe_output`, `current_session`, `current_backend`, `get_session`,
`get_backend`, `_resolve_session_id`, `_require_running`,
`_registered_ids_for_tmux_name`. Public names: all of those plus the
attributes `manager.sessions` and `manager.backends`, 27 external readers.
The load-bearing one is `_registered_ids_for_tmux_name`, which enforces ONE
PANE IS ONE REGISTRATION. It gets its own test that registering the same pane
under two ids is detectable: the 22 versus 21 defect as an assertion rather
than a paragraph.
Negative control: `manager.sessions is registry.sessions` must hold. A slice
that leaves two dicts passes every value test and is wrong.
Proof: `/sessions/list` row count equals the tmux count exactly, and a WS
terminal binds and streams bytes on a real session.
Risk: medium-high, purely from the attribute reach. Parallel: yes.

### S8. The listing assembly
Carves `_session_info_for` (413), `_build_tmux_status_map`,
`_startup_gate_for` (155), `_seed_candidate_tmux_names`,
`_listed_tmux_names_by_session` into a frozen `SessionMeasurements` dataclass
plus a pure `assemble_session_info`. This is where `TmuxReader` earns its keep.
It READS `session_status_map.py`, `session_instance_index.py` and
`pipe_wakeup.py` and rewrites none of them, which is adoom666's explicit ask.
Tests: `tests/test_listing_subprocess_cost.py`,
`tests/test_listing_pass_datastore_cost.py`,
`tests/test_listing_seed_row_cost.py`,
`tests/test_listing_liveness_socket_scope.py`,
`tests/test_session_status_seed.py`.
The ceilings that must not move: fewer than `2 * N` `has-session` calls,
`MAX_DATASTORE_OPENS_PER_LISTING = 4`, first pass captures equal to N, second
pass captures zero.
Negative control: an INCOMPLETE listing must still yield `unknown` and never
`dead`, and a listing from a different socket must not vouch. That is the one
invariant both parties named in their claims.
Risk: high. Parallel with adoom666: NO. This is his queued wave 3 territory.

### S9. The create path
`create_session` (499) becomes a pure `resolve_create_plan` plus a thin
executor, with `_cleanup_failed_create` as the plan's own rollback.
Must keep: `persist_creation` calling `resolve_project_binding` with
`allow_create=True`, and the pair rule that `(project_id,
project_attribution)` moves together or neither moves.
New: a test that a derived `(None, 'none')` writes NEITHER column, because the
half-write is what put an attribution of `none` on a row that held a good
project.
Risk: high. Parallel: NO.

### S10. HookTokenAuthority
Moves the four token maps and `_load_hook_tokens`, `_persist_hook_tokens`,
`_mint_hook_token`, `_keep_hook_token`, `_gc_hook_tokens`, `get_hook_token`,
`validate_hook_token`, `recover_hook_token`, `get_env_for_spawn`.
Mutation that must turn a test red: make `keep()` call `mint()`. If nothing
goes red, the rule that saved 4h24m is undefended.
Negative controls, both required: a bogus 40-char token must be refused, and
`recover` must refuse a token this process never minted for THAT id on THAT
pane. A recovery that accepted broadly would pass every positive test and be a
credential bypass.
Proof by measurement: restart the live server and count
`hook_post_rejected_invalid_token` over the next ten minutes. It must be zero.
The failure signature is 94 refusals in four minutes; there is no ambiguity.
Risk: highest in the file. Parallel: NO.

### S11. The adoption path
`adopt_external_session` (443), `_adopt_identity_for`, `persist_adoption`,
`destroy_external_session`, `_resolve_external_cwd`.
The invariant, structurally: an adoption RESOLVES an id through
`session_boot_readopt_plan.resolve_session_id` and the code to mint one is not
reachable from that method. A resolved id calls `keep`, a derived id calls
`mint`, and those are the only two exits.
New: a test that a re-keyed adoption issues zero mints, asserted on the
authority's own call ledger rather than on a mock's arrangement.
Risk: highest. Parallel: NO.

### S12. Collapse the facade
`_wipe_session_state` becomes a loop over collaborators and `__init__` (248
lines) becomes composition. The manager is measured under 500 lines, or the
overflow is reported to the owner rather than absorbed.

## 8. The three neighbours

**`src/api/routes.py`, 4,387 lines, is a different and much easier problem.**
61 module-level functions, 3,727 lines of them, 51 routes, ZERO instance
state. It is a router split by resource and nothing else: 31 routes under
`/sessions`, 6 `/agents`, 4 `/providers`, 2 each `/filesystem` and
`/terminal`, one each `/toasts`, `/hooks`, `/health`, `/themes`, `/shutdown`,
`/projects`. The directory already has the pattern, with eleven sibling route
modules. Four functions are over 150 lines (`claude_event_hook` 424,
`restart_session` 212, `fork_session` 194, `session_attribution_prompt` 177)
and those are decision ladders in disguise, same treatment as section 5. This
track collides with nobody and can run in parallel with S8 through S11.

**`src/core/tmux_backend.py`, 2,801 lines, is a second god object and it is
smaller.** `TmuxBackend` is 38 methods and 12 written fields, with `start`
380, `respawn` 348, `attach_existing` 238, `list_attachable_sessions` 128,
`ensure_pipe_pane` 107. It is where the never-raised guard lived. Same
treatment, later, and NOT before S8, because the listing slice changes what
the backend is asked for.

**`src/config.py`, 2,112 lines, is 14 dataclasses plus one 1,426-line
class.** The dataclasses are a free split into a `src/config/` package with no
behaviour change. `Settings` has 31 methods, four of them large
(`load_auth_config` 261, `get_agent_command` 165, `update_settings_config`
116, `get_settings_summary` 97). `update_settings_config` carries the atomic
write pattern the whole repo copies, so it moves verbatim and gets a mutation
test. `get_agent_command` must never be called with a user-supplied id, and
that rule should become a TYPE rather than a comment: a validated
`AgentChoice` value object only
`session_agent_choice.validate_agent_choice` can construct.

**Out of scope, deliberately.** `src/core/session_notification_policy.py` (563)
and `src/core/notifications/idle_watcher.py` (513) are over the guideline and
are adoom666's live mute work. `src/models.py` (2,495), `src/api/auth.py`
(1,674), `src/core/db_models.py` (1,663), `src/main.py` (1,406) and
`src/core/db_steps.py` (1,402) are real and not in this plan; the last two
carry schema version machinery and nothing here goes near a schema version.

## 9. The safety discipline

**A clean rebase and a green suite prove very little when the dangerous change
never conflicts.** That is measured, not theoretical: when the two lines merged
on 2026-09-10, only two files conflicted and both were docs, while four
expensive design collisions merged silently.

Every slice carries three separate obligations, because they catch different
things.

**(a) The mutation.** Name one edit that must turn a specific test red. If it
does not, the test is decorative and the slice is not done. The precedent is
the guard that 4,874 green tests had never observed raise. Per-slice mutations
are named in section 7.

**(b) The negative control.** Name what must NOT happen. A matcher that always
finds something is worse than useless, which this repo learned when directory
agreement was counting as one fact corroborating itself. The load-bearing
controls: for S7, one object not two, asserted with `is`; for S8, an
incomplete listing yields `unknown` and never `dead`; for S10, a bogus token
is refused and an unminted token is refused.

**(c) The live measurement.** Four instruments already exist and cost nothing
new.

1. `scripts/deploy-lib.sh` sha256s every destination file against the local
   list and reports `CANNOT DETERMINE` when no hash comes back, so "it
   deployed" is measured. A `CANNOT DETERMINE` is not a pass.
2. `boot_readopt_complete` held plus skipped against
   `tmux -L cloude list-sessions | wc -l`. Equal, or the boot pass lost
   sessions.
3. `GET /sessions/list` row count against the same tmux count. Equal, or one
   pane has two registrations. Check BOTH 2 and 3: the log line was perfect
   the day the listing returned 22 for 21.
4. `hook_post_rejected_invalid_token` in the ten minutes after a restart.
   Zero. The failure signature is unmistakable at 94 in four minutes.

**The baselines to beat, so drift is detectable.** pytest on `release/1.2.1`
is 5,708 passed, 2 known environmental failures, 19 skipped. Node is 200
suites clean. A slice reporting materially different totals has a broken venv,
not a passing suite: the baseline once read 4,647 for exactly that reason,
because a `venv` symlink pointed at a `venv.nosync` that no longer existed.
Check the symlink before trusting a number that looks wrong.
`tests/test_respawn_refreshes_pane_env.py` is measured flaky under a full run
because it drives the real `cloude` socket; a lone failure there with no code
change behind it is not a regression.

**Two rules that are not per-slice.** Nothing under `src/core/sessions/` may
import `session_manager`, and no new file exceeds 500 lines. Both enforced by
a test that greps the package, because the guideline that produced this
document should defend the code that fixes it.

## 10. Coordination with adoom666

**Slices 1 through 7 collide with nothing he has claimed. Slice 8 onward
does.**

His active claim `adoom666-webui-perf-waves` lists
`docs/webui-performance-and-session-menu-plan.md`, `scripts/perf/*`,
`tests/test_perf_*.py`, `client/js/app.js`, `client/js/terminal.js` and
`src/api/websocket.py`. None of those is in this plan. His other active claim
is the session row menu, which is client-side.

The intersection is not textual, which is the kind that costs. His queued wave
3 is "moving blocking tmux, SQLite and filesystem work off the event loop",
which lands in `_session_info_for` and `create_session`, slices 8 and 9. His
path list does not name `session_manager.py`, so a path detector would not
flag it and it would be found by fetch, twice.

Three files he asked not to have rewritten this week are read and not
rewritten by slice 8: `src/core/session_status_map.py`,
`src/core/session_instance_index.py`, `src/core/pipe_wakeup.py`.

Nothing here touches a schema version. He noted, correctly, that two parties
migrating one store on two branches is the collision conversation cannot fix
afterwards.

Behaviours on our own kept list that these slices must not remove: dead rows
go to Recent (`session_lifecycle.py`, `session_manager.py`), the manual
mark-unread control, and the strict CSP. None is at risk from a structural
change; they are named so a later slice cannot claim it did not know.

## 11. What we still owe the owner

- **Whether the facade fits under 500 lines with 68 public methods on it.** It
  probably does not. Some of those 68 are legacy views (`session`, `backend`,
  `current_backend` have zero call sites in `src/` and zero in `tests/`) and
  the surface should shrink. That is a deprecation conversation, not a
  refactor decision.
- **Whether slice 8 is ours or adoom666's.** We offered it to him in the claim. Until `now/adoom666.md` answers, slices 1 through 7 are the work.
- **Twelve slices is not one release.** The plan is designed so stopping after any slice leaves a coherent tree.
