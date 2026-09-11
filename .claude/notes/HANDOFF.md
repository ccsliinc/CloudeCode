# HANDOFF - CloudeCode app development

Written 2026-09-07. UPDATED 2026-09-08 (late round), 2026-09-09 (status-light
round), and REWRITTEN 2026-09-11 for the 1.2 / 1.2.1 releases and the two
rewrites now waiting behind them. Re-scoped from
`Infrastructure/.claude/notes/handoff-2026-09-06-cloudecode-migration.md`, which
was written for someone continuing the MacBook-to-mini MIGRATION. This one is
written for someone continuing APP DEVELOPMENT.

Everything below was measured on the dates given, not inferred. Where something
is unproven it says so in those words. Where a figure was RE-MEASURED for this
rewrite on 2026-09-11 it is labelled `re-measured`; everything else is quoted
from a dated record in `.claude/TODO.md` and labelled `on record`.

Read `CLAUDE.md` in the repo root first - it is the architecture and the
conventions, and this file deliberately does not repeat it. Read
`.claude/notes/NEXT-SESSION.md` second if you only have five minutes; it is the
one-page version of sections 8 and 9 below. Read `.claude/TODO.md` third,
starting with its `## OPEN - index`. This file is the operational half: where
things run, how to deploy, and what will lie to you.

**THE ONE THING TO KNOW BEFORE YOU READ ANYTHING ELSE.** There are now THREE
lines of this project and they disagree about basic facts. `release/1.2.1` is
what LIVE RUNS and what this file and `CLAUDE.md` describe by default.
`feat/svelte-slice-7` (the client rewrite) and `feat/backend-decomposition` (the
backend rewrite) are finished but UNMERGED and UNDEPLOYED, and on them whole
files named in these documents no longer exist. Section 8 is the map. A claim
here without a branch beside it is a claim about `release/1.2.1`.

---

## 1. WHERE THINGS PHYSICALLY ARE

| Thing | Location |
|---|---|
| Source checkout (authoritative) | `/Users/jsugamele/Library/Mobile Documents/com~apple~CloudDocs/Sync/Development/CloudeCode`, branch `release/1.2.1` |
| Live production server dir | mini: `~/Library/Application Support/cloude-code-menubar/server` |
| Live production app bundle | mini: `/Applications/Cloude Code.app/Contents/Resources` |
| Live URL | `http://10.0.1.150:8000` |
| Staging (v1.1) | port 8001, state `~/Library/.../CloudeCode-v1.1`, tmux socket `cloude-v11`. Disposable. |
| Deploy script | `scripts/deploy-mini.sh`; `--target live` is REQUIRED, the default target is v11 |
| Live tmux socket | `cloude` |
| Database | `~/Library/Application Support/CloudeCode/cloude.db`, **5,365,055,488 bytes (5.0 GiB), re-measured 2026-09-11 09:57** |
| Pre-v26 database backup | `cloude.db.bak-v25-20260910T154341Z`, 5,143,568,384 bytes, beside it (re-measured) |
| Archive corpus database | mini: `/Users/jsugamele/ClaudeArchive/` was released to archive-nas 2026-09-09; do not assume it is still on disk |
| Wrapper scripts (rendered) | `~/Library/Application Support/CloudeCode/agent_wrapper_scripts/<id>.zsh` |
| 1.3.0 preview server (fixtures) | mini: `http://10.0.1.150:5057/`, pid 97386, UP re-measured 2026-09-11. Fixtures, not the owner's sessions; reads live, writes refused. |

**BOTH deploy targets must be written.** The packaged app copies its bundle
Resources over the server dir on every start, so writing only the server dir is
silently reverted at next launch. `deploy-mini.sh --target live` does both; a
hand `scp` must do both explicitly.

**Everything here runs on mac-mini-m4 (10.0.1.150).** There is no other host in
this project. The mini's boot volume had **110 GiB free**, re-measured
2026-09-11, which matters because the database backup gate in section 9 needs
room for a 5 GiB `VACUUM INTO` beside the original.

**WHAT LIVE ACTUALLY RUNS, re-measured 2026-09-11: version 1.2.1 on BOTH
halves.** `GET /health` answers 200. `/Applications/Cloude Code.app` reports
`CFBundleShortVersionString` **1.2.1**, and `tmux -L cloude list-sessions | wc -l`
returns **19**. The repo commit behind it is `d074bbc`, tagged `v1.2.1`, pushed
to `origin` and `adamdev`, published with an installer.

The BOTH matters, because it was the failure of the previous two rounds. There
are two independently movable version numbers:

- the **source**, which `deploy-mini.sh --target live` writes into the server
  dir and the bundle's `Resources`, and
- the **Electron bundle**, whose `app.getVersion()` becomes
  `CLOUDE_APP_VERSION` in the server's spawn env
  (`macOS/server-manager.js:917`) and is what `GET /api/v1/version` and the
  footer render.

A source deploy ships `git ls-files src client` and **cannot rewrite
`app.asar`**, so a perfect deploy can leave the footer reading an old version
forever. That happened twice: 1.2.0 source over a 1.0.33 bundle, and 1.2.1
source over a 1.2.0 bundle. Both were closed by rebuilding the bundle
(`cd macOS && npm install`, then
`CSC_IDENTITY_AUTO_DISCOVERY=false npm run package`) and reinstalling it.
`macOS/package.json` is the ONLY hand-written version source; everything else
derives from it, so neither rebuild changed a line of code.

**Schema is v26** (`src/core/db_models.py:53`, `CURRENT_SCHEMA_VERSION = 26`),
added by Adam's durable session mute. The live database itself was NOT read for
this rewrite: the ssh session has no TCC grant for that path, so
`sqlite3 file:...?mode=ro` returns "unable to open database file (14)". The
`cloude.db.bak-v25-...` file dated the same minute as the 1.2.1 deploy is strong
evidence the live file migrated v25 to v26 in that deploy, but it is inference,
not a read. Anyone who needs the live schema version should read it from a
terminal with Full Disk Access, or through the app.

---

## 2. THE DEPLOY TRAPS

Each of these has cost real time, and each fails by looking like success.

**FIXED 2026-09-07: a clean tree now deploys the committed state.**
`deploy-mini.sh` used to deploy only CHANGED files, so against a clean tree it
printed `nothing to deploy` and exited, which was repeatedly read as a
successful deploy. It now falls back to the committed file set and says
`working tree is CLEAN, so deploying the committed state`. The three outcomes
are separate banners and separate exit codes: `== DEPLOYED ==` (0),
`== NOTHING DEPLOYED ==` (2, and it spells out that the target was NOT
updated), `== DEPLOY FAILED ==` (1, or 3 for could-not-evaluate, 4 for a hash
mismatch). `--all` still forces the full set explicitly.

**The transfer is tar over ssh, NOT rsync, and this is deliberate.** Both this
Mac and the mini ship Apple openrsync (protocol 29, "rsync 2.6.9 compatible"),
not GNU rsync 3.x. openrsync handles `--files-from=- --relative` fine; what
breaks it is a remote destination containing SPACES, which the remote shell
word-splits, giving `server receiver mode requires two argument`. BOTH live
destinations contain spaces, so `--target live` could never work while
`--target v11` always did. That is the real cause of the 2026-09-07 failure,
not `--files-from`. tar over ssh has no such edge because the remote command is
one quoted string the script controls.

**Verification is now automatic and nobody has to remember it.**
`deploy-mini.sh` stages the files in one dir on the mini, sha256s the staging
area against this Mac BEFORE production is touched, copies into each
destination, then sha256s EVERY file on EVERY destination against this Mac, and
after a live restart re-hashes the server dir to catch the bundle revert. A
mismatch names the offending file and exits non-zero. A file the target cannot
hash becomes an explicit MISSING line rather than dropping out of the
comparison, because absent on both sides compares equal and that is how a check
silently verifies nothing. `deploy-mini.sh --verify-only` re-runs exactly that
check against a target without copying anything.

Never verify with `git rev-parse` on either side - that only reads back the same
claim the deploy already believes, it is not an independent measurement. For a
by-hand check outside the script, fetch the asset over HTTP and hash it against
the local file; the 2026-09-06 `5c88fdd` deploy was verified by
`GET /static/js/launchpad.js` and hashing, and that is the pattern to copy.

**A browser tab open across a deploy does not re-fetch static assets.** It can
run arbitrarily many releases behind while its API calls and its WebSocket keep
working perfectly. Hard-reload before believing ANY UI observation. One-line
check before chasing a server-side explanation for "my changes are not showing":
look for a STATIC-ASSET request from that client's IP after the restart
timestamp. If there is none, the fix is a hard reload, not the server.

**RESTART THE APP WITH `bootout` THEN `bootstrap`. NEVER `kickstart -k`.**
This file used to prescribe `kickstart -k` and that instruction was WRONG; the
correction is kept here rather than quietly swapped, and there is a matching
entry in section 10.

    launchctl bootout gui/$(id -u)/com.cloudecode.menubar
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cloudecode.menubar.plist

