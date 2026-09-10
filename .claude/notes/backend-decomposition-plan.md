# Backend decomposition plan, v2

Rewritten 2026-09-10 on `docs/backend-plan-v2` off `release/1.2.1`. Version 1 of
this document is on `feat/backend-decomposition` and five slices shipped from
it. Everything below was re-measured on `release/1.2.1` and on that branch
today, not recalled. Coordination: GitHub issue #12, draft PR #19, repo
`Adoom666/CloudeCodeDev`.

**Why there is a v2.** The owner's direction, verbatim: "what are we doing with
the monoliths. I think this project now has feet and should be first class
python", and earlier "i want full top end code with proper classes and all.
first class." Version 1 was designed to be safe. It is safe, and it is capped.
This version raises the ceiling and says what that costs.

## 1. What v1 got right, and the one thing that capped it

**The extractions are sound, the tests are real, and the file barely moved.**
Five slices shipped: S1 `4e911b6` ProbeHealthRecorder, S2 `c170eb6` theme
cluster, S3 `bb7abb0` toast inbox, S4 `09284df` SessionRegistry first half,
S5 `209947d` AttachmentSidecars. They added 2,433 lines of new collaborator and
test code that did not exist before, all of it green.

`src/core/session_manager.py` went 8,340 to 8,239. Net 101 lines over five
slices. Per slice, measured with `git show --numstat`:

| Slice | Added to the file | Removed | Net |
|---|---|---|---|
| S1 probe health | 53 | 76 | -23 |
| S2 themes | 211 | 321 | -110 |
| S3 toasts | 103 | 198 | -95 |
| S4 registry half | 80 | 25 | **+55** |
| S5 sidecars | 100 | 28 | **+72** |

Two of the last three slices GREW the file. That is not execution drift, it is
the design working as specified. The cause, measured on the branch head with an
AST walk: the class now carries **23 pure forwarding members costing 291 lines**,
an average of 12.7 lines to forward one call. Method count went 136 to 146.
Public surface went 68 to 76. **Extraction made the god object bigger in every
dimension a reader cares about.**

Three v1 rules combine to guarantee that:

- the facade keeps every public name resolving, permanently;
- `SessionManager()` keeps taking no required arguments, permanently, because
  102 bare constructions across 46 test files depend on it;
- every function carries a full docstring with description, typed inputs and
  typed output.

A 20-line body moves out. A 12.7-line documented forwarder stays. Do that
seven more times and the forwarding block alone is roughly 600 lines, which is
the entire budget for the target facade before one real method is written.

**So the constraint to change is the facade, not the pace.**

## 2. The measurement, all nine files, on `release/1.2.1`

**They are five different problems wearing one symptom, and the treatments do
not transfer.** Sizes re-measured today with `wc -l`; structure with `ast`.

| File | Lines | What it actually is | Treatment |
|---|---|---|---|
| `src/core/session_manager.py` | 8,340 | **God object.** One class of 8,055, 136 methods, 68 public, 36 written fields, 3 module functions | Collaborators, composition root, facade deleted |
| `src/api/routes.py` | 4,387 | **Route table.** 61 module functions, ZERO classes, zero instance state, 51 routes | Split by resource; lift 4 ladders out |
| `src/core/tmux_backend.py` | 2,801 | **Driver.** One class of 2,538 on a legitimate ABC, 38 methods, 12 fields | Split by concern behind the same ABC. COLLIDES with issue #5 |
| `src/models.py` | 2,496 | **Schema, not behaviour.** 75 pydantic classes, 2 functions, no methods worth the name | Package split by domain. Cheapest win here |
| `src/config.py` | 2,113 | **Settings blob.** 14 dataclasses plus one `Settings` of 1,426 | Dataclasses to a package; `Settings` to loader plus typed readers |
| `src/api/auth.py` | 1,675 | **Route table again.** 33 module functions, one 3-line model | Same as routes.py |
| `src/core/db_models.py` | 1,664 | **Append-only DDL ledger.** Zero classes, zero functions, pure data by its own docstring | LEAVE IT. See below |
| `src/main.py` | 1,407 | **Boot script.** `lifespan` alone is 547 lines and constructs 15 services onto `app.state` | Becomes the composition root, as a side effect of section 3 |
| `src/core/db_steps.py` | 1,403 | **Append-only migration ledger.** 34 step functions, additive by rule | Package split by version range, mechanical, nothing touches a version |

