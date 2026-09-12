# Troubleshooting discoveries

Append only. Each entry is something that was MEASURED, with the date, so
the next agent does not rediscover it.

---

## 2026-09-07 - the sidebar row overflow menu (kebab)

Five things cost real time while folding the row's action icons into a
per-row kebab. All five were measured in Chromium, not reasoned about.

**A `position: fixed` panel rendered inside the sidebar is positioned
against the SIDEBAR, not the viewport.** `.session-sidebar-panel` carries
`transform: translateX(-100%)` for its open/close slide
(client/css/session-sidebar.css), and a transformed ancestor becomes the
containing block for a fixed descendant. Any floating surface hung off a
sidebar row therefore has to be mounted on `document.body`. The cost of
doing that is that the list-scoped click router in
session-sidebar-clicks.js never sees the panel's clicks, and that
`onRowActionClick`'s `closest('.session-sidebar-row')` walk finds nothing
- which reads as "not the open tab, no backend" and routes an own-tab
close down the wrong path. That function now falls back to a by-NAME
lookup of the live row.

**A deferred dismiss binding is a real dead window, not a theoretical
one.** The menu bound its Escape handler inside `setTimeout(..., 0)`,
copying session-theme-menu.js. Playwright pressed Escape before that
timeout ran and the menu did not close - reproducibly. Only the POINTER
handler needs the defer (so the click that opened the surface does not
dismiss it); a keydown never does, because the keydown that opens a menu
is delivered before the click it synthesises. Bind keys synchronously.

**`flex-basis` beats `height` on a flex item.** Setting
`list.style.height = '80px'` on `#session-sidebar-list` did nothing: the
element is a flex item with a basis, stayed 844px tall, could not scroll,
and the scroll-closes-the-menu test passed for a reason unrelated to the
menu. `style.flex = 'none'` first, and assert
`scrollHeight > clientHeight` before believing a scroll test.

**A coarse pointer never reaches `AnchorPopover.placeAt`.** The row menu
anchors to the kebab on touch and opens at the pointer on a mouse, so a
Playwright context created with `is_mobile=True` exercises `place()` for
BOTH the kebab tap and the right click. The point-placement path had zero
coverage until a second, fine-pointer context was added, and a mutant
that deleted the whole placement rule survived the entire suite. If a
module branches on `(pointer: coarse)`, the suite needs both contexts or
half of it is untested.

**The flip and the clamp in anchor-popover are redundant at a phone
size.** Either alone keeps the panel on screen, so no single-line mutant
can kill an on-screen assertion. Mutate the whole placement rule instead;
what the test asserts is the property, not a line.

**Project rule found the hard way:** every raw `vh` declaration needs an
immediately following `dvh` twin, enforced by
`tests/test_viewport_units.node.mjs`. A new stylesheet with
`max-height: calc(100vh - 16px)` fails that suite.

## 2026-09-08 - claude_session_uuid: why it goes missing, and why some are phantoms

**Root cause of the missing uuids, measured on the live server log.**
`sessions.claude_session_uuid` had ONE writer on the create path: Claude Code's
`SessionStart` hook. When that POST body arrives empty, `src/api/routes.py`
degrades it to `{}` and `session_manager.record_claude_lifecycle_event` answers
`the SessionStart payload carried no session_id`. The live log holds **25 such
failures across 20 distinct sessions**, mapping exactly onto the rows missing a
uuid today.

**The real defect is structural, not the empty body.** `SessionStart` fires
EXACTLY ONCE per conversation. Every other hook event repeats hundreds of times,
so a lost delivery is invisible and self-healing; a lost `SessionStart` is
permanent. A one-shot write over a lossy channel with no retry and no
reconciliation loses a fraction of its writes forever. Observed: 41 percent.

**`agent_type` does NOT share this cause.** Crosstab over the 39 live rows: 14
rows have `agent_type` NULL AND a hook-written uuid. The two failures are
independent. Backlog item 3 stays its own job.

**`slugify_project_dir` was wrong and the error was invisible.** It mapped only
`/` and `.`. The real rule maps every character outside `[A-Za-z0-9-]`, verified
against 908 of 919 live transcripts. Every path on this machine lives under
`~/Library/Mobile Documents/com~apple~CloudDocs/` (a SPACE and two TILDES), so
the computed directory name never existed, and `correlate_adopted_session` had
therefore never once succeeded on this box. Underscores were mismapped too
(`claude_4` -> `claude-4`).

**PHANTOM UUIDS ARE A THIRD CLASS AND NOBODY WAS COUNTING THEM.** Over the live
database: 16 rows have no uuid, 18 have one whose transcript exists, and **5 have
one with NO transcript anywhere**. A phantom reads as sound on every surface and
resumes nothing. All 5 are on rows using the SHORT symlink spelling of
`working_dir`. Four of them are one session split across two rows by the cwd
spelling trap - the live pane's argv names a conversation the OTHER row already
holds (rows 4/7 Media Compression, 9/11 Mac, 10/12 Hirschfeld, 38/39 Fantasy
Football). `--fork-session` is a plausible minter: it mints a new uuid at
SessionStart, the hook records it, and the forked transcript is written lazily
and may never materialise.

**The transcript timing rule cannot find a RESUMED conversation.** A resumed
conversation's first message predates its pane by months (`--resume` appends to
the SAME file), so first-message-vs-pane-epoch matches nothing. Use LAST-write
time, or better, the pane's own argv.

**Reading the live DB while the app runs:** `mode=ro` fails while the corpus
ingester holds a WAL. Use `PRAGMA query_only=ON` on a normal connection.

**tmux is not on the default PATH over ssh to the mini.** Prefix
`/opt/homebrew/bin`. The mini's system `python3` has no structlog; the deployed
server venv at `~/Library/Application Support/cloude-code-menubar/server/venv`
does.

Dry-run tool: `scripts/backfill_claude_session_uuid.py` (dry run is the default;
`--emit-facts` is stdlib-only so it runs on a bare machine).

## 2026-09-08 - after a live deploy the server answers, then stops answering for ~40s

`./scripts/deploy-mini.sh --target live` (HEAD c9cd9ab) exited 0 and its own
post-restart re-verify passed. Immediately afterwards `curl :8000` returned
`000` and `lsof -iTCP:8000 -sTCP:LISTEN` was empty, which reads exactly like a
deploy that killed the server. It had not.

Two things happen after the deploy's kill, and neither is a fault:

