# Continuous integration

What runs, when it runs, and what it does when something it needs is missing.

## CI IS SWITCHED OFF RIGHT NOW, ON PURPOSE. READ THIS FIRST.

**Three of the five workflows below are `disabled_manually` on
`Adoom666/CloudeCodeDev`: `tests`, `secret scan` and `release`.** Nothing in
this repository is being verified by CI. The rest of this document describes
what those workflows DO when they are on, which is still accurate and still
worth reading; it does not describe what is happening on a push today.

The owner's ruling, 2026-09-10, verbatim: "P25 - kill the CI".

**It was not a test failure.** Every run from 2026-09-10T13:47Z was REFUSED
BEFORE IT STARTED, with the annotation "recent account payments have failed or
your spending limit needs to be increased". Twelve consecutive red runs across
two workflows, four jobs each, none of which ever executed. There is no log to
read, which is why `gh run view --log-failed` answers `log not found` and the
raw log endpoint answers `BlobNotFound`. A red badge meant a BILLING state, not
a code state, and it emailed a failure on every push that said nothing about
the push.

**A check that could not run is not a check that failed.** This codebase draws
that distinction everywhere else and says so in CLAUDE.md more than once:
`StatusMap.complete`, `InstanceIndex.complete`, the recreate gate's `gone`
versus `unknown`, `db_integrity`'s `cannot_determine` versus `failed`. GitHub
does not draw it. Both render as a red X and both send the same email, so the
distinction has to be drawn by whoever reads the board.

**The workflows were DISABLED, not deleted, and no test was removed.** The
files under `.github/workflows/` are untouched. Reversing this is one command
per workflow once the billing block is cleared:

```
export GH_TOKEN=$(gh auth token --user Adoom666)
gh workflow enable tests -R Adoom666/CloudeCodeDev
gh workflow enable "secret scan" -R Adoom666/CloudeCodeDev
gh workflow enable release -R Adoom666/CloudeCodeDev
```

`Claude Code Review` and `Claude Code` were deliberately left ACTIVE. They are
the review bot rather than CI, and the ruling did not cover them.

