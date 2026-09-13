# How we work here, the test baseline, the archive ingester, the integrity check, secret scanning and install refresh: the record

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

## How we work here

- **Every function documented**: one-line description, typed inputs, typed
  output, and an example when the usage is not obvious. Types belong in the
  Python signature, not only in the docstring.
- **A pure forwarder is exempt from the full docstring rule.** A member whose
  entire body is `return self._collaborator.method(...)` has no behaviour of
  its own to document. Restating the collaborator's contract creates a SECOND
  copy of it that can go stale, and a confidently wrong doc sends the next
  agent to write a bug. Such a member carries one line naming its replacement
  and its delete date, and nothing else. The exemption applies ONLY to a member
  marked deprecated with a delete date, so it cannot be stretched to cover a
  thin method that does anything at all: one argument reshaped, one default
  filled in, one error translated, and the full rule applies again. Types still
  belong in the signature, on the forwarder as on everything else. The
  measurement behind this: the first five decomposition slices left 23 pure
  forwarders costing 291 lines, an average of 12.7 lines to forward one call,
  which is why two of those three slices GREW the file they were shrinking.
- **DRY, single source of truth, named constants.** No magic strings. A literal
  like the hook marker or the socket name lives in exactly one module and gets
  imported.
- **New logic goes in new focused modules.** These files are already past the
  500-line guideline and should not grow: `client/js/terminal.js`,
  `client/js/app.js`, `client/css/styles.css`,
  `src/core/session_manager.py`. Edit them when the change
  belongs there; do not use them as the default landing spot.
  `src/api/routes.py` CAME OFF THIS LIST: decomposition slice S6 took it from
  4,397 lines to 106 across 29 siblings, so it is an aggregator now and adding
  a router line to it is the correct move rather than a thing to avoid.
- **`src/config/` is a package**, not a module: one typed block of `config.json`
  per file, `settings.py` holding only the env-backed fields and the two caches,
  and the behaviour in named siblings (`auth_loader`, `state_paths`,
  `agent_command`, `config_file`, `config_writes`, `summary`, `wrappers`,
  `provider_models`). `__init__.py` re-exports every public name the flat module
  had, so `from src.config import settings` is unchanged.
  **`settings.py` IS OVER THE 500-LINE GUIDELINE AND THE OWNER HAS RULED
  THAT IT STAYS THERE.** His words, 2026-09-10, on being shown the one open
  question S5 left: "Leave it it's ok". This is a RULING, recorded in
  `docs/DECISIONS.md` under "`src/config/settings.py` stays over 500 lines", and
  it binds both sides: do not "fix" this file to hit a line count. The class
  keeps 31 public names because 111 modules import from this package and the
  suite patches those members on the CLASS (23 sites patch `state_dir_override`,
  eight patch `type(sm.settings).get_state_dir`); a name that stopped resolving
  there would be invisible to every one of them. The bodies are all gone - what
  remains is 109 lines of pre-existing field declarations and 31 typed entry
  points averaging 13 lines. Getting under 500 needs the entry points DELETED
  and their ~45 callers migrated, which is Rule B applied to `Settings`. That is
  its own slice, it is filed as a FUTURE OPTIONAL slice in
  `.claude/notes/backend-decomposition-plan.md` and in `.claude/TODO.md`, and it
  is NOT SCHEDULED. (It was 632 lines when the ruling was made; re-measured
  2026-09-12 at `b5de919` it is **620**. The ruling is about the file, not
  about the number, and the number drifts - measure it rather than quoting
  either figure.)