`kickstart -k` SIGKILLs Electron, which ORPHANS the python server still holding
port 8000. The app that starts back up fingerprints that orphan, `decideAdoption`
answers `mismatch`, and `server-manager.js` will neither start nor stop it: a
dead end wearing a correct log line. `bootout` lets the app's own teardown take
the server child with it. Measured across both 2026-09-10 bundle rebuilds: port
8000 free about **2 seconds** after bootout, `/health` back at 200 within **15 to
19 seconds** of the bootstrap. Sessions on `tmux -L cloude` are untouched by any
of it, confirmed by an unchanged session count both times.

**POLL `/health`, DO NOT SAMPLE IT.** On the 1.2.1 deploy the new process bound
:8000 immediately and did not answer for about **54 seconds**, because startup
work holds the event loop (`boot_readopt_complete` and `status_seed_warm` both
land after the socket exists). A single curl inside that window returns `000`
and reads exactly like a dead server. One probe at 32 seconds read 000 on a
deploy that was completely healthy.

    for i in $(seq 1 60); do
      printf '%s ' "$i"
      curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/health
      sleep 2
    done

**The supervisor still gives up after 3 unexpected stops,** and a dead server
can STAY dead while the page looks completely normal, because the UI gives no
signal when the server dies. The missing down-indicator is still an open item.
Recovery is the bootout/bootstrap pair above.

**`com.cloudecode.menubar` on port 8000 is the live agent.**
`com.cloudecode.v11` on 8001 was disabled 2026-08-31 (`launchctl bootout` plus
`disable`, plist left in place). `com.imc.cloude-code` does NOT serve this app;
Infrastructure `CLAUDE.md` hazard 40 names it wrongly and carries the correction.

**Staging cannot be click-tested.** It is TOTP-gated and credentials are not to
be entered. Verify on live, or by API.

---

## 3. THE LAG - FIXED 2026-09-07, and what is still open behind it

**The root cause was not where anyone was looking.** `PRAGMA integrity_check`
at `src/core/db.py:177` ran SYNCHRONOUSLY on the asyncio event loop inside the
`GET /api/v1/version` handler (`version_routes.py:207` -> `:178` ->
`db_health.py:94`), against a 4.5 GB `cloude.db`. The Electron tray polls that
endpoint every 20 seconds (`macOS/main.js`, `INTERVAL_MS = 20000`), and the
pragma re-verifies every page of every B-tree, so the loop was unavailable for
roughly 14 of every 20 seconds on an IDLE box, and the stall grew with the file.

**It was a REQUEST HANDLER ON A TIMER, not a background task.** That is exactly
why it survived several hunts: everyone was grepping for a loop. When you are
chasing a periodic stall, read what POLLS as well as what loops.

Confirmed twice, independently, BEFORE a line of fix was written: `py-spy dump`
mid-stall returned **17 of 17 stalled dumps byte-identical**, and the static
call chain says the same thing.

**Measured on live, before and after the deploy:**

| measurement | before | after |
|---|---|---|
| p99 | 14,505.7 ms | 13.3 ms |
| p50 | 30.5 ms | 5.2 ms |
| stall cadence | every 20.0s, lasting 14.5s | GONE |
| share of the window stalled | 86.5 percent | 0.0 percent |
| samples at the same poll rate | baseline | TRIPLED |

The tripled sample count is the measurement to trust, because it is
independent of the timing numbers: at an unchanged poll rate, more samples come
back only if the loop is free to answer them.

**13.3 ms IS NOT SETTLED, do not quote it as the number.** Later polls read p99
**64-72 ms** across two runs, and most recently **66-73 ms**. That is still
three orders of magnitude better than the 14,505 ms broken state and carries no
stall pattern, but it is about five times the figure recorded immediately after
the fix and it is NOT attributable. The corpus ingester was active during the
later runs; that is a hypothesis and it was NOT tested. Re-measure on a quiet
box before treating any single figure as the baseline.

The replacement design is in `CLAUDE.md` under "The daily database integrity
check": the pragma moved to a daily background loop that publishes a verdict
artifact, and the request path became one connect plus one small SELECT plus
one small JSON read. `tests/test_db_integrity_verdict.py` booby-traps every
binding of the helper, so a pragma cannot come back onto the request path
without failing the build.

**Still open behind it: the render path.** `renderProjectList()` does a
wholesale `innerHTML =` with NO signature guard, rebuilding 794 DOM nodes (385
elements + 409 text nodes) plus about 45 event listeners on every 5-second
tick, including while the launchpad is hidden behind a terminal. There is no
`clearInterval` anywhere in `launchpad.js` and the poller never pauses on tab
hide. Verify a fix by asserting the MUTATION COUNT, not that the signature
stopped changing - a signature that never changes and a renderer that ignores
it look identical from outside.

**Line numbers recorded for these have DRIFTED.** The TODO records
`renderProjectList()` at launchpad.js:3976 with the `innerHTML =` at :4120, and
the poller variously at :152 and ~387. Spot-checked 2026-09-07 on the `v1.1`
tip: `renderProjectList()` is at :4155, the wholesale `innerHTML =` at :4318,
the `setInterval` at :454, in a 6,069-line file, and `grep -c clearInterval`
returns 0. The facts hold; re-derive any line number before quoting it.

**Priority order now:** (1) the event loop is DONE. (2) the project-tree render
guard. (3) push updates over the existing websocket instead of polling. Note
for (3) that `src/api/websocket.py` carries NO project or session-list message
type at all - the websocket is per-session terminal I/O only, so there is no
push channel for state today and adding one is real work, not a config change.
Re-measure before designing it: the poll may not be the real cost now that the
loop is free.
---

## 4. IDENTITY - the model, and the identifiers that are not the same

**Three different identifiers, do not conflate them:** pin IDs, `cliSessionId`,
and transcript UUIDs. A pin ID can COINCIDENTALLY also exist as a real
transcript UUID. That happened with `8ae03490` and produced a confident wrong
conclusion that the Daily Briefing "was never a daily-briefing session". It maps
to `ce8c2dca`, a genuine briefing transcript, Aug 4 to Sep 1, 1,604 turns.

**Session identity is the triple `(tmux_socket, tmux_name, tmux_created_epoch)`
versus the durable `session_uuid`.** Not interchangeable. This is why tmux
resurrect/continuum needs a design pass rather than an implementation: a
restored session gets a NEW creation epoch and a naive restore orphans rows.

**`lifecycle='stopped' AND archived_at IS NULL`** is the Recent group.

**Group membership is DB-backed and travels between devices. Pinning and
within-group order are `localStorage` and are per-device.** A session that is
both pinned and grouped shows under Pinned where it was pinned and falls back to
its group elsewhere, which is the desired behaviour. `session_groups` HAS a
`position` column and a reorder endpoint; `session_group_members` does NOT, and
its primary key is `tmux_name` rather than `session_uuid`, which is a latent
defect (two sessions sharing a tmux name would share one membership row).

**`launchpad.js` launches new sessions with `project.path` (= `raw_path`), not
`root`.** A project-row correction that fixes only `root` is worse than nothing.
Recorded at :5599; spot-checked 2026-09-07 as `working_dir: project.path` at
:5871.

**cwd spelling matters, and it is the reason two junk project rows exist.**
`~/Development` is a symlink into iCloud and Claude Code derives its transcript
directory from the LITERAL cwd string, so two spellings of the same directory
produce two separate transcript dirs. Projects 3 and 4, `Mac (old path)` and
`Hirschfeld (old path)`, were retired 2026-09-03 for exactly this. Any
auto-derived path must use the resolved iCloud spelling. Always write the long
spelling in documents and in code.

**`sessions.claude_session_uuid` IS THE ROW'S COPY OF THE TRANSCRIPT UUID, AND
IT IS THE ONE THAT GOES MISSING.** It is what a restart resumes. Diagnosed
2026-09-08; the fix is committed as `8dd54a8` and NOT DEPLOYED, so on live all
of this is still true.

- **16 of 39 rows carry no uuid at all.** On the create path it has exactly ONE
  writer, Claude Code's `SessionStart` hook. An empty POST body becomes `{}` at
  `routes.py:2108`, `session_manager.py:4341` returns `LINEAGE_UNRESOLVED` and
  writes nothing. The live server log holds **25 such failures across 20
  distinct sessions**. The structural reason it never heals: `SessionStart`
  fires ONCE per conversation with no retry, while every other hook event
  repeats. That is why `last_work_at` recovers on the next event and the uuid
  never does.
