# Session identity, adoption, hook tokens, project binding, naming and themes: the record

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

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
attach to a tmux session it did not create. A TRULY external one - no row for
its instance triple - gets an id of `adopted:<tmux-name>` and is absent from
the owned tmux name set. Anything that parses, matches, displays or routes on a
session id has to handle both shapes. Strip the prefix to recover the tmux name;
do not assume the id is a clean display string.

**THAT SET LIVES ON `OwnedTmuxLedger`, NOT ON THE MANAGER, AND SO DOES THE FILE
THAT REMEMBERS IT.** `src/core/sessions/owned_tmux_ledger.py` owns the set (as
`.names`), the pre-v3 backfill sentinel, the boot listing,
`session_metadata.json` and the two datastore-backed ownership queries
(`is_owned_name`, `instances`). `SessionManager` holds one as `self._owned` and
keeps no copy and no forwarder; `build_services` hands the same object to
`AppServices.owned_tmux`, so a route reaches it there rather than through the
manager. `owned_tmux_sessions` is still the ON-DISK key in that file and must
stay spelled that way, because a v3 file written by an older build uses it.

Two halves of that file are unrelated and must not be confused: the owned set is
about EVERY session this app created, and the session pointer is about the one
most-recently-active. `drop_session_pointer` unlinks the pointer and re-writes
the set, because unlinking the file outright threw away N sessions' ownership
record to clean up one, on the ORDINARY path - after which every
launcher-created session resolved EXTERNAL. The write is tmp plus `fsync` plus
`os.replace` and `tests/test_owned_tmux_ledger.py` measures the protocol rather
than the resulting file, because a plain in-place write produces identical
contents and no atomicity.

**AN ADOPTION RESOLVES THE ID, IT DOES NOT MINT ONE, and the difference is the
hook path.** `adopt_external_session` opened with the literal
`adopted_id = f"adopted:{name}"` until 2026-09-08. That is wrong for a session
the app already has a row for. `get_env_for_spawn` puts `CLOUDECODE_SESSION_ID`
into the pane at `new-session` time, so the agent inside presents its
create-time id on every hook POST for life, with a token bound to THAT id;
registering the same live pane under an invented id makes `validate_hook_token`
answer False and `routes.py` return **403 - not 410**, so grepping for the
stale-session code finds nothing and the hook path looks healthy. Measured:
94 refusals in four minutes for one session. `src/core/session_adopt_identity.py`
now resolves the id through the boot re-adopt's OWN ladder
(`session_boot_readopt_plan.resolve_session_id`, imported rather than rebuilt,
so the two paths cannot name one pane two things), keyed on the instance triple
via `session_store.get_instance`.

Note it is NOT "a row exists, so reuse its id": `persist_adoption` records the
sighting BEFORE the id is resolved, so a row exists for every adoption by then.
The derived rung is reached because a fresh `observed` row carries no
`legacy_session_id` and no hook-token mapping.

**ONE PANE IS ONE REGISTRATION, so the adopt teardown keys on the tmux NAME.**
While the id was always `adopted:<name>`, "the registration for this id" and
"the registration for this pane" were the same question. Resolving the id made
them different, and keying the teardown on the id alone leaves the other one
behind. Measured on live minutes after the re-key shipped: the rehydrated
`session_metadata.json` entry held `cloude_Agent_-_Cloude_Code` as
`adopted:cloude_Agent_-_Cloude_Code`, the browser's adopt correctly re-keyed to
`ses_fb8dd410`, and `GET /sessions/list` returned **22 rows for 21 live tmux
sessions** - one pane, two backends, two tailers on one FIFO.
`SessionRegistry.registered_ids_for_tmux_name` is what enforces the rule; it
lives on the registry rather than the manager because it has to run against
the very `backends` dict the registration path writes, and a second dict
holding a copy answers every equality assertion while missing the second
registration. Note this was caught
only because the deploy was verified against `/sessions/list` rather than
against the `boot_readopt_complete` log line, which was perfect.