- **`src/core/sessions/` holds the collaborators `SessionManager` composes**, one
  mutable state cluster each, per
  `.claude/notes/backend-decomposition-plan.md`. THE STATE MOVES, IT NEVER
  COPIES: a collaborator holds the one and only copy of its cluster and the
  facade keeps none, because two objects holding one logical state and kept in
  sync by hand is the shape of the bug that produced 22 `/sessions/list` rows
  for 21 live panes. `SessionManager()` still takes NO required arguments (104
  test files construct it bare); a collaborator is an optional KEYWORD-ONLY
  argument with a default-constructed value, so injection is available to a new
  test and invisible to every old one. Two rules hold for every module in the
  package and both are enforced by `tests/test_sessions_package_rules.py`
  rather than remembered: nothing in there may import `session_manager`, and no
  file exceeds 500 lines. `ProbeHealthRecorder` (slice S1) is the worked
  example, and `ProbeHealth` is DEFINED there and re-exported from
  `session_manager` so every existing import keeps resolving. `ThemeStore`
  (S2, with `theme_accents` and `theme_dotfile` beside it) is the worked
  example for a cluster of DICTS, and it carries two rules the scalar one
  could not teach. **A moved attribute that anything REBINDS needs a
  property SETTER that writes through to the collaborator**: several tests
  assign `mgr.pinned_themes = {...}` wholesale, and a read-only property
  raises while a plain instance attribute silently shadows the property and
  forks the two objects while every value assertion still passes. **And a
  collaborator that does file I/O takes its path as a zero-argument
  CALLABLE, not a `settings` import.** Every theme test redirects state with
  `monkeypatch.setattr("src.core.session_manager.settings", stub)`, which
  patches the name in THAT module; a collaborator importing `settings`
  itself does not see it and reads and WRITES the developer's real
  `~/.cloude-sessions` during a pytest run. Resolving the path at call time
  is also exactly what the loose methods did. `ToastInbox` (S3) adds the
  third shape: **a moved container reached by a DEFENSIVE ACCESSOR in
  another module needs its own proof leg.**
  `src/core/toast_history.py` reads `getattr(manager, "_pending_toasts",
  None)` and answers `{}` for anything that is not a Mapping, deliberately
  and documented as such - so a facade that stopped exposing that name
  would show an EMPTY toast history on every surface while raising nowhere
  and failing no existing test. Whenever a slice moves a field, grep for a
  `getattr` on its name before trusting a green suite; that shape is what
  CLAUDE.md calls the characteristic failure of this refactor, and it has
  now appeared in two of the first three slices. `SessionRegistry` (S4,
  the log buffers and command counters, half the registry cluster with S7
  bringing the rest) settles the SETTER POSTURE as evidence rather than
  taste: **a write-through setter exists where a whole-map rebind is
  MEASURED in the tree, and the property is read-only everywhere else**,
  so a future assignment fails loudly instead of shadowing the property.
  It also generalises S2's callable rule from paths to VALUES - the line
  cap arrives as `lambda: settings.log_buffer_size`, because four test
  modules install a stub `settings` on `session_manager` carrying their
  own `log_buffer_size` and a collaborator that imported `settings` would
  read the real one. And it names the case where the existing suite can
  prove NOTHING: this cluster has zero readers outside `session_manager`
  and had zero tests of its own, so no pre-existing test could redden for
  any defect in the move and the structural legs carry the whole proof.
  Measured on the aliasing mutation, where `__init__` holds the
  collaborator's own dict as a plain attribute: leg (a), the `is` check,
  stays GREEN and only leg (b) fails. `AttachmentSidecars` (S5, the idle
  watchers, the adopt FIFO offsets and the pending terminal commands)
  QUALIFIES the getattr rule above rather than repeating it. **A
  defensive-accessor leg catches a REMOVED property, and it catches a
  COPYING one only if it asserts identity on the container itself.**
  `toast_history`'s leg does (`is` on the dict) and the websocket's
  `getattr(sm, "idle_watchers", {}).get(session_id)` does not - measured
  on the copying mutation, that leg passed while identity, cross-writes,
  the rebind and injection all failed. And **a test that constructs the
  manager with `SessionManager.__new__` bypasses `__init__`, so every
  property a slice adds is unreachable there**: it has to install the
  collaborator by hand the way it already installs `backends`. One file
  does that today, `tests/test_terminal_commands.py`, and it was
  repointed in the same commit. S5 also carries the one-shot rule for
  the two sidecars that are consumed exactly once - `take_fifo_offset`
  and `take_pending_command` POP, `peek_fifo_offset` does not, because
  `adopt_fifo_start_offset` is a property and a getter that consumed
  would let an unrelated read destroy the replay position of a session
  nobody had attached to yet.
- **No bare `except:` and no blanket `except Exception:`** that swallows. Catch
  the specific error, log it with structlog context, or re-raise. If you
  deliberately swallow, a comment says why (see the History-API guard in
  `client/js/router.js` for the shape).