- **The fallback ladder had never once fired on this machine.**
  `slugify_project_dir` (`claude_transcript_correlate.py:191`) mapped only `/`
  and `.`; the real rule maps EVERYTHING outside `[A-Za-z0-9-]` to a single
  `-`, verified against **908 of 919** live transcripts. Every one of the
  owner's paths contains a space and two tildes, so every slug it built was
  wrong. **A ladder that cannot fire is not a fallback**, and it is invisible,
  because a fallback that never matches looks exactly like one that was never
  needed.
- **`agent_type` does NOT share this cause.** 14 of 39 rows have `agent_type`
  NULL and a hook-written uuid, so backlog item 3 is a separate job.

**A uuid ON THE ROW IS NOT EVIDENCE A TRANSCRIPT EXISTS, and this is the trap
that will lie to you.** Over 39 rows: 16 absent, 18 sound, and **5 PHANTOM** -
a recorded uuid with no transcript on disk. All 5 collide, because the correct
uuid is already held by a sibling row split off by the cwd spelling trap above.
The pairs are **7 to 4, 9 to 11, 10 to 12, 38 to 39**.

Worked example, because the mechanism is the whole point. Row 7 is LIVE, its
`working_dir` is the SHORT symlink spelling, and its uuid
`db81f6bf-85f9-448b-a7f6-bc83f62659d9` exists nowhere. Row 4 is ARCHIVED,
carries the long iCloud spelling, and its uuid `82854c0e-...` has a transcript
that is **73,190,422 bytes**. The live pane is literally running
`--resume 82854c0e-... --fork-session`. **`--fork-session` MINTS A NEW uuid**,
the hook recorded that new one, and the forked transcript never materialised.
So the picker truthfully said "no transcript for db81f6bf" about a uuid with
nothing to do with the conversation the user was in, while the real
conversation sat on the archived twin. **The message was locally correct and
the conclusion a reader draws from it is wrong.** "Media Compression's
conversation is gone" was that wrong conclusion, and it was wrong.

**The backfill tool exists and has NEVER WRITTEN ANYTHING.**
`scripts/backfill_claude_session_uuid.py` is dry run by default. Its run over
the live corpus: **8 confident FILLs** (rows 14, 15, 16, 17, 19, 23, 24, 25),
**0 confident REPLACEs**, **8 ambiguous** (rows 26, 27, 30, 31, 33, 35, 40, 42,
at 45 to 78 candidates each), **1 no-candidate** (row 41, whose `working_dir` is
literally `/Users/jsugamele/Development/ses_ee8d919b`), and the 4 collision
pairs. It resolves both cwd spellings FORWARD, by slugifying every spelling
found in a HOME symlink scan, AND BACKWARD, from each transcript's own recorded
cwd canonicalised. The backward direction is not optional: **754 of 919
transcripts sit in a directory that disagrees with their own recorded cwd.**

Two matcher defects were caught by CONTROLS rather than by reading, and both
would otherwise have shipped looking correct. Directory agreement was clearing
a two-signal bar as ONE FACT CORROBORATING ITSELF, so evidence is now counted
in independent FAMILIES. And the negative control (a row pointed at a project
that does not exist, with real transcripts present) initially returned
`ambiguous` instead of `no_candidate`, because timing alone was counting as
evidence; an ANCHOR GATE now lets timing and title CORROBORATE a candidate and
never CREATE one. **A matcher that always finds something is worse than
useless.**

**CloudeCode only manages tmux sockets it owns.** A session resumed by hand on
the `default` socket is invisible to it, and tmux cannot move a pane between
servers. The only route back is to let the foreign copy exit and resume the same
transcript inside the CloudeCode pane.

---

## 5. WRAPPERS AND THE RESPAWN LADDER

Wrappers live under `agents.wrappers` in `config.json` and are rendered to
`~/Library/Application Support/CloudeCode/agent_wrapper_scripts/<id>.zsh`.

**A hand edit to `config.json` is NOT seen.** `Settings.load_auth_config` caches
in `_auth_config_cache`, so the running server keeps the old view. Add or change
a wrapper through `POST /api/v1/agents/wrappers`, which keeps the file and the
in-memory cache in agreement.

`claude-chrome` exists as of 2026-09-06:
`command claude --dangerously-skip-permissions --chrome "$@"`. Project
"Fantasy Football 2026" (project 17) has `projects.default_agent_type =
'claude-chrome'`; the default `claude-skip-permissions` was deliberately left
untouched so only that one project changed. Revert SQL is on the mini at
`~/football_chrome_revert.sql`.

**The respawn ladder gates on tmux's `#{pane_start_command}`.** A pane born as a
bare shell has that field EMPTY, so the ladder lands on `RESPAWN_SHELL` and an
UNPICKED restart hands back a LOGIN SHELL instead of claude. A session needs
BOTH a non-empty `pane_start_command` AND a stored `agent_type` to reach
`RESPAWN_AGENT` on its own. Row 40 (`Agent - Infrastructure`) was staged
deliberately with both, and was the first session on the box that would restart
correctly unaided.

**RESTATED 2026-09-08, because this was misstated once already.** Two facts,
and quoting only the first is what caused the confusion:

- **18 of 22 live sessions have an empty `#{pane_start_command}`** (measured
  2026-09-08; it read 15 of 19 on 2026-09-07, the population moved).
- **An explicit wrapper choice OVERRIDES that gate**
  (`src/core/session_respawn.py:542`). Picking a wrapper in the picker starts
  the agent properly.

So only an UNPICKED restart lands on the shell rung. Do not write "the restart
button gives you a shell" without the second half.

**UPDATE: the gate is no longer silent, and an explicit choice now beats it.**
Two things changed together.

`GET /sessions/restart/preview` (`src/api/restart_routes.py`) answers which rung
a session would land on WITHOUT acting. It reports the rung twice, because they
are two different questions: `unchanged` is what a restart does right now (for a
live pane, `not_dead`), and `projected` is what the session would come back AS
with liveness ignored (`project_restart_rung`, never `not_dead`). `pane_state`
carries liveness as its own fact. **A projected rung is a PREDICTION, NEVER A
PERMISSION** - it exists so the picker can say "this one would come back a plain
shell" about a session that is still running, which on this box is the whole
interesting population.

`POST /sessions/respawn` now takes an optional `agent_type`. It is an ID, never
a command: it is checked against `agents.wrappers` and an unconfigured id is a
400 rather than a silent fall back to the default wrapper
(`src/core/session_agent_choice.py`). An explicit choice OUTRANKS the
`pane_start_command` gate - the gate exists because a STORED `agent_type` is not
evidence of intent, and a wrapper the user just picked in a panel is. It does
NOT outrank `not_dead` or an unanswered probe. On a verified-alive restart the
choice is written to `sessions.agent_type`, which is the hand edit this replaces.

A sixth rung exists now: `RESPAWN_TRANSCRIPT_MISSING`. A REPLAY hands tmux back
its own start command, and 3 of the 19 live sessions on the box carry an
explicit `--resume <uuid>` in theirs, so a replay CAN re-run a resume against a
transcript that has since been deleted. `resume_uuid_in` extracts it and the
caller checks it through `session_transcript_presence`; a DEFINITE absence
refuses, `unchecked` never does. The preview applies the same guard, so the
picker cannot promise a replay the restart then declines.

The picker is `client/js/session-restart-picker.js`; the reopen is
`client/js/session-restart-return.js`; the option list was extracted to
`client/js/session-restart-options.js` (350 lines) in `0793eb1`, which also
takes the picker back under the 500-line rule.

**The picker's option text painted over the next row, and that fix is NOT
deployed (`0793eb1`).** Option rows inherited `flex-shrink: 1` inside a
`max-height: 46dvh` flex column, so the flex algorithm SQUASHED THE ROWS
instead of scrolling the list. Measured: 113px of content in a 62px box on
desktop, 145px in a 58px box on a phone. The fix is `flex-shrink: 0`. It is
verified by GEOMETRY, not by DOM text: `tests/test_restart_picker_geometry.py`
asserts no row's text intersects another row's title, and it was PROVEN TO FAIL
on the old code with 19px of text sitting on text. This matters more than a
cosmetic fix looks, because the picker is the only route to `--chrome` browser
control (section 9).

**UPDATE 2026-09-07: restarting a LIVE session IS built (item 22 part 2).**
The owner's two calls collapsed it - "same tmux should be fine" and "yes
resume the same session" - so it is `respawn-pane -k` in place, not
close-and-recreate. No row is minted, so nothing is re-carried and the
`session_group_members` primary-key defect is sidestepped rather than hit.

Four gates, and none of them is derivable from the projection: the row only
offers restart on a status positively known live (`unknown` gets close alone);
the picker's arm checkbox arrives unchecked and takes no argument; the confirm
modal names the bare-shell outcome (measured: 15 of 19 live sessions come back
a login shell); and the request must carry `confirm_restart_live`.
`RespawnPlan.kills_live_pane` is the single field that makes anything pass
`-k`, and `project_restart_rung` has no liveness input so it can never set it.