**AND A RECOVERED ID MUST NOT BE RE-MINTED A TOKEN.** `_mint_hook_token`
REPLACES the token it holds for an id. Called on a re-keyed id it revokes the
credential the running agent is holding and cannot be handed a replacement for,
so the 403 storm returns wearing the correct session id and every log line looks
right. A re-keyed adoption calls `_keep_hook_token` instead, which re-binds the
tmux name and leaves the secret alone; a derived id still mints exactly as
before.

**AND WHEN A MINT DOES LAND ON A RUNNING AGENT, IT IS NOW RECOVERABLE
ONCE.** The rule above is the prevention; this is the net under it,
because the failure is invisible from inside the pane and cost 4h24m of
dead hooks on 2026-09-08. Traced to the millisecond: a derived-id adopt
minted at 16:16:40.633984Z, the first `hook_post_rejected_invalid_token`
for that id landed 130 ms later at 16:16:40.763005Z, and 4,325 followed
until the owner restarted the pane by hand at 20:40:23Z. The same id was
being ACCEPTED minutes before (`toast_recorded` 16:11:28Z), so it was a
rotation, not a misconfiguration. `src/core/hook_token_recovery.py` keeps
a bounded IN-MEMORY ring of tokens this process minted and then replaced;
on a rejection, `SessionManager.recover_hook_token` accepts a value ONLY
if this server minted it for THAT id on THAT pane and superseded it, then
re-binds the store to what the running process holds, logs
`hook_token_rebound_from_superseded` once, and NEVER MINTS - minting is
the defect, and a recovery that minted would revoke the credential again
while every log line read correctly. `RECOVERY_NO_MATCH` (searched, not
found) is kept apart from `RECOVERY_UNAVAILABLE` (nothing to search, or
the pane binding is unknown); both refuse, but only the first says
anything about the token. THE NEGATIVE CONTROL IS THE LOAD-BEARING TEST:
a recovery that accepted broadly would pass the positive test perfectly
and be a credential bypass. In memory only is deliberate - a mint plus a
restart is not recoverable this way, and the restart already has its own
answer.

**A HUSK ON THE SOCKET CAN OUTLIVE ITS PROCESS, AND ADOPTING IT USED TO BE
A SERVER FAULT.** `remain-on-exit on` keeps a dead pane's tmux session on
`cloude`'s listing after its process exits, so the session still shows up
as adoptable and still passes `is_alive()`. `TmuxBackend.attach_existing`
already probed `#{pane_dead}` before doing any external-adopt setup, but
until 2026-09-13 both a MEASURED dead pane and a probe that simply could
not run shared one bare `RuntimeError`, which the adopt route has no
special handling for and answers with a 500. On 2026-09-13 one husk,
`cloude_cloudecode-4`, produced seven identical 500s across ninety minutes
because the listing kept offering it and the user kept clicking adopt.

The fix splits the two failures apart rather than adding a special case
for this one husk. `PaneDeadError(RuntimeError)` in `src/core/tmux_backend.py`
is raised ONLY when the probe RAN and read `"1"` - a positive measurement
of death. `SessionManager.adopt_external_session` catches it and re-raises
the existing `AdoptTargetGoneError`, the same error the listing-vs-click
race above already raises, so `src/api/session_attach_routes.py` needed no
new branch: it already maps that error to 409 `session_gone` with
`refresh: true`, telling the client to drop the row and re-list rather
than retry the same dead adopt. The probe-FAILED branch (tmux timed out,
errored, or the command otherwise did not complete) deliberately still
raises the bare `RuntimeError` and stays a 500, on the same discipline
`StatusMap.complete` and the recreate gate's `gone` versus `unknown` use
elsewhere in this app: not having been able to measure death is not
evidence of it, and answering that case with a client-facing "gone" would
be a guess wearing a confirmed fact's clothing.