1. The Electron supervisor restarts the server, the deploy's `waiting for :8000`
   loop sees THAT process answer, and the deploy exits. A LATER restart can
   still land after the script is gone. Measured here: the deploy's restart, then
   a second server start about two minutes on (pid 77491, 10:16:13), concurrent
   with an external 4.6 GB `cloude.db.bak-uuidrepair-*` write that nothing in
   this repo produces (`grep -rn uuidrepair src/ scripts/` finds nothing), so it
   came from another session working the uuid repair, not from app code.
2. A fresh boot runs a full corpus ingest pass over the real corpus (19,213
   files discovered here) and sits near 100 percent CPU while it does. The port
   is NOT bound for the first ~40 seconds. It settled to 200 and 2 percent CPU.

So a single post-deploy curl is not a measurement. Poll :8000 for at least a
minute before calling a live deploy failed, and check `ps aux | grep src.main`
for a process that exists but has not bound the port yet - that is starting, not
dead.

Unrelated to the deploy but worth knowing: `<state_dir>/db-integrity/latest.json`
legitimately does NOT refresh on a restart. The loop asks the artifact whether a
check is due first, so on a daily interval an artifact 23 hours old is `current`
and correct, not stale. Do not read an unchanged mtime there as a broken loop.

## 2026-09-08 Media Compression: moving a conversation uuid off a phantom row

The "Media Compression" session had two rows and the conversation on the wrong
one. Row 7 is the LIVE row (`cloude_Media_Compression`, tmux epoch 1788444837,
`lifecycle=running`, `parent_session_id=4`) and held
`db81f6bf-85f9-448b-a7f6-bc83f62659d9`, a uuid `--fork-session` minted and the
`SessionStart` hook faithfully recorded. Row 4 is the ARCHIVED twin the cwd
spelling split off (`archived_at=2026-09-03T16:30:54.809577Z`,
`lifecycle=stopped`) and held the real uuid
`82854c0e-a423-4591-a34f-a14cb92fbf41`. The partial unique index
`ux_sessions_claude_uuid` is what kept the app's own backfill tool from fixing
it: the tool proposes exactly this uuid for row 7 on four evidence families
(`pane_argv, sibling_row, recorded_cwd, project_dir`) and files it under
"LEFT ALONE - collides: one session, two rows". This change is that proposal,
unblocked by hand with the owner's authorisation.

Measured, not assumed:
- `db81f6bf` exists NOWHERE under `~/.claude/projects` - not as a filename and
  not as a content reference. A truly phantom uuid, never materialised.
- `82854c0e.jsonl` is 73,190,422 bytes, mtime 1788557412 (2026-09-04 17:30),
  and is the newest transcript in its slug dir by true mtime sort. Its own last
  line self-reports `sessionId: 82854c0e`. No Media transcript anywhere is
  newer, so the conversation did not continue somewhere else.
- The pane's mtime is 1.3 days AFTER the pane launched, so the live pane has
  been appending to `82854c0e` all along despite the hook recording the fork's
  uuid on the row.

### THE SHORT-vs-LONG cwd SPELLING DOES NOT SPLIT THE TRANSCRIPT DIR ON claude 2.1.263

Row 7's `working_dir` is the SHORT spelling
(`/Users/jsugamele/Development/Assistants/Media`) while the transcript lives in
the LONG iCloud slug dir. That looked like it would break a restart. It does
not, for two INDEPENDENT reasons, both proved with a throwaway rather than
reasoned about:

1. **Claude Code resolves symlinks.** A scratch replica (a real dir plus a
   symlink to it) run from the SYMLINKED path created its slug directory under
   the RESOLVED path, and the transcript's own recorded `cwd` field is the
   resolved path. That is why only ONE Media slug dir exists on this box even
   though two rows carry two spellings. `~/Development` is a symlink into
   iCloud, so the short spelling produces the long slug at runtime.
2. **Resume is not scoped to the slug dir anyway.** From a genuinely different
   directory (which got its own separate slug dir), `claude --resume <uuid>`
   exited 0 and appended to the ORIGINAL transcript in the ORIGINAL slug dir -
   verified by counting user turns, all 3 landed in the one file.

So `working_dir` was deliberately NOT rewritten. Note this qualifies CLAUDE.md
gotcha 6: the historic split is real and visible in the data, but the current
binary would not re-create it. Treat gotcha 6 as a fact about legacy rows, not
about what happens today.

### The provenance word

There is NO operator/manual value. `db_models.py` defines exactly three:
`hook`, `correlated_argv`, `correlated`. Rather than invent a fourth,
`correlated_argv` was used because it is literally the evidence - the uuid was
read out of the live pane's own argv (`--resume 82854c0e-... --fork-session`),
which is precisely what `db_models.py` documents `correlated_argv` to mean.
`hook` would have been a lie; `correlated` would have understated it.

### The statements, run as ONE transaction

Backup taken FIRST (see below). Both UPDATEs are guarded on the expected
current value so a wrong row cannot be hit, and ordered release-then-claim
because the unique index would otherwise reject the second one. NULLs do not
collide under the partial index.

```sql
BEGIN IMMEDIATE;
UPDATE sessions
   SET claude_session_uuid = NULL,
       claude_session_uuid_source = NULL,
       updated_at = '2026-09-08T14:22:13.407954Z'
 WHERE id = 4
   AND claude_session_uuid = '82854c0e-a423-4591-a34f-a14cb92fbf41';
-- changes() = 1

UPDATE sessions
   SET claude_session_uuid = '82854c0e-a423-4591-a34f-a14cb92fbf41',
       claude_session_uuid_source = 'correlated_argv',
       updated_at = '2026-09-08T14:22:13.407954Z'
 WHERE id = 7
   AND claude_session_uuid = 'db81f6bf-85f9-448b-a7f6-bc83f62659d9';
-- changes() = 1
COMMIT;
```

Row 4 stays archived and stopped; it only RELEASES the uuid. Its
`working_dir`, `lifecycle`, `archived_at` and `origin` are untouched. Row 7's
`agent_type` was already `claude` (NOT null, contrary to the briefing) so
nothing was guessed there. `sessions` has no notes column, which is why the
reason is recorded here.

**Backup:**
`~/Library/Application Support/CloudeCode/cloude.db.bak-uuidrepair-20260908T141621Z`
Taken with `sqlite3 .backup` in 4.4s. Verified three ways: byte size identical
to live (4,945,317,888 both), `PRAGMA integrity_check` on the BACKUP returns
`ok`, and `SELECT count(*) FROM sessions` matched live at 39. Every
pre-existing backup in that directory is 64-115 KB against a 4.6 GB database
and is NOT a usable rollback - do not mistake one for a safety net.