**UPDATE 2026-09-07 (later): A RESTART NOW RESUMES, ON EVERY RUNG THAT
CAN.** The owner defined it: "restart on recent is really just resume.
restart on open is close and resume session so it loads a new wrapper or
new claude binary." `f95a9ed` delivered that only on the REPLAY rung, by
accident of what tmux had recorded; the AGENT rung re-derives through
`get_agent_command` and carried no `--resume`, so it started a FRESH
conversation wearing the old name. `sessions.claude_session_uuid` now
reaches the command via `extra_args`, built once in
`src/core/session_resume_target.py` and threaded into all four command
resolutions (stored agent and every wrapper offer, action side and
preview side) so the two cannot render different strings.

`RespawnPlan.conversation` and the preview's `conversation` field carry
`resumed` / `none_recorded` / `unknown` - the same vocabulary
`RestartSessionResponse.conversation` already used. A NULL uuid is
`none_recorded` and is SAID, never a quiet fresh start; an unreadable row
is `unknown`, injects nothing and claims nothing. The value is derived
from the argv, so the claim cannot outrun the command. The transcript
guard now covers the agent rung on both paths, and the preview keys
presence verdicts by uuid because two rungs can resume two different
conversations.

ONE DRIFT FIXED ALONG THE WAY: `_agent_command_for_tmux_name` read
`agent_type` from `self.sessions` while `restart_preview` read it from the
ROW, so an ADOPTED session (in-memory `agent_type` None, row records the
wrapper) previewed as AGENT and restarted as REPLAY. Both now go through
`_stored_agent_type_for_tmux_name`.

**Identity across the kill is MEASURED.** tmux 3.7c, scratch socket: same
`#{session_created}`, same `#{pane_id}`, new `#{pane_pid}`. The triple does not
move, so the fourteen triple-keyed queries keep matching.
`src/core/session_instance_rekey.py` takes the epoch either side anyway and
answers `unchanged` / `rekeyed` / `cannot_determine` - a measurement that can
stop being true is not a thing to assume.

Related, backlog item 3: every session created via `auto_start_claude:false`
plus a hand-sent claude command lands with `sessions.agent_type` NULL,
because the agent_type wrapper only applies on auto-start. The flag IS on
the running process. **PARTIALLY CLOSED 2026-09-08 late round (`41382ee`):**
`session_agent_infer.py` now infers the wrapper from the process's own argv
and fills it, run at boot, at adopt, and on a session's first hook. Live run
found 0 rows to fill - all 19 live panes already carried `agent_type` by the
time it shipped. **Still open:** the inference is one-shot; nothing re-checks
a session that was already live when this landed, so a periodic sweep is the
remaining piece.

---

## 6. KNOWN FALSE GREENS CURRENTLY LIVE IN THE PRODUCT

Each with its mechanism, because the mechanism is what tells you whether your
fix covers it.

**A FAILED WRITE IS INVISIBLE TO A SIGHTED USER, AND IT IS ON LIVE 1.2.1
TODAY.** Found 2026-09-11 because the owner clicked "new group" on the 1.3.0
preview and reported it broken. It was not broken: the preview correctly
REFUSED the write and said so, and he could not see the refusal. The sentence is
produced correctly and reaches the page verbatim - announced through
`session-sidebar-group-actions.js`'s `announce()` into `#session-sidebar-live`,
which the stylesheet clips to `width:1px; height:1px; clip:rect(0,0,0,0)`.
That element exists for assistive technology. **So a screen reader user HEARS
the failure and a sighted user gets SILENCE**, which is the opposite of the
usual defect. Measured on four of four controls driven: sidebar group create,
group rename and delete from the menu, launchpad archive, launchpad restart
picker. In every case the live region read the full sentence while nothing
rendered. Not every control was driven; four were, four swallowed. This is the
LEGACY sidebar and launchpad error path, so the rewrite did not introduce it and
the rewrite does not fix it either - the sidebar is deliberately outside the
launchpad migration. The fix is to route `announce()`'s ERROR path to a toast
while KEEPING the live-region announcement; replacing the live region would
regress the screen-reader path to match the visual one.

**A row reads `running` over a pane whose agent has exited.** The SessionEnd
hook is cancelled on every clean exit - it fires while claude is tearing down,
its command is a `curl -sS -m 2`, and claude cancels pending hooks as it exits.
`reconcile_lifecycle` CANNOT cover for it, because that reconciles against the
TMUX LISTING, and a pane whose claude exited still has a live tmux session.
Measured 2026-09-06 between an `/exit` and a relaunch: tmux alive, no claude
process, row 39 still `lifecycle = running`. Seen again 2026-09-07 with row 40
reading `running` while its pane was DEAD (exited status 0). Two independent
routes to the same wrong answer, so a fix must reconcile against the PANE and
the agent, not the listing.

**CLOSED, item 4. `activity_state` no longer reads `working` after a resume -
measured at 0 seconds, not four minutes.** This entry originally reported the
defect as real and self-clearing; that was itself wrong, and the correction is
worth keeping because the mechanism is instructive. A real `--resume` fires
exactly one hook (`SessionStart`, +0.48s) and `SessionStart` was never one of
the events that stamps the working heartbeat, so a bare resume cannot expose
`working` at all - the historical ~4-minute observation is now understood to
be the (separately fixed) `SubagentStop` heartbeat re-arm landing on the turn
that happened to precede the resume, not anything the resume itself does.
Reproduced 3/3 runs with `CLOUDE_REAL_HOOK_TESTS=1` driving a real claude; see
`TODO.md`'s dated "item 4 measured" entry for the harness and the numbers.

**The UI gives NO signal when the server dies.** Covered in section 2. It is the
same family as the two above: an absence of bad news rendered as good news.

**THE 2026-09-07 INCIDENT: a session the owner closed and restarted vanished
from every view.** Fixed in `c9271da`, which IS deployed. Two independent
causes, and both are the shape this section is about:

1. **The restart resumed a `claude_session_uuid` whose transcript did not
   exist**, so the pane died instantly with **status 127** while the row still
   read `lifecycle=running`. This is the incident that bought
   `RESPAWN_TRANSCRIPT_MISSING` and `refuse_if_transcript_missing`.
2. **Close set `archived_at`.** Recents is
   `lifecycle='stopped' AND archived_at IS NULL`, so a closed session missed
   Recents and was then in no list at all.

**The hand recovery is recorded because it changed live data.** The pane was
respawned onto the correct transcript, and two rows were repaired in the live
database: **row 42** was emptied and retired (`claude_session_uuid = NULL`,
archived), and **row 43** took the live tmux linkage (`archived_at = NULL`,
`lifecycle = running`, `tmux_name = cloude_Agent_-_Cloude_Code`,
`tmux_created_epoch = 1788813811`). The repair had to CONSOLIDATE rather than
copy, because `claude_session_uuid` is UNIQUE and two rows cannot hold the same
value. Rollback SQL is on the mini at `/tmp/cc_row_rollback.sql`; `/tmp` is not
durable across a reboot, so treat that file as expiring rather than as an
archive.

**The archived-projects notice used to be one of these and no longer is.**
`loadProjects()` latched `_archivedFetchOk = false` on the error path and
returned WITHOUT re-rendering, so the screen kept the last successful paint and
read `showing archived: 1` after a failed fetch. Fixed in `5c88fdd`. The lesson
is the reusable part: **the three-outcome state existed in the MODEL and never
reached the SCREEN.** Latching a third state is not the same as rendering it.
Assert on the DOM, not on the variable.

---

## 7. HOW TO VERIFY ANYTHING HERE

**THE THREE-OUTCOME RULE.** Every check has three outcomes: pass, fail, and
could-not-evaluate. The third is not a flavour of the other two. Collapsing it
into pass invents a verdict nobody measured; collapsing it into fail burns the
alert's credibility until people stop reading it. Name the third state out loud
(`CANNOT DETERMINE`, `unreachable`, `unknown`) and make it reach the roll-up.
Ask of anything you write: what does this return when the thing it measures is
unreachable, absent, or was never created? If the answer is the same as when
everything is healthy, it is not finished.

**Run a POSITIVE and a NEGATIVE control before trusting a measurement.** A count
of zero from a query that has never been shown capable of returning non-zero is
a CANNOT DETERMINE, not a pass. Two real instances from this work:

- **The `--chrome` flag test.** `claude --chrome --version` AND
  `claude --chrom --version` both exit 0 and print the version, because
  `--version` short-circuits before option validation. A flag test that passes
  for a flag that does not exist is not a flag test. The real test is
  `claude --chrom mcp list` returning
  `error: unknown option '--chrom' (Did you mean --chrome?)` while
  `claude --chrome mcp list` runs.
