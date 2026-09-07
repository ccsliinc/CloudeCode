# HANDOFF - CloudeCode app development

Written 2026-09-07. Re-scoped from
`Infrastructure/.claude/notes/handoff-2026-09-06-cloudecode-migration.md`, which
was written for someone continuing the MacBook-to-mini MIGRATION. This one is
written for someone continuing APP DEVELOPMENT.

Everything below was measured on the dates given, not inferred. Where something
is unproven it says so in those words.

Read `CLAUDE.md` in the repo root first - it is the architecture and the
conventions, and this file deliberately does not repeat it. Read
`.claude/TODO.md` second, starting with its `## OPEN - index`. This file is the
operational half: where things run, how to deploy, and what will lie to you.

---

## 1. WHERE THINGS PHYSICALLY ARE

| Thing | Location |
|---|---|
| Source checkout (authoritative) | `/Users/jsugamele/Library/Mobile Documents/com~apple~CloudDocs/Sync/Development/CloudeCode`, branch `v1.1` |
| Live production server dir | mini: `~/Library/Application Support/cloude-code-menubar/server` |
| Live production app bundle | mini: `/Applications/Cloude Code.app/Contents/Resources` |
| Live URL | `http://10.0.1.150:8000` |
| Staging (v1.1) | port 8001, state `~/Library/.../CloudeCode-v1.1`, tmux socket `cloude-v11`. Disposable. |
| Deploy script | `scripts/deploy-mini.sh`; `--target live` is REQUIRED, the default target is v11 |
| Live tmux socket | `cloude` |
| Database | `~/Library/Application Support/CloudeCode/cloude.db`, schema v23, ~4.5 GB (4.68 GB with a 195 MB WAL as measured 2026-09-05) |
| Archive corpus database | mini: `/Users/jsugamele/ClaudeArchive/`, 21 GB, NOT readable by the production app |
| Wrapper scripts (rendered) | `~/Library/Application Support/CloudeCode/agent_wrapper_scripts/<id>.zsh` |

**BOTH deploy targets must be written.** The packaged app copies its bundle
Resources over the server dir on every start, so writing only the server dir is
silently reverted at next launch. `deploy-mini.sh --target live` does both; a
hand `scp` must do both explicitly.

**Everything here runs on mac-mini-m4 (10.0.1.150).** There is no other host in
this project.

---

## 2. THE DEPLOY TRAPS

Each of these has cost real time, and each fails by looking like success.

**A clean tree deploys NOTHING and says so in words that read like a pass.**
`deploy-mini.sh` deploys CHANGED files, so against a clean tree it prints
`nothing to deploy`. Use `--all`, or scp the specific files to BOTH targets.
Fixing this behaviour is itself an open item.

**Verify a deploy by fetching the asset over HTTP and hashing it against the
local file.** Never by `git rev-parse` on either side - that only reads back the
same claim the deploy already believes, it is not an independent measurement.
The 2026-09-06 `5c88fdd` deploy was verified by `GET /static/js/launchpad.js`
and hashing, and that is the pattern to copy.

**A browser tab open across a deploy does not re-fetch static assets.** It can
run arbitrarily many releases behind while its API calls and its WebSocket keep
working perfectly. Hard-reload before believing ANY UI observation. One-line
check before chasing a server-side explanation for "my changes are not showing":
look for a STATIC-ASSET request from that client's IP after the restart
timestamp. If there is none, the fix is a hard reload, not the server.

**The supervisor gives up after 3 unexpected stops.** A dead server can STAY
dead while the page looks completely normal, because the UI gives no signal when
the server dies. Recover with:

    launchctl kickstart -k gui/501/com.cloudecode.menubar

That took about 15 seconds on the last deploy. The missing down-indicator is
itself an open item.

**`com.cloudecode.menubar` on port 8000 is the live agent.**
`com.cloudecode.v11` on 8001 was disabled 2026-08-31 (`launchctl bootout` plus
`disable`, plist left in place). `com.imc.cloude-code` does NOT serve this app;
Infrastructure `CLAUDE.md` hazard 40 names it wrongly and carries the correction.

**Staging cannot be click-tested.** It is TOTP-gated and credentials are not to
be entered. Verify on live, or by API.

---

## 3. THE LAG - root cause, measured, and the first thing to fix