Also over the guideline and deliberately not ours:
`src/core/session_notification_policy.py` 564 and
`src/core/notifications/idle_watcher.py` 514, both adoom666's live mute work.

**`db_models.py` and `db_steps.py` are the two that look like the problem and
are not.** Both are append-only by an invariant the repo enforces: no step may
drop, rename or retype anything. A file that may only ever grow is a LEDGER,
and splitting a ledger to hit a line count fights its own reason for existing.
`db_steps.py` splits by version range because the boundaries are already there;
`db_models.py` does not, because the version constant and the table names must
stay in one importable place and the rest is 1,600 lines of DDL text. Filing
that under "monolith" would be a line count driving a decision instead of a
design.

**`models.py` is the opposite: 75 pydantic classes with no behaviour is a
directory that was never made.** It is the lowest-risk change in this entire
document and it is worth doing early purely for morale and to prove the
package-split machinery.

## 3. The target, stated as a design and not as a file list

**A composition root builds the collaborators and hands each one to whoever
needs it. Nothing assembles itself, and nothing reaches through a manager to
get at something else.**

The measurement that makes this possible is the asymmetry between the two
sides of the call graph:

| | Constructions | Call sites | Distinct names |
|---|---|---|---|
| `src/` | **1** (`src/main.py:290`) | 37 `app.state.session_manager` lookups, 29 of them in `routes.py` | 89 |
| `tests/` | 102 bare, 46 files | 993 attribute accesses | 96 |

One construction site in the whole application. The manager is already reached
through `app.state`, which is a service locator with 15 untyped entries on it.
That is not a god object problem, that is a container waiting to be named.

### 3.1 The composition root

`src/core/composition.py` holds `AppServices`, a frozen dataclass of the
collaborators, and `build_services(...)` which constructs them in dependency
order and returns it. `lifespan` calls it and puts the result at
`app.state.services`. `build_services` takes every port as a keyword with a
production default, so a test overrides one and gets the other eleven real.

That single function is the test fixture, the boot path and the documentation
of what this application is made of, and there is exactly one of it.

### 3.2 Ports, at the four genuine substitution points

`src/core/sessions/ports.py`, `typing.Protocol`, structural, so a double
satisfies it by shape with no base class and no mock framework. The repo
already uses `Protocol` in five modules.

- `TmuxReader`: `list_sessions`, `capture_pane`, `pane_status_all`,
  `is_alive`. The READ side only. The write side stays on `SessionBackend`,
  which is a genuine is-a with a stable base and remains the one legitimate ABC
  in this design.
- `SessionRecordStore`: `get_instance`, `claim_instance`, the `record_*`
  writers. The 26 methods that touch tmux AND sqlite become testable without a
  real socket and a real file.
- `Clock`: `now()`, `monotonic()`. Every timing rule in CLAUDE.md
  (`STARTUP_HOOK_GRACE_SECONDS = 20`, `WORKING_HEARTBEAT_TIMEOUT_SECONDS`,
  `PERMISSION_TAIL_GRACE_SECONDS`) is currently untestable without sleeping.
- `SettingsReader`: the handful of `Settings` values a collaborator actually
  needs. **This one is not a convenience, it is a near-miss fix.** S2 nearly
  wrote to the owner's real `~/.cloude-sessions` during pytest because the
  theme collaborator reached for the module-level `settings` singleton, which
  15 modules under `src/core/` import today. A collaborator that reads its
  configuration through a constructor argument cannot do that.