- **The `pgrep -P` safety guard.** A recovery script's guard - "refuse if a
  claude is still running under the default socket" - was built on
  `pgrep -P <pane_pid> -f claude`. In the Claude Code sandboxed shell,
  `pgrep -P` returns NOTHING even when `ps -eo pid,ppid` plainly shows the
  child. `pgrep -x zsh` works, so pgrep itself runs; only `-P` is blind. The
  same call over `ssh` DID return children, so it is a property of the local
  shell, not the machine. The guard reported the coast clear and the script
  started a SECOND claude on a transcript another process was still writing.
  Rewritten on `ps -eo pid,ppid,command`, and proven in both directions: with
  the other claude alive it REFUSES and names exactly one pid; against a
  snapshot with that pid removed it PASSES. **A guard that cannot fail is worse
  than no guard.**

Two more environment-specific traps, both of which manufacture false results
inside the verification step itself:

- **A Chrome MCP tab reports `document.hidden === true` even when fronted.**
  That freezes rAF, so a settle loop never resolves, a CSS transition stays at
  `currentTime: 0` and `getComputedStyle` reads the pre-transition value
  forever, and physical clicks do not reach the element at all (while
  `element.click()` does fire the handler). Assert `!document.hidden` before
  trusting any measurement through it, or measure in a headed Playwright
  chromium instead.
- **Never re-run an init function to test whether it ran.** Calling
  `initArchivedVisibleToggle()` again attached a SECOND listener, so one click
  fired both handlers, flipped the state twice and landed back where it started,
  which reads exactly like a dead control. The wiring had been correct the whole
  time. Re-running an init mutates the thing you are measuring.
- **Running `tests/real_hook_app.py` as a standalone script, not through
  `pytest`, skips `conftest.py`'s autouse socket guard.** The guard is what
  redirects a real-hook test off the user's live `cloude` tmux socket onto a
  throwaway one; a bare script never gets it installed. This actually happened
  during the item-4 resume-timing measurement: the first run created a REAL
  session (`cloude_ses_1d468a9a`) on the user's live socket, alongside his 19
  other real sessions. Caught in the same turn (the stray pane was idle on the
  trust dialog, killed by name, confirmed gone, nothing else touched) but it
  should never have been possible. **Always run the real-hook harness through
  `pytest`, never as a bare script.** If a standalone driver is ever needed,
  it must call `tests.socket_guard.install_default_socket_redirect()` and
  `install_subprocess_guard()` itself before creating anything, verify the
  resolved tmux socket name is actually NOT `cloude` before proceeding, and
  tear both down in a `finally`.

**A DOM-text assertion cannot see whether a glyph actually rendered.** Where a
defect is visible to a human, the test has to fail on the pixel: a computed
style check, a measured bounding rect, or a screenshot someone looks at.
`textContent` and element-presence assertions prove the DOM is right and prove
nothing about what rendered.

**Verification against a live system the owner is using is READ-ONLY by
default.** If a check genuinely requires mutating state to observe an effect,
record the value before you touch it, restore it after, and SAY in your report
that you did both. The 2026-09-06 archiving verification did exactly that: the
mutation was recorded before it was made and reverted after, and the report says
so. An earlier session cycled all 23 themes against the live app and left the
owner's theme on whichever one it stopped at, with no prior value on record to
restore.

**Tests and syntax, RE-MEASURED 2026-09-11 for this rewrite.** Run
`venv/bin/python3 -m pytest -q -p no:randomly` from the repo root; system
python3 has no fastapi.

| suite | branch | result | who measured |
|---|---|---|---|
| pytest | `release/1.2.1` | **5,708 passed / 2 failed / 19 skipped** in 214.5s | re-measured 2026-09-11 |
| node (`tests/*.node.mjs`, globbed as CI does) | `release/1.2.1` | **200 suites, 200 pass, 0 fail** | re-measured 2026-09-11 |
| `scripts/ci/check-js-syntax.sh` | `release/1.2.1` | **227 files parsed cleanly** | re-measured 2026-09-11 |
| pytest | `feat/backend-decomposition` @ `19ac32d` | 6,520 passed / 2 failed / 54 skipped, 6,576 collected | on record |
| vitest | `feat/svelte-slice-7` @ `f28faef` | 1,334 | on record, see the caveat below |

The two pytest failures are the known environmental pair and are NOT yours:
`test_home_write_guard.py::test_guard_refuses_the_real_claude_settings_path_by_name`
and `test_version_probe.py::test_current_version_empty_when_unresolvable`.
`test_state_dir_resolution.py`, which older copies of this file name as a third,
now passes.

**`CLAUDE.md` carried 5,656 / 2 / 19 and "197 node suites" until this rewrite,
and both were stale** by the row-menu round. Corrected in the same change. Take
your own baseline on a clean tree before you judge your own run; this figure has
now been stale three times.

**The vitest figure is the one number in this table I could not re-measure.**
1,334 is what the slice 7 record states at commit `f28faef`. Two commits landed
after it on that branch (`b79605d`, the two browser-proof fixes, and `82b8cb2`,
docs) and neither re-recorded a count. Re-measure with
`cd web && npm ci && npx vitest run` before quoting it. The owner's own summary
of this session said 1,335; the written record says 1,334, and neither of us has
measured the branch tip.

**A fresh `git worktree` has NO `config.json` (it is gitignored), and its absence
manufactures 19 failures plus 26 errors** - 401s from the test client and
FileNotFoundError from the route tests, every one of them an app that could not
start, every one of them clearing the moment the file is copied in. Do not
attribute a failure to a code change until the same run has been done on the
base commit in the same directory. A worktree may also need its `venv` symlink
recreated; the repo `venv` is a symlink to `venv.nosync` and a worktree does not
inherit it.

**A broken `venv` symlink lets the suite limp along UNDERCOUNTING rather than
failing outright.** That is how the baseline in `CLAUDE.md` was once stale by an
order of magnitude (4,647 against a real 5,491). If the number you see looks
nothing like the table above, check the symlink before you believe it.

**One test is measured FLAKY under a full run:**
`test_respawn_refreshes_pane_env.py::test_the_session_environment_itself_is_updated`
drives the real `cloude` tmux socket. A lone failure there with no code change
behind it is not a regression; re-run before chasing it.

`node --check` every JS file you touch. `CLOUDE_REAL_HOOK_TESTS=1` opts in to
`tests/test_led_real_hooks.py`, which launches a REAL claude on a throwaway
socket; it spends real Claude turns and about 50 seconds and is the only test
that measures the LED against a live agent.

---

## 8. CURRENT GIT STATE - the branch map, and what is done versus in flight

The main checkout sits on **`release/1.2.1`**. That is the release line and the
only thing that has ever been deployed. Everything else listed here is work that
exists only as a branch.

**REMOTES, and the rule is easy to get backwards.** `adamdev`
(`Adoom666/CloudeCodeDev`) is the PRIMARY development repo and the only issue
tracker either side has; `origin` (`ccsliinc/CloudeCode`) is the backup mirror
AND the public distribution point, because it is the public repo and the one
carrying published releases. "Primary" means development, not distribution.
**NEVER push to `upstream` (`Adoom666/CloudeCode`)**; its push URL is the
sentinel `DISABLED_do_not_push_to_Adoom666_CloudeCode` on the owner's clone and
must never be repaired. Push order for new work: `adamdev` first, then `origin`.

### The branch map

| Branch | What it holds | State |
|---|---|---|
| `release/1.2.1` | what live runs, `v1.2.1` tagged and published | DEPLOYED |
| `release/1.2` | the 1.2 merge, `v1.2.0` tagged and published | superseded |
| `feat/svelte-slice-7` | the whole client rewrite, slices 1 to 7 | DONE, unmerged, undeployed |
| `feat/backend-decomposition` | the whole backend rewrite, 13 slices | DONE to S7, unmerged, undeployed |
| `docs/backend-plan-v2` | the plan those slices follow (`.claude/notes/backend-decomposition-plan.md`) | reference |
| `docs/plugin-policy` | the TIP of the governance line: `docs/DECISIONS.md`, `docs/KEPT-BEHAVIOURS.md`, `docs/kept-behaviours/ccsliinc.md`, the guard | unmerged |
| `feat/work-protocol` | the ancestor of the above; do not read it instead of `docs/plugin-policy` | superseded by it |
| `docs/repo-of-record` | the adamdev-is-primary ruling and the mirror record | unmerged |
| `fix/update-checker-target` | both update checkers repointed, 33 draft releases deleted | unmerged |
| `docs/team-workflow` | the Issues-plus-Projects evaluation | unmerged, a proposal |
| `docs/handoff-restart-fix` | the kickstart correction; its `docs/deploy-mini.md` hunk is now on THIS branch | partially absorbed |
| `feat/i18n-foundation`, `feat/svelte-slice-2..6`, `feat/svelte-1.3*` | the intermediate slice branches | history, all in slice 7 |
| `main` (local) | `fd9e0a8`, 321 commits BEHIND `origin/main` | do not treat as current |
| `coord` | the retired orphan coordination branch | FROZEN, nothing new goes there |