- **Production ready.** No mocks, no placeholders, no test endpoints left behind.
- **`python3`, never `python`.** Tests: `venv/bin/python3 -m pytest -q` from the
  repo root. System python3 has no fastapi. **Current baseline, measured at
  `b5de919` on `integration/1.3.0`: 7303 passed / 4 failed / 57 skipped, out
  of 7364 collected. RE-MEASURED 2026-09-12 on the consolidated
  `integration/1.3.0` with all four 1.4.0 branches merged, `-p no:randomly`:
  7318 passed / 4 failed / 57 skipped in 284.81 s. The SAME four, so the
  fifteen tests the state-dir round added all pass and this consolidation
  introduced no new failure.** RE-MEASURED AGAIN 2026-09-12 on `master`
  after the terminal search work landed, `-p no:randomly`: **7365 passed /
  0 failed / 60 skipped.** The four named below are gone at this reading,
  so ZERO FAILED IS ONCE MORE THE NUMBER TO HOLD; node reads **203 suites,
  all passing** (the count MOVED DOWN from 223, not up, because two
  vanilla-JS suites were consolidated into one bundle suite rather than
  ported test-for-test - fewer suites is not fewer coverage here), and
  vitest reads **1430** tests. The four are environmental, they fail identically on
  the other party's parent `6012467`, and they are named here so you can
  recognise them rather than chase them:
  `test_cold_socket_born_at_depth_real_tmux`,
  `test_cold_socket_options_real_tmux`, `test_tmux_launch_batching_real_tmux`
  and
  `test_home_write_guard.py::test_guard_refuses_the_real_claude_settings_path_by_name`.
  **THREE OF THE FOUR ARE IN THE `real_tmux` GROUP, WHICH IS HOW YOU
  REPRODUCE MOST OF THIS BASELINE WITHOUT CONTENDING FOR A SOCKET.** Measured
  independently 2026-09-12 at `b5de919`, in a clean worktree with a
  `config.json` copied in, `-p no:randomly -m "not real_tmux"` reads
  **6957 passed / 1 failed / 57 skipped / 349 deselected in 193 s**, the one
  failure being `test_home_write_guard`. The arithmetic closes exactly,
  6957 + 1 + 57 + 349 = 7364, which is what makes those two runs ONE
  measurement rather than two numbers that happen to land near each other; a
  bare `--collect-only` on the same tree also answers 7364. `-m "not
  real_tmux"` IS STILL NOT A VERIFICATION RUN - it is a fast loop and a
  cross-check, and it cannot see three of the four failures it is being used
  to account for.
  ZERO FAILED WAS TRUE FOR ONE DAY AND IS NO LONGER THE NUMBER TO HOLD. The
  reading before this one was **6423 passed / 0 failed / 18 skipped**,
  re-measured 2026-09-11 on `master` at `ea2cbc9` with `-p no:randomly`, and
  before that **5758 passed / 0 failed / 18 skipped**,
  re-measured 2026-09-10 on `docs/6-meta-cluster` off `51f3489`, and the two
  it fixed by diagnosis are still fixed - what came back is a DIFFERENT set
  that arrived with the 1.4.0 fold and fails on his side too, so a failure
  here is still a real signal as long as it is not one of the four named
  above. Earlier readings, kept because the DRIFT is the lesson:
  **5656 passed / 2 failed / 19 skipped** on `release/1.2.1`, **5641 / 2 / 19**
  at the bare merge of `adamdev/master` 2b1fcb9, and
  **5628 / 2 / 19** at `release/1.2`. Note the SKIP COUNT MOVES between
  runs purely on `pytest-randomly`'s ordering, so a lone off-by-one is not a
  test that stopped being measured; the skip REASONS are what
  to read, and `-p no:randomly` pins it. Two failures this file used to name as
  permanently environmental are FIXED as of 2026-09-10, by diagnosis rather
  than by a skip, and the precondition behind each is written down because
  nobody had ever recorded it:
  `test_version_probe.py::test_current_version_empty_when_unresolvable`
  asserts a directory with no version source resolves to `""`, and
  `CLOUDE_APP_VERSION` is rung 1 of `resolve_version` and IGNORES the
  directory entirely. It is exported in the developer's own shell, so the
  test failed locally with `assert '0.8.1' == ''` and passed in CI, where
  nothing exports it. It now clears the variable for that one test, and a
  new test asserts the override outranks the directory so the rung has
  coverage instead of being a trap.
  `test_nuke_sandbox.py::test_dry_run_deletes_nothing` asserts a `--dry-run`
  leaves the sandbox manifest bit-identical; `nuke.sh` falls through to the
  `python3` on PATH, and when THAT interpreter lives inside a read-only
  bundle CPython redirects bytecode caching to
  `$HOME/Library/Caches/com.apple.python/...`, where HOME is the sandbox. The
  dry run deleted nothing and still grew the manifest by 49 directories. On
  this box `/usr/bin/python3` is the Xcode-bundled Python 3.9, which is
  exactly that case; CI uses `actions/setup-python`, which writes
  `__pycache__` beside the source. The fixture sets
  `PYTHONDONTWRITEBYTECODE=1`, suppressing only `.pyc` writing, so anything
  `nuke.sh` itself creates in HOME is still measured.
  `test_home_write_guard.py::test_guard_refuses_the_real_claude_settings_path_by_name`
  and
  `test_state_dir_resolution.py::test_get_state_dir_default_is_never_under_the_system_temp_dir`,
  which this file also used to name, both PASS. Neither was fixed on
  purpose, so treat them as environmental in both directions rather than as
  a guarantee.
  A CHECKOUT WITH NO `config.json` MANUFACTURES A FAKE FAILURE SET, and it
  is a big one: 19 failed plus 26 errored in a fresh `git worktree`, every
  one of them an app that could not start (401s from the test client,
  FileNotFoundError from the route tests), and every one of them clearing
  the moment the file is put back. `config.json` is gitignored, so a new
  worktree never has it. Copy one in before you measure anything, and do
  not attribute a failure to a code change until you have reproduced the
  same run on the base commit in the same directory.
  TAKE YOUR OWN BASELINE ON A CLEAN TREE BEFORE YOU JUDGE YOUR OWN RUN -
  this figure has been stale twice, and the population of environmental
  failures moves.
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
  chasing it. **THAT GROUP HAS A NAME NOW: the `real_tmux` marker**, 115 of
  the 5776 collected tests, so `-m "not real_tmux"` gives a fast local loop
  and `-m real_tmux` runs the contended group on its own, more than once,
  because one pass proves nothing about a flake. It is applied
  AUTOMATICALLY by `tests/conftest.py`, derived from the module importing
  `tests/socket_guard.py` or the test requesting the `tmux_test_socket`
  fixture, never hand-written on a test - a hand-kept list is wrong the
  first time somebody adds a test without knowing the list exists. It
  deliberately OVER-includes: marking a fast test costs a little coverage
  in a loop that was never a full verification anyway, while missing a
  real-tmux test puts a load-sensitive flake back into the fast loop. It
  adds no skip, changes no timeout and touches no assertion, so a plain
  `pytest` run collects and runs exactly what it did before, and
  `-m "not real_tmux"` IS NOT A VERIFICATION RUN. No timeout was raised to
  fix a flake: a timeout long enough never to flake is also long enough to
  hide a real hang. See `docs/ci.md`. Node: **197 tracked suites, all 197 passing** (re-counted
  2026-09-09 at the 1.2 merge; v1.1 alone had 193, of which 2 failed).
  `test_archive_full_page_mode.node.mjs`, the one long-standing node
  failure this file used to name, is FIXED and now passes. Re-measured
  2026-09-10 on the navigation-token branch: **206 tracked suites, all
  206 passing**, against 202 on its base commit in the same worktree -
  four added, no new failures. Measured 2026-09-12 by running the
  CI loop's own `for suite in tests/*.node.mjs` at `b5de919`: 195 tracked
  suites, all 195 passing, none failing. **CURRENT, re-measured 2026-09-12
  on the consolidated `integration/1.3.0` (the four-branch 1.4.0 round
  merged): 198 tracked suites, all 198 passing, none failing.** The three
  added are the client round's own
  `test_away_bar_containing_block.node.mjs` (renamed to
  `test_terminal_container_containing_block.node.mjs` on 2026-09-13 when
  the away bar went and the declaration it guards did not),
  `test_settings_panels_mount.node.mjs` and
  `test_write_failure_is_visible.node.mjs`. THE COUNT WENT DOWN AT
  `b5de919` AND THAT WAS THE MIGRATION, NOT A LOSS OF COVERAGE: the svelte slices retired node
  suites whose subject they deleted and re-asserted them in vitest under
  `web/src`, which the `tests/*.node.mjs` glob cannot see. Two numbers are
  needed to describe this tree now, and the vitest half was NOT re-measured
  by the `b5de919` pass - it carried `1340/1340` from `.claude/TODO.md` as a
  reading taken by an earlier round. **The consolidation round DID measure
  it: vitest `1342/1342` across 47 files, `svelte-check` 0 errors and 0
  warnings over 402 files, on the merged tree.** The two added cases are the
  shim's new `showError` and `selectProject` members. Note
  `test_terminal_layout.node.mjs`
  flaked ONCE in that base run and passed in isolation seconds later on
  the same tree, so a lone failure there without a code change is not a
  regression; re-run before chasing it. Re-measured 2026-09-11 on `master`
  at `ea2cbc9`: **223 tracked suites, all 223 passing**, against 206 at the
  prior reading - seventeen added, no new failures. The piped-stdin CLI helper for
  the real-hook harness lives at `tests/helpers/led_state_for.mjs`, outside
  the `tests/*.node.mjs` glob the CI loop runs, because it is not a suite and
  exits non-zero when run with no input - which is what it used to be
  reported as, from `tests/led_state_for.node.mjs`, before the move.