**The danger a port introduces, said out loud.** A double agrees with whatever
it was built to agree with. Every port gets a conformance test that runs the
REAL implementation against the same assertions as the double, and a slice
whose only evidence is a double is not proven. This repo paid for that twice:
`tests/test_boot_readopt.py` is hermetic and its `FakeBackend` had no guard to
fail, and `tests/test_respawn_refreshes_pane_env.py` exists because a mock
asserting two calls in order only tests its own arrangement.

### 3.3 Dependency direction, and what may never import what

```
src/core/sessions/ports.py        imports nothing from this project
src/core/sessions/*.py            may import ports and the pure ladders
src/core/composition.py           imports everything under core
src/main.py, tests/conftest.py    import composition
src/api/*.py                      imports the TYPE of AppServices, nothing else from core
```

Three rules, all enforced by the existing `tests/test_sessions_package_rules.py`
rather than by memory:

1. Nothing under `src/core/sessions/` may import `session_manager`.
2. Nothing under `src/core/sessions/` may import the module-level `settings`
   singleton. It takes a `SettingsReader`. This is the S2 rule.
3. No new file over 500 lines.

### 3.4 Packages

`src/core/sessions/` (exists), `src/models/` (new, by domain),
`src/config/` (new: the dataclasses, then `Settings` as a loader plus typed
readers), `src/api/routes/` (new, by resource), `src/core/schema/steps/`
(new, by version range).

Composition over inheritance throughout. `SessionBackend` stays the one ABC
because tmux and PTY are a real is-a over a stable base. Everything else is a
plain class with typed attributes, constructed and handed in.

## 4. The facade verdict

**It becomes a deprecated shim with a delete date, and it is deleted a cluster
at a time by the slice that extracts the cluster. Not at the end, and never in
one heroic commit.**

The v1 rule was: the facade is permanent, so a slice ADDS forwarders. The v2
rule inverts it.

> **Rule B, v2.** A slice is not done until nothing outside the collaborator's
> own module and its own tests calls the manager for that cluster. The slice
> DELETES the forwarders it would otherwise have written. A slice that leaves a
> forwarder behind has not finished; it has moved the code and kept the weight.

That makes every slice a net reduction by construction, because the file loses
the moved body AND the members that used to reach it, instead of losing the
body and gaining a documented forwarder.

### 4.1 What it costs, measured rather than feared

The 102 bare constructions and 993 accesses sound like the cost. They are not,
because both are concentrated. Measured today, counting only accesses through a
variable named `manager`, `sm`, `session_manager` or `mgr`:

| Cluster | Test files to migrate | `src/` call sites |
|---|---|---|
| Probe health (shipped S1) | 3 | 3 |
| Themes (shipped S2) | 4 | 0 |
| Toasts (shipped S3) | 13 | 5 |
| Log buffers, command counts (shipped S4) | 0 | 0 |
| Sidecars (shipped S5) | 2 | 0 |
| Owned tmux ledger | 9 | 2 |
| Hook token authority | 12 | 0 |
| Registry attributes (`sessions`, `backends`) | 31, but 41 hits | 6 |

**Retro-fitting all five shipped slices is 22 test files.** Not 46, not 107.

The 102 bare `SessionManager()` constructions mostly do not need a builder at
all: a test that exercises only the toast cluster stops constructing a manager
and constructs a `ToastInbox`, which is a REDUCTION in setup, not an addition.
The tests that genuinely need a whole application get one `conftest.py` fixture
wrapping `build_services(...)`. The builder is written once.

### 4.2 What could go wrong, and the net under it

- **A moved dict fails at runtime, in one path, on one machine.** Python has no
  compile step. Mitigation is Rule A, unchanged from v1 and now with three
  scars on it: **every slice moves the state, never a copy.** The proof
  obligation is an identity assertion. Note that `is` ALONE has now failed to
  catch a real mutation three times in this project, so several no-copy legs
  are chosen for the DATA: mutate through one reference, read through the
  other, assert the mutation is visible. If a mutation comes back green, the
  TEST is wrong.
- **A test patches `session_manager.<name>` and the name is gone.** Mechanical
  and silent: `mock.patch` on a missing attribute raises, `patch.object` with
  `create=True` does not. After moving any read, grep the suite for patches
  aimed at the old name and repoint them. This is a per-slice checklist item,
  not a hope.
