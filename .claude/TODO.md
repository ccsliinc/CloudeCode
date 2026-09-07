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

### The lag and the render path
- **2.** Tab switching and keyboard extremely laggy. Root cause found and
  measured 2026-09-05: synchronous SQLite on the asyncio event loop, 71.4
  percent of main-thread samples inside `sqlite3_step`, a 12.05s stall every
  20.0s, loop unavailable ~60 percent of wall clock on an IDLE box. WHICH query
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