- **CI IS SWITCHED OFF, ON PURPOSE, AND YOUR LOCAL RUN IS THE ONLY EVIDENCE
  THERE IS.** The owner's ruling, 2026-09-10, verbatim: "P25 - kill the CI".
  Three workflows on `Adoom666/CloudeCodeDev` are `disabled_manually` -
  `tests`, `secret scan` and `release`. `Claude Code Review` and `Claude Code`
  are still active, because they are the review bot rather than CI.
  **NO TEST WAS FAILING AND NO TEST WAS REMOVED.** Every run from
  2026-09-10T13:47Z was refused BEFORE STARTING with "recent account payments
  have failed or your spending limit needs to be increased": twelve
  consecutive red runs, two workflows, four jobs each, none of which ever
  executed, which is why `gh run view --log-failed` answers `log not found`.
  **A check that could not run is not a check that failed**, the same
  distinction as `StatusMap.complete`, the recreate gate's `gone` versus
  `unknown`, and `db_integrity`'s `cannot_determine` versus `failed`. GitHub
  renders both as a red X and emails both, so a human has to draw it.
  The consequence, said plainly: `2b1fcb98` is the last commit CI ever tested,
  everything after it including the v1.2.1 merge has never been through it,
  and **nothing you write today will be checked by anything but you.** Run the
  python suite and the node suites yourself, and say in the PR which ones you
  actually ran. The workflow FILES are untouched, so reversing this is
  `gh workflow enable <name> -R Adoom666/CloudeCodeDev` per workflow once the
  billing is settled. Do not delete, `continue-on-error` or otherwise green a
  workflow to quiet the board; that replaces a true "unknown" with a false
  "passed". Details and the re-enable commands are in `docs/ci.md`.
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
- **Push only to `Adoom666/CloudeCodeDev`. It is the only repository: nothing is pushed, mirrored or released anywhere else. NEVER to `upstream` (Adoom666/CloudeCode).** Owner's ruling 2026-09-12, "One repository: Adoom666/CloudeCodeDev" in `docs/DECISIONS.md`, which supersedes the earlier mirror to ccsliinc/CloudeCode. On Adam's clone that remote is `origin`; check `git remote -v` before a push, because other clones name it differently. The `upstream` push URL is set to `DISABLED_do_not_push_to_Adoom666_CloudeCode` on the owner's clone so a push there fails by construction; re-apply that with `git remote set-url --push upstream DISABLED...` on any fresh clone.
- **`gh`'s active account is GLOBAL TO THE MACHINE, and it does not hold
  still.** Other agents on this box run `gh` under other accounts, so the
  active one is not a fact you can check once and carry. Measured
  2026-09-11 in one working session: it moved off the account that can see
  this repo THREE TIMES, unprompted, including once between two
  consecutive commands. A check at session start proves nothing about the
  call forty minutes later. So NEVER RELY ON THE AMBIENT ACCOUNT: assert
  your own on every single `gh` invocation instead, by passing its token
  as an env var rather than trusting whatever `gh auth switch` last left
  active - `GH_TOKEN="$(gh auth token -u <your-account>)" gh <subcommand>
  ...`. `<your-account>` is whichever account YOUR clone can see this repo
  under; on Adam's box that is `Adoom666`, given here as the worked
  example rather than the universal answer, because this file is also
  read by the other developer, `ccsliinc`, who has their own account.
  `gh auth token -u <account>` reads that account's token without
  mutating anything global, which is exactly why it is the right tool and
  `gh auth switch` is not: a switch changes the account under every OTHER
  agent on the machine too, which can break their in-flight calls and
  starts a switch-back fight nobody wins. The token comes from command
  substitution AT CALL TIME ONLY and must NEVER be written into a file, a
  settings file, an env file, a commit or a log - this repo carries a
  pre-commit secret-scanning hook and `docs/secret-scanning.md` because of
  exactly that mistake once already. `git` is UNAFFECTED by any of this:
  a push here goes over SSH and never consults the `gh` account, so a
  failed `gh` call is not evidence a push failed, and treating it as one
  risks re-pushing or re-claiming work that already landed. The
  wrong-account failure reads as `GraphQL: Could not resolve to a
  Repository with the name '...'. (repository)`, which looks exactly like
  the repo was deleted or renamed and means only that the wrong account is
  active.

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
| May boot stand on the cached verdict | `src/core/db_integrity_gate.py` |
| Atomic write / tolerant read, shared with the ingester | `src/core/json_artifact.py` |