- **The retro-fit slice touches 22 files at once.** It is the largest single
  commit in this plan and it lands second, on purpose, while the 5,856-test net
  is fresh and before anything risky is built on top of it.
- **The facade shrinks to a size nobody wants to finish.** Guarded by the
  stopping condition in section 7 and by the delete date: the shim carries a
  literal `DELETE AFTER` line naming the slice that removes it.

**The delete date.** The `SessionManager` name and module survive as a shim
only until S9. After S9 there is no `SessionManager` class, `lifespan` builds
`AppServices`, and `src/core/session_manager.py` is deleted, not emptied.

## 5. The docstring rule

**Forwarding stops existing, and while it briefly exists it gets a one-line
docstring under a written exemption. Both halves, because the transition is
real and an implicit exemption is how a rule erodes.**

The full rule (description, typed inputs, typed output, example when
non-obvious) is right and stays. Applied to a one-line forward it produced a
measured 12.7 lines per member, which is what inverted the line count.

The ruling, to be written into CLAUDE.md verbatim in the S0 commit:

> **A pure forwarder is exempt from the full docstring rule.** A member whose
> entire body is `return self._collaborator.method(...)` has no behaviour of
> its own to document. Restating the collaborator's contract creates a SECOND
> copy of it that can go stale, and a confidently wrong doc sends the next
> agent to write a bug. Such a member carries one line naming its replacement
> and its delete date, and nothing else. The exemption applies ONLY to a member
> marked deprecated with a delete date, so it cannot be stretched to cover a
> thin method that does anything at all: one argument reshaped, one default
> filled in, one error translated, and the full rule applies again.

Types still belong in the signature, on the forwarder as on everything else.
The signature is what tooling verifies; the docstring is prose.

## 6. The slices

**Nine, ordered by how loud a failure would be, not by how tight the cluster
is. Every one independently shippable, full suite green, deleting what it
replaces in the same commit, no dual path.** Two v1 slices have left this lane
entirely; see section 8.

### S0. The composition root, the ports, and the fixture
No behaviour moves. `src/core/composition.py` with `AppServices` and
`build_services`, `src/core/sessions/ports.py` with the four Protocols, the
`conftest.py` builder fixture, the CLAUDE.md docstring ruling, and the two new
package rules wired into `tests/test_sessions_package_rules.py`.
`lifespan` calls `build_services` and keeps `app.state.session_manager` beside
`app.state.services` so nothing breaks yet.
**Why first:** every later slice needs somewhere to inject a collaborator FROM.
Without it, a caller migrated off the manager has nowhere to get the
collaborator except a module global, which is the S2 near-miss rebuilt.
**Mutation:** delete a port from `AppServices` and the conformance test must go
red, not the type checker alone.
**Risk:** none, nothing moves. **Parallel with adoom666:** yes.

### S1. Retro-fit the five shipped slices
Migrate the 22 test files and the 8 `src/` call sites onto the five existing
collaborators, then DELETE all 23 forwarders and 291 lines from the manager.
**Why second:** it is the only slice that PROVES the new rule pays, and it is
measurable before anything new is extracted. If the file does not drop by
roughly 291 lines plus the migrated readers, the v2 premise is wrong and we
stop and say so rather than building eight more slices on it.
**Negative control:** grep the suite for `patch(` aimed at any of the 23
deleted names. Zero remaining, or a test is patching a ghost.
**Risk:** low per file, medium in volume. **Parallel:** yes.

### S2. `src/models.py` into `src/models/`
75 pydantic classes into a package by domain, `__init__` re-exporting every
public name so no importer changes in the same commit. Pure filing, zero
behaviour, and it proves the package machinery on the safest file in the tree.
**Trap:** `SessionInfo` (242 lines) puts fields on TWO levels and that is the
single most repeated bug in this project. The split must not silently flatten
it. **Risk:** lowest of all nine. **Parallel:** yes.