**Verified after:** the live `GET /sessions/restart/preview` for
`cloude_Media_Compression` reads `pane_state: alive`, `projected.kind: agent`,
`projected.conversation: resumed`, and every wrapper option's predicted command
carries `--resume 82854c0e-a423-4591-a34f-a14cb92fbf41`. The transcript guard
`conversation_presence()` returns `present` from the short spelling, the long
spelling and with no working_dir at all; as a negative control the old phantom
and a bogus uuid both return `absent`, so the guard is not a matcher that
always finds something. The backfill dry run no longer lists row 7 as a
collision.

### Still open: three more rows have the identical defect

The same dry run still reports `LEFT ALONE - collides` for rows 9 (`cloude_Mac`,
wants `c2e5255b`, held by row 11), 10 (`cloude_Hirschfeld`, wants `c9fa94ea`,
held by row 12) and 38 (`cloude_Fantasy Football 2026`, wants `02eacc04`, held
by row 39). Each is the same `--fork-session` phantom against an archived twin
and each would take the same two-statement repair. They were left alone because
only Media Compression was authorised.

### A read-only sqlite open FAILS when the app is stopped

`sqlite3 "file:<db>?mode=ro"` and `sqlite3 -readonly` both return
`unable to open database file (14)` once the app has exited, because the
checkpoint removes the `-wal` and `-shm` and a read-only connection to a
WAL-mode database cannot create the `-shm` it needs. It works fine while the
app is running. When the app is down, open read-write and use
`PRAGMA query_only=ON` instead. This looks exactly like a missing or corrupt
database file and is neither.

## 2026-09-08 agent_type and claude_session_uuid backfill, and the three "pairs" that were briefed backwards

Three jobs were authorised in one pass. Job 1 was NOT executed, on evidence.
Jobs 2 and 3 wrote 23 rows in three guarded transactions.

**Backups, both verified three ways (size vs live, `integrity_check` on the
backup, `sessions` count vs live), both to be cleaned up once these repairs are
proven:**

- `cloude.db.bak-agenttype-20260908T144337Z` - 4,966,510,592 bytes, `ok`, 40/40.
  Predates every write below.
- `cloude.db.bak-uuidfill-20260908T144757Z` - 4,966,510,592 bytes, `ok`, 41/41.
  Sits between job 2 and job 3.

The pre-existing `cloude.db.bak-uuidrepair-20260908T141621Z` still exists,
4,945,317,888 bytes, 39 sessions. It remains the rollback baseline for the
Media Compression repair.

### JOB 1 REFUSED: the pairs are the other way round

The briefing, and the "Still open" note above it, both described rows 9, 10 and
38 as the LIVE rows wanting a uuid held by an archived twin. **Measured, that is
inverted.** In all three pairs the LIVE row already holds the real uuid and the
DEAD twin holds the phantom:

| pair | live row | its uuid | transcript | dead twin | twin's uuid | transcript |
|---|---|---|---|---|---|---|
| Mac | 11 running | `c2e5255b` | 16,072,050 B | 9 archived 2026-09-03 | `b60b65e7` | NONE |
| Hirschfeld | 12 running | `c9fa94ea` | 22,897,888 B | 10 archived 2026-09-03 | `1b56e525` | NONE |
| FF 2026 | 39 running | `02eacc04` | 9,034,442 B | 38 stopped | `cd0d62de` | NONE |

Each live pane's own child argv was read and names exactly the uuid its row
already holds:

    pane 65421 -> claude --dangerously-skip-permissions --resume c2e5255b-...
    pane 65474 -> claude --dangerously-skip-permissions --resume c9fa94ea-...
    pane  7187 -> claude --dangerously-skip-permissions --chrome --resume 02eacc04-...

Running the briefed statements would have set the RUNNING row's uuid to NULL and
moved the conversation onto the archived corpse - the exact opposite of the
Media Compression repair. **Zero statements were run for job 1.**

Why the backfill tool still files these under "collides": it proposes, for the
DEAD row, the uuid the LIVE sibling already claims, and refuses on the unique
index. That refusal is correct. There is no unique-index violation in the data -
the two rows hold DIFFERENT uuids - so nothing is broken. The only residue is
three dead rows carrying a phantom, which the transcript guard already covers.
Clearing those three phantoms is a DIFFERENT change with a different rationale
and was not authorised, so it was not made.

Corollary for whoever reads the "Still open" note above: it names the rows
correctly and the DIRECTION incorrectly. Re-measure `archived_at` and the live
tmux socket before acting on any pair, always.

### JOB 2: agent_type on running rows, from the live process

`agent_type` was NULL on 15 of 19 running rows. Crosstab before / after, over
running rows:

    before:  (NULL) 15   claude-chrome 3   claude-skip-permissions 1
    after:   claude-skip-permissions 16   claude-chrome 3   (NULL) 0

Mapping rule, and why the naive one is not enough. The flag set alone is
AMBIGUOUS: `claude-skip-permissions`, `cld` and `cldor` all reduce to
`{--dangerously-skip-permissions}`. They were separated by measured ENV, since
`cld` exports `CLAUDE_CODE_OAUTH_TOKEN` and `cldor` exports
`ANTHROPIC_BASE_URL` unconditionally before exec. `ps -E` on every live claude
child shows NEITHER on any pane, so both are ruled out and one candidate
remains. `cldl` is excluded by flags (`--model` absent).

    argv flag set (--resume/--fork-session/--name stripped) -> wrapper id
    {--dangerously-skip-permissions}            -> claude-skip-permissions   (15 rows)
    {--dangerously-skip-permissions, --chrome}  -> claude-chrome             (3 rows, all already set)

The matcher was run against controls before it was trusted: it answers on the
two positives, and REFUSES on `--bogus` added (no wrapper has that flag set),
on bare `claude` (empty flag set), and on a synthetic pane carrying cld's env
(ambiguous, 3 candidates). It is not a matcher that always finds something.

Corroboration, independent of argv: four panes' own `zsh -c` command line names
the wrapper script it sourced, and in every case it agrees with the stored
`agent_type` - `claude-chrome.zsh` on rows 7 and 43, `claude-skip-permissions.zsh`
on rows 8 and 13. Row 13 was NULL and had this direct wrapper evidence.

The other 14 rows show the ABSOLUTE binary path
`/Users/jsugamele/.local/bin/claude` and source no wrapper script, which is the
hand-sent-command origin CLAUDE.md predicts. `claude-skip-permissions` is
therefore the wrapper that REPRODUCES their command, not the one that launched
them. That is the right value to store, because `agent_type` is what a restart
comes back as.

ZERO disagreements: no row with a non-NULL `agent_type` conflicted with its
argv. Row 43 briefly read "no child process" (a `pgrep` race) and was recorded
as could-not-evaluate rather than as a mismatch; it is non-NULL anyway so no
write was in play.