**AND BOOT WAS DOING THE SAME THING THE REQUEST PATH USED TO, FOR LONGER.**
`ensure_db_migrated` ran the identical pragma unconditionally at
`db_migration.py:280`, BEFORE the schema-version gate, so it ran whether or not
a migration was pending. Measured 2026-09-11 on the owner's 5.4 GB cloude.db:
**51.8 s of a 55 s startup window**, after which the entire rest of the lifespan
took 200 ms. Warm cache floor about 21 s, cold about 54 s. That is 20 to 50
seconds of CLOSED PORT on every restart, six hours after the daily checker had
walked the same file in 19.767 s and written `ok`.

`src/core/db_integrity_gate.py` is the ladder. **ONLY A POSITIVE, FRESH, `ok`
VERDICT TAKEN ON THIS DATABASE MAY SKIP THE PRAGMA**; ten named rungs refuse and
every one of them runs it. The freshness window is NOT picked here: it is
`resolve_stale_after_seconds()`, two check intervals, and more than the number
the gate reuses the REDUCTION - `db_integrity_status.classify_record` is now one
public function and `GET /api/v1/version` calls it too, so the boot gate and the
status block cannot disagree about whether the database has been verified.

**A CACHED FAILURE RUNS THE LIVE PRAGMA; IT DOES NOT SHORT-CIRCUIT.** Returning
the degraded state straight from the recorded complaint looks stricter and is
worse: it makes a stale failure permanent, so a user who restored a verified
backup after a corruption would boot read-only forever, with a cached verdict
outranking a live one. Running the pragma cannot be softer than the old
behaviour because it IS the old behaviour.