**`docs/DECISIONS.md` DOES NOT EXIST ON `release/1.2.1`,** and neither does
`docs/KEPT-BEHAVIOURS.md`, `docs/kept-behaviours/` or `.claude/skills/work/`.
They live only on the docs branches above. So the governance documents that bind
both developers are invisible to anyone who reads only the release line. That is
worth fixing and it is a decision, not a chore: merging those branches is a
separate act from merging the rewrites.

**FOUR UNMERGED BRANCHES EACH EDIT `docs/DECISIONS.md`.** `feat/work-protocol`
started it, `docs/plugin-policy` and `docs/repo-of-record` each appended to the
same blob deliberately so they merge clean, and `fix/update-checker-target`
carried the blob across again. Read them in commit-time order before believing
any single copy: `feat/work-protocol` 14:34, `docs/plugin-policy` 15:21,
`docs/repo-of-record` 15:43, `fix/update-checker-target` 16:14, all 2026-09-10.
Where two disagree the later one wins, and the update-checker entry is the one
that disagrees with an earlier one.

### DONE, measured

**1.2 shipped.** Two divergent lines merged onto `release/1.2`: the owner's
`v1.1` and Adam's `adamdev/master` at `887b8fc`. 17 conflicted files, resolved
one at a time against six owner decisions (section 9). The auto-merged files
were the more dangerous half: FOUR of them merged cleanly and CONTRADICTED a
decision. Tagged `v1.2.0`, deployed, Electron bundle rebuilt at 1.2.0.

**1.2.1 shipped, and it is a performance release.** Adam's session-listing work
merged, plus two gaps of ours, plus his mute and theme fixes, plus one reconciled
row menu. Measured on live before and after, on the mini against loopback, on
record:

| measurement | 1.2.0 | 1.2.1 | change |
|---|---|---|---|
| `sessions/list` p50 | 272.9 ms | 83.0 ms | 3.3x faster |
| `/health` p50 while a listing is in flight | 175.8 ms | 23.4 ms | 7.5x |
| `/health` p50 quiet | 34.4 ms | 31.4 ms | flat |
| listings completed in the probe window | 33 | 68 | about 2x |

**The finding is the head-of-line blocking, not the p50.** On 1.2.0 a no-op
`/health` cost 175.8 ms under load against 34.4 ms quiet, a 5.1x penalty for
being unlucky about timing. On 1.2.1 there is no measurable penalty at all. The
confounder cuts the right way: the AFTER server had been up 4 minutes against
2.7 hours, so its caches were COLDER. The doubled completion count is the
number to trust because it is independent of the timings.

Tagged `v1.2.1`, deployed, Electron bundle rebuilt at 1.2.1, and both `v1.2.0`
and `v1.2.1` PUBLISHED on `ccsliinc/CloudeCode` with the CI-built DMG, a sha256
and a "how to go back" block. **Verified as a downloader, not as an uploader:**
each asset was fetched back from its public unauthenticated URL after publishing
and re-hashed, and both matched. A silently truncated upload is the failure that
only shows up when somebody actually needs to downgrade.

**The client rewrite is COMPLETE on `feat/svelte-slice-7`.** Seven slices.
`client/js/launchpad.js` is DELETED: **6,526 lines on `release/1.2.1`, absent on
`feat/svelte-slice-7`** (re-measured). Svelte 5 plus TypeScript plus Tailwind
built by Vite into a COMMITTED fixed-name bundle at `client/dist/app.js` and
`app.css`, so `client/` still has no build step at serve time. Re-measured on the
branch: **26 `.svelte` components, 109 `.ts` files, 47 test files** under
`web/src`. With it: one string catalog both trees read
(`client/js/i18n/catalog.en.js`, a plain ES module of flat dotted keys, with a
pseudo-locale as the coverage test), a typed build-time plugin surface registry
with FOUR surfaces (`session-card-action`, `launchpad-panel`, `sidebar-item`,
`status-source`) and mark-unread as its first plugin, and a TypeScript port of
the status LED with a drift guard pinning it to the shipped legacy module.

**The backend rewrite is at S7 of 9 on `feat/backend-decomposition`,** 13 slice
commits across TWO plans. Re-measured across the branches:

| file | `release/1.2.1` | `feat/backend-decomposition` |
|---|---|---|
| `src/core/session_manager.py` | 8,340 | **7,294** |
| `src/api/routes.py` | 4,387 | **106** |
| `src/config.py` | 2,112 | a package, `src/config/` (23 modules) |
| `src/models.py` | 2,495 | a package, `src/models/` (17 modules) |

The shape is a composition root, `src/core/composition.py::build_services`,
which constructs every collaborator in dependency order and hands back a frozen
`AppServices`; `lifespan` calls it and puts the result on `app.state.services`.
FOUR typed `Protocol` ports at the genuine substitution points, in
`src/core/sessions/ports.py`: **`Clock`, `SettingsReader`, `TmuxReader`,
`SessionRecordStore`**, with live implementations in `src/core/live_ports.py`.
`src/api/routes.py` is now an aggregator of about forty sibling route modules.

**Process changed too.** Coordination moved off the `coord` orphan branch onto
Adam's GitHub issue plus draft-PR protocol (`.claude/skills/work/`, on the docs
branches): an assignee is a declaration with nothing behind it, a draft PR has a
branch and a commit, and ties resolve by lowest PR number because that counter is
monotonic and server-side. A core-versus-plugin policy landed with a MECHANISM
rather than a norm: `scripts/check_kept_behaviours.py` plus
`tests/test_kept_behaviours_guard.py`, where each kept behaviour declares short
literal ANCHORS and the guard fails when one is gone. Replayed against the tree
of `8898f07` it names all FOUR behaviours that week's two removals took, and says
nothing about the other four entries. gitleaks is a second scan gate beside
`scripts/scan_secrets.py` (`gitleaks 8.30.1` present locally, re-measured). And
**33 stale draft releases were deleted from `ccsliinc/CloudeCode`, reclaiming
4,095,684,007 bytes (3.81 GiB)** - addressed by RELEASE ID and never by tag,
because `v1.0.31` exists twice and a tag-addressed delete there could have taken
the published twin. A release object is not a tag, and that was PROVEN: the
`git ls-remote --tags` listings from both remotes diff empty before and after.

### IN FLIGHT

- **`integration/1.3.0`** is being assembled as this is written: the merge of
  `feat/svelte-slice-7` with `feat/backend-decomposition`. It did not exist as a
  ref on either remote at 2026-09-11 10:00. Check for it before assuming.
- **Backend v2 S8** (the adoption and create paths) and **S9** (delete
  `session_manager.py` outright, not empty it). S8 is the highest-risk slice and
  is held for the 1.3.1 round.
- The governance and update-checker docs branches, all unmerged, listed above.

### BLOCKED, and by what

- **S8 is blocked on Adam's open issues #28 and #32**, both still labelled
  `blocked` at last check. The plan text says #28; the release plan in
  `TODO.md` says #32 and names `_session_info_for`. Both numbers appear in the
  record and I did not resolve which is the real blocker; check GitHub.
- **The kept-behaviours policy is symmetric on paper and one-sided in
  practice.** `docs/kept-behaviours/ccsliinc.md` has 8 entries; Adam has no
  file, so a commit of OURS that removes something of his fires nothing. Asked
  for on `Adoom666/CloudeCodeDev` #63 and #15; no answer on record.
- **1.3.1 (the Adam integration) is deliberately blocked behind the owner
  actually USING 1.3.0.** His master is 153-plus commits past our 1.2.1 base and
  most of it lands in client code we deleted or rewrote, so it is a DESIGN
  merge, not a textual one. Doing it first means two unknowns at once.

### WHAT TO DO FIRST NEXT SESSION, in this order

The short version of this list, plus the traps, is `.claude/notes/NEXT-SESSION.md`.

1. **Verify live actually equals what you think before touching anything.**
   `./scripts/deploy-mini.sh --verify-only --target live`. The trap is in the
   flag: `--verify-only` WITHOUT `--target live` checks the v11 staging target
   by default and reports `== DEPLOY FAILED ==` for the live one, so a bare run
   verifies a target nobody asked about.
2. **Find out whether `integration/1.3.0` exists and what it contains.** If
   another agent finished it, validate the combined tree with per-chain controls
   so any regression is attributable to one side.
3. **Take the database backup to archive-nas. It is a GATE, not a chore** - see
   section 9. `VACUUM INTO`, never `cp`; sha256 both ends.
4. **Run THE TWO LIVE BOOT CHECKS after deploying 1.3.0.** No suite substitutes
   for them, and they are what caught the 22-rows-for-21-panes defect:
   `boot_readopt_complete`'s held plus skipped against
   `/opt/homebrew/bin/tmux -L cloude list-sessions | wc -l`, and the
   `/sessions/list` row count checked SEPARATELY from that log line. The backend
   slices touch the boot re-adopt path and have NEVER run against a live server.