### S3. OwnedTmuxLedger
`owned_tmux_sessions`, the legacy backfill flag, `_boot_listing`, the metadata
load, save and atomic write, `_clear_stale_metadata`, `is_owned_tmux_name`,
`owned_tmux_instances`. 9 test files, 2 `src/` call sites.
**Mutation:** make the atomic write skip the `.bak`. If nothing goes red, the
rule that protects the user's whole setup is undefended.
**Live proof:** after a restart, `boot_readopt_complete` held plus skipped
equals `tmux -L cloude list-sessions | wc -l`, AND `GET /sessions/list` returns
exactly that many rows. Both, because the log line was perfect the day the
listing returned 22 rows for 21 panes. **Risk:** medium, first slice on the
boot path. **Parallel:** yes.

### S4. SessionRegistry, the second half
`sessions`, `backends`, `_subscribers`, `_last_session_id`, the registration
and lookup methods, and `_registered_ids_for_tmux_name`, which is what enforces
ONE PANE IS ONE REGISTRATION. 31 test files touch these attributes but only 41
times, so it is wide and shallow.
**Negative control:** registering one pane under two ids must be DETECTABLE by
an assertion, which is the 22-versus-21 defect turned from a paragraph into a
test. **Risk:** medium-high, purely from reach. **Parallel:** yes.

### S5. `src/config.py` into `src/config/`
The 14 dataclasses to modules; `Settings` splits into a loader and typed
readers. `update_settings_config` carries the atomic write pattern the whole
repo copies, so it moves verbatim and gets its own mutation test.
`get_agent_command` must never be called with a user-supplied id, and that
becomes a TYPE rather than a comment: a validated `AgentChoice` value object
that only `session_agent_choice.validate_agent_choice` can construct.
**Risk:** medium. Config writes are how a user loses their setup.
**Parallel:** yes.

### S6. `src/api/routes.py` and `src/api/auth.py` into route packages
Split by resource into the eleven-sibling pattern the directory already has:
31 routes under `/sessions`, 6 `/agents`, 4 `/providers`, 2 each `/filesystem`
and `/terminal`, one each for the rest. The four large functions
(`claude_event_hook` 424, `restart_session` 212, `fork_session` 194,
`session_attribution_prompt` 177) are decision ladders in disguise and their
decision halves become pure modules.
Each moved route swaps `app.state.session_manager` for the ONE collaborator it
needs off `app.state.services`, which is where the 29 lookups in `routes.py`
go to die. **Risk:** medium, and loud: a broken route is a 500 on the first
click. **Parallel:** yes.

### S7. HookTokenAuthority
The four token maps and `_load`, `_persist`, `_mint`, `_keep`, `_gc`,
`get_hook_token`, `validate_hook_token`, `recover_hook_token`,
`get_env_for_spawn`. 12 test files, 103 hits, zero `src/` reach.
The invariant becomes structural: `mint(session_id, tmux_name)` is the ONLY
writer of a secret, `keep(...)` re-binds a name and cannot reach the secret,
`recover(...)` reads the superseded ring and never mints.
**Mutation:** make `keep()` call `mint()`. If nothing goes red, the rule that
saved 4h24m of dead hooks is undefended.
**Negative controls, both required:** a bogus 40-char token is refused, and
`recover` refuses a token this process never minted for THAT id on THAT pane.
A recovery that accepted broadly would pass every positive test and be a
credential bypass.
**Live proof:** restart the live server, count
`hook_post_rejected_invalid_token` over ten minutes. Zero. The failure
signature is unmistakable at 94 refusals in four minutes.
**Risk:** highest in the file. **Parallel with adoom666:** yes, he has nothing
near it. **Parallel with our own slices:** no, it lands alone.

