# Continuous integration

What runs, when it runs, and what it does when something it needs is missing.

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

Two independent jobs.

**python** (ubuntu, python 3.13)

1. Installs `tmux` via apt. `tests/test_session_backend.py` drives a real tmux
   server, so those tests fail rather than skip without the binary.
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
5. Runs `python3 -m pytest -q`.

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
python3 -m pytest -q

scripts/ci/check-js-syntax.sh
node tests/test_deeplink_resolver.node.mjs

scripts/ci/assert-tmux-defaults.sh
gitleaks dir . --config .gitleaks.toml --redact --no-banner
```