`PaneDeadError` subclasses `RuntimeError` on purpose. The boot re-adopt
pass and the single-session rehydrate both already tolerate a bare
`RuntimeError` from this method, so neither needed to change to keep
working when this exception now arrives as a more specific subclass.
Regression coverage: `tests/test_adoption_three_outcomes.py` and
`tests/test_session_backend.py`, including a real-tmux case that kills a
pane's shell and asserts `PaneDeadError` rather than a generic
`RuntimeError`.

**EVERY SESSION BELONGS TO A PROJECT, AND THE ROW IS WHERE THAT LIVES.**
The owner's rule, verbatim: "all sessions belong to projects, the root folder
... its impossible to not have a project." Nothing in memory carries it - the
`Session` model (`src/models/sessions.py:45`) has no project field and `SessionInfo`
ships none, so `/sessions/list` cannot lose a project and cannot restore one.
The launchpad tree reads `project_id` / `project_attribution` off
`GET /sessions/records`, joined to the live session by tmux name plus epoch in
`buildProjectSessionGroups` (`web/src/lib/launchpad/project-groups.ts`, moved
there by slice 4 from `client/js/launchpad.js:3878`), and it tests
`attribution === 'none'` BEFORE it looks at `project_id`. So a row carrying
both an id and `none` renders under "no project" while holding a perfectly good
one, which is what the owner saw. The invariant is enforced in
`src/core/session_project_binding.py` and nowhere else: `resolve_project_binding`
is the ladder (as-written match, then the same path canonicalised, then a minted
project, then `none` for a scratch dir, then `unknown`), and `columns_to_write`
is the rule that **THE PAIR MOVES TOGETHER OR NEITHER MOVES**. It is called from
`persist_adoption` (`session_adopt_persist.py`, `allow_create=False` - re-entering
a session is not a moment to invent a project) and from `persist_creation`
(`session_create_persist.py`, `allow_create=True`), while `create_project`
(`project_writes.py`) adopts the project-less live rows already under its new
root, which is punchlist 16 closed from both directions.

Two things caused this and both are worth keeping. First, a HALF-WRITE:
`claim_instance` applies each column "only when not None", so a derived
`(None, 'none')` skipped the id and wrote the attribution ALONE - the row kept
its project and acquired a value contradicting it. "Only when not None" reads
as conservative and is not, when the columns are a pair. Second, a SPELLING the
lexical matcher cannot cross: `project_attribution.attribute` refuses to resolve
symlinks, correctly, so a session probed at `/Users/jsugamele/Development/...`
could never match a project declared at the iCloud path that same directory
resolves to. Canonicalising is a FALLBACK RUNG, tried only after the as-written
match fails, so a project declared at a symlink still collects the sessions
declared there. Measured 2026-09-08: rows 7 and 8 held projects 1 and 2 beside
`none`, row 45 held NULL from the create race, and 3 of 22 running sessions
rendered project-less.

**The ledger is keyed by the tmux INSTANCE, not by `session_id`, and that is not
interchangeable with `SessionActivityTracker.hooks_seen`.** A confirmed live
restart (`respawn-pane -k`) keeps the session_id AND the epoch and moves only the
pane pid, so `StartupGateLedger` keys on (epoch, pane_pid) and drops the whole
record - first-hook time and toast claim together - when either is MEASURED to
move. A null never resets, or the ledger would reset every poll and re-toast
forever. And every hook kind feeds it, not just `SessionStart`: hooks are
droppable, and a session whose `SessionStart` was lost but whose `PreToolUse`
landed is plainly past its prompt. Feeding it one event kind would rebuild the
one-shot-channel-with-no-retry defect that cost this project sixteen conversation
ids.