### S8. The adoption and create paths
`adopt_external_session` (443), `_adopt_identity_for`, `persist_adoption`,
`destroy_external_session`, `_resolve_external_cwd`, then `create_session`
(499) as a pure `resolve_create_plan` plus a thin executor with
`_cleanup_failed_create` as the plan's own rollback.
An adoption RESOLVES an id and the code to mint one is not reachable from that
method. A resolved id calls `keep`, a derived id calls `mint`, and those are
the only two exits.
**New test:** a derived `(None, 'none')` project binding writes NEITHER column,
because the half-write is what put an attribution of `none` on a row holding a
perfectly good project.
**Risk:** highest. **Parallel:** no. **Blocked on:** issue #28, see section 8.

### S9. Delete the shim
`_wipe_session_state` (54 lines, touching nine clusters) becomes a loop.
`__init__` (248 lines) is gone, because `build_services` is the constructor
now. `src/core/session_manager.py` is DELETED, not emptied. Any name still
resolving through it at this point is a slice that did not finish, and the
commit that finds one fixes it rather than granting an extension.

## 7. The stopping condition

**Per file, in numbers, so this cannot drift.** "Done" is not "feels better".

| File | Now | Done at | Test |
|---|---|---|---|
| `src/core/session_manager.py` | 8,340 | **0. The file does not exist** | import fails |
| Any file under `src/core/sessions/` | n/a | **under 500 each** | package rules test |
| `src/api/routes.py` | 4,387 | **under 500**, rest in `src/api/routes/` | package rules test |
| `src/models.py` | 2,496 | **under 200**, a re-export shim only | package rules test |
| `src/config.py` | 2,113 | **under 300**, rest in `src/config/` | package rules test |
| `src/api/auth.py` | 1,675 | **under 500** | package rules test |
| `src/main.py` | 1,407 | **under 400**, `lifespan` under 80 | package rules test |
| `src/core/tmux_backend.py` | 2,801 | **under 800** and NOT ours yet, see section 8 | |
| `src/core/db_models.py` | 1,664 | **unchanged, deliberately** | |
| `src/core/db_steps.py` | 1,403 | **under 300** plus `src/core/schema/steps/` | |

Two global conditions, both machine-checked:

- **Zero pure forwarders anywhere in `src/`.** A member whose whole body
  forwards to a collaborator is a failed migration, and after S9 there is
  nothing to forward to.
- **`app.state.session_manager` has zero readers.** Every route reaches the
  one collaborator it needs.

And one that is not a line count: **`build_services` is the only place in
`src/` that constructs a collaborator.** If a second construction site appears,
the composition root has been bypassed and the design is already leaking.

## 8. Coordination, and what is genuinely blocked

**Checked against live GitHub state today: 53 open issues, 4 open pull requests
and all four are ours. Nothing is formally taken by adoom666 under the draft-PR
protocol.** Ours are #19 (this work), #18, #22, #23. Per `docs/DECISIONS.md`,
work is claimed by draft PR and not by assignee, and any agent may pick up any
free issue, so "free" is real and so is the risk that he takes one tomorrow.

Three free issues land directly in files this plan restructures. They are his
work by subject even though no PR holds them, and planning through them is
exactly the silent-stale-port failure the protocol exists to prevent.

- **#32, "one bulk row read per listing pass, inside one deferred read
  transaction"** names `src/core/session_manager.py` and `_session_info_for`
  explicitly. That is v1's slice S8, the listing assembly. **REMOVED from this
  plan.** It is his wave 3. Our ports make it easier and we do not do it.
- **#28, "batch the compatible tmux launch commands, without touching env
  injection ordering"** is the tmux launch sequence, which is `create_session`
  and `TmuxBackend.start`. S8 above touches `create_session`, so **S8 waits
  until #28 has landed or been declared not being taken.** Env injection
  ordering is load-bearing: `set-environment` before `respawn-pane` is the
  whole claim of `tests/test_respawn_refreshes_pane_env.py`.
- **#5, p0, "the pipe rotation never re-points the read fd"** names
  `src/core/tmux_backend.py` `_maybe_rotate`, the tail loop, and
  `pipe_wakeup.py`. That is the heart of v1's tmux_backend split. **The
  tmux_backend decomposition is REMOVED from this plan** and re-filed as its
  own issue after #5 ships. A p0 fix has right of way over a refactor, always.