```sql
BEGIN IMMEDIATE;
-- x15, one per row, ids 11,12,13,14,15,16,17,18,19,20,21,22,23,24,25
UPDATE sessions
   SET agent_type = 'claude-skip-permissions',
       updated_at = '2026-09-08T14:45:10.569964Z'
 WHERE id = ?
   AND tmux_name = ?
   AND tmux_created_epoch = ?
   AND agent_type IS NULL
   AND lifecycle = 'running';
-- changes() = 1 on every one, total 15, else ROLLBACK
COMMIT;
```

`agent_family` was left NULL deliberately. It is a separate column with its own
`agent_family_source` and was not in scope.

### JOB 3: claude_session_uuid on every running row that lacked one

Eight running rows had no uuid: 14, 15, 16, 17, 19, 23, 24, 25.

**Rung (b) cannot answer on this machine, and that is a finding.** `lsof` on
every live claude child returns NO `.jsonl` handle at all - Claude Code opens
the transcript, appends and closes it. `lsof` itself works (30 lines for the
control pid), so this is a measured negative, not a broken probe. Do not build
anything on the assumption that the live process holds its transcript open.

Rung (a) answered for 7 of the 8, and the backfill tool's independent proposal
agreed with the argv on all 7 (`pane_argv, recorded_cwd, project_dir`). Every
uuid was checked for an existing holder (none) and for a transcript file on
disk (all present, 116 KB to 33.6 MB).

```sql
BEGIN IMMEDIATE;
-- x7: 15 <- c4f32112, 16 <- 9f97e766, 17 <- 5cdda257, 19 <- a5a09829,
--     23 <- b388f6dd, 24 <- a9da3522, 25 <- 7a376ed5
UPDATE sessions
   SET claude_session_uuid = ?,
       claude_session_uuid_source = 'correlated_argv',
       updated_at = '2026-09-08T14:48:41.270237Z'
 WHERE id = ?
   AND tmux_name = ?
   AND tmux_created_epoch = ?
   AND claude_session_uuid IS NULL
   AND lifecycle = 'running';
-- changes() = 1 on every one, total 7, else ROLLBACK
COMMIT;
```

Row 14 (`cloude_daily-briefing`) runs with NO `--resume`, so rungs (a) and (b)
gave nothing and it fell to rung (c). **`--apply` refuses by design** - the
script prints "REFUSING TO APPLY ... write the rows the report marks WRITABLE,
by hand, one statement each" and falls back to a dry run. Leave that refusal
alone; it is the reason a 4.5 GB live database has never been written by a
flag. The row was written by hand instead, after an independent check: the
proposed transcript is the ONLY `.jsonl` in that project dir (no tie to break),
its own recorded `cwd` matches the row's `working_dir` exactly, and its last
line self-reports `sessionId: 42ca16a6`.

The source word is `correlated`, NOT `correlated_argv`. `db_models.py` defines
exactly three, and the evidence here is filesystem correlation with no argv in
it. Using `correlated_argv` would have overstated it.

```sql
BEGIN IMMEDIATE;
-- guard: SELECT id FROM sessions WHERE claude_session_uuid = '42ca16a6-...' must be empty
UPDATE sessions
   SET claude_session_uuid = '42ca16a6-dc08-4b7a-bea1-1413f2b7e232',
       claude_session_uuid_source = 'correlated',
       updated_at = '2026-09-08T14:49:04.624403Z'
 WHERE id = 14
   AND tmux_name = 'cloude_daily-briefing'
   AND tmux_created_epoch = 1788552895
   AND claude_session_uuid IS NULL
   AND lifecycle = 'running';
-- changes() = 1
COMMIT;
```

### Completeness crosstab, 41 rows, 1463 transcripts on disk

    running (20)
      uuid present | agent_type present | transcript present          19
      uuid present | agent_type present | transcript ABSENT (phantom)  1
    stopped, not archived (15)
      uuid ABSENT  | agent_type ABSENT  | -                            6
      uuid ABSENT  | agent_type present | -                            1
      uuid present | agent_type ABSENT  | transcript present           6
      uuid present | agent_type present | transcript ABSENT (phantom)  2
    archived (6)
      uuid ABSENT  | agent_type ABSENT  | -                            1
      uuid ABSENT  | agent_type present | -                            1
      uuid present | agent_type present | transcript present           1
      uuid present | agent_type present | transcript ABSENT (phantom)  3

Running rows still lacking a uuid: none. Still lacking an `agent_type`: none.
The one running phantom is row 45 `cloude_Punchlist Test`, a session that was
CREATED DURING this pass - a newborn whose transcript has not landed yet, not a
defect. **The population moves under you**: the row count went 40 -> 41 mid-run
and row 44's uuid changed between two reads. Re-measure, never quote this table
as current.

### Verification

- The backfill dry run, re-run after the writes, drops all 7 rung-(a) rows out
  of WRITABLE (8 -> 1) and still refuses the same 4 collision pairs.
- `GET /api/v1/sessions/restart/preview` on the live server reads
  `current_agent_type` = `claude-skip-permissions` for `cloude_Mac`,
  `cloude_Hirschfeld`, `cloude_daily-briefing` and `cloude_N8N`, and
  `claude-chrome` for `cloude_Fantasy Football 2026` and
  `cloude_Media_Compression`. Every wrapper option's predicted command for the
  three job-1 pairs carries `--resume` with the uuid the running row holds.

**`GET /sessions/list` IS THE WRONG SURFACE FOR THIS and cost time.** It
returned 2 objects, not 41: it lists what the RUNNING MANAGER currently holds,
which after a server restart was two re-adopted panes with ids
`adopted:cloude_*`, `session.claude_session_uuid` NULL, and an `agent_type` of
`claude` - a derived FAMILY label, not the stored wrapper id. It cannot verify a
`sessions.agent_type` write. Use `restart/preview`, whose `current_agent_type`
is the column. Note also the field is `current_agent_type`, not `agent_type`.

The deployed server is 1.0.33 and still predates `8dd54a8`, so its preview
reports `projected.kind: shell` and `conversation: none_recorded` even while the
option command it returns carries `--resume`. That is the undeployed
derive-from-argv logic, not a regression from these writes.