Note for anyone touching `src/core/agent_fingerprint.py`: its
`^\s*❯\s*1\.\s*Yes, I trust this folder` pattern CANNOT fire on claude 2.1.263.
The live capture shows no option numbers and the cursor on "No, exit", so the
options read `❯ No, exit` then `  Yes, I trust this folder`. The startup gate
matches the sentence text instead, for exactly that reason.

**`unknown family` on a row whose record says `not_launched` is DATA, not a bug,
AND IT IS NOW FILLED FROM THE PANE'S OWN PROCESS.** The shape is
`agent_type` NULL beside `agent_family_source='not_launched'`: the
`auto_start_claude:false` plus a hand-sent claude command case named under
"Restarting a session" above. Both halves of the record are true - the app
really did open a bare shell and really did start no agent - and neither can
say what the human then typed into the pane. Re-measured 2026-09-08 on the
owner's box: 12 rows carry that shape (it read 27 of 40 earlier; the
population moves, re-measure rather than quoting either), and none of the 19
live panes does, because every live row already carries a wrapper id.

`src/core/session_agent_infer.py` is the ladder,
`session_agent_infer_apply.py` the per-session seam and
`session_agent_infer_sweep.py` the fleet pass. **THE EVIDENCE IS THE PANE'S
PROCESS**: the claude command line in its process tree (one `ps -A`, walked
with `claude_resume_argv`'s existing traversal rather than a second one),
because that is the only thing that can tell `claude-chrome` from
`claude-skip-permissions` - they fire identical hooks, print identical banners
and differ only in their flags. `#{pane_current_command}` CORROBORATES and
never creates: it answers the family when its basename is literally `claude`,
and the claude VERSION STRING that 15 of 19 live panes report there selects no
rung at all.

**A HOOK IS NOT THE TRIGGER, AND ASSUMING IT WAS ALMOST SHIPPED A RUNG THAT
COULD NEVER FIRE.** tmux copies `CLOUDECODE_SESSION_ID` and
`CLOUDECODE_HOOK_TOKEN` into a pane's process AT SPAWN, so a claude a human
typed into an already-running pane has neither and never announces itself.
Measured 2026-09-08: 10 of the hand-started `not_launched` sessions have never
fired a hook and never will - which is exactly the population this feature
exists for. So the read is driven three ways: `sweep_live_sessions` at the END
of the boot re-adopt pass and after an adoption, plus the per-session hook path
for a session that DOES carry the env. A hook remains the STRONGEST evidence
where it exists (it proves a claude is running before anything is read); its
ABSENCE is simply not evidence of absence. The sweep costs TWO subprocesses for
the whole fleet, and only if a row needs them - the row gate runs first, so a
box whose sessions all carry an `agent_type` spends no `ps` at all. There is no
periodic re-sweep yet, which is the known gap.

**THE ANCHOR GATE IS WHY THIS CANNOT ALWAYS FIND SOMETHING.** A wrapper is
named only when the observed argv carries at least one distinguishing flag AND
exactly one configured claude-family wrapper passes that same set - equality,
not subset, or a wrapper passing `--dangerously-skip-permissions` would claim
a pane running that plus `--chrome`. Empty agreeing with empty is the absence
of evidence, not two facts agreeing. Measured against the owner's real five
wrappers: `cld`, `cldl` and `claude-skip-permissions` all reduce to the same
single flag, so 16 of the 19 live panes tie three ways and get the bare family
`claude`, and only the 3 running `--chrome` resolve to a wrapper id.

The value is stored with `agent_family_source='inferred_process'`, a SIXTH
family source that renders as the dashed guess pill, never the solid one. It
is kept apart from `fingerprint` because the two were measured differently: a
process read is the stronger guess, which is why it is the one guess allowed
to name a wrapper, and it is still a guess. Writing it broke the premise
`session_agent_evidence` was built on ("nothing writes an inference into
`agent_type`"), so the row's source now travels with its value through
`identity_for_live_name`, `choose_agent_evidence` and `stored_launch_for` -
read one without the other and a guess paints solid.

**AN INFERENCE IS NOT INTENT, so `session_agent_infer.restart_agent_type`
keeps it out of the respawn ladder entirely.** `session_respawn.py` is
unchanged: `RESPAWN_SHELL` still fires on an empty `#{pane_start_command}`,
which is this whole population, and it fires BEFORE `agent_command` is
consulted - so filling `agent_type` could never have changed that rung anyway.
What it could have changed is an ADOPTED session with a real recorded start
command, silently moving it off `RESPAWN_REPLAY` on a guess, and that is what
`restart_agent_type` refuses. The restart picker's explicit choice remains the
only thing that overrides the gate.

The write happens at most once per pane: the WHERE clause requires
`agent_type` empty and the source not `launched`, which the first success makes
false, and an in-process memo keyed on the tmux INSTANCE keeps a `ps` off the
`PreToolUse` path. Steady state on a healthy box is one indexed SELECT per pane
per server process and no subprocess at all.

## The conversation id, and how a row loses it

`sessions.claude_session_uuid` is the id a restart resumes: the row's copy of a
transcript uuid. Do not conflate it with the instance triple, a pin id or a
project name. Everything in this section was traced to file and line on 2026-09-08 and
shipped in `8dd54a8`. **Note that `8dd54a8` is committed but not deployed at
the time of writing**, so a live install may still be showing the old
behaviour.

| Piece | File |
|---|---|
| Second chance at correlation when the hook writes nothing | `src/core/session_lineage_recovery.py` |
| How Claude Code actually slugifies a working directory | `src/core/claude_project_dirs.py` |
| The correlation ladder itself | `src/core/claude_transcript_correlate.py` |
| Propose a uuid for a row that lacks one | `src/core/session_uuid_backfill.py` |
| What counts as evidence, and what only corroborates | `src/core/session_uuid_backfill_rules.py` |
| Render the proposal for a human | `src/core/session_uuid_backfill_report.py` |
| The operator entry point, DRY RUN BY DEFAULT | `scripts/backfill_claude_session_uuid.py` |

**A ONE-SHOT CHANNEL WITH NO RETRY IS THE WHOLE PROBLEM.** On the create path
the uuid had exactly ONE writer, Claude Code's `SessionStart` hook. An empty
POST body becomes `{}` at `routes.py:2108`, `session_manager.py:4341` returns
`LINEAGE_UNRESOLVED`, and nothing is written. The live log holds 25 such
failures across 20 distinct sessions, and 16 of 39 rows carried no uuid at all.
Contrast the other hook events, which repeat: that is precisely why
`last_work_at` self-heals on the next event and the uuid never did. If you add
a field fed by a hook, ask which of the two kinds of event feeds it, and give
the one-shot kind a recovery path rather than a log line.

**A FALLBACK THAT CANNOT FIRE IS NOT A FALLBACK, AND IT IS INVISIBLE.**
`slugify_project_dir` mapped only `/` and `.`. The real rule replaces
EVERYTHING outside `[A-Za-z0-9-]` with a single `-`, verified against 908 of
919 live transcripts. Every path on the developer's machine contains a space
and two tildes, so every slug the ladder built was wrong and the fallback had
NEVER ONCE SUCCEEDED there. It looked exactly like a fallback that was never
needed. A ladder rung that has never been observed to fire is unmeasured, not
proven.

**A RECORDED uuid IS NOT EVIDENCE A TRANSCRIPT EXISTS.** Rows fall into three
groups, not two: over 39 rows, 16 absent, 18 sound, and 5 PHANTOM, holding a
uuid with no file behind it. All 5 phantoms collide with a sibling row, because
the correct uuid is already held by the twin that the cwd spelling trap split
off. The mechanism is `--fork-session`: it MINTS A NEW uuid, `SessionStart`
records the new one, and the forked transcript may never materialise. So the
picker can say "no transcript for <uuid>" perfectly truthfully about a uuid
that has nothing to do with the conversation the user is in, while the real
73 MB transcript sits on the archived twin. A message can be locally correct
and lead every reader to the wrong conclusion.

**Both cwd spellings must be resolved in BOTH directions.** Forward, by
slugifying every spelling found in a HOME symlink scan; and backward, from each
transcript's own recorded cwd, canonicalised. Backward is not optional: 754 of
919 transcripts sit in a directory that disagrees with their own recorded cwd.

**Evidence is counted in independent FAMILIES, and weak signals corroborate
rather than create.** Two matcher defects were caught by CONTROLS, not by
reading the code, and both would have shipped looking right. Directory
agreement was clearing a two-signal bar as one fact corroborating itself. And
the negative control, a row pointed at a project that does not exist while real
transcripts are present, returned `ambiguous` instead of `no_candidate` because
timing alone counted as evidence; an anchor gate now lets timing and title
corroborate a candidate and never create one. **A matcher that always finds
something is worse than useless**, so a negative control is mandatory for
anything in this family.

**`agent_type` is a SEPARATE failure, do not fold them together.** A crosstab
over all 39 rows finds 14 with `agent_type` NULL and a hook-written uuid. The
two are independent, and the `agent_type` persistence gap is still its own open
item.

## Naming a session, and the one name rule

ONE NAME PER SESSION, LAST RENAME WINS FROM EITHER SIDE. It lives in three places
- `sessions.title` (the browser), claude's own name (`--name`, `/rename`) and the
jsonl's `custom-title` record, where the two writers MEET. See
`src/core/claude_title_sync.py` (tail reader + rules), `claude_title_sync_apply.py`
(the seam, run from the hook route on every event), `claude_rename.py` (push out).
**NO HOOK EVENT CARRIES A `/rename`** - claude intercepts slash commands before
they become prompts - so the pane's name is only readable by READING THE
TRANSCRIPT. Last 64 KB only, 0.274 ms median against a 244 MB file, because this
runs on `PreToolUse`; an older rename reads `no_record` and changes nothing.
`sessions.claude_title` stops being dead weight and becomes the marker that makes
the sync idempotent under duplicated events.
**FIRST SIGHT OF A TITLE IS A BASELINE, NOT AN INSTRUCTION**: `custom-title` has
no timestamp, so it cannot be ordered against the label already on the row.
**A BOUND uuid IS NOT EVIDENCE A TRANSCRIPT EXISTS** and the push paid for it -
14:47:41Z 2026-09-08, a rename logged `claude_rename_pushed` and delivered
nothing because the file appeared 2m33s later, `--resume` exited 1, stderr went to
DEVNULL. `decide_push` now defers on a MEASURED absence only (`unchecked` still
sends) and `spawn_oob_rename` reaps and logs.
**THAT DEFERRED PUSH IS NOW RETRIED, A BOUNDED NUMBER OF TIMES, AND THE HARD
PART IS THE ORDERING RATHER THAN THE RETRY.** Measured on live 2026-09-16, 4 of
941 rows carry `title != claude_title` and one had been diverged since
2026-09-04. `src/core/claude_rename_retry.py` is the pure ladder,
`claude_rename_retry_store.py` the durable ledger and
`claude_rename_retry_apply.py` the seam, hung off the tail of
`sync_claude_title` because that pass has already read every field the retry
needs. THE ORDERING IS A WITNESSED STATE, NOT A CLOCK: `TITLE_APPLIED` writes
BOTH columns to one value and a browser rename writes `title` ALONE, so a
divergence is orderable exactly when the two columns were once seen to AGREE and
`claude_title` has not moved since. The ledger records that agreement. A row with
no such frame answers `unordered` and pushes NOTHING - which is the right answer
for the two live rows whose claude-side name may well be the newer one, and the
whole reason this is not a loop that re-sends a label. The push is additionally
gated on the transcript's own newest `custom-title` still equalling
`claude_title` (the sync's `TITLE_UNCHANGED`), so a silent or unreadable window
authorises nothing and spends no attempt. THE BOUND IS 5 PUSHES per distinct
label with a 60s floor between them, which spans four minutes against the 2m33s
transient above; `exhausted` and `superseded` are the named terminal states, a
new label starts a fresh budget, and the budget is durable so a restart cannot
refill it. `CLOUDE_RENAME_RETRY=0` switches it off and it defaults OFF under
`CLOUDE_TEST_MODE`, so a pytest run can never spawn `claude --resume` against
the developer's corpus.
**The plain create endpoint was the one creator passing no label**, so only
launchpad sessions launched claude with no `--name`; `CreateSessionRequest.label`
closes it, and an absent label leaves the command line byte-identical.

## Where a new project's folder comes from

A project's directory is `sessions.working_dir`, and it is permanent: the
row carries it, the launcher lists it, and the archive derives a
transcript directory from it. So the create path is the one place that can
poison every downstream reader, and until 2026-09-08 it did.

| Piece | File |
|---|---|
| Compose, validate and create the directory | `src/core/project_directory.py` |
| The folder step, and the pure rules behind it | `web/src/lib/launchpad/project-folder.ts` and `project-folder.test.ts` (slice 6 moved it out of `client/js/project-create-folder.js`, which is DELETED) |
| Where it is wired in | `src/api/session_crud_routes.py` (`create_session`), `web/src/lib/launchpad/create-flow.ts` (slice 6 moved it out of `launchpad.js::_createNewSessionInner`) |

**"START EMPTY" HAD NO FOLDER STEP AT ALL.** The chain was "+" > new
claude project > start empty > provider > name this project > create
session, and nothing in it ever asked where the project should live. The
client posted a name and no `working_dir`, so `SessionManager.create_session`
fell through to `work_path = settings.get_working_dir() / session_id` and a
project the user named `Punchlist Test` was created at
`.../ses_5a756046`. That is not a folder anyone chose, recognises, or can
find later, and it was written into the row as the project's home. The
fallback is still there for an old client, but it now logs at warning
level: it went unnoticed for as long as it did precisely because it was
silent.

**THE SECOND DEFECT WAS IN THE SAME LINE, AND IT IS GOTCHA 6.** That path
was built with `Path.expanduser()`, which expands `~` and stops. It does
NOT resolve symlinks, so `~/Development` stayed the SHORT spelling of a
directory that really lives in iCloud, and a short spelling is how one
directory becomes two projects. `project_directory` canonicalises with
`os.path.realpath` instead, so the LONG spelling is what reaches the row.
`tests/test_project_directory.py` asserts that against a real symlink
rather than trusting the reading.

**THE NEW FIELD IS `project_parent_dir`, NEVER `working_dir`.** Three
shipped flows already post `working_dir` with a folder from anywhere on
disk: "open an existing folder", the new-console FAB (it posts `~`), and
clone. Attaching a root restriction to that field would start refusing
folders they have always accepted, which is a worse bug than the one being
fixed. A restriction on a field nothing used to send cannot regress
anything. The server joins the parent to `project_name` itself, so the
client cannot compose a path the server did not check.

**Traversal and symlink escape are ONE check.** The parent goes through
`realpath` BEFORE any comparison, so `..` cannot survive and a symlink
bridge resolves to where it really points. Containment is component-wise,
never `str.startswith`, or `/Users/jsugamelevil` reads as living under
`/Users/jsugamele`. The allowed roots are the projects root plus HOME, and
home is deliberately generous: the owner's projects live under the iCloud
Sync path rather than under `DEFAULT_WORKING_DIR`, so a root set of only
the projects root would refuse the exact folders the folder step exists to
offer. That is a silent way of not shipping the feature.

**A name is REFUSED, never rewritten.** Spaces are legal and stay verbatim
(the owner's own projects have them). `/`, `\`, NUL, control characters, a
leading dot, `.` and `..`, and anything over 255 bytes come back as an
inline sentence. A sanitiser that turned `a/b` into `a-b` would make a
folder the user did not ask for and cannot find. An existing EMPTY target
directory is fine; a non-empty one refuses.

"clone from github" does NOT have this defect: it has collected a parent
directory since it shipped (`web/src/lib/launchpad/CloneModal.svelte`,
`modal-clone-parent`; it was `launchpad.js` until slice 6).

## A session's theme, and the two stores that hold one

There are TWO durable theme stores and they are keyed on different
things. `pinned_themes.json` (`Settings.get_pinned_themes_path`) is keyed
on the bare tmux NAME and records a theme the user pinned to ONE session.
`<working_dir>/.cc.theme` is keyed on the DIRECTORY and records the
default a PROJECT carries, which is what gives a checkout its colours
before any session exists and the only one of the two a user can commit.
Both are wanted; neither may silently override the other.

| Piece | File |
|---|---|
| The ladder, pure | `src/core/session_theme_resolution.py` |
| Both stores, and the ladder's one caller | `src/core/session_manager.py` (`resolve_project_theme`) |
| `PATCH /sessions/{name}/theme` | `src/api/routes.py` (`_apply_session_theme`) |
| Painting it, client side | `client/js/theme-navigation.js` (`applyForTarget`) |

**THE PIN WINS, AND IT SHIPPED THE OTHER WAY ROUND UNTIL 2026-09-10.**
`resolve_project_theme` read the dotfile FIRST, so the three paths that
seed `Session.pinned_theme` - create, adopt and the boot re-adopt - each
threw away a pin that was sitting on disk the whole time. A pinned theme
did not survive a server restart, and two sessions running out of one
repo folder (routine on this box) could never hold two different themes.
The rule is the one `session_agent_evidence` already states: a value
written ABOUT this session outranks a value written about the place it
happens to live. A default that beats an explicit choice is not a
default, it is an override.

**AND THE READ ORDER IS ONLY HALF OF IT. THE PATCH USED TO WRITE BOTH
STORES.** That is the mechanism by which pinning session B rethemed
session A: the dotfile is folder-wide, so a per-session control was
writing a shared value. The theme PATCH now writes the pin alone, and
`migrate_pinned_theme_to_dotfile` is GONE for the same reason - it
ferried one session's pin into the folder-wide file, and its original
job (carrying a v0.6.x pin forward) is moot once the pin store is read
first. Setting a project default is a separate, deliberate act through
`set_project_theme`, and it has no UI control yet, which is a known gap
rather than an oversight.

**A PIN NOW OUTLIVES ITS TMUX SESSION, which is a policy change that came
with the read order.** The `_lifespan_tmux_reconcile` pass used to drop
every `pinned_themes` entry absent from the live listing. That was free
while the map was a decaying fallback and is DATA LOSS now it is the
durable record: this app re-mints tmux names from project slugs, so the
name is coming back, and the entry only ever exists because a human
picked a colour. `discard_pinned_theme` on the explicit close is the one
removal path. Note the asymmetry with the OWNERSHIP prune in the same
pass, which stays: an ownership record claims a session is running, so a
measured zero contradicts it; a pin claims only what to paint if the name
returns, which a measured zero does not contradict at all.

`_save_pinned_themes` takes a `.bak` of the pre-write bytes first, like
`Settings.update_settings_config`. `_load_pinned_themes` starts from an
EMPTY map when it cannot parse the file, so without that backup one
corrupt read plus one pin would write the empty map over every pin the
user has. No migration was needed for the inversion and nobody's screen
changed colour on upgrade: an existing dotfile was written by a PATCH
that wrote both stores, so the pin map already held the same value.