```
main-thread samples: 19,484 | inside sqlite3_step: 13,913 = 71.4%
/health polled at 10Hz:  p50 = 30ms   p99 = 11,966ms   max = 12,767ms
STALLS every 20.0s, each lasting 12.05s
```

The server runs SQLite SYNCHRONOUSLY on its asyncio event loop, so a query
blocks every other request, including websocket frames. The loop is unavailable
roughly 60 percent of wall clock on an IDLE box.

There is no local echo in the terminal (`terminal.js:312 term.onData -> ws.send`,
characters appear only via `term.write()` fed by PTY output over the same
socket), so every keystroke round-trips through the blocked loop in BOTH
directions: 8 seconds working, 12 seconds dead, then a catch-up burst. That is
exactly the owner's "typing stops appearing then in a little bit it appears
again".

RULED OUT, each measured: multi-session streaming (singleton websocket, 2 TCP
connections not 17), the network (measured from 127.0.0.1), machine load
(min 9ms proves the server is fast when the loop is free), poll volume
(`/sessions/list`, `/sessions/attachable` and `/sessions/records` all correctly
use `run_in_threadpool` and are VICTIMS of the stall).

**CANNOT DETERMINE: which query.** `sample` renders CPython frames as
`_PyEval_EvalFrameDefault`, so the Python call site is invisible. Close it with
`py-spy dump --pid <server>` against the live process DURING a stall - a
30-second read-only step. Do that BEFORE writing a fix.
`corpus_ingest_task.py:223` already shows the correct shape
(`asyncio.to_thread`); the blocking path does not.

Second, independent performance defect: `renderProjectList()` does a wholesale
`innerHTML =` with NO signature guard, rebuilding 794 DOM nodes (385 elements +
409 text nodes) plus ~45 event listeners on every 5-second tick, including while
the launchpad is hidden behind a terminal. There is no `clearInterval` anywhere
in `launchpad.js` and the poller never pauses on tab hide. Verify a fix by
asserting the MUTATION COUNT, not that the signature stopped changing - a
signature that never changes and a renderer that ignores it look identical from
outside.

**Line numbers recorded for these have DRIFTED.** The TODO records
`renderProjectList()` at launchpad.js:3976 with the `innerHTML =` at :4120, and
the poller variously at :152 and ~387. Spot-checked 2026-09-07 on the `v1.1`
tip: `renderProjectList()` is at :4155, the wholesale `innerHTML =` at :4318,
the `setInterval` at :454, in a 6,069-line file, and `grep -c clearInterval`
returns 0. The facts hold; re-derive any line number before quoting it.

**Agreed priority order:** (1) unblock the event loop, `py-spy dump` FIRST to
name the query; (2) the project-tree render guard; (3) push updates over the
existing websocket instead of polling. Note for (3) that `src/api/websocket.py`
carries NO project or session-list message type at all - the websocket is
per-session terminal I/O only, so there is no push channel for state today and
adding one is real work, not a config change.

---

## 4. IDENTITY - the model, and the three things that are not the same

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
bare shell has that field EMPTY, so the ladder lands on `RESPAWN_SHELL` and the
restart button silently hands you a LOGIN SHELL instead of claude - with or
without a wrapper. A session needs BOTH a non-empty `pane_start_command` AND a
stored `agent_type` to reach `RESPAWN_AGENT`. Row 40
(`Agent - Infrastructure`) was staged deliberately with both, and is the first
session on the box that will restart correctly.

Related, and open as backlog item 3: every session created via
`auto_start_claude:false` plus a hand-sent claude command lands with
`sessions.agent_type` NULL, because the agent_type wrapper only applies on
auto-start. The flag IS on the running process. Fix the persistence, not the
display.

---

## 6. KNOWN FALSE GREENS CURRENTLY LIVE IN THE PRODUCT

Each with its mechanism, because the mechanism is what tells you whether your
fix covers it.

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

**`activity_state` reads `working` for about four minutes after a resume.** Then
it self-corrects (measured moving to `question` at 21:49:38 on 2026-09-06). Real
and self-clearing on that evidence, not stuck - a narrower defect than backlog
item 4 as written. Do not treat the existing signal as trustworthy while
building read/unread state or alert lights on top of it.

**The UI gives NO signal when the server dies.** Covered in section 2. It is the
same family as the two above: an absence of bad news rendered as good news.

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