**THE ARTIFACT NOW SAYS WHICH DATABASE IT DESCRIBES.** It recorded only
`db_path`, which is derived from the state directory on both sides and therefore
always matches and proves nearly nothing, because a restored file lands at the
same path. It now also carries `meta.install_id` and `db_size_bytes`, following
`corpus_ingest_scan.py`, which already invalidates its own cache on a changed
`install_id`. A file SMALLER than when it was verified has been replaced,
restored, truncated or VACUUMed, because SQLite does not shrink in normal
operation; a VACUUM is the one false positive and costs exactly one slow boot.
An artifact predating the binding carries no `install_id` and is REFUSED, so the
first boot after this ships still walks the file and only the second is fast.

**WHAT IT CANNOT DETECT IS SAID OUT LOUD RATHER THAN IMPLIED AWAY.** An in-place
restore of a same-size-or-larger backup of the SAME install is invisible to all
three identity facts, and so is bit rot arising between the check and the boot.
An unclean shutdown is not detectable either: in WAL mode a `-wal` file is
present whenever a connection is open and routinely survives a clean exit, and
this is a menubar app that is killed constantly, so any crash heuristic built on
it would refuse always or never. For all three the freshness window is the only
control, which is the same control the daily check has always rested on.

**THE OUTCOME ON THE LIVE RESTART, REPORTED AND NOT RE-MEASURED HERE.**
The owner's reading after the deploy, 2026-09-11: startup **21.4 s to
1.867 s**, with the skip logged rather than inferred from the clock. That
21.4 s is the WARM-CACHE floor the commit message names, so it is the cheap
end of the range this replaced and not the 51.8 s worst case. This
documentation pass did not touch the live host and did not reproduce either
number; the commit's own measurements (51.8 s of a 55 s window, the daily
checker's 19.767 s walk) are what the ladder was built against.

