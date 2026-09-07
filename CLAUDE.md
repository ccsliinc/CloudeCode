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
attach to a tmux session it did not create. Those get an id of
`adopted:<tmux-name>` and are absent from `owned_tmux_sessions`. See the adopt path at
`src/core/session_manager.py:2596` (`adopted_id = f"adopted:{name}"`).
Anything that parses, matches, displays or routes on a session id has to handle
both shapes. Strip the prefix to recover the tmux name; do not assume the id is a
clean display string.

**Claude Code lifecycle hooks feed the status machine.** `src/core/claude_hooks.py`
merges a managed hook block into `~/.claude/settings.json` (marked
`# cloudecode-managed`, idempotent, atomic write, bails rather than clobbering an
unparseable file). Hooks POST to a loopback-only endpoint authenticated by an
env-injected shared token. Events: `Stop`, `Notification`, `PermissionRequest`
(these three also raise a toast), plus `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `SubagentStart`, `SubagentStop` (activity state only).

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

**Config writes are atomic and backed up.** Copy the pattern in
`Settings.update_settings_config()` (`src/config.py`): write the `.bak` of the
pre-write bytes first, then temp file, `fsync`, `os.replace`. A half-written
`config.json` costs the user their whole setup, so there is no "just dump the
JSON" shortcut anywhere in this codebase.

## The `/sessions/list` shape

`GET /sessions/list` returns `SessionInfo` objects (`src/models.py`), and the
fields sit on **two different levels**:

- On the wrapper: `activity_status`, `unread`, `tmux_session`, `agent_type`,
  `pinned_theme`, `session_backend`, `recent_logs`, `local_servers`, `stats`
- On the nested `.session`: `id`, `pty_pid`, `working_dir`, and the rest of the
  `Session` model

Reading `info.id` or `info.session.unread` gives you `undefined` silently, and it
looks exactly like "the backend didn't send it". This is the single most
repeated bug in the project. Check the level before you debug the endpoint.

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
  repo root. System python3 has no fastapi. Current baseline is
  4647 passed / 3 failed / 0 errors / 13 skipped; the three failures are
  environmental and pre-existing:
  `test_home_write_guard.py::test_guard_refuses_the_real_claude_settings_path_by_name`,
  `test_state_dir_resolution.py::test_get_state_dir_default_is_never_under_the_system_temp_dir`,
  and `test_version_probe.py::test_current_version_empty_when_unresolvable`.
  Your job is to add no NEW ones. Watch for a broken environment
  manufacturing a fake baseline: a `venv` symlink pointing at a
  `venv.nosync` directory that no longer exists lets the suite limp
  along and undercount silently, rather than failing outright. If the
  numbers you see look nothing like these, check the symlink and rebuild
  the venv from `requirements.txt` before trusting the count.
- **`node --check`** every JS file you touch, before you claim it works.
- **Stage files by name** when committing. No `git add -A`.
- **Voice**: no em-dashes, no en-dashes, no emojis, anywhere, including commit
  messages. UI copy is lowercase and plain.

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
5. **A stale doc is worse than no doc.** A missing doc sends the next agent to
   read the code; a confidently wrong one sends it to write a bug. If you change
   behavior this file describes, update this file in the same change. If you find
   a claim here that reality contradicts, fix it and say so in the commit.