**Tests and syntax.** `venv/bin/python3 -m pytest -q` from the repo root; system
python3 has no fastapi. `node --check` every JS file you touch. A fresh git
worktree has NO `config.json` (it is gitignored), and its absence manufactures
collection errors that look exactly like pre-existing code bugs - seed it from
`config.example.json` before trusting any baseline measured in a worktree.

---

## 8. CURRENT GIT STATE

Branch `v1.1`. **8 commits unpushed as of 2026-09-07**, confirmed with
`git log --oneline @{u}..HEAD`. Newest first:

| commit | what it fixed |
|---|---|
| `5c88fdd` | the archived-projects notice now renders when the fetch FAILS, instead of leaving the last successful count on screen |
| `a89c919` | project archiving: archive/unarchive endpoints, `include_archived`, `src/core/project_archive.py`, and the show-archived toggle. No migration needed, `projects.archived_at` was already in the DDL |
| `63c8439` | the archive became a full-page mode that releases the current session via `pauseForHome()` instead of sitting on top of it |
| `7bf95e5` | a closed sidebar no longer strands keyboard focus off screen: `inert` plus `visibility:hidden` on the closed state, focus released on close |
| `a945771` | toasts: answering a session ACKS its toasts (not merely hides them), plus Dismiss all |
| `dc91524` | test: pins which hook events reach the work stamp |
| `e57a7f2` | ordering: sessions and projects sort by WORK, never by opening. The `is_this_tab` and `is_active` sort terms were removed |
| `f7bea60` | the project list refreshes after a session creates a project |

Pushing them is an open item. Do not rebase or amend them.

---

## 9. OWNER DECISIONS ALREADY MADE - do not relitigate

- Sync stays iCloud. His words: "i want icloud" / "stay with icloud".
- He will not work the same session on two computers.
- `OP_SERVICE_ACCOUNT_TOKEN` rotation is deferred by his explicit decision:
  "not until we finish this project. because it will happen again." Rotation is
  a 1Password WRITE and needs him.
- Codex OpenAI sign-out is his: "ill take care of that part when ready."
  `auth.json` and the three sqlite files holding live bearer tokens were
  deliberately left untouched.
- The RSA private key and `MESH_PASS`: "put it in the backlog."
- Merging the `(old path)` project rows directly in the database is authorised:
  "this is a me thing it can be done via database". **Take a verified backup
  first - every pre-existing backup in that directory is 65-115 KB against a
  4.5 GB database and would be useless as a rollback.**
- Installing the browser extension for `--chrome` is his call.
- CloudeCode DB copies in the NAS archive: "no i dont need them."

---

## 10. CORRECTIONS CARRIED FORWARD

Recorded rather than quietly dropped, per the convention that a wrong entry plus
its correction beats a clean lie.

- **The Brave extension finding was WRONG.** The claim that the Anthropic
  extension was "installed in none of Brave's three profiles" read Brave's
  `Preferences`; Chromium keeps extension settings in `Secure Preferences`.
  Re-measured there, `fcoeoabgfenejglbffodgkkbkcdhcgfn` IS installed under Brave
  `Profile 1`. An extension absent from `Preferences` is not evidence of
  absence.
- **The three "missing hook scripts" were a FALSE ALARM.** 84,217 files scanned
  on the mini, zero references. The on-screen errors are transcript attachments
  from 2026-04-23 being replayed by `--resume`. The related claim that
  `archive-context.sh` feeds `claude_session_uuid` was also wrong; that is a
  whole subsystem fed by the managed curl hooks POSTing to
  `/api/v1/hooks/claude-event`, which is live and firing.
- **The re-measured lag figure superseded the first one.** An early sample said
  a stall every ~20s lasting ~9.5s. The clean-baseline measurement on the quiet
  box gives 12.05s every 20.0s.
- **`com.imc.cloude-code` is the wrong agent name** for this app, in
  Infrastructure `CLAUDE.md` hazard 40. The live one is
  `com.cloudecode.menubar`.
- Earlier in the migration: UTC timestamps were read as local and led to a wrong
  conclusion about which sessions post-dated the row-reuse fix (they PREDATE it
  by 1h38m); a proposal to delete all 6 archived DB rows would have orphaned
  lineage, because rows 4 and 5 are parents of live sessions and roots of
  archives holding 24,790 records; and a token-minting shell quoting bug made
  both endpoints return 401 while the parser read the error body as an empty
  list, producing a false zero.
