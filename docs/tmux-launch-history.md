# The tmux launch path, the cold socket and the boot re-adopt: the record

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

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

**THE ENVIRONMENT WRITES TRAVEL TOGETHER NOW, AND THEY STILL NEVER
TRAVEL WITH THE SPAWN.** `respawn` issued one tmux process per variable;
`src/core/tmux_command_batch.py` sends them as one `;`-separated command
list, measured p50 20.99 ms to 9.38 ms for the two we inject. The batch is
still a SEPARATE, AWAITED call ahead of `respawn-pane`, which is the
distinction that matters: putting the spawn INSIDE the list would make
this ordering a property of tmux's command queue rather than of two
ordered awaits, and would swallow the spawn's own return code. Proved by
`tests/test_tmux_launch_batching_real_tmux.py`, which has the respawned
process write its own inherited value, and whose negative control was run
before it shipped - with the writes moved BEHIND the spawn the pane does
not come back empty, it comes back holding the tmux server's STALE
global values, which is the 403 storm above wearing a plausible face.

**THE LAUNCH IS SIX TMUX PROCESSES, DOWN FROM FOURTEEN, AND THE RULE FOR
WHAT MAY SHARE ONE IS COMPATIBLE FAILURE BEHAVIOUR.** Counted by tracing a
real `TmuxBackend.start()`, not estimated. Two batches: the pre-spawn
`history-limit` plus `remain-on-exit`, and the post-probe decorations
(extended keys, mouse, the two wheel bindings, terminal-features,
escape-time, `window-size manual`, aggressive-resize), which now carry
that same pre-spawn pair re-applied at their head and therefore number
ten rather than eight - see the cold-socket paragraph below. Every
command in both was already `check=False`. The three whose outcome
the caller ACTS on - `new-session`, `respawn-pane`, `pipe-pane` - stay in
processes of their own, because tmux gives no per-command control over a
list and a batch that reported only "the batch failed" would be a
downgrade. `attach_existing`'s four adopt-time options batch the same way,
behind `ensure_pipe_pane` rather than in front of it. Measured on tmux
3.6a at load average 14: the eight decorations cost **p50 206.41 ms apart
and p50 9.35 ms together**.

**TMUX ABORTS A COMMAND LIST AT ITS FIRST ERROR, WHICH IS WHY THE RUNNER
FALLS BACK.** Measured, not assumed: a list whose first command is invalid
exits 1 and the second never runs. So a naive batch turns "one option this
socket will not take" into "and every option after it was silently
skipped", which is strictly WORSE than the per-command loop it replaces.
`run_optional_batch` re-runs the commands individually on any non-zero
exit - every one of them is idempotent, so that restores exactly the
pre-batch behaviour, and it is also the only thing that can name WHICH
command failed, since tmux's stderr carries the error text but not its
position in the list. It costs nothing in steady state. A token that IS
`;` or ENDS in one is REFUSED rather than batched, because it would split
the list somewhere the caller did not intend; a semicolon in the MIDDLE
of a token is fine, which the wheel bindings depend on.