5. **Then the open list**, roughly in value order: the visible-error-path bug in
   section 6 (it is on live today); the away-bar layout bug; the seven manual
   pixel harnesses that still load the deleted `launchpad.js`; the websocket
   push channel (`src/api/websocket.py` still carries no project or session-list
   message type, so state is polled - re-measure whether polling is still the
   cost now the loop is free); the four remaining name-keyed per-row datastore
   readers on `/sessions/list` (`test_listing_pass_datastore_cost.py` pins the
   ceiling at `4N + 2`); the two `src/` files over 500 lines that the rewrite
   will NOT delete (`session_notification_policy.py` 563,
   `notifications/idle_watcher.py` 513); the periodic agent-infer sweep; toast
   history being process memory only; `--name` dropped on a restart's resume;
   `FALLBACK_PROJECTS_ROOT` hardcoding `/Users/jsugamele`.

### HAZARD: many agents, one branch, and a rebase that proves nothing

Eight to ten agents committed on one branch in a single day during the
2026-09-08 round, and two incidents came out of it: a stale-tree commit
(`3732bdf`) that reverted 15 files of unrelated LED work, and a
`git reset --hard` that dropped a commit outright. **The rule: every agent builds
its commit from HEAD plus its own hunks via a private git index, verifies
`git diff <base> --stat` shows only the paths it actually touched before
committing, and never runs `git reset --hard` on a shared branch.**

This session added the harder version of the same lesson: **a clean merge or
rebase is not evidence.** The dangerous staleness never conflicts. It showed up
three times in one week - four files that auto-merged and contradicted an owner
decision; an auto-merged hunk repointing `session-sidebar-clicks.js` from the
KEBAB to the ROW, which would have handed `runRestart` a `null` and made every
restart report "unknown" with nothing failing; and the `data-row-status` versus
`data-row-menu-status` spelling, where a validator mutated the reader back to
the old name, ran all 200 node suites, and got ZERO failures.

---

## 9. OWNER DECISIONS - the settled ones, then the ones still open

The settled ones are not to be relitigated. Rulings that bind BOTH developers
also live in `docs/DECISIONS.md` on `docs/plugin-policy`; that file is the
shared record and this section is the local one.

### Settled, standing

- Sync stays iCloud. His words: "i want icloud" / "stay with icloud".
- He will not work the same session on two computers.
- `OP_SERVICE_ACCOUNT_TOKEN` rotation is deferred by his explicit decision:
  "not until we finish this project. because it will happen again."
- Codex OpenAI sign-out is his: "ill take care of that part when ready."
- The RSA private key and `MESH_PASS`: "put it in the backlog."
- Merging the `(old path)` project rows directly in the database is authorised:
  "this is a me thing it can be done via database". Take a verified backup
  first.
- Installing the browser extension for `--chrome` is his call.
- CloudeCode DB copies in the NAS archive: "no i dont need them."
- **Adam is the tie-breaker for every party.** Verbatim: "i'm the tie-breaker on
  everything as i own the code." Agents have no standing to negotiate with each
  other; surface both positions to him verbatim and work the non-intersecting
  parts meanwhile.

### The six 1.2 decisions, 2026-09-09

Settled during the `v1.1` plus `adamdev/master` merge. They are the reason four
cleanly-auto-merged files had to be reverted.

1. **UNREAD MODEL: HIS.** Unread rides the OUTER ring as a still GREEN ring, the
   `done` bucket stays, and his status-key legend ships. Verbatim answer when
   shown both models: "1. his". Kept from ours: the one-element box-shadow
   geometry (no pseudo-element, so concentric is the only geometry available)
   and the grey `idle` fill. **Anything you read anywhere claiming the outer
   `unread` state was RETIRED is describing the model that LOST.**
2. **MANUAL MARK-UNREAD: KEPT, behind `ui.show_mark_unread_control`,** default
   true. One gate: `markUnreadHtml` returns `''`, so every surface hides it
   together. An unreadable config leaves the control SHOWN - a flag that hides
   things must fail open.
3. **ROW CONTROLS: OURS.** The kebab WITH restart on a live row.
4. **DEAD ROWS GO TO RECENT: OURS.** Verbatim 2026-09-08: "they go into recent,
   they can disappear."
5. **CI: HIS,** taken as-is.
6. **VERSION: 1.2.0.**

### The row menu, 2026-09-10

**"reconcile the two menus into ONE superset",** then the correction that shaped
the whole round: **"dont remove the rename. i said merge not take everything."**

That correction became the general rule: WHERE HIS CHANGE REMOVES A BEHAVIOUR OF
OURS, WE KEEP OURS AND ADD HIS ALONGSIDE, and a genuine either-or stops for the
owner rather than being decided inside a merge.

The shipped menu on a LIVE row, in order: rename, mark unread, move to group,
fork session, new session in folder, mute notifications, SEPARATOR, restart the
agent, close session. Pin is INLINE. On a DEAD row: inline restart and remove,
no menu. Rename has THREE doors (double-click, F2, the menu item) onto ONE
editor; the ~250 ms hold on a click on a renameable name is the known price of
keeping the gesture, not an oversight.

Third instruction, and it set the effort budget: **"dont forget we are rewriting
this. so much of this is going to be rewritten properly."** The vanilla
`client/js` menu is THROWAWAY. The TESTS were written to full care instead,
because they are the specification the Svelte rewrite has to satisfy.

### Repo of record and the update checker, 2026-09-10

- **`adamdev` (`Adoom666/CloudeCodeDev`) is the primary development repo;
  `origin` (`ccsliinc/CloudeCode`) is the backup mirror and stays the public
  distribution point.** Primary means development, not distribution.
- **Both update checkers point at Adam's main repo, `Adoom666/CloudeCode`.**
  This SUPERSEDES an earlier same-day note saying `macOS/update-check.js` was
  "already correct" pointing at ccsliinc. `src/core/update_check.py` needed no
  edit because it already pointed there; only the menubar JS moved.
  **The consequence, flagged not buried:** that repo publishes v1.0.36 as its
  latest, so a 1.2.1 install is told the latest is OLDER than what it runs. It
  does NOT prompt a downgrade - verified in both implementations, 1.2.1 sorts
  above 1.0.36 so `status` reads `current` - but the reported figure is wrong
  and the upgrade link opens a release older than the running build. Filed as
  `Adoom666/CloudeCodeDev` #69 because the coupling is partly his to make.
- **33 stale draft releases deleted.** Verbatim: "2. i think this is safe so why
  not." FLAGGED AND NOT ACTED ON: `v1.0.34`, `v1.0.35` and `v1.0.36` on
  `ccsliinc` are also drafts carrying DMGs, roughly another 370 MB, OUTSIDE the
  authorised range. They need their own decision.

### The 1.3 release plan, 2026-09-11

Verbatim: "ok, update git and lets get this finished and then make a 1.3.1", and
on testing: **"if shit isnt working we can only test by working."**

- **1.3.0 is OURS**: the two rewrites merged, validated, backed up, deployed,
  and then USED by the owner on real sessions. His using it is a RELEASE STEP,
  not an optional one - the fixture preview could not find the broken group
  control until he clicked it, and it cannot find anything that needs a real
  pane. Then tag and publish with an installer, a sha256 and a downgrade block.
- **1.3.1 is Adam integrated**, deliberately AFTER he has used 1.3.0.

### The database backup GATE, 2026-09-11

Verbatim: **"once we are confident on the code, we take a database backup to the
archive NAS. this way i can test the site live."** It is a gate, not a chore: it
is what makes live testing safe, and it happens AFTER the combined tree
validates and BEFORE the deploy.

- `VACUUM INTO`, never a file copy. The database is over 5 GiB and a running
  server is writing it; a straight `cp` of an open SQLite file can capture a
  torn page. `/Users/jsugamele/docker-management/devices/mini-m4/backup-m4.sh`
  already does it this way and is the pattern.
- Destination archive-nas `10.0.1.237`, TrueNAS SCALE, ssh user
  **`truenas_admin`** (a bare `ssh 10.0.1.237` fails), path
  `/mnt/ARCHIVE/vault/85_cloud-exports/claude/`.
- **VERIFY THE COPY, do not trust the transfer.** sha256 both ends. An
  unverified backup is a belief, and the whole point is that the owner can break
  the live install and get back.
- Record the ROLLBACK in the same place, so it is one command and not a
  reconstruction: redeploy `release/1.2.1` (tagged, published, known good), and
  for the bundle move
  `/Applications/Cloude Code.app.rollback-1.2.0-20260910T120538` back, then
  `bootout` and `bootstrap`. NEVER `kickstart -k`.

### STILL OPEN, waiting on him

1. Rotate `~/.config/restic/mini-m4.pw` into 1Password, and decide whether
   restic's scope should widen. Deferred with the rest of credential rotation.