**What this costs, stated plainly so nobody is surprised.** `2b1fcb98` at
03:00Z on 2026-09-10 is the last commit CI ever actually tested. Everything
merged since, the v1.2.1 merge included, has never been through it. Anyone
relying on CI to catch a regression on this repo has no such net right now, and
any issue whose "How to verify" section names CI cannot be verified that way
until it is back on. **Run the suites locally in the meantime** (see "Running
the checks locally" below), and say in a PR which suites you actually ran.

The local pre-commit secret hook still runs and is currently the only gate
actually executing. Install it with `./scripts/install-secret-hook.sh`; it is
not version controlled, so it is one run per clone.

## The workflows

| Workflow | File | Triggers | Needs a secret |
|---|---|---|---|
| tests | `.github/workflows/tests.yml` | every `push`, every `pull_request` | no |
| secret scan | `.github/workflows/secret-scan.yml` | every `push`, every `pull_request` | no |
| Claude Code Review | `.github/workflows/claude-code-review.yml` | `pull_request` opened, synchronize, ready_for_review, reopened | yes, degrades gracefully |
| release | `.github/workflows/release.yml` | push of a tag matching `v*`, or manual dispatch | no |
| Claude Code | `.github/workflows/claude.yml` | `@claude` mention by an owner or member | yes, fails loudly by design |

Only the first two are meant to gate a merge. Nothing here writes to the
repository except the release workflow, and that writes a draft.

## tests

Three jobs: **python** as a two-platform matrix, **skip audit** over its
results, and **javascript**.

### Why the python job runs on macOS AND Linux

Updated 2026-08-24. It used to be ubuntu-only, and that was reporting a
verdict it had never measured.

CloudeCode ships as a macOS menu bar app AND as a Linux container
(`Dockerfile`, `docker-compose.yml`). Both are real deployment targets:

- **Linux-only CI can never execute** `~/Library/Application Support`,
  `launchctl`, `security(1)`, LaunchAgents or `.icns` handling. Every macOS
  behaviour would have to skip, and a test skipped on the only platform CI
  runs is furniture: it cannot go red, so it is not a measurement.
- **macOS-only CI hides Linux portability defects.** Measured, not
  hypothetical: `restore_backup()` in
  `scripts/upgrade_lib/upgrade_rollback_common.sh` selected its manifest rows
  with a backslash-t inside a POSIX basic regular expression. BSD grep (macOS)
  reads that as a tab; GNU grep 3.11 reads it as a literal `t`. On Linux the
  branch never fired, so a restore restored the install files, restored NONE
  of `session_metadata.json` / `pinned_themes.json` / `unread_state.json` /
  `refresh_tokens.db`, and still printed a success count. Only a Linux leg
  finds that class.

The repository is public, so Actions minutes are free on every runner type;
the usual cost objection to `macos-latest` does not apply here. What the
split still gives up: neither leg exercises a REAL signed .app bundle, a real
LaunchAgent load, or a real Keychain, because a GitHub macOS runner has no
signing identity and no logged-in GUI session. Those remain untested by CI
and are only covered by hand on the mini.

### The tag the continuity tests need

`actions/checkout` clones at depth 1 with no tags.
`tests/test_session_meta_continuity.py` compiles `v0.8.1`'s OWN
`Settings.get_session_metadata_path` out of the tag with
`git show v0.8.1:src/config.py`, so a tagless clone leaves that whole
comparison unmeasurable.

`fetch-depth: 0` would fix it by downloading the entire history. Fetching the
single tag at depth 1 is enough and much cheaper: measured 2026-08-24 against
a `--depth=1` clone of this repo, `git fetch --depth=1 origin tag v0.8.1` took
0.97s and left `.git` at 35M. A shallow tag fetch still carries that commit's
complete tree, which is all `git show <tag>:<path>` reads.

The workflow config is only half the fix. The test itself now has three
outcomes rather than two: it SKIPS with a named reason plus the exact fetch
command when the tag is absent from the clone (a shallow clone is a real
environment, not a repository fault), and FAILS when the tag is present but
its `get_session_metadata_path` cannot be read or parsed. The workflow step
then `git rev-parse`s the tag and fails if it is missing, so that skip can
never quietly become CI's normal state. Neither half is sufficient alone:
config-only breaks again in any shallow clone, test-only lets CI go green
without ever running the comparison.

### skip audit

A suite that passes while quietly skipping the tests that would have failed
is the false-green pattern this project keeps paying for. So:

1. Every python job runs pytest with `--junitxml` and `-rs`, then prints its
   own skip count and every skipped test id with its reason.
2. Each job uploads its skip list as an artifact.
3. The `skip audit` job intersects them and FAILS the build if any test was
   skipped on BOTH platforms, i.e. was never measured anywhere.

`scripts/ci/skip-audit.py` is that tool. It refuses to treat a missing or
unparseable junit report as "no skips" - that is a broken measurement, not an
empty one - and it refuses to intersect fewer lists than there are platforms,
because an intersection over one list passes trivially.

The rule earned its keep on its first run (32737804938): it caught
`tests/test_setup_wizard_renders.py`, the only suite that measures PIXELS
rather than DOM text, skipping on both platforms because playwright had never
been installed in CI, and
`tests/test_dmg_artwork.py::test_the_generator_runs_end_to_end`, skipping on
both because `rsvg-convert` was absent. Both now run.

### Measured baseline

Run 32738204216, 2026-08-24, commit `e16cb17`:

| Leg | Result |
|---|---|
| python tests (ubuntu-latest) | 2415 passed, 1 skipped |
| python tests (macos-latest) | 2416 passed, 0 skipped |

The one Linux skip is `test_dmg_artwork.py::test_the_generator_runs_end_to_end`,
which is macOS-only by construction: it calls `tiffutil` to prove the dmg
background carries both a 1x and a 2x representation, and `tiffutil` does not
exist on Linux. `librsvg` is therefore installed on the macOS runner only.
Installing `rsvg-convert` on Linux too would move the failure, not fix it.

**python** (ubuntu-latest and macos-latest, python 3.13)

1. Installs `tmux` (apt on Linux, brew on macOS; macOS already ships zsh, and
   the macOS leg also installs `librsvg` - see above).
   `tests/test_session_backend.py` drives a real tmux server, so those tests
   fail rather than skip without the binary.
2. Runs `scripts/ci/assert-tmux-defaults.sh`. `src/core/tmux_backend.py`
   addresses panes as the literal `<session>:0.0`, which requires tmux's
   default `base-index 0` and `pane-base-index 0`. A developer whose dotfiles
   set `base-index 1` sees 8 `test_session_backend.py` failures (measured
   2026-08-14 with `config.json` present): 5 fail directly with `can't find
   window: 0`, and 3 more (`..._start_ignores_one_sided_initial_dims`,
   `..._attach_existing_flips_running`,
   `test_list_attachable_sessions_flags_ownership_correctly`) cascade from
   those with `tmux new-session failed: server exited unexpectedly`, because
   the tests share one tmux server. It reads like a backend bug and is not
   one. The script says so in one line. Runners have no tmux config, so it
   passes there.

   The 4 `test_session_rejoin_scrollback.py` failures in the raw baseline are
   a separate cause and are not affected by `base-index`: they fail with
   `Auth config file not found: config.json` and are fixed by step 4. An
   earlier version of this document merged both sets into a single claim of
   "all twelve tmux tests", which was wrong about the count and about the
   cause.
3. Installs `requirements.txt`.
4. Copies `config.example.json` to `config.json`. `src/config.py` raises
   `FileNotFoundError` without it, and `config.json` is gitignored. This single
   step is what turns the six `test_deep_link_routing.py` errors and the four
   `test_session_rejoin_scrollback.py` failures green.
5. Installs `playwright` and its chromium. `tests/test_setup_wizard_renders.py`
   is the only suite that asserts on painted pixels rather than DOM text, and
   it `importorskip`s playwright. Playwright is deliberately NOT in
   `requirements.txt`: it is a test-time browser driver, not a runtime
   dependency of the server.
6. Runs `python3 -m pytest -q -rs --junitxml=...`, then reports and uploads
   this platform's skip list.

Python 3.13 rather than 3.14: the suite gives identical results on both, and
every pinned wheel in `requirements.txt` has a prebuilt 3.13 artifact.

**javascript** (ubuntu, node 22)

1. `scripts/ci/check-js-syntax.sh` runs `node --check` over every `.js` file
   under `client/js`. The client is served as static files with no bundler, so
   before this job a syntax error reached the browser unnoticed.
2. Runs `tests/test_deeplink_resolver.node.mjs`, the repository's only
   behavioural JS test. It is a standalone script and needs no test runner.

### How "green on the first run" was verified

A pipeline that is red on day one teaches everyone to ignore it, so the claim
that this one starts green is checked rather than assumed. The check does not
need a GitHub runner: the only relevant difference is that a runner's tmux
reads no user config. Putting a shim earlier on `PATH` that runs
`tmux -f /dev/null "$@"` reproduces exactly that, and both `base-index` and
`pane-base-index` then read `0` as on a runner.

```
printf '#!/bin/sh\nexec "$(command -v tmux)" -f /dev/null "$@"\n' > /tmp/shim/tmux
chmod +x /tmp/shim/tmux
PATH=/tmp/shim:$PATH python3 -m pytest -q
```

Run that way on 2026-08-14, with `config.json` in place, the suite reports
**632 passed, 4 skipped, 0 failed**. Run without the shim on a machine whose
dotfiles set `base-index 1`, the same tree reports 8 failures in
`test_session_backend.py` and the `assert-tmux-defaults.sh` step names why.

This is also what proved that
`test_ensure_pipe_pane_does_not_clobber_existing_pipe` was NOT a `base-index`
casualty. That test mocks `_run_tmux` outright and never contacts a tmux
server, so it failed identically under the shim and would have been red on the
first GitHub run. Its real cause was a superseded contract: commit `6dfe52d`,
the terminal-freeze fix, deliberately changed `ensure_pipe_pane` to close a
user's existing pipe and start its own, because the previous
defer-and-return behaviour left an adopted session with no readable pipe and
the browser showing a frozen terminal. The test and the method's own docstring
were left asserting the old contract. Both now describe the current one, and
the test is renamed `test_ensure_pipe_pane_replaces_existing_pipe`.

### The four tests that skip

`tests/test_agent_fingerprint.py::test_real_capture_detects` reads real
scrollback captures from a directory that is not committed. The path used to be
hardcoded to the original author's machine, so the four cases failed for
everyone else. They now skip with a reason, and the directory is overridable:

```
AGENT_CAPTURE_DIR=/path/to/captures python3 -m pytest tests/test_agent_fingerprint.py
```

The captures are excluded on purpose. They are large dumps of whatever happened
to be on screen when they were taken, and fabricating stand-ins from the
detector's own fingerprint rules would only test the rules against themselves.
The four synthetic cases in the same file, including the false-positive guard,
still run everywhere.

## secret scan

`gitleaks` over the checked-out tree, pinned to a specific version, configured
by `.gitleaks.toml`. Findings are redacted in the log and the full report is
uploaded as a SARIF artifact so a hit can be triaged without printing the value
into a public log.

This is the highest-value job in the pipeline. This public repository is
populated by copying files out of a private one. There is no shared git history
to diff against and no server-side hook chain, so nothing structural stops a
credential riding along in a copied file. Running it in Actions rather than as a
local pre-commit hook is deliberate: it applies to every push regardless of who
made it or what they have installed locally.

**Why it scans the tree and not the full history.** Building this pipeline found
three real credentials committed in `THEPROBLEM.md`: a Cloudflare API token, a
TOTP secret and a JWT secret, pasted from a live `.env` into a bug report. They
have been replaced with `<redacted>`, but they remain readable in git history,
so a history-mode scan would fail permanently until the history is rewritten. A
required check that can never pass trains everyone to ignore every check. Tree
mode catches the case that matters, which is a secret present in the code
someone is about to publish.

**Those three credentials still need rotating.** Redacting the file does not
un-leak them.

The allowlist in `.gitleaks.toml` covers placeholder files and named fake
values only. The `tests/` directory is deliberately not allowlisted: a
credential pasted into a test file is exactly the accident this job exists to
catch.

## Claude Code Review

This workflow had failed six of six recent runs, for two reasons that no
contributor could fix.

1. `secrets.CLAUDE_CODE_OAUTH_TOKEN` is not configured on the repository.
2. A pull request from a fork gets a read-only token, cannot read repository
   secrets, and cannot mint an OIDC token. The action can never succeed there.

It has been kept and guarded rather than deleted, because it becomes useful the
moment the maintainer adds the secret and needs no further change then.

* Fork pull request: the job does not run. The condition
  `github.event.pull_request.head.repo.full_name == github.repository` skips it.
* Secret absent: the job runs, a preflight step emits a `::notice` naming the
  secret to add, the review step is skipped, and the job succeeds.

To enable it, add `CLAUDE_CODE_OAUTH_TOKEN` under Settings, Secrets and
variables, Actions. To retire it instead, delete the file.

`claude.yml` was left alone. It only fires when someone explicitly writes
`@claude`, so a missing secret produces a visible failure exactly when a human
asked for something, which is the correct behaviour. Making it degrade silently
would leave that person waiting for a reply that is never coming.

## release

**This workflow changes the existing manual DMG process, so it is opt-in.**

It never runs on a merge, a branch push, or a schedule. The only automatic
trigger is pushing a tag matching `v*`, which is a deliberate act. It can also
be started by hand from the Actions tab, where it defaults to a dry run that
builds without creating a release.

What it does:

1. Builds the macOS DMG on `macos-latest` with `npm run package` in `macOS/`,
   which is the same command the manual process uses.
2. Refuses to build if the tag version and `macOS/package.json` version
   disagree, so the DMG and the release cannot end up named differently.
3. Uploads the DMG as a workflow artifact, retained 30 days.
4. Creates a **draft** GitHub release with the DMG attached. Nothing reaches
   users until a human opens the draft, checks the build, and publishes.

**It does not sign or notarize.** The output is equivalent to a local unsigned
`npm run package`, and Gatekeeper will warn on first launch. Signing needs an
Apple Developer ID certificate and an app-specific password in repository
secrets; it is left out openly rather than half-implemented, because a pipeline
that quietly ships an unsigned build through a signed-looking process is worse
than one that is honestly unsigned.

Deleting `release.yml` restores the fully manual process. Nothing else depends
on it.

## Running the checks locally



```
cp config.example.json config.json
python3 -m pip install --requirement requirements.txt
python3 -m pip install playwright && python3 -m playwright install chromium
python3 -m pytest -q -rs

scripts/ci/check-js-syntax.sh
for suite in tests/*.node.mjs; do node "$suite" || echo "FAIL $suite"; done

scripts/ci/assert-tmux-defaults.sh
gitleaks dir . --config .gitleaks.toml --redact --no-banner
```

`-rs` prints the reason for every skip. Without playwright installed,
`tests/test_setup_wizard_renders.py` skips locally and you are not measuring
what CI measures. Note also that a local run is NOT a substitute for CI here:
the whole class of bug this matrix exists to catch is one where local and CI
disagree. **That is not a reason to skip the local run while CI is off, it is a
reason to say what you actually ran.** A local pass on one machine is the only
evidence available today, and it is evidence about that machine.

### The `real_tmux` marker, and which subset to run when

115 of the 5776 collected tests drive a REAL tmux server on this run's
throwaway socket (counted 2026-09-10). They are the slowest part of the suite
and the part most likely to flake under concurrent load, because their waits
are real waits against a real process and a contended machine makes a real wait
longer. Two measured examples, neither of them a defect in the test:
`test_respawn_refreshes_pane_env.py::test_the_session_environment_itself_is_updated`
failed once beside three passes in isolation on the same tree minutes apart,
and `test_session_restart_wrapper_choice` failed twice with four agents working
the box and passed clean on a quiet one.

```
venv/bin/python3 -m pytest -q -p no:randomly                        # everything
venv/bin/python3 -m pytest -q -p no:randomly -m "not real_tmux"     # fast loop
venv/bin/python3 -m pytest -q -p no:randomly -m real_tmux           # that group alone
```

Use `-m "not real_tmux"` for the loop you run while you are still writing the
change. **It is not a verification run.** Before you claim anything works, run
the whole suite, and if you touched anything tmux-shaped run the marked group
more than once: one pass proves nothing about a flake.

**The marker is applied automatically by `tests/conftest.py`, not written on a
test by hand.** It is derived from two signals a real-tmux test cannot avoid
carrying: its module imported `tests/socket_guard.py` (which is how a test
names the throwaway socket it is allowed to touch), or it requested the
`tmux_test_socket` fixture. A hand-maintained list would be wrong the first
time somebody added a test without knowing the list existed. The derivation
deliberately OVER-includes and must never under-include: marking a fast test
costs a little coverage in a loop that was never a full verification anyway,
while missing a real-tmux test puts a load-sensitive flake back into the fast
loop and defeats the point of the marker.

The marker adds no skip, changes no timeout and touches no assertion. A plain
`pytest` run collects and runs exactly what it did before.

`tests/test_led_real_hooks.py` is a separate thing and stays opt-in behind
`CLOUDE_REAL_HOOK_TESTS=1`. It launches a real `claude`, spends real Claude
turns and about 50 seconds. Without the variable, or without tmux, claude or
node, every test in it skips with a reason naming what went unmeasured.

### Two failures that are the machine, not the code, and are now fixed

Both were named in CLAUDE.md as environmental for a long time without anyone
recording WHY, which is most of the reason they stayed. Written down here so
the next person does not re-diagnose them:

- `tests/test_version_probe.py::test_current_version_empty_when_unresolvable`
  asserts that a directory with no version source resolves to `""`.
  `CLOUDE_APP_VERSION` is rung 1 of `src/core/version.py::resolve_version` and
  ignores the directory entirely, and it is exported in the developer's own
  shell, so the test failed locally with `assert '0.8.1' == ''` and passed in
  CI where nothing exports it. The fixture now clears the variable for that one
  test, and a second test asserts the override outranks the directory, so the
  rung has coverage instead of being a booby trap.
- `tests/test_nuke_sandbox.py::test_dry_run_deletes_nothing` asserts a
  `--dry-run` leaves the sandbox manifest bit-identical. `nuke.sh` falls
  through to the `python3` on PATH, and when that interpreter lives inside a
  read-only bundle CPython redirects its bytecode cache to
  `$HOME/Library/Caches/com.apple.python/...`. HOME is the sandbox, so the dry
  run grew the manifest by 49 cache directories without deleting anything. On
  the developer's box `/usr/bin/python3` is the Xcode-bundled Python 3.9, which
  is exactly that case; CI uses `actions/setup-python`, which writes
  `__pycache__` beside the source. The sandbox fixture now sets
  `PYTHONDONTWRITEBYTECODE=1`, which suppresses only `.pyc` writing, so
  anything `nuke.sh` itself creates in HOME is still measured.

Neither fix weakened an assertion and neither skipped anything.
