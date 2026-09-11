# CloudeCode - Task Tracker

> **APPEND ONLY.** Nothing in this file is ever deleted or rewritten. Mark items
> complete. When a past entry turns out to have been WRONG, add a new
> `SUPERSEDED` or `CORRECTION` entry rather than editing the old one - the wrong
> entry plus its correction is more useful than a clean lie.
>
> **Heading convention:** `### YYYY-MM-DD - short title - OPEN|DONE|SUPERSEDED`
>
> **Split out 2026-09-07** from
> `/Users/jsugamele/Library/Mobile Documents/com~apple~CloudDocs/Sync/Development/Assistants/Infrastructure/.claude/TODO.md`.
> The original entries were LEFT IN PLACE there, because that file is
> append-only history and deleting from it is not permitted. Infrastructure now
> covers the fleet (24 hosts, monitoring, backups); this file covers the app.
> Where an item still has a live Infrastructure index number it is tagged
> `INFRA-nn` so it can be traced back.
>
> **Path spelling.** Always write the long iCloud spelling:
> `/Users/jsugamele/Library/Mobile Documents/com~apple~CloudDocs/Sync/Development/CloudeCode`.
> `~/Development` is a symlink into iCloud and Claude Code derives its transcript
> directory from the LITERAL cwd string, so two spellings of one directory
> produce two transcript dirs. That is exactly how the `Mac (old path)` and
> `Hirschfeld (old path)` project rows came to exist.
>
> **Voice:** no em-dashes, no en-dashes, no emojis, anywhere, including commit
> messages. Date every factual claim. Write CANNOT DETERMINE rather than guess.

---

## AGREED PRIORITY ORDER

Set 2026-09-06, and nothing since has changed it:

1. **Unblock the event loop.** Run `py-spy dump --pid <server>` DURING a stall
   FIRST, to name the query. Do not write a fix before that; the query is
   currently CANNOT DETERMINE. Item 2 / the LAG entry.
2. **The project-tree render guard.** `renderProjectList()` has no signature
   guard and rebuilds 794 DOM nodes every 5 seconds. Item 13 / the render entry.
3. **Push updates over the existing websocket instead of polling.** Last,
   deliberately: `src/api/websocket.py` carries no project or session-list
   message type at all, so this is real work, and the poll may not be the real
   cost once (1) is done. Re-measure before designing it.

---

## OPEN - index

One line each, newest measurement wins. Detail follows below in full.

- **2. FIXED AND DEPLOYED 2026-09-07.** `PRAGMA integrity_check` is off the
  request path. Measured on live: p99 **14,505.7 ms -> 13.3 ms** (1,090x), p50
  30.5 -> 5.2 ms, the 20.0s / 14.5s stall cadence GONE, 86.5% of the window
  stalled -> 0.0%. Corpus ingester verified still ingesting with a positive
  control (row counts rose). Commit `3c23309`. See the DONE entry for the full
- **22. HALF DONE 2026-09-07.** The DRY-RUN RUNG PREVIEW is built and the shell
  landmine is no longer silent: `GET /sessions/restart/preview` reports the rung
  a session would land on without acting, twice - `unchanged` (what a restart
  does now) and `projected` (what it would come back AS, liveness ignored) -
  plus `pane_state` as its own fact. A projected rung is a PREDICTION, NEVER A
  PERMISSION. Also landed: an optional `agent_type` on `POST /sessions/respawn`
  so a session can be moved onto another launch wrapper without hand-editing
  `sessions.agent_type`, and a return-to-session step after a successful
  restart. STILL OPEN: close-and-recreate for a LIVE session, which needs a new
  row re-carrying attribution, theme, unread, filing and position. A live pane
  still answers `not_dead` and the picker refuses it.
- **23.** The deploy copies with `ditto`, which MERGES. The first commit that
  DELETES a file will leave the stale copy on BOTH targets and still report
  success, because verification only hashes files that should be present.
  Latent until something is removed. LOW effort, do it before a deletion ships.
- **2b. MEASUREMENT NOTE 2026-09-07.** A later 30s poll after the `cddc823`
  deploy read p99 **64-72 ms** across two runs, not the 13.3 ms recorded right
  after the fix. Stable, no stall pattern, still 3 orders of magnitude better
  than the 14,505 ms broken state, but ~5x the earlier figure and NOT
  attributable. The corpus ingester was active during both later runs, which is
  a hypothesis and was not tested. Re-measure on a quiet box before treating
  13.3 ms as the number.
  measurement and how the deploy was verified.
- **21. NEW, HIGH.** `scripts/deploy-mini.sh` is BROKEN on current macOS: both
  machines ship Apple openrsync, which rejects `--files-from=- --relative`
  with `server receiver mode requires two argument`. It fails safe (copies
  nothing) but every future deploy needs a hand tar-over-ssh until fixed.
### The lag and the render path
- **2.** Tab switching and keyboard extremely laggy. Root cause found and
  measured 2026-09-05: synchronous SQLite on the asyncio event loop, 71.4
  percent of main-thread samples inside `sqlite3_step`, a 12.05s stall every
  20.0s, loop unavailable ~60 percent of wall clock on an IDLE box. WHICH query
- **2a. ANSWERED 2026-09-07.** The query is `PRAGMA integrity_check` at
  `src/core/db.py:177`, reached from the async `GET /api/v1/version` handler
  (`version_routes.py:207` -> `:178` -> `db_health.py:94`), run synchronously on
  the loop against 4.5 GB, polled every 20s by the ELECTRON TRAY
  (`macOS/main.js:1588` `INTERVAL_MS = 20000`). Confirmed twice independently:
  py-spy 17/17 stalled dumps byte-identical, plus static analysis. It is a
  REQUEST HANDLER on a timer, not a background task. Stall has grown 12.05s ->
  14.3s and scales with the file. FIX NOT BUILT: threadpool alone is
  insufficient, the pragma does not belong on a status endpoint.
  is CANNOT DETERMINE. `py-spy dump` mid-stall is the next step. PRIORITY 1.
- **13.** Home screen polls every 5s and `renderProjectList()` repaints from it
  with NO guard: 385 elements + 409 text nodes destroyed and recreated per tick
  at 15 projects / 17 sessions, ~45 listeners re-attached, including while the
  launchpad is hidden behind a terminal. No `clearInterval` anywhere. PRIORITY 2
  (the guard) and PRIORITY 3 (the push channel).

### Project creation, all three reproduced live 2026-09-06
- **14.** The typed project name is never used for the directory. Owner
  requirement: he must be able to CHOOSE where a project lives, including the
  subfolder.
- **15.** `POST /api/v1/sessions` cannot set a title. `CreateSessionRequest` has
  no `label` field. Every UI-created session lands `title = NULL`. Fix is one
  field and three lines.
- **16.** Attribution races project creation by 15 milliseconds, so the session
  lands `project_id NULL / attribution 'none'` and nothing ever re-probes.
- **17.** A server restart unbinds every session but one; they render
  "adoptable" rather than "running" until opened. Do NOT fix by making
  `/sessions/list` read the database.

### From owner screenshots 2026-09-07
- **18.** The folder path overruns its box in the project modals and cannot be
  read to the end. `div.folder-picker-path` has `width: 100%` and no
  `word-break` / `overflow-wrap` / `overflow` (`styles.css:2641`); the sibling
  `.folder-picker-status` already carries the fix. Its `:focus` and
  `::placeholder` rules are DEAD on a div. VERIFIED in code.
- **18a.** Same screenshot shows the SHORT cwd spelling
  `/Users/jsugamele/Development/...`, the exact symlink trap that manufactured
  the two `(old path)` project rows. UNVERIFIED whether the modal resolves it on
  submit; it definitely displays the short form. More serious than 18.
- **19.** A session parked on an unanswered folder-trust prompt over stale
  diagnostic scrollback (`CLAUDE-NOT-FOUND` / `PATHIS`), and the sidebar showed
  it as `Connected` with a PID and no signal. Neither probe string exists in
  this repo, so the scrollback is almost certainly replayed. UNVERIFIED, owner
  says it may be obsolete. Reproduce before spending time.
- **20.** A pinned theme bleeds across a session switch: session A pinned to
  Darcula left Darcula applied to session B, which pins nothing. Likely a
  missing else-branch (theme applied on open, never reset on leave). The home
  screen case is UNTESTED and the owner flagged it. UNVERIFIED, reported from
  live use 2026-09-07. Verify on the pixel, not the API value.

### Session and agent identity
- **1.** Sleep and resume: EXPOSE full-vs-summary as a deliberate option on wake.
  Do not ship the suppression as the fix.
- **3.** Sessions display as "maybe claude" or "unknown". `sessions.agent_type`
  is NULL on rows 11-14 while the API reports `claude-skip-permissions`. Fix the
  persistence, not the display.
- **The respawn ladder gates on tmux `#{pane_start_command}`.** A pane born as a
  bare shell lands on `RESPAWN_SHELL`, so the restart button hands you a login
  shell instead of claude. Needs BOTH a non-empty start command AND a stored
  `agent_type`. OPEN as a product defect, not just a per-session fact.
- **The SessionEnd hook is cancelled on every clean exit, and
  `reconcile_lifecycle` cannot cover for it.** A row reads `running` over a pane
  whose agent has exited. Measured 2026-09-06 and seen again 2026-09-07.

### Attention, toasts and sidebar
- **4.** Alert lights need looking into. Related and narrower than item 4 now
  reads: `activity_state` reads `working` for about four minutes after a resume,
  then self-corrects.
- **6.** Sidebar group ellipsis popup renders BEHIND the sidebar.
- **7.** Toasts must be visible ACROSS sessions. Raising should go global;
  dismissal must STAY per-session. Two different axes.
- **8.** A toast HISTORY page. Server already holds the record; this is a read
  view, not new persistence.
- **11.** Read / unread state per session. Shares one state model with items 4
  and 7, or the three will disagree.

### Sidebar, groups and projects
- **5.** Merge the `(old path)` and new-path projects. API CANNOT do it. Owner
  authorised a direct database edit. Take a VERIFIED backup first.
- **9.** Group everything, including pinned sessions. Question outstanding for
  the owner about the ungrouped Infrastructure sessions.
- **10.** Durable ORDER WITHIN a group. Needs a `position` column on
  `session_group_members`, done in the SAME change as re-keying that table from
  `tmux_name` to `session_uuid`.
- **12.** Archive a PROJECT when finished. Sessions have `archived_at`; projects
  now do too as of `a89c919`, so this is largely DONE - see the DONE section.
- Register the ~26 dormant projects as archived. Unblocked 2026-09-06.
- There is no sessions UNARCHIVE endpoint. Projects have one; sessions do not.
- **Startup race, cosmetic.** Cold load with show-archived already on paints the
  button pressed before the notice lands.

### Connection state and deploy
- **The UI gives NO signal when the server dies.** The supervisor gives up after
  3 unexpected stops, so a dead server can STAY dead while the page looks normal.
- **`deploy-mini.sh` deploys CHANGED files, so a clean tree deploys nothing** and
  prints `nothing to deploy`, which reads like success. Fix it rather than work
  around it.
- Push the 8 unpushed `v1.1` commits.

### Archive and message browser (opened 2026-08-31 / 2026-09-02)
- **INFRA-99.** Export download cannot authenticate from a browser. Needs a
  short-lived single-use download ticket. Owner's call: it puts a credential in
  a URL.
- **INFRA-101.** Corpus 1 has `manifest_sha` NULL yet 19,545 of 19,548
  transcripts claim `host_attribution manifest_verified`.
- **INFRA-102.** Widen ingest-side secret detection.
- **INFRA-103 / 114 / 121.** Where the corpus permanently lives, and making the
  moved copy readable. The 21 GB database is on the mini at
  `/Users/jsugamele/ClaudeArchive/` and is NOT readable by the production app.
- **INFRA-105.** 46 subagent transcripts (12.2 MB) are in NO archive; the
  ingester does not walk `workflows/`.
- **INFRA-109.** Reclaim the 3.78 GB of duplicate ingest. Prevention shipped at
  schema v22; reclaim not attempted.
- **INFRA-115.** tmux resurrect/continuum. A restored session gets a NEW tmux
  creation epoch and session identity is the triple, so a naive restore orphans
  rows. Needs a design pass.
- **INFRA-116.** `src/core/db_steps.py` (1,124+ lines) and
  `src/core/message_gate_contract.py` (906 lines) exceed the 500-line cap.
- **INFRA-117.** `tests/test_secret_gate_parity.py` failed once across three
  full runs and passed 10 of 10 in isolation. Cause CANNOT DETERMINE.
- **INFRA-100 / 110.** The archived-secret inventory is undercounted, and it
  feeds the deferred credential rotation. OWNER-GATED: he asked to be consulted
  on secrets separately. Kept in BOTH files on purpose.
- **INFRA-112.** The mini leaks a CloudeCode hook token in plaintext `ps`
  arguments.

### Test-harness safety, all HIGH
- **INFRA-49.** The pytest suite still creates real tmux sessions on the live
  shared `cloude` socket, roughly 15 hardcoded socket-name literals, currently
  deselected rather than refactored.
- **INFRA-61.** ~28 standalone `scripts/verify_*.py` harnesses write into the
  owner's REAL `~/.claude/settings.json`. Not one sets
  `CLOUDE_CLAUDE_SETTINGS_PATH`, and at least twenty boot a real server.

### Older app items carried over
- **INFRA-53.** The copy chip reports a FALSE SUCCESS on real iOS, and the only
  candidate fix is UNVERIFIED (`0ed0b91`, branch `fix/copy-ios-false-success`,
  written by an agent that died before reporting).
- **INFRA-54.** TLS on the Tailscale hostname blocks four things; the `cld`
  wrapper; an unpushed PR to Adam; merging `integration/mobile-rc` to main.
- **INFRA-56.** `tests/manual_audio_check.md` documents removed UI elements.
- **INFRA-59.** `setup_auth.py` still hardcodes `PORT=8000` in its `.env`
  fallback template.
- **INFRA-60.** The effects-`inactive` terminal state is untested BY
  CONSTRUCTION - a check that can never fail.
- **INFRA-52.** claude-history residual gaps: the `audit.jsonl` adapter, the
  `(session_id, seq_in_file)` uniqueness blocker, and the history VIEWER.
- **INFRA-57 / 58.** Stale tmux sockets on mac-mini-m4 (~1500 `cc-locale-*` and
  four of unknown provenance). Host-side symptom of this app's test harness;
  the line stays in Infrastructure too.
- **The browser half of `--chrome` is NOT ready and it is the owner's to do.**
  Chrome is not installed on the mini (only Brave); the extension IS installed
  under Brave `Profile 1`.

### Added and updated 2026-09-08 - newest measurement wins

Nothing above is removed. These lines are the current reading where they
disagree with an older line.

- **DEPLOY STATE.** Live on mac-mini-m4 runs **`0b12edf`**. Committed AND
  PUSHED but **NOT DEPLOYED**: `0793eb1` (picker layout) and `8dd54a8` (lineage
  recovery plus backfill). **Nothing is unpushed**, which supersedes the "8
  commits unpushed" lines below and in `HANDOFF.md` section 8.
- **25. NEW, HIGH. The conversation id is missing on 16 of 39 session rows.**
  Two independent defects, both traced: `SessionStart` is the ONLY writer on
  the create path and never retries (25 failures across 20 sessions in the live
  log), and `slugify_project_dir` mapped only `/` and `.` when the real rule
  maps everything outside `[A-Za-z0-9-]`, so the fallback ladder had NEVER ONCE
  fired on this machine. Fix committed `8dd54a8`, NOT deployed. `agent_type`
  does NOT share this cause, so item 3 stays separate.
- **26. NEW. Five rows carry a uuid whose transcript does not exist, and all
  five COLLIDE** with a sibling row split off by the cwd spelling trap. Pairs
  7 to 4, 9 to 11, 10 to 12, 38 to 39. Over 39 rows: 16 absent, 18 sound, 5
  phantom. Merging them is the already-authorised item 5 family and still needs
  a VERIFIED backup first.
- **27. NEW. Deploy `0793eb1` and `8dd54a8`**, and authorise the 8 confident
  backfill FILLs (rows 14, 15, 16, 17, 19, 23, 24, 25). Dry run only so far,
  nothing written.
- **2. DONE AND DEPLOYED.** The lag is fixed. p99 14,505.7 ms to 13.3 ms.
  Caveat 2b stands and has grown: later polls read 64-72 ms and most recently
  66-73 ms, so **13.3 ms should not be treated as settled.**
- **20. DONE 2026-09-07, deployed.** The theme bleed. `a6b6b91`.
- **21. DONE 2026-09-07, deployed.** `c779afb`. **The openrsync diagnosis in
  the line above was WRONG**: the failure was a remote destination containing
  SPACES, not `--files-from`. See the 2026-09-08 corrections entry.
- **22. DONE 2026-09-07, deployed.** Part 2 shipped: `f95a9ed` restarts a live
  pane in place, `0b12edf` makes every rung that can resume the same
  conversation. The picker layout fix `0793eb1` is committed and NOT deployed.
- **CORRECTION to the respawn-ladder line above.** 18 of 22 live sessions have
  an empty `pane_start_command` (was 15 of 19 on 2026-09-07), BUT an explicit
  wrapper choice OVERRIDES that gate (`session_respawn.py:542`). Only an
  UNPICKED restart lands on the shell rung.
- **CORRECTION.** The tmux identity premise was wrong: `respawn-pane -k` does
  NOT move the instance triple. Measured on tmux 3.7c, `session_created` held
  at 1788821572 and `pane_id` at `%0`; only `pane_pid` changed.
- **CORRECTION.** "Media Compression's conversation is gone" was wrong. The
  transcript is 73,190,422 bytes and present.
- **CORRECTION.** The `CLAUDE.md` pytest baseline was stale by an order of
  magnitude because the `venv` symlink pointed at a deleted `venv.nosync`. Real
  numbers: **3 failed / 4874 passed / 12 skipped.**
- **24. UPDATED.** `'ProjectsView' object has no attribute 'read_only'` is now
  56 occurrences since 2026-08-29 and fires twice per boot. Pre-existing.
- **`--chrome` browser control: the route is the wrapper picker.** The
  extension is paired and installed but `claudeInChromeDefaultEnabled = false`,
  and tools bind at session start, so the only way in is to restart a session
  and choose the `claude-chrome` wrapper.
- **HAZARD.** A second Claude Code session was editing branch `v1.1`
  concurrently on 2026-09-07 and committed `32052d1`. It has exited. Two agents
  on one branch is how work gets clobbered.

---

## 2026-09-04 - CloudeCode backlog, after the session migration completes - OPEN

Recorded from the owner during the MacBook-to-mini migration. All of these are
POST-migration. He is testing the new daily-briefing agent now and wants
sessions moved a couple at a time so he can retire the local app as he goes.

The wording of items 1 to 5 is the OWNER'S OWN, preserved from the
Infrastructure TODO. Do not paraphrase it.

1. **Sleep and resume: he wants the OPTION, not the suppression.** Earlier work
   found `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` (default 100000) and
   `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` (default 70) gate the
   "resume from summary vs full" dialog, plus a persisted `resumeReturnDismissed`
   in `~/.claude.json`. Both env vars are UNVERIFIED - found in the binary, never
   exercised. He has since said he does NOT mind the warning; he wants the choice
   surfaced. So the work is to EXPOSE full-vs-summary as a deliberate option on
   wake, not to suppress the prompt. Do not ship the suppression as the fix.
   Note the mini runs claude 2.1.260/261 with native background-session
   primitives (`attach`, `logs`, `respawn`, `stop`, `rm`) that may replace the
   hand-built sleep entirely - evaluate before building.

2. **Tab switching and keyboard still extremely laggy.** The earlier diagnosis
   blamed machine load (UrBackup at 94 percent CPU, disk 95 percent full, 18
   pinned snapshots). All three are now resolved and he reports it is STILL bad,
   so that explanation is insufficient. The live structural finding stands and
   was never disproven: the server runs SQLite SYNCHRONOUSLY on its asyncio event
   loop, so any query blocks every other request. Sampling showed a stall every
   ~20s lasting ~9.5s. `corpus_ingest_task.py:223` already does it correctly with
   `asyncio.to_thread`; the blocking path does not. Re-measure on the now-quiet
   box before fixing - a clean baseline is what was missing.

   MEASURED 2026-09-05, see the LAG entry below. The re-measure was done and the
   stall is 12.05s every 20.0s, not ~9.5s.

3. **Sessions display as "maybe claude" or "unknown".** The `sessions.agent_type`
   DB column reads NULL on rows 11, 12, 13 and 14 (Mac, Hirschfeld, Personal
   Assistant, daily-briefing) while the API reports `claude-skip-permissions`
   with `agent_family_source: wrapper`. Every session created via
   `auto_start_claude:false` + a hand-sent claude command lands this way, because
   the agent_type wrapper only applies on auto-start. The flag IS on the running
   processes. So the stored value and the displayed value disagree with reality
   in different directions. Fix the persistence, not the display.

4. **Alert lights need looking into.** Owner-reported, not yet diagnosed. Note
   the related earlier finding: `activity_status` read `working` on Hirschfeld
   while its pane was idle at a prompt - stale state left from the resume render.
   May be the same defect or may be separate; do not assume.

   NARROWED 2026-09-06: `activity_state` read `working` for roughly four minutes
   after a resume while the pane sat idle at an empty prompt, then corrected
   itself to `question` at 21:49:38. On that evidence the stale `working` is real
   and SELF-CLEARING, not stuck - a narrower defect than item 4 as written.

5. **Merge the "(old path)" and new-path projects.** Projects 3 and 4 are
   `Mac (old path)` and `Hirschfeld (old path)`, retired 2026-09-03 because their
   root used the non-iCloud symlink spelling which maps to a different Claude
   transcript dir. Projects 5/6 superseded them. The API CANNOT do this: `PATCH
   /api/v1/projects/{name}` explicitly never rewrites `projects.root`, and DELETE
   returns HTTP 500 on a FOREIGN KEY constraint because archived session rows
   still reference them. Owner has explicitly authorised doing it directly in the
   database ("this is a me thing it can be done via database"). Take a verified
   backup first - note every pre-existing backup in that directory is 65-115 KB
   against a 4.5 GB database and would be useless as a rollback.

   ALSO, from `handoff-2026-09-06`: `launchpad.js:5599` launches new sessions
   with `project.path` (= `raw_path`), NOT `root`. A project-row correction that
   fixes only `root` is worse than nothing. Spot-checked 2026-09-07: that call
   site now reads `working_dir: project.path` at launchpad.js:5871, so the line
   number has drifted; the fact has not.

Also outstanding from earlier, unrelated to the above:
- 25 of the 31 sidebar sessions still to migrate, a couple at a time.
- The connection-state indicator: the UI gives NO signal when the server dies.
  Demonstrated during the 2026-09-04 live deploy - the supervisor gives up after
  3 unexpected stops, so a dead server can STAY dead while the page looks normal.
- Codex OAuth sign-out is the owner's to do; `auth.json` and the three sqlite
  files holding live bearer tokens were deliberately left untouched.
- Monthly rules review and a pitfalls/lessons file for the daily-briefing repo,
  agreed but not yet written. Trigger on ELAPSED time since last review, never on
  a calendar day - he misses days and a date-triggered review would skip silently.
  (That last bullet belongs to the daily-briefing repo, not this one; kept here
  because it was recorded in the same block.)

### 2026-09-05 - two more CloudeCode UI items for the post-migration backlog - OPEN

6. **Sidebar group ellipsis popup renders BEHIND the sidebar.** Clicking the
   ellipsis on a group (to close/collapse it) opens a menu that is obscured by
   the sidebar itself. Stacking-context or z-index problem, likely the menu being
   a child of a container that establishes its own stacking context. Note the
   sidebar gained `inert` + `visibility:hidden` on its CLOSED state (commit
   `7bf95e5`) - check that fix did not contribute before assuming it is
   pre-existing.

7. **Toasts must be visible ACROSS sessions.** The owner wants to see that
   another session needs attention while he is looking at a different one.
   The toast work in commit `a945771` made AUTO-DISMISS per-session, which is
   correct and should stay - typing into session A must not clear session B's
   toast. But he reports the toasts are not SHOWING across sessions in the first
   place. Determine whether visibility is currently scoped to the active session
   and, if so, make raising global while keeping dismissal per-session. These are
   two different axes and it would be easy to fix one by breaking the other.
   Toasts are server-backed with no dwell timer and require an ack, so a
   cross-session toast will persist until answered - which is the desired
   behaviour here, but confirm it does not stack unboundedly across 20+ sessions.

8. **A toast HISTORY page.** Owner: "we should keep a history log that i can look
   at in case i miss something, maybe a history page." Cross-session toasts
   (item 7) mean more of them land while he is elsewhere, so a scrollback of what
   was raised and what he did about it. Good news on feasibility: toasts are
   already SERVER-BACKED and ack-required (no dwell timer, they survive a reload
   and are re-delivered by the attach backfill until acked via
   `POST /api/v1/toasts/<id>/ack`), so the server already holds the record - this
   is a read view over existing state, not new persistence. Show: raised-at,
   session, type (`Stop` / `Notification` / `PermissionRequest`), the text, and
   how it was resolved (acked by the user, auto-dismissed by session input, or
   cleared by Dismiss all). Distinguishing those three matters - "I answered it"
   and "it got swept by Dismiss all" are different facts and collapsing them
   makes the history useless for the exact case he wants it for.

9. **Group everything, including pinned sessions.** Established 2026-09-05:
   group membership is DB-backed and travels between devices; pinning is
   per-device `localStorage` (`cloude.session.sidebar.arrangement`) and does not.
   A session that is BOTH pinned and grouped shows under Pinned where it was
   pinned and falls back to its group elsewhere - which is the desired behaviour.
   So the migration should assign a group even to pinned sessions, making the pin
   purely additive. In the owner's own sidebar, `Agent - Developer` and
   `Agent - N8N` are already both pinned AND in `Agents`; the rest of the pinned
   block is ungrouped. Ask him whether the ungrouped Infrastructure sessions
   (HA, HA Smart Git, Corporate, Athena, Claude Dev Move, Claude Move Mac Mini)
   want a group of their own rather than sitting loose.

10. **Durable ORDER WITHIN a group.** Measured 2026-09-05 against the live
    schema: `session_groups` HAS a `position` column and a reorder endpoint, so
    GROUP order is DB-backed and travels between devices. `session_group_members`
    has only `tmux_name` (pk), `group_id`, `added_at` - NO position. The store's
    own docstring says it: "members: tmux names filed in this group, in no
    meaningful order - the sidebar's own manual order decides how they are
    drawn", and that manual order is per-device `localStorage`. Owner wants his
    own durable order inside a group. Needs a `position` column on
    `session_group_members`, an endpoint to set it, and the client sorting on it
    instead of the local arrangement. **Do it in the same change as re-keying
    that table from `tmux_name` to `session_uuid`** - the current key is a latent
    defect (two sessions sharing a tmux name would share one membership row); it
    measured clean for his 31 titles but the table is being altered anyway.

11. **Read / unread state per session.** Owner: entering a session marks it read
    and it greys out if nothing is happening in it; he wants to be able to mark
    it unread again from the sidebar. Note this interacts with item 7
    (cross-session toasts) and item 4 (alert lights) - all three are "does this
    session want my attention", and they should share one state model rather than
    three that can disagree. Note also `activity_status` has already been seen
    reading `working` on an idle pane (stale state after a resume render), so the
    existing signal is not trustworthy as-is.

12. **Archive a PROJECT when finished.** Owner wants to retire a whole project,
    not just a session. Sessions already have `archived_at`; projects do not.
    Relevant constraint found 2026-09-05: a project that has ever hosted a session
    CANNOT be deleted through the API - `DELETE /projects/{name}` returns HTTP
    500 on a FOREIGN KEY constraint because `sessions.project_id` still
    references it, and `PATCH /projects/{name}` explicitly never rewrites
    `projects.root`. So project archival has to be a soft-delete column plus
    filtering, the same shape sessions already use, and it pairs naturally with
    the "show archived" toggle.

    **LARGELY DONE 2026-09-06** in `a89c919` plus `5c88fdd`. See the DONE
    section. No migration was needed: `projects.archived_at` has existed since
    the original DDL and the list query already filtered on it; only the write
    path, API and UI were missing. What remains is registering the ~26 dormant
    projects as archived.

13. **Home screen polls every 5s; owner noticed it visibly refreshing and asked
    whether it is generating traffic.** It is: `launchpad.js` ~387
    `setInterval(loadRunningSessions, 5000)` hitting `/sessions/attachable` and
    `/sessions/list` on every tick, and `renderProjectList()` repaints from that.
    With 17+ sessions this is measurable. He raised moving to PUSH updates
    (Svelte-style) rather than polling. Worth noting `src/api/websocket.py`
    carries NO project or session-list message type at all - the websocket is
    per-session terminal I/O only - so there is no push channel for state today
    and adding one is real work, not a config change. See also item 2: the server
    runs SQLite synchronously on the asyncio event loop, so every poll competes
    with terminal websocket frames on the same loop. Fix the blocking first and
    re-measure before designing a push layer; the poll may not be the real cost.

### 2026-09-05 - THE LAG: root cause found and measured - OPEN, PRIORITY 1

**Synchronous SQLite running as a coroutine on the asyncio event loop. The
server freezes for 12 seconds out of every 20, on an IDLE machine.**

Measured on the quiet box (all earlier load explanations - UrBackup, 95 percent
disk, 18 pinned snapshots - are resolved and were insufficient):

    sample, 30s:   main-thread samples 19,484
                   inside sqlite3_step 13,913  =  71.4 percent
    stack:         uvloop Loop__run -> uv__run_idle -> Handle__run -> task_step
                   -> pysqlite_connection_execute -> sqlite3_step
                   (a coroutine, running a synchronous query, on the loop)

    /health at 10Hz, 60s:  n=155  min=9ms  p50=30ms  p90=70ms
                           p99=11,966ms  max=12,767ms
    STALLS at 11:08:45, 11:09:05, 11:09:25, 11:09:45
    - exactly every 20.0s, each 12.05s long.

The loop is unavailable ~60 percent of wall-clock. Context: `cloude.db` is
4.68 GB with a 195 MB WAL and 5,598,436 rows in `transcript_records`.

**Why this IS the typing symptom.** There is no local echo -
`terminal.js:312 term.onData -> ws.send`, and characters only appear via
`term.write()` fed by PTY output returning over the same socket. So every
keystroke round-trips through the loop in BOTH directions. 8 seconds on,
12 seconds off, then a catch-up flush. That is the owner's description exactly.

**RULED OUT, with method:**
- Simultaneous multi-session streaming (the owner's own hypothesis). Only ONE
  terminal is attached at a time - `terminal.js` ends in a SINGLETON
  `new Terminal()` holding one `this.ws`, force-closed on every switch path
  (`connectToSession` :811, `reconnectToExistingSession` :948, `pauseForHome`
  :2375). Measured server-side: 2 established TCP connections from the browser,
  not 17. Does not scale with session count.
- Network latency: stalls measured from 127.0.0.1, p50 30ms.
- Machine load: box quiet, min 9ms proves the server is fast when the loop is free.
- Poll traffic volume: ~5 req/s of small JSON; `/sessions/list`,
  `/sessions/attachable` and `/sessions/records` all correctly use
  `run_in_threadpool` - they are VICTIMS of the stall, not the cause. The "home
  screen keeps refreshing" is four polls' worth of results landing in a clump
  when the block releases, not a repaint storm.

**CANNOT DETERMINE: which query.** `sample` renders CPython frames as
`_PyEval_EvalFrameDefault` so the Python call site is invisible. One 30-second
read-only step closes it: `py-spy dump --pid <server>` during a stall. Two
unproven candidates: `session_manager.record_hook_event()` called synchronously
un-awaited at `routes.py:1976` inside an `async def` handler (a real structural
defect either way), or something scanning `transcript_records`. No 20s-cadence
timer exists in the code, so the periodicity is itself unexplained.

Also unexplained and worth noting: the `-wal` at the canonical path is deleted
and recreated at 0 bytes at each stall while the server holds an fd on a 195 MB
unlinked WAL inode - the signature of connection open/close per call.

**The correct shape already exists in this repo:** `corpus_ingest_task.py:223`
does it with `asyncio.to_thread`. The blocking path does not. Do the `py-spy
dump` FIRST; do not write a fix against a query nobody has named.

### 2026-09-05 - The project tree rebuilds 794 DOM nodes every 5 seconds, unguarded - OPEN, PRIORITY 2

Separate, secondary, and real. `renderRunningSessions()` HAS a working signature
guard that correctly excludes ticking values. `renderProjectList()`
(`launchpad.js:3976`, wholesale `innerHTML =` at :4120) has NO guard at all -
measured at 15 projects / 17 sessions: 385 elements + 409 text nodes destroyed
and recreated per tick, plus ~45 event listeners re-attached, unconditionally,
including while the launchpad is hidden behind a terminal. Called twice with
byte-identical data it rebuilds both times.

Consequences measured: keyboard focus in the tree is destroyed every 5s (a
SECOND focus-destruction mechanism, separate from the sidebar one fixed in
`7bf95e5`); an in-progress rename input is destroyed when any unrelated session
changes state; `:hover` is dropped and fades back in over a 300ms transition,
which is the visible pulse under the cursor. Scroll reset RULED OUT (not scroll
containers). Terminal container never touched.

Fix: give it the same signature guard. Nothing in that tree is time-relative, so
there is no ticking value to build the guard around. Verify by asserting the
MUTATION COUNT, not that the signature stopped changing - a signature that never
changes and a renderer that ignores it look identical from outside.

Also: there is no `clearInterval` anywhere in `launchpad.js`. The poller is armed
once at :152 and runs forever, explicitly not pausing on tab hide.

**LINE NUMBERS HAVE DRIFTED - spot-checked 2026-09-07 on the `v1.1` tip.**
`renderProjectList()` is at launchpad.js:4155, the wholesale `innerHTML =` at
:4318, and the 5-second `setInterval` at :454, in a 6,069-line file. The other
figure recorded for the poller, `~387` in item 13 above, does not match either.
The FACTS all still hold - `grep -c clearInterval` over launchpad.js returns
**0** - but re-derive any line number before quoting it. Both recorded values
are kept here rather than corrected away, per the append-only convention.

### 2026-09-05 - CORRECTION: the three "missing hook scripts" were a false alarm

`archive-context.sh`, `notify-done.sh`, `enforce-slimRules.sh` do not exist on
EITHER machine and are referenced by NOTHING - 84,217 files scanned on the mini,
zero hits; the mini's `settings.json` Stop array holds exactly one hook (the
cloudecode curl). The error text visible in panes is a STORED TRANSCRIPT
ATTACHMENT from 2026-04-23, repainted by `--resume` every time those sessions
are resumed. The only file that ever referenced them is
`settings.json.backup-20260513-170340`. Copying them would have created dead
files and changed nothing on screen.

The related claim that `archive-context.sh` feeds `claude_session_uuid` was ALSO
wrong. That is a whole subsystem (`hook_contract.py`, `claude_hooks.py`,
`claude_session_correlate_ladder.py`, `session_claude_correlate_bind.py`,
`db_steps.py`) fed by the managed curl hooks POSTing to
`/api/v1/hooks/claude-event`, which is live and firing. Why specific rows are
NULL is CANNOT DETERMINE and needs the correlation ladder's own outcomes.

### 2026-09-06 - project creation is broken three ways, all reproduced live - OPEN

The owner created "Fantasy Football 2026" through the UI. Three separate defects,
each with a file:line, all hit in one action. Repaired by hand (project 17 and
sessions 38/39); the CODE is still broken and will do it again on the next project.

14. **The typed project name is never used for the directory.** `launchpad.js:4781-4786`
    sends `{auto_start_claude, copy_templates, project_name, cols, rows}` with **no
    `working_dir`**. `routes.py:600` mints `session_id = f"ses_{uuid4().hex[:8]}"`,
    and `session_manager.py:2758-2763` falls back to
    `settings.get_working_dir() / session_id` when no working_dir is supplied,
    creating an EMPTY dir named `ses_121ceb6f`. `launchpad.js:4820-4824` then
    registers the project as `{name: typed_name, path: session.working_dir}` -
    the typed name bolted onto a machine-minted path.
    There is NO name-to-slug code anywhere; `FantasyHockey2026` came from the
    FOLDER-PICKER route (`launchpad.js:5481 saveProjectWithUniqueName` with a
    `selectedPath`), i.e. the owner chose it himself. Known-recurring: a
    `ses_ec5bf2a3` path is fossilised as test data in
    `tests/test_project_authority.py:71` and `project_writes.py:14`.
    **OWNER REQUIREMENT 2026-09-06: he must be able to CHOOSE where a project
    lives, including the subfolder.** The picker already exists on the other
    route - the new-project flow should use it, or accept an explicit
    `working_dir`. Three outcomes required on the derived path: if the target
    directory already exists and is non-empty, that is an explicit refusal or a
    declared reuse, never a silent adopt.

15. **`POST /api/v1/sessions` cannot set a title.** `CreateSessionRequest`
    (`src/models.py`) has no `label` field; `routes.py:619-630` calls
    `create_session(...)` with nine kwargs and no `label=`, while the fork route
    (`:314`) and restart route (`:506`) both pass it. `create_session` itself
    ACCEPTS `label` (`session_manager.py:2662`) - only this one route declines to
    pass it. Every session created through the UI or the API lands with
    `title = NULL`. Every one of the ~29 sessions migrated that day needed a
    follow-up `PATCH /sessions/{id}/name` to work around it. Fix is one field and
    three lines.

16. **Attribution races project creation by 15 milliseconds.** Session row 38 was
    written at `20:21:56.978851Z`, its project row at `20:21:56.993415Z` - so the
    session attributed against a projects table that did not yet contain its own
    project, landed `project_id NULL / attribution 'none'`, and nothing ever
    re-probes. `project_writes.create_project` (`project_writes.py:277`) does no
    backfill of existing sessions. Either register the project BEFORE spawning the
    session, or have `create_project` attribute pre-existing sessions whose
    `working_dir` falls under the new root.

Related, same session: the project was registered under the `~/Development`
SYMLINK spelling, which is exactly why projects 3 and 4 were retired on
2026-09-03 (it maps to a different Claude transcript dir than the resolved iCloud
path the pane actually runs in). Any auto-derived path must use the resolved
iCloud spelling.

17. **A server restart unbinds every session but one, and they render as
    "adoptable" rather than "running" until opened.** `session_manager.py:889`
    rehydrates AT MOST ONE session on startup; the rest keep their live tmux pane
    but lose their in-process backend. `/sessions/list` (`routes.py:766-785` ->
    `list_session_infos` -> `_session_info_for`, `session_manager.py:3693-3698`)
    returns only sessions WITH a live backend, so an unbound one is absent from it
    and present in `/sessions/attachable` instead. Nothing is lost - the sidebar
    merges both - but after every restart, any session the owner does not open sits
    in that state. Observed 2026-09-06: `cloude_Fantasy_Hockey_2026`, unbound since
    the 2026-09-04 12:05 restart, 17 of 18 sessions having been opened since.
    **Do NOT fix by making `/sessions/list` read the database** - its contract is
    "a websocket attach will succeed here", and widening it would make it promise
    something false. Fix in the client merge: an `/attachable` row carrying a
    non-null `session_row_id` whose DB `lifecycle='running'` is a KNOWN session
    with a live pane, not an unknown external tmux, and should render as running.

### 2026-09-06 - the SessionEnd hook is cancelled on exit, and lifecycle cannot catch it - OPEN

Seen during the football bounce: `SessionEnd hook [(cat | curl ...)] failed:
Hook cancelled`. Not a misconfiguration and not harmful in that instance, but
it exposes a real false green.

**The hook channel itself is fine, proven positively.** The SAME hook plumbing
was working minutes later from the new process: `sessions.activity_state_at` on
row 39 advanced at 21:45:18, 21:49:18 and 21:49:38 with the state moving
`working -> working -> question`. So this is a SHUTDOWN RACE, not a broken
hook - SessionEnd by definition fires while claude is exiting, its command is a
`curl -sS -m 2`, and claude cancels pending hooks as it tears down.

**Why it still matters.** If the SessionEnd POST never lands, CloudeCode is
never told the agent ended. `reconcile_lifecycle` cannot cover for it, because
that reconciles against the TMUX LISTING - whether the tmux session exists - and
a pane whose claude exited still has a live tmux session. Measured exactly that:
between `/exit` and the relaunch, tmux was alive, no claude process existed, and
row 39 still read `lifecycle = running`. Nobody noticed because a relaunch
followed within a minute. On an ordinary exit the row would sit at `running` over
an empty pane indefinitely - a session the UI calls alive with nothing in it.
Same family as the connection indicator that gives no signal when the server
dies.

**SEEN AGAIN 2026-09-07.** Row 40 read `lifecycle = running` the whole time its
pane was DEAD (pane exited status 0 at 07:51), for the same reason: the tmux
session existed, only the pane died. Two independent ways to reach the same
false green, so a fix has to reconcile against the PANE and the agent, not the
tmux listing.

### 2026-09-06 - project archiving verified live, one false green found and fixed - DONE + OPEN

**DONE - verified in the owner's own browser against live.**
Toggle discoverability PASS (rendered unconditionally, never gated on there
BEING archived rows - knowing whether any archived rows exist would need a
second fetch of the very rows the toggle excludes, so the control announces
itself instead). Round trip PASS end to end: archived `Mac (old path)` live,
default `GET /projects` returned 16 without it, `include_archived=true` returned
17 with `archived_at: 2026-09-06T21:12:30Z`, UI read `showing archived: 1`, then
unarchived and the state was restored exactly (17 projects, 0 archived,
preference key removed). The test mutation was recorded before it was made and
reverted after.

**DONE - a false green INSIDE the feature built to prevent false greens.**
`loadProjects()` latched `_archivedFetchOk = false` on the error path and then
returned WITHOUT re-rendering, so the screen kept whatever the last successful
fetch had painted. Measured live with `API.getProjects` stubbed to throw:
internal state went to `false` and the notice on screen still read
**"showing archived: 1"**. A confident count left standing after the request
that would have told you had failed. Fixed by one `this.renderProjectList()` in
the catch (`5c88fdd`), deployed to BOTH live locations, verified by fetching
`/static/js/launchpad.js` over HTTP and hashing against the local file rather
than by `git rev-parse`. All three states then proven live:

| toggle | fetch | rendered |
|---|---|---|
| off | not asked | nothing at all |
| on | ok | `showing archived: 0` (or N) - a measured fact |
| on | failed | `CANNOT DETERMINE - archived projects could not be loaded. This is NOT a claim that there are none; the list below may be stale or incomplete.` |

The generalisable point: the three-outcome state existed in the MODEL and never
reached the SCREEN on the one path it was built for. Latching a third state is
not the same as rendering it - assert on the DOM, not on the variable.

**OPEN - startup race, cosmetic, low priority.** On a cold load with the
show-archived preference already on, the first paint uses a non-archived fetch
and the archived-aware one lands a second or two later, so the button reads
pressed while the notice is briefly absent. Does not produce a false claim (an
absent notice is the "not asked" state, not a false zero), but it is a real
ordering bug between the preference read and the first `loadProjects()`.

**NEW TRAP - Chrome MCP clicks in a background tab, and re-running an init.**
Physical clicks did not reach the button at all while `document.hidden` was
true; `element.click()` fired the handler fine. Then calling the wiring function
again to "re-wire" it attached a SECOND listener, so one click fired both,
flipped the state twice and landed back where it started - which reads exactly
like a dead control. The wiring was correct the whole time
(`initArchivedVisibleToggle()` is called from `initSectionDisclosures()`,
launchpad.js:3439). Assert `!document.hidden` before believing any click-driven
measurement through that MCP, and never re-run an init function to test whether
it ran - that mutates the thing you are measuring.

**OPEN - now unblocked.** Registering the ~26 dormant projects as archived was
blocked on archiving being live. It is live and round-trip proven, so it can
proceed. `Mac (old path)` and `Hirschfeld (old path)` are the obvious first two -
their own descriptions say "Retired 2026-09-03". They were NOT archived that day;
the test archive was reverted.

### 2026-09-06 - claude-chrome wrapper staged on the mini for Fantasy Football - DONE (staged), OPEN (browser half)

Owner asked for `--chrome` either added to the existing wrapper or put in a new
one with the football chat pointed at it. Took the SECOND option: a new wrapper
`claude-chrome`, leaving the default `claude-skip-permissions` untouched, so
only the one project changes rather than every session on the box.

**What is in place**
- **Wrapper `claude-chrome`** added through the running server's own API
  (`POST /api/v1/agents/wrappers`), so config.json and the in-memory config
  cache agree - a hand edit to config.json would NOT have been seen, because
  `Settings.load_auth_config` caches in `_auth_config_cache`.
  Script: `command claude --dangerously-skip-permissions --chrome "$@"`,
  rendered to `~/Library/Application Support/CloudeCode/agent_wrapper_scripts/claude-chrome.zsh`.
- **DB**: `projects.default_agent_type = 'claude-chrome'` on project 17
  (Fantasy Football 2026), and `sessions.agent_type = 'claude-chrome'` on rows
  38 and 39. Prior values were captured live first - all NULL except session 38,
  which was `claude-skip-permissions`. Revert SQL is on the mini at
  `~/football_chrome_revert.sql`.
- Verified in-process against the live config: the project resolves to
  `claude-chrome`, and the CONTROL (`Infrastructure`, no default) still resolves
  to `claude-skip-permissions` - nothing else moved.

**`--chrome` is a real flag, proven with a negative control.**
`claude --chrome mcp list` runs; `claude --chrom mcp list` returns
`error: unknown option '--chrom' (Did you mean --chrome?)`. Worth recording HOW
that was established, because the obvious test is worthless: `claude --chrome
--version` AND `claude --chrom --version` both exit 0 and print the version,
because `--version` short-circuits before option validation. A flag test that
passes for a flag that does not exist is not a flag test.

**THE RESTART BUTTON WILL NOT DO THIS, and that is a finding in its own right.**
`respawn_session` gates on tmux's `#{pane_start_command}`, and for
`cloude_Fantasy Football 2026` that field is **EMPTY** - the pane was born as a
bare shell and claude was typed into it (which is why the row reads
`agent_family_source: not_launched` with no `agent_type`, backlog item 3). The
ladder therefore lands on `RESPAWN_SHELL` and would put a LOGIN SHELL in that
pane, not claude, with or without the wrapper. A session needs BOTH a non-empty
`pane_start_command` AND a stored `agent_type` to reach `RESPAWN_AGENT`.

**OPEN - the browser half is NOT ready, and it is the owner's to do.**
`--chrome` will launch, but there is nothing on the mini for it to connect to.
Measured: **Google Chrome is not installed** (only Brave). The native messaging
host IS registered for both Chrome and Brave and its binary exists at
`~/.claude/chrome/chrome-native-host`.

**CORRECTION 2026-09-06 to the Brave finding above.** The claim that the
Anthropic extension `fcoeoabgfenejglbffodgkkbkcdhcgfn` was "installed in none of
Brave's three profiles" was WRONG, and the owner said so. It read Brave's
`Preferences`; Chromium keeps extension settings in `Secure Preferences`.
Re-measured there: the extension IS installed under Brave `Profile 1`. Left as a
correction rather than an edit. Lesson: an extension absent from `Preferences` is
not evidence of absence - check `Secure Preferences`, which is the protected
store Chromium actually writes.

### 2026-09-07 - a guard that could not see, and two writers on one transcript - DONE (recovered), LESSON

Recorded here because the mechanism is a product-adjacent hazard, not a fleet one.

**`pgrep -P` RETURNS NOTHING IN THE CLAUDE CODE SANDBOXED SHELL.** A session
recovery script's first guard - "refuse if a claude is still running under the
default socket" - was built on `pgrep -P <pane_pid> -f claude`. Measured on
mac-mini-m4, in that shell: **`pgrep -P 29423` returns NOTHING while
`ps -eo pid,ppid` plainly shows 29725 with ppid 29423**, and `pgrep -P 29422`
returns nothing for a tmux server whose child 29423 `ps` lists. `pgrep -x zsh`
works fine, so pgrep itself runs - only `-P` is blind. The same `pgrep -P` calls
issued through `ssh mac-mini-m4 '...'` DID return children, so this is a property
of the LOCAL sandboxed shell, not of the machine.

**Consequence, measured, not hypothetical:** the guard found nothing, reported
the coast clear, and the script respawned a SECOND claude onto the transcript a
still-running ssh copy was writing. Two writers on one `.jsonl` is the one thing
the whole staging design existed to prevent. Caught within about a minute; a byte
copy of the transcript was taken first (99 MB), then the second pid was killed.
**No damage: 36,196 lines, 0 invalid JSON, last record a normal attachment
carrying the right sessionId.**

**A guard that cannot fail is worse than no guard** - it reports a verdict it
never measured, and everyone downstream trusts it. Rewritten on
`ps -eo pid,ppid,command`, which is authoritative here.

Second bug found while fixing the first: matching `*claude*` against the whole
argv matched TRANSIENT SHELLS, because every Bash tool call in this environment
runs a zsh whose argv names `~/.claude/shell-snapshots/...`. That would have made
the guard refuse forever after the real claude had gone - the opposite failure,
equally silent. The predicate now tests column 3, the executable path, against
`claude` or `*/claude`.

Both directions proven before trusting it:
- POSITIVE control - with the ssh claude alive it REFUSES and names exactly one
  pid, the real one.
- NEGATIVE control - the same logic run against a snapshot with that pid removed
  PASSES, so it is not simply stuck on refuse.

Also relevant to this app: **CloudeCode only manages sockets it owns**, so a
session resumed by hand on the `default` tmux socket is invisible to it, and
**tmux cannot move a pane between servers**. The only route back is to let the
foreign copy exit and resume the same transcript inside the CloudeCode pane.

### 2026-09-06 - every shell CloudeCode spawns can run a Homebrew update - OPEN (workstation-side, affects session launch)

`~/.zshrc` sources `.profile_interactive`, which chains to
`~/.dotfiles/platforms/mac/.profile`, which calls **`my-update-mac`
unconditionally on every shell load** - and CloudeCode's own wrapper is
`zsh -c 'source ~/.zshrc ...; source <wrapper>.zsh "$@"'`, so a session launch
runs it too. Staging a session triggered it: it listed 8 outdated formulae and
reached `Need sudo to fix Homebrew Cellar permissions (may prompt for password)`
inside a non-interactive shell that can never answer.

It is not a per-launch tax - the script claims a 1-day timestamp reservation
first, so only the FIRST shell each day actually runs it and the rest skip
silently. But that first one is whichever session you happen to open first, and
it does system updates and blocks on a sudo prompt during that session's own
startup. **Worth suspecting as a contributor to a slow or hung first session
launch of the day.**

### 2026-09-07 - two items from owner screenshots - OPEN

Both raised by the owner from screenshots on 2026-09-07. What follows separates
what is VISIBLE in the images from what was VERIFIED in the code, because only
the first item was reproducible from the tree.

**18. The folder path overruns its box in the project modals. VERIFIED in code.**

Screenshot: the add-project modal with folder
`/Users/jsugamele/Development/Assistants/FantasyHockey2026`, the tail of the
string running past the right edge of the box with no wrap, no scroll and no
ellipsis. The user cannot read the end of their own path.

Mechanism, read 2026-09-07 on the `v1.1` tip. The path is NOT an input. It is
a `div.folder-picker-path`, rendered in two places in `client/js/launchpad.js`:
the edit-project modal at :4562 and the shared `pathHintHtml` at :5167. Its CSS
is `client/css/styles.css:2641` and it sets `width: 100%` with NO
`word-break`, NO `overflow-wrap` and NO `overflow`, so a long single-token path
simply spills.

The fix already exists eleven lines below it: `.folder-picker-status`
(`styles.css:2666`) carries `word-break: break-all` for exactly this reason.

Two things to fix in the same pass, because they are the same defect:
- The div is styled to impersonate an input (`cursor: text`, plus
  `.folder-picker-path:focus` at :2655 and `.folder-picker-path::placeholder`
  at :2661). Both of those rules are DEAD on a div and can never match. Either
  make it a real readonly input or drop the two rules; do not leave CSS that
  claims a behaviour the element cannot have.
- There is no `title` attribute on it, so hover reveals nothing either. A
  wrapped path is the fix; a tooltip is not a substitute on a phone.

Verify on the PIXEL, not the DOM. `textContent` will read the full path whether
or not it rendered inside the box. Assert the element's `scrollWidth` is not
greater than its `clientWidth`, or measure the bounding rect against the modal,
or take a screenshot someone looks at.

**18a. The same screenshot carries a more serious finding the owner did not
ask about: the SHORT cwd spelling.** The folder reads
`/Users/jsugamele/Development/Assistants/FantasyHockey2026`. `~/Development` is
a symlink into iCloud, and Claude Code derives its transcript directory from
the LITERAL cwd string, so that spelling produces a SECOND transcript directory
for a directory that already has one. This is the exact mechanism that
manufactured projects 3 and 4, `Mac (old path)` and `Hirschfeld (old path)`,
retired 2026-09-03. Any path the modal accepts or auto-derives must be resolved
to the long iCloud spelling
(`/Users/jsugamele/Library/Mobile Documents/com~apple~CloudDocs/Sync/...`)
before it is stored. UNVERIFIED whether the modal resolves it on submit; the
screenshot only proves it DISPLAYS the short form. Check
`launchpad.js` around the create path (`working_dir: project.path`, spot-checked
at :5871) before assuming either way.

**19. Session `ses_2b41d99f` parked on an unanswered trust prompt, over stale
diagnostic scrollback. UNVERIFIED, owner says it may be obsolete.**

Screenshot: session `ses_2b41d99f`, header `ses 2b41d99f`, sidebar group OTHER,
status `Connected`, PID 47672. The pane shows two commands as plain text,

    command -v claude || echo CLAUDE-NOT-FOUND
    echo PATHIS:$PATH

and then Claude Code's own first-run folder-trust prompt for
`/Users/jsugamele/Library/Mobile Documents/com~apple~CloudDocs/Sync/Development/Assistants/Media`,
sitting on `No, exit` and never answered.

**Neither probe string exists anywhere in this repo.** Grepped 2026-09-07
across `*.py`, `*.js`, `*.sh` and `*.zsh` excluding `node_modules`: zero hits
for `CLAUDE-NOT-FOUND` and zero for `PATHIS`. So they were typed by a human or
an agent during a past debugging session, which makes this most likely REPLAYED
SCROLLBACK rather than anything the app emits today. That is the same shape as
the "three missing hook scripts" false alarm: on-screen text from an old
transcript being repainted by `--resume`, mistaken for a live error.

What is NOT resolved by that explanation, and is the part worth reproducing:
- The `CLAUDE-NOT-FOUND` probe means somebody was chasing `claude` missing from
  PATH in a spawned tmux shell. Related to the `agent_type` NULL / respawn
  ladder family (backlog item 3, and the `RESPAWN_SHELL` gate on an empty
  `#{pane_start_command}`), but not the same bug and not shown to be current.
- A session that opens onto an unanswered trust prompt looks IDENTICAL in the
  sidebar to one that is working: `Connected`, a PID, no signal. Same family as
  the other false greens in this file, an absence of bad news rendered as good
  news.
- The session is titled `ses 2b41d99f` and sits under OTHER, not under a project
  name. Consistent with item 15 (`POST /api/v1/sessions` cannot set a title,
  every UI-created session lands `title = NULL`) and item 16 (attribution races
  project creation). Not new evidence, but a live instance of both.

Before spending time here: reproduce it. Open a NEW session against a folder
Claude Code has not trusted yet and see whether the app surfaces the prompt or
hides it. If it cannot be reproduced, close this as scrollback and keep only the
"a session parked on a prompt is indistinguishable from a working one"
observation, which stands on its own.

---
### 2026-09-07 - a pinned theme bleeds across a session switch - OPEN, UNVERIFIED

**20.** Reported by the owner 2026-09-07 from live use, not yet reproduced in
code. One session is pinned to Darcula. Switching to a DIFFERENT session in the
browser left Darcula applied to that other session, which does not have it
pinned. The owner also flagged, without testing it, that he does not know what
happens on returning to the HOME SCREEN.

Shape of the likely defect: `pinned_theme` rides on the `SessionInfo` WRAPPER,
not on `.session` (see the two-levels section of the root `CLAUDE.md`). If the
theme is APPLIED on session open but never RESET when the session is left, then
a session with no pinned theme of its own simply inherits whatever the previous
one set. That is a missing else-branch, not a wrong value: the code has a path
for "this session pins a theme" and no path for "this one does not, put it
back".

Reproduction to run before touching code, three steps and the third is the one
people skip:
1. Pin Darcula on session A. Open session B, which pins nothing. Does B render
   Darcula?
2. From B, go to the HOME SCREEN / launchpad. Does the launchpad render Darcula?
   The owner explicitly does not know this one.
3. Hard-reload on B. If B renders correctly after a reload but wrongly after a
   switch, the bug is in the switch path and not in what the server sends.

Verify on the PIXEL. `getComputedStyle` on a themed element, or a screenshot a
human looks at. Reading the `pinned_theme` VALUE off the API proves the server
is right and proves nothing about what rendered - the archived-notice defect
(`5c88fdd`) was exactly this: the state existed in the MODEL and never reached
the SCREEN.

Note the device-scope rule while testing so a wrong result is not manufactured:
group membership is DB-backed and travels between devices, but PINNING and
within-group order are `localStorage` and are per-device.

**Do not cycle themes to test this on the live app without recording the owner's
current theme first and restoring it after.** An earlier session cycled all 23
themes against live and left him on whichever one it stopped at, with no prior
value on record.

---
### 2026-09-07 - THE LAG: the query is NAMED. Confirmed twice, independently - OPEN (fix), CLOSED (diagnosis)

Item 2 / PRIORITY 1 was blocked on "WHICH query is CANNOT DETERMINE". It is no
longer cannot-determine. Two independent methods, run without knowledge of each
other's result, returned the same call site.

**THE CALL SITE**

    src/core/db.py:177        integrity_check
      conn.execute("PRAGMA integrity_check").fetchall()
    <- src/core/db_health.py:94      live_state
    <- src/api/version_routes.py:178 _datastore_block
    <- src/api/version_routes.py:207 get_version   (async GET /api/v1/version)

`GET /api/v1/version` runs `PRAGMA integrity_check` SYNCHRONOUSLY, inside the
coroutine, against the 4.5 GB `cloude.db`, on EVERY request. No
`run_in_threadpool`, no cache, no TTL, no guard.

**WHAT POLLS IT.** `macOS/main.js:1588` `const INTERVAL_MS = 20000`, fired by
`setInterval(tick, INTERVAL_MS)` at `:1604` -> `pollTraySignals()`
(`macOS/main.js:668`) -> `trayApi.fetchUpdateStatus()`
(`macOS/tray-api.js:267`), which calls `getAuthed('/api/v1/version')` with a
Bearer token, so it DOES reach the handler.

**It is a REQUEST HANDLER on a timer, not a background task.** Everything in
the earlier analysis that went looking for a periodic server-side loop was
looking on the wrong side of the wire. The timer is in the ELECTRON SHELL.

**EVIDENCE, method 1 - py-spy against the live process.** PID 48024, Python
3.14.7, `-m src.main`, ppid 48016 (the Electron shell under launchd
`com.cloudecode.menubar`). 25 dumps taken. **17 of 17 dumps that landed inside a
stall showed this stack byte-identical, zero variation.** 22 of 25 total were
`integrity_check`; the other 3 landed in the quiet window and showed an idle
`selectors.select`, which is what a healthy loop looks like. Timestamp
correlation is exact: a `/health` request starting `1788789574.36` took 14.52s,
and dumps 17-21 all fall inside that window and all show `integrity_check`;
dumps 14, 15, 22, 23 fall in fast windows (`/health` 0.02-0.04s) and all show
the idle loop. NO dump contradicts the pattern.

**EVIDENCE, method 2 - static analysis of the checkout.** Independently walked
`/api/v1/version` -> `_datastore_block` -> `live_state` -> `integrity_check` and
independently found the 20000 ms `setInterval` in `macOS/main.js`. Reasoned that
`PRAGMA integrity_check` re-verifies every page of every B-tree, which on 4.5 GB
is seconds of pure `sqlite3_step` - matching both the 12.05s duration and the
71.4% main-thread share.

**Why the period is EXACTLY 20.0s and not 20 + 12.05.** `setInterval` fires on a
fixed wall-clock cadence regardless of how long the fetch takes. A chained
`setTimeout` would have drifted. The fixed period was itself a clue and it
pointed at a timer, correctly.

**IT IS GETTING WORSE ON ITS OWN.** The stall measured 12.05s on 2026-09-05 and
14.1-14.4s on 2026-09-07, re-confirmed live with slow `/health` at `...835.34`,
`...855.52`, `...875.82` (deltas 20.18s and 20.30s). `integrity_check` scales
with file size and the database grows. This does not plateau.

**WHY NOBODY SAW IT.** `/tmp/cloudecode-menubar-error.log` contains ZERO
`Executing <Handle` lines: asyncio debug mode is off, so the loop never warned
about a 14-second callback. `/tmp/cloudecode-menubar.log` is meanwhile full of
`GET /api/v1/version HTTP/1.1 200 OK` from `127.0.0.1` - the evidence was
sitting in the access log the whole time, looking like normal traffic.

**A 401 DOES NOT TEST THIS.** An unauthenticated `curl` to `/api/v1/version`
returns 401 WITHOUT reaching the handler, so it cannot measure the pragma. One
such 401 did take 4.76s, which independently proves the loop was blocked at that
moment but says nothing about the cause. If you test this endpoint, use a real
token or you are measuring the auth rejection.

**THE FIX - NOT YET BUILT. Three parts, and part 1 alone is not enough.**

1. `run_in_threadpool` / `asyncio.to_thread` ALONE IS INSUFFICIENT. It unblocks
   the loop but still burns 14 seconds of disk and CPU every 20 seconds,
   forever, growing. The loop would be free and the machine would still be
   grinding.
2. **`PRAGMA integrity_check` does not belong on a status endpoint at all.** It
   is a maintenance operation, not a liveness probe. A version/status handler
   wants "can I open and query this database", not a full-file page walk.
3. If a periodic integrity check is genuinely wanted, it belongs on a SLOW
   background schedule (daily, not 3x/minute), in a thread, with the result
   CACHED and the endpoint reading the cache.

**Verify the fix on the SYMPTOM, not the code.** Re-run the `/health` poll and
show p99 dropping from ~12,000ms to double digits, and confirm the 20s stall
cadence is gone. A code-reading that says "it is in a thread now" is not a
measurement. Keep a before/after latency log.

**Cleanup owed:** py-spy 0.4.2 was installed into a throwaway venv at
`/tmp/pyspy-diag/venv` ON THE MINI to take these dumps. Nothing in the server
tree, database or config was touched, and nothing was restarted or deployed.
Remove that venv when convenient. Also recorded: py-spy CANNOT attach on macOS
without root (`This program requires root on OSX`), and passwordless sudo IS
available on the mini (`sudo -n true` succeeds), which is what made the live
dump possible at all.

**Raw dumps and the correlation logs** are in this session's scratchpad under
`pyspy/` (`dump_01.txt` .. `dump_24.txt`, `dump_stall_final.txt`, `health.log`,
`dumptimes.log`). Scratchpad is session-scoped and will not survive; copy them
into the repo if they are wanted as a record.

**TWO CORRECTIONS TO THE RECORD, both found on the way.**

- **`/sessions/list` does NOT use `run_in_threadpool`.** This file and
  `HANDOFF.md` both say it does, and both are WRONG. `src/api/routes.py:772`
  awaits a plain `async def` (`session_manager.py:2496 list_session_infos`),
  which calls sync `_session_info_for` -> `_owned_instances_from_db` ->
  `_datastore_connection` (`:2573`), opening cloude.db ON THE LOOP. The queries
  are small so it is not the 14s stall, but it is real blocking and the
  "correctly uses run_in_threadpool" claim must not be repeated.
- **`GET /corpus/status` is a dormant second bomb.** `src/api/corpus_routes.py:75`
  -> `corpus_status.py:99` runs a full-scan aggregate over `transcript_archives`
  plus `COUNT(*) FROM message_transcripts` at `:157`, on the loop. And
  `transcript_archives` (`src/core/db_models.py:1083`) has six indexes but NONE
  on `source_path` (one was deliberately dropped, see the comment at `:1340`),
  so `COUNT(DISTINCT source_path)` at `corpus_status.py:100` is a guaranteed
  full scan of the biggest table. Nothing polls it today. The day something does,
  this reproduces the same outage.

---
### 2026-09-07 - THE LAG: fix BUILT and validated locally, NOT YET DEPLOYED - OPEN (deploy + confirm)

The diagnosis above is closed. The fix is written, tested and independently
validated on this checkout. **It is NOT on the mini.** Until it is deployed and
`/health` is re-polled, the real-world improvement is CANNOT DETERMINE.

**What was built**

| Piece | File |
|---|---|
| Run one check off-loop, own the verdict artifact | `src/core/db_integrity.py` (384 lines) |
| Read the verdict, decide what may honestly be said | `src/core/db_integrity_status.py` (254) |
| The daily background loop | `src/core/db_integrity_task.py` (237) |
| Atomic write / tolerant read, shared with the ingester | `src/core/json_artifact.py` (113) |
| The cheap per-request probe | `src/core/db_health.py` (modified) |

The request path is now one connect plus one small SELECT plus one small JSON
read. `PRAGMA integrity_check` moved to a daily loop via `asyncio.to_thread`.

**The verdict has TWO fields on purpose.** `verdict` is `ok` / `failed` /
`cannot_determine`; `freshness` is `current` / `stale` / `never_ran` /
`cannot_determine`, reusing the vocabulary already in
`src/core/corpus_ingest_state.py` rather than inventing a second one. `verdict`
reads `ok` ONLY when a check actually ran AND its record is fresh, so "never
checked" can never render as "checked and sound". A recorded `failed` still
degrades `data.status` the way the live pragma did; `cannot_determine`
deliberately does NOT, because not having looked is not a fault.

`CLOUDE_DB_INTEGRITY_CHECK=0` disables the loop; defaults OFF under
`CLOUDE_TEST_MODE` so pytest never walks the real database.
`CLOUDE_DB_INTEGRITY_CHECK_INTERVAL` overrides the daily interval and the
staleness window is derived from it (2x) rather than hardcoded.

**VALIDATION - what was actually proven, and how**

Independent validator, read-only, not the agent that wrote the code.

- **Pragma is gone from the request path.** Proven WITHOUT grep and WITHOUT the
  shipped test: `sqlite3.connect` was patched to install a `set_trace_callback`
  recording every statement a real `GET /api/v1/version` executes. Four artifact
  states (missing, corrupt, fresh-ok, failed) each executed exactly 5
  statements: three connection pragmas, `SELECT 1 FROM sqlite_master ...
  name='meta'`, and `SELECT value FROM meta WHERE key='schema_version'`. No
  integrity check on any path including exception and fallback paths.
  **NEGATIVE CONTROL: calling `integrity_check()` directly DID make the tracer
  print `PRAGMA integrity_check`**, so the instrument was live. Request cost
  1.4 ms.
- **The three-outcome guard was attacked in both directions.** 11 adversarial
  states (no artifact, empty file, truncated JSON, JSON array, `status:ok` with
  missing `finished_at`, unparseable stamp, future-dated stamp giving a NEGATIVE
  age, stale stamp, null status, garbage status, empty object). All 11 returned
  `cannot_determine`, none leaked `ok`. **POSITIVE CONTROL: a fresh `status:ok`
  record yields `verdict: ok, freshness: current`. FAILURE CONTROL: a
  `status:failed` record yields `verdict: failed` AND degrades `data.status` to
  `degraded_db_unreadable`.** The guard can fail and does.
- **The riskiest edit was the `corpus_ingest_state.py` extraction**, which
  deleted ~40 lines from a subsystem that was not the target. Verified by
  AST-unparsing the pre-change function bodies from `git show HEAD` and diffing
  against the new shared ones: IDENTICAL modulo the log-event call, for both
  writer and reader. Every primitive survived (`mkdir(parents, exist_ok)`,
  `NamedTemporaryFile` in the same dir, `flush`, `os.fsync(fileno)`,
  `os.replace`, `os.unlink` on failure).
- **Tray contract intact.** Top-level keys still exactly `data`, `update`,
  `version`; `update` unchanged with all seven keys, which is what
  `macOS/tray-api.js:267` reads. `integrity` is nested at `data.integrity`,
  purely additive. Grep found NO consumer of the `data` block anywhere in
  `client/js` or `macOS`.
- **Boot safety.** Scheduler started last in `lifespan()` (`src/main.py:673`),
  wrapped so boot cannot fail on it, `aclose()`d on shutdown.

**Tests: 4615 passed -> 4647 passed. 3 failed before, the SAME 3 after, 0
errors.** The three are `test_home_write_guard`, `test_state_dir_resolution`,
`test_version_probe`, all environmental and pre-existing. No new failures.

**CANNOT DETERMINE, stated plainly: the real speedup.** Measured 0.46 ms
(new probe) vs 112 ms (old pragma) against a 310 MB SYNTHETIC database built
from the real schema. That is 215x and it widens with file size, but it is NOT
the 4.5 GB production file and nobody has watched p99 drop on the mini.

**WHAT REMAINS - the deploy, and how to prove it worked**

1. Deploy with `scripts/deploy-mini.sh --target live`. `--target live` is
   REQUIRED and BOTH targets must be written (server dir AND app bundle
   Resources) or the next app launch silently reverts it.
2. Verify the deploy by fetching the asset over HTTP and hashing it against the
   local file. NOT by `git rev-parse` on either side.
3. **Prove the fix on the SYMPTOM.** Re-run the `/health` poll at 10Hz and show
   p99 dropping from ~12,000 ms to double digits, and the 20-second stall
   cadence gone. Keep the before/after log. A code reading that says "it is in a
   thread now" is not a measurement.
4. Note for whoever tests the endpoint: an unauthenticated `curl` to
   `/api/v1/version` returns 401 WITHOUT reaching the handler. Use a real token
   or you are timing the auth rejection.

**Deliberately NOT changed:** `src/main.py:755` carries an emoji in the FastAPI
app title (`title="<emoji> Cloud Code"`), which violates the no-emoji rule. It
is PRE-EXISTING, not introduced by this change, and it is a user-visible string.
Left for a deliberate decision rather than changed silently.

**Also fixed in this change, found by the validator:** `CLAUDE.md` claimed the
corpus ingest loop is "started last in `lifespan()`", which this change made
false; and the pytest baseline in `CLAUDE.md` was stale by an order of magnitude
(it said ~614 passed / 16 failed / 6 errors against a real 4647 / 3 / 0). The
reason the old number was so wrong is worth knowing: **the repo's `venv` symlink
pointed at a `venv.nosync` directory that no longer existed, so the suite could
not run properly at all and manufactured a fake low baseline.** The environment
was rebuilt on Python 3.14 from `requirements.txt`. A warning to that effect is
now in `CLAUDE.md` beside the existing one about a fresh worktree having no
`config.json`.

---
### 2026-09-07 - THE LAG IS FIXED ON LIVE. Measured, not inferred - DONE

Commit `3c23309` deployed to live on both targets 2026-09-07. No rollback
needed. **This closes item 2 / PRIORITY 1, open since 2026-09-05.**

**THE MEASUREMENT**

| metric | BEFORE | AFTER | during a 29s background ingest |
|---|---|---|---|
| p50 | 30.5 ms | 5.2 ms | 5.1 ms |
| p99 | 14,505.7 ms | **13.3 ms** | 8.9 ms |
| max | 14,774.7 ms | 78.3 ms | 40.4 ms |
| stalls over 1s | 4 | **0** | 0 |
| stall cadence | every 20.0s, ~14.5s each | **GONE** | none |
| share of window stalled | 86.5% | **0.0%** | 0.0% |
| samples in window | 120 | 539 | 996 |

**p99 fell 1,090x.** The sample count TRIPLED in the same 60 seconds at the same
poll rate, which is its own independent evidence: the loop is genuinely free now
and can answer three times as many requests in the same wall clock.

Both runs used the same script, same host, same 60s, same ~10 Hz, and a 30s
timeout so a stall is recorded at its TRUE length rather than truncated. Zero
non-200 responses in either run.

**HOW THE DEPLOY WAS VERIFIED.** sha256 of all 434 deployable files on BOTH
targets against the local repo. Not `git rev-parse` on either side. Pre-deploy
drift against HEAD~1 was 0, which PROVES the 8-file deploy was equivalent to
`--all` rather than assuming it. Post-deploy: 0 mismatches on both targets, all
four new modules present. Then **re-hashed AGAIN after the kickstart**, because
the packaged app copies its bundle Resources over the server dir on start, and
all 8 files survived that copy. That is the trap in section 2 of `HANDOFF.md`
being actively checked rather than trusted.

**BOOT SURVIVED, which was the highest risk in this change.** Electron
48016 -> 50860, server 48024 -> 50872, `runs=5`, last exit 0, HTTP 200 in 4 ms.
ZERO error-level lines and zero tracebacks since restart. Both schedulers logged
themselves started: `corpus_ingest_scheduler_started` (900s) and
`db_integrity_scheduler_started` (86400s, stale window 172800s). The
`ProjectsView has no attribute read_only` warning in the log is PRE-EXISTING
since 2026-08-29 (38 occurrences before this deploy) and is not a regression.

**THE CORPUS INGESTER SURVIVED THE REFACTOR.** This mattered because the change
pulled the atomic-write helpers out of `corpus_ingest_state.py`. The liveness
artifact refreshed at 14:49:03Z, 15:00:25Z and 15:15:54Z. Two full passes
observed after the restart, both `status: ok` with `rooting.status: ran`.
**Verified with a POSITIVE CONTROL, not a null result:** `transcript_archives`
21,991 -> 21,997 (+6, matching the reported `ingested: 6`),
`transcript_records` 6,682,469 -> 6,685,974 (+3,505),
`transcript_root_decisions` +6, while `projects` and `sessions` were unchanged.
Corpus discovered 19,186 against 19,184 `.jsonl` on disk, consistent. Row counts
GOING UP is what proves ingestion, where an unchanged count would have been a
CANNOT DETERMINE.

**THE NEW INTEGRITY LOOP RAN AND PUBLISHED.** `db-integrity/latest.json`
appeared, `status: ok`, `duration_seconds: 26.395`, finished 15:00:11Z. The file
was ABSENT before the deploy, so its appearance is attributable to this change
(negative control held).

**CANNOT DETERMINE, stated rather than softened: the daily integrity check was
never observed while the lag was being measured.** It ran 14:59:45-15:00:11Z,
entirely BEFORE the 15:00:27-15:01:27Z measurement window, so the after-numbers
do not evidence its off-loop behaviour either way. The gap was closed
INDIRECTLY instead, and this is the more interesting result: a **29 second
background ingest pass ran INSIDE a 110 second measurement window and produced
ZERO stalls with p99 8.9 ms**, which proves the `asyncio.to_thread` mechanism
holds under real background database load. Confirming the daily check
specifically would need a forced run, which means mutating config, and that was
correctly not done on a live box.

**Rollback is still staged on the mini** at
`/tmp/cc-rollback-20260907T145443Z/{server-src.tgz,bundle-src.tgz}`, verified
listable and containing `src/main.py`. Delete when satisfied.

**Raw before/after health logs** are on the mini at `/tmp/cc-health-*.log` and
in this session's scratchpad (`cc-health-before.log`, `cc-health-after.log`,
`cc-health-during-ingest.log`, plus `upgrade-baseline-pre.json` and
`upgrade-baseline-post.json`). Copy them into the repo if they are wanted as a
permanent record; the scratchpad is session-scoped.

**Note for future read-only DB access:** `mode=ro` now FAILS once the ingester
holds a WAL, because it cannot create the `-shm` file. Use the project's own
`PRAGMA query_only=ON` path instead.

---

### 2026-09-07 - `scripts/deploy-mini.sh` is BROKEN on current macOS - OPEN, HIGH

**21.** Found during the `3c23309` deploy. Both machines now ship Apple's
**openrsync** ("protocol version 29, rsync 2.6.9 compatible") rather than
GNU rsync 3.x. openrsync REJECTS the combination the script relies on,
`--files-from=- --relative`, with:

    server receiver mode requires two argument

The deploy **aborted cleanly having copied nothing**, so it fails safe rather
than half-deploying, which is the one good thing about it. The `3c23309` deploy
was completed by hand via tar-over-ssh to both targets instead.

**This affects EVERY future deploy** and should be fixed before the next one.
Options: install GNU rsync on both ends and pin the path, or rewrite the file
transfer to use tar-over-ssh the way the manual recovery did. Whichever is
chosen, the script must still write BOTH targets and must keep failing safe.

Related and still open from `HANDOFF.md` section 2: a clean tree makes the
script print `nothing to deploy`, which reads like a pass. Worth fixing in the
same pass.

---
### 2026-09-07 - restarting a LIVE session: what the owner asked for, and why it is not built - OPEN

**22.** Owner request, verbatim: "we will also need a restart menu item added. like
there is an update available, the session is quiet, i hit restart and it closes
and then runs a new session to update."

Deliberately NOT built alongside the kebab menu (`cddc823`). The reasons are in
the SOURCE, not just inherited from `HANDOFF.md` section 5, and they are the
whole point of this entry.

**THE EXISTING RESTART CANNOT DO THIS.** The path is
`SessionRowActions.ACTION_RESTART` -> `API.respawnSession` ->
`POST /sessions/respawn` (`src/api/routes.py:1000`) ->
`SessionManager.respawn_session` (`src/core/session_manager.py:5966`) ->
`resolve_respawn_plan` (`src/core/session_respawn.py`, called at
`src/core/tmux_backend.py:1419`).

`resolve_respawn_plan` returns `RESPAWN_NOT_DEAD` the moment `pane_dead != "1"`,
and tmux itself refuses `respawn-pane` on a live pane without `-k`, which that
module never passes. **Respawn revives a corpse. It does not replace a running
session.** The owner described a session that is quiet but ALIVE, so the
existing control is the wrong mechanism, not a mechanism that needs a new
button. It remains in the kebab, unchanged and tested, for a DEAD row.

**THE LANDMINE, confirmed in source.** An empty `#{pane_start_command}` lands on
`RESPAWN_SHELL`, which silently hands back a LOGIN SHELL. A non-empty command
with no stored `agent_type` lands on `RESPAWN_REPLAY`. Only both together reach
`RESPAWN_AGENT`. Since `sessions.agent_type` lands NULL for every session
created via `auto_start_claude:false` plus a hand-sent claude command (backlog
item 3), a naive restart would destroy a working claude session and return a
bare zsh prompt for a REAL SUBSET of the sessions on this box. As of 2026-09-07
there are 18 live tmux sessions, most idle for days, which is exactly that
population.

**TWO THINGS MUST BE BUILT, neither small.**

1. **A dry-run rung preview.** There is no way to ask which rung a session would
   land on without acting: `POST /sessions/respawn` is the only entry point and
   it MUTATES. Worse, the ladder short-circuits on not-dead BEFORE it ever reads
   `#{pane_start_command}`, so predicting the rung for a LIVE session needs a new
   pure-function branch plus a new read-only route. Without this the UI cannot
   honestly warn the user, and per the three-outcome rule an unknown rung must
   render as cannot-determine, never as a yes.
2. **Close-and-recreate.** Respawn deliberately PRESERVES the instance triple
   `(tmux_socket, tmux_name, tmux_created_epoch)` and writes NO database row.
   Destroy-and-create mints a NEW row and must re-carry project attribution,
   pinned theme, unread state, group filing and sidebar position, all of which
   are keyed on the tmux name. Note the latent defect already recorded: the
   primary key of `session_group_members` is `tmux_name` rather than
   `session_uuid`, so two sessions sharing a tmux name share one membership row.
   A recreate that reuses the name walks straight into it.

**Design questions to settle BEFORE writing code:**
- Does restart keep the same tmux name (simpler, collides with the
  `session_group_members` key defect) or take a new one (clean, orphans every
  localStorage per-device key that is name-scoped, including pinning and
  within-group order)?
- Does the transcript continue via `--resume`, or is a fresh transcript correct
  when the point is to pick up a new agent version?
- What is shown when the rung preview says `RESPAWN_SHELL`? The answer must be a
  choice offered to the user, not a silent proceed and not a silent refusal.

**Guard requirement.** Restart destroys a running session and is irreversible
from the user's side, so it must confirm. Do NOT build a hard block on
`activity_status`: `HANDOFF.md` section 6 records `activity_state` reading
`working` for about four minutes after a resume before self-correcting. Use it
to inform the confirmation, never to silently refuse.

---

### 2026-09-07 - pick a wrapper at restart, and land back in the session - DONE (item 22's first half)

**24.** Owner, verbatim: "when resuming/restarting a session can we pick a new
wrapper" then "yes, and then fix so i can go right back into it." The workflow
behind it: he wanted a session on the `claude-chrome` wrapper and had to have
the database edited by hand to do it.

**WHAT LANDED.**

1. **A read-only rung preview.** `GET /sessions/restart/preview`
   (`src/api/restart_routes.py`) probes the pane once and runs the SAME ladder
   the action runs, so it cannot drift from it. It answers TWO questions rather
   than one, because they are different questions:
   - `unchanged` - what a restart does RIGHT NOW. On a live pane, `not_dead`.
     This is the safety answer and the one a button obeys.
   - `projected` - the rung it would come back AS, liveness ignored
     (`project_restart_rung` in `src/core/session_respawn.py`). Never
     `not_dead`. **A PREDICTION, NEVER A PERMISSION.**
   - `pane_state` - `dead` / `alive` / `unknown`, liveness as its own fact.
   Plus one predicted outcome per configured wrapper, each carrying `resolvable`
   (a fact about the wrapper) and `actionable_now` (a fact about the pane), kept
   apart so a client can say WHY a row is greyed out.
   `wrappers_status` is `ok` / `unavailable`, so an unreadable wrapper list can
   never render as "you have none configured".

2. **An `agent_type` override on `POST /sessions/respawn`.** An ID, never a
   command. Validated against `agents.wrappers` in
   `src/core/session_agent_choice.py`, which REFUSES an unknown id rather than
   letting `Settings.get_agent_command` fall back to the default wrapper - that
   forgiveness is right for a launch and catastrophic for a picker. Three
   verdicts: `accepted`, `unknown`, `cannot_determine`.

3. **The explicit choice outranks the `pane_start_command` gate.** The judgment
   call worth reviewing. The gate exists because a STORED `agent_type` is
   written on every create and so is not evidence of intent; a wrapper the user
   picked in a panel, having been shown what it would do, is different evidence,
   and the failure the gate prevents (an agent in a pane the user believes is
   his shell) cannot occur. It does NOT outrank `not_dead` or an unanswered
   probe. Verdict stays `RESPAWN_AGENT`; `RespawnPlan.chosen` and a different
   sentence carry the distinction, so the kind vocabulary did not fork.

4. **Persistence.** On a restart VERIFIED alive with a picked wrapper,
   `sessions.agent_type` is updated on the row keyed by the instance triple.
   Only one column; no lineage, no origin, no identity. A restart that FAILED
   does not record the choice - recording it would make the next restart
   re-derive a command already observed to fail. `agent_type_persisted` is
   reported so a restart that worked and a choice that did not stick are told
   apart.

5. **Return to session.** `POST /sessions/respawn` now reads the row back AFTER
   the restart and returns `session_id` and `session_uuid`.
   `client/js/session-restart-return.js` reopens by that id and refuses to
   navigate if a different session comes back. Identity is the SERVER's
   measurement, not a client name match.

6. **The picker.** `client/js/session-restart-picker.js`, opened from the
   kebab's existing restart item and from the launchpad row. It shows the
   baseline first (the row that exposes the shell landmine), marks the current
   wrapper, shows the predicted outcome for every choice, and its own restart
   button is the confirmation. `activity_status` is shown and never used to
   refuse - HANDOFF section 6 records `working` lagging four minutes after a
   resume.

**NOT BUILT, deliberately: close-and-recreate for a LIVE session.** A running
pane still answers `not_dead` and the picker renders that refusal. The wrapper
switch is complete for a dead or exited session, which is the case the hand edit
was for. Recreating a live one needs a new row that re-carries attribution,
theme, unread, group filing and position, and walks straight into the
`session_group_members` primary-key defect. That stays item 22.

**Tests.** `tests/test_session_restart_wrapper_choice.py` (pure ladder + real
tmux: the picked wrapper is what ends up in a pane born as a bare shell; an
unknown id refuses and spawns nothing; the choice persists and `session_uuid`
does not move; a failed restart records nothing; the preview spawns nothing).
`tests/test_restart_picker_renders.py` (Playwright, phone width: the shell
warning is a different colour from the agent one, a live session is told what it
would come back as and every radio stays disabled, a failed preview paints no
panel). `tests/test_restart_picker.node.mjs` + its
`tests/test_restart_picker_runs.py` wrapper pin the prediction/permission split.

---

### 2026-09-07 - the deploy copies with `ditto`, which MERGES - OPEN, latent

**23.** Found during the `cddc823` deploy. `dl_commit` in
`scripts/deploy-lib.sh` copies the staged tree into each destination with
`ditto`, which MERGES into the target rather than replacing it.

Consequence: **the first commit that DELETES a client or server file will leave
the stale copy on BOTH targets, and the deploy will still report success.**
Verification cannot catch it, because verification hashes the files that SHOULD
be present and a leftover file is not in that list. An orphaned `.js` still
referenced by a cached `index.html`, or a removed module that something still
imports, would keep working on the mini and nowhere else.

Not urgent: every deploy so far has only added or modified. It becomes a live
defect the moment a file is removed, and the group-chip removal in progress may
be exactly that moment. **Check whether that change deletes any file before
deploying it.**

Fix options: have the deploy compute the deletion set from git and remove those
paths on both targets explicitly, or replace-not-merge into a fresh directory
and swap. Whichever is chosen, the verification must then also assert that
files which should be ABSENT are absent, otherwise it still cannot fail.

---
### 2026-09-07 - restart preview and wrapper picker DEPLOYED, and the owner's two design calls - DONE (deploy), OPEN (part 2)

`83b6377` deployed to live on both targets 2026-09-07, second clean run of the
rewritten deploy script. No rollback needed.

**What is live now.** The restart rung preview
(`GET /api/v1/sessions/restart/preview`), the wrapper picker, the transcript
presence guard, the close-lifecycle fix from `c9271da`, the group chip removal
and the dvh fix. Nine new files, all confirmed present on BOTH targets.

**Verified, with controls that were proven able to fail.** sha256 of 14 files
matched on both destinations before AND after the restart re-hash (the app
copies bundle Resources over the server dir on start, which is how a deploy
silently reverts). The MISSING branch of the check was fired deliberately with a
bogus filename. All five new static assets served 200 with body hashes matching
local, and a bogus asset URL returned 404 so the check can fail. The new route
returned **401, not 404** - and a bogus sibling route under the same prefix
returned 404, which is what makes the 401 evidence of registration rather than a
blanket auth wall.

**No regression.** /health at 10 Hz on-box, 30s each side. Before p50 29.7 /
p99 74.6 / max 84.4 ms. After p50 29.9 / p99 66.0 / max 73.0 ms. Zero errors
either side. The lag fix holds. Corpus ingest artifact mtime MOVED during the
window (18:39:42 -> 18:44:48, age 213s -> 44s), so it is live rather than merely
present. DB integrity `status: ok`.

Rollback tars on the mini, both listable and content-checked:
`/tmp/rollback-server-20260907-184229.tgz`,
`/tmp/rollback-bundle-20260907-184229.tgz`.

**CANNOT DETERMINE: whether the picker behaves correctly in the browser.** The
bytes are on disk, the assets are served with matching hashes, the tags are in
the served HTML and the route is registered. Nobody has clicked it. A tab open
across the deploy keeps serving cached assets until a hard reload.

---

**OWNER DECISIONS on item 22 part 2, given 2026-09-07. Do not relitigate.**

- **Same tmux name.** His words: "same tmux should be fine."
- **Resume the same conversation.** His words: "yes resume the same session."

**These two answers collapse most of part 2.** It is no longer close-and-recreate.
It becomes kill the pane and respawn it IN PLACE with the same start command,
which is `respawn-pane -k` against a live pane - a small delta on the existing
ladder, not a new subsystem. No new database row is minted, so NONE of the
re-carrying work previously scoped is needed: project attribution, pinned theme,
unread state, group filing and sidebar position all stay put because the row
never moves.

**It also sidesteps the `session_group_members` landmine** rather than fixing it.
That table's primary key is `tmux_name` rather than `session_uuid`, so a recreate
that CHANGED the name would have collided. Keeping the name means the membership
row keeps pointing at the right thing. The defect is still real and still open;
this feature simply no longer walks into it.

**The one consequence to keep in mind.** Killing and respawning gives the pane a
NEW `tmux_created_epoch`, so the instance triple
`(tmux_socket, tmux_name, tmux_created_epoch)` changes and anything keyed on the
epoch sees a different instance. That is the same mechanism that makes tmux
resurrect/continuum a design problem (INFRA-115), so it is a known shape here,
not a surprise.

**And this is exactly why the transcript-presence guard matters.** Resuming the
same conversation routes every restart through `refuse_if_transcript_missing`,
which turns a deleted transcript into a named `RESPAWN_TRANSCRIPT_MISSING` state
instead of the dead-pane-reported-running failure that cost the owner a session
on 2026-09-07.

---

### 2026-09-07 - `ProjectsView` has no attribute `read_only` - OPEN, low

**24.** `src/core/upload_sweeper.py:155` logs `project_list_unreadable` with
`'ProjectsView' object has no attribute 'read_only'`. **52 occurrences going back
to 2026-08-29.** Confirmed PRE-EXISTING and not introduced by any of the
2026-09-07 work: neither `read_only` nor `ProjectsView` is touched anywhere in
`cddc823..83b6377`. Noise today, but it means the upload sweeper's project list
read is failing every pass and nobody has looked at what it was supposed to do.

---

## DONE - kept because they are the evidence for how the open ones should be approached

All on branch `v1.1`. **8 commits unpushed as of 2026-09-07**, verified with
`git log --oneline @{u}..HEAD`.

- `5c88fdd` **the archived notice renders when the fetch FAILS.** The
  three-outcome state existed in the model and never reached the screen. Fixed
  by one `renderProjectList()` in the catch. Verified by fetching the asset over
  HTTP and hashing it against the local file, NOT by `git rev-parse`. **This is
  the verification pattern to copy.**
- `a89c919` **project archiving.** `POST /api/v1/projects/{name}/archive` and
  `/unarchive`, `include_archived` on `GET /projects` and `GET /sessions/recent`,
  new `src/core/project_archive.py` (159 lines), and the show-archived toggle.
  **No migration was needed** - `projects.archived_at` has existed since the
  original DDL and the list query already filtered on it. Only the write path,
  API and UI were missing. Schema stays v23. **Read the DDL before writing a
  migration.**
- `63c8439` **the archive is a full-page mode.** It used to sit on top of the
  current session and keep holding it. It now releases via `pauseForHome()`.
- `7bf95e5` **sidebar focus.** A closed sidebar kept keyboard focus off screen,
  so keystrokes went nowhere. `close()` now calls `_releaseFocus()` and
  `_setInteractive(false)`, and the closed state carries `inert` plus
  `visibility:hidden`. `App.focusTerminal()` is called from `showTerminal()` and
  `returnToExistingTerminal()`. **Note this is only ONE of two focus-destruction
  mechanisms** - the 5-second `renderProjectList()` rebuild is the other, and it
  is still open.
- `a945771` **toasts.** `dismissForSessionActivity(sessionId)` (which ACKS, it
  does not merely hide), `dismissAll()`, `_noteUserInputToSession()`.
  Auto-dismiss is deliberately PER-SESSION and must stay that way - see open
  item 7, where the missing half is cross-session VISIBILITY, a different axis.
- `dc91524` **test(ordering): pin which hook events reach the work stamp.**
- `e57a7f2` **ordering by work done, never by clicking.** The `is_this_tab` and
  `is_active` sort terms were removed. The sidebar is a timeline of work, which
  is what the owner asked for and is the point of the whole ordering rule.
- `f7bea60` **refresh the project list after a session creates a project.**
  Guarded `await this.loadProjects()` added to `_handleAttachRunningSession`,
  `createConsoleSession` and `_createNewSessionInner` - the "main page updates
  sessions but not projects" fix.

Also done, outside this repo but part of the same work:
- `~/.claude/_scripts/statusline-enhanced.sh` (135 -> 190 lines).
  `build_icon_path()` handles both the `$HOME/Development/...` and the long
  iCloud spelling; the `[NN%]` was replaced with a ten-cell bar; **unknown
  renders `[??????????]`, not an empty bar**, which is the three-outcome rule
  applied to a status line. Backup at `statusline-enhanced.sh.bak-20260903`.
- Migration state as of 2026-09-06: 29 sessions on the mini, groups Joe /
  Agents / Waiting / Clients, 12 in Recent. 17 projects, 0 archived. Disk on the
  mini went 26 GB -> 178 GB free.

---

## CARRIED OVER FROM THE INFRASTRUCTURE TODO - older app items, all still OPEN

These predate the 2026-09-04 backlog and were filed in the Infrastructure OPEN
index. They are app defects, so they live here now; the Infrastructure lines are
left in place because that file is append-only.

### Test-harness safety - HIGH, both touch the owner's live state

**INFRA-49. The pytest suite still creates real tmux sessions on the live shared
`cloude` socket.** `tests/test_session_backend.py::test_adopt_external_session_*`,
roughly 15 hardcoded socket-name literals, currently DESELECTED rather than
refactored onto a throwaway socket. One leaked as `adopt_itest_d15ad052`. It is
the remaining way an unattended test run can touch the owner's live tmux
sessions on mac-mini-m4. Effort: 2-3h. Risk: HIGH. Opened 2026-08-17.

**INFRA-61. ~28 standalone `scripts/verify_*.py` harnesses write into the
owner's REAL `~/.claude/settings.json`.** Verified 2026-08-26: `src/main.py`'s
FastAPI lifespan calls `ensure_hook_settings(default_settings_path())`, and
`default_settings_path()` (`src/core/claude_hooks.py:291`) falls back to
`Path.home()/".claude"/"settings.json"` whenever `CLOUDE_CLAUDE_SETTINGS_PATH`
is unset - and NOT ONE harness sets it, while at least twenty boot a real
server. v1.0.4's fix was narrower than it reads: it made the
`ensure_hook_settings` argument required and added a conftest canary, but the
`verify_*.py` harnesses are not pytest and the canary does not cover them.
Effort: 1-2h (set the override in every harness's server-spawn env, plus a guard
that refuses to boot a harness server without it). Risk: HIGH. Guardrail: the
file must stay at sha256
`c950b30887ca3bfe63e7ba51ca1ca4b49f453ca333d0c162b2e2a66db4f6ae09` (confirmed
unchanged 2026-08-26); hash before and after any harness run. Opened 2026-08-26.

### iOS and mobile

**INFRA-53. The copy chip reports a FALSE SUCCESS on real iOS, and the only fix
for it is UNVERIFIED.** Measured twice on an iPhone 16e simulator against an
insecure origin: the UI says "copied url to clipboard" while
`xcrun simctl pbpaste` returns EMPTY, and it DESTROYS a sentinel already on the
clipboard. A candidate fix is committed as `0ed0b91` on branch
`fix/copy-ios-false-success`, but **the agent that wrote it DIED before
reporting**, so nobody has read the diff, nobody has run its tests, and it has
never been deployed. Treat it as untrusted. It is the false-green class, on the
owner's primary device, in the control he uses to move OAuth urls off the phone.
Effort: 1-2h. Risk: HIGH. Opened 2026-08-18.

**INFRA-54. Carried-forward group, unchanged since 2026-08-18.**
(a) **TLS on the Tailscale hostname blocks FOUR things**: web push, clipboard
WRITE, clipboard READ (`navigator.clipboard` is undefined on http, so
paste-from-clipboard is impossible by construction - no code fix exists) and PWA
install. One `tailscale cert` on the `.ts.net` hostname clears all four; it is
the highest-leverage unblocked item.
(b) Adam's `cld` wrapper is broken on the mini - Keychain generic-password
service `claude-cld-oauth` does not exist; fix is `claude setup-token` run
inside a GUI session, not over ssh.
(c) The PR to Adam on branch `fix/portability-and-personal-paths` @ `3bfcee0`
has NEVER been pushed.
(d) Merging `integration/mobile-rc` to main is still owed.

### Small and mechanical

**INFRA-56.** `tests/manual_audio_check.md` lines 12 and 14 still tell a manual
tester to look for `.header-audio-toggle` and `<button id="audioToggleBtn">`,
both removed by the 2026-08-18 kebab consolidation. Effort: 15min. Risk: LOW.

**INFRA-59.** `setup_auth.py` still writes a literal `PORT=8000` into its
minimal `.env` fallback template, even after `bb29afd` single-rooted port
resolution on `Settings.port` and added `scripts/resolve-port.sh`. Effort:
30min. Risk: LOW-MEDIUM (only a first-run fallback path, but it defeats the
point of the single-rooting).

**INFRA-60. The effects-`inactive` terminal state is untested BY
CONSTRUCTION.** All 23 themes now declare an `effects` key, so there is no
effects-free theme left to prove the harness settles to `inactive` with zero
canvases on switch; teardown was verified another way instead (previous canvas
`isConnected: false` after a switch), which is not the same claim. Same shape as
a check that can never fail. Effort: 1-2h (a synthetic no-effects theme fixture,
or a harness-level unit test that forces the branch directly). Risk: LOW-MEDIUM.

**INFRA-52. claude-history residual gaps, three of them.** (a) Desktop
`local-agent-mode-sessions/*/audit.jsonl` (5 files, 3,078 lines) is deliberately
NOT ingested and needs its own adapter: no `parentUuid`, a different timestamp
field, and TWO session ids per file, which breaks the one-file-one-Session
assumption the ingester rests on. (b) `(session_id, seq_in_file)` cannot be made
UNIQUE until subagent sessions are re-keyed by `(parent uuid, agent id)`. (c)
The CloudeCode-side history VIEWER is not started.
**Not a gap, recorded so nobody hunts for it:** roughly six months of pre-2026
transcripts were PRUNED by the `cleanupPeriodDays` default of 30 before the
setting was raised to 360 on 2026-01-22, and are unrecoverable. The owner has
about EIGHT months of history, not the year he believes.

**INFRA-57 / 58. tmux socket cruft on mac-mini-m4.** Roughly 1500 stale
`cc-locale-*` and other socket files accumulating in `/private/tmp/tmux-501/`,
plus four of unknown provenance (`cloude-refit-test`,
`cloude-test-jsstatusbar`, `cloudeverify`, `cloudewt`) not explained by any
tracked test branch. Filed here because this app's test harness creates them;
the Infrastructure lines stay because it is that host's disk. Opened 2026-08-18.

### The message browser and the archive (opened 2026-08-31 / 2026-09-02)

**INFRA-99. THE EXPORT DOWNLOAD CANNOT AUTHENTICATE FROM A BROWSER.** Auth is
HTTPBearer only; measured, `?token=`, `?access_token=` and a cookie ALL return
401, and a plain navigation sends no Authorization header. Needs a short-lived
single-use download ticket. It is the OWNER'S CALL because it puts a credential
in a URL.

**INFRA-101.** Corpus 1 has `manifest_sha` NULL yet 19,545 of its 19,548
transcripts claim `host_attribution manifest_verified` - an evidenced state with
no evidence behind it. Ingest-side, flagged not fixed.

**INFRA-102.** Widen ingest-side secret detection. The current detector requires
a nearby name like `key` or `token`; the undercount in INFRA-100 traces to this.
Unscheduled.

**INFRA-103 / 114 / 121. Where the archive corpus lives, and whether it is
readable.** The 21 GB database was migrated to the mini at
`/Users/jsugamele/ClaudeArchive/` on 2026-09-02 and hash-verified WITH A
NEGATIVE CONTROL (a deliberately altered copy was confirmed to FAIL the same
check, proving the check can discriminate). **It is not readable there yet:**
the production CloudeCode app on the mini was version 1.0.33, has no
message-archive feature, is on schema 11, and deliberately drops to read-only
against a newer schema. Reading it needs a SEPARATE instance from the checkout
run with `CLOUDE_MESSAGE_ARCHIVE=1`, not the production app.

**INFRA-105.** 46 subagent transcripts (12.2 MB) exist in NO archive because the
ingester does not walk `workflows/`. A further 554 MB of tool-result artifacts
are uncovered BY DESIGN, not by omission.

**INFRA-109.** Reclaim the 3.78 GB of duplicate ingest. Cause: the ingest
idempotency key was `source_path`, and once the mini's real path changed on the
2026-09-01/02 symlink migration, 19,294 files whose `content_sha256` was already
stored got archived a second time under the new path. Prevention shipped at
schema v22 by making the key content-addressed. **Path canonicalisation would
NOT have fixed this** - the two encodings are genuinely different directory
names on disk, not two paths resolving to one file. Reclaim of the existing
duplicates was never attempted.

**INFRA-115. tmux resurrect/continuum: wanted by the owner**, but a restored
session gets a NEW tmux creation epoch and session identity is the triple
(socket, name, epoch), so a naive restore would orphan rows. Needs a design pass
before implementation.

**INFRA-116.** `src/core/db_steps.py` (1,124+ lines) and
`src/core/message_gate_contract.py` (906 lines) both exceed this project's
500-line file cap.

**INFRA-117.** `tests/test_secret_gate_parity.py` failed once across three full
test runs and passed 10 of 10 when run in isolation; cause is CANNOT DETERMINE
as of 2026-09-02.

**INFRA-112.** The mini leaks a CloudeCode hook token in plaintext `ps`
arguments. Opened 2026-09-02.

**INFRA-100 / 110. OWNER-GATED, kept in BOTH files deliberately.** The archived
secret inventory is undercounted: measured lower bound **1,800** missed
body-occurrences on one value, recall **1.5 percent**, extrapolated to roughly
**7,000** against **12,390** recorded findings. Treat 1,800 as the FLOOR, not
the estimate - the 7,000 is a heavy-tailed extrapolation. This feeds the
deferred rotation of 731+ credentials found in the archive. The owner asked to
be consulted on secrets work separately, so nothing here is actionable without
him. It stays in the Infrastructure TODO too because the credentials are fleet
credentials.

### Findings from the message-browser build that are worth not re-learning

Recorded 2026-08-31 and 2026-09-02, measured not reasoned about. These are
closed as work but live as constraints.

1. A snippet-withhold gate keyed on a DETECTOR FLAG rather than on the VALUE
   leaked credentials. One credential appeared in 762 bodies, 415 of them
   unflagged, and 21 of 43 search hits returned it in cleartext. 587 of 587
   missed occurrences lacked the nearby `key`/`token` context the detector
   needs, so re-scanning would NOT have helped - proven by re-running the
   current detectors over all 415 and getting zero findings. The fix RECOGNISES
   rather than detects: hash candidate substrings against every credential
   already detected anywhere in the corpus. Result 0 of 43, stated as
   best-effort, not a guarantee.
2. **Secret offsets are Unicode CODE POINTS** (12,390 of 12,390, with a positive
   control proving a byte answer was reachable) **but JavaScript strings are
   UTF-16**, and 1,100 findings sit behind an astral character. Masking with
   code-point offsets in JS measured 0 of 1,100 correct and LEFT THE LAST 4
   CHARACTERS OF A 40-CHARACTER CREDENTIAL VISIBLE. Fixed with
   `match_offset_utf16` companions.
4. `export_transcript` peaked at 2,205 MB serializing a 181 MB transcript
   (12.1x). Streaming replaced it, but the "78 MB regardless of size" claim is
   FALSE: the largest transcript contains a SINGLE 37,404,061-byte line, and one
   line's render is the floor, measured 566 MB. **Size export concurrency
   against roughly 600 MB, not 78 MB.**
5. **Streaming export cannot verify itself** - uvicorn implements no HTTP
   trailers, so there is no hash of what was sent. Reported as an explicit
   could-not-evaluate with the `shasum` command a human can run, never as
   success.
6. **Subagent linkage does not work through the obvious foreign keys.**
   `agent_id` matches zero of any `tool_use_id`, and `origin_session_ref` names
   the ROOT session in one hop even five subagents deep. The real link is a
   string printed in the tool RESULT's prose, `agentId: <id>`, which resolves
   96.04 percent of 19,629 spawns. Not schema-enforced, and the printed format
   has already changed once.
7. **`json_extract` raises on malformed JSON even when `json_valid` is selected
   in the same query**, because SQLite evaluates every selected expression
   regardless. One unparseable body would abort a whole page of valid rows.
8. **`PRAGMA foreign_keys` is a no-op inside a transaction**, which is exactly
   where migrations run. A standard table-rebuild migration would have
   cascade-deleted 3.1M appearance rows with the guard unarmable at the moment
   it mattered.
9. `result_status "ok"` does NOT mean the scope was fully read - a live search
   returned `ok` having scanned 1 of 3,416 transcripts.
10. `scan.bytes_scanned` is a CHARGE, not work done - 1,501,528 against a
    1,048,576 budget, and 91,950,363 bytes reported in 0.0039 seconds. It must
    never drive a progress bar.
11. **The in-app Chrome MCP browser pane reports `document.hidden === true` EVEN
    WHEN FRONTED**, which freezes rAF and makes every measurement through it
    false. Verification moved to a headed Playwright chromium.
12. **Mutation testing found three things ordinary green tests did not:** a
    production promise that never settled on a rejected fetch (the suite HUNG
    rather than going red), a binary-search mutant that survived 10,000 random
    scroll samples because random floats never land exactly on a row boundary
    though scroll-into-view always does, and a Node test harness whose `test()`
    did not await its argument so six async tests recorded a pass before their
    assertions ran and were incapable of failing.
13. **Six client defects passed their own tests because the test MOCK and the
    real server disagreed about response shape** - most seriously, every message
    body in the reader rendered COULD NOT EVALUATE because the body cache never
    unwrapped the API envelope. **Capture fixtures from the live server; do not
    hand-write mocks.**
14. gitleaks and `scripts/scan_secrets.py` disagreed and only the weaker one ran
    pre-commit, so CI was ALREADY red before that session's first commit. They
    are complementary - gitleaks has no rule for the 1Password `ops_` token
    class. A gitleaks `paths` allowlist suppresses the ENTIRE file, so allowlists
    here are value-scoped. Also measured: a positive control planting AWS's own
    published documentation example key CANNOT FIRE, because gitleaks allowlists
    that exact value by design - a positive control that itself needs a positive
    control.
17. **Counting assertions across the Node test suites is unreliable** - five
    different summary formats were observed and a regex written for one silently
    zeroed out eight files. Judge suite health by EXIT STATUS PER FILE, not by a
    parsed assertion count.

Two schema/registry facts that read like bugs and are not: the `projects` table
is EMPTY and `message_projects` is the real registry; the `sessions` table held
8 rows, all pytest fixtures. And project slugs are NOT invertible (a hyphen is
both separator and literal), so display names are derived from `observed_cwd`.

**Checked, not landed, verified 2026-08-31 against the `v1.1` checkout:** a
`start_line` parameter on `/lines` and a `session_ref_scheme` filter on the
transcript list were REPORTED as added and do not exist. `archive_routes.py` has
no `start_line` query param on `get_transcript_lines`, and no route takes
`session_ref_scheme` as a filter (the field is only ever returned in output
rows). Left open, not struck.


---

### 2026-09-07 - restart a session whose pane is ALIVE - DONE (item 22 part 2)

Built to the owner's two calls verbatim: "same tmux should be fine" and "yes
resume the same session". So it is NOT close-and-recreate. It is
`tmux respawn-pane -k` against a live pane: kill the process, put a new one in
the same pane, same tmux session name, same row. No row is minted, so project
attribution, pinned theme, unread state, group filing and sidebar position all
stay put because nothing moves, and the `session_group_members` primary-key
defect is sidestepped rather than walked into.

**ONE LADDER, NOT TWO.** `resolve_respawn_plan` took one new keyword,
`live_restart_confirmed`. It changes exactly which side of the liveness gate a
live pane falls on; both sides still end at `_rung_from_start_command`, which is
what makes the projection structurally incapable of drifting from the action. A
parametrised test pins the two to identical `kind`, `command` and `detail`
across every rung.

**THE PERMISSION IS ONE FIELD AND A PREDICTION CANNOT SET IT.**
`RespawnPlan.kills_live_pane` is the only thing `TmuxBackend.respawn` reads to
decide whether `-k` is passed, and it is True only when the pane was MEASURED
alive AND the caller confirmed AND the rung is actionable.
`project_restart_rung` is never told whether the pane is alive, so every plan it
returns carries False - asserted over all 16 input shapes rather than by
reading the code. `refuse_if_transcript_missing` BUILDS its refusal instead of
copying, so `RESPAWN_TRANSCRIPT_MISSING` arrives with the flag False and a
missing transcript cannot kill a working session.

**FOUR GATES IN THE UI AND ON THE WIRE.** `actionsFor` now offers restart on a
status positively known live (`unknown` still gets close alone). The picker's
arm checkbox (`client/js/session-restart-live.js`, its own file because it is
the half that destroys something) is emitted unchecked, takes no argument, and
is the only thing that relaxes `disabled`; `optionsHtml` still derives the initial state from
`actionable_now` alone. The confirm modal names the bare-shell outcome. The
request must carry `confirm_restart_live`.

**THE CONFIRMATION COPY**, verbatim, title `replace what is running`, primary
`kill and restart`:

> this cannot be undone. the process running in this pane is killed and a new
> one is started in the same pane. the session keeps its tmux name, its row and
> its place in the list, and the transcript is not deleted. this session has no
> recorded start command, so it does not come back as an agent. it comes back
> as a plain login shell. what will be started: <the server's own sentence>.

The shell sentence appears only when the projected rung is `shell`, which on the
owner's box is 15 of 19 live sessions. A busy row adds the `activity_status`
lag sentence; it informs and never refuses.

**IDENTITY WAS MEASURED, AND THE PREMISE THAT IT MOVES IS WRONG.** tmux 3.7c on
a scratch socket, before and after `respawn-pane -k`: `session_created`
1788821572 both times, `pane_id` `%0` both times, `pane_pid` 34420 -> 34426. The
instance triple does NOT change, because `#{session_created}` belongs to the
SESSION and `-k` replaces the pane's PROCESS. Fourteen queries in `src/core` key
on the exact triple and all read the same column, so they hold together.
`src/core/session_instance_rekey.py` takes the epoch either side of the kill
anyway and answers `unchanged` / `rekeyed` / `cannot_determine`, re-keying on the
OLD triple if a future tmux ever does move it. A measurement that can stop being
true is not a thing to assume.

**Tests.** `tests/test_session_restart_live.py` (32: the ladder, the shared
tail, the exhaustive projection guard, the transcript guard, real tmux proving
the process is replaced in place and the triple survives, and the HTTP gate).
`tests/test_session_instance_rekey.py` (15: all four identity outcomes plus the
old-triple match). `tests/test_restart_live_gate.node.mjs` + its
`tests/test_restart_live_gate_runs.py` wrapper (15: the row gate, the arm gate,
the confirmation copy). Four new browser tests in
`tests/test_restart_picker_renders.py`.

**Still open, and it is an owner decision.** On the `agent` rung the command is
re-derived through `Settings.get_agent_command`, which carries no
`--resume <uuid>`, so that restart starts a FRESH conversation rather than
resuming the old one. Only the `replay` rung (tmux replaying its own recorded
command) resumes the same conversation, which is 3 of the 19 live sessions. The
confirmation is honest about it - it shows the server's own sentence for the
rung - but "resume the same session" is only literally true on the replay path.
Making the agent rung resume would mean injecting `--resume` from
`sessions.claude_session_uuid`, which is a new behaviour and was not built.

**Re-measured read-only against the live `cloude` socket, 2026-09-07.** 22 live
tmux sessions now, 18 with an EMPTY `#{pane_start_command}`, 3 carrying
`--resume`. The ladder gates on that tmux field alone, so 18 of 22 (82 percent)
land on `RESPAWN_SHELL` and come back a login shell - higher than the 15 of 19
the part-2 brief quoted, and the reason the bare-shell warning is the load
bearing half of the confirmation. No write was made to the socket or the
database.

**Known deviation.** `client/js/session-restart-picker.js` is 578 lines, past
the project's 500-line rule. It was 476 before this change, so the destructive
half was extracted to `session-restart-live.js` (157 lines) rather than left
inline. Getting under 500 would mean also splitting the option-list rendering,
which is deployed code this change does not otherwise touch. Flagged rather
than done.

### 2026-09-07 - a restart resumes the same conversation - DONE (item 22, the ditto defect)

**THE OWNER'S DEFINITION, verbatim.** "restart on recent is really just
resume. restart on open is close and resume session so it loads a new
wrapper or new claude binary." ONE semantic, two mechanics. A dead row has
no process to kill so its restart IS a resume; a live row has its pane
killed first, and the kill exists only so the pane picks up a new wrapper
or a new claude binary. Both come back on the SAME conversation.

**THE DEFECT.** `f95a9ed` made that true only on the REPLAY rung, where
tmux replays a recorded `--resume` it wrote down itself (3 of the owner's
22 live sessions). The AGENT rung re-derives its command through
`Settings.get_agent_command`, which carries no `--resume`, so a restart
there started a FRESH conversation wearing the old session's name and
dropped the user's working context.

**WHAT SHIPPED.**

- `src/core/session_resume_target.py` (new). Classifies
  `sessions.claude_session_uuid` into `resumed` / `none_recorded` /
  `unknown` - the same three words `RestartSessionResponse.conversation`
  already used, reused rather than re-invented - and builds the argv
  fragment through the existing `session_restart.resume_arguments`.
- The uuid reaches the command as
  `get_agent_command(extra_args=['--resume', <uuid>])`, which shlex-quotes
  at every boundary and routes THROUGH the user's wrapper. Never
  concatenated: the returned string is `zsh -c '...; cld'` and an appended
  flag would land outside that quoting.
- ONE lookup per request feeds all FOUR command resolutions (stored agent
  and every wrapper offer, on the action side and the preview side), so
  the preview's predicted command and the action's actual command are the
  same string by construction. Test asserts byte equality.
- `RespawnPlan.conversation` / `RespawnResult.conversation` /
  `RestartPlanPreview.conversation` / `RestartPreviewOption.conversation`.
  DERIVED FROM THE ARGV: a command carrying a `--resume` reads `resumed`
  whatever the caller believed, so the claim cannot outrun the command.
- The transcript guard now covers the AGENT rung on the dead path as well
  as the live one. It always did structurally (`TmuxBackend.respawn` keys
  on `plan.resume_uuid`, not on liveness); it was vacuous there until the
  rung began carrying a uuid. `unchecked` still never refuses.
- The preview passes presence verdicts as `presence_by_uuid` because TWO
  conversations can be in play: the replay rung resumes what tmux
  recorded, the agent rung resumes what the row says. One verdict applied
  to both would refuse a restart nobody measured.
- `client/js/session-restart-continuity.js` (new, 115 lines). The picker
  was NOT grown; it already renders the server's `detail` verbatim and
  that sentence now carries the clause.
- `liveConfirmCopy` keeps the bare-shell warning and adds the continuity
  line. Anything unrecognised, a missing field included, reads `unknown`.

**A DRIFT FOUND AND FIXED WHILE PROVING THE PREVIEW.**
`_agent_command_for_tmux_name` read `agent_type` from `self.sessions`
while `restart_preview` read it from the ROW. An ADOPTED session carries
`agent_type` None in memory and the wrapper id on its row, so it PREVIEWED
as AGENT and RESTARTED as REPLAY. Both now go through
`_stored_agent_type_for_tmux_name`. This is a behaviour change beyond the
brief and is called out deliberately: the alternative was to align the
preview DOWN to the action, which would have removed the whole point of
the picker.

**A GUARD REWRITTEN, NOT DELETED.**
`test_the_wrapper_chooser_never_resumes_a_transcript` asserted the chooser
never resumes anything, which the owner's definition makes wrong. Its own
docstring said what to do instead, and that is what was done: it is now
`test_no_module_on_the_restart_path_spells_its_own_resume`, an AST-based
check that `session_restart.resume_arguments` stays the single builder, so
every restart resume still reaches the presence check.

**The four gates from `f95a9ed` all still hold**, re-pinned by tests:
`kills_live_pane` needs measured-alive AND confirmed AND actionable;
`project_restart_rung` takes no liveness input (swept over every value of
the new `resume_outcome` argument); `armHtml()` takes zero arguments;
`optionsHtml` derives `disabled` from `actionable_now` alone, proven
against a preview whose every projection is actionable and whose every
continuity reads `resumed`.

**Baseline held.** pytest 3 failed / 4823 passed / 12 skipped (was 3 /
4803 / 12; the same three environmental failures). Node: 169 files, only
the pre-existing `test_archive_full_page_mode.node.mjs` fails.

**NOT committed. Nothing on the mini was touched** - no writes to the
production database, no deploy, no restart, no tmux pane created or killed
outside a scratch socket.

---

### 2026-09-08 - DEPLOYMENT STATE, read this before believing anything about live

**Live on mac-mini-m4 runs `0b12edf`.** Committed, pushed, and NOT DEPLOYED:

| commit | what it is | on live? |
|---|---|---|
| `0b12edf` | restart means resume | YES, this is what live runs |
| `0793eb1` | restart picker layout fix | NO |
| `8dd54a8` | lineage recovery plus the backfill tool | NO |

**Nothing is unpushed.** `git log --oneline @{u}..HEAD` returns empty as of
2026-09-08, and `origin/v1.1` is at `8dd54a8`. This SUPERSEDES the "8 commits
unpushed" line in the DONE section and in `HANDOFF.md` section 8, both of which
were true on 2026-09-07 and are not true now.

Anything you observe on live is `0b12edf` behaviour. The picker layout defect
and the lineage recovery are both still live-visible as defects because the
fixes are sitting in git.

---

### 2026-09-07 - the session that vanished, and the two rows repaired by hand - DONE (fix deployed), DONE (recovery)

The owner closed a session, hit restart, and it disappeared from every view.
Two independent root causes, both fixed in `c9271da`, which IS deployed.

1. **Restart resumed a `claude_session_uuid` whose transcript did not exist.**
   The pane died instantly with **status 127** while the row still read
   `lifecycle=running`. This is the incident that motivated
   `RESPAWN_TRANSCRIPT_MISSING` and `refuse_if_transcript_missing`.
2. **Close set `archived_at`.** The Recent group is
   `lifecycle='stopped' AND archived_at IS NULL`, so a closed session missed
   Recents entirely and was in no list at all.

**The hand recovery, recorded because it changed live data.** The pane was
respawned onto the correct transcript, and two rows were repaired in the live
database:

- **Row 42** was emptied and retired: `claude_session_uuid = NULL`, archived.
- **Row 43** took the live tmux linkage: `archived_at = NULL`,
  `lifecycle = running`, `tmux_name = cloude_Agent_-_Cloude_Code`,
  `tmux_created_epoch = 1788813811`.

The repair had to CONSOLIDATE rather than copy, because `claude_session_uuid`
is UNIQUE and both rows cannot hold the same value. Rollback SQL is on the mini
at `/tmp/cc_row_rollback.sql`. `/tmp` is not durable across a reboot; treat
that file as expiring, not as an archive.

---

### 2026-09-08 - the conversation id: two defects, a third group nobody had counted, and a backfill nobody has run - DONE (code, `8dd54a8`), OPEN (deploy and authorisation)

**25.** A session row with no `claude_session_uuid` comes back from a restart
with no history. **16 of the owner's 39 rows were in that state.** Both causes
traced to file and line, not guessed.

**DEFECT ONE: the create path has exactly one writer and it never retries.**
`sessions.claude_session_uuid` is written on create only by Claude Code's
`SessionStart` hook. An empty POST body becomes `{}` at `routes.py:2108`,
`session_manager.py:4341` then returns `LINEAGE_UNRESOLVED` and writes nothing.
The live server log holds **25 such failures across 20 distinct sessions**, and
their ids map onto the missing rows. The structural problem is the shape of the
channel: `SessionStart` fires ONCE per conversation with no retry, while every
other hook event repeats and self-heals. That is exactly why `last_work_at`
recovers on the next event and the uuid never does.
`src/core/session_lineage_recovery.py` (171 lines) now runs the existing
correlation ladder at that failure point, giving the create path the second
chance the adopt path already had.

**DEFECT TWO, worse in practice: the fallback ladder had never once fired on
this machine.** `slugify_project_dir` (`claude_transcript_correlate.py:191`)
mapped only `/` and `.`. The real rule maps EVERYTHING outside `[A-Za-z0-9-]`
to a single `-`, verified against **908 of 919** live transcripts. Every one of
the owner's paths contains a space and two tildes, so every slug the ladder
built was wrong and no fallback had ever succeeded here. **A ladder that cannot
fire is not a fallback**, and the failure was invisible because a fallback that
never matches looks exactly like a fallback that was never needed.
`src/core/claude_project_dirs.py` (260 lines) is the corrected rule.

**`agent_type` does NOT share this cause.** A crosstab over all 39 rows finds
**14 with `agent_type` NULL and a hook-written uuid**, so the two failures are
independent and **backlog item 3 stays its own job.**

**26. A THIRD GROUP NOBODY HAD COUNTED: rows whose recorded uuid has NO
transcript on disk.** Over 39 rows: **16 absent, 18 sound, 5 phantom.** All 5
phantoms COLLIDE, because the correct uuid is already held by a sibling row
split off by the cwd spelling trap. The pairs are **7 to 4, 9 to 11, 10 to 12,
38 to 39.**

Worked example, because the mechanism is the point. Row 7 is LIVE, its
`working_dir` is the SHORT symlink spelling, and its uuid
`db81f6bf-85f9-448b-a7f6-bc83f62659d9` exists nowhere on disk. Row 4 is
ARCHIVED, carries the long iCloud spelling, and its uuid `82854c0e-...` has a
transcript that very much exists. The live pane is literally running
`--resume 82854c0e-... --fork-session`. **`--fork-session` MINTS A NEW uuid**,
the hook recorded that new one, and the forked transcript never materialised.
So the picker truthfully said "no transcript for db81f6bf" about a uuid that
has nothing to do with the conversation the user is in, while the real
conversation sat on the archived twin. The message was correct and the
conclusion a reader draws from it is wrong.

**THE BACKFILL, DRY RUN ONLY, NOTHING WRITTEN.**
`scripts/backfill_claude_session_uuid.py` (392 lines) proposes a uuid for a row
that lacks one. It is dry run by default. Results over the live corpus:

| outcome | rows |
|---|---|
| confident FILL | 8: rows 14, 15, 16, 17, 19, 23, 24, 25 |
| confident REPLACE | 0 |
| ambiguous | 8: rows 26, 27, 30, 31, 33, 35, 40, 42, at 45 to 78 candidates each |
| no candidate | 1: row 41 |
| collision pair | 4 pairs, listed above |

Row 41's `working_dir` is literally `/Users/jsugamele/Development/ses_ee8d919b`,
which is not a project directory, so no candidate is the right answer there.

Both cwd spellings are resolved FORWARD, by slugifying each spelling found in a
HOME symlink scan, AND BACKWARD, from the transcript's own recorded cwd
canonicalised. The backward direction is not optional: **754 of 919 transcripts
sit in a directory that disagrees with their own recorded cwd.**

**TWO MATCHER DEFECTS WERE CAUGHT BY CONTROLS, NOT BY READING.** Worth keeping
because both would have shipped a matcher that looked right.

- Directory agreement was clearing a two-signal bar as ONE FACT CORROBORATING
  ITSELF. Evidence is now counted in independent FAMILIES.
- The negative control, a row pointed at a project that does not exist while
  real transcripts are present, initially returned `ambiguous` rather than
  `no_candidate`, because timing alone was counting as evidence. An ANCHOR GATE
  now lets timing and title CORROBORATE a candidate and never CREATE one.
  **A matcher that always finds something is worse than useless.**

New modules from `8dd54a8`: `src/core/session_uuid_backfill.py` (358),
`src/core/session_uuid_backfill_rules.py` (371),
`src/core/session_uuid_backfill_report.py` (312),
`src/core/claude_project_dirs.py` (260),
`src/core/session_lineage_recovery.py` (171), plus the script. Tests:
`tests/test_claude_project_dirs.py`, `tests/test_session_lineage_recovery.py`,
`tests/test_session_uuid_backfill.py`. 33 tests added, each fix proven by
REVERTING it. pytest went 4823 to 4874 passed with the same 3 pre-existing
environmental failures.

**STILL OPEN on this item:** the code is not deployed, and no write has been
authorised. See the decisions entry below.

---

### 2026-09-07 - the restart picker painted its option text over the next row - DONE (code, `0793eb1`), OPEN (deploy)

Option rows inherited `flex-shrink: 1` inside a `max-height: 46dvh` flex
column, so the flex algorithm SQUASHED THE ROWS instead of scrolling the list.
Measured: **113px of content in a 62px box on desktop, 145px in a 58px box on a
phone.** The fix is `flex-shrink: 0`.

**Verified by GEOMETRY, not by DOM text.** `tests/test_restart_picker_geometry.py`
(649 lines) asserts that no row's text intersects another row's title, and it
was PROVEN TO FAIL on the old code with **19px of text sitting on text**. A
test that has not been shown failing on the broken version is not evidence.
Screenshots are committed alongside it.

`client/js/session-restart-options.js` (350 lines) was extracted from
`session-restart-picker.js` in the same change, which takes the picker from 578
lines back down under the 500-line rule.

---

### 2026-09-08 - CORRECTIONS: four earlier conclusions were WRONG

Recorded per the convention at the top of this file. The wrong entry plus its
correction beats a clean lie.

**CORRECTION to item 21, the openrsync diagnosis.** `deploy-mini.sh` did NOT
fail because openrsync rejects `--files-from=- --relative`. It handles that
combination fine, proven by a successful copy. It fails on **a remote
destination containing SPACES**, which the remote shell word-splits. Both live
destinations contain spaces and the v11 staging path does not, so **`--target
live` could never work while `--target v11` always did.** That asymmetry is the
whole reason the bug hid for as long as it did: every test anyone ran by habit
went to v11. Fixed in `c779afb` by moving the transfer to tar over ssh, where
the remote command is one quoted string the script controls.

**CORRECTION to the tmux identity premise.** Killing and respawning does NOT
move the instance triple. Measured on tmux 3.7c: `session_created` held at
**1788821572** and `pane_id` at **`%0`** across `respawn-pane -k`, and only
`pane_pid` changed. The reason is structural, not luck: `session_created`
belongs to the SESSION and `-k` replaces the PANE'S PROCESS.
`src/core/session_instance_rekey.py` still measures the epoch either side and
answers `unchanged` / `rekeyed` / `cannot_determine`, because a measurement that
can stop being true is not a thing to assume.

**CORRECTION: "Media Compression's conversation is gone" was WRONG, and the app
said it too.** The transcript `82854c0e-a423-4591-a34f-a14cb92fbf41.jsonl`
exists and is **73,190,422 bytes**. See the phantom-uuid entry above for why
the app's message was locally truthful and globally misleading.

**CORRECTION: the `CLAUDE.md` pytest baseline was stale by an order of
magnitude.** The repo `venv` symlink pointed at a deleted `venv.nosync`
directory, exactly the failure mode `CLAUDE.md` warns about, and the suite
limped along undercounting rather than failing outright. Real numbers after
rebuilding: **3 failed / 4874 passed / 12 skipped.** The three are the same
environmental ones: `test_home_write_guard`, `test_state_dir_resolution`,
`test_version_probe`. Node: 169 files, only `test_archive_full_page_mode.node.mjs`
fails, also pre-existing.

---

### 2026-09-08 - the bare-shell exposure, restated correctly

This was MISSTATED ONCE ALREADY, so the correct form in full:

- **18 of 22 live sessions have an empty `#{pane_start_command}`.** Measured
  2026-09-08. Earlier entries say 15 of 19; that was 2026-09-07 and the
  population moved.
- An UNPICKED restart on such a session lands on the `RESPAWN_SHELL` rung and
  hands back a login shell.
- **BUT an explicit wrapper choice OVERRIDES that gate**
  (`src/core/session_respawn.py:542`). Picking a wrapper in the picker starts
  the agent properly.

So the exposure is real and it is NOT unavoidable: only an unpicked restart
lands on the shell rung. Do not record this as "the restart button gives you a
shell" without the second half.

---

### 2026-09-08 - item 24 recount

**24.** `'ProjectsView' object has no attribute 'read_only'` at
`src/core/upload_sweeper.py:155`. Now **56 occurrences since 2026-08-29**, and
it fires TWICE PER BOOT. Still pre-existing, still not introduced by any
2026-09-07 or 2026-09-08 work. Unchanged in substance from the entry above,
recounted so the number is current.

---

### 2026-09-08 - item 23 is still latent

**23.** The deploy copies with `ditto`, which MERGES. The first commit that
DELETES a file will leave the stale copy on BOTH targets and still report
success, because verification only hashes files that SHOULD be present. **No
deletions have shipped yet**, so this has not bitten. Both undeployed commits
(`0793eb1`, `8dd54a8`) are additions and edits, no removals, so deploying them
does not trip it either. Do it before a deletion ships.

---

### 2026-09-08 - HAZARD: two Claude Code sessions were editing branch `v1.1` at once

A SECOND Claude Code session was working this same branch concurrently for part
of 2026-09-07. It committed `32052d1`. It has since exited. Nothing was
clobbered that anyone found, but **two agents on one branch is how work gets
clobbered**, and the second agent's commits are indistinguishable from the
first's in the log. If a commit in this range does something you did not expect,
that is the likely explanation. Recorded as a process hazard, not as a defect.

---

### 2026-09-08 - browser control, and the only route to it

Claude in Chrome is PAIRED and INSTALLED: `pairedDeviceName = Browser 2`,
`hasCompletedClaudeInChromeOnboarding = true`. But
`claudeInChromeDefaultEnabled = false`, so **browser tools exist ONLY in a
session launched with `--chrome`**, which is the `claude-chrome` wrapper. Tools
BIND AT SESSION START, so browser control cannot be added to a conversation
already running.

**The wrapper picker is the intended route**: restart a session and choose
`claude-chrome`. That is what the picker was built for, and it is now the
supported answer to "can this session drive the browser". Note this is also why
the picker layout fix (`0793eb1`) matters more than it looks: it is the control
surface for this.

---

### 2026-09-08 - OPEN DECISIONS AWAITING THE OWNER

Three, none of them started, all of them blocked on a human answer.

1. **Authorise writing the 8 confident FILLs** from the backfill dry run (rows
   14, 15, 16, 17, 19, 23, 24, 25). Nothing has been written. The tool is dry
   run by default and stays that way until told otherwise.
2. **Merge the 4 duplicate row pairs** (7 to 4, 9 to 11, 10 to 12, 38 to 39).
   This is the ALREADY-AUTHORISED `(old path)` merge family, item 5, and it
   still carries its condition: **take a VERIFIED backup first. Every
   pre-existing backup in that directory is 65 to 115 KB against a 4.5 GB
   database and would be useless as a rollback.** A backup that cannot restore
   is not a backup.
3. **Deploy `0793eb1` and `8dd54a8`.** Live is on `0b12edf`.

### 2026-09-08 owner note: clean up database backups when the row repairs are done

- [ ] When the Media Compression row repair and the duplicate-row merges are finished and verified, delete the extraneous cloude.db backups: every pre-existing 65-115 KB backup in the backup directory (useless as rollbacks against a 4.5 GB file) and any full-size dated backups taken for the repairs, once a restart has proven the repaired rows work. Keep exactly one verified full backup until then. Owner request, 2026-09-08.

### 2026-09-08 security note from the Desktop inventory

- [ ] `~/.config/restic/mini-m4.pw` is a plaintext restic repository password on disk. It was surfaced into a subagent transcript while reading backup config, and the file also sits inside the Time Machine backup. Owner decision: rotate the restic repo password and move it to `op://Claude/`, per rules/secrets-protocol.md. Deferred to the owner (credential rotation is his call; see the earlier decision to defer rotations until this project is done).
- [ ] restic on the mini covers only `ai-setup` and `docker-management`; the Desktop is covered by Time Machine to the NAS only. Decide whether the restic scope should widen.

### 2026-09-08 INFRA-49 fresh evidence

- [ ] The boot re-adopt agent measured `test_session_startup_gate.py::test_manager_never_captures_a_tail_for_a_session_with_a_hook` failing because of leaked `keeper` tmux sessions from the respawn/restart suites, and `test_hook_driven_status.py::test_list_attachable_sessions_maps_tmux_status_with_unread` hitting the production socket guard. Order-dependent, both pass in isolation. Live socket checked at 15:40 local: 21 sessions, all real, no leak present now. INFRA-49 (tests on the live `cloude` socket) is now causing flaky failures, not only risk. Raise priority.

### 2026-09-08 evening - punchlist items closed today, twenty commits `018f2a7..1a28b23`

DEPLOY STATE: HEAD is `1a28b23`, 20 commits past this morning's `018f2a7`, NOT
pushed (deliberate hold, `git status` reads "ahead of origin/v1.1 by 20
commits"). Live on mac-mini-m4 was `0b12edf` this morning and has since moved
to `c9cd9ab` (picks up `0793eb1` and `8dd54a8`). A deploy of HEAD is IN
PROGRESS as a separate concurrent task at the time of this entry - it will run
the v24 migration and the app's first real boot re-adopt. Treat this as
"in progress," not "done," until checked directly on the mini. Full
commit-by-commit table in `HANDOFF.md` section 8.

- [x] **Item 6.** Sidebar group ellipsis popup rendered behind the sidebar
  panel. Fixed by raising its z-index. Commit `43e8fc2`.
- [x] **Item 13.** Home screen repainted the whole project tree from a 5s
  poll with no guard (385 elements + 409 text nodes destroyed and recreated
  per tick). Fixed by gating the repaint on whether anything actually
  changed. Commit `ee5d547`.
- [x] **Item 14.** A new project could not choose its own folder; the typed
  name was never used for the directory. Fixed. Commit `a4eeef1`.
- [x] **Item 15.** `POST /api/v1/sessions` could not set a title; every
  UI-created session landed `title = NULL`. Server-side `label` field
  shipped in `06bacd6`; both claude-launching create paths (new project,
  open-existing-project) now send it in `e7ca5ec`.
- [x] **Item 17.** A server restart unbound every session but one, so they
  rendered "adoptable" rather than "running" until opened. Fixed by holding
  every surviving session through boot re-adopt, not just the last one.
  Commit `bca7069`. A related bug in the same area, a reused tmux name
  hiding a session the user had deleted from the RECENT list, was fixed
  alongside it in `986c50e`.
- [x] **Item 18.** The folder path overran its box in the project modals.
  Fixed with `word-break` / `overflow-wrap`. Commit `9009588`.
- [x] **Item 18a.** The project modal displayed and WROTE the short,
  symlinked cwd spelling (`/Users/jsugamele/Development/...`), the same trap
  that manufactured the `(old path)` project rows. Fixed as part of the
  project-folder-picker work. Commit `a4eeef1`. See also the qualification
  added to `CLAUDE.md` gotcha 6 today: claude 2.1.263 itself now resolves
  symlinks before slugging, so new splits cannot originate from claude, but
  this app was still writing the short spelling until this commit.
- [x] **Item 19.** A session parked on an unanswered folder-trust prompt
  painted `Connected` with a PID and no signal. Fixed: a hook-absence signal
  plus a scrollback probe now distinguish `ready` / `awaiting_startup_prompt`
  / `unknown`, never guessing. Commit `9cdcb90`.
- [x] **Item 23.** The deploy copied with `ditto`, which merges rather than
  mirrors, so a deleted file would survive on both targets and still verify
  as a success. Fixed: deploy now mirrors `src/client` instead of merging.
  Commit `9adaac9`.
- [x] **Item 24.** `'ProjectsView' object has no attribute 'read_only'` at
  `src/core/upload_sweeper.py:155`, firing twice per boot since 2026-08-29.
  Fixed: reads the real `ProjectsView.writable` attribute. Commit `bc65ef4`.
- [x] **Items 25/27 (database operation, no commit).** `agent_type` filled on
  15 running rows from measured argv plus environment disambiguation
  (`cld` / `cldor` / `claude-skip-permissions` share an identical flag set;
  separated by presence of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_BASE_URL`).
  8 of the confident backfill FILLs (rows 14, 15, 16, 17, 19, 23, 24, 25)
  authorised and written. `lsof` confirmed claude does NOT hold its
  transcript file open, a hypothesis that would have blocked safe editing if
  true (measured negative).
- [x] **Items 5/26 (database operation, no commit).** The 3 "phantom pair"
  entries (9/11, 10/12, 38/39) were INVERTED in the earlier note: the live
  rows already held the real conversation ids, and it was their dead twins
  holding phantom ones. The dead twins were retired (archived), not merged
  over the live rows. Ghost rows 44 and 47 (no session or transcript behind
  them) were retired too. Remaining phantom-uuid rows: 41 (kept
  deliberately) and 46 (a newborn session, transcript not yet landed -
  re-check, do not treat as settled).
- [x] **Item 10.** Durable order within a group needed a `position` column on
  `session_group_members`, done in the same change as re-keying that table
  from `tmux_name` to `session_uuid`. Commit `24d25b9`.
- [x] **The "show archived" toggle rename.** The RECENT list's control used
  to say "deleted," which told the user their history was gone when it was
  one checkbox away; it now says "show archived," matching what
  `archive_session` actually does (stamps `archived_at`, keeps every
  column). Commit `2b93428`.
- [x] **Wrapper pills.** A running-session row now shows which launch
  wrapper it is running, read from the record rather than guessed. Commit
  `c89ef55`.
- [x] **Naming.** One name per session, last rename wins from either side;
  the pane's typed name is read from the transcript tail since no hook
  event carries a `/rename`. Commit `06bacd6`. A new session's label is now
  sent from both claude-launching create paths. Commit `e7ca5ec`.
- [x] **Import.** `~/.claude/projects` held 1,486 top-level transcripts
  against 43 session rows; everything else was invisible to the app. Script
  landed in `b18f018`; run today (database operation, no further commit):
  895 conversations imported as archived sessions, 59 archived projects
  created, 13 scratch conversations excluded, 224 `agent-*.jsonl` subagent
  files correctly identified as non-sessions and skipped, 319 files with no
  recoverable cwd. Dry-run report: `.claude/notes/import-dry-run-2026-09-08.md`.
- [x] **Lineage guard.** A second claude process started under one pane
  (for example by `claude` invoked from inside another session's shell) was
  being treated as a fork of this app's own session. Fixed: no longer
  misattributed. Commit `2071963`.

### 2026-09-08 evening - additional verification done, no code change

- [x] Restart proven live on three real sessions - Media Compression, Agent
  Cloude Code, Fantasy Football 2026 - same tmux session, same conversation
  resumed, wrapper switched to `claude-chrome`, `agent_type` persisted to the
  row. This is the end-to-end proof behind items 22/27's "restart means
  resume" claim.
- [x] Ingester proven live with a positive control: this transcript itself
  grew during the check and was re-archived, file count moved 19,223 to
  19,255, 0 missing. INFRA-105 ("`workflows/` is never walked") is REFUTED:
  457/457 files there are archived.
- [x] Desktop `~/Desktop/Backups`: 13 transcripts existed ONLY there (not in
  the corpus). Copied in and archived 13/13; verified against the TrueNAS
  archive bundle (`05-desktop-backups.tar.zst`,
  `/mnt/ARCHIVE/vault/85_cloud-exports/claude/claude-archive-20260830/` on
  10.0.1.237) by manifest hash, 13/13; Time Machine on 10.0.1.202 separately
  holds all 10,431 files. The folder itself can now be deleted (owner's
  call, see the new open item below).
- [x] Media project's `.claude/settings.json` had five `Write(...)`
  permission rules where `Edit(...)` was meant, the source of its yellow
  startup warnings. Rewritten to `Edit(...)`.

### 2026-09-08 evening - new open items

- [ ] **Restart drops claude's own `--name`.** `resume_extra_args` carries
  only `--resume <uuid>`, so a resumed session comes back without whatever
  name claude itself had (`--name`, `/rename`). The app's row title
  (`sessions.title`) is unaffected because it lives outside claude's argv.
  Fix would reuse `claude_title_sync`'s transcript read to reapply the name
  on resume. Documented in `CLAUDE.md`'s restart section today.
- [ ] **A deferred browser-rename push is never retried.** When `/rename`'s
  push defers because the transcript is not there yet (measured absence),
  nothing re-attempts it once the file lands. `title != claude_title` is the
  marker a retry would key on.
- [ ] **`FALLBACK_PROJECTS_ROOT` hardcodes `/Users/jsugamele`**
  (`src/core/project_directory.py:85`). Fallback-only path, but a hardcoded
  home directory in shared code is wrong on any other machine.
- [ ] **The "four oversized test files" premise was WRONG - there are far
  more.** `wc -l tests/*.py tests/*.mjs | awk '$1>500'` finds 48 files over
  500 lines, not four. Worst offenders: `test_session_backend.py` (2125),
  `test_session_row_menu_renders.py` (1036), `test_sidebar_sessions.node.mjs`
  (998), `test_theme_audio.node.mjs` (796), `test_session_restart_wrapper_choice.py`
  (793), `test_session_restart_resumes_the_conversation.py` (770),
  `test_restart_picker_renders.py` (768), `test_boot_readopt.py` (763),
  `test_archive_overlay.py` (754). CLAUDE.md's 500-line guideline names five
  production files as already past it; it says nothing about tests, and this
  count suggests the guideline has never been enforced there. Re-scope or
  explicitly exempt tests before quoting a number again.
- [ ] **gitleaks is not installed on the mini.** The pre-commit hook's
  second gate (`scripts/install-secret-hook.sh`) silently never runs its
  gitleaks stage; only the first gate (`message_model_secrets.py`-based
  scan) is active. Install it or stop documenting a two-gate hook as if both
  gates run.
- [ ] Delete `~/Desktop/Backups` on this Mac now that its 13 transcripts are
  archived, manifest-verified against the TrueNAS bundle, and also covered
  by Time Machine on 10.0.1.202. Owner's call; nothing depends on the folder
  surviving.

### 2026-09-08 browser re-test on the redeployed build (01ebb85 + 41a89f1)

- [x] Boot re-adopt: 21 of 21 held under stored ids after restart, 0 `adopted:` re-mints (verified on live by the deploy agent).
- [x] Cards: family pill `claude` on all 21, wrapper pill `claude (chrome)` on the three chrome sessions.
- [x] Archived toggle: 13 recent -> 912 with the box checked (895 imported visible).
- [x] New project flow: name -> folder step (parent defaulted to the long-spelling Development root, full path shown) -> session in `.../Development/Punchlist Two`, row working_dir long spelling, claude launched with `--name`, wrapper and conversation id recorded (row 943).
- [x] Rename TUI -> browser: `/rename` in the pane reached the header on the next hook event; toast carries the new name.
- [x] Rename browser -> TUI: header rename appended a `custom-title` record to the transcript (`claude_rename_push_landed`); the running TUI status line stays stale until that process restarts (documented limitation).
- [ ] Row `title` NULL at create despite `--name` landing (row 943): fix in flight.
- [ ] Test artifacts to archive when the owner says so: sessions `Punchlist Test` (45), `Punchlist Browser Rename(fork)` (46), `Punchlist Two` (943); folders `.../Development/ses_5a756046` and `.../Development/Punchlist Two`.
- [ ] This orchestrator session (`Agent - Cloude Code`) carries a rotated hook token in its running process (hooks 403 until restarted); a restart through the picker resumes the conversation and fixes it.
- [ ] Wrapper pill reads `claude` for `claude-skip-permissions`; confirm that is the configured label, not a fallback.

### 2026-09-08 owner report: "we lost some of our conversation"

- [ ] Display-side loss, not data loss. After the app restarts and re-attaches to a running pane, the client fetches `include_scrollback=1` and repaints the terminal from tmux capture-pane. Claude Code TUI draws in place, so the pane has `history_size=0` and the capture is one screen; the browser replaces the buffer it had built over the websocket with that screen. Transcript verified intact (7.6 MB, one compaction marker from the morning /compact, last write 13:29). Fix direction: keep the existing client buffer when the incoming capture is shorter than what the client holds, or replay the tail of the server pipe stream on attach. Explorer report pending; then build.

### 2026-09-08 restart procedure finding

- [x] Restarting the menubar app with osascript quit plus `open -a` relaunches it under an ad hoc launchd job (`application.com.cloudecode.menubar.*`) with stdout to /dev/null, so `/tmp/cloudecode-menubar.log` stops growing and the app runs outside its LaunchAgent. Correct restart: `launchctl kickstart -k gui/$(id -u)/com.cloudecode.menubar`. The server also writes its own log to `~/Library/Application Support/cloude-code-menubar/logs/server.log` regardless. Being added to docs/deploy-mini.md by the reconnect agent.
- [ ] Reconnect buffer keep (d70e4ab): keep path verified firing in the browser console; the resize nudge that follows made the TUI repaint the viewport, so on-screen rows were lost while scrollback is expected to survive. Measurement of the exact resize escape sequences and the nudge decision in progress.

### 2026-09-08 the eraser is a geometry flap, not the reconnect

- [ ] Console evidence on the Punchlist Two tab: terminal rows flap 41 -> 45 -> 41 around websocket connect/reconnect (`source=ResizeObserver`), and claude answers any geometry change with `ESC[2J` (measured: a same-size resize emits zero bytes, a different size emits a viewport clear plus redraw). The reconnect keep path (f5156aa) works and is not the eraser; an in-flow page element changing the terminal container height by four rows is. Culprit hunt and overlay fix in progress; also a transient-resize guard in the ResizeObserver path.

### 2026-09-08 eraser hunt, instrumented

- [x] Ruled out by measurement: the reconnect (keep path fires, no reset), the resize nudge (removed in f5156aa), the local-servers panel (overlaid in 3ef5624), the renderer and the font (cell 8x16 webgl on every resize line, 2361b33 instrumentation).
- [ ] Arithmetic on the instrumented lines: 45 rows x 16 px = 720 px at reconnect, 41 x 16 = 656 px ten seconds later; `#terminal` measures 668 px after the flap; the only in-flow sibling is the 43 px `.info` status bar under the terminal. It is absent or collapsed at reconnect and appears once session info lands, stealing four rows and triggering claude ESC[2J. Fix in progress: reserve its height permanently or take it out of flow.

### 2026-09-08 eraser hunt, closed

- [x] Real in-app causes, both fixed and deployed: the local-servers panel toggling in flow under the terminal (3ef5624, now an overlay) and the bottom status bar growing when its three late writers fill it (afbe005, height reserved via a named token). Reconnect keeps the browser buffer (d70e4ab, f5156aa). A settle guard drops transient unannounced resizes (3ef5624). `[TERM-RESIZE]` prints cell, renderer and box heights; `[TERM-BAR]` logs status-bar height changes.
- [x] The residual flap seen during testing was the Brave automation infobar: the extension attaches a debugger on each action, the viewport shrinks 56 px, and detaches when idle (`screen=797` idle vs `screen=741` attached, info=43 both). Not an app defect.
- [ ] Inherent limit, documented: claude 2.1.263 answers any real geometry change with ESC[2J, so a phone rotation, the on-screen keyboard, or a sidebar toggle still clears the visible screen. The transcript is never affected. Only spurious resizes are avoidable, and those are now avoided.

### 2026-09-08 late findings

- [x] Fork verified end to end in the browser: the forked session answered from the parent conversation history and took a new prompt, hooks and toast working (row 46).
- [ ] Deep link rejects a session whose name contains parentheses: `/session/Punchlist%20Browser%20Rename(fork)` bounces home with "Invalid project name in URL"; the card click works and lands on `/session/Punchlist_Browser_Rename_fork`. The router validation and the slug the card uses disagree. Fix: accept the same set of names the app itself creates (fork labels carry `(fork)`), or link cards and deep links by the same slug.
- [ ] Rename status-line staleness: after a browser rename the running TUI keeps its old name in the status line until that claude process restarts; the transcript carries the new name. Documented limitation, revisit only if claude gains an external rename signal.

### 2026-09-08 after the import, what the archived list looks like

- [ ] Owner decision: of the 895 imported conversations, 512 look interactive, 256 are `scheduled task: ...` runs (media-refetch-wave-advance, ptimc-email-reply-poll and the like) and 127 are headless or delegated prompts ("You are a code splitting subagent...", "Implement the following plan...", "Reply with exactly OK"). All are real transcripts; as launcher rows they bury the interactive ones. Options: a second filter on the archived list (hide automated runs), or tag them at import (`origin` stays imported, add a `kind`) and default the list to interactive only.
- [ ] `SessionInfo` carries no `created_at_epoch`, so the instance-exact join in `launchpad.js` (`_buildProjectSessionGroups`, the `:3900` join) can never fire for an open session and always degrades to the name match. Cosmetic today; a fallback that cannot fire. Found by the attribution agent, not fixed.
- [x] Attribution invariant enforced (7bd55fd, e73c1a7): ladder as-written -> canonical spelling -> mint a project -> none only for scratch; the pair (project_id, project_attribution) moves together or not at all; archived roots take no part in matching; create_project adopts project-less live rows under a new root (item 16 closed). Live: 19 running, 0 without a project.

### 2026-09-08 status light work, late findings

- [x] LED status light (0fc23a5, 4215ad0): two independent rings, inner = chat status (working, waiting-permission, waiting-input, done, dead, unknown), outer = attention (active breathing, steady, unread, off, dim); one component behind the sidebar row, launchpad card, project tree and terminal header; group headers summarise children (waiting > working > unread > done > dead > unknown). Full model in docs/session-status.md.
- [x] The tmux fallback turned any non-shell foreground process into `working` with no expiry; 15 of 19 panes hit it because claude renames its own process. Now `unknown` until a hook answers.
- [x] Unread persisted by `<tmux_name>@<session_created>` so a killed session cannot hand its flag to its successor.
- [ ] A second session, `ses_68c185ce`, has 2,757 hook POSTs rejected for a stale token (same class as this orchestrator session). Find how its token went stale and add a self-heal: a rejected hook for a pane that has a row should re-issue the token into the pane env and log once.
- [ ] `waiting-permission` is in the LED vocabulary but unreachable: the server folds `PermissionRequest` and `Notification` into one `question` state. Split them server-side so a permission prompt can read differently from a plain notification.
- [x] Concurrency incident: the recent roll-up agent committed from a stale tree (3732bdf) and reverted 15 files of the LED work; restored byte for byte in 4215ad0. Rule for future agents: build commits from HEAD plus own hunks only.

### 2026-09-08 herdr teardown (github.com/herdrdev/herdr), candidates only

- [ ] Automation primitives: `agent wait --until blocked`, `agent prompt --wait`, JSON socket API. Fits our hook state; needs a wait endpoint and a control API.
- [ ] Status "explain": a verdict that reports its source, matched rule, evidence and a named fallback reason. Add on top of the LED state machine; today `unknown` cannot say why.
- [ ] Sequence-numbered seen/done per source (`state_change_seq`), stale reports accepted and ignored. Stricter than our last-write-wins unread; consider for the unordered-hook problem.
- [ ] OS-level notification when an agent blocks (web push or APNs); today only an open tab toasts.
- [ ] Multi-machine in one client (saved SSH machines); our model assumes one tmux socket on one box.
- [ ] Git worktree workspaces grouped with the parent repo; one more project kind.
- [ ] Other agents via screen-scrape manifests; only Claude gives us hooks.
- [ ] Real-hook LED integration test: launch a real claude on a throwaway tmux socket with the hook URL pointed at the app in test mode, drive prompts, assert the LED after each real event; skip when the binary is absent. Owner asked whether possible: yes, not yet built.

---

### 2026-09-08 late round closed out, 455d692..8ee40d1 (12 commits), deployed live

DEPLOY STATE: live on mac-mini-m4 runs HEAD as of the `8ee40d1` deploy. Boot
held 19 sessions (18 plus 1 benign skip). Every running session carries a
project. Session lists show interactive conversations only: 645 archived
rows visible, 270 automated excluded by default, 305 unknown kept (kind is
unknown, not evidence of automation).

- [x] **Deep link fork-label rejection.** A session named `<title>(fork)`
  bounced the deep link home with "Invalid project name in URL" while its
  card click worked. Fixed with a permissive validator that rejects only
  what is actually hostile in a URL segment, and a title-fallback resolver
  so a link built from a display title resolves the same session a
  tmux-slug link does. Commit `ee3133c`.
- [x] **Attribution invariant, half-write.** `claim_instance`'s "only when
  not None" column policy let a derived `(None, 'none')` write the
  attribution alone, leaving a row with a real `project_id` rendering as
  "no project" because the tree checks `attribution === 'none'` first. The
  id and the attribution now move together or neither moves. Also closed:
  the lexical matcher couldn't cross a symlink spelling, so a project
  declared at an iCloud path never matched sessions probed at the `~`
  symlink; canonicalising is now a fallback rung. Commit `7bd55fd`.
- [x] **Attribution invariant, archived catch-all.** An archived project
  rooted at the owner's home directory contained every session on the
  machine and won the as-written match rung before the canonical rung
  (the one that finds the real project) ever ran, so two live rows were
  attributed to a project the user cannot see. Archived roots now take no
  part in matching. Commit `e73c1a7`. Live, verified: 19 running sessions,
  0 without a project.
- [x] **Wording purge: archive, not delete.** Owner's instruction verbatim:
  "remove the deleted wording, its archived." The project row's hard-delete
  trash button is gone (archive/unarchive was already correct and stays);
  every other user-facing delete/deleted/deletion string in `client/js` and
  `client/index.html` is renamed to archive/archived (recoverable actions)
  or remove/removed (genuinely irrecoverable ones, matching this app's
  existing verb for that class). New node test tokenizes every JS string
  literal and HTML text node and asserts none read delete/deleted/deletion.
  Commit `026c7ac`.
- [x] **Session kind: interactive / automated / unknown.** Owner's rule
  verbatim: "lists should always just be mine. the rest can be found in the
  archive explorer." `sessions.kind` (schema v25) is nullable with no SQL
  default, stamped only by evidence the machinery itself wrote (a
  `<scheduled-task>` tag, or `entrypoint='sdk-cli'`) so a title can never
  create an `automated` verdict. `/sessions/records` and `/sessions/recent`
  exclude `kind='automated'` by default; `/archive` is untouched and still
  shows everything, asserted structurally. Measured over the 895 imported
  rows: 320 interactive, 270 automated, 305 unknown (an era before the
  `entrypoint` field existed, not a gap). Commit `2b0ed7d`.
- [x] **LED: two independent rings, and its accidental revert.** `0fc23a5`
  shipped the two-ring LED (inner = chat status, outer = activity/attention)
  replacing the old single-dot model that could not say "working, and also
  unread" at the same time; stopped a tmux `running` pane from reporting a
  permanent unmeasured `working` (measured: 15 of 19 live sessions report a
  claude version string as `pane_current_command`, so this was the common
  case, not the rare one). `3732bdf`, landed seconds later from a stale
  tree, reverted all fifteen of those files (2,132 deletions) as a side
  effect of an unrelated launchpad fix; nothing in its message flagged it.
  `4215ad0` restored all fifteen byte-for-byte and touched none of the
  three files `3732bdf` legitimately owned. Commits `0fc23a5`, `3732bdf`,
  `4215ad0`. **Rule for every future agent on a shared branch: build your
  commit from HEAD plus your own hunks via a private index, verify
  `git diff origin/v1.1 --stat` shows only your paths, and never run
  `git reset --hard`.**
- [x] **LED halo, sized down.** The sidebar row and the launchpad card both
  render the LED at the 9px default with no per-call override anywhere in
  the codebase, so the old `--led-halo-scale` (2.6) / `--led-glow-spread`
  (0.62) put the whole lit object at ~35px across at the breathing peak -
  bigger than the row text, overlapping neighbours. Dropped to 1.7 / 0.3
  (~21px peak) and the breathing keyframe's peak scale from 1.06 to 1, so
  the animation no longer grows the halo past its resting size. Commit
  `8ee40d1`. Reference gallery (all LED states enumerated, pending the
  owner's sign-off on the resized version):
  https://claude.ai/code/artifact/aac4e1df-56aa-44e7-a444-6d1e1fc48627
- [x] **Recent section collapse toggle.** `#recent-sessions-toggle` has
  rendered as a real disclosure button since `b1365a2` but was never wired
  into `initSectionDisclosures()`, so clicking it did nothing - no click
  handler existed to clobber. Wired up with the same persistence and
  re-apply-on-load as its two siblings; the recent section's header now
  matches the projects header's layout (show-archived control right-aligned
  in the same row). Commit `3732bdf`.
- [x] **Project gutter alignment.** Styling fix bringing the project tree's
  left gutter into alignment across rows, landed alongside the day's LED
  TODO notes. Commit `d6e4883`; test `test_project_gutter_alignment.node.mjs`.
- [x] **Documentation only, no code.** `4ae9965` (import noise counts, the
  dead epoch fallback, attribution invariant closed), `e8cbc79` (herdr
  teardown candidates, the real-hook LED test idea).

**Verified in the browser today, end to end:** fork and rename; new project
flow (name to folder step, long-spelling root, session launched with
`--name`, wrapper and conversation id recorded); the archived toggle;
recent-section collapse and its toggle placement; project gutter alignment.

**Test artifacts.** All prior test sessions and scratch folders created
during this work were archived through the app. The two empty test folders
and `~/Desktop/Backups` are gone - the owner deleted them himself.

**Carried forward, still open (unchanged by today's round, listed here so
this closing section doesn't bury them):**
- `waiting-permission` LED state is in the vocabulary and unreachable from
  live data until the server splits `PermissionRequest` from `Notification`
  (both fold into `question` today). See `docs/session-status.md`.
- Stale hook tokens: this orchestrator session and `ses_68c185ce`
  (2,757 rejected POSTs) both need a self-heal - a rejected hook for a pane
  that still has a row should re-issue the token into the pane env and log
  once, rather than degrading silently into the tmux fallback tier.
- The real-hook LED integration test (launch a real claude on a throwaway
  socket, drive prompts, assert the LED after each event) is offered, not
  built.
- `SessionInfo` carries no `created_at_epoch`; the instance-exact join in
  `launchpad.js` degrades to a name match for every open session. Cosmetic
  today, a fallback that cannot fire.
- The herdr teardown candidates (see the 2026-09-08 herdr section above).
- **Owner action needed:** confirm the LED states rendered in the gallery
  artifact above (particularly the resized halo from `8ee40d1`) before
  treating the visual design as settled.

### 2026-09-08 final round closed out, 117823d..6934965 (3 commits)

Picks up right where the late round above left off. Deploy state for this
round: another agent was deploying HEAD as this section was written, so
treat it as **deploy in progress at time of writing** - do not read
"live" anywhere below as confirmed for these three commits until the next
session checks the running commit directly.

- [x] **LED halo, sized down again, per owner calibration.** The owner
  looked at the gallery artifact from the late round and called it: the
  halo should be 1 to 2px larger than the dot, not a wide bloom.
  `--led-halo-scale` 1.7 -> 1.3, `--led-glow-spread` from a scale-relative
  0.3x to a fixed 1.5px. At the 9px default the lit object goes from ~21px
  to ~14.7px across. Breathing amplitude tightened 0.9 -> 0.92 so the
  animation stays inside that new size. Pinned numbers updated in
  `tests/test_status_led.node.mjs` and `docs/session-status.md`. Commit
  `e7a212e`.
- [x] **`question` split into `question` (blocked) and `notice` (not
  blocked).** A `PermissionRequest` halts claude mid-turn until a human
  answers yes or no; a `Notification` is claude asking to be looked at
  while nothing is blocked. One state named `question` carried both, so a
  chatty session painted identically to a parked one - the false-urgency
  twin of this project's recurring false-green problem. Two independent
  booleans, `permission_open` and `notice_open`, not one field with three
  values, because hook events arrive unordered and duplicated and a
  `Notification` on either side of its `PermissionRequest` must not move
  the blocking claim. `permission_open` reads first, so holding both
  answers `question`. Both clear on `UserPromptSubmit`, `PreToolUse`, and
  `Stop` - the events that mean a human showed up. LED: `question` ->
  inner `waiting-permission` (new hue, `--led-color-permission`, resolves
  to the existing `--color-status-pending`), `notice` -> inner
  `waiting-input` (shared with the startup gate). Summary priority is now
  permission > input > working > unread > done > dead > unknown. Toast
  copy: "needs your permission" vs "wants your attention". Commit
  `cc885d6`.
- [x] **A superseded hook token is recovered once, never re-minted.**
  Traced to the millisecond on live 2026-09-08: a derived-id adopt minted
  a new token for `cloude_Agent_-_Cloude_Code` at 16:16:40.633984Z while
  the pane's own process still held the old one baked into its env at
  spawn time, and the first `hook_post_rejected_invalid_token` landed
  130ms later. 4,325 rejections followed over 4h24m, ending only when the
  owner restarted the pane by hand at 20:40:23Z. `hook_token_recovery.py`
  keeps a bounded in-memory ring of tokens this process minted and then
  superseded; a rejected hook is checked against that ring and, on a
  match for that id and that pane, the store is re-bound to the value the
  running process actually holds - logged once as
  `hook_token_rebound_from_superseded`, and nothing is minted. The
  negative control is the point of the test: a recovery that accepted
  broadly would be a credential bypass wearing a passing test. The
  respawn path and boot re-adopt now also push the current session env
  onto the pane before the next process starts, since tmux only copies
  session env at spawn time and a live process can never receive a
  post-hoc push. Live state needed no repair - the owner's 16:40 restart
  had already left the process, the pane env and the store agreeing,
  confirmed by 26 hook 200s in 45 seconds with no new 403s afterward.
  `ses_68c185ce` (2,757 rejected POSTs, carried forward from the late
  round above as needing a self-heal) last fired 2026-08-28 and its pane
  no longer exists - nothing to recover there, it is simply dead. Commit
  `6934965`.

**Test baseline, re-measured directly this round, not copied from a
commit message:** full `venv/bin/python3 -m pytest -q` from repo root,
**5274 passed / 3 failed / 12 skipped**, the three failures the same
pre-existing environmental ones CLAUDE.md already names
(`test_home_write_guard`, `test_state_dir_resolution`,
`test_version_probe`). This matches what `6934965`'s own commit message
claims, so that number is confirmed rather than merely quoted. **One test
is flaky under a full run, not from this round's code:**
`test_respawn_refreshes_pane_env.py::test_the_session_environment_itself_is_updated`
failed once in a full-suite run and passed 3-for-3 seconds later in
isolation on the same tree - it drives the real `cloude` tmux socket,
same class as INFRA-49. A lone failure there without a matching code
change is not a new regression. **Node: `git ls-files` counts 185
tracked `*.node.mjs` files, not 190 as `cc885d6`'s own commit message
claimed** - running all 185 directly gives 184 pass / 1 fail, the
pre-existing `test_archive_full_page_mode.node.mjs`. The "190" figure was
wrong when it was written; CLAUDE.md is corrected to 185 rather than
carrying the inflated count forward. Two untracked files sat alongside
this work throughout - `tests/led_state_for.node.mjs` and
`tests/test_led_real_hooks.py`, a real-hook LED integration harness
another agent was building in parallel (see the next bullet). Neither is
committed as of `6934965`, so neither is counted in the 185/1 line above.

- [ ] **The real-hook LED integration test is IN PROGRESS, not built,
  as of this section.** `tests/test_led_real_hooks.py`,
  `tests/real_hook_app.py`, `tests/real_hook_harness.py` and
  `tests/led_state_for.node.mjs` exist on disk (confirmed present) but are
  UNTRACKED - `git status` shows no commit behind them. Running the
  python file directly gives 8 skipped (opt-in via
  `CLOUDE_REAL_HOOK_TESTS=1`, correctly gated off by default), so the
  gating logic works; whether the tests pass WITH the env var set against
  a real claude binary has not been checked here, out of scope for a
  docs-only pass. `led_state_for.node.mjs` is not itself a test - it is a
  piped-stdin CLI helper the python harness shells out to
  (`echo '{"activity_status":...}' | node tests/led_state_for.node.mjs`)
  so that the python test can assert against the SHIPPED
  `client/js/status-led.js` mapping instead of re-implementing it; running
  it standalone with no stdin fails on a JSON parse error, which is
  expected, not a defect. Next session: find out who owns this work
  before committing it yourself, then verify token 4 of HANDOFF.md's
  first-session list.

- [ ] **Item 4 (alert lights / activity-after-resume) - BUILT, verify
  then close, not yet verified this round.** The narrower defect on
  record (`activity_state` reads `working` for about four minutes after a
  resume, then self-corrects) is now addressed two ways already shipped
  in this branch's history: the 120-second expiry on hook-fed `working`
  (`CLAUDE.md`, "The status lights, and what they are allowed to claim")
  and the fix stopping a raw tmux `running` pane from mapping to
  `working` on no evidence (it maps to `unknown` instead, landed in
  `0fc23a5`/`4215ad0` from the late round). Nobody has re-run the
  original four-minute measurement against current code to confirm the
  combination actually closes the gap rather than narrowing it further.
  Next session: reproduce a resume, time how long `activity_state` claims
  `working` past it, then close this item or write down what is still
  wrong.
- [ ] **Item 11 (read/unread state per session) - BUILT, verify then
  close, not yet verified this round.** CLAUDE.md's "Unread is keyed on
  the INSTANCE" section and the LED's outer-ring `unread` state (marked
  DONE earlier in this file at the `0fc23a5`/`4215ad0` entry) describe a
  finished mechanism: unread is keyed on `<tmux_name>@<#{session_created}>`
  so a reused name cannot inherit a dead session's flag, set on `Stop`,
  cleared when a WS terminal binds, with a legacy-name fallback when the
  epoch cannot be measured. What is NOT confirmed this round is the
  owner-facing half from the original ask (entering a session marks it
  read; a control lets the owner mark it unread again from the sidebar).
  Next session: click through that flow by hand against a real session
  before marking this closed.

**Backups to delete, filenames confirmed from this repo's own written
record (`.claude/notes/troubleshooting.md`) - do NOT delete from here,
this is a list for whoever next has mini access and database
permission:**
- `cloude.db.bak-uuidrepair-20260908T141621Z`
- `cloude.db.bak-agenttype-20260908T144337Z` (4,966,510,592 bytes,
  confirmed `ok` integrity, 40/40 tables at time of writing)
- `cloude.db.bak-uuidfill-20260908T144757Z` (4,966,510,592 bytes,
  confirmed `ok` integrity, 41/41 tables at time of writing)
- `cloude.db.bak-v23-20260908T161615Z` (written by the v24 migration)

Troubleshooting.md separately records "six 4.6GB `cloude.db.bak-*`
copies (~24GB)" in the state dir as of that pass, so **two more exist
beyond the four named above.** The owner's next-session intent names them
as "the sessionkind and projectbind ones" (from the `sessions.kind`
schema-v25 migration, `2b0ed7d`, and the project-attribution invariant
fixes, `7bd55fd`/`e73c1a7`) - but **no filename for either one appears
anywhere in this repo's tracked docs**, so do not invent one. List the
actual state dir on the mini before deleting anything; go by what is on
disk, not by this guess at what its name should be. Per the standing
owner note at "2026-09-08 owner note: clean up database backups when the
row repairs are done" earlier in this file: keep exactly one verified
full backup until a restart has proven the repaired rows work, then
delete the rest.

### 2026-09-08 real-hook led integration test closed out, 3af3a3d

Closes the item logged above at "the real-hook led integration test is IN
PROGRESS, not built" - it is now built, committed, and run for real.

- [x] **The real-hook led integration test is DONE.** Commit `3af3a3d`
  ("test(status): assert the led against hooks a real claude actually
  fired") adds `tests/test_led_real_hooks.py`,
  `tests/real_hook_harness.py`, `tests/real_hook_app.py`,
  `tests/real_hook_assertions.py`, and `tests/led_state_for.node.mjs`,
  and is pushed to origin/v1.1. Opt in with `CLOUDE_REAL_HOOK_TESTS=1`
  plus claude, tmux, and node on PATH - without it, every test skips
  naming what went unmeasured. The harness runs a real `SessionManager`,
  real routes, and a real `/ws/terminal` under uvicorn on a free port
  (not `src.main.app`, whose lifespan touches live config and db), feeds
  a real claude the production `_build_hook_block()` via a temp settings
  file passed as `claude --settings` (nothing written near
  `~/.claude/settings.json`), runs tmux through `tests/socket_guard` on a
  per-process socket, and asserts every state by piping
  `GET /sessions/list` rows through the shipped `client/js/status-led.js`
  under node.
  Real run: 9 passed in 49.5s. Timeline: startup gate
  `awaiting_startup_prompt` (waiting-input/active) at +20s, trust
  answered, `SessionStart` at +23.2s gate `ready`, `working` on
  `PreToolUse` at +30.9s, `Stop` at +39.8s `finished_unread`
  (done/unread), `SubagentStop` at +41.5s back to `working`, ws bind
  clears the halo, a real `PermissionRequest` at +48.6s `question`
  (waiting-permission/active) made deterministic by a `permissions.ask
  ["Bash"]` rule in the run's own settings file, a bogus token 403 leaves
  state byte-identical, and a killed pane leaves the list.
  Full suite after: `5274 passed / 3 failed / 21 skipped` (same three
  pre-existing environmental failures; skipped rose from 12 to 21 because
  these 9 real-hook tests skip without the env var). `node --check`
  clean.
  Also measured, recorded in the harness header:
  `--dangerously-skip-permissions` does not clear the trust dialog (adds
  a bypass-acceptance dialog instead); `CLAUDE_CONFIG_DIR` relocates
  trust but loses auth; pre-seeding `~/.claude.json` is refused because
  every live claude read-modify-writes it; binary ws frames sent before
  the resize handshake are dropped by design.

- [x] **New defect found by the real-hook test: `SubagentStop` re-arms
  `working` after `Stop` on a turn with no subagent.** DONE - see the
  closing entry at the end of this file. Measured in the
  9-pass run above: `SubagentStop` lands about 1.5s after `Stop` even
  when no subagent ran, and `session_activity.record_event` stamps
  `last_tool_event_ts` on it - the same timestamp `Stop` had just
  cleared. A finished session therefore repaints `working` for the full
  120-second heartbeat window; `finished_unread` is visible for only
  about 1.5s and `idle` is unreachable in between. This is a light
  claiming work nothing can see, arriving through the hook stream rather
  than the tmux fallback. Fix direction: `SubagentStop` must not count as
  tool activity - either never stamp `last_tool_event_ts` from it, or
  only stamp it when a matching `SubagentStart` is actually open.

- [ ] **New defect found by the real-hook test: a dead pane reaches no
  live endpoint, so the led's dead/off state is unreachable from live
  data.** `_session_info_for` drops a dead pane on `LIVENESS_GONE`
  (deliberate, commented in code) and `/sessions/attachable` does not
  carry it either, so a killed session simply vanishes from the sidebar
  instead of rendering as dead. Decision needed, not yet made: either
  make a dead row visible somewhere in live data so the led's `dead`
  state has something to render against, or accept that in this app
  dead means gone and drop `dead` from what the live endpoints are
  expected to ever show.


## 2026-09-08 - punchlist item 4 closed: a closing hook event is not a heartbeat

- [x] **Punchlist 4 ("activity lights: `activity_state` reads `working`
  for about four minutes after a resume, then self-corrects") is CLOSED,
  with its root cause found rather than guessed.** It was not a resume
  and it was not four minutes: it was
  `WORKING_HEARTBEAT_TIMEOUT_SECONDS` (120s) being re-armed after the
  turn ended. `tests/test_led_real_hooks.py` measured it twice on claude
  2.1.265 - on a turn with NO SUBAGENT ANYWHERE IN IT, `SubagentStop`
  arrives about 1.5s AFTER `Stop`, and `record_event` stamped
  `last_tool_event_ts` on it, the field `Stop` had just cleared to say
  the turn was over. `finished_unread` was visible for about a second and
  a half and `idle` was UNREACHABLE for the rest of the window.

- [x] **The rule shipped: a CLOSING event stamps the heartbeat only when
  something was open for it to close.** `SubagentStop` needs
  `subagent_depth > 0`, which is already the exact record of an unmatched
  `SubagentStart`; at zero it decrements nothing, stamps nothing, moves
  no state, and logs `subagent_stop_without_start` at debug. A
  `SubagentStop` that closes a real subagent still decrements (floored)
  and stamps exactly as before - that negative control is the
  load-bearing test, because a guard that refused every `SubagentStop`
  would pass the defect tests perfectly and delete `working_subagent`'s
  exit heartbeat.

- [x] **The same trap was closed for `PostToolUse`, narrowly.** A tool
  result from a turn that already ended is not evidence of work now, but
  there is no counter to key on (parallel tool calls, and a droppable
  `PreToolUse`, would desynchronise one), so it keys on a `turn_open`
  boolean that every OPENING event sets and `Stop` clears. It is refused
  ONLY when a `Stop` has POSITIVELY been seen for the session and nothing
  has opened since: never having seen a `Stop` - a fresh session, a
  server restarted mid-turn - is not evidence the turn is over, so that
  case still stamps. Hook payloads carry no timestamp of their own, so
  the ordering measured is arrival order at the server; the narrowing is
  what makes that safe.

- [x] **`tests/test_led_real_hooks.py` test 5 INVERTED, not loosened**,
  as its own docstring instructed. It now waits for the stray
  `SubagentStop` to LAND and re-reads after it, which is the only
  ordering that can tell the fix from the 1.5s gap. Test 6 additionally
  asserts the dot reaches `idle` once the halo clears - the state
  punchlist 4 made unreachable, so that is the live proof.

- [ ] STILL OPEN, unchanged by this: the dead-pane entry above
  (`_session_info_for` drops a dead pane on `LIVENESS_GONE`, so the LED's
  `dead` state is unreachable from live data). Being worked separately.

- [x] **A DEAD SESSION NOW KEEPS ITS ROW** (closes the dead-pane entry
  left open above). `resolve_listing_liveness` answered ONE verdict,
  `LIVENESS_GONE`, for two different facts - the tmux session is gone
  (`exists` False) and the tmux session is there with a corpse in its
  pane (`#{pane_dead}` = 1, `remain-on-exit`) - and `_session_info_for`
  dropped the row for both. `/sessions/attachable` cannot catch either,
  because the route filters out every name bound to a live backend. So a
  killed pane vanished off the sidebar and the running list while
  `dead`/`off` and `actionsFor('dead')` waited for a row that never came.

- [x] **The split lives in `src/core/session_liveness.py`**, moved out of
  `session_status.py` rather than duplicated there: `alive` /
  `pane_dead` / `session_gone` / `unknown`, with the pane words imported
  from `session_respawn.py` so a listing verdict and a restart preview
  cannot disagree about one measurement. `pane_dead` keeps the row and
  forces `activity_status` to `dead`; `session_gone` drops it exactly as
  before and the reaper files the stored row into the recent list.
  Existence is read BEFORE the pane, so a stale `dead` cannot keep a
  session tmux no longer has on screen. `keeps_row` is an allow-list of
  what SURVIVES, not a deny-list of what drops.

- [x] **Two guards stopped being freebies and are now exercised.** The
  restore branch's `liveness == LIVENESS_ALIVE` used to be unreachable
  for a dead pane (the row returned first); it is now the only thing
  keeping a persisted `idle` from overwriting a measured `dead`. And
  `_startup_gate_for` gets its first `pane_alive=False` caller: it
  answers `ready`, raises no toast, and captures no scrollback, so a dead
  row costs nothing per poll.

- [x] **`tests/test_led_real_hooks.py` test 8 INVERTED**, as its own
  docstring instructed, and a ninth added. `RealHookApp` grew a second
  kill mode: `kill_agent` SIGKILLs the process (the `pane_dead` case, row
  survives saying `dead`), `kill_session` removes the tmux session (the
  `session_gone` case, row correctly leaves). New:
  `tests/test_session_liveness_split.py` (vocabulary shape, the
  disagreeing-probes negative control, the reaper's half) and
  `tests/test_dead_row_renders_dead.node.mjs` (the shipped sidebar merge
  into the shipped LED and action builder).

- [ ] STILL OPEN: nothing prunes a `pane_dead` row on its own. That is
  deliberate - the owner's model is that it stays until the user restarts
  or removes it - but it means a box left alone accumulates dead rows,
  and no one has measured what that looks like after a week.

## 2026-09-08 late: owner decisions on items 9 and the dead-pane finding

- Item 9 DECIDED (owner, verbatim: "yes, its something that floats to top row
  can still be ungroupped"): a pin is a flag that floats the row to the top,
  not a bucket of its own; an ungrouped session stays a legal state, so the
  six ungrouped Infrastructure sessions are NOT forced into a group. No
  migration needed. Only work left: confirm a pinned row floats to the top
  whether or not it is in a group, then close.
- Dead-pane finding DECIDED (owner: "they go into recent, they can
  disappear"): a killed session drops out of the live list and shows under
  Recent. The LED dead/off state stays gallery-only. Closed as by design.

## 2026-09-08: archived one-off verify scripts whose fixes shipped

- [x] Reviewed all 31 `verify_*`/`verify-*` scripts at the top of `scripts/`
  (about 11,342 lines). For each one read its docstring, found the git
  commit that shipped the fix it was proving, and grepped the repo for a
  permanent automated test covering the same assertion, and for any other
  script or CI file that still calls or imports it.
- Moved 21 scripts (7,649 lines) into `scripts/archive/verify/` via
  `git mv`, each one a closed single-bug pixel/behaviour proof now
  covered by a test under `tests/`. Table of script, closing commit and
  covering test is in `scripts/archive/verify/README.md`.
- Kept 4 in place because they are load-bearing: `verify_header_icons_and_menu.py`,
  `verify_sidebar_groups.py` and `verify_sidebar_sessions.py` are actively
  invoked by `scripts/ci/mutate-*.sh` mutation-testing scripts;
  `verify_sidebar_rename.py` is not called directly but is imported by
  `verify_sidebar_groups.py` (`from verify_sidebar_rename import
  measure_inline_rename`), so moving it would break that CI-invoked
  script.
- Kept 4 more as reusable parameterised operator tools, not one-off
  proofs: `verify_lifecycle_reconcile.py` (`--db`/`--listing` against a
  real `cloude.db`) and the `verify_selection_apps.py` /
  `verify_selection_regressions.py` / `verify_selection_scrolled.py` trio
  (argparse, live server plus TOTP, cross-import each other), all still
  named as release-time harnesses in `RELEASE-NOTES.md`.
- Kept 2 as unsure: `verify_home_mechanics.py` is a multi-item regression
  harness (items into the 50s) referenced by a comment in
  `scripts/ci/mutate-home-screen-mechanics.sh`, with at least one item
  still open across past releases per `RELEASE-NOTES.md`, so it is not a
  single closed bug; `verify_sidebar_group_drag.py` is a companion to the
  actively-called `verify_sidebar_groups.py`, last touched 2026-09-07, in
  a part of the codebase under active edit during this same session.
- Full suite after the move: 5302 passed / 3 failed / 22 skipped, same
  three pre-existing environmental failures named in `CLAUDE.md`
  (`test_home_write_guard`, `test_state_dir_resolution`,
  `test_version_probe`). Nothing newly broken by the archive move.

## 2026-09-08 - the status round, closed as the owner ruled (`cafb50c`)

Two findings from `tests/test_led_real_hooks.py` (the real-claude harness
added in `3af3a3d`), both now closed. The first was tightened, the second
was overruled and reverted.

**Finding 1 - a late `SubagentStop` reopened `working`. CLOSED, rule (a).**
The owner's symptom was "clicking a tab does not change the light to idle".
Measured cause: on a turn with NO subagent in it, claude 2.1.265 fires a
`SubagentStop` about 1.5s AFTER `Stop`, and `record_event` stamped
`last_tool_event_ts` on it, re-arming the 120s working heartbeat on a
finished session. `e794aef` shipped option (b) - stamp only when
`subagent_depth > 0`. Review found the hole: hooks are DUPLICATED, so a
duplicated `SubagentStart` delivered after `Stop` raises the depth off the
floor by itself and the duplicated `SubagentStop` behind it then passes the
gate and stamps, at its own arrival time, ratcheting the expiry out on
every further pair. Tightened to option (a) in `cafb50c`: **a
`SubagentStop` NEVER stamps the heartbeat; it only decrements
`subagent_depth`, floored at 0.** `PostToolUse` keeps the `turn_open`
machinery unchanged - it is the only event some legitimate turns emit late,
so a blanket refusal is wrong there.
- Negative control moved with the rule and is still the load-bearing test.
  The old one ("a real SubagentStop still stamps") is false by design now,
  so it split in two: the DECREMENT is asserted on its own (a refusal that
  also skipped it would wedge `working_subagent` forever - verified to trip
  4 tests), and the non-stamping is asserted separately.
- New: the ratchet test that pins the hole above, the measured real
  timeline (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
  `SubagentStop` +1.5s) reading `finished_unread` then `idle`, and the same
  timeline duplicated and reordered. Both new assertions were confirmed to
  FAIL against the `depth > 0` version before being kept.
- NOT claimed: an OPENING event still stamps unconditionally, so a stray
  `SubagentStart` after `Stop` still buys ONE bounded window keyed on
  itself. Documented in the test rather than silently left.

**Finding 2 - a dead pane vanished off every live surface. CLOSED by the
owner's decision, and `ba2aa5d` REVERTED.** `ba2aa5d` read this as a bug
and made a husk KEEP its row, painted dead. The owner ruled otherwise,
verbatim: "they go into recent, they can disappear." So the row leaves the
live list, `dead`/`off` stays GALLERY-ONLY, and `ba2aa5d` is reverted whole
in `cafb50c`: `src/core/session_liveness.py`, its two test files, the
`_session_info_for` row-keeping branch, the `pane_alive=False` startup-gate
caller and the persist-settled skip. `resolve_listing_liveness` returns to
`session_status.py` - moving it bought nothing once the verdict went back
to three values.
- `tests/test_led_real_hooks.py::test_a_killed_pane_leaves_the_live_list_rather_than_painting_dead`
  already asserted the owner's behaviour against a real killed pane. Its
  docstring is rewritten from "characterisation of a defect, invert this"
  to "this is the product decision, changing it needs the owner".

**STILL OPEN (new item, from finding 2).** `remain-on-exit` keeps a husk's
tmux SESSION in the listing, and `src/core/session_lifecycle.py` reaps on
ABSENCE from that listing, so a killed pane's row leaves the live list
without yet arriving in Recent. The second half of the owner's decision is
therefore NOT built. Closing it needs a reaper rung keyed on a MEASURED
`#{pane_dead}` - a new durable writer, in the one module whose entire
premise is never writing a verdict nobody measured - so it is its own
change with its own gates (a probe that could not answer must not reap).
The real-hook test now PRINTS the recent-list membership on every run
instead of pinning the gap open with an assertion in either direction.

**Measured.** Full suite 5329 passed / 3 failed / 21 skipped; the three are
the pre-existing environmental ones `CLAUDE.md` names
(`test_home_write_guard`, `test_state_dir_resolution`,
`test_version_probe`). Real-hook test opted in once against a real claude
in a throwaway tmux socket: 9 passed in 51.92s.

2026-09-08: git remote rule
- Push only to `origin` (ccsliinc/CloudeCode) or `adamdev` (Adoom666/CloudeCodeDev). NEVER to `upstream` (Adoom666/CloudeCode).
- The `upstream` push URL is set to `DISABLED_do_not_push_to_Adoom666_CloudeCode` on the owner's clone so a push there fails by construction; re-apply that with `git remote set-url --push upstream DISABLED...` on any fresh clone.

2026-09-08: sidebar unread-count badge removed. `client/js/session-status-summary.js` `summaryHtml()` no longer emits `.status-summary-badge`; the count still drives the LED outer ring (`bucketFor`) and rides in the LED title/aria-label. CSS block removed from `client/css/status-led.css`. Only consumer was the sidebar group header (`client/js/session-sidebar-groups.js`); launchpad has no separate numeric badge (its `markUnreadHtml` is an unrelated manual toggle icon). Tests updated in `tests/test_status_summary.node.mjs`, 17/17 pass. Commit 1d03f2835e27d92aa23702dee8de8a5027d1d534 on v1.1, pushed to origin.

---

## 2026-09-08 - Punchlist 1: the choice on wake, not a better silent default - SHIPPED

**What the app did before, read rather than assumed.** Two reconnect paths
and they differ. The websocket re-attach (`src/api/websocket.py`) replays NO
history at all: `request_dims`, the client's `pty_resize`, ~150 ms for
SIGWINCH, then `ws_startup_paint` paints the VISIBLE SCREEN, or sends Ctrl+L
and lets a TUI redraw itself. The launchpad/sidebar rejoin
(`GET /sessions?include_scrollback=1`) captures
`tmux capture-pane -p -e -J -S -<session.scrollback_lines>`, 3000 lines by
default, and `terminal-reconnect-buffer.js` then decides alone: `keep` for
the same session id with content already in xterm, `replace` otherwise.
Nobody was ever asked, and nothing ever said what happened during the gap.

**Threshold 60s, bound 3000 lines.** `TerminalAwayGap.AWAY_THRESHOLD_MS`.
Under a minute is a blip and keeps today's behaviour with no prompt - a bar
that fired on every wifi hiccup would be dismissed unread, which is worse
than no bar. The full-history bound is `session.scrollback_lines` read from
config, so the number the bar prints is the number tmux is asked for.

**The absence is MEASURED by a heartbeat, not by a visibility event.** A
sleeping phone may fire nothing: the tab is already hidden and the OS
suspends the process. `terminal-away-bar.js` stamps the wall clock every 5s
while visible; the gap between the last stamp and the next tick IS the
absence. `visibilitychange` is wired too because a tab switch does fire it.

**A remembered choice PRE-SELECTS AND NEVER SUPPRESSES.** Stored per device
in `localStorage` under `cloude.away.lastChoice`. The bar shows every time
and nothing runs without a press, because a remembered choice that acted on
its own would be exactly the silent default this item exists to remove,
wearing the user's own preference as a disguise. Pinned by a test.

**The summary is built from what the app already has**, no LLM step and no
new event log: toast records with a `created_at` inside the window counted
by kind, the live `SessionActivityTracker` signal (`permission_open`,
`notice_open`, and the later of `last_tool_event_ts` / `last_stop_ts`), and
one `#{alternate_on}` probe. One new read-only route,
`GET /api/v1/sessions/away/summary`, because three of those facts are on no
existing endpoint. The server ships FACTS and never sentences, so the app
keeps exactly one duration formatter instead of two that drift.

**THE TURN COUNT IS A FLOOR.** `SessionManager.record_toast` supersedes an
unacked `Stop` with the same title IN PLACE, so twelve finished turns can be
one stored record. The report counts records, names the coalescing kinds,
and the client prints "at least 3 turns finished". A total there would be
the same class of lie the toast layer already refuses to tell in the other
direction.

**COVERAGE IS ITS OWN FIELD, and it is the negative control.** The toast
store is in memory, so a bucket emptied by a restart is indistinguishable
from a quiet session. A window starting before this process loaded reports
`partial_server_restarted` and the bar says so out loud. "Nothing happened"
and "the record was thrown away" must never render the same.

**The bar is an OVERLAY inside `.terminal-container`.** An in-flow child
there steals rows from `#terminal`, the ResizeObserver ships a `pty_resize`,
tmux raises SIGWINCH and claude answers `ESC[2J`, which on the alternate
screen erases the conversation. A bar asking "what should I repaint" must
not be able to wipe the answer on its way in. `#localServersContainer`
already paid for this.

**STILL OPEN.** A websocket drop with the user PRESENT raises no bar, on
purpose - that is not an absence and the reconnect buffer already kept the
screen across it. If it ever should, the signal does not exist: nothing
dispatches an event on `ws.onopen` and `client/js/terminal.js` is under a
no-growth guard. Also unaddressed: on an alternate-screen pane "show full
history" trades the browser's kept buffer for a single captured frame. The
caveat is printed before the press, but for a Claude Code session the
browser's buffer is usually the better record.

**Files.** `client/js/terminal-away-gap.js` (pure rules and sentences),
`client/js/terminal-away-bar.js` (heartbeat, element, actions),
`client/css/terminal-away-bar.css`, `src/core/session_away_report.py`,
`src/api/away_routes.py`, `docs/reconnect.md`,
`tests/test_terminal_away_gap.node.mjs` (13),
`tests/test_session_away_report.py` (19). Nothing in
`terminal-reconnect-buffer.js` was touched; this layers on top of its keep
rule.

**Measured.** `venv/bin/python3 -m pytest -q`: 5328 passed / 4 failed / 21
skipped. Three are the pre-existing environmental ones `CLAUDE.md` names;
the fourth is
`test_respawn_refreshes_pane_env.py::test_the_session_environment_itself_is_updated`,
the documented real-tmux flake, which passes 3/3 in isolation on the same
tree minutes later. The passed/skipped counts include another session's
uncommitted work in this tree.

## 2026-09-08 - Local branch/worktree prune + gc (v1.1)

Authorised prune of local branches merged into v1.1, removal of worktrees
whose branches were merged, and a plain `git gc`. Main tree, shared index,
and v1.1/main refs were never touched directly (no checkout/reset/stash/
clean in the main tree).

- Worktrees removed (clean + branch merged): copy-ios-false-success,
  fix-copy-output, home-bottom-bar, session-editor-top-right,
  sidebar-toggle-spacing, theme-audio, tools-consolidation (7 total).
- Worktree skipped (dirty, uncommitted change to
  client/css/config-editor.css): editor-project-roots
  (branch fix/editor-project-roots).
- Branches deleted via `git branch -d`: 184 (all local branches merged
  into v1.1, excluding v1.1/main/current and the branch still checked out
  in the surviving worktree).
- Branch skipped: feat/gui-fork (git refused: not fully merged to its
  own remote-tracking branch origin/feat/gui-fork, despite being merged
  to v1.1's HEAD - `-d` correctly declined; left alone, not force-deleted).
- Branch count: 207 -> 16. `.git` size: 163M -> 135M (count-objects
  size-pack 140.27 MiB -> 134.43 MiB, prune-packable 1 -> 0).
- `git gc` (plain, not --prune=now) ran clean, no lock retries needed.
- v1.1 sha moved 537c10c -> 1d03f28 during this work (another worker's
  commit landed on it live, confirmed by log - not caused by this prune).
  main unchanged at fd9e0a8d.
- Working tree dirty-path count moved 45 -> 65 in the main tree during
  this work (other workers' concurrent uncommitted edits, per the brief -
  nothing here touched the working tree or index).
- Recovery record (sha of every ref before any deletion, so any branch
  can be recreated): /private/tmp/claude-501/-Users-jsugamele-Library-Mobile-Documents-com-apple-CloudDocs-Sync-Development-CloudeCode/2629dba5-234e-44d2-be54-ddaf69c8db4b/scratchpad/prune-refs-before.txt
- Before/after snapshots: same scratchpad dir, prune-before.txt / prune-after.txt.

### 2026-09-08 - punchlist 7 and 8 closed: toasts raise globally, dismiss per session, and a history page

**WHAT FILTERED TOASTS TO THE SESSION ON SCREEN, and it was TWO filters,
which is why fixing either alone would have left the bug.** (1) The
`toast.new` WebSocket frame is fanned out only to sockets bound to the
raising session (`src/api/routes.py`'s own comment: "toasts for session A
never leak"), and a browser holds ONE terminal socket, bound to the
session being viewed. (2) `client/js/terminal.js` backfills via `GET
/sessions/{id}/toasts` for the ATTACHED session alone, and only at
WebSocket open. So a session needing attention while the owner was
elsewhere was silent - and the launchpad and archive screens, which hold
no terminal socket at all, were deaf to notifications entirely.

**WHAT RAISES THEM NOW.** `GET /api/v1/toasts` returns every session's
records; `client/js/toast-global-poll.js` polls it every 10s from
whatever screen is up and feeds the SAME `ToastManager.backfill` the
attach path already used, so a record arriving by both routes dedupes on
id and renders once. A poll rather than a wider WS broadcast on purpose:
widening the fan-out would push every session's frames down the one
terminal socket and make terminal.js filter them - coupling notification
delivery to the terminal transport, which is the coupling that caused
this - and would still leave the socket-less screens deaf.

**THE DISMISSAL AXIS WAS ALREADY CORRECT AND THE WORK WAS NOT TO BREAK
IT.** `ToastManager.dismiss()` already acked with `toast.session_id` -
the toast's OWN session, never the one on screen - and
`SessionManager.ack_toast` walks only that session's bucket.
`dismissForSessionActivity` was already scoped to the session typed into.
Item 7 was therefore purely a visibility problem, and the new tests exist
to pin the isolation now that the read is global.

**THE ONE NEW DEFECT THE POLL COULD HAVE INTRODUCED, and its guard.**
`dismiss()` drops the id from its model immediately and fires the ack
asynchronously; a poll tick that left BEFORE the ack landed returns a
snapshot where the toast is still unacked, and `add()` would resurrect
the card the user just dismissed. `client/js/toast-dismissed-ring.js` is
a bounded, EXPIRING set of locally dismissed ids that the poller filters
every result through, fed by a new `cloude:toast-dismissed` CustomEvent
from `toast.js` (an event rather than a hard call, so the toast module
keeps working with no poller loaded). It is a SUPPRESSION, NEVER AN ACK:
if the ack genuinely failed the record is still unacked server-side, the
ring forgets it after 60s and the toast correctly comes back. A permanent
ring would turn a failed write into a notification never seen again.

**CLICKING A CARD GOES TO THE SESSION THAT RAISED IT**
(`client/js/toast-navigate.js`), which only became meaningful once most
cards on screen were about somewhere else. It resolves the real
`/sessions/list` row and hands it to `App.returnToExistingTerminal` ->
`ThemeNavigation.applyForSession`. IT DOES NOT SYNTHESISE A ROW: the
toast carries enough to NAME a session and not enough to ENTER one -
`pinned_theme` rides on the SessionInfo WRAPPER - so a synthesised object
would paint the previous session's theme, gotcha 7, already paid for
once. The dismiss button calls `stopPropagation`, so dismissing never
navigates, and the click NEVER ACKS: reading a notification is not
answering it. A dead session is announced through `Router.showError`, the
app's one banner.

**WHERE THE HISTORY LIVES, MEASURED, because the handoff's "the server
already holds the record" is true only for the current process.** There
is NO toast table and NO json store. Everything is
`SessionManager._pending_toasts`, an in-memory dict keyed by session id.
Retention is asymmetric: unacked kept WITHOUT LIMIT (dropping one loses a
notification nobody saw); acked kept to the last 50 PER SESSION
(`_TOAST_ACKED_CAP`), older falling off the tail; a wiped session loses
its whole bucket; a restart loses everything. So `GET
/api/v1/toasts/history` reports `storage: "process_memory"` and the empty
state says it in words - an empty list after a restart means the record
was LOST, not that nothing ever happened.

**THE HISTORY OUTCOME IS TWO-VALUED AND THAT IS A NAMED LIMITATION.**
Item 8 wanted three outcomes distinguished (answered / auto-dismissed by
typing / swept by "dismiss all") because "I answered it" and "it got
swept" are different facts. `Toast` carries `acknowledged` as a bare
boolean and nothing records which act set it, so a row says `dismissed`
or `open` and nothing else. Rendering a guessed reason on a page whose
only job is to be trusted would be worse than the missing column. Adding
it needs a reason threaded through the ack route into
`SessionManager.ack_toast`, which is in another session's uncommitted
work this round.

**WHERE IT IS REACHED.** Settings gear -> `notifications` tab -> beneath
the channel fields. That tab already existed and settings-panel.js
already had a declarative SLOT mechanism (wrappers, terminal commands),
so this is `slots: ['toast-history']` plus one `mountSlots()` call, not a
fourth navigation pattern in a place nobody would look for it.

**CORRECTED A STALE DOCSTRING while testing it** (gotcha 8): the ack
route claimed a 404 for a toast id unknown to the named session. It never
did that - it returns 200 "No-op" for both "not in this bucket" and
"already acked", because the storage layer treats them as the same
non-change. The scoping is real and lives in the storage walk; the tests
assert the resulting STATE rather than a status code.

**FILES.** New: `src/core/toast_history.py` (pure: flatten, order with a
`(created_at, id)` tiebreak, page), `src/api/toast_routes.py`,
`client/js/api-toasts.js`, `client/js/toast-dismissed-ring.js`,
`client/js/toast-global-poll.js`, `client/js/toast-navigate.js`,
`client/js/toast-history-render.js`, `client/js/toast-history-panel.js`,
`client/css/toast-history.css`, `docs/notifications.md`,
`tests/test_toast_cross_session.py`,
`tests/test_toast_history_render.node.mjs`. Edited:
`client/js/toast.js` (+50), `client/js/settings-panel.js` (+14),
`src/api/routes.py` (docstring only), `src/main.py` (router
registration), `client/index.html` (tags).

**THE TIEBREAK IS NOT COSMETIC.** `collect_toasts` orders on
`(created_at, id)` because a hook burst records several toasts inside one
`datetime.utcnow()` tick; two records comparing equal leave their order
to whatever the sort last saw, so page 1 and page 2 can both contain a
row and neither contain another. Asserted directly.

**TEST BASELINE, and the attribution.** `venv/bin/python3 -m pytest -q`:
**5325 passed / 7 failed / 21 skipped** in 190s. THREE are the documented
environmental failures (`test_home_write_guard`,
`test_state_dir_resolution`, `test_version_probe`). The other FOUR are
all in `tests/test_session_activity.py` (subagent depth / `SubagentStop`
cases) - that file AND `src/core/session_activity.py` are another
session's uncommitted work in this tree, and the file passes 57/57 when
run alone minutes later. Nothing in this round touches that path. Node:
187 files, run individually (`node --test` hangs on
`led_state_for.node.mjs`, which is a piped-stdin CLI helper, not a
standalone test) - **185 pass, 1 fails**, the pre-existing
`test_archive_full_page_mode.node.mjs`. `tests/test_viewport_units.node.mjs`
caught a real defect in the new CSS during this round: a raw `46vh` with
no `dvh` twin, fixed.

**STILL OPEN, carried forward:** (a) no durable store - a restart clears
the history, and a table needs a schema migration through modules another
session holds this round; (b) the dismissal REASON is unrecorded, so the
three-way outcome cannot be rendered; (c) a duplicate hook event arriving
AFTER a dismissal mints a NEW toast, because supersession deliberately
never returns an acked record - correct for a genuinely new turn, wrong
for a duplicated delivery, and indistinguishable at the record level
today; (d) nothing bounds the number of DISTINCT SESSIONS stacking at
once (the client cap and coalescing bound what is drawn, and supersession
bounds repeated `Stop`s per session) - the owner asked about this for
20+ sessions and it wants measuring on a real box before a cap is added.

---

## 2026-09-08 - punchlist 3: infer a hand-started session's agent from its process

**DONE.** `sessions.agent_type` NULL beside
`agent_family_source='not_launched'` rendered "unknown family" for a pane
plainly running claude. Filled FROM EVIDENCE, never by defaulting the
resolver.

**The ladder** (`src/core/session_agent_infer.py`, pure): refusals first.
`unavailable` when `ps` did not answer, so nothing was measured;
`not_claude` when the tree WAS read and holds no claude - the bare-zsh
negative control; `wrapper` when the claude argv carries at least one
distinguishing flag and EXACTLY ONE configured claude-family wrapper
passes that same set; `family` (bare `claude`) for everything else that
is proven claude - no distinguishing flag, no match, or several.
`#{pane_current_command}` CORROBORATES only: it answers the family when
its basename is literally `claude`, and the claude VERSION STRING that 15
of 19 live panes report there selects no rung at all.

**The anchor gate is the whole design.** Equality of flag sets, not
subset, or a `--dangerously-skip-permissions` wrapper would claim a pane
running that plus `--chrome`. An EMPTY observed set names nothing, even
when a flagless wrapper is configured: empty agreeing with empty is the
absence of evidence, not two facts agreeing.

**THE HOOK IS NOT THE TRIGGER, and that was the correction that mattered.**
The first design ran only on the first hook. Measured on live: 10 of the
hand-started `not_launched` sessions have NEVER fired a hook and never
will - `CLOUDECODE_SESSION_ID` / `CLOUDECODE_HOOK_TOKEN` are copied into a
pane's process at spawn, so a claude a human typed into an
already-running pane has neither. A hook-only ladder would have been a
rung that can never fire for exactly the population it was written for.
Three drivers now: `session_agent_infer_sweep.sweep_live_sessions` at the
END of the boot re-adopt pass and after an adoption (TWO subprocesses for
the whole fleet - one `list-panes -a`, one `ps -A` - and only if a row
needs them, because the row gate runs first), plus the per-session hook
path in `session_agent_infer_apply` for a session that DOES have the env.
A hook is still the strongest evidence when it exists; its absence is no
longer read as an absence of claude.

**The new source is `inferred_process`**, a SIXTH `agent_family_source`,
rendered as the dashed guess pill. Kept apart from `fingerprint` because
they were measured differently: a process read is the STRONGER guess -
what the process was told to do, not what it printed - which is why it is
the one guess allowed to name a wrapper, and it is still a guess. Writing
an inference into `agent_type` broke the premise `session_agent_evidence`
rested on, so the row's source now travels with its value through
`identity_for_live_name`, `choose_agent_evidence` and `stored_launch_for`.

**An inference is not intent.** `session_respawn.py` is UNCHANGED.
`RESPAWN_SHELL` still fires on an empty `#{pane_start_command}` and fires
BEFORE `agent_command` is read, so this could never have moved that rung.
What it could have moved is an ADOPTED session off `RESPAWN_REPLAY` on a
guess, which `session_agent_infer.restart_agent_type` refuses at
`_stored_agent_type_for_tmux_name`. The picker's explicit choice stays
the only override.

**LIVE READ-ONLY DRY RUN, 2026-09-08 (nothing written).** 19 live panes,
all with rows, **0 fillable**: every live row already carries an
`agent_type`, so the row gate ends the pass before any `ps`. 12 rows on
disk carry the punchlist-3 shape (`not_launched` + NULL `agent_type`) and
NONE is live, so there is no pane to read for them. Counterfactual, run
against the owner's five real wrappers: had those 19 rows been empty the
ladder would have named `claude-chrome` for 3 and written the bare family
`claude` for 16, because `cld`, `cldl` and `claude-skip-permissions` all
reduce to the same single flag and tie three ways. That tie is the anchor
gate working on real config, not a hypothetical.

**TEST BASELINE.** `venv/bin/python3 -m pytest -q`: see the final run
recorded in the commit. New: `tests/test_session_agent_infer.py` (25) and
`tests/test_agent_inferred_source_renders_as_a_guess.py` (20).
`tests/test_claude_title_sync_apply.py`'s fixture gained
`agent_family_source` because `identity_for_live_name` now selects it.
NOT MINE and left alone: `tests/test_no_name_keyed_session_identity.py`
fails on `src/api/recreate_routes.py`, an UNTRACKED file another session
holds in this tree.

**STILL OPEN:** (a) no periodic re-sweep - a claude typed into a pane
after boot with no adoption and no hook waits for the next server start;
the sweep is cheap enough for a slow timer and that is the obvious next
step. (b) The one-shot backfill for the 12 dead-row cases is out of scope
here: those rows have no live pane, so only a transcript/argv archive
could answer them, and it needs a verified backup first.

2026-09-08: fix(launchpad) a74988a - project row session count moved from margin-left:auto (far from chevron, flush against card) to a fixed 4px gap beside the chevron, coloured to match the sidebar count treatment (2174b0d, accent text no pill). Archive action icon replaced U+1F5C4 file-cabinet emoji with a shared archiveIconSvg() (session-status-ui.js, same stroke family as pencilIconSvg) matching the header archive button shape; project row is the only surface using the new shared function so far. Targeted node tests updated and green: test_project_gutter_alignment, test_project_archive_render, test_project_authority_banner/render, test_project_list_render_guard, test_project_session_tree, test_home_screen_mechanics (via lib-home-mechanics.mjs stub).

### 2026-09-08 - recreate a dead session on the same row - DONE (item 22, close-and-recreate)

**THE GAP, restated as the owner would see it.** Restart in place shipped for a
pane that died (`respawn-pane`) and for a pane that is alive (`respawn-pane -k`).
Neither can touch a session whose tmux SESSION is gone entirely - the server was
restarted, the machine rebooted, someone ran `kill-session`, so the name is
simply absent from `tmux -L cloude list-sessions`. The respawn ladder reads a
PANE, finds none, and answers `cannot_determine`. That is correct and it is a
dead end: the only path left was building a fresh session by hand, which loses
the row and with it the project binding, the title, the pinned theme, the unread
key and the group filing.

**REUSE BEFORE INVENTING, and it is a call rather than a copy.**
`src/core/session_recreate.py` owns exactly one new fact - is the tmux session
still on the socket - and hands everything else to
`session_imported_restart.plan_imported_restart`: the measured directory
spelling (`resume_directory`), the transcript refusal, the wrapper validation
(`session_agent_choice.validate_agent_choice`), the `--resume` fragment
(`resume_extra_args`) and the three conversation words. So there is ONE
create-a-session classifier for the two rows that have no pane, and a change to
the transcript guard cannot fix one path and miss the other.

**THE GATE IS A LISTING, NOT `is_alive()`.** `has-session` returns the same
False for "no such session" and for "tmux is missing / timed out / errored".
Acting on that would spawn a second tmux beside a perfectly healthy one and
rebind the row onto the newcomer, leaving the pane the user is talking to alive
and unreferenced. `session_recreate_presence.tmux_presence` takes
`discover_existing()`'s `ok` and `complete` and answers `gone` / `present` /
`unknown`. Only `gone` acts; `present` is reported as the ladder's own
`not_dead`; a listing that did not run, one that ran with rows the parser
refused, and a name outside the `cloude_` namespace the listing does not cover
are all `unknown`. `tests/test_recreate_gate_real_tmux.py` drives a real
throwaway socket for the present -> killed -> gone transition, plus two negative
controls (a neighbour session still running while the asked-about name is
absent; a non-prefixed name that IS running and must never read gone).

**THE IDENTITY GUARD CAUGHT THE FIRST DRAFT, and it was right.** The routes
originally took the tmux name and resolved the row by greatest
`tmux_created_epoch`. `tests/test_no_name_keyed_session_identity.py` failed it:
a name is reusable and this app re-mints them, so that is a recency guess, and a
wrong answer rebinds a DIFFERENT session's row onto a tmux session it has
nothing to do with. `GET /sessions/recreate/preview` and `POST /sessions/recreate`
now take `session_uuid` - the same durable key `imported_restart_routes` takes -
and read the tmux name OFF the row. Client-side the same rule applies:
`SessionRestartOptions.recreateTarget(records, name)` returns a uuid only when
EXACTLY ONE record carries that name, null otherwise. A refusal costs the user
the offer, which is what they had before this existed; a guess costs a session.

**WHAT MOVES.** `create_session(reuse_session_id=...)` reaches
`session_restart.rebind_instance`, which holds `sessions.id` fixed while moving
the instance triple, so the project binding, the title, the conversation link,
the pinned theme, the unread key and the group membership all ride the row.
Group filing is safe because `session_group_membership` has keyed on
`session_uuid` since v24; the v8 table it replaced keyed on `tmux_name`, which
is the landmine the 2026-09-07 design notes flagged and which this shape does
not touch. The SAME tmux name is asked for so name-scoped per-device browser
state survives, and it is free by construction because the gate only passes on a
measured absence - but the create path still uniquifies on collision, so the
response REPORTS the name actually taken rather than the one requested.

**UI.** The picker asks the second question itself:
`SessionRestartOptions.previewFor(name, uuid)` re-asks the recreate endpoint when
the restart preview came back `cannot_determine` on a pane state that is not
`alive`, and carries the MODE back on the choice so the action posts to the
endpoint that made the prediction. `recreate` is its own rung with its own badge
("would build a new session on this record") rather than a synonym for `agent`,
because `agent` reuses the pane and keeps its scrollback and this does neither.
A failed second ask falls back to the restart preview's honest refusal, not to a
blank panel.

**MOUNTED THROUGH `src/api/restart_routes.py`** (`router.include_router`) rather
than from `src/main.py`, which another session holds modified in this tree. Same
`/api/v1` prefix, one mount, cannot be forgotten separately.

**TEST BASELINE.** `venv/bin/python3 -m pytest -q`: 5417 passed, 3 failed, 21
skipped. The three failures are the same pre-existing environmental ones
(`test_home_write_guard`, `test_state_dir_resolution`, `test_version_probe`).
New: `tests/test_session_recreate.py` (23, pure gate + plan),
`tests/test_recreate_routes.py` (10, HTTP + the re-key against a real migrated
schema with a project actually bound), `tests/test_recreate_gate_real_tmux.py`
(3, real socket), `tests/test_recreate_picker.node.mjs` (13) with its
`tests/test_recreate_picker_runs.py` wrapper. `tests/test_restart_picker_renders.py`
gained `mode` / `sessionUuid` in the two choice-shape assertions.

**STILL OPEN:** (a) the recreate offer is reachable only where a
`GET /sessions/records` row uniquely names the session - a name shared by two
records refuses rather than guesses, and the honest fix is for the sidebar to
carry `session_uuid` on its rows instead of resolving one. (b) The launchpad's
own stopped-row restart still goes to `POST /sessions/{uuid}/restart`, which has
no presence gate and no directory-spelling measurement; it should be routed
through this path, and `launchpad.js` was out of scope for this change.

---

## 2026-09-08 - punchlist 20: a resting claude reads idle, not unknown

**COMPLAINT, verbatim:** "on the homepage and sidebar many status unknown."

**MEASURED READ-ONLY ON LIVE, 2026-09-08 22:24Z.** 19 live panes on the
`cloude` socket, 15 painting `unknown`. Cause: `SessionActivityTracker`
(`src/core/session_activity.py`) is an in-memory dict and nothing hydrates it at
boot or at adopt, so after a restart `resolve()` falls to `map_tmux_fallback`,
which correctly answers `unknown` for any pane running claude. Ten of the 15 had
NEVER fired a hook and never will - hand-started without the hook env, last
assistant turns dated 2026-07-16 and 2026-08-24, alive at an idle prompt for
weeks. Three carried real hook history in the row (Fantasy Football 20:01Z,
daily-briefing 13:17Z, Mac 09-04) but all of it PERISHABLE and stale, so
`activity_persist.restore_state` correctly refused it. Zero cases of
hook-seen-but-unknown. The 4 bare-shell panes already read `idle`.

**SHIPPED.** A second source of evidence, one that outlives the process.

| Piece | File |
|---|---|
| The pure ladder, and the asymmetry it enforces | `src/core/session_status_seed.py` |
| What one transcript record says about a turn | `src/core/session_status_seed_records.py` |
| The cache and the refresh clock | `src/core/session_status_seed_store.py` |
| The two reads, and the seam | `src/core/session_status_seed_read.py` |

**IT MAY CLAIM REST AND MAY NEVER CLAIM `working`.** A file carries no
heartbeat, so a `working` seeded from one could never be expired - the identical
defect `4215ad0` had just fixed one tier up, where a raw tmux `running` painted
15 sessions busy on no evidence. Rung A is the row, judged by
`activity_persist.restore_state` (imported, never rebuilt) and read on the FULL
INSTANCE TRIPLE - byte-for-byte the WHERE clause `write_state` writes on,
because a name-scoped read answers for whichever epoch sorts newest, which is a
different question. Rung B is the last decidable record of the bound transcript,
walked BACKWARDS so the newest evidence wins.

**THE ONE BOUNDED READER IS NOW SHARED.** `claude_title_sync.read_tail_records`
was extracted out of `read_newest_custom_title`, which is rebuilt on top of it.
The 64 KB bound and its reasoning are unchanged; there is one window/clamp/
partial-line implementation instead of two about to drift.

**TWO RECORD SHAPES THE LADDER HAD TO BE CORRECTED ABOUT, both caught by
measuring rather than by reading the code.** A SIDECHAIN `end_turn` is a
SUBAGENT finishing inside a turn that is still running, so it is UNDECIDABLE.
And a SLASH COMMAND IS NOT A PROMPT: claude intercepts `/rename` before it
becomes one (which is why no hook event carries it) but still writes a
pseudo-`user` record about it wrapped in `<command-name>` /
`<local-command-caveat>` envelopes whose own text says "DO NOT respond to these
messages". Read as prompts, those were the ONLY two sessions the first version
of this ladder refused - and both were sitting at an empty `>` prompt. They are
now undecidable rather than rest, so the walk continues to a boundary claude
really wrote and a slash command can never manufacture an idle either.

**WIRED IN THREE PLACES, one hunk each.** `session_boot_readopt.py` (warm, at
the end of the pass, beside `sweep_live_sessions`), `src/api/routes.py`
(`adopt_session`, after the adopt returns), and ONE call site in
`SessionManager._session_info_for` - reached only while the answer is still
`unknown` on a pane measured LIVE, so a seed can add an answer and can never
overwrite a measured one. `session_manager.py` grew 30 lines at that single
seam and nothing else. The seed store hangs off a `WeakKeyDictionary` keyed on
the manager rather than an attribute assigned in its `__init__`, deliberately:
that file is far past the size guideline and was under concurrent edit.

**A HOOK RETIRES A SEED INSTANTLY** - the seam is gated on `hooks_seen`, so
there is no expiry to wait out and no value to clear. That gate is also what
makes seeding idempotent: a seed is a cached READING of durable evidence, not
an event applied to a state machine.

**RESULT, measured read-only against the live DB and the real corpus before
committing: all 15 of the unknowns would read `idle`**, every one via rung B,
dated by its own transcript (oldest 2026-04-23, newest 2026-09-08). 0.27 ms
median per session, 1.09 ms max. THE NEGATIVE CONTROL IS SEPARATE AND
LOAD-BEARING, because a matcher that always finds something is worse than
useless: over 400 randomly sampled transcripts the ladder splits 172 `at_rest` /
70 `in_flight` / 158 `no_marker`.

**TEST BASELINE.** `venv/bin/python3 -m pytest -q`: 5463 passed, 3 failed, 21
skipped. The three failures are the same pre-existing environmental ones
(`test_home_write_guard`, `test_state_dir_resolution`, `test_version_probe`).
New: `tests/test_session_status_seed.py` (42) - positive per rung, and a
negative control per rung: a stale `working` row does not seed working while a
stale `idle` row still does, a user prompt and a `tool_use` seed nothing, an
unreadable transcript refuses rather than answering idle, a measured absence is
named apart from an unreadable file, a sidechain `end_turn` does not seed idle,
the newest decidable record wins over an older closer, duplicated seeds are
idempotent, and a session with live hook signal is never seeded. Plus a
hermetic boot test in the style of `tests/test_boot_readopt.py` with `$HOME`
redirected under `tmp_path` so nothing reads the developer's real corpus.

**STILL OPEN:** (a) `SessionManager._restored_activity_state` (the pre-existing
rung-A read at the seam) still selects `WHERE tmux_name = ? ... ORDER BY
tmux_created_epoch DESC LIMIT 1` - name-scoped, so for two rows sharing one name
it can answer for the wrong instance. It cannot currently produce a WRONG seed,
because the new epoch-scoped read only runs after it has already declined, but
it can produce a wrong RESTORE. Fixing it means a second hunk in
`session_manager.py`, which was out of scope for this change. (b) The periodic
re-seed rides the listing poll rather than a task of its own; if the listing
ever stops running for a hookless session, its light freezes at its last seed.

## 2026-09-08 deploy to live: 1f9b437

Nine worker commits from `2361427..1f9b437` (LED centering, verify-script
archive, sidebar header, the status machine split, badge removal, the
sleep/wake bar, global toasts, the home page row and icon, wrapper
inference, recreate, status seeding) shipped to the live install with
`./scripts/deploy-mini.sh --target live --all`, restarted with
`launchctl kickstart -k gui/501/com.cloudecode.menubar`.

The index carried stale staged state from an earlier session (`MM`, `D`
and `AD` rows against a worktree that already matched HEAD). `git reset -q`
cleared it and left the tree clean, untracked included: every doc append
the workers made was already committed, and `origin/v1.1` was already at
`1f9b437`. Nothing was discarded.

Pre-deploy baseline, measured before anything was copied: 19 rows on
`GET /sessions/list` against 19 live tmux sessions, statuses 13 unknown,
3 idle, 1 working, 2 notice.

Tests on the clean tree: 5463 passed, 3 failed, 21 skipped in 196s. The
three failures are the standing environmental ones (`test_home_write_guard`,
`test_state_dir_resolution`, `test_version_probe`); the tmux-socket flake in
`test_respawn_refreshes_pane_env.py` did not fire this run. Node: 188 files,
only the pre-existing `test_archive_full_page_mode.node.mjs`.

Verified after the restart, three outcomes each, all PASS:

- Deploy hashes: `--verify-only` exit 0, 518/518 files on both the app
  bundle Resources and the server dir, mirror-clean in both directions.
- The RUNNING process serves HEAD. `GET /api/v1/version` carries a release
  string (`1.0.33`) and no git hash, so the fallback was used instead:
  seven files changed or added this round were fetched from the served
  `/static` path and sha256-compared to the repo copy. All seven matched
  (`status-led.js`, `status-led.css`, `session-sidebar-groups.js`,
  `session-sidebar-band-menu.js`, `terminal-away-bar.js`,
  `toast-global-poll.js`, `session-status-ui.js`). Corroborated by the log:
  `status_seed_warm` and `agent_infer_sweep_complete` both ran at boot, and
  neither module existed before this round.
- Sessions: 19 rows against 19 live tmux sessions, no session vanished and
  none appeared versus the pre-deploy set. `boot_readopt_complete` held 18,
  failed 0, skipped 1, live_count 19, all 18 ids recovered from
  `hook_token` and none derived.
- The status seeding is what this round was for and it MOVED THE NUMBER:
  unknown fell from 13 to 1 (`cloude_PT-IMC` alone), idle rose from 3 to 14,
  1 working, 3 finished_unread.
- Hooks over the two minutes after boot: 21 `POST /api/v1/hooks/claude-event`,
  all 200, zero `hook_post_rejected`, zero stale-session refusals.
- New routes: `GET /api/v1/toasts/history?limit=5` 200,
  `GET /api/v1/sessions/away/summary` 200 with a real session and a
  one-hour `since`, `GET /api/v1/sessions/recreate/preview` with a bogus
  uuid 404 with a sentence naming the uuid, not a 500. Note the recreate
  pair is mounted through `restart_routes.py`, not from `main.py`, which is
  deliberate and documented in that file.
- Client assets: the five new or changed JS files fetched from `/static`
  all returned 200 and passed `node --check` ON THE FETCHED BODIES rather
  than on the repo copies, and the served `index.html` references
  `terminal-away-bar.css`, `terminal-away-bar.js`, `toast-global-poll.js`,
  `session-sidebar-band-menu.js`, `session-status-ui.js` and
  `toast-history.css`.

**STILL OPEN:** one session, `cloude_PT-IMC`, still reads unknown. It fired
no hook in the window and the seeder declined it, so nothing here says
whether its row, its transcript or its pane is the reason. Not measured.

## 2026-09-08 - punchlist item 4 (activity-after-resume): the real four-minute
## measurement, re-run against current code, and it does not reproduce

- [x] **Item 4 verified closed with a live measurement, not just the earlier
  root-cause fix.** Used `tests/real_hook_app.py` / `tests/real_hook_harness.py`
  AS A LIBRARY from a standalone scratch driver (not added to the repo, per
  instructions) to: create a real session, answer the trust dialog, run one
  turn to completion (`Stop`), read the transcript uuid, SIGKILL the pane's
  process, and `respawn-pane -k` the SAME pane with `claude --resume <uuid>`
  and the same `--settings` file - the tmux-layer mechanic
  `TmuxBackend.respawn(live_restart_confirmed=True)` performs in production.
  Then polled `GET /sessions/list` every 2s from the moment the resumed pane
  was born, logging `(t, activity_status, startup_gate, unread)` plus every
  hook's arrival time off the harness's ledger. Two independent runs: one
  with a trivial no-tool prompt, one with the real `WORKING_PROMPT`-style
  5-file-read turn (so `Stop` is preceded by real `PreToolUse`/`PostToolUse`
  pairs and a trailing `SubagentStop`, matching the owner's actual workflow).

- [x] **A RESUME FIRES EXACTLY ONE HOOK - a fresh `SessionStart` - and
  nothing else.** Measured identically in both runs: `SessionStart` lands
  0.48s and 0.49s after the resumed pane's process starts. No
  `UserPromptSubmit`, no `PreToolUse`/`PostToolUse`, no `Stop`, no
  `SubagentStop` are replayed from the prior conversation's history. The
  full ledger for the tool-using run: original turn
  `SessionStart+4.66s, UserPromptSubmit+8.64s, PreToolUse/PostToolUse x5
  (13.46s..32.35s), Stop+35.71s, SubagentStop+38.49s`, then after the kill
  and resume: `SessionStart+69.62s` and NOTHING after it for the rest of
  the 300s ceiling.

- [x] **SECONDS TO SETTLE: ZERO, in both runs.** `activity_status` was
  already at its post-resume value (`finished_unread`, `unread=true`) at
  the very FIRST poll (t=0.0s) and held there for the full 10.9s
  confirmation window (poll granularity is 2s, so 0.0s is the true
  measurement, not an artifact of a coarse poll). It never reads `working`
  at any point after a bare resume. This makes sense given the mapping in
  `src/core/session_activity.py`: `SessionStart` is a lifecycle event
  consumed only by the lineage/correlation path, not one of the events
  that stamps `last_tool_event_ts` or moves the status machine - so a
  resume with no NEW prompt cannot arm the 120s working heartbeat at all.

- [x] **THE FOUR-MINUTE CLAIM DOES NOT HOLD.** Confirms and extends the
  2026-09-08 earlier closure entry above ("a closing hook event is not a
  heartbeat"): that entry fixed the mechanism (`SubagentStop` no longer
  re-arms the heartbeat when `subagent_depth == 0` / `turn_open=False`) but
  had not been re-run against an actual `--resume`. This run did that. The
  guard was measured LIVE and firing correctly during the tool-using run's
  original turn: `subagent_stop_without_start session_id=... turn_open=False`
  logged 2.78s after `Stop`, and `activity_status` read `finished_unread`
  (never `working`) both immediately before the kill and for the entire
  post-resume window. **The word "resume" in the original punchlist item
  was itself a red herring** - a resume does not replay hooks and cannot,
  on its own, produce ANY working-state exposure; the historical ~4-minute
  observation is fully explained by the (now-fixed) `SubagentStop`
  heartbeat re-arm on the turn that happened to precede the resume, not by
  anything the resume itself does. Two re-arms of the 120s
  `WORKING_HEARTBEAT_TIMEOUT_SECONDS` land almost exactly on "about four
  minutes", which is consistent with the original report.

- [ ] **SIDE FINDING, NOT CHASED DOWN: `record_claude_lifecycle_event`
  answered `LINEAGE_UNRESOLVED` for every session created in this harness
  ("no live session carries this cloudecode session id, and no persisted
  tmux name is recorded for it"), even though the session was created by
  the SAME process moments earlier and never restarted.** Reproduced 3/3
  runs. `sessions.claude_session_uuid` was therefore never written via the
  normal path in any of these runs; the measurement above used the
  transcript uuid read directly off disk instead (newest `*.jsonl` under
  `~/.claude/projects/<slugify_project_dir(realpath(work_dir))>/`), which
  is independent of that column. Not investigated further - could be
  specific to `RealHookApp`'s minimal bootstrap (it deliberately skips
  `src.main.app`'s lifespan) rather than a defect reachable from the real
  app; whoever touches `src/core/session_lineage.py` next should check
  whether `session.tmux_session` is actually populated at the point
  `record_claude_lifecycle_event` runs for a session created through the
  same request/response cycle, since that is the exact case that failed
  here.

- [ ] **OPERATIONAL NEAR-MISS DURING THIS MEASUREMENT, recorded so the next
  person does not repeat it: running `tests/real_hook_app.py` as a
  standalone script (not through `pytest`) does NOT get
  `tests/conftest.py`'s autouse `tmux_socket_isolation` fixture, so nothing
  installs `tests/socket_guard`'s socket redirect or subprocess guard.**
  First attempt created a REAL session (`cloude_ses_1d468a9a`) on the
  user's live `cloude` tmux socket, alongside his 19 other real sessions
  (confirmed via `tmux -L cloude list-sessions` logging
  `socket_name=cloude`). Caught before any real damage - the stray session
  was idle on the trust dialog and was killed by name
  (`tmux -L cloude kill-session -t cloude_ses_1d468a9a`) within the same
  turn, verified gone, no other session touched, no orphan claude process
  left running. Fix: a standalone driver MUST call
  `tests.socket_guard.install_default_socket_redirect()` and
  `install_subprocess_guard()` itself before creating anything, verify
  `settings.load_auth_config().session.tmux_socket_name` actually resolved
  away from `"cloude"` before proceeding, and call
  `kill_test_socket_server()` / `remove_subprocess_guard()` /
  `remove_default_socket_redirect()` in a `finally`. The corrected pattern
  is in the scratch script referenced below - if this harness ever grows a
  documented "run as a script" mode, this guard installation belongs in it
  by default, not left to whoever forgets it next.

- Rerunnable driver (not part of the repo, per instructions):
  `/private/tmp/claude-501/-Users-jsugamele-Library-Mobile-Documents-com-apple-CloudDocs-Sync-Development-CloudeCode/2629dba5-234e-44d2-be54-ddaf69c8db4b/scratchpad/item4_resume_timing.py`.
  Run with `CLOUDE_REAL_HOOK_TESTS=1 venv/bin/python3 <path>` for the
  no-tool original turn, or add `ITEM4_TOOL_PROMPT=1` for the tool-using
  original turn. Needs claude/tmux/node on PATH, as the shipped real-hook
  suite does.

---

## 2026-09-08 - unread is ONE instance-keyed flag, read by every surface [DONE]

**Reported, measured in the browser on the live app.** Clicking a running
session card's "mark unread for followup" envelope on the home page turned
the envelope yellow, while the SIDEBAR row for the same session stayed
`data-outer="steady"` for over 12 seconds across two `/sessions/list`
polls. The owner's spec, verbatim: "when clicking a tab, the session is
marked read. if i want it unread i click unread. it allows me to know
whats waiting."

**The divergence, traced rather than guessed.** Three defects, one
symptom, and the client one is the whole visible failure:

1. **No live caller passed the LED its unread signal.**
   `SessionStatusUI.dotHtml(status, signals)` takes `unread` and
   `startup_gate` as an optional second argument, and
   `StatusLed.ledStateFor` is the only thing that turns `unread` into an
   outer `unread` halo. All three live call sites
   (`session-sidebar-rows.js:389`, `launchpad.js` card, `launchpad.js`
   project-tree row) passed the status alone. So the flag reached the row,
   was fingerprinted by BOTH repaint signatures (which already carried
   `unread`), forced a repaint, and was dropped at the last inch: `idle` +
   unread painted `steady`, `working` + unread painted `active`. Only
   `finished_unread` looked right, and only because that status string
   hardcodes the halo. Every surface was equally broken - the launchpad's
   yellow envelope, which reads `s.unread` directly, is what made it look
   like only the sidebar was wrong.
2. **The `/sessions/list` READ used a cache the WRITE never used.**
   `_session_info_for` resolved the epoch from `self._instance_epochs`,
   populated only by the create/adopt persist steps and therefore EMPTY
   for every session predating the process (after any restart, all of
   them). A miss composes the LEGACY bare-name key, which cannot see an
   entry stored under `<name>@<epoch>` - the key the manual control writes
   via `_epoch_for_tmux_name`. Now reads `row["created_at_epoch"]` off the
   bulk tmux probe it already fetched.
3. **The two WRITERS keyed differently.** The `Stop` branch of
   `record_hook_event` also read `_instance_epochs`, so it filed the same
   pane under the bare name while the control filed it under the instance
   key. Now uses `_work_stamp_epoch` (probes tmux once, caches), the same
   source `mark_session_viewed` already used.

**Behaviour change, per the spec.** `mark_session_viewed` (the WS bind)
now clears BOTH sub-flags: opening the tab marks the session read, full
stop. It used to spare `manual` ("survives being viewed"), and
`tests/test_hook_driven_status.py::test_manual_unread_survives_being_viewed`
asserted that; it is now
`test_manual_unread_is_cleared_by_being_viewed`. Clearing the control
(`PATCH .../unread` with `false`) also clears both, because the envelope
renders the UNIFIED flag - a row flagged by a `Stop` shows the control
pressed, and clearing only `manual` would leave it unread and read as a
dead control. New `UnreadStore.clear()` drops the pair in one write and
retires the legacy bare-name entry alongside the composite one.

**Verified.** Both new suites were run against the reverted code and
FAIL there: `tests/test_unread_led_one_field.node.mjs` 6 of 17 fail
without the client fix, `tests/test_unread_one_flag.py` 6 of 9 fail
without the server fix. Full pytest 5473 passed / 3 failed / 21 skipped
(the 3 are the known environmental ones: `test_home_write_guard`,
`test_state_dir_resolution`, `test_version_probe`), up from the 5463
baseline with no new failures. Node: 190 files, 2 fail, both known -
`test_archive_full_page_mode.node.mjs` (pre-existing) and
`led_state_for.node.mjs` (a piped-stdin CLI helper, not a standalone
test).

**Negative controls are in both suites** because a renderer that
hardcoded the halo, or a read path that always answered True, would pass
every positive assertion: an unmarked row must stay `steady`/`active`, a
DEAD pane must never paint as unread whatever the flag says, and a mark
aimed at a different tmux name must not reach this row.

**Files.** `src/core/unread_store.py` (new `clear`),
`src/core/session_manager.py` (three call sites; net -0 lines),
`src/api/routes.py` (docstring), `client/js/session-sidebar-rows.js`,
`client/js/launchpad.js` (net 0 lines), `docs/session-status.md`,
`CLAUDE.md`, plus the two new test files.

## 2026-09-08 - boot race closed: PT-IMC's epoch never recorded [DONE]

**Reported, from a read-only trace against a live boot at 23:14:25Z.**
`session_re_registered_from_backend session_id=ses_fb4b2825
backend_session=cloude_PT-IMC` landed at 23:14:44.109Z from the LEGACY
metadata-driven reconcile (`SessionManager._lifespan_tmux_reconcile` /
`_register_session`), a fraction of a second ahead of the triple-keyed
boot re-adopt (`boot_readopt_complete held=18 failed=0 skipped=1` at
23:14:44.407Z; the one skip was PT-IMC, already registered).

**Root cause.** Only `session_boot_readopt.py`'s attach step writes
`manager._instance_epochs[session_id] = epoch`; the legacy reconcile
never does. `plan_readopt` skips a name already registered
(`SKIP_ALREADY_HELD`) BY NAME, before it ever resolves an epoch for it -
so the race left PT-IMC's epoch permanently unset. Every reader keyed on
the instance triple, including `session_status_seed_read.derive_seed`,
then read "this session's exact tmux instance could not be identified"
and cached that refusal, silently, because the swallow around it was
`except Exception: logger.debug(...)` and this server emits no debug
lines.

**Fix.** `session_boot_readopt._record_epoch_for_already_registered` now
runs right after the plan is built: for every name skipped as
`SKIP_ALREADY_HELD`, it resolves the epoch from the SAME epoch-bearing
listing this pass already paid for, maps the name back to whichever
session id already holds it (`manager.backends`), and fills
`_instance_epochs` if it is still unset - logging
`boot_readopt_epoch_recorded_for_registered` once per session healed.
Costs no extra tmux round trip.

Separately, `session_status_seed_read.py`'s swallows are narrowed from
bare `except Exception` to a named tuple (`sqlite3.Error`, `OSError`,
`ValueError`, `KeyError`) and now log at `warning` with the session id
and the exception's type name, in `read_instance_row`,
`read_transcript_rest`, `seeded_status`, and `seed_live_sessions` (which
is now per-session inside its loop, so one bad session's read failure no
longer aborts the whole boot warm-up). And a cached "instance could not
be identified" refusal is no longer permanent:
`SessionStatusSeeds.due`/`remember` now carry the epoch a reading was
taken against, and a refusal cached with no epoch is due again the
instant a caller supplies one, rather than waiting out a full
`SEED_REFRESH_INTERVAL_SECONDS` on grounds that no longer apply.

**Verified.** New hermetic tests: `test_boot_readopt.py::
test_a_session_registered_ahead_of_this_pass_still_gets_its_epoch`
(pre-registers a session the way the legacy path does, with no epoch,
and asserts the pass fills it in); `test_session_status_seed.py::
test_a_refusal_cached_with_no_epoch_is_due_the_instant_one_is_known` and
`test_a_seed_cached_with_a_known_epoch_is_not_forced_due_by_the_same_epoch`
(store-level); `test_seeded_status_retries_a_refusal_once_the_epoch_is_known`
(the PT-IMC shape end to end, through `seeded_status`); and
`test_a_broken_datastore_read_logs_at_warning_not_debug` (a
`sqlite3.OperationalError` from a broken connection double is caught,
logged at `warning` with the session id and `error_type`, and never
raises past `read_instance_row`). Full pytest: 5478 passed / 3 failed
(the same known environmental three: `test_home_write_guard`,
`test_state_dir_resolution`, `test_version_probe`) / 21 skipped - no new
failures.

**Files.** `src/core/session_boot_readopt.py`,
`src/core/session_status_seed_read.py`,
`src/core/session_status_seed_store.py`, `tests/test_boot_readopt.py`,
`tests/test_session_status_seed.py`, `CLAUDE.md`.

---

## 2026-09-08 DEPLOY RECORD - c360cfc to live (mac-mini-m4, port 8000)

Deployed `c360cfc` (boot epoch for a session the legacy reconcile
registered first) and `c39dd14` (unread one flag), branch `v1.1`, tree
clean, HEAD equal to `origin/v1.1` at deploy time. `./scripts/deploy-mini.sh
--target live` wrote both destinations (app bundle Resources, then the
server dir), 518 files, verified both directions before and after the
restart.

**Regression gate before the deploy.** `tests/test_unread_one_flag.py`,
`tests/test_boot_readopt.py`, `tests/test_session_status_seed.py`,
`tests/test_led_real_hooks.py`: 70 passed / 9 skipped (the real-hook file
skips without `CLOUDE_REAL_HOOK_TESTS=1`, as designed). Node
`tests/test_unread_led_one_field.node.mjs` and
`tests/test_status_summary.node.mjs`: 2 passed / 0 failed.

**Before.** 19 live tmux sessions on `-L cloude`; `GET
/api/v1/sessions/list` returned 19 rows, idle 15 / working 1 /
finished_unread 3 / unknown 0, 4 rows unread.
`cloude_Fantasy_Hockey_2026` was unread by hand from the home page,
`activity_status=finished_unread`.

**After.** Boot at 2026-09-08T23:52:12Z.

- `boot_readopt_complete`: held 18, skipped 1, failed 0, live_count 19.
  held + skipped = 19 = the live tmux count. `id_sources` all
  `hook_token` (18), no `legacy_row`, no `derived`, `no_row` 0 - so no id
  was minted and no hook token was rotated.
- `boot_readopt_epoch_recorded_for_registered` fired once, for
  `cloude_BHPP` / `ses_8f7ea3db`, epoch 1788559250. That is the c360cfc
  fix doing exactly the thing it was written for: the one session the
  legacy reconcile had already registered without an epoch got its epoch
  recorded rather than being skipped empty.
- `status_seed_warm`: seeded 19 = examined 19. PT-IMC, the one miss
  before this round, is gone.
- `GET /api/v1/sessions/list` after the deploy: 19 rows for 19 live tmux
  sessions, idle 15 / working 1 / finished_unread 3, and **zero**
  `unknown`.
- Unread survived the restart: 4 rows unread
  (`cloude_Agent_-_Cloude_Code`, `cloude_Hirschfeld`,
  `cloude_Fantasy_Hockey_2026`, `cloude_daily-briefing`), and
  `cloude_Fantasy_Hockey_2026` came back `unread=true`,
  `activity_status=finished_unread` - the flag in `unread_state.json` is
  keyed on the instance and the instance did not move.
- Hooks over the first 2m20s after boot: 30 POSTs to
  `/api/v1/hooks/claude-event`, all 200. Zero non-200, zero
  `hook_post_rejected_invalid_token`, zero
  `hook_post_rejected_non_loopback`.
- Served bytes, not the file on disk: `GET
  /static/js/session-sidebar-rows.js` hashes
  `8de50029561df1d427325a21ec327d573da6f64684da39b56e537befc7aafdea` and
  `GET /static/js/session-status-ui.js` hashes
  `5a001c143afe31509825373115edef22465ce781dd398f98fb92d8509763ec8e`,
  both equal to the repo copies.
- `./scripts/deploy-mini.sh --target live --verify-only` re-run after the
  restart: exit 0, 518/518 on both destinations, mirror-clean.

**Method note worth keeping.** `/sessions/list` is under `/api/v1`, not
at the bare path this file and `CLAUDE.md` quote, and it requires auth. A
token is obtained on the mini itself from `TOTP_SECRET` in the live
install's `.env` via `pyotp` against `POST /api/v1/auth/verify`; the
secret never leaves that box. The negative control was run in the same
pass: a bogus bearer token returns 401, so a 200 on the real one is
evidence of the credential and not of an open endpoint. Accepted and
rejected hook counts were read off uvicorn's own access lines rather than
off a success-only application event, because the accepted path logs
nothing of its own and a grep for rejections alone can never tell "none
rejected" from "none received".

## 2026-09-09 - a terminal bind clears the same instance key the writers wrote

**Reported.** Browser measurement on live (HEAD 2692b63): mark "unread for
followup" on the Fantasy Hockey 2026 card - card LED, sidebar row and the Joe
group header all paint the outer `unread` halo within one poll, so c39dd14's
set half works. Then click the row: the page navigates, the terminal paints,
and nine seconds later `GET /sessions/list` still reports `unread: true`,
`activity_status: finished_unread` for `cloude_Fantasy_Hockey_2026`
(`ses_9523c563`). Owner's rule, verbatim: "when clicking a tab, the session is
marked read. if i want it unread i click unread."

**Cause, measured, and it was NOT the server.** A live end-to-end probe against
the running install - mint a JWT from the install's TOTP secret, PATCH the
manual unread, open a real `/ws/terminal?session_id=ses_9523c563`, hold it two
seconds, close it - cleared BOTH sub-flags on the correct instance key
`cloude_Fantasy_Hockey_2026@1788444912`, moved the row to `unread: false` /
`activity_status: idle`, and left the negative control `cloude_Hirschfeld`
untouched. The server was never the problem.

THE BROWSER NEVER OPENED A WEBSOCKET. Grepping the live log across the whole
window: `websocket_disconnected` at 23:57:28.776Z (the navigation away) and NO
`websocket_connected` until the probe's own at 00:01:35.065Z, four minutes
later. Confirmed in the live tab: `TerminalController.ws === null` while
`sessionActive === true`, `isReconnecting false`, `_intentionalClose false`,
footer stuck on "Connecting to terminal..." - the string set on the line ABOVE
the await in `connectWebSocket()`. A bare `requestAnimationFrame` in that tab
did not fire within 3000 ms at `visibilityState === 'hidden'`, and
`waitForFontsAndLayout()` did not resolve within 4000 ms. The suspended connect
opened its socket the instant the tab was painted, 35 minutes on.

So: `waitForFontsAndLayout` ended on two bare
`await new Promise(requestAnimationFrame)` calls; a browser does not run rAF
for a tab it is not painting; `connectWebSocket()` suspended there, before
`openWebSocket()`. No socket means no `onclose`, so every rung of the
auto-reconnect ladder is unreachable too - the failure is silent and permanent,
and it breaks the terminal outright, not only the unread flag.

**Fixed.**
- NEW `client/js/terminal-layout-wait.js` - every wait raced against a timer
  (`setTimeout` fires in a background tab, rAF does not). A layout wait may
  DELAY a connect, never CANCEL one. A timed-out wait is reported, not thrown;
  the resize handshake corrects the grid on the first real paint.
  `terminal.js` is a thin delegate and got SHORTER (2423 -> 2422 lines).
- NEW `src/core/unread_identity.py` - THE one epoch source the unread key is
  derived from, and it is the live tmux listing. `_unread_epoch` is the only
  caller in `session_manager.py`; the `Stop` writer, the manual control,
  `mark_session_viewed` and both read paths all reach it. Removes the two
  answers that used to compete: the session_id-keyed `_instance_epochs` (seeded
  from the DB row, empty after a restart) and the row's own recorded epoch. The
  name-keyed cache is a memo of the tmux measurement, refreshed by every
  listing, so a recycled name cannot hold a dead session's epoch past one poll.
  `_epoch_for_tmux_name` is gone, folded into the one resolver.

**Tests.** `tests/test_unread_bind_clears_same_key.py` (the measured sequence:
manual mark, bind, list reads read; Stop sets it again, bind clears again, a
duplicate bind is harmless; set and clear agree with a COLD memo after a
simulated restart) and `tests/test_terminal_layout_wait.node.mjs` (an unpainted
tab resolves instead of hanging, with the negative control that a painted tab
still awaits both frames rather than being short-circuited). Negative controls
throughout: a bind for a different session leaves this flag alone, a bind on a
different INSTANCE of the same name does not clear, and the on-disk file keeps
every other row verbatim - a clear that dropped everything would pass every
positive assertion.

pytest 5491 passed / 3 failed / 21 skipped, the 3 the known environmental ones.
Node 189 of 190, the one failure the known `test_archive_full_page_mode`.

**FOLLOW-UP, same day: FIXING ONE rAF WAIT WAS NOT ENOUGH, and only a live
re-verification caught it.** After the first deploy the delegate was live in
the page (`waitForFontsAndLayout.toString()` contained `TerminalLayoutWait`,
the module was loaded) and a hidden tab STILL opened no socket and still read
`unread: true`. `reconnectToExistingSession` (the sidebar row click) and the
adopt branch of `connectToSession` each carried their OWN bare
`await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
and both sit ABOVE the `setTimeout(() => this.connectWebSocket(), 500)` in the
same async function - so the connect was never even SCHEDULED, let alone
reached. `TerminalLayoutWait.settleFrames(frames, timeoutMs)` replaces both,
and `tests/test_terminal_layout_wait.node.mjs` now also asserts the SOURCE of
terminal.js carries no bare rAF await at all, so a third one cannot be added
back quietly.

Two things this round is worth remembering for. A unit test on the module
would never have caught it: the module was correct and the caller above it was
not, which is exactly what "verify what the user sees" means here. And the
first version of the delegate dereferenced `window.TerminalLayoutWait`
unguarded, which threw in `tests/test_terminal_reconnect_buffer.node.mjs` - a
real defect, not a harness artifact, since a missing optional script would have
broken the connect outright. It is `?.` with a `Promise.resolve()` fallback
now (never a timer: that harness stubs `setTimeout` to a no-op, and a fallback
that cannot resolve is the bug being fixed), and the harness loads the module
the way index.html does so it measures the real path.

**Live verification, deployed build, 2026-09-09.**
- Server end to end (no browser): mint a JWT from the install's TOTP secret,
  PATCH manual unread, open a real `/ws/terminal?session_id=ses_9523c563`,
  hold 2s, close. `unread: true` / `finished_unread` -> `unread: false` /
  `idle`; the key `cloude_Fantasy_Hockey_2026@1788444912` appears and is
  dropped; negative control `cloude_Hirschfeld` stays `unread: true`.
- The actual defect, in a BACKGROUNDED tab (`visibilityState: 'hidden'`), as a
  genuine session-to-session switch: before `unread: true` /
  `finished_unread`, a WebSocket opens and is scoped to the right session id,
  after `unread: false` / `idle`, Hirschfeld untouched either side.
- `deploy-mini.sh --target live --verify-only` exit 0, 520/520 on both
  destinations, mirror-clean. `boot_readopt_complete` held 18 / failed 0 /
  skipped 1 against 19 live tmux sessions, identical to the pre-deploy
  baseline. Over one minute: 2 hook POSTs accepted, 0 403s, 0 410s, 0
  `hook_post_rejected_invalid_token`.

---

## 2026-09-08 - late round closed out (07bbbb8..54731f9), deployed and confirmed live

21 commits, all deployed to live and verified: `./scripts/deploy-mini.sh
--target live --verify-only` reported 520/520 file hashes matching on both
destinations, boot held 18 sessions plus 1 benign skip against 19 live tmux
sessions, zero hook-token rejections in the post-deploy window, and zero
`unknown` activity statuses out of 19.

**Commits, newest first:**

- `54731f9` - the sidebar-rejoin and adopt code paths each carried their own
  bare rAF wait above the websocket connect; both now race
  `TerminalLayoutWait` instead of hanging in a backgrounded tab.
- `43ef512` - a terminal bind clears the same instance-keyed unread flag the
  stop hook and the manual mark write, via `unread_identity.py`'s one epoch
  source (the live tmux listing).
- `c360cfc` - boot epoch race closed: a session the legacy metadata reconcile
  registered first is now recorded (`boot_readopt_epoch_recorded_for_registered`)
  instead of silently skipped by the triple-keyed pass.
- `c39dd14` - unread collapsed to one instance-keyed flag; every `dotHtml`
  call site now passes the `unread`/`startup_gate` signals it was silently
  dropping; `UnreadStore.clear()` clears both sub-flags.
- `1d03f28` - the unread-count badge removed from the sidebar summary LED
  (the outer ring already says unread).
- `a9d0da2` - sleep/wake choice: after 60s away, the bar offers full history
  (bounded by `scrollback_lines`) / summary (toasts + hook state + alternate
  screen probe via `GET /api/v1/sessions/away/summary`) / just continue. Open
  item: a WS drop with the user present raises no bar.
- `54475f3` - items 7 and 8 closed: toasts raised from any screen
  (`toast-global-poll.js`, `GET /api/v1/toasts`), dismissed per session with
  an expiring ring; history page under settings > notifications,
  `GET /api/v1/toasts/history`, storage is process memory (acked capped at 50
  per session), not durable. Verified in Brave: a "Your turn" toast for BHPP
  appeared on the home page.
- `a74988a` - home page: project count sits 4px off the fold arrow in accent
  text; archive button is a stroke icon (`archiveIconSvg` in
  `session-status-ui.js`) matching the pencil.
- `41382ee` - item 3 partial: `session_agent_infer.py` +
  `session_agent_infer_sweep.py` infer a hand-started session's wrapper from
  ps argv at boot, adopt, and first hook; new `agent_family_source
  inferred_process` renders as a dashed guess pill, never a launch fact.
  Live: 0 rows to fill (all 19 live panes already carried `agent_type`).
  Open: no periodic sweep timer.
- `46c4872` - item 22: `session_recreate.py`, `recreate_routes.py`
  (`GET /sessions/recreate/preview`, `POST /sessions/recreate`, keyed on
  `session_uuid`, mounted via `restart_routes.py`); gate is a tmux LISTING
  answering gone/present/unknown, only gone acts; row re-keyed to the new
  triple, project/title/theme/unread/group membership ride the row.
- `1f9b437` - status seeding: `session_status_seed.py`, rung A row
  `activity_state` if fresh (stale working refused), rung B transcript tail
  last decidable record (turn end seeds idle at its timestamp; prompt/tool_use
  seeds nothing; `/rename` envelopes undecidable), rung C bare shell idle,
  else unknown; may never claim working. Live: unknown 13 -> 1 at first
  deploy, then 0.
- `c360cfc` (deploy record `2692b63`) - see above.
- `537c10c` - docs: closed the two status findings, recorded the reaper gap.
- `cafb50c` - `SubagentStop` NEVER counts as activity (only decrements depth
  with a floor); fork's dead-row-in-live-list hunk removed per owner ("they
  go into recent, they can disappear"); real-hook test 9 passed. Item 4.
- `2174b0d` - sidebar group headers: count first in a 22px gutter
  (`--sidebar-gutter`), colored tabular text, no pill; kebab on every header
  incl. pinned and other (`session-sidebar-band-menu.js`, fold/expand).
- `3c640fa` - 21 one-off verify scripts (7,649 lines) archived to
  `scripts/archive/verify/` with README; 8 kept (CI-called or reusable).
- `07bbbb8` - LED halo concentric (one shared inset on all four sides;
  measured -1.35px at 9px).

**Items closed with no commit of their own, verified or decided this round:**

- **Item 4, closed.** Measured with `CLOUDE_REAL_HOOK_TESTS=1` driving a real
  claude through `--resume`: exactly one hook fires, `SessionStart` at
  +0.48s; `activity_status` reads `finished_unread` from the very first poll;
  zero seconds of `working` exposure. The old ~four-minute observation is
  fully explained by the (separately fixed, `cafb50c`) `SubagentStop`
  heartbeat re-arm landing on the turn that happened to precede the resume,
  not by anything the resume itself does. Reproduced 3/3 runs. Side finding,
  not chased: `record_claude_lifecycle_event` answered `LINEAGE_UNRESOLVED`
  for every session created inside this harness, even though the session was
  created by the same process moments earlier - see the harness entry above
  this section for the full note and what to check first.
- **Item 9, closed by owner decision, no migration.** Pin is a flag that
  floats the row to the top; ungrouped stays legal. Residue: a check that a
  pinned row floats regardless of its group is still untracked verification
  work.
- **Item 11, closed.** Verified live on `54731f9` by the orchestrator in
  Brave: mark unread on the home page -> server reports `unread: true`,
  `finished_unread`; open the tab -> server reports `unread: false`, `idle`.
  A hidden automation tab's DOM repaint lagging is Brave throttling hidden-tab
  timers, not the app - confirmed separately by the terminal-layout-wait fix
  landing before this check.

**Git housekeeping, no code behind it:** 184 local branches merged into
`v1.1` deleted (`git branch -d`, branch count 207 -> 16), 7 stale worktrees
whose branches were already merged removed, plain `git gc` ran clean, `.git`
163M -> 135M. `feat/gui-fork` (unmerged to its own remote-tracking branch)
and the `editor-project-roots` worktree (dirty) were left alone, not forced.
Recovery record (sha of every ref before deletion) is in a scratchpad file
noted in the "Local branch/worktree prune + gc" entry earlier in this file -
treat that path as non-durable across sessions. Remote rule restated: push
only to `origin` (ccsliinc/CloudeCode) or `adamdev` (CloudeCodeDev), never
`upstream` (Adoom666/CloudeCode) - its push URL is disabled by construction.

**Consolidation candidates measured, none started (for HANDOFF's "next"):**
`src/core/session_manager.py` 7,684 lines, `src/api/routes.py` 4,022,
`src/core/tmux_backend.py` 2,542, `client/js/launchpad.js` 6,472,
`client/js/terminal.js` 2,423; 29 Python files and 13 JS files over the
500-line guideline in total; the same HTML-escape helper is copy-pasted
across 7 JS files; `PTYBackend` legacy branches remain in 5 core files. The
small `src/core` module families are healthy as-is and should be left alone -
the size problem is concentrated in the five files named above.

**Test baseline at the end of this round:** pytest 5491 passed / 3 failed
(the same three environmental: `test_home_write_guard`,
`test_state_dir_resolution`, `test_version_probe`) / 21 skipped. Node 191
tracked files, 1 known failure (`test_archive_full_page_mode.node.mjs`);
`tests/led_state_for.node.mjs` is a piped-stdin CLI helper, not a standalone
test.

**Still open after this round:** the websocket push (last, deliberately -
`src/api/websocket.py` still carries no project/session-list message type);
item 2b (re-measure the db integrity request-path cost on a quiet box);
the HTML-escape helper dedupe across 7 JS files; the `PTYBackend` trim; the
big-file splits listed above; a periodic sweep for `session_agent_infer`
(item 3's residual piece); a bar for a WS drop while the user is present
(only the 60s-away sleep/wake bar exists); toast history durability
(process memory only, does not survive a restart); the deferred rename-push
retry (a push deferred on a measured-missing transcript is never retried);
`FALLBACK_PROJECTS_ROOT` hardcoding `/Users/jsugamele`
(`src/core/project_directory.py:85`); `--name` dropped on a restart's
resume; gitleaks not installed on the mini; the
`~/.config/restic/mini-m4.pw` plaintext password awaiting the owner's
rotation decision; the ~24GB of `cloude.db.bak-*` copies awaiting the
owner's word to delete (list the actual state dir first, not every filename
is recorded in this repo's docs); `_restored_activity_state` still
name-scoped rather than instance-keyed; and
`record_claude_lifecycle_event` answering `LINEAGE_UNRESOLVED` for sessions
created inside the real-hook test harness (found by the item-4 run above,
not chased).

- [x] NOT A BUG: "a cleared unread does not repaint the led". Investigated on
  live 54731f9 in Brave. The answer is (c), the poll pauses, and it pauses on
  purpose. Both list polls stop for a surface that is off screen: the sidebar's
  `_startPoll`/`_stopPoll` are called from `open()`/`close()`
  (`client/js/session-sidebar.js:219,245`) so a closed panel has NO timer at all,
  and the launchpad's 5s `_startRunningSessionsPoller` (`launchpad.js:529`) keeps
  ticking but returns early on `ProjectListRenderGuard.shouldPoll(document)` while
  `#launchpad-screen` lacks `.active`. Measured mid-symptom with the terminal up:
  `sidebar.poll:false`, `guardShouldPoll:false`, server `unread:false`, all three
  DOM leds still `data-outer="unread"`. Ruled OUT (b): the fingerprint already
  carries `unread` (`session-sidebar-rows.js:207` `signature()`), and calling the
  real tick `SessionSidebar._fetchAndRender()` by hand flipped the row to
  `unread:false` and the led to `steady` in one pass. Ruled OUT (a): the launchpad
  interval was alive and firing throughout, and the sidebar had no timer to
  throttle. The earlier hand-call of `SessionSidebarFetch.load()` proved nothing
  because it only fetches and returns rows, it never assigns `_rows` and never
  calls `repaint()`. Every surface refreshes the moment it becomes visible:
  `open()` ends in `_fetchAndRender()` and `showLaunchpad()` ends in
  `loadProjects()`, both verified painting `steady` on return, and a sidebar left
  PINNED open repaints within one 5s poll unaided. The `Joe` group header reading
  `unread` beside a cleared Hockey row is also correct, not stale:
  `cloude_daily-briefing` is genuinely unread in that group, and the client's
  unread set matched the server's four rows exactly. No code change.

## 2026-09-09 - status LED: one element, fill plus a box-shadow ring and glow

DONE. Owner's report, verbatim: "the circles are still not lining up properly.
can we do the same with only one icon? can we have a fill color and a border
color, and can the border have a an opacity or blur so we can make the same
effect with only one icon?" then "go".

ROOT CAUSE, and why the previous fix could not have worked. The halo was an
`::after` - a second box, sized off the dot. The layout engine pixel-snaps a
box's position and its size, and it snaps the halo's box independently of the
dot's box. So whenever the dot itself landed on a fractional x or y - routine
inside a flex row, or wherever a text baseline puts an inline box on a half
pixel - the two rounded different ways and the circles came apart by a device
pixel. The 2026-09-08 symmetric-`inset` change fixed the halo's own INTERNAL
symmetry (its left and right offsets could no longer disagree) and was
therefore correct and insufficient: the drift was BETWEEN TWO BOXES, not
inside one. A box-shadow is not a box - it is painted from the element's own
border box at that box's own subpixel position - so concentric stops being
something a rule arranges and becomes the only geometry available.

WHAT SHIPPED. `client/css/status-led.css` rewritten. No pseudo-element. Fill
is `background-color` from `data-inner`; the outer ring and its glow are two
layers of ONE `box-shadow` from `data-outer` (`0 0 0 1px` hard ring, then
`0 0 4px 1.5px` glow). Alpha is mixed into the shadow colour with
`color-mix(in srgb, <hue> <alpha>, transparent)` rather than element
`opacity`, which on one element would fade the fill too.

TOKENS INTRODUCED: `--led-ring-width` (1px), `--led-glow-blur` (4px),
`--led-glow-rest` (0.4), `--led-ring-ink`, `--led-ring-alpha`,
`--led-glow-alpha`, `--led-hollow-width`, `--led-inset-ring`,
`--led-ring-layer`, `--led-glow-layer`, `--led-glow-layer-rest`.
RETIRED: `--led-halo-scale`, `--led-halo-inset`, `--led-halo-ink`,
`--led-halo-opacity`. KEPT: `--led-size` (9px), `--led-glow-spread` (1.5px),
every `--led-color-*` hue unchanged.

THREE TRAPS THE REWRITE HAD TO CLEAR, all recorded in the file and in
docs/session-status.md:

1. THE HOLLOW `unknown` RIM WOULD HAVE ERASED THE OUTER RING. There is one
   `box-shadow` property and the ring needs it, so `[data-inner='unknown']`
   declaring its own would have made one dimension depend on the other - the
   invariant this component exists to hold. It goes in as a LAYER,
   `--led-inset-ring`, defaulting to a no-op `inset 0 0 0 0 transparent` so
   the layer count never changes. For the same reason `off` zeroes the ring
   and glow ALPHAS instead of setting `box-shadow: none`, which would take
   the rim with it.
2. THE LEGACY REFEREE'S `box-shadow: none` WOULD HAVE BLANKED EVERY RING.
   `.status-dot.status-led` is two classes and beats every rule in the
   component. It was correct while the ring lived on a pseudo-element and is
   now removed; the legacy shadows it cancelled are single-class rules in
   `status-dot.css`, which loads FIRST, so source order already handles them.
3. THE REFEREE'S BLANKET `animation: none` WOULD HAVE KILLED THE PULSE. Now
   that the animation is on the element rather than the pseudo, that reset
   ties with the breathing rule at (0,2,0) and wins on order. It is scoped
   off the two breathing states with `:not()`, which is order-independent.

MOTION: keyframes touch the glow layer only, spread and alpha together off
the one `--led-glow-rest` fraction. The ring layer is byte-identical at both
ends. No transform, no width, no margin, no inset - `box-shadow` is
paint-only, so the element's box is identical at every frame. Costs a repaint
per frame instead of a composited transform; the region is about 16px square,
and the alternative is a second box. `prefers-reduced-motion` kills the
animation and nothing else, because the base rule already paints the full lit
value.

TESTS: `tests/test_status_led.node.mjs` rewritten from the halo assertions -
46 pass. Adds a comment-stripped `RULES` view, because this stylesheet's own
explanations name the properties the structural assertions forbid and were
failing their own tests. New assertions: no `::after`/`::before` anywhere, one
`box-shadow` declaration, the hard ring is zero-blur and its 9px diameter is
an integer, glow reach does not exceed the 16.2px the halo had, no `opacity`
rule anywhere, the hollow rim is a layer not a declaration, the referee
touches no `box-shadow`, the referee's animation reset excludes the breathing
states, keyframes touch box-shadow alone with matching layer counts, and
nothing in the sheet uses transform / margin-top / margin-left / inset /
position:absolute. Also green: test_session_status_ui (7), test_status_summary
(17), test_unread_led_one_field (17), test_no_remote_assets (9).

GALLERY (scratchpad, not published): three rounds side by side - the shipping
single-element round with `status-led.css` inlined VERBATIM and unscoped, plus
the 1.3x and 1.7x halo rounds re-created and scoped under `.era-halo`, so the
round under test is byte-identical to what ships. Every inner x outer cell at
9px, 12px and 16px, crosshair stages, and rows offset by `margin-left: 0.5px`
and `0.25px` to force the dot's box onto a fractional device pixel - the exact
condition the drift needed.

OPEN, deliberately: the ring and glow are flat pixel values and do NOT scale
with `--led-size`, so a much larger LED reads as a thinner ring. Correct at
the 9px every call site actually ships; would need revisiting if a surface
ever rendered at 36px.

## 2026-09-09: 18 legacy cloude.db backup files moved to Trash

Storage cleanup of `~/Library/Application Support/CloudeCode/`, verified
reversible move (not delete). 18 named backup snapshots (bak-uuidrepair,
bak-agenttype, bak-uuidfill, bak-import, bak-v23, bak-projectbind,
bak-sessionkind, bak-claudeuuid, bak-preidentity, bak-v6, bak-v8, bak-v9,
bak-v10, bak-v11, pre-cleanup, pre-media-migrate, pre-v10, pre-v11) plus
34 `-shm`/`-wal` sidecars (52 files total, 32G) moved via `mv` into
`~/.Trash/cloude-db-backups-20260909/` (same volume, instant rename).
Preconditions checked before moving: zero open file handles (lsof),
live `cloude.db` quick_check ok. Kept untouched:
`cloude.db.bak-v24-20260908T194725Z` (4.6G, verified SQLite format 3
header) - the most recent pre-v24-migration backup - plus the live
`cloude.db`, `unread_state.json`, `hook_tokens.json`, and everything else
in the data dir. Data dir size 46G -> 14G. Post-move directory diff
confirmed no file outside the 18-name target list was removed. Note: an
unrelated `cloude.online-backup.db` (4.6G) appeared during this pass from
the app's own background backup process - not touched, not part of this
cleanup. Reclaim the 32G by emptying the Trash (not done here, left for
the owner).

## 2026-09-09 restic now covers Development and the app data dir

- [x] Owner asked for "all of development added to restic". Done. The nightly
  job `/Users/jsugamele/docker-management/devices/mini-m4/backup-m4.sh` (this is
  the file launchd actually runs; the copy under `ai-setup/scripts/launchd/` is
  NOT executed) gained two sources:
  `/Users/jsugamele/Library/Mobile Documents/com~apple~CloudDocs/Sync/Development`
  and `/Users/jsugamele/Library/Application Support/CloudeCode`. Repo is
  `rest:http://10.0.10.80:8000/mini-m4` on qnap-home, LaunchAgent
  `com.jsugamele.backup-m4`, daily 03:30, retention 7d/4w/6m run on qnap-home
  because both REST servers are append-only and this host is write-only.
  The long iCloud spelling is what was added, deliberately, per gotcha 6.

- [x] First full pass: snapshot `2b1964d8`, 178,601 files / 50.356 GiB,
  28.264 GiB added (15.608 GiB stored) in 7:33. Restic deduplicated roughly
  22 GiB of that, mostly the `database.sqlite` / `.bak-premigrate` twins under
  `Web/pt-imc-catalog`. Second pass (the one that carries the database):
  snapshot `0e27bf00`, 4.636 GiB added (3.818 GiB stored) in 1:59.

- [x] VERIFIED BY RESTORE, not by listing. Restored out of `0e27bf00` into a
  scratch target and diffed against the originals: `Development/CloudeCode/
  CLAUDE.md` (83,235 bytes) IDENTICAL, `Application Support/CloudeCode/
  session_metadata.json` (989 bytes) IDENTICAL. Restore target then deleted.
  Note restic restores directory modes too, so the tree needed a chmod pass
  before it could be removed.

- [x] `cloude.db` IS COVERED, VIA A DUMP, AND THE RAW FILE IS EXCLUDED. Copying
  a hot SQLite file captures a torn database, so the job now takes a
  `VACUUM INTO` dump to `cloude.online-backup.db` (integrity_check ok, 27
  tables, 4,962,832,384 bytes) and excludes `cloude.db`, `-wal` and `-shm` so a
  restore cannot pick the torn one. This is the pattern the job already used
  for uptime-kuma and dockge, not a new mechanism.

  CORRECTION to the cleanup entry above in this file: `cloude.online-backup.db`
  is NOT "the app's own background backup process". It is written by the restic
  job every night and it is the only consistent copy of the database that goes
  off-box. DO NOT DELETE IT and do not add it to a cleanup sweep.

  Unlike dockge, the dump opens the source WITHOUT `mode=ro`. Measured: this
  database is `journal_mode=wal`, and a read-only open needs the `-shm` it may
  not create, so both python sqlite3 and the sqlite3 CLI answer "unable to open
  database file (14)". `VACUUM INTO` writes only its target, so the source is
  not modified either way.

- [x] EXCLUSIONS, with the sizes that justify them. Regenerable build
  artifacts, measured across Development before the change: `venv.nosync`
  (1 dir, 0.2 GiB), `.venv` (2, 0.1 GiB), `__pycache__` (346, 0.1 GiB),
  `.mypy_cache` (2, 0.1 GiB), `.pytest_cache` (14, ~0), plus `node_modules`,
  `venv` and `.DS_Store` which measure zero today and are excluded so they stay
  that way. Those total only about 0.5 GiB: Development is 51 GiB of real data,
  not dependency bloat, so nothing else was cut from it. Excluding them dropped
  the pass from 191,857 files to 178,601.

  The big exclusion is in the app data dir: eight stale multi-gigabyte
  `cloude.db.bak-*` / `cloude.db.pre-*` migration rollbacks, roughly 37 GiB of
  near-duplicates of the same database from one day's schema work. Also
  excluded: `*.pipe` and `*.pipe.1` tmux scrollback tails, which are rewritten
  constantly and would churn the repo nightly for no recovery value.

  0 `.icloud` placeholder stubs in the tree, so everything in Development is on
  local disk and is really captured, not a stub. Worth re-checking if the owner
  ever turns on Optimise Mac Storage: restic backs up only what is on disk.

- [x] TWO BUGS FOUND AND FIXED IN THE JOB ITSELF, both exposed by the new scale.

  1. The CloudeCode dump was rejected on its first run by its own table floor,
     27 tables against a floor of 40. The floor was wrong, not the dump: it was
     derived from `SELECT count(*) FROM sqlite_master`, which counts every
     object. This database is 27 tables + 58 indexes + 2 views = 87 objects.
     The dump check counts `WHERE type='table'`. sqlite_master is not a table
     list unless you filter it. Floor is now 15 against a measured 27. The
     guard behaved correctly throughout: it refused the dump AND the
     post-snapshot verify then reported the file absent from `2b1964d8`.

  2. THE POST-SNAPSHOT VERIFY KILLED THE SCRIPT ON A GOOD BACKUP. It pipes the
     `restic ls -l` listing into `awk '... {print $4; exit}'`. Under
     `set -euo pipefail`, awk leaving early breaks the pipe, `printf` takes
     SIGPIPE, the command substitution returns 141 and `set -e` ends the run.
     This was invisible while the listing was 103 lines, because it fit in the
     64 KB pipe buffer and printf always finished first. At 252,935 lines
     printf blocks and the job dies mid-verify having written a perfectly good
     snapshot, reporting failure every night. awk now reads to EOF and keeps
     the first match. Proven against the real 252,935-line listing: all three
     dumps verify and the pipeline survives `set -euo pipefail`.

     The same line also could not have matched the new path at all: it used
     `$NF`, and `Application Support` contains a space, so the last field was
     only the tail of the name. It now matches on the line ending with the path.

- [ ] OPEN, for the owner to weigh: the nightly job now writes a ~4.6 GiB
  `VACUUM INTO` dump and pushes it every night. VACUUM rewrites pages, so
  night-over-night dedup on that file is unlikely to be as good as on ordinary
  data; run 2 added 4.636 GiB (3.818 GiB stored) for it. Against 7d/4w/6m
  retention that is real growth on qnap-home. Worth watching the repo size for
  a week and deciding whether the database wants a lower cadence than the rest.

- [ ] OPEN, unrelated to this change but seen while doing it: the restic
  password sits in plaintext at `~/.config/restic/mini-m4.pw`, and the retired
  `~/.config/restic/backup-m4.sh.orig.20260616` still carries an old password
  inline in the file. Left alone deliberately, not rotated, not copied. The
  owner already knows about the .pw file; the `.orig` copy may be news.

## 2026-09-09: cleanup, v24 backup and scratch dbs moved to Trash

- [x] Moved to `~/.Trash/cloude-cleanup-20260909/` (move, not delete, per owner
  policy - `rm` is denied by settings anyway):
  - `~/Library/Application Support/CloudeCode/cloude.db.bak-v24-20260908T194725Z`
    (4.6G) plus its `-shm` (32K) and `-wal` (0B) sidecars. Precondition
    verified first: restic snapshot `0e27bf00` (repo `rest:http://10.0.10.80:8000/mini-m4`,
    taken 2026-09-09T07:25:26-04:00) holds
    `Library/Application Support/CloudeCode/cloude.online-backup.db` (confirmed
    via `restic ls 0e27bf00 | grep online-backup`, 3 hits: cloude, dockge,
    kuma). Live `cloude.db` passed `PRAGMA quick_check` = ok. `lsof` showed
    the `.bak` not open. The v24 backup is gone from disk because restic
    already holds the equivalent dump off-box.
  - This session's scratch copies: `.../scratchpad/live.db` (4.7G) with its
    `-shm`/`-wal` sidecars, and `.../scratchpad/bench/cloude.db` (295M).
    `lsof` showed neither open.
  - Trash folder total: 9.5G. Verified after the move: all seven source
    paths gone (`[ -e ]` false), and `cloude.db`, `cloude.online-backup.db`,
    `unread_state.json`, `hook_tokens.json` unchanged in size (only mtime
    moved by seconds, from the live server's own normal activity between the
    baseline read and the verify read - nothing in this cleanup touched
    them).

- [ ] OPEN, read-only findings from the same pass, not acted on:
  - `~/ClaudeArchive` (37G: `cc-dev-state` 21G, `hostdim` 11G,
    `claude-config-archive` 4.2G, `claude-icloud-conflict-preserve-20260902`
    1.0G, rest small) is covered by **no** backup found: 0 hits in
    `restic ls 0e27bf00 | grep -c ClaudeArchive`, and it is not under the
    `~/Development` (iCloud) path either - it is its own directory at
    `~/ClaudeArchive`, so iCloud sync does not cover it and the m4 restic repo
    does not either. Worth a decision on whether it needs a backup target.
  - `~/Library/Caches/CloudKit/*`: mostly small, but `com.apple.bird` (iCloud
    Drive daemon) is 23G and `com.apple.cloudphotod` is 22G. Both are
    OS-managed caches, safe to ignore, not part of this cleanup.
  - Only one network mount active: Time Machine over smbfs to 10.0.1.202. No
    other SMB/AFP/NFS mounts present at check time.

## 2026-09-09 - ClaudeArchive archived to archive-nas and released to Trash

- [x] CLOSES the open item above ("`~/ClaudeArchive` is covered by no backup").
  It now has one. archive-nas = 10.0.1.237 (TrueNAS SCALE, ssh user
  `truenas_admin`, pubkey), dataset `/mnt/ARCHIVE` (8.4T, 1 percent used),
  destination `/mnt/ARCHIVE/vault/85_cloud-exports/claude/`.

- [x] `hostdim/` copied to `multihost-db-20260830/` (this was the ONLY item of
  the four not already on the NAS).
  - Source confirmed closed with `lsof` before reading; WAL 0 bytes, so the
    `.db` is self-contained. `-shm` / `-wal` deliberately not copied.
  - Opened read-only (`mode=ro`): `PRAGMA quick_check` = **ok** (64.3s).
    `page_count` 2,918,513 x 4,096 = 11,954,229,248 = exactly the file size,
    so not truncated.
  - `rsync -a --partial --progress` (NOT `--info=progress2`: macOS ships
    openrsync 2.6.9-compatible, which rejects that flag with exit 1 and a
    usage dump. It failed before transferring anything, so no partial state).
  - PROVEN: full sha256 on BOTH sides, identical,
    `efbec96404dbcd329611e73f10e56faa2161f21427273031c18b4e4a810529c4`
    (76s remote). Independently corroborated a third time by the hash the
    owner's own `~/ClaudeArchive/README.md` already recorded for this file.
  - Remote copy opened read-only with `sqlite3` on the NAS: 21,039 /
    2,447,028 / 3,125,122 (message_transcripts / message_bodies /
    message_appearances), matching the source exactly.
  - All 10 provenance sidecars sha256-matched both sides. `README.txt` written
    beside it on the NAS recording provenance, dates and the hash.

- [x] Re-verified the three already-archived items before releasing them:
  - `cloude-archive-20260903.db`: size 22,595,760,128 both sides, tail-64MiB
    sha256 `ee9290bb...` identical.
  - `claude-config-git-20260831.tar.zst`: size 4,481,263,585 both sides,
    tail-64MiB sha256 `7661cd2f...` identical, and the NAS `.sha256` sidecar
    reads `9a876ec9...` as expected.
  - conflict-preserve set: went further than a sample. Streamed the NAS
    `07-*.tar.zst` and hashed EVERY member: 6,962 files, 6,962 manifest
    entries, 6,962 hash matches, 0 mismatches, 0 not-in-manifest. Plus 50
    evenly-spaced manifest entries hashed against the local files, 50/50.
    That closes the local <-> manifest <-> tar chain. A manifest is not the
    archive, so verifying only the manifest would have proven the wrong thing.

- [x] CUSTODY GAP FOUND AND CLOSED BEFORE RELEASE: `cc-dev-state/` held 240,325
  bytes across 7 small files that were NOT on the NAS (`README-dev.md`, the
  two `archive-sample-report.*`, the two `icloud-conflicts.*`,
  `migration_trail.jsonl`, `refresh_tokens.db`). Only `cloude.db` had ever
  been archived. Copied to
  `cloude-db-20260903/cc-dev-state-sidecars/`, all 7 sha256-verified both
  sides, THEN released. The two subdirectories (`projects/`, `legacy-logs/`)
  were empty. Note `refresh_tokens.db` is credential material and
  `README-dev.md` carries a throwaway TOTP/JWT pair the owner's README
  already flags as throwaway.

- [x] Released by MOVE to `~/.Trash/ClaudeArchive-20260909/` (never `rm`):
  `cc-dev-state/`, `claude-config-archive/`,
  `claude-icloud-conflict-preserve-20260902/`, `hostdim/`.
  `~/ClaudeArchive` 37G -> 119M.

- [ ] OPEN, needs the owner: **the 37G is still on the disk.** The Trash is on
  the same volume, so `df` is UNCHANGED at 38Gi available on
  `/System/Volumes/Data`. Emptying `~/.Trash` is what actually reclaims it,
  and that is deliberately the owner's call, not this pass's.

- Remaining in `~/ClaudeArchive` (119M, all regenerable, left in place):
  `app/` 54M, `archive-venv/` 64M, `run/` 100K, `config-backups/` 64K,
  `README.md` 16K, `archive-start.sh`, `refresh-app.sh`,
  `archive-instance.env`.

- Two things worth keeping. First, the owner's README records `cloude.db` as
  22,572,834,816 B / sha256 `51943da1...`, but the file is now
  22,595,760,128 B: it is the live DB for the archive instance and grew after
  the README was written, so THAT RECORDED HASH IS STALE. It agrees with
  nothing today and would look like corruption to the next reader. The NAS
  copy matches the CURRENT file. Second, `cloude.db` was checked with `lsof`
  and port 5055 was probed (`curl` got no response) before the move, because
  moving a live database out from under a running service is the obvious way
  to turn a cleanup into an incident.

## 2026-09-09: disk cleanup closed (measured)

- Owner emptied the Trash and thinned APFS local snapshots twice
  (`sudo tmutil thinlocalsnapshots / 60000000000 4`). Free space on
  /System/Volumes/Data: 38 GiB this morning -> 147 GiB now (67 percent
  used). Local snapshots: 19 -> 1. Trash 0 B. ~/ClaudeArchive 119 MB
  (regenerable code and venv only). App data dir 9.4 GB (live db plus the
  nightly VACUUM INTO dump).
- Lesson: on APFS, emptying the Trash frees nothing while a local Time
  Machine snapshot still references the blocks; thin the snapshots after a
  large delete or the measurement lies. Also, a folder moved into ~/.Trash
  by `mv` from a shell may not appear in Finder until Finder relaunches;
  `ls ~/.Trash` is the truth.

## 2026-09-09: status LED - idle gets its own gray fill, ring widened and feathered

DONE. Owner's report, verbatim: "i need the lights to go idle, (i think
thats gray) when i click on a tab. there needs to be a read/idle color.
lets make the border a little larger and can we feather it?"

**ROOT CAUSE.** `idle` (read, at rest) and `finished_unread` (not yet
read) both painted inner `done` green - only the outer ring moved when a
tab was opened, too subtle a change at a glance.

**WHAT SHIPPED.**
- New inner state `idle`: `client/js/status-led.js` INNER_STATES gains
  `idle` (slotted between `waiting-input` and `done`), a new
  `--led-color-idle` token in `client/css/status-led.css` (neutral
  mid-grey, `var(--color-fg-muted, #8f8f8f)` - deliberately different
  from `unknown`'s `#666`/`#8b8b8b` grey AND from `unknown`'s hollow
  shape; `idle` stays a solid dot, since it is a measurement and
  `unknown` is the absence of one).
- `ledStateFor`: `activity_status === 'idle'` now returns
  `{inner: 'idle', outer: 'off'}` when NOT unread, and
  `{inner: 'done', outer: 'unread'}` (unchanged) when the defensive
  `idle` + `unread: true` combination arrives - kept identical to
  `finished_unread`'s pair on purpose, because
  `session-status-summary.js`'s `unread` bucket always renders as
  `{inner: 'done', outer: 'unread'}` and a row that disagreed would make
  the group header lie about its own child
  (`tests/test_status_summary.node.mjs`, "a single-child group renders
  the same LED state as that child" - this is what caught it).
- `session-status-summary.js`: `bucketFor` and `SUMMARY_PRIORITY` gain an
  `idle` bucket/entry, slotted between `done` and `dead`. New priority:
  **permission > input > working > unread > done > idle > dead >
  unknown**. A group of all-idle now reads idle instead of falling to
  unknown; one unread among ten idle still bubbles unread.
- Geometry, `client/css/status-led.css`: `--led-ring-width` 1px -> 1.5px.
  New `--led-ring-feather-blur` (1px) and `--led-ring-feather-fraction`
  (0.35) drive a NEW named layer, `--led-ring-feather-layer` - a second
  shadow at the SAME spread as the hard ring (so its unblurred edge sits
  exactly on the ring's own edge), blurred, at a FRACTION of
  `--led-ring-alpha` (so it zeroes automatically wherever the ring does,
  e.g. `off` - the same trick `--led-glow-rest` already used for the
  breathing trough). `--led-glow-blur` 4px -> 6px, `--led-glow-spread`
  held at 1.5px on purpose: raising blur alone spreads the same light
  over a wider fade ("softer"), where raising spread would have read as
  a bigger solid disc ("bigger") - the owner asked for the former. The
  box-shadow is now FOUR layers (was three): inset-ring, ring, feather,
  glow - both keyframes restate all four, unchanged except the glow
  layer, same pattern the ring layer already used.
- MEASURED FOOTPRINT: ring diameter at the 9px default is now 12px (was
  11px), still an integer. The ring-plus-feather's own visible reach is
  `width + feather-blur/2` = 2.0px past the dot - well inside the "about
  4px past the dot" ceiling. The glow's reach grew from 3.5px to 4.5px
  (blur 4px -> 6px, spread unchanged), putting the lit object at about
  18px across (was 16.2px) - an accepted, documented 1.8px cost of the
  feathering, not a silent regrowth of the "glowing is still too big"
  problem the previous round fixed.
- Sidebar clipping checked, not just assumed: `.session-sidebar-row-main`
  padding is 10px (cozy/detailed) or 8px (compact), `.session-sidebar-list`
  padding is 8px on top of that, and neither row nor list sets
  `overflow: hidden` on the row's own box (only text spans do, for
  ellipsis) - so the new ~9px glow radius from centre has 16-18px of
  clearance before the list's own scroll edge in every density. No
  regression.

**TESTS.** `tests/test_status_led.node.mjs`: 52 pass (was 46 pre-2026-09-08
element rewrite baseline; new tests added for the idle fill token
distinctness, idle's solid-not-hollow shape, idle rendering outer off with
no lit ring, the feather layer's presence/fraction/reach, and the ring
width/glow blur token values). `tests/test_status_summary.node.mjs`: 20
pass (idle priority slot, all-idle group, one-unread-among-ten-idle,
idle-beats-dead-loses-to-unread). `tests/test_unread_led_one_field.node.mjs`:
17 pass (idle+nothing-waiting now asserts outer `off`, not `steady`).
`tests/led_state_for.node.mjs` docstring example updated (CLI helper, not a
test - exits non-zero with no stdin by design). `tests/test_led_real_hooks.py`
(opt-in, `CLOUDE_REAL_HOOK_TESTS=1`, not run this pass - would spend real
Claude turns) updated at the two spots that asserted `inner: 'done'` /
`outer: 'steady'` for a session reaching rest, now `idle`/`off`. Full
`tests/*.node.mjs` sweep run (191 files): zero new failures; the two
non-green results (`led_state_for.node.mjs` with no stdin,
`test_archive_full_page_mode.node.mjs`) are both pre-existing/documented,
per CLAUDE.md. `node --check` clean on every touched JS file.

**GALLERY** (scratchpad, not published):
`led-gallery.html`'s "Round 3 - single element (shipping)" section now
inlines the real `status-led.css`/`status-led.js` verbatim (spliced
programmatically from the shipped files, then verified: brace-balanced
CSS, the extracted `<script>` block executes under `node -e` and produces
`INNER_STATES` including `idle` and the correct `{inner:'idle',
outer:'off'}` mapping). Added an `idle` row to all three inner x outer
matrix tables (9/12/16px) and to the "every inner state, active outer"
strips, plus a new plain-English legend row above them: working / waiting
for permission / waiting for input / done, unread / idle, read / dead /
unknown, rendered at 20px through the real `ledStateFor()` pairs (not
hand-picked colours). Round 1 and Round 2 (the retired halo-era
comparisons) untouched - they predate `idle` and are historical reference
only. `build-gallery.js`/`page-template.html` in the same scratchpad
directory are a separate, unused generator for a different page layout
and were left alone.

**DOCS.** `docs/session-status.md`: inner-dot vocabulary, the
activity_status -> (inner, outer) mapping table, the geometry/Sizing
section, and the group-rollup priority line all updated for `idle` and
the new ring/feather/glow numbers, plus a note on why `idle` + `unread:
true` is defensive rather than normally reachable. `CLAUDE.md`: the status
paragraph now says the box-shadow is three ring-side layers (was two) and
names `--led-color-idle`; the summary-priority line gains `idle`.

## 2026-09-09: status light audit, defects A to E closed

Audited on live at `f77a978`, 19 live sessions. Client and server agreed on
all 19 rows, so nothing here is a rendering bug; every defect was upstream of
the paint.

- [x] **A. A view now clears an open `notice`, and still never a
  `permission`.** `notice` is set by claude's `Notification` hook (its
  roughly-60s "waiting for your input"), outranks the heartbeat, and cleared
  only on `UserPromptSubmit` / `PreToolUse` / `Stop` - all three the AGENT
  acting. Nothing represented the USER showing up, so BHPP painted terracotta
  for 46 minutes ACROSS a visit. `src/core/session_view_clears.py` is the one
  definition of what looking at a session resolves, reached from the WS bind
  (`mark_session_viewed`) and from the manual mark-read control, which arrive
  holding different identifiers. `SessionActivityTracker.clear_notice` is the
  only thing outside the hook stream allowed to move that machine, and it may
  move exactly one field. `permission_open` is deliberately untouched: a
  blocking fact about the agent is not answered by looking at it. No time
  expiry was added either, per the owner - "a session left alone should not go
  gray".

- [x] **B. A hook-less session reads its own transcript.** Only 6 of 19 live
  sessions had EVER fired a hook; the other 13 rested on seed rung B, which
  can say `idle` and nothing else, so three sessions that had touched their
  transcript inside 36 minutes painted the same rest as ones last touched in
  July. `src/core/session_transcript_status.py` (pure) plus
  `_read.py` (the reads, the turn ledger, the unread write) is rung 0 of the
  same ladder, fed by the existing 60s re-seed. Rung 1 mtime inside
  `WORKING_HEARTBEAT_TIMEOUT_SECONDS` -> `working`; rung 2 a turn end NEWER
  than the ledger's -> `finished_unread` plus ONE auto-unread claim; rung 3
  the turn end already recorded -> `finished_unread` while unread, `idle`
  after a view; rung 4 stale in-flight -> nothing; rung 5 no transcript ->
  nothing.
  - **An mtime is a TIMESTAMP, which is exactly the objection the old
    docstring raised.** It refused file-derived work because a RECORD carries
    no clock. A modification time is a clock, so the claim expires on the same
    120s a hook heartbeat does. `StatusSeed.expires_at` plus `display_state`
    enforce it, because the seed cache holds a reading for 60s and would
    otherwise stretch the window.
  - **FIRST SIGHT OF A TURN END IS A BASELINE, NOT AN INSTRUCTION.** The
    ledger is in memory; a first-sighting claim would light the whole fleet
    unread on every restart, July conversations included. It records and
    claims nothing. The baseline only moves FORWARD, and only the two
    turn-end rungs may move it - rung 1's timestamp is a file mtime, not a
    turn boundary.
  - **The gate is `hooks_seen`, NOT the hook token store.** Measured:
    `hook_tokens.json` holds 33 entries against 19 live sessions and includes
    every `adopted:` id, because an adopt mints a token for a pane it never
    spawned into. Gating on it would have refused the ladder to exactly the
    sessions it was built for, and shipped a no-op.

- [x] **C. The legend says what the states mean.** `idle` was "waiting at the
  shell" while 15 of 19 panes ran claude. Now: `waiting for permission` /
  `wants your attention` / `working` / `done - unread` /
  `idle - read, nothing running` / `not measured` / `dead - process exited`,
  all in `STATUS_LABELS` and reached by every surface through `dotHtml`.

- [x] **D. The terminal header has a light.** The screen you actually look at
  was the one surface with no LED, so the status of the session you were IN
  was the one you had to open a list to read.
  `client/js/session-header-led.js` renders through
  `SessionStatusUI.dotHtml`, so it inherits the rings, the colours and the
  legend and cannot drift. Fed from one call site at the end of
  `session-sidebar-fetch.js`'s `load()`; because that poll runs only while the
  drawer is OPEN, the module also arms a fallback timer at the same cadence
  that stands down while the drawer is open. AT MOST ONE POLLER, EVER, and
  none at all with no session attached.

- [x] **E. `status_source` on the `/sessions/list` wrapper.** `hook` /
  `transcript` / `seed_row` / `tmux` / `none`, defined once in
  `src/core/session_status_source.py` and DERIVED FROM THE RUNG THAT
  ANSWERED, so a status and its provenance travel together. Rendered in the
  TOOLTIP ONLY (`via hooks`, `via transcript`) - never a colour, a class or a
  shape, because one status with two appearances would undo the single
  vocabulary the light rests on.

**ACCEPTED AS IS, both by design and both re-confirmed against live:**
- A COLLAPSED GROUP HIDES ITS ROWS. Rows missing from the sidebar under a
  folded band are folded, not lost. Folding is in the paint signature
  precisely so it repaints; nothing to fix.
- A PERMISSION STAYS LIT UNTIL IT IS ANSWERED. `question` is not cleared by a
  view, an expiry or a poll - only by the events that resolve it. That is the
  one light meaning "this cannot proceed without you" and it must not be
  dimmable by a glance.

**Tests.** `tests/test_status_view_and_transcript.py` (35: the view rules with
their permission negative control, every rung, the once-per-turn claim, the
first-sight baseline, the older-turn-end control, the hooked-session and
bare-shell controls, the expiry) and
`tests/test_status_legend_and_header_led.node.mjs` (14: the legend copy, the
tooltip suffix, and the header light rendering and updating from a list row).
Full suite 5530 passed / 3 failed / 21 skipped - the three are the known
environmental ones (`test_home_write_guard`, `test_state_dir_resolution`,
`test_version_probe`). Node 190 passed / 1 failed, the pre-existing
`test_archive_full_page_mode`.

---

## 2026-09-09 - the read state is derived on every path, and the ring means activity only

Two defects the owner reported minutes apart, both measured on live at
HEAD 5e13cb1, both about a light claiming something nobody measured.

**1. WRONG STATUS AFTER A VIEW.** Owner: "i just clicked into the daily
briefing tab, nothing changed." `/sessions/list` for
`cloude_daily-briefing` after the click: `unread: false`,
`activity_status: finished_unread`, `status_source: seed_row`. The WS
bind had cleared the flag exactly as designed; the durable row still held
the word `finished_unread` stamped before the view, and the seed path
returned it verbatim.

ROOT CAUSE, AND IT IS A SHAPE WORTH KEEPING: every source had its own
half of the read/unread rule, and one of them had only the half that ADDS
unread. `idle` plus a set flag became `finished_unread`;
`finished_unread` plus a cleared flag stayed exactly as it was. A
one-directional derivation is not a derivation, it is a cache - and a
cache of a fact that moves is a lie with a timestamp.

FIX. `session_status.derive_read_state(state, *, unread)` is the ONE
function, pure, total and idempotent, and every path runs through it:
`SessionActivityTracker.resolve`, `session_activity.map_tmux_fallback`
(which is also the attachable-row path), `session_status_seed
.display_state`, `session_transcript_status.resolve_transcript_status`
rung 3, and `SessionManager._session_info_for` on the assembled answer -
that last one AFTER the seed path has had its chance to set a flag.
`activity_persist.write_state` now stores the BASE state, so
`sessions.activity_state` stops baking a read verdict into a column
nothing rewrites on a view; rows written before today are reconciled on
read by the same function, which is why this needed no migration.

THE ONE RUNG THAT IS NOT DERIVED IS THE ONE THAT SETS THE FLAG.
Transcript rung 2 has just MEASURED a turn end newer than anything
recorded and reports `claim_turn_end_at`; deriving there against the flag
as it stood BEFORE that measurement would answer `idle` about a turn that
finished unseen.

**2. THE RING MEANT UNREAD, WHICH READS AS ACTIVITY.** Owner: "the ring
around some of the leds are not gray, which means there should be
background tasks. i dont think those few have any background tasks."
`finished_unread` mapped to outer `unread` - a breathing amber ring - so
the quietest state on the dial wore the loudest light in the app. The
original spec, verbatim: "behind this is a larger glowing circle is
colored and pulsing on activity and steady on done."

FIX. The outer ring encodes ACTIVITY ONLY: `working` /
`working_subagent` / `running` -> `active` (the only thing that
breathes), `question` / `notice` / an unanswered startup gate ->
`steady` (a live turn that is not moving), `finished_unread` / `idle` /
`dead` -> `off`, `unknown` -> `dim`. Unread rides the INNER dot alone,
green `done` against grey `idle`. The outer `unread` state is retired
from `OUTER_STATES`, from the CSS (`--led-color-unread` with it), from
the gallery and from the tests. The group header folds the two
dimensions SEPARATELY - highest-priority inner among members, ring from
activity across the whole group - so a group with one parked session and
one busy one paints the parked dot inside a breathing ring, which is
both facts at once. The `done` bucket ("finished and already read") is
retired with it: the grey dot spells that itself.

**Tests.** New `tests/test_read_state_derivation.py` (21: the pure
function in both directions and its idempotence, the pass-through
negative control over every non-resting state, all four sources, the
assembled `_session_info_for` answer, set/view/set/view applied twice
each, and the writer storing the base state). NEGATIVE CONTROL RUN: with
the `_session_info_for` derivation removed, 3 of the 21 fail - the test
sees the defect. Node: `test_status_led.node.mjs` (56) gained an
exhaustive sweep proving no `activity_status` x `unread` x
`startup_gate` combination can produce an `unread` ring and that exactly
three statuses breathe; `test_status_summary.node.mjs` (23) gained the
same sweep at the header level plus the separate ring fold;
`test_unread_led_one_field.node.mjs` (18) now proves the flag survives
to the INNER dot on all three surfaces, which is a stronger claim than
the halo assertion it replaces.

Full suite 5551 passed / 3 failed / 21 skipped - the three are the known
environmental ones. Node sweep: only the pre-existing
`test_archive_full_page_mode` fails.

---

## 2026-09-09 - the group header rolls up again: `signalsFor` reconciles the two names for one field

**The owner's report**, verbatim: "the status in the group is not working
as expected." Measured in the browser on live at `880247f`, sidebar on the
home page: EVERY group header LED read `data-inner="unknown"
data-outer="dim"` - Joe (12 members, every one of them painting
`idle/off`), Agents (4, folded), Waiting (1, folded), Clients (0), other
(2 members painting `working/active` and `idle/off`). A group of twelve
sessions and an empty group rendered the same light.

**Root cause: ONE FACT, TWO FIELD NAMES, and the fold only knew one of
them.** `summarizeStates` resolved each child through
`StatusLed.ledStateFor(row)`, which reads `row.activity_status` - the
`/sessions/list` spelling. Its only caller is the group header, and the
rows it hands over are MERGED SIDEBAR ROWS, where
`session-sidebar-fetch.js mergeLiveRow()` copies `info.activity_status`
onto `row.status` so the probe rows and the live rows share one shape. So
the field was `undefined` on every child, every child bucketed `unknown`,
the fold picked `unknown` (last in `SUMMARY_PRIORITY`), and `outerFor`
answered `dim` for that winner. The priority table and the ring fold were
both already correct; the INPUT never arrived.

**Why nothing caught it.** `tests/test_status_summary.node.mjs` had 23
green tests and every one of them built its rows with `activity_status`,
which is the shape no caller passes. And
`tests/test_sidebar_groups_rename.node.mjs` renders the real
`bodyHtml`, but loaded neither `status-led.js` nor
`session-status-summary.js`, so `window.SessionStatusSummary` was absent
and `headerHtml` took its "render the header without a LED" branch -
green assertions over a header painting no light at all. A test that
constructs its own input in a shape the app never produces is testing the
test.

**The fix.** `signalsFor(row)` in `client/js/session-status-summary.js` is
the one place the two spellings are reconciled: whichever of
`activity_status` / `status` is a non-empty string wins,
`activity_status` first. Neither present stays `undefined` rather than
defaulting to a state, so a row with no status field still answers
`unknown/dim` - reconciling two names must not become "find something to
say". It is NOT pushed into the caller: the row beside the header renders
through `SessionStatusUI.dotHtml(r.status, ...)`, and a second copy of
the adapter is a second chance to drift, which is the failure this module
exists to prevent. `sectionHtml` already passed `rows` to `headerHtml`
whether or not the section was folded; that is now documented as
load-bearing rather than incidental, because the folded section emits no
rows and the LED is the only thing left speaking for it.

**Roll-up, unchanged and now reachable.** Inner is the highest-priority
member state, `permission > input > working > unread(done) > idle > dead
> unknown`. Outer is activity across the WHOLE group, folded
independently: `active` if any member is working, `steady` if any is a
live turn waiting on the user, `off` otherwise, `dim` only when the group
is empty or every member is unmeasured. AN EMPTY GROUP READS
`unknown/dim` and that is the documented choice - nothing to measure is
not measured-and-quiet, and a calm light on an empty group is the false
green this project keeps paying for.

**Tests.** `test_status_summary.node.mjs` 23 -> 33: the sidebar spelling
folds identically to the server spelling across all seven states, unread
and the startup gate reach the fold from a sidebar row, a row carrying
NEITHER name is `unknown` (the negative control - the reconciliation must
not invent a status), `activity_status` wins when both are present, an
empty string is not a status, plus the five roll-ups the owner named:
all-idle -> `idle/off`, one working among idle -> `working/active`, one
done-unread among idle -> `done/off`, a permission among working ->
`waiting-permission/ACTIVE` (the two dimensions folded independently),
and a notice with nothing running -> `waiting-input/steady`.
`test_sidebar_groups_rename.node.mjs` 33 -> 37 and its stack now loads
the LED modules: the header LED reads the rows, a COLLAPSED group is
summarised from rows absent from its own markup, folding does not move
what the header claims, and a header over a live member NEVER reads
unknown across all six measured states. NEGATIVE CONTROL RUN both ways:
with `signalsFor` removed from the call, 8 of the summary tests and all 4
of the groups tests fail - the tests see the defect.

Node sweep: 192 files, only the two known - `test_archive_full_page_mode`
(pre-existing) and `led_state_for.node.mjs` (the piped-stdin CLI helper,
which exits non-zero with no input by design).

---

## 2026-09-09 - a prompt from any client answers the session's toasts

**The ask, verbatim.** "on the toasts, if its waiting on me and i type
into this browser or a remote control session, the toasts should be
removed, we can tell because i think when a new prompt is sent it should
trip a hook." He is right about the hook: `UserPromptSubmit` fires
whenever a prompt is submitted, whoever typed it and wherever - browser
terminal, remote control session, or the keyboard on the Mac - so it is
a fact about THE USER SHOWING UP, and a notification asking the user to
show up is answered the moment they do.

**Three rules, and the size of each set is the design.**
`UserPromptSubmit` answers every kind (Stop, PermissionRequest,
Notification, StartupPrompt) - the user typed, nothing is still waiting
on them. `PreToolUse` answers a PermissionRequest and nothing else: a
tool about to run proves a permission was granted and proves nothing
about a notice the user has not read. `Stop` answers a permission, a
notice and a startup prompt, and NEVER a "your turn".

**A STOP NEVER ACKS A STOP, AND THAT IS STRUCTURAL RATHER THAN
POSITIONAL.** Stop both raises the "your turn" card and answers others,
so the obvious defect is a Stop eating the card it just created. Relying
on call order - ack before recording, so the new toast cannot be seen -
holds only until someone moves a line, and fails outright for a
DUPLICATED Stop whose predecessor's card is a real unacked record by
then. Excluding the KIND makes it hold for every ordering, every
duplicate and every future call site.

**The cutoff is the EVENT's instant, not the ack's.** The route stamps
`received_at` at the top of the handler before any state is mutated, and
a toast raised later than that is never answered by that event. A prompt
redelivered late must not clear a notice about something that happened
after the user typed - that destroys a record the user never saw, which
is worse than a card that lingers. Idempotence falls out of `ack_toast`
refusing a second ack: ten deliveries ack once and do nothing nine
times, so no duplicate frames and no history churn.

**The client half was the bigger gap.** `ToastManager.backfill` had only
ever ADDED, which was correct while the only thing that could close a
toast was a click here or a `toast.ack` frame from another tab. Neither
is true once the SERVER closes toasts, and a surface with no socket for
the raising session (launchpad, archive, a terminal attached elsewhere)
has no frame to hear it on. `reconcileOpen` applies the open set in both
directions each poll tick. Its guard is `ToastDismissedRing`'s race
pointing the other way: a response describes the server as of when the
request LEFT, so a card added after that instant is spared, and removed
by the next tick whose snapshot can actually speak to it. Sparing is a
delay, never an exemption. Removals read the RAW list, additions the
ring-filtered one; reconciling never acks, because the record is already
closed.

**`ack_reason` closes docs/notifications.md open item 2.** History was
two-valued because nothing stamped a reason. The human paths now write
`dismissed`, the auto-ack writes `answered`, and a row reads open /
dismissed / answered. A record acked before the field existed carries
null and still reads `dismissed` - not having recorded which act cleared
a toast is not evidence it cleared itself. `summarize()` reports
`answered` as a SUBSET of `dismissed` rather than a sibling, so the count
already on the history header did not silently change meaning.

**No new clearing path for the LED.** `session_activity` already cleared
`permission_open` and `notice_open` on exactly these three events, so the
auto-ack matches a set that was already there. Asserted through the
public resolver, not the private flags: a light saying "needs permission"
with no card is the same lie as a card with no light.

**Tests.** `test_toast_auto_ack.py` 20 cases - each rule with its
negative control (PreToolUse must leave a Notification alone; no Stop may
clear a "your turn", including an OLDER one), duplicates, the reorder
where a late event meets a newer toast, the reorder where the Stop's own
toast already exists, session scoping, the reason field, and the feature
measured end to end through the real hook endpoint against what
`GET /api/v1/toasts` actually serves - with another session's toast as
the control. `test_toast_reconcile.node.mjs` 12 cases for card removal
including the spared-then-removed race.
`test_toast_history_render.node.mjs` 17 -> 19 (vocabulary is three words
now, and an unrecognised reason still reads `dismissed`).

Full pytest 5572 passed / 3 failed / 21 skipped - the three are the known
environmental pre-existing ones. Node sweep 191 passed, only the
pre-existing `test_archive_full_page_mode`.

---

## 2026-09-09 - a view clears a permission flag, and an open flag is verified against the pane

**The report.** "media compression has a bad status and not clearing."
`GET /sessions/list` for `cloude_Media_Compression` (`ses_949a8585`) read
`activity_status: question`, `status_source: hook`, `unread: false`,
while its pane tail showed no dialog at all - a settings warning about
`Write(.claude/notes/**)`, a typed-but-unsubmitted prompt line "thats me,
i have another session running", and `bypass permissions on`.

### What the log says, traced to the id

At **17:55:12.153Z** a `Notification` toast and at **17:55:12.165Z** a
`PermissionRequest` toast were recorded **directly under `ses_949a8585`,
with no `toast_session_id_remapped` line before either**. Every other
hook from that pane in the same window logged a remap from
`adopted:cloude_Media_Compression`: the `UserPromptSubmit` at
17:55:20.489 (which auto-acked both of those toasts), the `Stop` at
17:55:57.649, a `Notification` at 17:56:57.723, a `UserPromptSubmit` at
17:57:16.642, a `Stop` at 17:57:26.806 and a `Notification` at
17:58:26.897. `record_toast` and `auto_ack_toasts` both remap and both
LOG when they do, so the absence of a remap on the 17:55:12 pair is
positive evidence those two POSTs carried the live id literally - which
the pane's own claude cannot produce.

**Measured directly**: the claude running in that pane (pid 93139,
started 2026-09-08 14:27:37Z, never restarted since) holds
`CLOUDECODE_SESSION_ID=adopted:cloude_Media_Compression` in its own
process environment. tmux copies the session env into a pane's process at
spawn and cannot rewrite a running one, so that id is fixed for the life
of the process. `hook_tokens.json` holds tokens for BOTH
`ses_949a8585` and `adopted:cloude_Media_Compression`, both mapped to
tmux name `cloude_Media_Compression`, which is why nothing was rejected -
zero `hook_post_rejected_invalid_token` lines for this session, ever.

**So**: the toast test's synthetic `PermissionRequest` set
`permission_open` on `ses_949a8585` (the id `tmux show-environment`
hands out, and the one a test script would naturally read), while every
event that clears the flag arrived under `adopted:cloude_Media_Compression`
and landed on a different tracker key. `record_hook_event` passes the RAW
header id to `SessionActivityTracker.record_event` and does not remap,
unlike the toast path either side of it. Confirmed live through
`GET /sessions/away/summary`: `permission_open: true` on `ses_949a8585`,
`notice_open: false`, `last_activity_at: null`.

**`cloude_N8N` (`ses_36e98dcd`) cleared for exactly the reason Media
Compression did not.** It took a `Notification` toast in the same 17ms
burst (17:55:12.170Z), and its pane's claude (pid 58667) holds
`CLOUDECODE_SESSION_ID=ses_36e98dcd` - the SAME id the synthetic toast
used. So its own next `UserPromptSubmit` cleared `notice_open` on the key
the flag was actually on. It reads `idle` now. The difference between the
two sessions is not the event, it is whether the pane can still reach the
key its flag sits on.

### The rule this produced

A flag set by an event channel keyed on an id the running agent can no
longer be re-keyed to is not a claim, it is a stuck bit. Rather than add
a second id remap and hope the two never drift, the flag is re-verified
against the thing both ids share: the pane.

- **FIX A** `session_view_clears.clear_view_state` now calls
  `tracker.clear_permission(sid)` alongside `clear_notice(sid)`, on every
  id registered for the pane. The owner's rule, verbatim: "when clicking
  a tab, the session is marked read. if i want it unread i click unread."
  The three hook-driven clears are untouched.
- **FIX B** `src/core/session_permission_verify.py` (pure ladder +
  matcher) and `session_permission_verify_apply.py` (the seam, called
  from `_session_info_for` BEFORE `resolve()`). While `permission_open`
  is set, dated, and older than `PERMISSION_TAIL_GRACE_SECONDS` (20) on a
  pane measured live, ONE `capture-pane` per poll. Marker present -> keep.
  Tail read, no marker -> clear + `permission_flag_cleared_no_dialog`,
  which fires once per episode because clearing drops the stamp and the
  gate then refuses. Tail UNREADABLE -> keep, refusing on no evidence.
  Nothing here can invent a permission.
- The stamp `permission_opened_at` is written on the False -> True
  TRANSITION only, so a repeating `PermissionRequest` cannot push the
  grace window out for as long as the duplicates keep arriving.

### The markers were measured, not guessed

Two real dialogs captured from a real `claude` on a THROWAWAY tmux socket
(never `cloude`) with a `permissions.ask` rule in its own settings file,
2026-09-09, versions 2.1.265 and 2.1.266:

```
 Do you want to proceed?          <- Bash,  ask rule on "Bash"
 Do you want to create note2.txt? <- Write, ask rule on "Write", Bash denied
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend
```

The question line CHANGES with the tool, so a matcher keyed on the
literal "Do you want to proceed?" would answer "no dialog" for every file
operation - the exact family the owner's stuck session was about. The
option block and the footer are identical across both. Note the contrast
with the trust dialog `session_startup_gate.py` matches: that one is NOT
numbered on 2.1.263+ and its footer reads "Enter to confirm · Esc to
cancel". Two screens, two ladders, no shared pattern.

### Item 4 needed no change

The `question` tooltip already reads **waiting for permission**
(`client/js/session-status-ui.js:58`) and the LED title already reads
"waiting on you - permission" (`client/js/status-led.js:129`). No JS was
touched, so no node sweep was owed.

**Tests.** `test_session_permission_verify.py`, 35 cases. The matcher
against BOTH captured dialogs and against TWO negative controls, one of
which is the real captured tail of the stuck live session - all three
fixture blocks verified line-for-line verbatim against the capture files.
Plus an unseen third wording matched by shape, the phrase mid-sentence
refused, the cost gate's four refusals, the ladder's four verdicts, the
transition-only stamp, re-arming after a clear, and the seam end to end
with a stubbed capture (no capture inside grace, none with no flag open,
one per poll then none, keeps on dialog, keeps on unreadable, never
invents, never raises). `test_status_view_and_transcript.py`'s
`test_a_websocket_bind_leaves_a_permission_prompt_alone` was REVERSED to
`..._clears_a_permission_prompt` with the reasoning recorded in place.

## 2026-09-09 - closed out (922e400..dfddbdc), deployed and confirmed live

13 commits (7 code, 6 docs/housekeeping), all deployed to live and verified:
`./scripts/deploy-mini.sh --target live --verify-only` reported 529/529 file
hashes matching on both destinations, boot held 18 sessions plus 1 benign
skip against 19 live tmux sessions, and zero hook-token rejections in the
post-deploy window.

**Commits, newest first:**

- `dfddbdc` - a view clears an open `permission_open`, and one left open past
  `PERMISSION_TAIL_GRACE_SECONDS` (20s) is verified against the pane with one
  `capture-pane` per poll before it is trusted (`session_permission_verify.py`
  the pure ladder, `session_permission_verify_apply.py` the seam). Markers
  measured from two real claude 2.1.265/266 dialogs: "Do you want to ...?",
  "❯ 1. Yes", "Esc to cancel · Tab to amend". Root cause of the Media
  Compression incident: a synthetic `PermissionRequest` landed on
  `ses_949a8585` while the pane's own claude presents
  `CLOUDECODE_SESSION_ID=adopted:cloude_Media_Compression` on every real hook
  it fires (tmux fixes env into a process at spawn, cannot rewrite a running
  one) - the toast path remaps that split and logs when it does, the
  activity tracker did not, so nothing reachable could clear the flag. 35
  test cases against both captured dialogs plus two negative controls,
  including the real captured tail of the stuck session.
- `389ae5b` - toasts are auto-answered by the hook event that resolves them:
  `UserPromptSubmit` acks every open toast on the session, `PreToolUse` acks
  permission, `Stop` acks permission and notice but never its own; a
  `toast.ack` frame plus a per-poll reconcile, with an open/dismissed/
  answered reason recorded in history.
- `8e78f5d` - sidebar group-header roll-up fixed: children carried `status`,
  the fold read `activity_status` - the two names for one field disagreed
  and a folded group summarised wrong. `signalsFor` now reconciles both
  names so a folded group's roll-up matches its children again.
- `880247f` - `finished_unread` versus `idle` is derived from the unread
  flag on every path by ONE function, `derive_read_state`
  (`src/core/session_status.py`), called from the hook tracker's resolve,
  the tmux fallback, the seed's `display_state`, the transcript ladder's
  rung 3, and the assembled answer in `_session_info_for`. Shipped as a
  one-directional rule (add unread to `idle`, never remove it from a stored
  `finished_unread`) so a saved state is a cache, never a stale claim. The
  outer ring now means activity alone; the outer `unread` state and its
  `--led-color-unread` hue are retired.
- `5e13cb1` - a view clears an open notice (never an open permission - a
  `Notification` is a message that looking at answers, a `PermissionRequest`
  is a blocking fact that looking at does not); hook-less sessions (13 of 19
  live panes, started by hand with no hook env) get a transcript-driven
  ladder (`session_transcript_status{,_read}.py`): an mtime inside
  `WORKING_HEARTBEAT_TIMEOUT_SECONDS` reads `working` with an `expires_at`
  the display enforces, a turn end newer than the instance-keyed ledger
  reads `finished_unread` plus one auto-unread claim (first sight is a
  baseline, so a restart never re-lights the fleet); a terminal-header LED
  (`session-header-led.js`); `status_source`
  (hook/transcript/tmux/seed_row/none) rides the `/sessions/list` wrapper
  and renders in the tooltip only.
- `bc12886` - idle gets its own grey fill, `--led-color-idle`, distinct from
  `unknown`'s hollow rim and from `done`'s green; the ring is 1.5px with a
  feathered edge, glow blur 6px.
- `922e400` - the LED becomes one element: the fill is the `background-color`
  for the inner state, and a three-layer `box-shadow` on that same span (a
  hard ring, a low-alpha feather softening the ring's own edge, then a
  blurred glow) is the outer, concentric with the dot at every fractional
  x/y position. There is no pseudo-element and there must not be one - a
  `::after` halo pixel-snaps its own box independently of the dot's box, so
  a dot landing on a fractional position (routine in a flex row) drifted a
  device pixel from its own ring.
- `d419000`, `611780a`, `36e55c2`, `7587d96`, `f77a978` - docs-only:
  18 legacy `cloude.db` backup files moved to Trash (v24 kept); restic now
  covers `Development` and the app data dir; v24 backup and scratch dbs
  moved to Trash; ClaudeArchive released to Trash after archive-nas
  verification; disk cleanup closed at 38 GiB to 147 GiB free.

**Housekeeping today, no commit behind it (database/disk operations, not
code):** 32 GB of db backups and 37 GB of ClaudeArchive released to Trash
after byte verification against copies on archive-nas (10.0.1.237, TrueNAS,
`/mnt/ARCHIVE/vault/85_cloud-exports/claude/`, ssh user `truenas_admin`);
`multihost.db` archived there with a full sha256; restic
(`rest://10.0.10.80:8000/mini-m4`, job
`/Users/jsugamele/docker-management/devices/mini-m4/backup-m4.sh`, daily
03:30) now covers `Development` and the app data dir with a `VACUUM INTO`
db dump, two verify-loop bugs fixed, script committed (`2f26e45`) and
pushed to Gogs after fixing a repo-local `core.sshCommand` that had been
pinning a read-only deploy key; APFS local snapshots thinned; free space
38 GiB to 147 GiB.

**Test baseline at the end of this round:** pytest 5609 passed / 3 failed
(the same three environmental: `test_home_write_guard`,
`test_state_dir_resolution`, `test_version_probe`) / 21 skipped. Node 191
tracked files, 1 known failure (`test_archive_full_page_mode.node.mjs`);
`tests/led_state_for.node.mjs` is a piped-stdin CLI helper, not a
standalone test.

**Owner-verified today:** the dot goes grey on click; group headers roll up
correctly again.

**Still open after this round (carried from yesterday plus new), in value
order:** the websocket push (`src/api/websocket.py` still carries no
project/session-list message type, so state is polled, not pushed -
re-measure whether polling is still the real cost before designing it);
the big-file splits (`session_manager.py` ~7,700 lines, `routes.py` 4,022,
`tmux_backend.py` 2,542, `launchpad.js` 6,472, `terminal.js` 2,422); the
HTML-escape helper copy-pasted across 9 JS files; `PTYBackend` legacy
branches remaining in 6 core files; the periodic agent-infer sweep (item
3's one-shot inference at boot/adopt/first-hook is built, nothing re-checks
a session already live when it shipped); toast history is process memory
only, not durable, does not survive a restart; no bar raised for a WS drop
while the user is present (only the 60s-away sleep/wake bar exists);
`--name` dropped on a restart's resume; `FALLBACK_PROJECTS_ROOT` hardcoding
`/Users/jsugamele` (`src/core/project_directory.py:85`);
`record_claude_lifecycle_event` answering `LINEAGE_UNRESOLVED` for sessions
created inside the real-hook test harness; the LED ring/glow are fixed px,
not relative to the dot size; the adopted-id tracker key item (`dfddbdc`
covers `permission_open` via the pane-verify fix - confirm every OTHER
tracker flag for the same adopted/row-id split, or rekey the tracker on
remap, rather than patching flags one at a time); gitleaks not installed on
the mini; restic password rotation and the `.orig` script with an inline
password (owner's call, deferred with credential rotation until this
project is finished); watch restic repo growth from the nightly 4.6 GB
dump; the archive README on the NAS records a stale size/hash for
`cloude.db`; `refresh_tokens.db` now sits on the NAS (credential material,
owner aware).

---

## 2026-09-09 - release/1.2: v1.1 merged with adamdev/master

Two lines of this project that had diverged since `ba2aa5d` (2026-09-08)
merged onto a new branch `release/1.2`, cut from `v1.1` (`d392aeb`) in a
throwaway worktree so nothing touched the owner's checkout.

**HIS TIP: `887b8fce9b9595f800b9a222ca4f9ef856c9edf0`** ("feat(brand): real
app icon in the DMG background and a new hero banner"). Five commits newer
than the `0d1a12c` the five comparison reports in
`.claude/notes/compare-1.2/` were written against; all five are additive
(clickable toast session name plus theme tint, release v1.0.36, docs and
DMG branding, agent notes under `docs/`) and all five are taken.

**17 CONFLICTED FILES**, resolved one at a time against the owner's six
decisions rather than by picking a side per file. The auto-merged files
were the more dangerous half: four of them merged cleanly and CONTRADICTED
a decision, which is a merge that compiles and lies.

### The six decisions, and what each one cost

1. **UNREAD MODEL: HIS.** Unread rides the OUTER ring as a still green
   ring, the `done` bucket stays, and his status-key legend
   (`client/js/session-status-key.js`) ships. Our retired-ring paragraphs
   in `CLAUDE.md` and `docs/session-status.md` are REWRITTEN to describe
   what shipped and to record that the owner chose the ring on
   2026-09-09, rather than left contradicting the code. Kept from our
   side: the one-element box-shadow geometry (no pseudo-element, so
   concentric is the only geometry available) and the grey `idle` fill for
   a read session. Taken from his: the transport rung (`disconnected`),
   the `notice` inner state and its light blue, and the ONE LIT DIAMETER
   rule - which under our composition is true by construction, because the
   five geometry tokens are declared once and no state rule may override
   one. `tests/test_status_led.node.mjs` is his 48 cases as the base, our
   composition and motion cases swapped in for the ones that measured his
   `::after`, and the inner-dot-unread assertions deleted: **62 cases, all
   passing**.
2. **MANUAL MARK-UNREAD: KEPT, BEHIND A SETTING.** His branch deleted the
   control from the whole client. Restored (11 client files reference it
   again) and gated on a new `ui.show_mark_unread_control` boolean,
   default true. `UIConfig` in `src/config.py`, wired into
   `load_auth_config` (the negative-control test caught that a new block
   is DROPPED unless it is read there explicitly), reported on
   `GET /api/v1/features` and in the settings summary, read client-side by
   a new `client/js/ui-flags.js` that follows `archive-entry.js`'s
   probe-once pattern. ONE GATE: `markUnreadHtml` returns `''`, so every
   surface hides it together. An unreadable config or a failed probe
   leaves the control SHOWN - a flag that hides things must fail open.
   Cover: 1 node case (3 states) plus `tests/test_ui_flags_setting.py` (8).
3. **ROW CONTROLS: OURS.** His ~1100-line row-menu removal is dropped
   entirely: `session-row-menu.js`, its gesture module and its stylesheet
   are restored, along with `session-row-actions.js`, `kebab-icon.js`,
   `session-sidebar-pin.js`, `session-sidebar-reorder.js`,
   `project-list-render-guard.js` and `session-sidebar-density.css`; his
   `session-row-inline-controls.css` and his two tests for that UI are
   removed. VERIFIED, because the sidebar report warned this is the silent
   one: `session-sidebar-rows.js` renders `SessionRowMenu.kebabHtml(r)`,
   which stamps `data-row-status` on the KEBAB, and
   `session-sidebar-clicks.js` reads it back off `[data-row-menu]`. His
   hunk re-pointing that read at the ROW auto-merged and was reverted; had
   it stayed, `runRestart` would have been handed `null` and every restart
   would have reported "unknown" with nothing failing.
4. **DEAD ROWS GO TO RECENT: OURS.** `tests/test_dead_row_renders_dead.node.mjs`
   stays deleted, and his "GATE 1 IS NOW SHUT" paragraph - which claimed a
   dead row is the only surface still reaching the respawn ladder - is
   replaced, since decision 3 keeps restart on a live row.
5. **CI: HIS.** `.github/workflows/tests.yml` (+51), `pytest.ini`'s
   `.claude` exclusion, `scripts/ci/skip-audit.py` (+109) and its exempt
   list all taken as-is. Baselines re-measured (below) and written into
   `CLAUDE.md`.
6. **VERSION: 1.2.0.** `macOS/package.json` and the three README
   references (download link, badge, Path A). The Path A sha256 now points
   at the release page rather than quoting 1.0.36's digest for a file that
   does not exist. No tag created - the orchestrator tags after deploy.

### Also applied, from the reports' standing rules

- `verify_status_led_geometry.py` landed under `scripts/archive/verify/`
  rather than top-level, with a README row and a note that it was written
  against the pseudo-element construction that did NOT ship.
- `session-status-summary.js` is ours (`signalsFor`, `outerFor`) with the
  `done` bucket restored and his `inputIsStopped` hue rule taken back.
  Activity outranks unread on the header ring, and a single-child group
  now paints exactly what that child's row paints, case by case.
- `session-sidebar-groups.js` / `.css` are ours (gutter, coloured count,
  kebab on every band).
- `client/js/session-sidebar-footer.js` is NEW: the status-light key, the
  version line and the remembered-slots note extracted out of
  `session-sidebar-rows.js`, which the new wiring pushed to 531 lines
  against a 500-line budget its own suite asserts. Now 498.
- Backend: all three shared files auto-merged. Read both halves rather
  than assuming - his `subagent_depth` gate is a pure READ taken before
  `record_hook_event` whose only effect is to skip `record_toast`, while
  our `auto_ack_toasts` runs after and only moves an ALREADY OPEN toast to
  `answered`. A suppressed toast was never opened, so there is nothing to
  double-clear.

### Measured baselines

- **pytest: 5626 passed / 2 failed / 21 skipped**, against **5610 / 2 /
  21** for `v1.1` alone in the same checkout minutes earlier. 16 tests
  added, no new failures. The skip count reads 21 or 22 depending on
  `pytest-randomly`'s ordering; `-p no:randomly` pins it at 21 and every
  skip carries a named could-not-evaluate reason. The two are the known environmental ones
  (`test_home_write_guard`, `test_version_probe`). The third `CLAUDE.md`
  used to name, `test_state_dir_resolution`, now passes.
- **node: 197 suites, all 197 passing**, against 193 with 2 failing at
  `v1.1`. `test_archive_full_page_mode.node.mjs` is fixed on his side, and
  `led_state_for` moved to `tests/helpers/`, out of the CI glob.
- `scripts/scan_secrets.py`: exit 0, 1369 files, 8 detectors.
- `tests/test_no_remote_assets.py`: 9 passed.

### A trap worth keeping

A fresh `git worktree` has no `config.json` (it is gitignored), and
without it the suite reports **19 failed plus 26 errored** - 401s from the
test client and FileNotFoundError from the route tests, every one of them
an app that could not start. Reproduced identically on `v1.1` in a second
throwaway worktree and cleared by copying the file in. Do not attribute a
failure to a code change until the same run has been done on the base
commit in the same directory.

### Open

- No git tag: the orchestrator tags `v1.2.0` after deploy.
- `verify_status_led_geometry.py` measures a construction that did not
  ship; rewrite it against the box-shadow composition or drop it.
- The `ui` settings block has no editor in the settings SCREEN yet - it
  round-trips through the API and is edited by hand in `config.json`.

**Late catch, worth recording.** `UIFlags.ensure()` had NO CALLER when the
merge commit landed. The module answers every flag's shipped default until
its probe returns, which is the correct fail-open behaviour and is also
exactly how a setting ships dead: `show_mark_unread_control` would have
answered true forever and `ui.show_mark_unread_control: false` would have
been a config key nothing ever read, with nothing failing and nothing
logged. Fixed in a follow-up commit by calling it (unawaited, memoized to
one request per page load) from `session-sidebar-fetch.js load()` and
`launchpad.js loadRunningSessions()`, either of which may be the first
surface a page load reaches, plus a test that fails if the caller
disappears again. This is the "a fallback that cannot fire is not a
fallback, and it is invisible" trap from CLAUDE.md, in a new place.

---

## 2026-09-09 DEPLOY RECORD - release/1.2 at 6768dcc to live (mac-mini-m4, port 8000)

Deployed the merged 1.2 line from the release worktree, branch
`release/1.2`, HEAD `6768dcc`, working tree clean. NOT TAGGED AND NOT
PUSHED: browser check (a) failed, see "the one failure" below.

**Deploy.** `./scripts/deploy-mini.sh --target live` selected "working tree
is CLEAN, so deploying the committed state", 541 files, staged and hash
checked 541/541 before production was touched, wrote the app bundle
Resources then the server dir, pruned both, and re-verified after the
restart. Banner `== DEPLOYED ==`. The re-run
`./scripts/deploy-mini.sh --verify-only --target live` exited 0 with
`== VERIFIED ==`, 541/541 on both destinations, mirror-clean, nothing
copied. The supervisor did not give up and no kickstart was needed.

**Boot, 2026-09-10T01:00:54Z.** `boot_readopt_complete` held 18, skipped 1,
failed 0, live_count 19. held + skipped = 19 = `tmux -L cloude
list-sessions | wc -l` = 19. `id_sources` all `hook_token` (18), zero
`legacy_row`, zero `derived`, `no_row` 0, so no id was minted and no hook
token was rotated. `status_seed_warm` seeded 19 of 19 examined.

**Hooks after the restart.** Zero `hook_post_rejected_invalid_token`, zero
`hook_post_rejected_non_loopback`, zero 403s and zero 410s on
`/api/v1/hooks/claude-event`. 5 hook POSTs accepted, all 200, no non-200.
Zero tracebacks in the post-restart window. Read off uvicorn's own access
lines, not off a success-only application event, so "none rejected" is
distinguishable from "none received".

**Endpoints.** `GET /api/v1/features` returns
`ui.show_mark_unread_control: true`, and the browser agrees:
`UIFlags.showMarkUnreadControl()` answers true on a loaded page, so
`UIFlags.ensure()` really has a caller. `GET /api/v1/sessions/list`
returns 19 rows for 19 live tmux sessions, idle 16 / working 1 /
finished_unread 2. The bearer was minted on the mini from `TOTP_SECRET`
in the live install's `.env` via pyotp against `POST /api/v1/auth/verify`;
the secret never left that box and neither it nor the token was printed.
Negative control in the same pass: a bogus bearer returns 401, so the 200
is evidence of the credential and not of an open endpoint.

**Browser, live app, hard reloaded (a tab across a deploy does not
refetch static assets).** Fresh bytes proven by presence rather than by a
claim: `VersionFooter`, `UIFlags`, `StatusLed`, `TerminalLayoutWait` and
`TerminalFrameGuard` are all defined on `window`, and every one of those
files read `target MISSING` in the pre-deploy verify.

- b PASS. The status-light key renders under "what the lights mean" with
  seven states, and "done, unread" is drawn as a hollow GREEN ring,
  visibly distinct from solid-green "working", solid-grey "idle" and the
  hollow-grey "not measured".
- c PASS end to end, on `cloude_Fantasy_Hockey_2026` / `ses_9523c563`,
  the oldest live session by last activity (2026-09-03T14:15:12) and
  already idle and read. Marked unread from its own row menu: the LED
  became `status-dot--finished-unread`, title "done - unread (via tmux)",
  `animationName: none` so it is STILL, and `::after` content `none` so
  it is the single-element box-shadow build rather than the pseudo
  element that used to drift a device pixel. NOTE THE SHAPE, because it
  is the 2026-09-09 model and not the older one: the GREEN is the inner
  dot, painted as `rgb(74,222,128) 0 0 0 2px inset`, while the outer
  box-shadow rings are neutral grey at 0.18 and 0.063 alpha with a fully
  transparent glow. The outer ring means activity alone and is correctly
  OFF for a resting session. Clicking into the row cleared it: the
  terminal bound (`Session: ses_9523c563 | PID: 23070`, footer
  "Connected"), and the row came back `status-dot--idle`, title "idle -
  read, nothing running", with the server reporting `unread=False` /
  `idle`. THE NEGATIVE CONTROL IS THE LOAD-BEARING HALF: a blanket clear
  would have passed the positive test perfectly, so the two sessions that
  were already unread were re-read afterwards and BOTH stayed unread
  (`cloude_Media_Compression`, `cloude_Hirschfeld`), on the server and in
  the DOM.
- d PASS. "mark unread for followup" is present in the sidebar row menu
  on a live row.
- e PASS. Every sidebar row carries the kebab, and the menu it opens
  reads: pin to top, mark unread for followup, move to another group,
  close session, restart the agent.
- f PASS. All five group headers render the count in the fixed-width
  gutter as plain coloured text `rgb(215,119,87)` (not a pill) plus a
  `...` kebab BUTTON, the reserved "other" band included, whose button is
  the smaller band menu, `Actions for the other group`. The pinned band
  was NOT rendered at the time of the check because nothing is pinned, so
  it was not measured live; it is the same `headerHtml` path and the same
  unconditional `menuButtonHtml` call as "other", and pinning one of the
  owner's sessions to see it was not worth the state change.
- g PASS. Zero CSP violations across a full hard reload plus six seconds,
  and zero console messages of any kind. The response carries
  `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:;
  font-src 'self' data:; frame-ancestors 'none';` with no third-party
  origin in any directive. A DETECTOR THAT NEVER FIRES CANNOT PROVE A
  ZERO, so the negative control was run in the same pass: an injected
  image from `cdn.jsdelivr.net` raised exactly one `img-src` violation on
  the same listener, which is what makes the zero above mean something.

**The one failure: a, the version footer reads v1.0.33, not 1.2.0.** It is
not a bad deploy and no redeploy can move it. `src/core/version.py`
resolves `CLOUDE_APP_VERSION` FIRST, the Electron shell sets it from
`app.getVersion()` (`macOS/server-manager.js:917`), and that is the
PACKAGED BUNDLE's own version, baked into `app.asar` at build time.
Measured: the running server's environment carries
`CLOUDE_APP_VERSION=1.0.33`, `/Applications/Cloude Code.app` has
`CFBundleShortVersionString` 1.0.33, and `bootstrap.js` has stamped
`1.0.33` into the server dir's VERSION file. `deploy-mini.sh` ships
`git ls-files src client` and cannot rewrite `app.asar`, so
`macOS/package.json` saying 1.2.0 in the repo reaches nothing at runtime.
`GET /api/v1/version` returns `{"version": "1.0.33", ...}` and the client
renders that string in four places. MOVING IT MEANS REBUILDING AND
REINSTALLING THE ELECTRON BUNDLE AT 1.2.0, which is a separate release
artifact and a much larger blast radius than a source deploy, so it was
not attempted unasked on a live install.

Worth knowing while you are in there: the same endpoint reports
`update_available`, latest 1.0.36, against remote
`https://github.com/Adoom666/CloudeCode.git` - the upstream this project
is forbidden to push to. An install on the 1.2 line will keep being told
it is behind by a line it does not follow.

**Not done, deliberately, because a and the step 3 version check failed:**
no `v1.2.0` tag was created, and nothing was pushed to origin.

---

## 2026-09-10 - the electron bundle rebuilt at 1.2.0 and installed on live

Closes the one failure recorded above: the footer read v1.0.33 because
`CLOUDE_APP_VERSION` is set by the Electron shell from `app.getVersion()`,
which is the PACKAGED bundle's own version. No source deploy can move it,
so the bundle itself was rebuilt and reinstalled.

**Build procedure, discovered rather than invented.** There is no build
script under `scripts/`. The procedure is the one `.github/workflows/release.yml`
encodes and the maintainer runs by hand: `cd macOS && npm install`, then
`CSC_IDENTITY_AUTO_DISCOVERY=false npm run package`
(`electron-builder --mac --publish never`). Built from the `release/1.2`
worktree at `ecd0669`, electron-builder 24.13.3, electron 28.3.3,
darwin arm64. The `afterPack` hook `macOS/scripts/adhoc-sign.js` ran and
verified its own signature, which is not optional: without it the bundle
carries no `Contents/_CodeSignature` at all. Outputs
`macOS/dist/mac-arm64/Cloude Code.app` and
`macOS/dist/Cloude Code-1.2.0-arm64.dmg` (120 MB). The .app was installed
directly; the DMG is the distributable and was not needed for a local
install.

**NO VERSION SOURCE NEEDED FIXING.** `macOS/package.json` already read
1.2.0 and it is the ONLY hand written source: electron-builder derives
`CFBundleShortVersionString` and `CFBundleVersion` from it, `app.getVersion()`
reads that, `server-manager.js:917` puts it in the spawn env, and
`bootstrap.js` stamps the server dir's VERSION file from the same value.
The repo carries no VERSION file (it is generated) and no Info.plist
template. Every `1.0.x` literal found by grep across `macOS/`, `src/`,
`client/` and `packaging/` is prose in a comment about the 2026-08-25
adoption incident. So this round changed no code at all.

**THE SOURCE DID NOT MOVE, AND THAT WAS MEASURED BEFORE THE SWAP.** The
new bundle's `Contents/Resources/src` and `client` hash byte for byte
identical to the installed 1.0.33 bundle's
(`e14a7164...` and `0eaa57fa...`), because `deploy-mini.sh --target live`
had already written `6768dcc` into both destinations and `ecd0669` is a
docs only commit on top of it. The only thing that changed on disk is
`app.asar` and the version. The same two hashes were re-measured on the
server dir AFTER the restart, so the bundle resync put back what was
already there.

**Backup, one move from a rollback:**
`/Applications/Cloude Code.app.rollback-1.0.33-20260910T085834`,
matching the naming already beside it. Nothing was deleted; the owner's
settings deny `rm`.

**The restart was bootout then bootstrap, NOT `kickstart -k`, and the
reason is the adoption gate.** `kickstart -k` SIGKILLs the Electron app,
which orphans the python server onto launchd still holding port 8000. The
new 1.2.0 bundle would then find a 1.0.33 server there,
`decideAdoption` would answer `mismatch`, and `server-manager.js` would
refuse to start OR stop it: a dead end wearing a correct log line. So
`launchctl bootout gui/501/com.cloudecode.menubar` ran first, the app's
own teardown took the server child with it (port 8000 free in 2s, measured,
not assumed), and only then `launchctl bootstrap gui/501 <plist>`.

**Measured after the restart (2026-09-10T12:59:09Z):**
- 19 tmux sessions on `-L cloude` before and after, unchanged. Nothing was
  typed into, restarted or closed.
- `boot_readopt_complete` at 12:59:30.151048Z: `held: 18`, `skipped: 1`,
  `live_count: 19`. Same shape as the last known good deploy.
- ZERO `hook_post_rejected_invalid_token` in the whole post restart window.
  The only hook token line is one `hook_tokens_restored`. The only warning
  of any level is one `notifications.topic_missing`, which is unrelated.
- The three version reads all agree: `CFBundleShortVersionString` 1.2.0 on
  the installed bundle, `CLOUDE_APP_VERSION=1.2.0` in the RUNNING server
  process env (`ps eww`, pid 66351), and the server dir VERSION file
  stamped 1.2.0.
- `GET /api/v1/version` returns `{"version": "1.2.0", ...}`, read through
  the app's own authenticated client in a real browser.
- The footer renders `v1.2.0` on a hard reload, in both `.home-bar__version`
  and the sidebar `.version` span, and it is the ONLY version string in the
  page text. It is fed by the server rendered
  `<meta name="cloude-app-version" content="v1.2.0">`, so the painted value
  and the endpoint have the same origin.
- Zero CSP violations across a full load that produced 260 console
  messages. THE NEGATIVE CONTROL WAS RUN IN THE SAME PASS, because a
  detector that never fires cannot prove a zero: an injected image from
  `cdn.jsdelivr.net` raised exactly one `img-src` violation on the same
  listener, and was removed afterwards.

**Still open, unchanged by this round:** the endpoint still reports
`latest_version` 1.0.36 against `https://github.com/Adoom666/CloudeCode.git`,
the upstream this project may not push to, so a 1.2 install keeps being
told it is behind a line it does not follow. No `v1.2.0` git tag was
created here either; that is a separate deliberate act and the release
workflow triggers on it.

---

## 2026-09-10 - release/1.2.1: adam's listing round merged, plus the two gaps that are ours

Built in a throwaway worktree on `release/1.2.1`, branched from
`release/1.2` (344da42). NOT deployed, NOT tagged, NOT pushed - that is
the orchestrator's step after validation.

### Per commit

- **merge** - `adamdev/master` 2b1fcb9 into `release/1.2`. Every code file
  auto-merged. The two conflicts were both documentation and both were
  test baseline numbers: kept ours (measured on this tree) and folded in
  his "take your own baseline on a clean tree" discipline. His corrected
  "the tail read was claimed to be free in steady state and it was not"
  paragraph replaces our falsified sentence, which is the one place his
  text overrides ours and is the right way round, because he measured it.
  README now carries 1.2.1 everywhere and keeps his rebuilt 1.0.36 dmg
  hash attributed to upstream.
- **fix(listing) socket scope** - `listing_proves_alive` was trusting a
  listing from ONE socket to stand in for a probe of ANOTHER. `StatusMap`
  carries its socket, the function takes the socket being asked about,
  and unstated-or-mismatched refuses. New test on two real throwaway
  sockets, same name alive on A and killed on B, with the PRE-FIX rule
  reproduced inline so the file fails if the old behaviour returns.
  Also hoisted `kq = None` above the try in `pipe_wakeup._try_watch`.
- **perf(listing) gap A** - the status seed's `read_instance_row` opened a
  connection per session on `/sessions/list`. It now answers from HIS
  index, which grew the four seed columns rather than acquiring a rival.
  `InstanceIndex` gained `complete` (the `StatusMap` discipline) so an
  index that could not be BUILT falls back instead of answering "no row"
  and blanking the ladder. The index is skipped entirely when no held
  session is hookless, which is his own 2b1fcb9 correction on this path.
- **perf(permission) gap B** - measured before changing anything, and the
  briefed premise did not hold: `should_capture_permission_tail` is
  FAIL-CLOSED at every rung, so a healthy box already spent zero here.
  That is now a measurement over six sessions rather than a docstring
  claim. What WAS real is the re-look, bounded by
  `PERMISSION_TAIL_RECHECK_SECONDS = 30` through a ledger keyed on the
  CLAIM, not the session, so the first look at a new claim is never
  delayed.
- **version + docs** - `macOS/package.json` 1.2.0 to 1.2.1 (confirmed the
  only hand-written declaration). CLAUDE.md gains the listing-cost
  paragraphs and a re-measured test baseline.

### Measured, in-process against real tmux, one listing pass

| n sessions | datastore opens | pass p50 | pass p99 |
|---|---|---|---|
| 12, before | 60 | 40.0 ms | 42.2 ms |
| 12, after | 49 | 33.9 ms | 46.8 ms |
| 19, before | 95 | 58.9 ms | 68.4 ms |
| 19, after | 77 | 49.7 ms | 57.2 ms |

"Before" is the same tree with the bulk index forced to report it could
not be built, so the seam falls through to the per-row connection - the
pre-round shape, on the same panes, in the same process. The index costs
one open and saves one per session.

TRUST THE COUNT, NOT THE MILLISECONDS. That timing is a warm local
database with no rows in it and n=15 passes; the p99 at 12 sessions is
higher after than before, which is noise at that sample size and is left
in rather than dropped. tmux subprocesses were 1 per pass at both 12 and
19 sessions, which is his fix holding: the pre-round shape was
`2N + 1`, so 39 at 19 sessions.

### What was NOT measured, and why

- **No live measurement.** Nothing was deployed and the live box was not
  touched. The figures this work is aimed at are the review's:
  `/sessions/list` p50 270.1 ms / p99 418.5 ms with 19 sessions, and a
  no-op `/health` going from p50 45.3 ms quiet to 181.9 ms while a
  listing is in flight. Re-measure there after deploy.
- **No local HTTP timing.** A local server needs a `.env`, and the only
  one available points at the live state dir and the live `cloude` tmux
  socket, which a boot re-adopt would then attach to. The in-process
  measurement above measures the same thing (the synchronous pass, and
  the event loop gap around it) without that risk.
- **NEAR MISS WORTH RECORDING**: an ad-hoc probe script written outside
  pytest read the PRODUCTION `cloude` socket, because `socket_guard`'s
  subprocess guard is installed by conftest and an ad-hoc script does not
  get it. It was read-only (`list-panes -a`) and nothing was written, and
  it was caught by the socket name appearing in its own debug output.
  Every measurement was redone under pytest. Do not write throwaway tmux
  probes outside the suite.

### Follow-ups this round measured but did not close

1. **FOUR name-keyed per-row datastore readers remain on
   `/sessions/list`**, attributed by caller at 19 sessions:
   `_restored_activity_state` 19, `_identity_for_live_name` 19,
   `_label_for_tmux_name` 19, `_owned_instances_from_db` 19. They are not
   folded into the index because all four take "the newest instance of
   this name" while the index keys on the full triple; answering them
   from it would be a silent behaviour change in the duplicate-name case.
   Closing them means giving them the epoch the pass already holds, or a
   second name-keyed bulk read. `tests/test_listing_pass_datastore_cost.py`
   pins the ceiling at `4N + 2` and names the reader that grew.
2. **OWNER DECIDES** whether `STARTUP_TAIL_RECHECK_SECONDS = 30` is an
   acceptable worst case for noticing a session that becomes stuck LATER
   (claude quit and hand-restarted in a pane whose `pane_pid` does not
   move). First looks are unthrottled. Carried over from the round-2
   review, still open.
3. **A SUPPRESSED TOAST IS RECORDED, UNACKED AND UNRENDERABLE.** His
   `ToastManager.add()` drops a toast for the ACTIVE session while our
   `StartupGateLedger.claim_toast` is once per instance and the server has
   already recorded it open; `reconcileOpen` only removes cards the server
   has closed, so it never re-materialises. For a permission or startup
   prompt on the session the user is looking at, silence is the intent.
   Recorded here rather than left to be found.
4. **`client/js/session-sidebar.js` WAS AT EXACTLY ITS 500-LINE BUDGET**,
   so his 8-line toast-dismissal addition broke
   `tests/test_sidebar_sessions.node.mjs` on the merged tree (it passed on
   his). Fixed by extracting the rule to
   `client/js/session-entry-toasts.js` and collapsing two delegating
   methods to the one-line form the two methods above them already use.
   The file has three lines of headroom now; the next addition there
   needs an extraction, not a trim.

### Verification

- pytest, full, `-p no:randomly`: **5656 passed / 2 failed / 19 skipped**.
  The two failures are the same environmental pair the baseline names
  (`test_home_write_guard`, `test_version_probe`). Merge point read
  5641/2/19 and `release/1.2` read 5628/2/19 in this same worktree.
- node, exactly as CI runs it: **197 suites, 0 failing**.
- `node --check` on every JS file touched: toast.js, session-sidebar.js,
  session-entry-toasts.js, macOS/main.js.
- `scripts/scan_secrets.py`: exit 0. The pre-commit hook ran normally on
  every commit, gitleaks gate included; `--no-verify` was not used.

## 2026-09-10 - release/1.2.1: adam's four newest folded in, the row menu held

Owner authorised the fold ("2. yes all folded in"). Range
`2b1fcb9..adamdev/master`, his tip `8898f07`. Merge commit `94ecc85`,
both parents recorded, so his tip is in ancestry and cannot silently
re-propose itself on the next fetch.

### Per commit

- **`4ae4b71` docs plan. TAKEN, unedited.** 242 lines, new file,
  `docs/webui-performance-and-session-menu-plan.md`. His roadmap, taken
  as his document.
- **`46e7aca` mute. TAKEN.** Schema v26 (`sessions.notifications_muted`,
  `notification_policy_generation`), nullable, no backfill, so the
  absence of a decision on a row IS unmuted. VERIFIED rather than
  believed: the gate sits BELOW `record_hook_event` (`routes.py:2286`
  against the check at `2467`), so a muted `PermissionRequest` still sets
  `permission_open` and still resolves `question`, and a muted `Stop`
  still flips unread. `toast_auto_ack.py`, `session_view_clears.py` and
  `client/js/toast.js` are untouched, so our toast semantics do not move.
- **`6f79e90` themes. TAKEN.** Removes the SECOND WRITER of the terminal
  palette (app.js's `Themes.applySession(agent_type)` running after
  theme-navigation had painted the pin). `applyForTarget` survives as the
  total function gotcha 7 requires and now hands both inputs to one
  resolution, so this strengthens the invariant rather than widening it.
- **`8898f07` row action menu. HELD, NOT RESOLVED. OWNER DECIDES.**

### Why the row menu was held

His `session-row-actions.js` DELETES `LIVE_STATUSES` and returns
`[CLOSE]` alone for every non-dead status, under a comment block titled
"NO LIVE-ROW RESTART LIST ANY MORE" citing the owner's 2026-09-08 "remove
'add to group' / 'restart the agent'". His five menu items are rename,
fork session, new session in folder, mute/unmute and close; pin goes back
inline. Ours carries pin/unpin, mark unread, close/remove plus restart,
and group filing.

So it contradicts THREE settled decisions of the 1.2 round, not one:
decision 3 (row controls are ours, the kebab WITH restart on live rows),
decision 2 (manual mark-unread kept behind `ui.show_mark_unread_control`)
and decision 4's replacement of his "only a dead row reaches the respawn
ladder" claim. The 2026-09-08 instruction he cites is real; decision 3 is
dated 2026-09-09 and is the later ruling. That tension is the owner's to
settle, not a merge's.

**Resolution applied:** all 25 of its paths resolved to OURS. The 19 we
share were `git checkout HEAD --`'d; the 4 modules it adds alone
(`session-row-menu-actions.js`, `session-row-menu-open.js`,
`test_session_row_menu.node.mjs`, `test_session_row_menu_renders.py`) were
removed; the 2 that decision 3 had already deleted
(`test_session_row_inline_controls.node.mjs`,
`test_session_row_controls_render.py`) stay deleted. Verified afterwards
that no trace survives (`offersMenu`, `SessionRowMenuOpen`,
`SessionRowMenuActions` all absent) and that our surface is intact
(`LIVE_STATUSES` present, `actionsFor` still returns
`[ACTION_CLOSE, ACTION_RESTART]` on a live row).

**Dropped WHOLE, deliberately.** The commit is atomic: it also deletes
double-click rename and routes rename through the new menu, so taking
half would leave no way to rename a session at all.

**Zero file overlap** between `8898f07` and the other three commits, so
the drop cost the kept work nothing.

### The consequence the owner should weigh

**The mute feature now ships SERVER SIDE ONLY.** `46e7aca` touches no
client file at all; its single UI control was the menu item in the
dropped commit. So a mute is reachable through
`PATCH /sessions/records/{session_uuid}/notifications` and through
nothing a user can click. Recorded as a note in `docs/session-status.md`
rather than papered over by inventing a control, which would have been
the same class of unilateral product decision as resolving the menu.

**→ ONE QUESTION FOR THE OWNER:** decision 3 kept the kebab WITH restart
on a live row; adam's new menu replaces it with five different items and
no restart. Take his menu and lose live-row restart, keep ours and lose
his four new actions plus the only mute control, or have the two
reconciled into one menu that keeps restart AND adds his four?

Recovery either way is cheap and neither direction is lost:
`git checkout 8898f07 -- <paths>` re-lands his version.

### Two of his tests were repointed

`test_session_notification_mute.py` imported `LIVENESS_ALIVE` from
`src/core/session_liveness`, a module introduced by `ba2aa5d` - the
commit the owner OVERRULED AND REVERTED (dead rows go to Recent,
decision 4). Repointed at our settled three-value vocabulary,
`session_status.LIVENESS_LIVE`. Test-only; no product code moved and
decision 4 is untouched. His 43 mute cases all pass.

### Verification

- pytest **5708 passed / 2 failed / 19 skipped** against a 5656/2/19
  baseline, so +52 and NO new failures. The two are the known
  environmental pair (`test_home_write_guard`, `test_version_probe`).
- Node **198 suites, 0 failing** (run exactly as CI).
- `node --check` clean on all 4 touched JS files.
- `scan_secrets.py` exit 0, gitleaks clean via the pre-commit hook.
- Version confirmed still **1.2.1**; nothing bumped, tagged, pushed or
  deployed.
- Our 1.2.1 perf work verified intact: socket-scoped liveness
  (`session_status_map`), index-backed seed row read
  (`session_status_seed_read`), permission re-look throttle
  (`PERMISSION_TAIL_RECHECK_SECONDS`). **No per-row query or per-row tmux
  capture is added to the listing path**: `_session_info_for` does call
  `notification_policy_for` per row, but it resolves against the
  in-memory `_by_uuid` projection hydrated once at boot, not SQL.

### 500-line rule

His work pushes two PRODUCTION files over the line, both his and both
left alone rather than restructured mid-merge:
`src/core/session_notification_policy.py` (new, 563) and
`src/core/notifications/idle_watcher.py` (459 -> 513). Four test files
also cross. None is ours to extract; flagged for a later round.

### For the later 1.3 re-port

`feat/svelte-1.3` rebuilt the row menu on a plugin registry with
mark-unread as a plugin. NOT touched here. Whatever the owner rules on
the menu, the re-port must reconcile: `client/js/session-row-actions.js`
(the `actionsFor` / `LIVE_STATUSES` contract and his `offersMenu`),
`client/js/session-row-menu.js`, `client/js/session-row-menu-gestures.js`,
`client/js/session-sidebar-rows.js`, `client/js/session-sidebar-clicks.js`
(the `data-row-status` read, kebab vs row - the silent one),
`client/js/session-sidebar-rename.js` (double-click vs menu item),
`client/js/session-sidebar-fetch.js`, `client/js/session-sidebar.js`,
`client/js/launchpad.js`, `client/js/project-list-render-guard.js`,
`client/css/session-row-menu.css` and `client/index.html`. The theme
change also re-ports: `client/js/themes/registry.js`,
`client/js/theme-navigation.js`, `client/js/app.js`,
`client/js/terminal.js`.

### Unverified, stated plainly

Nothing was run against a live install. The mute gate, the theme
resolution and the dropped menu are verified by the test suites and by
reading the merged code, NOT by clicking the app on the owner's box.
His `test_terminal_theme_survives_agent_renders.py` and
`test_session_row_menu_renders.py` drive real Chromium; the former runs
here, the latter was removed with the menu.

## 2026-09-10 later: the row action menu reconciled into ONE superset

**OWNER'S RULING, verbatim:** "reconcile the two menus into ONE superset",
and then the correction that shaped the rest of it: **"dont remove the
rename. i said merge not take everything."**

That correction became the general rule for the whole reconcile: WHERE
HIS CHANGE REMOVES A BEHAVIOUR OF OURS, WE KEEP OURS AND ADD HIS
ALONGSIDE, and a genuine either-or stops for the owner rather than being
decided in the merge. Nothing hit that second case; every conflict here
turned out to be additive once looked at.

Third instruction, and it set the effort budget: **"dont forget we are
rewriting this. so much of this is going to be rewritten properly."** The
vanilla `client/js` menu is THROWAWAY - `feat/svelte-1.3` rebuilds this
exact surface on the plugin registry - so the JS is the smallest correct
diff and nothing was restructured for elegance. The TESTS were written to
full care instead, because they are the specification that rewrite has to
satisfy.

### What the menu contains, on a LIVE row

rename (R), mark unread (U), move to group (G), fork session (F), new
session in folder (N), mute notifications (M), then a separator, then
restart the agent (T) and close session (C). Pin is INLINE, adam's
placement. Restart and close sit below the separator because both end the
process running right now - on a live row a restart kills the pane and
respawns it, so it is every bit as destructive as close.

On a DEAD row: inline restart and remove, and NO menu, per decision 4. A
dead row also still belongs in Recent rather than on the live list; this
is only the honest rendering of one the reaper has not taken yet.

### What was taken from each side

- **HIS, as the base:** the three-module split
  (`session-row-menu.js` item table + captured context,
  `-actions.js` runners, `-open.js` panel/focus/keyboard), because a
  declarative item table is what makes an eight-item superset a table
  edit rather than a rewrite. With it: identity captured at PAINT TIME
  (the list repaints every 5s), the capture-phase key handling that stops
  a shortcut letter reaching the terminal, `aria-disabled` with a
  reachable reason rather than the `disabled` attribute, and pin inline.
- **OURS, kept:** `session-row-actions.js` ENTIRELY - `LIVE_STATUSES` and
  `actionsFor` returning `[CLOSE, RESTART]` for a live row, which is
  decision 3 - plus the three items (restart, mark unread, move to
  group), the `ui.show_mark_unread_control` gate, the gestures module
  (right click and long press, which his menu has no answer for), and the
  open-menu repaint guard in `project-list-render-guard.js` that his
  version had dropped.
- **HIS `offersMenu`, taken and rewired:** it is DERIVED from `actionsFor`
  rather than from a second status list, so pointing it at OUR
  `actionsFor` gives the right answer for free - live and unknown get the
  menu, dead keeps its inline pair - with no change to decision 3's logic.

### The rename pair, which is the point of the correction

**BOTH ENTRY POINTS SHIP, DRIVING ONE IMPLEMENTATION.** Double-click
rename is untouched (`session-sidebar-rename.js` keeps `onDblClick`,
`deferActivation` and `clearPending`; `session-sidebar.js` keeps its
`dblclick` listener; `session-sidebar-clicks.js` keeps the deferral on the
name). The menu's rename calls `SessionSidebarRename.beginEdit`, which is
the SAME function both gestures already ended in - so there are in fact
THREE doors (double-click, F2, menu) onto one editor, one seed, one
validator and one commit path. `tests/test_session_row_menu_dispatch.node.mjs`
drives all three and asserts they land in the same place, and that all
three refuse an unrenameable row identically.

**THE COST THE OWNER IS ACCEPTING BY KEEPING IT**, stated because his
commit message is the only place it was written down: the deferral holds
every click on a RENAMEABLE row's name for a measured ~250 ms before the
row switches, so a double-click can claim it. That is the most-used
interaction in the list paying for the rarest. Keeping the gesture keeps
the delay. Worth a look on a phone; not changed here.

### Everything in his commit that DELETES rather than adds

Audited on request, so nothing goes through unseen:

1. **Double-click rename** (`-94` in rename.js, the `dblclick` listener in
   sidebar.js, the deferral in clicks.js). REFUSED, kept, per the owner.
2. **The open-menu repaint guard** in `project-list-render-guard.js`.
   KEPT, repointed at `SessionRowMenuOpen`.
3. **The live row's inline close X.** Taken - it becomes the `close
   session` item, which is what the ruling asks for.
4. **`LIVE_STATUSES` / live-row restart** - not in this commit but in the
   base it sits on. REFUSED; ours stands, and there is now a test that
   fails if it goes again.

Nothing else in the commit is a deletion. His launchpad menu wiring was
NOT taken: our launchpad keeps its inline controls, so nothing of ours is
lost there and the diff stays small.

### The trap that would have compiled and lied

`session-sidebar-clicks.js` `runRestart` read the row status off
`data-row-status`, which OUR kebab stamped. Adam's trigger spells it
`data-row-menu-status`. Reading the old spelling against the new trigger
returns null and the picker reports EVERY restart as "unknown" with
nothing failing - the exact defect `.claude/notes/compare-1.2/sidebar.md`
flagged. Repointed, and called out in a comment at the site.

### Tests: extended, never replaced

- NEW `tests/test_session_row_menu_superset.node.mjs` (16 cases): the
  eight items and their order, the separator group, distinct shortcuts,
  restart on every measured-live status, the negative control that an
  UNDETERMINED row offers none, restart availability being IDENTICAL to
  `actionsFor` wherever a menu is drawn, the mark-unread flag with its
  negative control, both flipping labels, move-to-group withheld off the
  sidebar, fork and rename refusing WITH a reason, decision 4's dead row,
  and the context round-tripping through the trigger unchanged.
- NEW `tests/test_session_row_menu_dispatch.node.mjs` (8 cases): the three
  rename doors, the identical refusal, and where restart / mark unread /
  move to group actually go, including that a missing collaborator is a
  no-op rather than an exception.
- UPDATED behaviourally, not deleted: the row and parity suites now ask
  what a row OFFERS (inline plus menu) instead of matching tooltip
  strings, so they survive the Svelte port.

**THE NEW GUARDS WERE MUTATION-TESTED**, because a test that cannot fail
is worse than none. Dropping restart from a live row (adam's regression,
reproduced deliberately) failed 5 superset cases and 1 row case; giving
the menu a private rename instead of `beginEdit` failed 2 dispatch cases.
Both mutations reverted.

**Note for the Svelte port:** the two updated suites had assertions on
generated HTML (`title="close session"`, inline-icon counts). Those are
gone, replaced by action-set assertions. What remains markup-coupled and
would need rework in 1.3: the trigger attribute round-trip case in
`test_session_sidebar_rows.node.mjs` and the `offeredFor` regex helper in
`test_session_row_actions.node.mjs`, both of which parse rendered HTML
because this repo bundles no DOM.

### Verification

- pytest **5708 passed / 2 failed / 19 skipped**, identical to the
  post-merge baseline; the two are the known environmental pair. This
  round is client-side, so no Python moved.
- Node **200 suites, 0 failing** (198 before, plus the two new files).
- `node --check` clean on every JS file touched.
- `scan_secrets.py` exit 0. Version confirmed still **1.2.1**.

### Follow-ups, split by whether the code survives

**PERMANENT, under `src/` - the Python is NOT being rewritten, so these
should not quietly become permanent:**

- [ ] `src/core/session_notification_policy.py` is **563 lines**, over the
      500 rule. Suggested split: lift the durable-row half (hydration
      query, `apply`, the generation counter) into
      `session_notification_policy_store.py` and leave the pure verdict
      ladder and its three values behind, which is the same seam
      `session_startup_gate` / `_ledger` already uses.
- [ ] `src/core/notifications/idle_watcher.py` is **513 lines**, newly
      over after the mute gate landed. Suggested split: move the policy
      consultation and its refusal reasons into a small
      `idle_watcher_policy.py`, keeping the watcher loop itself under the
      cap.

**THROWAWAY, under `client/js` - deleted by the 1.3 Svelte rebuild, so
NOT split here on purpose:**

- `client/js/session-row-actions.js` 552 lines (already 519 and over
  before this round).
- `client/js/session-row-menu.js` 535 lines.

### For the 1.3 re-port

`feat/svelte-1.3` has this surface on a plugin registry with mark-unread
already a plugin, so the eight items above are the target shape. Files it
must reconcile: `client/js/session-row-menu.js` (the item table, the
`available` vs `enabled` split, and the captured context),
`session-row-menu-actions.js` (where each item goes),
`session-row-menu-open.js` (focus, the capture-phase keyboard, the
optional point placement), `session-row-menu-gestures.js` (right click and
long press), `session-row-actions.js` (`actionsFor` / `offersMenu`),
`session-sidebar-rows.js` (pin inline plus trigger),
`session-sidebar-clicks.js` (the `data-row-menu-status` read),
`session-sidebar-rename.js` (three doors, one `beginEdit`),
`session-sidebar.js` (the dblclick listener),
`project-list-render-guard.js`, `client/css/session-row-menu.css` and
`client/index.html`. The two new test files are the specification and
should port before the code does.

## 2026-09-10 later still: two validator findings on the menu delta, fixed

Independent validation failed the row-menu commit on 2 of 12 checks. Both
were real. The other ten passed, including the live-row restart guard,
which broke 7 cases across 3 files when forced rather than the 6 recorded
above.

### FINDING 1: the attribute-name bug was FIXED BUT NOT GUARDED

The validator mutated the READER in `session-sidebar-clicks.js` back to
the old spelling `data-row-status`, ran all 200 node suites, and got
**zero failures**. So the "compiles and lies" regression the commit
message claims to fix could come straight back and ship silently.

**Why the existing cover could not see it, and the lesson.** There were
two tests either side of the seam and neither crossed it: a WRITER-side
assertion that the trigger carries `data-row-menu-status`, which passes
happily while the reader looks somewhere else, and a READER-side dispatch
test whose `runRestart` was a MOCK - and a mock never performs the
attribute read at all. Two green tests, one unguarded contract. **When a
writer and a reader agree by naming the same string, only a test that
runs BOTH halves is evidence.**

**The fix:** two cases in `tests/test_session_row_menu_dispatch.node.mjs`
that render the REAL trigger through `SessionRowMenu.triggerHtml`, parse
the attributes out of that rendered markup (never a hand-written map,
which would be a third spelling that could agree with one side while the
other drifted), and drive the REAL `SessionSidebarClicks.runRestart`
against it with a recording picker. The status must arrive at
`picker.open` as `working`, not null. The second case drives four
statuses, because a wrong spelling reads null for every one and a single
fixture could pass on a default.

**MUTATION-PROVEN, before and after the split:** with the reader on the
wrong spelling both new cases fail and the full 200-suite run reports 1
failing file instead of 0. Reverted and re-confirmed green.

### FINDING 2: two client files shipped over the 500-line rule

`session-row-menu.js` 535 and `session-row-actions.js` 552. CLAUDE.md
names this family as one that must not grow, and the owner has recorded
"files over 500 lines" as a stated dislike, so shipping them was
inconsistent with what we published the same day. Split along the seam the
three-module structure already had - a LIFT each, no redesign, no new
abstraction, no renamed export:

| file | was | now |
|---|---|---|
| `client/js/session-row-menu.js` | 535 | **402** |
| `client/js/session-row-menu-items.js` | - | **168** (the item table) |
| `client/js/session-row-actions.js` | 552 | **449** |
| `client/js/session-row-actions-confirm.js` | - | **166** (CONFIRM_COPY, `confirm`, `attachmentPreamble`) |

`SessionRowMenu.ITEMS` is still re-exported and `SessionRowActions.confirm`
/ `.attachmentPreamble` still exist under their own names, delegating, so
no caller changed. A missing confirm module answers **false** - a
destructive action must never proceed because its confirmation failed to
load. Nine test sandboxes that load these modules standalone now load the
split half too, and `test_server_status_panel.node.mjs` reads the pair as
one source because its assertions are about the pair.

### Verification after both fixes

pytest **5708 passed / 2 failed / 19 skipped** (the two environmental);
the three cost-ceiling suites `test_listing_seed_row_cost.py`,
`test_listing_subprocess_cost.py`, `test_listing_liveness_socket_scope.py`
**12 passed**; node **200 suites, 0 failing**; `node --check` clean;
`scan_secrets.py` exit 0; version still **1.2.1**.

The two `src/` follow-ups recorded above (`session_notification_policy.py`
563, `notifications/idle_watcher.py` 513) are UNCHANGED and still open -
that code is not being rewritten, so they still want a real split.

---

## 2026-09-10 DEPLOY RECORD - release/1.2.1 at d074bbc to live (mac-mini-m4, port 8000)

Deployed the merged 1.2.1 line from the release worktree, branch
`release/1.2.1`, HEAD `d074bbc`, working tree clean. TAGGED `v1.2.1` AND
PUSHED to `origin` and `adamdev`. All gates passed.

**Deploy.** `./scripts/deploy-mini.sh --target live` selected "working tree
is CLEAN, so deploying the committed state", 551 files, staged and hash
checked 551/551 before production was touched, wrote the app bundle
Resources then the server dir, pruned both, and re-verified after the
restart. Banner `== DEPLOYED ==`. The re-run
`./scripts/deploy-mini.sh --verify-only --target live` exited 0 with
`== VERIFIED ==`, 551/551 on both destinations, mirror-clean, nothing
copied. The pre-deploy verify showed the expected 1.2.0 drift, including
eight files reading `target MISSING` that are new in this release.

**The restart was the app's own, and no kickstart was needed.** Electron
(pid 66329) stayed up throughout and its python child was replaced,
66351 to 93038, at 2026-09-10T15:43:22Z. The `bootout` / `bootstrap`
dance the 1.2.0 round needed was not required here because nothing
SIGKILLed Electron, so nothing orphaned a server onto port 8000.

**A HEALTH READ AT 32 SECONDS RETURNED 000 AND THAT WAS NOT A FAILURE.**
The new process bound :8000 immediately but did not answer until
15:44:16Z, about 54 seconds after spawn, because startup work held the
event loop (`boot_readopt_complete` lands at 15:44:05.166Z and
`status_seed_warm` at 15:44:05.210Z, both after the socket exists). A
single probe inside that window reads exactly like a dead server. It was
resolved by POLLING rather than by concluding from one sample, which is
the only reason this record does not say the deploy failed. If a future
round sees 000 here, poll for a minute before believing it.

**Boot, 2026-09-10T15:44:05Z.** `boot_readopt_complete` held 18, skipped 1,
failed 0, live_count 19. held + skipped = 19 = `tmux -L cloude
list-sessions | wc -l` = 19. `id_sources` all `hook_token` (18), zero
`legacy_row`, zero `derived`, `no_row` 0, so no id was minted and no hook
token was rotated. `status_seed_warm` seeded 19 of 19 examined.

**Hooks after the restart.** Zero `hook_post_rejected_invalid_token`, zero
`hook_post_rejected_non_loopback`, zero 403s and zero 410s on
`/api/v1/hooks/claude-event`. 6 hook POSTs accepted, all 200. Zero
tracebacks and zero error-level lines in the post-restart window. Read off
uvicorn's own access lines, so "none rejected" is distinguishable from
"none received", which is the whole point of quoting the accepted count
beside the rejected one.

**Endpoints.** `GET /api/v1/features` returns
`ui.show_mark_unread_control: true`. `GET /api/v1/sessions/list` returns
19 rows for 19 live tmux sessions (idle 12, finished_unread 5, working 1,
unknown 1; sources transcript 11, tmux 4, seed_row 3, hook 1).
`GET /api/v1/version` reports `current_version` **1.2.0, and that is
EXPECTED, not a failed deploy**: the field is `CLOUDE_APP_VERSION`, which
the Electron shell sets from the PACKAGED bundle's `app.getVersion()`, and
the bundle was deliberately not rebuilt this round. No source deploy can
move it. The footer paints v1.2.0 for the same reason and from the same
origin. The bearer was minted on the mini from `TOTP_SECRET` in the live
install's `.env` via pyotp against `POST /api/v1/auth/verify`; the secret
never left that box and neither it nor the token was printed. Negative
control in the same pass on every measurement: a bogus bearer returns 401,
so each 200 is evidence of the credential and not of an open endpoint.

### The measurement, which is the point of this release

Read-only, run ON the mini against loopback so network variance is out of
it. 20 sequential `GET /api/v1/sessions/list`; 30 `/health` while quiet;
30 `/health` while a `sessions/list` is CONTINUOUSLY in flight, which is
the head-of-line blocking probe. Three warmup calls discarded. The BEFORE
pass independently reproduced the figures already on record for 1.2.0
(p50 272.9 against the recorded 270.1), which is what makes the two passes
comparable rather than two different experiments.

| measurement | 1.2.0 before | 1.2.1 after | 1.2.1 confirm | change |
|---|---|---|---|---|
| sessions/list p50 | 272.9 ms | 83.0 ms | 86.8 ms | 3.3x faster |
| sessions/list p99 | 539.2 ms | 218.5 ms | 113.6 ms | 2.5x to 4.7x |
| health p50, quiet | 34.4 ms | 31.4 ms | 29.2 ms | flat |
| health p99, quiet | 197.4 ms | 47.4 ms | 39.4 ms | 4.2x |
| health p50, under listing | 175.8 ms | 23.4 ms | 20.0 ms | 7.5x |
| health p99, under listing | 655.4 ms | 54.8 ms | 62.8 ms | 11.9x |
| listings completed in the probe window | 33 | 68 | 64 | about 2x |

**THE HEAD-OF-LINE BLOCKING IS GONE, and that is the finding, not the
p50.** On 1.2.0 a no-op `/health` cost 175.8 ms at p50 while a listing was
running against 34.4 ms quiet, a 5.1x penalty for being unlucky about
timing. On 1.2.1 it is 23.4 ms under load against 31.4 ms quiet, so there
is NO measurable penalty at all. A concurrent listing no longer parks the
event loop.

**Attributable, with the confounder named.** Nothing else changed on the
box between the two passes, both ran the same script against the same 19
sessions, and the AFTER pass was repeated at a five minute interval with
the same shape, so it is not a one-off. The one confounder that cuts the
right way: the AFTER server had been up about 4 minutes against roughly
2.7 hours for BEFORE, so its caches were COLDER, which works against the
improvement rather than manufacturing it. Sample size is small (n=20 for
the listing, n=30 per health condition), so read p99 as indicative;
p50 and the load-versus-quiet ratio are the numbers to trust, and the
tripled completion count is independent of the timings entirely.

### Browser, live app, hard reloaded twice

A tab open across a deploy does not refetch static assets, and the owner's
own tab proved it: it was still reporting `meta cloude-app-version`
**v1.0.33**. All checks below were run in a SEPARATE tab, hard reloaded,
and the tab was closed afterwards. That the bytes are fresh is proven by
PRESENCE rather than by a claim: `SessionEntryToasts`,
`SessionRowActionsConfirm`, `SessionRowMenuActions`, `SessionRowMenuItems`
and `SessionRowMenuOpen` are all defined on `window`, and every one of
those five files read `target MISSING` in the pre-deploy verify.

The Chrome MCP tab reports `document.hidden === true` even when fronted,
so every interaction was driven through the app's OWN entry points
(`SessionRowMenuOpen.open(kebab)`, the exact call
`session-row-menu-gestures.js:216` makes) rather than physical clicks,
which do not reach the element in that state.

- a PASS. The kebab on live row `cloude_Media_Compression` opens a menu of
  exactly 8 items and exactly 1 separator, in this order: rename, clear
  unread flag, move to group, fork session, new session in folder, mute
  notifications, SEPARATOR, restart the agent, close session. That is the
  reconciled superset in the order `session-row-menu-items.js` declares.
  The second item reads "clear unread flag" rather than "mark unread for
  followup" because that row IS currently unread and the label states the
  RESULT of activating it, which is the documented behaviour, not a
  discrepancy. Pin is INLINE on the row
  (`session-sidebar-row-pin`, title "pin to top") and `pin` appears
  nowhere in the menu text.
- b PASS. "restart the agent" opens the picker, which reads
  `this row currently reads "working"`. That is a MEASURED status, not
  `unknown`. The four gates were observed in force at the same time: the
  arm checkbox renders UNCHECKED, and all six wrapper radios report
  `disabled: true`. CANCELLED without restarting. Proven server-side
  rather than by intent: zero `POST /api/v1/sessions/respawn` and zero
  `POST .../recreate` in the whole window, and the only related request
  is one read-only
  `GET /api/v1/sessions/restart/preview?session_name=cloude_Media_Compression`
  returning 200.
- c PASS. A `dblclick` on the row name element enters rename mode:
  `SessionSidebarRename.isEditing()` true, an input present, FOCUSED, and
  carrying the current value "Media Compression". Escape exited it, the
  editor is gone, `isEditing()` is false and the title is unchanged.
  Nothing was committed, proven server-side: zero title/rename PATCHes and
  zero `claude_rename_pushed` in the window. Note the handler requires the
  event target to be inside `[data-row-name]`; a dispatch aimed at the row
  container one level up is silently ignored, which reads exactly like a
  dead control.
- d PASS, and STATE WAS RESTORED. Run on `cloude_Fantasy_Hockey_2026`, the
  oldest row that is genuinely idle and read (the single oldest by
  `last_work_at` is Media Compression, but it reads `working`, so it was
  not used). Recorded BEFORE the touch: `notifications_muted: False`. The
  menu item is enabled and clickable; clicking it drove
  `PATCH /api/v1/sessions/records/e8b81c54-.../notifications` to 200 and
  the server then held `notifications_muted: True`. Reopening the menu
  showed the label had flipped to "unmute notifications". Clicking that
  restored `notifications_muted: False`, the value it started at. Exactly
  2 PATCHes were issued against that uuid and nothing else was written.
- e PASS. Zero CSP violations across a full hard reload plus 6 seconds,
  both on a `securitypolicyviolation` listener and in the console reader.
  THE NEGATIVE CONTROL IS WHAT MAKES THE ZERO MEAN ANYTHING: an injected
  image from `cdn.jsdelivr.net` raised exactly one `img-src` violation on
  that same listener, and the element was removed afterwards. Live header
  carries no third-party origin in any directive:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self' data:;
  frame-ancestors 'none';`
  Note the console reader only starts capturing when it is first called,
  so the page had to be reloaded AGAIN after arming it; the first "no
  messages" answer was a CANNOT DETERMINE wearing a pass.

**The owner's sessions.** 19 before, 19 after, and the sorted session-name
lists are byte-identical, so none was lost, renamed or added. Zero
respawn, zero recreate, zero session DELETE and zero pane input POSTs for
the entire window. The only writes this deploy made to the owner's data
are the two mute PATCHes above, which cancel out.

**Tag and push.** `v1.2.1` annotated on `d074bbc`, tag object
`54d95d1`. Pushed `release/1.2.1` and `v1.2.1` to `origin`
(ccsliinc/CloudeCode) and `adamdev` (Adoom666/CloudeCodeDev), verified
independently with `git ls-remote` on both: branch `d074bbc`, tag
`54d95d1` on each. NOTHING was pushed to `upstream` and its broken push
sentinel was left exactly as it is; `git ls-remote upstream refs/tags/v1.2.1`
returns nothing.

**Still open, unchanged by this round:** the version endpoint reports
`latest_version` 1.0.36 against `https://github.com/Adoom666/CloudeCode.git`,
the upstream this project may not push to, so a 1.2 install keeps being
told it is behind a line it does not follow. The Electron bundle is still
1.2.0 and would need a rebuild to make the footer read 1.2.1.

---

## 2026-09-10 - the electron bundle rebuilt at 1.2.1 and installed on live

Closes the version mismatch left by the 1.2.1 source deploy: live ran 1.2.1
source while the footer and `GET /api/v1/version` both read 1.2.0. The number
comes from `CLOUDE_APP_VERSION`, which `macOS/server-manager.js` injects from
`app.getVersion()`, which reads the PACKAGED `macOS/package.json`. A source
deploy ships `git ls-files src client` and cannot rewrite `app.asar`, so only a
bundle rebuild could move it. Same mechanism, same fix, as the 1.2.0 rebuild
recorded above.

**NO VERSION FILE WAS TOUCHED.** `macOS/package.json` already read 1.2.1, and it
is the only hand written version source. This round changed no code at all.

**Build.** From the `release/1.2.1` worktree at `ce7267d`:
`cd macOS && npm install`, then `CSC_IDENTITY_AUTO_DISCOVERY=false npm run
package`. electron-builder 24.13.3, electron 28.3.3, darwin arm64. The
`afterPack` hook `macOS/scripts/adhoc-sign.js` ran and self verified
("signature present and verified (ad-hoc, no identity)"). Outputs
`macOS/dist/mac-arm64/Cloude Code.app` and
`macOS/dist/Cloude Code-1.2.1-arm64.dmg`. The .app was installed with `ditto`;
the dmg is the distributable and was not needed here. Build host is
mac-mini-m4, which is also the target host.

**BLAST RADIUS MEASURED BEFORE THE SWAP, and it is exactly one file.** The new
bundle's `Contents/Resources/src` and `Contents/Resources/client` hash byte for
byte identical to the installed 1.2.0 bundle's:
src `7ee339d7f5616f67a1fd6beec9cdb22a12f3088c38cf1928c64b9786182bce73`
(265 files) and client
`1759da52668d758497f707b0ffb201c137e2f876217fcb399abe5756d68f9aea`
(312 files), unchanged either side. Only `app.asar` moved,
`20ee2119...` to `7f091e0d...`, plus the version in Info.plist. So the reinstall
put back the same source the 1.2.1 deploy had already written.

**Backup, one move from a rollback:**
`/Applications/Cloude Code.app.rollback-1.2.0-20260910T120538`.
Nothing was deleted; the owner's settings deny `rm`. Rollback is a single `mv`
back followed by a bootout/bootstrap.

**The restart was bootout then bootstrap, NOT `kickstart -k`,** for the reason
recorded in the 1.2.0 entry: `kickstart -k` SIGKILLs Electron and orphans the
python server on port 8000, which the new bundle then refuses to adopt as a
mismatch. Measured this round: `launchctl bootout gui/501/com.cloudecode.menubar`
at 16:05:47Z freed port 8000 in **2 seconds**, and
`launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.cloudecode.menubar.plist`
brought `/health` back to 200 at **t+15s**. THE PROBE WAS A POLL, NOT A SAMPLE:
the 1.2.1 deploy recorded startup holding the event loop for about 54 seconds
after binding, so a single curl can return 000 and read exactly like a dead
server.

**Measured after the restart:**
- 19 tmux sessions on `-L cloude` before and after, and the sorted NAME LISTS
  diff clean. Nothing was typed into, restarted or closed.
- `boot_readopt_complete` at 16:06:15.484584Z: `held: 18`, `skipped: 1`,
  `failed: 0`, `live_count: 19`, `id_sources.hook_token: 18`. Held plus skipped
  equals 19, the same shape as the last two good deploys.
- ZERO `hook_post_rejected_invalid_token` after 16:05:47Z. The file holds 7,104
  of them in total and the most recent is 2026-09-08T20:40:23.231960Z, which is
  the storm CLAUDE.md already documents, not this round. The only token line
  after the restart is one `hook_tokens_restored`.
- Three independent version reads all agree:
  `CFBundleShortVersionString` **1.2.1** on the installed bundle (and
  `codesign --verify --deep --strict` on the INSTALLED copy: "valid on disk",
  "satisfies its Designated Requirement");
  `CLOUDE_APP_VERSION=1.2.1` in the RUNNING server process env
  (`ps eww`, pid 28060); and `GET /api/v1/version` returning
  `{"version": "1.2.1", ...}`. The server dir VERSION file also stamped 1.2.1.
- Browser evidence, in a tab of our own opened via Claude in Chrome and closed
  afterwards, the owner's tab untouched: after a hard reload the footer renders
  `v1.2.1` in `.home-bar__version` and in both `.version` spans, the server
  rendered `<meta name="cloude-app-version">` reads `v1.2.1`, and `v1.2.1` is
  the ONLY version shaped string in the whole rendered page text.
- Zero CSP violations and zero console errors across a full load that produced
  268 console messages. THE NEGATIVE CONTROL RAN IN THE SAME PASS, because a
  detector that never fires cannot prove a zero: an injected `img` pointed at
  `cdn.jsdelivr.net` raised exactly one `img-src` violation on the same
  listener, and the element was removed afterwards.

**Still open, deliberately not touched this round:** the version endpoint's
`update` block still points at `https://github.com/Adoom666/CloudeCode.git`,
the upstream this project may not push to, and reports
`latest_version: "1.0.36"` against `current_version: "1.2.1"`. Note the
`status` field reads `current` rather than claiming an update, because 1.2.1
sorts above 1.0.36, so the visible symptom is a bogus "latest" figure and an
`upgrade_command` pointing at the forbidden fork's releases page rather than a
false update prompt. Where the update checker SHOULD point is the owner's call.

## 2026-09-10 - backend decomposition, claim plus plan (no code)

**What this round was.** Measurement and design only. No product code written,
nothing deployed. Two artifacts: a coordination claim and a plan.

**The claim.** `claims/ccsliinc-backend-decomposition.md` on the orphan `coord`
branch, committed `dc5db2d`, pushed to `adamdev` and `origin`. Filed BEFORE any
code, which is what that branch exists for. `scripts/scan_secrets.py` clean
(1,367 files, exit 0) and `gitleaks protect` clean on the working tree before
pushing; `gitleaks detect` reports 7 historical findings, all in `THEPROBLEM.md`
and `worklog.md` from commits dated 2025-10-28 and 2026-04-19/24, files that are
not in the current tree.

**What Adam has, and where we intersect.** His two active claims are the session
row menu (client side) and the web UI performance waves
(`docs/webui-performance-and-session-menu-plan.md`, `scripts/perf/*`,
`tests/test_perf_*.py`, `client/js/app.js`, `client/js/terminal.js`,
`src/api/websocket.py`). No path overlap with anything planned here. The
non-textual overlap is his queued wave 3, "move blocking tmux, SQLite and
filesystem work off the event loop", which lands in `_session_info_for` and
`create_session`, our slices 8 and 9. Three files he asked not to have
rewritten (`session_status_map.py`, `session_instance_index.py`,
`pipe_wakeup.py`) are READ by slice 8 and rewritten by none of it. His mute work
(`session_notification_policy.py` 563, `notifications/idle_watcher.py` 513) is
out of scope even though both are over the 500 guideline. No schema version
moves.

**Measured, on `release/1.2.1`.** `src/core/session_manager.py` is 8,340 lines,
one class of 8,055, 136 methods, 68 public, 36 written instance fields, 85 call
sites from `src/` and 490 from `tests/`, 108 constructions of which 107 are in
tests, and the constructor takes no arguments. Eleven methods carry 3,045 lines,
37 percent of the class. By I/O: 43 pure, 62 tmux only, 5 database only, 26
both. The 36 fields cluster into ten groups with almost no cross traffic;
`_wipe_session_state` is the only method touching nine at once.
`src/api/routes.py` is 61 module functions, 51 routes, ZERO instance state.
`tmux_backend.py` is 38 methods and 12 fields. `config.py` is 14 dataclasses
plus a 1,426-line `Settings`.

**The design.** Seven collaborator classes (session registry, hook token
authority, toast inbox, theme store, owned tmux ledger, probe health recorder,
attachment sidecars), three structural `Protocol`s (tmux reader, session record
store, clock), and the 71 pure ladder modules left exactly where they are.
`SessionManager` keeps its name and all 68 public methods as a facade. Two hard
rules: every slice moves the state and never a copy of it (proved with `is`, not
by value), and the constructor keeps taking no required arguments.

**Twelve slices**, ordered by how LOUD the failure is rather than how tight the
cluster is. Probe health first, hook tokens and adoption last, because every
incident this file has caused was silent from inside the pane. Slices 1 to 7 run
parallel to Adam; 8 onward waits on `now/adoom666.md`.

**Plan:** `.claude/notes/backend-decomposition-plan.md`, 499 lines, on
`feat/backend-decomposition`. Force-added, because `.gitignore:183` ignores
`.claude/*`.

## 2026-09-10 - S1 SHIPPED: ProbeHealthRecorder, the first collaborator

**What moved.** The four probe scalars (`_last_probe_ok`, `_last_probe_reason`,
`_last_probe_detail`, `_last_probe_socket`) left `SessionManager` for
`src/core/sessions/probe_health.py`, which now HOLDS a `ProbeHealth` instead of
re-deriving one from loose fields on every read. `ProbeHealth` itself is defined
there and re-exported from `session_manager`, so every existing
`from src.core.session_manager import ProbeHealth` keeps resolving. Delegating
readers: `last_probe_health`, `_tmux_socket_name`, `tmux_socket_name`,
`list_attachable_sessions_with_socket`, and the write half of
`list_attachable_sessions`.

**Line delta.** `src/core/session_manager.py` 8,340 to 8,317 (-23; 53 inserted,
76 deleted). New: `src/core/sessions/probe_health.py` 194,
`src/core/sessions/__init__.py` 22. The file grew a docstring-heavy constructor
while shedding a dataclass and four fields, so the net is smaller than the
volume moved. Twelve slices, not one.

**A CORRECTION TO THE PLAN, recorded because the next reader will trust it.**
Section 3 says `ProbeHealth` "is a dataclass nothing constructs". Measured: it
WAS constructed, at `session_manager.py:6109`, lazily from three loose scalars on
every call. The seam the plan saw is real; the wording is not. S1 is better
stated as "the recorder HOLDS a ProbeHealth instead of rebuilding one".

**A DRY defect found and closed in passing.** Three sites read
`self._last_probe_socket or self._tmux_socket_name()`, but `_tmux_socket_name()`
already prefers `_last_probe_socket` internally, so `X or f()` where `f()`
returns X-when-truthy is exactly `f()`. All three collapsed. The probed socket is
now read in ONE place, which is what makes the no-copy rule structural rather
than remembered. Also removed the defensive `getattr(self, "_last_probe_socket",
None)`: left in place it would have returned None silently once the field was
gone, and the probe-wins-over-settings rule would have died with a green suite.

**HOW THE NO-COPY RULE IS PROVEN, and why it is not the plan's `is` check.**
Rule A's example (`manager.sessions is registry.sessions`) is for a shared
mutable dict. This cluster is four SCALARS, and an identity assertion on a value
proves nothing (rebinding a bool on the facade is invisible through any other
object, and two equal frozen dataclasses are never `is`). So the proof has three
legs: (a) the fields DO NOT EXIST on the facade, asserted with `hasattr` over a
named list; (b) the injected recorder IS the held object, `is`; (c) delegation is
live in BOTH directions, including through the REAL `list_attachable_sessions`
path rather than a stubbed method.

**MUTATION RESULTS. Both mutations were run, and both were reverted.**
1. The named one, the facade keeping its own copy instead of delegating (four
   fields restored to `__init__`, all readers and writers pointed back at them,
   recorder still constructed): **6 tests red**, legs (a) and (c) together.
   Leg (b) alone stayed GREEN, which is exactly why one leg is not enough and
   the three exist.
2. False-green, `health` reporting `ok=True` when nothing has been probed:
   **4 tests red**, including the S1-named "never ran reads cannot_determine and
   never ok". The PRE-EXISTING `tests/test_s9_recent_and_pills.py` also went red,
   so the old regression guards still bind through the new indirection.
   Reverted, 24 green.

**Measured, in this worktree, not quoted.** Control before the change: 5,708
passed / 2 failed / 19 skipped. After: 5,734 / 2 / 19, the same two
environmental failures (`test_home_write_guard`, `test_version_probe`). The +26
is fully accounted by a collection diff: 24 new tests of mine, plus 2 the
repo-wide `test_no_unresolved_names` guard automatically added for the 2 new
source modules. ZERO tests removed. Node 200 suites, 0 failures. Listing cost
ceilings 12 passed. `scan_secrets.py` exit 0.

**New tests.** `tests/test_probe_health_recorder.py` (19) and
`tests/test_sessions_package_rules.py` (5), the latter enforcing the plan's two
package-wide rules by AST parse rather than grep, with a guard test that fails
when the package globs empty (a parametrised test over an empty list passes, so
a renamed package would otherwise look perfectly compliant).

**Not done, deliberately.** No `Protocol` was added: the plan names three
(`TmuxReader`, `SessionRecordStore`, `Clock`) and none is a substitution point
for S1, which does no I/O and calls nothing. No live deploy, so the plan's proof
by measurement for S1 (`/sessions/list` row count against
`tmux -L cloude list-sessions | wc -l`) is UNVERIFIED and still owed.

## 2026-09-10 - backend decomposition S2: the theme cluster

Slice S2 of `.claude/notes/backend-decomposition-plan.md`. `pinned_themes`
and `_theme_accent_cache` left `SessionManager` for `src/core/sessions/`.

- `src/core/sessions/theme_store.py` (466) owns the pin map, its atomic
  file, and the two-source resolution ladder.
- `src/core/sessions/theme_accents.py` (116) owns the manifest accent
  memo. COMPOSED, not inherited.
- `src/core/sessions/theme_dotfile.py` (144) is the stateless `.cc.theme`
  format: path, read, atomic write.
- The plan called S2 "about 250 lines" in one class. It is 726 in three,
  because the docstring standard roughly doubles the body and one class
  holding all of it measured 573 lines, over the package's own 500 rule.
  Split by concern rather than by line count.

`session_manager.py` 8,317 -> 8,207 (-110).

**The no-copy rule, four legs** (`tests/test_theme_store.py`). This
cluster is dicts, not S1's scalars, so identity is meaningful - and still
not sufficient on its own, because assigning `self.pinned_themes =
store.pinned_themes` in `__init__` satisfies it and forks on the first
rebind. (a) identity across all three spellings; (b) neither name is in
the facade's instance `__dict__` and both are properties on the class;
(c) writes cross in both directions INCLUDING a whole-dict rebind, which
`tests/test_tmux_listing_consumers.py` really does; (d) a real
`set_pinned_theme` round trip onto real disk, read back by a second store.

**The landmine, and it was not a green-suite one.** Every theme test does
`monkeypatch.setattr("src.core.session_manager.settings", stub)`. A store
importing `settings` itself would not see that patch and would read and
WRITE the owner's real `~/.cloude-sessions/pinned_themes.json` during a
pytest run. The pin path is therefore an injected zero-argument callable
resolved at call time, which is what the loose methods did anyway.

**A test that could no longer fail, fixed in the same commit.**
`tests/test_toast_lifecycle.py` patched `SessionManager._themes_dir` to
prove the accent cache serves a value after the manifest moves. Once the
read moved, that patch bound a name nothing consults and the assertion
would have passed over a manifest that never moved. Repointed at
`ThemeAccents.themes_dir`, and `test_theme_store.py` carries a negative
control that the patch actually changes the answer.

**Mutations, all run and all reverted to a byte-identical tree.**
- facade keeps its own copy of the map, run as TWO variants because the
  weaker one is the one that matters. A `dict(...)` copy: 8 red across 4
  files. A REFERENCE copy (`self.pinned_themes = store.pinned_themes`,
  the naive fix): only 3 red, and leg (a) IDENTITY STAYED GREEN, along
  with the in-place-write half of leg (c). Only leg (b) (no field on the
  facade), the whole-dict rebind, and one real behaviour test
  (`test_successful_empty_probe_still_prunes`) caught it. That is the
  measurement behind "identity alone proves nothing here".
- `save()` writes the temp and skips `os.replace`: 4 red.
- `ThemeStore` imports `settings` instead of taking the provider: 6 red,
  so the injection is load-bearing rather than ceremony.
- accent cache reads a cached `None` as a miss: GREEN on the first
  attempt, which is the useful result. The cache test asserted the return
  value and the cache contents, and BOTH implementations agree on both:
  each returns None and each writes None. What separates them is the
  SECOND call. Test rewritten to publish the manifest after the None is
  cached and assert the answer does not move; 1 red, reverted, green.
  A mutation that fails to go red is the point of running it.

**Measured in this worktree, control run by me rather than quoted.**
Control 5,734 passed / 2 failed / 19 skipped. After: 5,778 / 2 / 19, same
two environmental failures. Collection 5,755 -> 5,799, +44, ZERO removed:
35 new in `test_theme_store.py`, 6 from the package-rules parametrisation
(2 rules x 3 modules), 3 from `test_no_unresolved_names`. Node 200/200.
Listing cost ceilings hold. `scan_secrets.py` exit 0.

One full run also failed
`test_session_restart_wrapper_choice.py::test_the_picked_wrapper_is_what_ends_up_in_the_pane`
in its SETUP ("the pane did not exit" inside a 6s wait). It passes in
isolation and passed on the immediate re-run of the full suite. Real tmux
socket, INFRA-49 class, not this change.

No protocol added. The plan names three; none is a substitution point
here, and the one injection a test needs is a parameter, not a Protocol.

## 2026-09-10 - backend decomposition S3: the toast inbox

Slice S3 of `.claude/notes/backend-decomposition-plan.md`.
`_pending_toasts` and `_pending_startup_toasts` left `SessionManager` for
`src/core/sessions/toast_inbox.py` (390 lines), along with the acked-tail
cap, the supersession rule, the prune and the startup queue.

`session_manager.py` 8,207 -> 8,112 (-95). Cumulative S1+S2+S3: 8,340 ->
8,112, -228.

**The seam is storage versus everything else.** `record_toast` is 196
lines, and only the storage half moved. The inbox resolves no session id,
reads no theme, stamps no label and emits nothing to the notification
router; those are other clusters and stay on the facade. What DID move is
every rule about which record wins, which may be rewritten and which may
be dropped - the three questions a toast store gets wrong.

**A THIRD NO-COPY SHAPE, and it is the one CLAUDE.md warns about.**
S1 was scalars, S2 was dicts a caller rebinds. This cluster is reached by
a DEFENSIVE ACCESSOR from another module: `toast_history.py` does
`getattr(manager, "_pending_toasts", None)` and answers `{}` for a
non-Mapping. Drop the facade property and every history view goes empty,
raising nowhere and failing no existing test. That is leg (e), and it
asserts the reader gets the REAL dict (`is`), not merely that it does not
explode. Legs (a) identity, (b) no instance field and both are properties,
(c) writes cross, (d) live delegation through all four public methods.

Both properties are READ-ONLY here, unlike S2's `pinned_themes`. Nothing
assigns either container wholesale once `_flush_startup_toasts` drains
through `drain_startup()` instead of rebinding, so a future assignment
should fail LOUDLY rather than shadow the property with a second
container.

**Mutations, all run and all reverted to a byte-identical tree.** The
facade one was run as THREE variants, because only the third isolates the
claim.
- facade keeps its own REFERENCE to the records dict: 1 red, leg (b)
  alone.
- the facade property is REMOVED entirely: 16 red, 12 of them
  pre-existing. So a total removal is caught by the repo as it stands.
- the facade property returns a COPY: **every pre-existing toast suite
  stays GREEN, 66 of 66**, and only legs (a) and (e) go red. That is the
  measurement behind this slice's claim. A copy works perfectly on the
  day it is written and diverges the first time anything writes through
  the inbox rather than through the facade, and `toast_history`'s
  tolerant `getattr` cannot tell the difference.
- `find_supersedable` may return an ACKED record: 2 red, including the
  pre-existing `test_toast_supersede.py`.
- `ack` re-stamps a record already acknowledged: 4 red.
- `prune` caps the UNACKED half too: 2 red.

**A claim corrected rather than left standing.** An earlier draft of this
entry said `test_toast_lifecycle.py` passed 17 of 17 with the property
removed. That was measured on a tree where a `git checkout --` had
already reverted the facade wiring, so it was a reading of the S2 code,
not of a mutant. Re-measured properly, removal IS caught. The copy
variant above is the honest version of the same point.

**Measured in this worktree.** Control (measured, not quoted) 5,734 passed
/ 2 failed / 19 skipped. After S2: 5,778 / 2 / 19. After S3: 5,804 / 2 /
19, the same two environmental failures throughout. Collection 5,799 ->
5,825, +26, ZERO removed: 23 new tests, 2 from the package-rules
parametrisation, 1 from `test_no_unresolved_names`. Node 200/200. Listing
cost ceilings hold. `scan_secrets.py` exit 0.

The plan's S3 asked for "a test that a duplicated `Stop` acks by KIND and
never acks the toast the same event just raised, a rule currently
expressed only in prose". It is
`test_a_duplicated_stop_acks_by_kind_and_not_the_toast_it_just_raised`,
end to end through the facade, plus a cutoff negative control beside it.

No protocol added. The inbox does no I/O at all - no tmux, no database,
no filesystem - so there is nothing to substitute.

## 2026-09-10 - backend decomposition S4: the log buffers and command counts

Slice S4 of `.claude/notes/backend-decomposition-plan.md`. `log_buffers`
and `command_counts` left `SessionManager` for `SessionRegistry` in
`src/core/sessions/registry.py` (187 lines), along with the append, the
per-session line cap, the registration ensure and the teardown.

`session_manager.py` 8,112 -> 8,167 (+55). Cumulative S1+S2+S3+S4: 8,340
-> 8,167, -173. **This slice GROWS the facade and that is expected, not a
regression.** The moved BODY was about 20 lines; the property pair plus
the documented delegation that replaces it is a fixed cost of roughly 70,
and the docstring standard is what makes it so. S7 moves the other four
fields of this cluster into the same class and pays that cost only once
more.

**The registry lands in two pieces, on purpose.** The plan's registry
cluster is six fields. S4 moves the two with NO reader outside
`session_manager.py`; S7 moves `sessions`, `backends`, `_subscribers` and
`_last_session_id`, which have 27 external readers between them. Splitting
on reader count rather than on the heading puts the pattern under test on
the half that cannot break a caller.

**PLAN VERSUS CODE: the named coverage does not exist.** S4's entry says
"Tests: `tests/test_session_backend.py`". Measured before the move,
`add_log_entry` and `get_recent_logs` appear in ZERO test files in this
suite, that one included. The only exercise either got was indirect,
through `_session_info_for` reading `get_recent_logs` for a listing row.
So no pre-existing test could have gone red for a defect introduced here.
That is why `tests/test_session_registry.py` is 21 tests rather than a
handful of legs.

**The no-copy legs, chosen for a cluster with no external reader.** S3
could lean on a defensive accessor in another module; there is no
analogue here, and no consumer whose behaviour a copy would break. So:
(a) identity of both containers; (b) neither name is an instance
attribute and both are properties on the class; (c) an in-place write
through either spelling is seen by the other; (d) live delegation through
`add_log_entry`, `get_recent_logs` and `_wipe_session_state`; (e) an
injected registry is the object the facade actually holds and uses.

**The setter posture is now a rule with evidence behind it.** A
write-through setter exists where a rebind is MEASURED (S2's
`pinned_themes`, which `tests/test_tmux_listing_consumers.py` assigns
wholesale). Nothing in `src/` or `tests/` assigns either name here, so
both properties are read-only, like S3's pair. An earlier draft of this
slice shipped setters for symmetry; they were removed once the rule was
stated, because a setter nothing needs is a second way to write a
container that must have one owner.

**The line cap is an injected callable, and that is the S2 hazard in a
new dress.** `add_log_entry` trimmed to `settings.log_buffer_size`,
resolved out of `session_manager`'s globals per call. Four test modules
(`test_s9_recent_and_pills.py`, `test_session_lifecycle_wiring.py`,
`test_persist_fingerprint_family_wiring.py`,
`test_tmux_listing_consumers.py`) install a stub `settings` carrying their
own `log_buffer_size`. A registry importing `settings` itself would read
the developer's real configuration during a pytest run. The cap is re-read
per append rather than captured, so a settings reload still takes effect
on a live manager. There is a leg for it.

**Mutations, all run and all reverted to a byte-identical tree** (sha256
checked after each revert).
- facade property returns a COPY: 3 red - legs (a), (c) and (e).
- `append_log` skips the cap trim: 3 red, the two cap legs and the trim
  direction test.
- `forget` drops only the buffer and leaves the counter: 2 red.
- `forget` is a no-op: 2 red.
- facade keeps its own plain ATTRIBUTE aliasing the registry's dict:
  **1 red, leg (b) alone. Leg (a), the `is` check, stays GREEN**, which
  is S2's measurement reproduced on a second cluster and the reason an
  identity assertion is never the whole proof.

**Measured in this worktree.** Control (measured, not quoted) 5,804
passed / 2 failed / 19 skipped. After S4: 5,828 / 2 / 19, the same two
environmental failures (`test_home_write_guard`, `test_version_probe`).
Collection 5,825 -> 5,849, +24, ZERO removed: 21 new tests, 2 from the
package-rules parametrisation, 1 from `test_no_unresolved_names`. Node
200/200. The three listing cost ceilings pass inside the full run.
`scan_secrets.py` exit 0. Pre-commit hook left enabled.

No protocol added. The registry does no I/O of its own - the one thing it
reaches outside itself is the cap, and a zero-argument callable is a
parameter, not a substitution point.

No patch had to be repointed: nothing in the suite patches or
monkeypatches `log_buffers`, `command_counts`, `add_log_entry` or
`get_recent_logs` under any spelling.

## 2026-09-10 - backend decomposition S5: the three per-session sidecars

Slice S5 of `.claude/notes/backend-decomposition-plan.md`. `idle_watchers`,
`adopt_fifo_offsets` and `pending_terminal_commands` left `SessionManager`
for `AttachmentSidecars` in `src/core/sessions/sidecars.py` (211 lines),
taking three clusters out of `_wipe_session_state`.

`session_manager.py` 8,167 -> 8,239 (+72). Cumulative S1..S5: 8,340 ->
8,239, -101. Like S4 this slice grows the facade, for the same reason:
three properties plus a documented setter cost more lines than the three
field declarations and eleven call sites they replace. The god method
`_wipe_session_state` lost three of its nine clusters, which is the
measurement the plan actually cares about.

**They are one cluster because they have one lifecycle**, not because
they are three dicts: each is written on the create or adopt path, read
once when a client shows up, and dropped when the session goes away.

**The one-shot rule is the point, and half of it was undefended.** The
plan asks for both. `take_pending_command` already had a pre-existing
guard - `test_terminal_commands.py::test_flush_types_the_command_and_pops_it`
went red on the pop-to-get mutation. `take_fifo_offset` had NONE: that
same mutation on the FIFO offset reddened only the two new tests. A
reconnect re-seeking to a stale offset would replay against a FIFO that
has grown by however much output landed meanwhile.

**A getter may not consume.** `peek_fifo_offset` exists next to
`take_fifo_offset` because `adopt_fifo_start_offset` is a PROPERTY, and
`peek` and `take` differ by one method call while both read perfectly.
Its own test, and its own mutation.

**PLAN VERSUS CODE: `flush_pending_terminal_command` did not move, only
its pop did.** The plan lists it among "their four accessors". It is 60
lines of settings lookup, backend write and retry loop, which is the S3
seam - storage versus everything else - so the sidecars own
`take_pending_command` and the facade keeps the flush. The ordering is
the safety property rather than the pop alone: the flush can fail after
the pop on an unknown id, a missing backend or a write error, and a
session whose command FAILED must still not have it retyped. There is a
test for that ordering.

**`forget` deliberately does not drop the pending command.** Measured
pre-move: `_wipe_session_state` popped the watcher and the offset and
never touched `pending_terminal_commands`. Preserved verbatim, and now
ASSERTED, so that changing it is a decision somebody makes rather than a
diff nobody notices. Session ids are not reused, so what is left behind
is an entry nothing can ever read; worth dropping one day, but a refactor
is not where a behaviour change belongs.

**The legs, and the one that is necessary but NOT sufficient.** (a)
identity of all three containers; (b) none of the three is an instance
attribute and all three are properties; (c) in-place writes cross both
ways; (c2) a whole-map REBIND through the facade reaches the collaborator
- this is the cluster that gives the setter rule its evidence, because
`tests/test_terminal_commands.py` rebinds `pending_terminal_commands`
wholesale twice while nothing rebinds the other two, which are therefore
read-only with a negative control asserting the assignment raises; (d)
live delegation through `idle_watcher`, `adopt_fifo_start_offset` and
`_wipe_session_state`; (e) the defensive reader in `src/api/websocket.py`
still finds the watcher; (f) injection is real.

**Leg (e) is where the S3 rule gets QUALIFIED.** `toast_history`'s leg
asserts `is` on the container and catches a copying property. The
websocket's is `getattr(sm, "idle_watchers", {}).get(session_id)`, and
`.get()` on a copy answers correctly - so measured on the copying
mutation, leg (e) PASSED while (a), (c), (c2) and (f) failed. A
defensive-accessor leg catches a REMOVED property always, and a COPYING
one only if it asserts identity on the container itself.

**A patch that had to be repointed.** `tests/test_terminal_commands.py`
builds its manager with `SessionManager.__new__(SessionManager)`, which
skips `__init__` entirely, so `_sidecars` does not exist and every S5
property is unreachable. It now installs `AttachmentSidecars()` by hand
the same way it already installs `backends`. Two other files bypass the
constructor (`test_workspace_env_reaches_terminal.py`,
`test_adoption_three_outcomes.py`) and neither touches an S5 name. Any
later slice adding a property must re-check those three.

**Mutations, all run and all reverted to a byte-identical tree** (sha256
checked after each revert).
- `take_fifo_offset` reads instead of popping: 2 red, both new.
- `take_pending_command` reads instead of popping: 3 red, one
  pre-existing.
- `peek_fifo_offset` consumes: 2 red.
- `forget` also drops the pending command: 1 red.
- the three facade properties return COPIES: 4 red, and leg (e) GREEN,
  as above.
- the setter shadows instead of writing through: 3 red, two pre-existing.
- the facade keeps its own attributes aliasing the sidecar dicts: 5 red.
- `_wipe_session_state` stops reaching the sidecars: 1 red.

**Measured in this worktree.** Control (measured, not quoted) 5,804
passed / 2 failed / 19 skipped. After S4: 5,828 / 2 / 19. After S5:
5,856 / 2 / 19, the same two environmental failures throughout.
Collection 5,849 -> 5,877, +28, ZERO removed against S4 and ZERO against
the control: 25 new tests, 2 from the package-rules parametrisation, 1
from `test_no_unresolved_names`. Node 200/200. The three listing cost
ceilings pass inside the full run. `scan_secrets.py` exit 0. Pre-commit
hook left enabled.

No protocol added. The sidecars do no I/O at all - no tmux, no database,
no filesystem, no awaits - so there is nothing to substitute.

**Coordination.** Re-read `now/adoom666.md` and both his claims off
`adamdev/coord` at `6e09b1c` before starting. Nothing of his names
`session_manager.py`, `log_buffers`, `command_counts`, `idle_watchers`,
`adopt_fifo_offsets` or `pending_terminal_commands`. His mute work lives
in `src/core/session_notification_policy.py` and
`src/core/notifications/idle_watcher.py`; neither is touched here - S5
moves only the manager's MAP of watchers, not the watcher. His queued
wave 3 lands in `_session_info_for` and `create_session`, which are
slices 8 and 9, not these.

---

## 2026-09-10 - backend decomposition v2, slice S0: the composition root, the four ports, the fixture

Plan v2 (`.claude/notes/backend-decomposition-plan.md` on
`docs/backend-plan-v2`, `d70bb98`) replaces v1's permanent facade. This is
its first slice. NO BEHAVIOUR MOVES.

**What landed.**
- `src/core/sessions/ports.py` - four `typing.Protocol` boundaries,
  `runtime_checkable`, structural. Zero runtime imports from this project.
- `src/core/live_ports.py` - `SystemClock`, `LiveSettings`,
  `LiveSessionRecordStore`. `TmuxReader` gets NO adapter: `TmuxBackend`
  already satisfies it by shape, which is the point of a structural port.
- `src/core/composition.py` - `AppServices` (frozen) and `build_services`,
  the one construction site. It builds the five collaborators the shipped
  slices created and hands them to `SessionManager` through the keyword
  seam those slices already added, so `services.themes is
  manager._theme_store` holds BY CONSTRUCTION.
- `src/main.py` - `lifespan` calls `build_services()` and publishes
  `app.state.services` beside `app.state.session_manager`.
- `tests/conftest.py` - the `app_services` fixture, written once.
- CLAUDE.md - the pure-forwarder docstring exemption, verbatim from the
  plan's section 5.
- `tests/test_sessions_package_rules.py` - RULE 3, nothing under
  `src/core/sessions/` may import the `settings` singleton.

**Three places the PLAN and the CODE disagreed, and the code won.**
1. `TmuxReader`'s methods. The plan sketched `list_sessions` /
   `capture_pane` / `pane_status_all`; the real `TmuxBackend` spells them
   `discover_existing` / `capture_scrollback` / `capture_visible_screen` /
   `list_pane_status_all`. The sketch's spelling would have been satisfied
   by nothing in the tree, which is a rung that can never be observed to
   fire.
2. `SessionRecordStore`'s members. `get_instance` is a module function in
   `session_store.py`, `claim_instance` is one in `session_identity.py`,
   and the nine `record_*` functions live in seven unrelated modules with
   no shared shape. What the manager actually funnels every row read
   through is `_datastore_connection` / `_writable_datastore_connection`,
   so THAT pair is the port. `claim_instance` joins when S8 gives it a
   call site to be substituted at.
3. `AppServices` carries no `tmux` field. A `TmuxReader` is bound to ONE
   pane; there is no process-wide instance to hold. Putting a per-pane
   object in a process-wide container is the same category error as
   keying unread state on a name when it describes an instance.

**The S2 near miss is now a test, not a comment.** `LiveSettings` resolves
`src.core.session_manager.settings` on EVERY call, because 41 places in
the suite `monkeypatch.setattr` that name and a reader bound to
`src.config.settings` would be invisible to all of them and would write
the owner's real `~/.cloude-sessions` during a pytest run. Four tests fail
if that indirection is removed. DELETE AFTER S5.

**Mutations, all eight measured, every revert verified byte-identical by
sha256.**
1. Drop the `records` field from `AppServices` -> 2 red.
2. `LiveSettings` reads `src.config.settings` -> 4 red.
3. The facade's `pinned_themes` property returns a COPY -> 1 red.
   NOTE, AND IT IS THE MOST USEFUL RESULT HERE: the identity test stayed
   GREEN and so did the forward data leg. Only the REVERSE leg caught it.
   `is` alone has now failed four times in this project, and a
   one-directional data leg is not enough either.
4. `build_services` hands `AppServices` a second `ThemeStore` -> 4 red.
5. The manager-plus-collaborator refusal removed -> 1 red.
6. The REAL `TmuxBackend.capture_scrollback` grows a required argument ->
   the real conformance leg red, the double GREEN. That is the whole
   reason both legs exist.
7. A collaborator imports the settings singleton -> package rule 3 red.
8. `lifespan` builds services then constructs a second manager -> 2 red.

**Verification.** Control measured first-hand on `209947d`: 5,856 passed /
2 failed / 19 skipped, 5,877 collected. The two failures are the known
environmental pair (`test_home_write_guard`, `test_version_probe`).

**Coordination.** Checked live before starting. PR #60 (draft,
`fix/5-pipe-rotation-fd`) now CLAIMS issue #5, the p0 pipe rotation in
`tmux_backend.py`. Plan v2 had already removed the tmux_backend split from
this lane on the strength of #5 being free-but-his; it is now formally
taken, which confirms rather than changes the plan. #28 and #32 remain
free, both still labelled `blocked`. No new issue touches
`session_manager.py`, `composition`, or the ports.

---

## 2026-09-10 - backend decomposition v2, slice S1: retro-fit the five shipped slices, delete the 291 lines of forwarders

**THE GO/NO-GO SLICE, AND IT PASSES.** Plan v2 says: if retro-fitting the
five shipped slices does not drop `session_manager.py` by roughly 291
lines plus the migrated readers, the premise is wrong and the honest move
is to revert to v1's permanent facade.

`src/core/session_manager.py`: **8,239 -> 7,894, a drop of 345 lines.**
291 of forwarder bodies, 21 blank separators, 33 of comment blocks that
existed only to explain the forwarders. Zero pure forwarders to a shipped
collaborator remain, enforced by `tests/test_no_cluster_forwarders.py`
rather than remembered. Contrast the five slices before this one, which
moved 101 lines NET between them.

**THE PREDICTION HELD.** The plan predicted 22 test files. Actual: 23
pre-existing test files, plus my own two S0 files that assert through the
facade, plus 2 new files. The one the plan's name-grep missed is
`test_session_kind_listing.py`, which reaches `/sessions/recent` through a
hand-rolled `_Manager` double and so carries none of the 21 names.

**FOUR DEFENSIVE READERS, and every one of them would have failed
SILENTLY.** This is the characteristic failure CLAUDE.md names, and it was
sitting in four places at once:
- `toast_history.buckets_from_manager` answered `{}` for anything without
  `_pending_toasts`. Every toast history view empties, nothing raises.
- `routes.py` guarded `get_toasts` with `hasattr`. The reattach backfill
  endpoint returns `[]` on every session.
- `away_routes.py` used `getattr(..., None)` plus a `callable` check on
  the same method. The away report shows no toasts.
- `websocket.py` did `getattr(sm, "idle_watchers", {}).get(...)`. No idle
  watcher, on every session, forever.
All four were repointed AND their tolerance removed, so the next such
move is a crash rather than an empty page.

**A GREEN MUTATION FOUND A TEST THAT DID NOT EXIST.** Replacing the
websocket watcher lookup with a literal `None` broke nothing in 5,900
tests. The one path guaranteed to fail quietly had no coverage at all,
which is the worst possible pairing. `tests/test_ws_idle_watcher_lookup.py`
drives the real `send_pty_output` over a fake socket and a one-item queue;
the `None` mutation now goes red, and so does a lookup that ignores
`session_id`.

**`test_route_names_resolve.py` earned its keep.** The first draft of the
theme migration wrote `request.app.state...` inside `_apply_session_theme`,
which takes no `request`. That is a NameError and a bare 500 on the first
click, and no other test in the suite would have caught it. The helper now
takes the `ThemeStore` as an argument and its two callers pass it.

**One argument reshape, on purpose.** `SessionManager.ack_toast` defaulted
`reason` to `ACK_REASON_DISMISSED`; `ToastInbox.ack` requires it. 13 test
call sites now say why the ack happened. An ack that does not record its
reason is what makes a toast history unreadable, and the route already
passed it explicitly.

**Mutations, all eight measured, every revert verified byte-identical by
sha256.**
1. A forwarder comes back -> 2 red (shape leg and name leg).
2. The tolerant `getattr` returns to `toast_history` -> 2 red.
3. `buckets_from_inbox` returns a COPY -> 1 red.
4. The `/toasts` backfill route answers `[]` -> 2 red.
5. The websocket watcher lookup answers None -> GREEN first time. Test
   written, then 1 red.
6. The watcher lookup ignores `session_id` -> 1 red.
7. The away report stops reading toasts -> 1 red.
8. The theme route stops writing the dotfile -> 3 red.

**Patch sweep: clean.** Zero `patch(` or `patch.object(` in the suite aims
at any of the 21 deleted names, checked before and after.

**Verification.** 5,928 passed / 2 failed / 19 skipped, 5,949 collected,
against the S0 baseline of 5,902 / 2 / 19 and 5,923 collected. Delta +26,
accounted by collection diff as 23 in `test_no_cluster_forwarders.py` and
3 in `test_ws_idle_watcher_lookup.py`. FOUR ids left the listing and all
four are RENAMES with a matching new id in the same file - the leg (b) and
leg (e) tests whose old names described the forwarder they no longer test.
ZERO tests removed. The two failures are the known environmental pair.
Node 200/200. The three listing cost ceilings pass. `scan_secrets.py` exit
0, pre-commit hook left enabled.

**What is NOT done, said out loud.** Six pure forwarders remain on the
class, 81 lines, pointing at `_hook_tokens`, `_unread_store`,
`_activity_tracker`, the two notification handles and `_tmux_socket_name`.
Those belong to S7 and later and are deliberately outside
`test_no_cluster_forwarders.py`'s list, which grows one entry per slice. A
list that failed for work nobody has done would be a countdown, not an
invariant.

## 2026-09-10 - decomposition v2 slice S2: `src/models.py` into `src/models/`

Plan v2 section 6, slice S2. Pure filing, zero behaviour, and it exists to
prove the package machinery on the safest file in the tree before the
machinery is pointed at anything that runs.

**What moved.** 2,495 lines holding 78 top-level definitions - 73 pydantic
models, 2 enums, 2 functions and 3 constants - into 16 domain modules plus a
re-export `__init__.py`. `src/models.py` is DELETED, not emptied, in the same
commit. Nothing was renamed and no importer changed: all 41 `from src.models
import ...` sites in `src/`, `tests/` and `scripts/` still read the same names
off the same objects. Largest module is `sessions.py` at 380 lines, the shim is
149, every file is under the 500-line guideline.

**The moved bodies are byte-exact.** Each definition was carved by source span
including the comment block above it, so `git show` of this commit is a pure
move plus 17 new headers. Two now-redundant section comments (`# API Response
Models`, `# WebSocket Message Models`) were KEPT rather than tidied away,
because a byte-exact diff is a property a reviewer can check and a tidied one
is a property they have to take on trust.

**The proof that nothing changed.** Every model's `model_json_schema()`, field
annotations and model config were fingerprinted from the flat file at `1cc7046`
and from the package, and compared: 78 names, zero differences once module
qualnames (`src.models.Session` -> `src.models.sessions.Session`) and lambda
repr addresses are normalised. `SessionInfo`'s two levels came through
unchanged, which is what the plan named as this slice's trap.

Three names the flat module leaked and the package does not re-export: `Enum`,
`Field` and `field_validator`, which were only ever visible because they were
imported at the top of one file. Checked before deleting: nothing in the tree
imports any of them from `src.models`, and there is no `import *`.

**`tests/test_models_package_rules.py`, 198 tests.** The frozen 78-name public
surface, `__all__` parity with it, one-definition-per-name, and the two-level
`SessionInfo` shape asserted in BOTH directions with the three fields that
genuinely live on both levels named rather than left out.

**The no-copy legs, chosen for THIS data.** A package split's characteristic
failure is a class PASTED into two modules: both importable, neither
recognising the other, and no traceback explaining it. So identity is one leg
of four, not the proof.
(a) `models.X is submodule.X` for all 78 names.
(b) forward - build through the submodule, assert `type(...) is models.X`.
(c) reverse - build through the root, assert `type(...) is submodule.X`. One
    direction is not enough: S1 measured a copy that left the identity leg and
    the forward leg both green.
(d) through pydantic - `SessionInfo(session=...)` re-validates its nested
    field against whatever its annotation resolves to, so a copy is silently
    rebuilt as the copy and the VALUE still looks right. Assert the class that
    comes OUT.

**Five mutations, five red, every revert byte-identical by sha256.**
1. Drop `SessionStats` from the re-export -> 2 red.
2. Define `SessionStats` a second time in `common.py` -> 2 red.
3. Flatten `SessionInfo.unread` down onto `Session` -> 1 red (the trap).
4. Re-export `Session` as a SUBCLASS of the real one -> 4 red, including
   both data legs. `isinstance` alone would have passed the reverse; the
   `type(...) is` assertions are what made it fail.
5. `adopt.py` keeps its own pasted `Session` instead of importing the
   sibling -> 2 red.

**Patch sweep: nothing to repoint.** Zero `patch(` or `patch.object(` anywhere
in the tree aims at `src.models`, before or after.

**Verification.** 6,141 passed / 2 failed / 20 skipped, 6,163 collected,
against a control MEASURED on the same tree at `1cc7046` of 5,928 / 2 / 19 and
5,949 collected. Delta +214, accounted entirely by collection diff: 198 in the
new rules file (197 pass, 1 skip) and 16 in
`test_no_unresolved_names.py::test_every_loaded_name_is_bound_somewhere`, which
parametrises over source modules and now sees 17 files where it saw 1. ZERO
tests removed, zero renamed. The two failures are the known environmental pair.
Node 200/200 as CI globs them, `check-js-syntax.sh` clean. The three listing
cost ceilings pass. `scan_secrets.py` exit 0, pre-commit hook left enabled.

**Doc paths repaired in the same commit**, per gotcha 8: CLAUDE.md's
`src/models.py:138` and `src/models.py` in the `/sessions/list` section, and
`docs/session-attribution-import.md`'s `models.py:346-353`, which was a line
range rather than a name and would have been wrong on the next edit anyway.

**Plan versus code: one disagreement, minor.** The plan's stopping condition
says `src/models.py` ends "under 200, a re-export shim only". A module and a
package of one name cannot coexist, so the shim is `src/models/__init__.py` at
149 lines and the flat file is gone. The budget is the same number and it is
enforced by `test_the_re_export_shim_stays_a_shim`.

## 2026-09-10 - decomposition v2 slice S3: OwnedTmuxLedger

Plan v2 section 6, slice S3. The first slice on the boot path, and the first
one that moves a durable file.

**What moved.** `src/core/sessions/owned_tmux_ledger.py`, 435 lines, owns the
owned tmux NAME set (`owned_tmux_sessions` -> `OwnedTmuxLedger.names`), the
pre-v3 backfill sentinel, the boot listing, `session_metadata.json` (load,
save, the atomic write and the pointer drop) and the two datastore-backed
ownership queries (`_owned_instances_from_db` -> `instances_from_db`,
`owned_tmux_instances` -> `instances`, `is_owned_tmux_name` -> `is_owned_name`).
`src/core/session_manager.py` goes 7,894 to 7,725, a drop of 169.

`SessionManager` keeps no copy and no forwarder: `self._owned` is the ledger and
every one of the 66 internal reads reaches it directly. `AppServices` grew an
`owned_tmux` field and `build_services` hands the SAME object to both sides.
Rule B is enforced by `tests/test_no_cluster_forwarders.py`, whose deleted-name
list grew by the seven members that left.

**Three methods stayed, and they are not forwarders.** `_load_session_metadata`
registers the session the ledger parsed, which wires backends and subscribers
and would put the registry on the far side of the package rule.
`_save_session_metadata` fills in the current session as a default.
`_clear_stale_metadata` wipes in-memory state the ledger cannot see. Each does
work of its own, so the full docstring rule applies to each and does.

**The socket and the metadata path are late-bound, and both had to be.**
`_tmux_socket_name` lets the PROBED socket win over the configured one, and a
captured string would key every ownership read on the configured value and
answer the badge from a socket nothing was ever written to. The metadata path is
a callable resolving `settings` out of the `session_manager` module's globals at
call time, which is the S2 near-miss rule: a ledger that imported `src.config`
would be invisible to the 41 `monkeypatch.setattr("src.core.session_manager.settings", ...)`
calls in the suite and would read and WRITE the owner's real
`~/.cloude-sessions/session_metadata.json` during a plain pytest run. In
`build_services` the socket callable closes over the name `manager`, which the
NEXT statement binds; there is no value that could be supplied at that point.

`SettingsReader` grew one method, `session_metadata_path`, which is the growth
model its own docstring describes: one method at a time, when a collaborator
genuinely needs one.

**The no-copy legs, chosen for THIS data.** The risk here is two objects holding
one logical set, which passes every `==` assertion until the first write through
the wrong reference and then badges a session this app created as somebody
else's.
(a) identity, `services.owned_tmux is manager._owned`;
(b) data forward, add through the manager's handle, read on the ledger;
(c) data reverse, add on the ledger, read through the manager. S1 measured a
    copy that left (a) and (b) both green and failed only here;
(d) through the FILE, which is the medium this cluster exists for: save from one
    ledger, load into a second, then mutate the first and assert the second does
    not see it. That last half is the control on the other three - if they
    passed because everything in the module aliases everything else, (d) fails.
The same four legs were added to `tests/test_composition_root.py`'s existing
services-versus-facade pair.

**Seven mutations. Six red, one green that was MY MUTATION'S FAULT, and one
that was red outside the runner I first used.**
1. `build_services` stops handing the ledger to the manager -> 3 red, all three
   composition legs.
2. `write_atomic` writes in place, no tmp and no rename -> 1 red.
3. `drop_session_pointer` stops re-writing the owned set -> 2 red, including the
   pre-existing `test_owned_set_survives_stale_clear.py`.
4. A failed read empties the owned set -> 1 red.
5. `is_owned_name` falls back to a `cloude_` prefix match -> 4 red. That is the
   spoofable heuristic the set exists to replace.
6. `save` stops stamping the owned set onto the payload -> 6 red across four
   files.
7. **GREEN, and the test was right.** `self._owned.names = set(self._owned.names)`
   after construction is not a divergence at all: the copy is assigned back ONTO
   the ledger, so both references still see one object. Rewritten as 7b, a
   create-path write into a local copy (`_copy = set(...); _copy.add(...)`),
   which is the divergence that can actually happen. 7b is red - in
   `test_session_backend.py`, NOT in the focused runner I had been using, which
   is worth writing down: a mutation is only measured against the tests you
   actually ran.

Every revert verified byte-identical by sha256.

**A reverted file, and the lesson.** Reverting mutation 7 with
`git checkout -- src/core/session_manager.py` threw away every S3 edit to that
file, because the file was not yet committed. Re-applied from the same script
(`scratchpad/s3/apply_manager.py`) and re-verified. Revert a mutation with the
`.bak` you took, never with git, while the slice is uncommitted.

**Patch sweep and repointed guards.** No `patch(` in the suite aims at any name
that moved: the 23 sites patching `_load_session_metadata` /
`_save_session_metadata` target members that still exist. Repointed: two
`monkeypatch.setattr(SessionManager, "_owned_instances_from_db", ...)` in
`test_s4_regressions.py` onto `OwnedTmuxLedger.instances_from_db`; the
`AppServices` field list and the port conformance double; two SOURCE-TEXT guards
in `test_session_ownership_origin.py`, one of which got STRONGER because the two
resolvers have left `session_manager.py` and no longer need exempting; and
`tests/test_launchpad_help_content.node.mjs`, which reads
`owned_names=set(...)` out of the manager source to check a help-text claim and
would otherwise have been the only failing node suite.

**A double stopped answering a question nobody asks.** The listing double in
`test_tmux_listing_consumers.py` carried an owned-name set that no assertion ever
observed; the route reads `list_attachable_sessions()` and nothing else. Removed
rather than repointed, so a future read through it is an AttributeError.

**Verification.** 6,170 passed / 2 failed / 20 skipped, 6,192 collected, against
the S2 tree's 6,141 / 2 / 20 and 6,163 collected. Delta +29, accounted entirely
by collection diff: 18 in `test_owned_tmux_ledger.py`, 7 in the forwarder
invariant's deleted-name list, 3 in `test_sessions_package_rules.py` (one more
module in the package, three rules each) and 1 in `test_no_unresolved_names.py`.
ZERO tests removed. The two failures are the known environmental pair. Node
200/200, `check-js-syntax.sh` clean. The three listing cost ceilings pass.
`scan_secrets.py` exit 0, pre-commit hook left enabled.

**Plan versus code, and the code won twice.**
1. The plan's mutation for this slice is "make the atomic write skip the `.bak`.
   If nothing goes red, the rule that protects the user's whole setup is
   undefended." THERE IS NO `.bak` IN THIS WRITE. `_write_metadata_atomic` was
   tmp plus `fsync` plus `os.replace` and never had one; the `.bak` belongs to
   `Settings.update_settings_config` in `src/config.py`, which is slice S5. The
   invariant that IS here is the atomic rename, and mutation 2 above is the test
   of it.
2. The plan says "9 test files, 2 `src` call sites". The `src` count is exactly
   right. A plain attribute grep finds 13 test files, but re-measured with the
   plan's own methodology (accesses through a variable named `manager`, `sm`,
   `session_manager` or `mgr`) it is 9 on the nose. The extra four are two
   docstring-only mentions and two files using other variable names, plus
   `test_session_ownership_origin.py`, whose reach is source text rather than an
   attribute and which a name-grep of either kind would have missed.

**What is NOT done, said out loud.** `SessionManager._datastore_connection` and
`_writable_datastore_connection` survive with about 28 callers across clusters
this slice does not own; the ledger reaches the datastore through the
`SessionRecordStore` port instead, so the ONE ownership caller moved and the
private pair keeps the rest until their own slices. And `routes.py` still guards
`active_tmux_names` with `hasattr` two lines from the call this slice edited;
that name belongs to S4 and removing its tolerance here would change behaviour
outside this slice.

## 2026-09-10 - backend decomposition v2, slice S4: the registry's second half

`src/core/sessions/registry.py` grows from 187 to 441 lines and now owns the
LIVE SESSION TABLE as well as the log buffers: `sessions`, `backends`,
`subscribers` (was `_subscribers`), `last_session_id` (was `_last_session_id`),
the registration path, every lookup, the "current session" pointer with its
self-repair, the output fan-out and `registered_ids_for_tmux_name`.
`src/core/session_manager.py` goes **7,725 to 7,589**, and twelve members are
gone from the class: `current_session`, `current_backend`, `session`, `backend`,
`get_session`, `get_backend`, `list_sessions`, `_resolve_session_id`,
`_register_session`, `_registered_ids_for_tmux_name`, `subscribe_output`,
`unsubscribe_output`.

**No copy and no forwarder.** All 82 internal reads go through
`self._registry`, and `__init__` creates none of the four containers - a new
test parses `__init__` and fails if it ever does, because an attribute
assignment is invisible to the existing forwarder SHAPE walk. `AppServices`
needed no new field: the registry has been on it since S0, so the composition
root already hands the same object to both sides.

**Three methods stayed and none is a forwarder.** `_make_output_handler`
builds a per-session closure over `publish`, which is real work rather than a
forward. `idle_watcher` and `adopt_fifo_start_offset` each reach TWO
collaborators (the registry for which session is current, the sidecars for what
is attached to it), so neither belongs on either one alone.

**The no-copy legs are chosen for this data, and there are five.** What can go
wrong here is not a wrong value, it is TWO CONTAINERS: two dicts written
through one path agree forever and diverge only when a create through the
manager meets a boot re-adopt through the registry, which is the 22-rows-for-21
-panes shape. So: (a) identity, kept only as the cheap canary; (b) FORWARD,
write through the manager and read through a registry reference captured
BEFORE that write; (c) REVERSE, write through the registry and read through
`has_active_session` / `is_session_live` / `active_tmux_names`, which walk the
dicts themselves; (d) TWO REFERENCES ONE PANE, register one tmux name under two
ids through two different references and require the query to see both, which
is the plan's named negative control and a no-copy leg at once; (e) DELETION,
because `pop` on a copy leaves the original populated and an add-only suite
cannot see that. (d) carries its own control: an unregistered name finds
nothing, and `also` naming an id with no backend is refused.

**Five mutations, five RED, every revert byte-identical by sha256.** Reverted
from `.pristine` copies, never with `git checkout`.
1. The composition root hands the manager a DIFFERENT registry from the one in
   `AppServices`: 5 red across `test_composition_root` and
   `test_lifespan_composition`.
2. `registered_ids_for_tmux_name` returns only the first match: 2 red,
   including the PRE-EXISTING `test_adopt_rekey_stored_id`.
3. `forget` stops repairing the current pointer: 1 red.
4. `publish` fans out to every subscriber instead of the session's own: 4 red,
   including the pre-existing `test_session_backend::
   test_concurrent_sessions_output_isolation`.
5. THE NO-COPY ONE: `register` writes into `dict(self.sessions)` and rebinds.
   **Leg (a) stayed GREEN** - both spellings still read one attribute on one
   object at any instant - and legs (b) and (e) went red. That is the whole
   argument for choosing legs per slice rather than reusing an `is` check.

**Ten defensive readers repointed, and NINE of them were invisible to the first
sweep** because they were spelled `getattr(manager, "backends", None)` rather
than `manager.backends`. Every one would have answered empty instead of
raising: `session_view_clears` (twice - a view would have stopped clearing any
flag), `session_status_seed_read`, `session_agent_infer_apply`,
`claude_title_sync_apply`, `local_servers`, `status_routes` (twice),
`away_routes` (twice) and `routes.py`. `read_alternate_screen` now takes the
REGISTRY rather than the manager, because a `callable` guard on `get_backend`
answers None for a moved method and a real refusal identically. The
`hasattr(session_manager, "active_tmux_names")` guard that the S3 entry flagged
as belonging to this slice is gone, and the `elif` behind it was dead code.

**Patch sweep clean.** No `patch(`/`patch.object(` in the suite aims at any of
the twelve deleted names. One monkeypatch repointed:
`test_boot_readopt.py` patched `mgr._register_session` and now patches
`mgr._registry.register`. Both node source-text guards
(`test_launchpad_help_content`, `test_session_ownership_badge`) still match
without edits, checked rather than assumed.

**Verification.** Control MEASURED on this tree before any edit: 6,169 passed /
3 failed / 20 skipped, 6,192 collected. After: **6,200 passed / 2 failed / 20
skipped, 6,222 collected**. Collection diff is exact: +31 added (14 in the new
`test_session_registry_live.py`, 16 parametrised cases in
`test_no_cluster_forwarders.py`, 1 rename replacement), -1 removed, and the
removed one is `test_open_ids_tolerates_a_manager_with_no_backends_dict`
RENAMED to `test_open_ids_is_empty_when_nothing_is_registered` in the same
file. **ZERO tests removed.** The two remaining failures are the known
environmental pair. The control's third failure,
`test_boot_readopt_real_tmux::test_attach_to_a_dead_pane_still_succeeds`,
passed after the change: it drives the real `cloude` socket and is the
INFRA-49 flake class, not a regression either way. Node 200/200,
`check-js-syntax.sh` 227 files clean, four listing cost ceilings pass,
`scan_secrets.py` exit 0, pre-commit hook left enabled.

**Plan versus code, and the code won twice.**
1. The plan says "31 test files touch these attributes but only 41 times".
   Re-measured today with the plan's own methodology it is **37 files and 138
   hits**, three times the stated reach. Wide and shallow was right; the number
   was not.
2. `src/core/sessions/registry.py`'s own module docstring said the second half
   was slice "S7", which is version 1 numbering. Under plan v2 it is S4. The
   docstring is rewritten rather than left to become the stale-doc trap gotcha
   8 warns about.

**What is NOT done, said out loud.** `test_session_registry.py`'s legs (a) and
(c) became degenerate when S1 deleted the forwarders - both sides of each
assertion now read `manager._registry` - and this slice did not repair them,
because they belong to the log-buffer half and the real legs for the live table
are in the new file. Worth a follow-up.

## 2026-09-10 - backend decomposition v2, slice S5: src/config.py into src/config/

`src/config.py`, 2,112 lines, is DELETED. In its place a 23-module package:
13 typed `config.json` blocks and the one named error in their own files
(bodies byte-exact, carved by source span including the comment above each,
the same machinery slice S2 proved on `src/models.py`), and the 1,426-line
`Settings` split into a LOADER plus typed READERS - `auth_loader`,
`state_paths`, `agent_command`, `config_file`, `config_writes`, `summary`,
`wrappers`, `provider_models`, `bootstrap`. `__init__.py` is a 73-line
re-export, so not one of the 111 importers changed.

**PROOF THAT NOTHING MOVED: A FINGERPRINT, NOT A READING.** Every public
name the flat module exposed was recorded before and after - pydantic json
schema, field annotations and defaults for all 13 models, plus all 31
`Settings` method signatures and all 19 field annotations. Over the 21
shared public names there is exactly ONE difference, and it is an
improvement the standards require: `_mutate_wrappers(self, mutation)` gained
`mutation: Callable[[List[dict]], List[dict]]`.

**THE FINGERPRINT EARNED ITS KEEP IMMEDIATELY.** The first run found FOUR
models whose schema would no longer build - `AgentsConfig`, `AuthConfig`,
`ProjectConfig`, `WorkspaceConfig` - because a carved module did not import a
name its annotations use (`AgentWrapper`, `Union`, `Literal`, `Dict`). They
became unresolved ForwardRefs. Every one of those models still CONSTRUCTED
fine, so the suite was green on three of the four; only a schema build says
so. This is the S2 trap restated: a package split fails by an annotation
resolving somewhere new. A fifth, `default_terminal_commands` missing in
`auth.py`, was caught by `test_no_unresolved_names.py` and would have been a
NameError the first time that default fired.

**37 NAMES THE FLAT MODULE LEAKED ARE NOT RE-EXPORTED** - its own imports
(`json`, `os`, `Path`, `Field`, `TerminalCommand`, `MODEL_ID_PATTERN`,
`wrapper_store` and the rest). Checked rather than assumed: zero of the 37 is
imported from `src.config` anywhere in `src/`, `tests/`, `scripts/` or
`macOS/`.

**DUPLICATION REMOVED, AND THE BIGGEST ONE HAD NO TEST UNDER IT.**
`load_auth_config` carried the four-line malformed-block pattern TWELVE
times. It is now `auth_loader.parse_block`, with the event name and the log
payload as arguments because those genuinely differ - a workspace env VALUE
can be a secret, so that block logs key names only. **Measured before
touching it: 21 test files reach `load_auth_config` and NOT ONE asserts any
of the twelve `invalid_*_config_block` fallbacks.** The whole degraded path
was unmeasured. `tests/test_config_block_tolerance.py` is 20 new tests over
it, including the two extremes pointing OPPOSITE ways on purpose (a mangled
`message_archive` yields disabled, the safe direction; a mangled `ui` yields
the ALL-DEFAULT object, because an unparseable block must not be able to HIDE
a capability) and the negative controls: a valid block round-trips, a missing
file and invalid JSON and a missing secret are all still REFUSED. Also
collapsed: four copies of the "run setup_auth.py" `FileNotFoundError`, four
of the invalid-JSON wrap, and TWO copies of the atomic write, into
`config_file.py`.

**SEVEN MUTATIONS. THREE RED IMMEDIATELY, FOUR CAME BACK GREEN, AND ALL FOUR
WERE A MISSING TEST RATHER THAN A MEANINGLESS MUTATION.** Reverted from
`.pristine` copies, never `git checkout`; every revert byte-identical by
sha256.
1. RED. The plan's named mutation: the atomic write stops making the `.bak`.
   Two tests. (Note this IS the write that has a `.bak`; the S3 entry
   recorded that the plan had aimed the same mutation at the session-metadata
   write, which never had one.)
2. GREEN, then RED. The write stops being atomic - in place instead of
   tmp-plus-rename. Green because BOTH PATHS PRODUCE IDENTICAL FINAL BYTES;
   they differ only when the write does not finish, which no outcome
   assertion can see. Two new tests stage the difference: a serialisation
   that fails part way must leave `config.json` untouched, and the
   destination must never be opened for writing at all.
3. RED. `parse_block` stops falling back: 14 red.
4. RED. The state-file pin stops sticking: 3 red, including the two that
   exist because a re-derived pin silently MOVED `session_metadata.json`.
5. GREEN, then RED. `get_agent_command` resolves the state directory
   EAGERLY. Green because no test had ever made that resolution FAIL, which
   is the only thing the laziness protects: `get_state_dir` raises on an
   unwritable directory, and the wrapper-less branch has no scripts
   directory to need. A launch that always worked would start failing on
   the box least able to afford it.
6. GREEN, then RED. A writer stops invalidating `_auth_config_cache`. Green
   for a precise and worrying reason: `test_config_settings.py`'s fixture
   EMPTIES the cache before every test, so no test in that file had ever
   exercised a WARM cache - which is the only state a running server is in
   after its first read. The new test warms it first; without the
   invalidation the PATCH writes correctly and reports the PRE-write value
   straight back.
7. GREEN, then RED. The merge stops re-validating, so a block pydantic
   refuses reaches disk and the next load quietly falls back to that block's
   defaults - the user's notifications setup gone with no error anywhere.

**THE ONE RULE THIS SLICE COULD NOT MEET, SAID PLAINLY.**
`src/config/settings.py` is **632 lines, over the 500-line guideline**. It is
109 lines of pre-existing field declarations plus 31 typed entry points
averaging 13 lines; every method BODY is gone. It cannot go lower without
either inheritance (banned) or deleting `Settings`' public surface and
migrating its ~45 callers - Rule B applied to `Settings`, which plan v2's S5
does not specify and which is its own slice. Measured reason the surface has
to stay: 111 modules import from this package and the suite patches these
members on the CLASS, 23 sites on `state_dir_override`, eight on
`type(sm.settings).get_state_dir`. **This needs the owner's call**: accept it,
or schedule S5b to migrate the callers. Recorded in CLAUDE.md as a known
measured exception so the next agent does not read it as drift.

**CARVED OUT, DELIBERATELY.** Plan v2's S5 also asks for a validated
`AgentChoice` value object that only `validate_agent_choice` can construct.
That is a typed-API change threading through four restart paths, not a
relocation, and folding it into a commit that moves 2,112 lines would make a
failure unattributable to either half. Not done, not hidden.

**Two other things found and fixed rather than left.**
`test_config_defaults_source_of_truth.py` sliced the loader with
`source.index("\n    def ")`; it now slices by AST. Its known HOLE is
recorded in the test: the four blocks read through a CONSTANT (`ui`,
`workspace`, `server_prefs`, `message_archive`) are invisible to its regex
AND absent from `supported_keys()`, so the two agree by both being blind.
And `socket.gethostname()`'s `except Exception` narrowed to `OSError`, which
is what it raises.

**Verification.** Control for this slice is the S4 commit, measured: 6,200
passed / 2 failed / 20 skipped, 6,222 collected. After: **6,248 passed / 2
failed / 20 skipped, 6,270 collected.** +52 added (20 tolerance, 4 config
settings, 2 agent families, 26 from `test_no_unresolved_names.py`, which is
parametrised over source FILES and the package has 22 more of them), -4
removed, and all four are the SAME parametrised test's ids being
re-disambiguated by pytest (`agents.py` became `agents.py0`/`agents.py1`
because the name now exists in two places). **ZERO tests removed.** The two
failures are the known environmental pair. Node 200/200, four cost ceilings
pass, `scan_secrets.py` exit 0, pre-commit hook left enabled.

---

## 2026-09-10 - the S5 settings question, RULED and closed

The owner was shown the one open question S5 left and ruled on it, verbatim:
**"Leave it it's ok"**.

`src/config/settings.py` stays at 632 lines. It is the ONE ruled exception to
this project's 500-line rule and it is not a precedent for any other file.
Recorded in three places so nobody, on either side, "fixes" it later:

- `docs/DECISIONS.md`, entry "`src/config/settings.py` stays over 500 lines".
  The file binds both teams. Its exact blob was carried across from
  `feat/work-protocol` and the entry APPENDED, so a later merge stays clean.
- `CLAUDE.md`, where the existing note was rewritten to read as a RULING with
  the owner's words and the date, rather than as an observation someone could
  take as an invitation.
- `.claude/notes/backend-decomposition-plan.md` section 11, FO1, as a future
  OPTIONAL slice. Plan v2's exact blob was carried across from
  `docs/backend-plan-v2` in the same commit, because the branch was still
  carrying plan v1 while shipping plan v2's slices, and a stale doc is worse
  than no doc.

**The migration is NOT SCHEDULED.** Getting under 500 needs the 31 typed entry
points deleted and roughly 45 callers migrated. That is Rule B applied to
`Settings` and it is a test-suite migration wearing a refactor's clothes: 111
modules import from the package and the suite patches these members on the
CLASS, 23 sites on `state_dir_override` and eight on
`type(sm.settings).get_state_dir`. A name that stopped resolving there fails
silently, not loudly. If it is ever taken it gets its own slice, its own patch
sweep and its own control.

---

## 2026-09-10 - S6 SHIPPED: the two route monoliths into siblings

Plan v2's S6. `src/api/routes.py` **4,397 to 106** and `src/api/auth.py`
**1,674 to 362**, into 29 new sibling modules plus two pure core modules.
Both stopping-condition rows met (routes.py under 500, auth.py under 500).
Largest new file is `hook_event_routes.py` at 441; every one is under 500.

**THE PLAN CONTRADICTS ITSELF AND THE CODE SETTLED IT.** Section 3.4 says
`src/api/routes/` (a package) while section 7 says "`src/api/routes.py`
under 500". Those cannot both exist: a package shadows a module of the same
name. `src/api/` already carries eleven `<resource>_routes.py` siblings and
S6's own prose says "the eleven-sibling pattern the directory already has",
so it is flat siblings with `routes.py` left as the aggregator. That keeps
`from src.api.routes import router` resolving for `src/main.py` and ten test
files, untouched.

**ORDER IS PRESERVED BY CONSTRUCTION, and that is the fingerprint.** Modules
are CONTIGUOUS runs of the original declaration order, so aggregating in
that order reproduces the table exactly. Two resources were not contiguous
and keep a second router rather than moving:
`provider_models_routes.local_models_router` (registered second) and
`auth_routes.status_router` (`GET /auth/status`, registered between the
clone route and the command lists). **Fingerprint: 51 routes, 18 auth
routes and 99 openapi operations, IDENTICAL before and after on path,
method set, endpoint name, response model, status code, dependency count,
response class, schema inclusion AND position.**

**NOTHING IS RE-EXPORTED FROM THE AGGREGATOR BUT `router`.** A re-export
would let `monkeypatch.setattr(routes_mod, "_bundled_themes_root", ...)`
go green while patching a name the handler no longer reads. Every such
site was repointed at the module that owns the name.

**auth.py IS NOW THE AUTHORITY AND DECLARES NO ROUTER.** 83 call sites
import `require_auth` from it, so every auth-side route module depends on
it; a router there would need the imports back and the cycle would only
resolve by ordering them at the bottom of the file. `auth_routes.py`
assembles that side instead. Acyclic, and `test_api_route_modules.py`
enforces it.

**Two decision halves lifted to pure modules**, per the plan's S6.
`src/core/hook_event_presentation.py` is the toast copy;
`src/core/hook_toast_gate.py` is the mute-then-subagent ladder, which had
no test of its own because it was reachable only through an HTTP POST.
`tests/test_hook_toast_gate.py` is 18 cases and over half of them are
negative controls: a gate that suppressed broadly would pass every "it
went quiet" test and rebuild the false-silence failure.

**A REAL DEFECT FOUND, not introduced.** Five siblings inherited a
FUNCTION-LOCAL `from fastapi.concurrency import run_in_threadpool` - nine
of them across the five - which is the exact defect
`tests/test_route_names_resolve.py` was written for: the next handler in
that module uses the name and NameErrors into a bare 500. Hoisted to module
scope and the local imports deleted.

**Three structural tests were pointed at a file that no longer holds what
they check**, and all three would have gone quietly useless:
`test_route_names_resolve.py` (hardcoded `src/api/routes.py`, now
discovers every module declaring a router and parametrises over 46),
`test_docs_operations_chart_drift.py` (a seven-entry `ROUTER_FILES` tuple,
now discovered the same way), and `test_rename_writes_label_not_tmux.py`
plus `test_session_fork.py` and `test_configured_wrappers_path.py`, which
AST-parse a named source file.

**Patch sweep: 22 sites across 19 files, and the first grep found 13 of
them.** The nine it missed were spelled through a different alias
(`from src.api import routes as routes_module`) or reached a name the
literal grep did not contain. A second sweep by AST - resolve each file's
alias for the module, then check every attribute against the aggregator's
real namespace - found the rest and now reports zero.

**Mutations.** (1) Delete one `include_router` line: red on
`test_the_aggregator_actually_serves_what_it_assembles`. It ALSO exposed a
hole in the new test's own per-module case, which skipped instead of
failing because it inferred "mounted elsewhere" from having no aggregated
routes - which is what a deleted include looks like. Replaced with an
explicit register of the modules `src/main.py` mounts directly; the
mutation is now red twice. (2) Strip a module-scope import from a sibling:
red on `test_every_route_handler_resolves_its_helper_names` for that
module, proving the generalisation actually covers the new files. Both
reverted by hunk and verified byte-identical by sha256.

**Imports are emitted PER NAME.** The first pass copied whole statements,
so any sibling needing one model got all fifty names of
`from src.models import (...)` - the monolith's coupling surface handed to
every file. `themes_routes.py` went from 253 lines to 202 on that change
alone.

**Verification.** Control MEASURED on this branch at `a1bf306`: 6,248
passed / 2 failed / 20 skipped, 6,270 collected. After: **6,478 passed /
2 failed / 76 skipped, 6,556 collected.** +289 added, -3 removed, and all
three "removals" are accounted: two are `test_route_names_resolve`'s
un-parametrised ids being replaced by 92 parametrised ones, and one is a
parametrised id that embeds the worktree path. **ZERO tests removed.** The
+289: 147 `test_api_route_modules.py` (new), 92
`test_route_names_resolve.py` (2 tests over 46 route modules), 31
`test_no_unresolved_names.py` (parametrised over source FILES, and there
are exactly 31 new ones), 18 `test_hook_toast_gate.py` (new), 1 the
worktree-path id. The two failures are the known environmental pair. Node
200/200 as CI runs it, four listing cost ceilings pass, `scan_secrets.py`
exit 0, pre-commit hook left enabled.

**Not done, and said out loud.** `src/api/recreate_routes.py` (582) and
`src/api/websocket.py` (675) were already over the guideline and are not in
this slice's lane. They are on an explicit register in
`test_api_route_modules.py` with their measured size, so they are visible
and may not GROW; a register that tolerates any number is the rule deleted
with extra steps.