2. Confirm the LED states in the reference gallery
   (https://claude.ai/code/artifact/aac4e1df-56aa-44e7-a444-6d1e1fc48627),
   in particular the resized halo. Not revisited.
3. Where the update checker SHOULD point, now that ccsliinc has real published
   releases. The current answer (Adam's repo) is ruled but produces a wrong
   "latest" figure; #69 asks him.
4. `v1.0.34` / `v1.0.35` / `v1.0.36` drafts on ccsliinc, roughly 370 MB.
5. Whether `.gitignore`'s `.claude/*` should keep excluding notes by default.
   Force-adding works but is INVISIBLE: a new note is silently untracked again
   unless somebody remembers `-f`. Two options on record - narrow the ignore to
   the genuinely local paths, or keep it and add a guard test that fails when a
   file under `.claude/notes/` is untracked. The second is cheaper and matches
   how this repo already guards things.
6. `STARTUP_TAIL_RECHECK_SECONDS = 30` as an acceptable worst case for noticing
   a session that becomes stuck LATER. First looks are unthrottled.
7. What "show full history" is supposed to do, versus "show summary", on the
   away bar.

**Browser control, and the only route to it.** Claude in Chrome is PAIRED and
INSTALLED but `claudeInChromeDefaultEnabled = false`, so browser tools exist
ONLY in a session launched with `--chrome`, which is the `claude-chrome`
wrapper. Tools BIND AT SESSION START, so browser control cannot be added to a
conversation already running. The wrapper picker is the intended route: restart
a session and choose `claude-chrome`.

---

## 10. CORRECTIONS CARRIED FORWARD

Recorded rather than quietly dropped, per the convention that a wrong entry plus
its correction beats a clean lie.

### New in the 2026-09-11 rewrite

- **This file prescribed `launchctl kickstart -k` and that was WRONG.** Both
  2026-09-10 bundle rebuilds measured it SIGKILLing Electron and orphaning the
  python server on port 8000, which the next app refuses to adopt as a version
  mismatch. Section 2 now prescribes `bootout` then `bootstrap`, and
  `docs/deploy-mini.md` carries the same correction.
- **The `CLAUDE.md` test baseline was stale for the third time.** It read
  5,656 / 2 / 19 and "197 node suites"; re-measured on `release/1.2.1` on
  2026-09-11 it is **5,708 / 2 / 19** and **200 node suites, 200 passing**.
  Corrected in the same change. Three times is a pattern, not bad luck: take
  your own baseline.
- **`cloude.db` is not 4.5 GB any more.** This file said ~4.5 GB; re-measured
  2026-09-11 it is **5,365,055,488 bytes (5.0 GiB)**. The backup-gate entry in
  `TODO.md` also says "roughly 4.5 GB" and is stale the same way. Size the
  `VACUUM INTO` and the NAS transfer against 5 GiB.
- **`src/api/routes.py` was 4,387 lines, not 4,397.** The brief for this rewrite
  said 4,397; re-measured on `release/1.2.1` it is 4,387, and 106 on
  `feat/backend-decomposition`. The decomposition plan's own table also says
  4,387.
- **The frontend test count is 1,334 on record, not 1,335,** and it was recorded
  at `f28faef` with two commits landing after it that never re-recorded a count.
  Nobody has measured the branch tip. Labelled unverified in section 7 rather
  than quoted as a fact.
- **The draft-release cleanup reclaimed 4,095,684,007 bytes (3.81 GiB), not
  "4.2 GB", across 33 drafts.** Both the count and the size are on record with a
  written audit artifact at
  `docs/audits/2026-09-10-ccsliinc-draft-release-deletion.md`.
- **The backend suite did not go "5,609 to 6,520".** 5,609 was the 2026-09-09
  figure this file and `CLAUDE.md` both carried BEFORE the 1.2 merge. The
  measured control on the branch's own 1.2.1 base is **5,708** (re-measured),
  and the branch tip is **6,520** (on record). The improvement is real; the
  starting number was the wrong one.
- **The governance documents are not where the brief said.**
  `docs/kept-behaviours/` is a DIRECTORY holding one party file
  (`ccsliinc.md`); the policy document itself is `docs/KEPT-BEHAVIOURS.md`; and
  the current tip of that line is **`docs/plugin-policy`**, not
  `feat/work-protocol`, which is its ancestor.
- **The update-checker ruling reversed an earlier same-day note.**
  `docs/repo-of-record` (15:43) recorded `macOS/update-check.js` as "already
  correct" pointing at ccsliinc; `fix/update-checker-target` (16:14) repointed
  it at `Adoom666/CloudeCode` so both checkers agree. The later one is the
  ruling. Two unmerged branches now say different things about the same file.
- **`CLAUDE.md` naming `client/js/launchpad.js` as a file that must not grow is
  NOT a stale claim on `release/1.2.1`.** The brief for this rewrite said the
  file no longer exists; it exists and is **6,526 lines** on the release line
  and on live. It is deleted only on `feat/svelte-slice-7`. Writing "it does not
  exist" into `CLAUDE.md` on the release branch would have been a new false
  claim in the file every agent reads first, so `CLAUDE.md` now states both
  facts with the branch beside each.
- **`cp -i` does not simply hang.** Re-measured 2026-09-11 on this machine:
  with stdin closed, `cp -i a b` onto an existing `b` prints
  `overwrite b? (y/n [n]) not overwritten`, **exits 1, and copies nothing**.
  With an inherited stdin nobody answers it blocks on the prompt instead.
  Either way the file is not copied, and the first shape is worse because it
  looks like a command that ran.

### Carried forward from earlier rounds

- **The Brave extension finding was WRONG.** The claim that the Anthropic
  extension was "installed in none of Brave's three profiles" read Brave's
  `Preferences`; Chromium keeps extension settings in `Secure Preferences`.
  Re-measured there, `fcoeoabgfenejglbffodgkkbkcdhcgfn` IS installed under Brave
  `Profile 1`. An extension absent from `Preferences` is not evidence of
  absence.
- **The three "missing hook scripts" were a FALSE ALARM.** 84,217 files scanned
  on the mini, zero references. The on-screen errors are transcript attachments
  from 2026-04-23 being replayed by `--resume`.
- **The re-measured lag figure superseded the first one.** An early sample said
  a stall every ~20s lasting ~9.5s; the clean baseline gives 12.05s every 20.0s,
  and by the time it was fixed the stall had grown to 14.5s. It scaled with the
  file, which is itself the evidence it was the pragma.
- **The openrsync diagnosis was WRONG.** `deploy-mini.sh` did not fail because
  openrsync rejects `--files-from=- --relative`; it failed on a remote
  destination containing SPACES. Both live destinations contain spaces and the
  v11 staging path does not, so `--target live` could never work while
  `--target v11` always did.
- **The tmux identity premise was WRONG.** Killing and respawning does NOT move
  the instance triple. Measured on tmux 3.7c: `session_created` held at
  **1788821572** and `pane_id` at **`%0`** across `respawn-pane -k`, and only
  `pane_pid` changed.
- **"Media Compression's conversation is gone" was WRONG, and the app said it
  too.** The transcript `82854c0e-a423-4591-a34f-a14cb92fbf41.jsonl` exists and
  is 73,190,422 bytes. The app's message was locally truthful about a uuid that
  had nothing to do with the session.
- **`com.imc.cloude-code` is the wrong agent name** for this app, in
  Infrastructure `CLAUDE.md` hazard 40. The live one is
  `com.cloudecode.menubar`.
- **The LED ruling in `docs/DECISIONS.md` was recorded INVERTED** and is
  corrected in `3736c7f` against the shipped code. `docs/kept-behaviours/ccsliinc.md`
  carried the same inversion, ported straight out of `coord`'s `wants/` file,
  and is corrected in place with a note saying so. **`wants/` and `settled/` on
  `coord` are FROZEN**, so anything else ported out of them needs re-verifying
  against code before it reaches a file that binds both teams.
- **`data-row-status` in our own kept-behaviours file was stale** and is
  corrected to `data-row-menu-status`: the 2026-09-10 reconcile moved us onto
  Adam's trigger spelling.
- **The 1.2.0 release notes did NOT credit Adam with a large share, on purpose.**
  Between `v1.0.36` and `v1.2.0` he authored 2 of 40 non-merge commits; between
  `v1.2.0` and `v1.2.1` he authored 9 of 18. The brief for that task said a
  large share of BOTH came from him; that is right for 1.2.1 and wrong for
  1.2.0, and the published notes say the measured thing.
- Earlier in the migration: UTC timestamps were read as local and led to a wrong
  conclusion about which sessions post-dated the row-reuse fix (they PREDATE it
  by 1h38m); a proposal to delete all 6 archived DB rows would have orphaned
  lineage; and a token-minting shell quoting bug made both endpoints return 401
  while the parser read the error body as an empty list, producing a false zero.