**AND `set-option` DOES NOT START A TMUX SERVER ON tmux 3.6a, WHICH THE
COMMENT IN `start()` USED TO CLAIM.** Measured on a cold throwaway
socket: both pre-spawn `set-option` calls exit 1 with "error connecting",
batched or separate, and after `new-session` the socket reports
`history-limit 2000` (tmux's default, not our 50000) and
`remain-on-exit off`. It was silent because both calls pass `check=False`,
and it reaches the FIRST session created after a reboot, after a tmux
server restart, or any time the socket's last session closes and the
server exits under `exit-empty`. The pre-spawn pair still runs and still
must: it is the ONLY thing that can make a pane be BORN at
`HISTORY_LIMIT`, and on a warm socket - every session after the first - it
lands.

**THE TWO OPTIONS ARE RE-APPLIED AT THE HEAD OF THE POST-PROBE DECORATION
BATCH, WHICH FIXES THE SOCKET AND CANNOT FIX THE FIRST PANE.** Measured
through a real `TmuxBackend.start()` on a cold socket, before and after:
the socket's global `history-limit` **2000 to 50000** and its global
`remain-on-exit` **off to on**. It costs no extra tmux process, because
that batch is issued either way, and both commands are pure assignments of
a constant, so they are idempotent and safe under the runner's
individual-rerun fallback.

**THE RE-APPLICATION CANNOT REACH THE FIRST PANE, BECAUSE A PANE'S DEPTH
IS FIXED INTO ITS GRID AT CREATION.** Measured three ways on tmux 3.6a, a
pane born under the stock limit still reports `#{history_limit} 2000`
after a global `set-option`, after a session-scoped one, and after
`respawn-pane -k`. So the re-application fixes the socket for every LATER
session and cannot hand the first one its 48000 missing lines.
`tests/test_cold_socket_options_real_tmux.py` pins that as a measured
fact. What the first session always DID keep is its corpse: the
belt-and-braces `set-option -t <session> remain-on-exit on` after
`new-session` resolves to that session's WINDOW, so the dead-on-arrival
probe always had a pane to read - the GLOBAL window table was the half
that was wrong.

**SO THE FIRST PANE IS NOW BORN AT THE FULL DEPTH, FROM A `-f` CONFIG THE
SERVER READS BEFORE IT MAKES THE PANE.** tmux reads a `-f` file when it
STARTS THE SERVER, which on a cold socket happens inside the
`new-session` invocation itself and strictly before the session is
created. That is the only window there is. Measured through a real
`TmuxBackend.start()` on a cold socket, the first pane's own
`#{history_limit}` goes **2000 to 50000**.
`src/core/tmux_server_config.py` renders and atomically writes it,
`TmuxBackend._server_config_argv` places it, and
`tests/test_cold_socket_born_at_depth_real_tmux.py` measures the PANE
rather than the option table, because #87 already proved those two can
disagree.

**IT COSTS ZERO EXTRA TMUX PROCESSES, WHICH IS THE WHOLE REASON IT WON.**
`-f` is two more argv elements on a call that was being made anyway.
Counted at base and at head: a COLD launch spends **8 at both**, a warm
one **6 at both**. Cold is two above the six quoted higher up because the
pre-spawn batch cannot reach a server that is not running, so
`run_optional_batch` re-runs its two commands individually - #87's
fallback, not this. The spawn is still its own invocation and still
carries its own return code; nothing is batched into it, and the env
injection ordering is untouched.

**EVERY FAILURE PATH DEGRADES TO THE PRE-FIX LAUNCH, AND tmux's OWN
BEHAVIOUR WAS MEASURED RATHER THAN ASSUMED.** A missing `-f` file, an
unreadable one (mode 000) and a MALFORMED one all give `rc=0` and a
working session; on a warm socket `-f` is ignored outright. The malformed
case is the one to know: tmux DISCARDS THE WHOLE CONFIG SILENTLY, so a
valid line placed before the bad one does not apply either and nothing is
printed. That is why `render_config` refuses a token it cannot express
instead of quoting it hopefully, and why the test measures the pane
afterwards. If the file cannot be written at all, `_server_config_argv`
returns `[]` and the launch is byte-identical to what it was: losing
scrollback depth is survivable, refusing a session is not.

**THE FILE IS RE-DERIVED ON EVERY LAUNCH, SO A STALE ONE IS IMPOSSIBLE.**
It lives at `<state_dir>/cloude-tmux.conf` and its body is rendered from
the same argv fragments the pre-spawn and post-spawn batches send, so all
three places that state these two options read one definition. Nothing
migrates it on upgrade and nothing cleans it up; the next launch
overwrites it with what the running build believes.

**AND `-f` REPLACES tmux's OWN DEFAULT CONFIG LOAD, WHICH IS DESIRED AND
IS ALSO A REAL CHANGE.** Per tmux(1), given a config on the command line
tmux does not read `/etc/tmux.conf` or `~/.tmux.conf`. This file already
states the intent - CloudeCode carries its own explicit tmux settings and
deliberately does not source a personal config, because one references
plugins that do not exist on another machine - so until now a COLD
CloudeCode socket was quietly doing the opposite. Measured on the
developer's box: none of the three default paths exists, so nothing there
was being inherited and nothing is lost. On a box that HAS one, that
config stops reaching our socket.

**THE REJECTED ALTERNATIVE, KEPT SO IT IS NOT RE-PROPOSED.**
`start-server` ALONE does not work - the batch exits 0 and the server,
having no sessions, is gone before the next tmux process connects. Adding
`set-option -s exit-empty off` to that list DOES work, measured, and
leaves a tmux server with zero sessions alive on our socket for the life
of the box. Adam rejected that on 2026-09-10 for exactly that reason.

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