**CORRECTION, 2026-09-08.** The paragraph above misread the response and
attributed the mismatch to the undeployed `8dd54a8` deploy. It is not a
version-skew bug. `projected.conversation` and `options[].conversation`
(`src/api/restart_routes.py:104` and `:120`) are two different scopes
answering two different questions: `projected` describes what an UNPICKED
restart does right now, which lands on the `RESPAWN_SHELL` rung and so reads
`none_recorded`, while each entry in `options` describes what happens if the
caller explicitly PICKS that wrapper, which already carried `--resume` before
`8dd54a8` because an explicit choice overrides the shell gate
(`session_respawn.py:542`, see CLAUDE.md's restart section). Seeing
`none_recorded` next to a command carrying `--resume` in the same response is
expected on any deployed version, not evidence of which commit is live.
Deploying `8dd54a8` does not change this pair of fields; do not use it as a
deploy-verification signal.

### 2026-09-08 (same pass, later) retiring the three dead twins

Authorised after the refusal above. Rows 9, 10 and 38 RELEASE their phantom and
are archived; the live siblings 11, 12 and 39 were not touched and keep the
uuids they already held.

The archive shape is copied verbatim from `session_store.archive_session`
(`src/core/session_store.py:407`): it writes `archived_at` and `updated_at` and
NOTHING ELSE, guarded on `archived_at IS NULL`. `lifecycle` is deliberately not
in the SET clause - `session_close_lifecycle.py` owns that column and its
docstring says archive and close are separate writes. Rows 9 and 10 already
carried `archived_at`, so only row 38 needed the archive statement.

```sql
BEGIN IMMEDIATE;
-- x3: 9 / cloude_Mac / b60b65e7, 10 / cloude_Hirschfeld / 1b56e525,
--     38 / cloude_Fantasy Football 2026 / cd0d62de
UPDATE sessions
   SET claude_session_uuid = NULL,
       claude_session_uuid_source = NULL,
       updated_at = '2026-09-08T14:52:11.537212Z'
 WHERE id = ? AND tmux_name = ? AND claude_session_uuid = ?
   AND lifecycle <> 'running';
-- changes() = 1 each

UPDATE sessions
   SET archived_at = '2026-09-08T14:52:11.537212Z',
       updated_at  = '2026-09-08T14:52:11.537212Z'
 WHERE id = 38 AND tmux_name = 'cloude Fantasy Football 2026'
   AND archived_at IS NULL AND lifecycle <> 'running';
-- changes() = 1   (tmux_name in the real statement is 'cloude_Fantasy Football 2026')
COMMIT;
```

**Left alone, deliberately.** Row 41 `cloude_CloudeCode` holds phantom
`5ee3f9da` and has NO live sibling by tmux name or by realpath'd working_dir, so
there is nothing to prove where its conversation went; clearing it would destroy
the only pointer a future investigator has. Row 44 `cloude_Agent_-_Cloude_Code`
is being handled elsewhere. Row 46 is a running newborn whose transcript has not
landed yet.

**Final crosstab, 42 rows.** running (21): 20 sound, 1 newborn phantom.
stopped-not-archived (14): 6 no-uuid/no-agent_type, 1 no-uuid, 6
uuid+transcript/no-agent_type, 1 phantom (row 44, out of scope).
archived (7): 1 neither, 4 no-uuid, 1 sound, 1 phantom (row 41, no live sibling).
Phantoms remaining: 41, 44, 46 - each for a stated reason, none of them the
duplicate-pair defect this pass was about.

Later the same pass: the two GHOST rows minted by the sibling-`SessionStart`
defect (fixed in `2071963`, not yet deployed) were retired. Shape that identifies
them: `tmux_created_epoch IS NULL` AND `parent_session_id IS NOT NULL` AND
`lifecycle = 'stopped'`. Exactly two matched, rows 44 (parent 43) and 47
(parent 44), both `tmux_name = 'cloude_Agent_-_Cloude_Code'`. Row 44's uuid
`0f1a21b4` has no transcript; row 47's `dfac3b83` HAS one, but under a
scratchpad slug - a subagent's headless run, not the pane's conversation. Both
uuids were cleared: leaving 47's would let a future backfill treat a throwaway
run as a real conversation, which is worse than a null.

```sql
BEGIN IMMEDIATE;   -- archive, shape from session_store.archive_session
UPDATE sessions
   SET archived_at = '2026-09-08T15:03:29.887194Z',
       updated_at  = '2026-09-08T15:03:29.887194Z'
 WHERE id = ? AND tmux_name = 'cloude_Agent_-_Cloude_Code'
   AND tmux_created_epoch IS NULL AND parent_session_id IS NOT NULL
   AND archived_at IS NULL AND lifecycle <> 'running';   -- x2 (44, 47), changes() = 1 each
COMMIT;

BEGIN IMMEDIATE;   -- release the uuid
UPDATE sessions
   SET claude_session_uuid = NULL,
       claude_session_uuid_source = NULL,
       updated_at = '2026-09-08T15:03:29.887194Z'
 WHERE id = ? AND tmux_name = 'cloude_Agent_-_Cloude_Code'
   AND claude_session_uuid = ?          -- 44 -> 0f1a21b4, 47 -> dfac3b83
   AND tmux_created_epoch IS NULL AND parent_session_id IS NOT NULL
   AND lifecycle <> 'running';          -- changes() = 1 each
COMMIT;
```

No other row carries the ghost shape. Crosstab, 43 rows: running 21 (20 sound,
1 newborn phantom row 46); stopped-not-archived 13 (6 neither, 1 no-uuid, 6
uuid+transcript/no-agent_type, 0 phantoms); archived 9 (1 neither, 6 no-uuid,
1 sound, 1 phantom row 41). Phantoms remaining: 41 (no live sibling, kept as the
only pointer to where that conversation went) and 46 (newborn).

## 2026-09-08 - the first real boot re-adopt held ZERO of 21, deterministically

Deployed `1a28b23` to live (`deploy-mini.sh --target live --all`, exit 0, 484
files, prune removed nothing on either destination). v24 migrated cleanly.
The boot re-adopt then failed on every single owned session:

```
boot_readopt_complete: held=0 failed=20 skipped=1 live_count=21
                       id_sources={hook_token:0, legacy_row:0, derived:0} no_row=0
```

All 20 failures are the same error, `"backend not running"`, logged inside the
same millisecond (16:16:36.407237Z .. .407418Z). That timing is the tell: this
is not tmux being slow or flaky, it is a guard rejecting the call before any
tmux command is issued.

**The bug is an ordering one, and both halves are in `tmux_backend.py`.**
`attach_existing` computes `do_external_setup = needs_pipe_setup or
self._is_external` and calls `await self.ensure_pipe_pane()` at **line 913**,
but does not set `self._running = True` until **line 984**. `ensure_pipe_pane`
opens with, at **lines 1023-1024**:

```python
if not self._running and not self._is_external:
    raise RuntimeError("backend not running")
```

The boot path (`session_boot_readopt.py`, `_attach`) builds an OWNED backend -
not `TmuxBackend.for_external` - so `_is_external` is False, and `_running` is
still False because line 984 has not run yet. Both halves of the `and` are
therefore true on every owned session, every time. The guard was written for
the external-adopt path, where `for_external` sets `_is_external=True` and the
guard passes; the boot re-adopt is the first caller to reach it with
`needs_pipe_setup=True` on a NON-external backend, which is exactly why this
shipped looking correct.

**A guard whose only exercised caller sets the flag it checks has never been
tested.** The external adopt path can never fail this check, so nothing in the
suite ever observed the raising branch with `needs_pipe_setup=True`.

**The skip is not a second bug.** `skipped=1` is
`cloude_Punchlist_Browser_Rename_fork` (the one tmux name absent from the 20
failures) and it is `SKIP_ALREADY_HELD` - the rehydrated metadata session set
before the pass. It is the ONLY row in `/sessions/list` carrying its stored id,
`ses_37f3f6ee`. `no_row=0`, so nothing was skipped for lack of a row.

**The downstream damage is the hook path, via a re-minted id.** With held=0,
the orchestrator pane was not held under its stored id `ses_fb8dd410`. The
client then issued an explicit `api_adopt_session_request` (16:16:38) and it
came back as `adopted:cloude_Agent_-_Cloude_Code` - an `adopted:` re-mint of a
session that HAS a row. Its hook env still carries a token bound to
`ses_fb8dd410`, so `validate_hook_token` fails and `routes.py:2148` returns
**403**, 94 times in the first four minutes, all for that one id. Zero hook
POSTs were accepted after the restart. Note the status: **403, not 410** - if
you grep for 410 expecting the stale-session code you will find nothing and
conclude the hook path is fine.

So a single boot defect produced three symptoms that each look like their own
bug: sessions missing from the list, an `adopted:` id where a stored id was
expected, and a dead hook/toast path. Fix the ordering at line 913/984 (or
build the boot backend as external) and all three should go together.

Unrelated, but it accumulated during this pass: `cloude.db` is 4.6 GB and the
state dir now holds six 4.6 GB `cloude.db.bak-*` copies (~24 GB), including a
new `cloude.db.bak-v23-20260908T161615Z` written by the v24 migration.

## 2026-09-08 - the boot re-adopt now holds 21 of 21, and the two defects behind zero

Shipped `01ebb85` then `41a89f1`, both deployed to live (`deploy-mini.sh
--target live --all`, exit 0, 485 files, 2 destinations, verified both
directions). Final live boot at 16:47:36Z:

```
boot_readopt_complete: held=20 failed=0 skipped=1 live_count=21
                       id_sources={hook_token:20, legacy_row:0, derived:0} no_row=0
```

**The skip is not a failure.** It is `cloude_Agent_-_Cloude_Code`, already held
under `ses_fb8dd410` by the single-session `session_metadata.json` rehydrate
that runs before the pass, so it lands on `SKIP_ALREADY_HELD`. 20 held + 1
already held = 21 of 21. `GET /sessions/list` returns **21 rows, 21 distinct
tmux names, zero `adopted:` ids, zero names bound twice**.

### Defect 1 - a guard whose only exercised caller sets the flag it checks

`attach_existing` called `ensure_pipe_pane()` at line 913 and did not set
`_running` until 984; the guard was `not self._running and not
self._is_external`. The boot pass builds an OWNED backend, so both halves were
true on every session: 20 failures, all `"backend not running"`, all inside one
millisecond, before any tmux command ran.

Fixed by threading intent - `ensure_pipe_pane(attaching=True)`, passed only
from inside `attach_existing`, after `is_alive()` and the `#{pane_dead}` probe
have both answered. NOT by setting `_running` early: that would make the
backend claim it was streamable across four tmux round trips and leave the
claim standing on an object whose setup raised.

**Why 4874 green tests missed it.** `tests/test_boot_readopt.py` is hermetic
and its `FakeBackend.attach_existing` is two lines with no guard in it. A
double cannot reproduce a guard. Until this pass existed the only caller
reaching that branch was the external adopt path, where `for_external` sets
`_is_external=True` and the check CANNOT fail - so the raising branch had never
once been observed. `tests/test_boot_readopt_real_tmux.py` now drives the REAL
`TmuxBackend` on a throwaway per-process socket; against `b276b68` it
reproduces the incident in-process (`held=0 failed=2`, `backend not running`).

### Defect 2 - adopt-on-open minted a second identity, and the token trap inside it

`adopt_external_session` opened with the literal `adopted_id =
f"adopted:{name}"`. For a session that HAS a row that is wrong: the pane's
agent carries its create-time id and a token bound to it, so an invented id
makes every hook POST answer **403, not 410**. The id is now resolved through
the boot re-adopt's own ladder (`session_adopt_identity.py`, importing
`resolve_session_id` rather than rebuilding it), keyed on the instance triple.
Live confirms it: `adopt_rekeyed_to_stored_id ... ses_fb8dd410 id_source=hook_token`.