Not colliding: #30 (file tree, `config_files_routes.py`), #31 (a NEW
`work_admission.py`), #6 (docs).

Unchanged from v1 and still binding: `src/core/session_status_map.py`,
`src/core/session_instance_index.py` and `src/core/pipe_wakeup.py` are READ and
never rewritten. `src/core/session_notification_policy.py` and
`src/core/notifications/idle_watcher.py` stay his even though both exceed the
500-line guideline. **No schema version moves anywhere in this plan.** Two
parties migrating one store on two branches is the collision that conversation
cannot fix afterwards, which is also why `db_steps.py` splits by version range
without touching a version number.

Kept behaviours this plan must not quietly remove: dead rows go to Recent, the
manual mark-unread control, the strict CSP with no third-party origin. Named
here so a later slice cannot claim it did not know.

## 9. The safety discipline, carried forward

**A clean rebase and a green suite prove very little when the dangerous change
never conflicts.** Measured, not theoretical: when the two lines merged on
2026-09-10, only two files conflicted and both were docs, while four expensive
design collisions merged silently.

Every slice carries four obligations, because they catch different things.

**(a) The mutation.** Name one edit that must turn a specific test red. If it
does not, the test is decorative and the slice is not done. The precedent is
the guard that 4,874 green tests had never observed raise, and that failed 20
of 20 owned sessions on its first real boot.

**(b) The negative control.** Name what must NOT happen. A matcher that always
finds something is worse than useless. The load-bearing ones: for S4, one
object and not two, proved by mutating through one reference and reading
through the other; for S7, a bogus token refused and an unminted token refused.

**(c) The patch sweep.** After moving any read, grep the suite for `patch(`
and `patch.object(` aimed at the old name and repoint them. `patch.object` with
`create=True` will happily patch a name that no longer exists and the test goes
green over nothing.

**(d) The live measurement.** Four instruments exist and cost nothing new.
`scripts/deploy-lib.sh` sha256s every destination file and a `CANNOT DETERMINE`
is not a pass. `boot_readopt_complete` held plus skipped against the live tmux
count. `GET /sessions/list` row count against the same count, checked
SEPARATELY, because the log line was perfect the day the listing returned 22
for 21. And `hook_post_rejected_invalid_token` at zero for ten minutes after a
restart.

**Baselines, so drift is detectable.** pytest on `release/1.2.1` is 5,708
passed, 2 known environmental failures, 19 skipped; the branch net is 5,856.
Node is 200 suites with one pre-existing failure. A slice reporting materially
different totals has a broken venv, not a passing suite: the baseline once read
4,647 for exactly that reason, because a `venv` symlink pointed at a
`venv.nosync` that no longer existed. `tests/test_respawn_refreshes_pane_env.py`
is measured flaky under a full run because it drives the real `cloude` socket;
a lone failure there with no code change behind it is not a regression.

**One rule that is not per-slice, and it is the S2 lesson:** a collaborator
must not import the module-level `settings` singleton. It takes a
`SettingsReader`. Fifteen modules under `src/core/` import that singleton today
and one of them nearly wrote to the owner's real `~/.cloude-sessions` during a
pytest run.

## 10. What we still owe the owner

- **Nine slices is not one release.** The plan is designed so stopping after
  any slice leaves a coherent tree with no dual path, but S9 is the only point
  at which the headline number reaches zero.
- **S1 is the go/no-go.** If retro-fitting the five shipped slices does not
  drop `session_manager.py` by roughly 291 lines plus the migrated readers, the
  premise of this document is wrong and the honest move is to say so and revert
  to v1's permanent facade, not to write eight more slices on a bad assumption.
- **The tmux_backend split and the listing assembly are out of our lane** until
  issues #5 and #32 resolve. That is two of v1's twelve slices gone, and it is
  the right answer rather than a shortfall.
- **`db_models.py` stays 1,664 lines on purpose.** If the owner wants that
  number down anyway, it is a conversation about the append-only invariant and
  not a refactor decision.