**A BOOT-RUN CHECK PUBLISHES**, tagged `source: boot` beside the scheduled
sweep's `source: scheduled`. It is a real completed check and withholding it
would make the next boot walk a file verified moments earlier, which on a box
that restarts more often than the daily schedule fires is the whole fix not
happening. The tag is what keeps a dead daily loop diagnosable now that the
artifact's age alone cannot separate the two producers.

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

The hook runs a second gate after that scanner passes: gitleaks, against the
same `.gitleaks.toml` config CI runs. Installed via Homebrew on mac-mini-m4
(version 8.30.1, matching the version CI pins). A missing gitleaks binary does
not refuse the commit, it prints a NOTE that the second gate did not run.

Audit the tree with `./venv/bin/python3 scripts/scan_secrets.py`. Exit 2 means
could-not-scan and is not a pass. Full detail in `docs/secret-scanning.md`.

## Upgrading an install

`docs/upgrade-with-claude.md` is the runbook, and `/upgrade`
(`.claude/commands/upgrade.md`) is the entry point. The one rule that matters:
take `./scripts/upgrade-baseline.sh` BEFORE touching anything, because you
cannot verify a migration without a record of what the data was, and that is
the step everyone skips. `./scripts/upgrade-verify.sh` exits 2 when a check
could not be evaluated; 2 is not 0.

## Refreshing the local install on a new version

Adam's rule: every time there is a new version, his local copy gets
refreshed to it, so he is always running the latest code. Write down the
mechanics, because every one of them is a way the refresh silently does
not happen, and each has already cost time on this machine.

**There are two launch modes and they rsync from different places.** The
packaged app (`/Applications/Cloude Code.app`) rsyncs from the bundle's own
`Contents/Resources`, so launching it REVERTS any unreleased repo change.
Dev mode (`npm start` / `electron .` from `macOS/`) rsyncs from the REPO
ROOT instead. Both write into the same derived copy, at
`~/Library/Application Support/cloude-code-menubar/server/`, which is what
the server actually executes - so the launch mode is what decides which
code Adam ends up running, and the two can drift apart for a long time
with nothing on screen saying so. Measured 2026-09-10: the installed
bundle read version 1.0.33 while `macOS/package.json` already said 1.2.1,
and the gap was invisible because Adam was running dev mode off the repo.

**The version lives in exactly one place, `macOS/package.json`.** There is
no root `package.json` and no second version literal to grep for. The web
client's own version comes from a `{{VERSION}}` token that `src/main.py`
substitutes at serve time, via `src/core/version.py::resolve_version()`.

**A refresh is kill, relaunch, verify, in that order, or it only looks like
one.**
- macOS has no `setsid`. `setsid nohup npm start &` fails with "command not
  found" and starts nothing while reading as success. Use
  `nohup npm start > /tmp/cloude-menubar.log 2>&1 & disown` instead.
- Killing Electron does not kill its Python child. The old server keeps its
  port and keeps serving the OLD code, a health check on that port still
  answers 200, and it reads as a successful deploy of nothing. Kill both
  processes and confirm the port is free before relaunching.
- Verify against the DERIVED copy, never the repo, and never trust a
  matching timestamp as proof: rsync PRESERVES MTIME, so the file dates
  lining up proves nothing about whether a fresh sync happened. Grep the
  derived file for the actual code change instead.

**Sessions survive this by design**, because they live on the dedicated
`tmux -L cloude` socket, not inside the Electron/Python process being
restarted. A refresh is safe to do with live work in progress, and
`tmux -L cloude list-sessions` reporting the same session count before and
after is one of the checks that proves the restart did not touch them.

A refresh is not done until all four of these are true: the port answers,
the derived copy at
`~/Library/Application Support/cloude-code-menubar/server/` contains the
new code (grepped, not timestamp-checked), `tmux -L cloude list-sessions`
reports an unchanged session count, and the reported version matches
`macOS/package.json`.

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