**The half that would have shipped looking right.** `_mint_hook_token`
REPLACES the token it holds. Re-keying and then minting rotates the exact
credential the running agent cannot be handed a replacement for, so the 403
storm returns wearing the correct id and every log line looks right. A re-keyed
adoption calls `_keep_hook_token` instead.

Note `persist_adoption` records the sighting BEFORE the id is resolved, so a
row exists for every adoption. What keeps a true external session on
`adopted:<name>` is the LADDER degrading - a fresh `observed` row carries no
`legacy_session_id` and no hook-token mapping - not a test for a row's
existence.

### Defect 3 - found only because the deploy was verified against what the user sees

The first deploy's log line was perfect (`held=20 failed=0`) and
`/sessions/list` still returned **22 rows for 21 live tmux sessions**. The
rehydrate had registered the pane as `adopted:cloude_Agent_-_Cloude_Code`, the
adopt correctly re-keyed to `ses_fb8dd410`, and the teardown - keyed on the
resolved id - did not match the stale registration. One pane, two backends, two
tailers on one FIFO.

While the id was always `adopted:<name>`, "the registration for this id" and
"the registration for this pane" were the same question. Resolving the id made
them different. `_registered_ids_for_tmux_name` now drops every registration
bound to the pane. **Had I stopped at the log line, this would have shipped.**

### The 403s that remain, and why they are not a regression

