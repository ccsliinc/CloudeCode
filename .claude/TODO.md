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