Since the 16:47:36Z boot: **1 hook 200, 43 hook 403**. Every one is accounted
for - 41 from `adopted:cloude_Agent_-_Cloude_Code`, 2 are my own deliberate
negative controls. The 41 are a pre-existing casualty of the OLD code's
unconditional mint: that pane's long-running `claude` process holds an
`adopted:` id and a rotated token in its OWN process environment, and tmux
`set-environment` only reaches NEW processes. Measured:
`tmux -L cloude show-environment -t cloude_Agent_-_Cloude_Code
CLOUDECODE_SESSION_ID` now reads **`ses_fb8dd410`**, so the pane is correct and
the next process launched in it will present the right id. Nothing can
retroactively hand a rotated credential back to a process already running.

Positive proof on the current build, since idle sessions emit no hooks: a POST
for re-adopted `ses_c61bfd43` (tmux `cloude_Hirschfeld`) with its own token
answered **200**; bogus token **403**; unknown session **403**. Real agent
traffic in the previous boot's window independently shows 6 accepted POSTs with
`toast_recorded` for `ses_c61bfd43`.

Controls: no-token `/sessions/list` **401**, bogus asset **404**, real asset
**200**. tmux before vs after the two restarts: **identical, same 21 names and
the same 21 `#{session_created}` epochs** - nothing on the live socket was
killed or recreated.

**A measurement artifact worth remembering.** An early count of "14,174 hook
200s since the restart" was wrong: `awk '/hook_tokens_restored/{seen=1} seen'`
triggers on the FIRST occurrence in a 1.7M-line log, not the latest restart, so
it counted the file's entire history. Anchor a window on a timestamp, not on an
event name that recurs every boot.

Suite: 3 failed / 5177 passed / 12 skipped - the 3 are the environmental
failures CLAUDE.md already names. Node: 182/183, only the pre-existing
`test_archive_full_page_mode.node.mjs`.

## 2026-09-11 / 2026-09-12 - SIX CHECKS THAT WERE GREEN WHILE MEASURING NOTHING

Six of these in two days, across the 1.4.0 release, the deploy and the
integration round. They are collected here rather than filed one per incident
because **the mechanism is what transfers and the mechanism is the same every
time**: the thing being measured went ABSENT, and absent compared equal - or
the complaint the tool did make was routed somewhere nothing was reading.

Each entry below gives the mechanism, then what was measured, then the control
that would have caught it. Every measurement in this section was re-taken on
2026-09-12 in a throwaway directory or against `b5de919` in a clean worktree,
not quoted from the original report. Where a claim could NOT be reproduced,
that is said in the entry rather than smoothed over.

**THE RULE UNDERNEATH ALL SIX: A GREEN CHECK MUST FIRST PROVE IT CAN GO RED.**
Plant the thing the check exists to catch, watch it fail, then remove the
plant. A check that has never been observed failing is unmeasured, not proven.
This is the same discipline `StatusMap.complete`, the recreate gate's `gone`
versus `unknown`, `db_integrity`'s `cannot_determine` versus `failed` and
`InstanceIndex.complete` already encode in the product: a reading that did not
happen is kept apart from a reading of nothing.

### 1. A bare `dist/` in `.gitignore` swallowed the committed bundle

**Mechanism.** A `.gitignore` pattern with no leading slash matches at ANY
depth. `dist/` sits in the Python section at the top of the file, aimed at
setuptools output, and it therefore also matched `client/dist` - the vite
bundle that `scripts/deploy-mini.sh` ships by tar and that the mini, which
runs no build, has no other way to obtain. An ignored bundle is not in the
tracked file list, so it is not in the tar, so it is not on the mini. **And
every hash check in the deploy would still have read green, because the file
was absent on BOTH sides and absent compares equal to absent.**

**Measured 2026-09-12**, in a throwaway `git init` with one file:

    .gitignore = "dist/"            -> git check-ignore -v client/dist/app.js
                                       answers .gitignore:1:dist/  (exit 0)
    .gitignore = "dist/\n!client/dist/"
                                    -> no output, exit 1

At `b5de919` the negation is present and `git check-ignore -v
client/dist/app.js` exits 1, so this is closed. `.gitignore` itself now
carries a comment block recording the 2026-09-09 measurement.

**The control.** `dl_remote_hashes` already had it and it is the shape to
copy: a file it cannot hash becomes an explicit `MISSING <path>` line rather
than vanishing from the comparison, "because absent on both sides compares
equal and that is how a verification step silently checks nothing". The
bundle check needed the same posture one level up - assert the file is IN the
tracked list before comparing hashes of it.

### 2. A docs drift guard whose grammar could not express its own subject

**Mechanism.** `tests/test_docs_operations_chart_drift.py` holds
`docs/session-project-operations.md` to its citations: every
`path::symbol` in the chart must resolve. Both of its regexes matched only
the `src|client|tests|macOS` roots and the `.py|.js` extensions. Svelte slice
7 then deleted `client/js/launchpad.js` and moved those actions into
`web/src/**/*.ts`. **A citation repointed at the new home would have stopped
matching the citation grammar entirely, which does not fail - it reclassifies
the line as ordinary prose.** The guard would have gone on passing while
holding nothing, forever, and the document it guards would have become fiction
with a green suite behind it.

Same commit, same shape, a second guard: `test_client_called_routes_exist.py`
scanned `client/js` only, so it went SILENT on the entire Svelte client the
moment slice 7 landed.

**Fixed in `882073e`.** Both now accept the `web` root and `.ts` / `.svelte`.

**The control, and it is the load-bearing part.** Both of those assertions are
"nothing was found", which is the exact shape that passes when the collector
is broken. So the fix added `test_the_web_src_arm_actually_fires`, which
plants a call in a stand-in tree and proves the arm REPORTS it, and proves a
commented path and a test file are NOT reported. The commit records that the
control itself was watched failing with the arm disabled. A planted bogus
`web/` symbol and a planted bogus `web/` module were each watched turning the
drift guard red.

### 3. `rsync --no-compress` on macOS: zero bytes copied, and the failure eaten by a pipe

**Mechanism, and the summary of this one that circulated was WRONG in a way
worth correcting.** macOS ships Apple openrsync ("protocol version 29, rsync
2.6.9 compatible"), not GNU rsync 3.x, and it does not have `--no-compress`.
Measured 2026-09-12 on this box:

    rsync --no-compress /dev/null /tmp/x
      -> exit 1, 0 bytes on stdout, 1392 bytes on STDERR
         ("rsync: unrecognized option `--no-compress'" plus usage)
      -> /tmp/x does not exist. Nothing was copied.

So **rsync itself did NOT exit 0 and did NOT print to stdout**; it failed
correctly and loudly. What made it green was the PIPELINE:

    rsync --no-compress ... 2>&1 | tail -1   -> exit 0
    ( set -o pipefail; same command )        -> exit 1

Without `pipefail`, a shell reports the exit status of the LAST element of a
pipeline, which is `tail`, which always succeeds. The `2>&1 | tail` that was
there to keep the log short is what discarded both the complaint and the exit
code.

**The control.** `set -o pipefail` in any script that pipes a command whose
failure matters, and never read exit 0 from a command whose stderr you
redirected into a truncating filter. Note this is also why `deploy-lib.sh`
uses tar over ssh rather than rsync at all - see its header for the separate
spaces-in-remote-path reason.

### 4. The deploy up-check passed against the DYING OLD PROCESS

**Mechanism.** `scripts/deploy-mini.sh` restarts the live server with a plain
`kill` of the pid that owns the port, and `kill` sends SIGTERM and RETURNS
IMMEDIATELY. The very next statement is the up-check loop:

    curl -s -o /dev/null --max-time 2 "http://$HEALTH_HOST:$PORT/"

That curl succeeds against ANY process answering on that host and port. For
the milliseconds or seconds between the SIGTERM and the old process actually
closing its listener, **the process answering is the one being killed**, so
the check reports the deploy up while the new code has not started. The
up-check has NO IDENTITY IN IT: it proves something answered, never that what
answered is what was just deployed.

Verified by reading `scripts/deploy-mini.sh` at `b5de919`, lines 394 to 421.
It is the only up-check in the script and it is unchanged there.

**The control.** Ask the server WHICH BUILD it is, not whether it is up: the
app already exposes `GET /api/v1/version`, and a check that compares the
version or a deployed-commit marker against what was just shipped cannot pass
against the outgoing process. The same discipline the deploy already applies
to files - it re-hashes the server dir AFTER the restart rather than trusting
the pre-restart hash - simply was not applied to the process.

### 5. The same check reported "up" with nothing listening - MECHANISM NOT ESTABLISHED

Reported from the same round: the up-check printed `- up` and exited 0 while
nothing was listening on the port.

**THIS ONE IS RECORDED AS UNRESOLVED RATHER THAN EXPLAINED, DELIBERATELY.**
The script as committed at `b5de919` cannot produce that from a closed port:
`curl` against a closed TCP port exits 7, the `if` fails, the loop retries,
and after 30 attempts `UP=0` takes the `say_failed` branch and `exit 1`. So
one of the following is true and this pass could not tell which:

- something OTHER than the freshly deployed server was answering
  `http://10.0.1.150:8000/` at that moment (the Electron supervisor
  relaunching it, or a stale process), which would make it entry 4 again
  rather than a distinct defect, or
- the observation came from a different check than this loop.

Do not write a mechanism for this one until it has been reproduced. An
invented explanation here would be worse than the gap, because it would close
an investigation that has not happened. **The agent working
`fix/deploy-upcheck-identity` owns this; fold their finding in here when it
lands.**

### 6. `tmux list-sessions` over a non-interactive ssh: "not found" read as "zero sessions"

**Mechanism.** A non-interactive `ssh host 'command'` does not run the login
shell's profile, so it gets a minimal PATH. Homebrew's `tmux` is not on it.
With stderr suppressed, `command not found` produces empty stdout, and code
that counts lines of output reads that as zero sessions - a positive,
confident, wrong answer about the live host.

**Measured 2026-09-12 against mac-mini-m4:**

    ssh mac-mini-m4 'echo $PATH'
      -> /usr/bin:/bin:/usr/sbin:/sbin
    ssh mac-mini-m4 'command -v tmux'
      -> nothing (not found)
    ssh mac-mini-m4 'zsh -lc "command -v tmux"'
      -> /opt/homebrew/bin/tmux

**The control.** Address the binary absolutely (`/opt/homebrew/bin/tmux`) or
force a login shell (`ssh host 'zsh -lc "..."'`), and NEVER discard stderr on
a remote command whose empty output you intend to interpret. An empty result
from a remote command has three causes - it worked and found nothing, the
command does not exist, or the connection failed - and they must not collapse
into one.

### What to do with this section

Two of these six were in DEPLOY tooling and two were in TEST tooling, which is
the uncomfortable half: the checks that exist to catch mistakes are themselves
the least-checked code in the tree, because nothing checks a checker. When you
write or touch one, the first thing you owe it is a run in which it FAILS.

## The new deploy up-check refuses on leg D with no retry (2026-09-12)

**Symptom.** The first real use of `scripts/deploy-restart-check.sh`, deploying
the consolidated `integration/1.3.0` to live, exited **3 (CANNOT DETERMINE)**:

```
confirming the old process exited - gone (was 38309)
waiting for a new process on :8000 ...- pid 19708, 5s old (restart was 11s ago)
  CANNOT DETERMINE: could not resolve the working directory of pid 19708.
```

**The deploy itself was fine.** Legs A, B and C all PASSED: the old pid was
gone, a new pid held the listener, and it was 5s old against an 11s-old
restart. Only leg D, the working directory, failed to read. Checked by hand
about a minute later, `lsof -a -p 19708 -d cwd -Fn` resolved immediately to
`/Users/jsugamele/Library/Application Support/cloude-code-menubar/server`,
which is exactly `DEST_SERVER`, so leg D would have passed on a retry.

**Root cause: leg D is read ONCE, inside the same probe that found the pid.**
`dl_probe_port` emits `CWD <pid> <dir>` in the same pass that emits `PIDS` and
`AGE`, and the caller polls only until a NEW LISTENER APPEARS. The moment a pid
is seen the polling stops, so the cwd is read at the earliest possible instant
in the new process's life, which is precisely when `lsof` is most likely to
come back empty for it. The 300s `DL_NEW_LISTENER_TIMEOUT` budget is spent
waiting for the pid and then not used for anything else.

**This is the check behaving correctly and still being wrong.** Refusing rather
than guessing is the right instinct and is why this file exists. But a refusal
that a two second retry would have cleared is a FALSE red, and the script's own
header argues at length that a false red on a live box is dangerous because it
"invites a human to start re-deploying or killing processes underneath 19
running sessions". That is the exact situation it created on its first run.

**The fix is to poll legs D, E and F within the remaining budget** rather than
taking one reading at the instant of discovery, and to distinguish "read and
came back empty" from "could not read" the way `__OK__` already distinguishes a
dead ssh from an empty port. NOT DONE HERE: this round only measured it. Do not
"fix" it by dropping leg D or by treating an unresolved cwd as a pass, which
would delete the only leg that catches a server started from the wrong
directory.

**Do not read a rc=3 here as a failed deploy.** Verify by hand in this order:
the listener pid, its `etime`, its cwd, then `curl --fail /api/v1/health`. If
the old pid is gone and the new one is young and in the destination, the deploy
landed and only the check could not say so.
