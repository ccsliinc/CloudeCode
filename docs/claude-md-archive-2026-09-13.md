# Everything else carved out of CLAUDE.md that has no better home

Carved out of CLAUDE.md on 2026-09-13, when that file was stripped back to a
routing layer. This is the detailed record behind the summary that stayed there:
the measurements, the rulings, the rejected alternatives and the incidents, kept
verbatim.

---

# Cloude Code

Drive a Mac's live Claude Code sessions from a phone. A FastAPI server owns real
tmux sessions on the Mac, streams the PTY over a WebSocket, and paints it into
xterm.js in a browser. The session runs whether anyone is watching or not, which
is the whole point and the source of most of the interesting design.

Read this before writing code here. It is orientation first, conventions second.

## THE SPELLING "Cloude" IS DELIBERATE. NEVER CORRECT IT.

This product is called **Cloude Code**, one letter off "Claude Code", and that
is on purpose. Measured 2026-09-10: **214 files** in this tree carry the
spelling (`grep -rl "Cloude" .`, excluding the repository metadata directory,
`venv` and `node_modules`). It looks exactly like a typo that propagated, which
is why this warning is the first thing in the file rather than an entry in the
gotchas list at the bottom.

A rename is NEVER in scope for a tidying, linting, typo-fixing or naming
consistency pass. It is not a small change and it is not reversible by a second
find-and-replace, because the string is load bearing in places that are not
prose:

- **The tmux socket, `tmux -L cloude`.** Every session this app owns lives on
  that socket. Rename it and the server addresses a socket with nothing on it,
  while the user's live panes carry on running somewhere it can no longer see.
- **The session name prefix, `cloude_*`** (`SESSION_PREFIX`,
  `src/core/tmux_backend.py`). Discovery, adoption, the boot re-adopt and the
  recreate gate all scope themselves by that prefix. Change it and every
  existing session becomes invisible to its own app.
- **The database filename, `cloude.db`**, and the state directory
  `~/Library/Application Support/cloude-code-menubar/`. Rename either and the
  app boots onto an empty database beside the real one, losing every project
  binding, title, pinned theme and unread flag on disk.
- **The Electron bundle id, `com.cloudecode.menubar`** (`macOS/package.json`).
  macOS keys permissions, the login item and the app's own container on that
  id. A changed bundle id is a different application to the operating system.
- **Every environment variable, `CLOUDE_*`**, and every log event name a
  running install and its already-installed hook block emit today.

So the blast radius of "fixing the typo" is: the sessions the user is currently
working in, their entire database, and the app's identity to macOS. If you were
told to fix typos, this is not one of them. If a document, a comment, a path or
a variable reads `Cloude`, leave it.

The same prohibition is carried by `.github/ISSUE_TEMPLATE/task.yml` and by
`.claude/skills/work/SKILL.md`. Both of those are opt-in and reach only an
agent that happens to read them. This file is the one every agent loads, which
is why a third copy is correct rather than duplication.

## Every document in `docs/`, and when to read it

CLAUDE.md is the only entry point guaranteed to be loaded, so a document it
does not name is effectively invisible: a clean-context agent will re-derive
what the file already says, or contradict it. Gotcha 8 below is the argument -
a doc nobody can find is a missing doc that still costs maintenance.

This table is the routing layer. Read the one that answers your question; do
not read all 27.

| Document | Read it when |
|---|---|
| `docs/DECISIONS.md` | **Before you re-litigate any design choice.** Standing rulings from Adam, who owns the code and is the sole tie-breaker. A ruling binds both parties and both sides' agents. This is the file that says double-click rename stays. |
| `docs/LESSONS.md` | Before you debug something that feels familiar. Defect shapes that have bitten this project more than once, with the evidence. Add one when a pattern REPEATS; once is an incident, twice is a pattern. |
| `docs/session-status.md` | Anything about the status lights. The single source of truth for the state model, the two rings, the five colours and where each fact is stored. |
| `docs/session-status-model.md` | You need the transition-by-transition derivation. Four independent state machines, every state citing the symbol it was read out of, drift-tested by `tests/test_status_model_chart_drift.py`. |
| `docs/notifications.md` | Anything about toasts. Raising is global, dismissing is per session, and those are independent axes. Also the external push channels: the queue stays sequential, the three channels inside one entry go out at once under a per-channel bound. |
| `docs/alert-state-model.md` | You are designing alerting. DESIGN ONLY, nothing in it is built, and it deliberately disagrees with `docs/session-status-model.md` in two places. Read that one first. |
| `docs/session-project-operations.md` | You need to know what an operation does to a session row, a project row and the tmux session underneath. Every node cites the symbol it came from. |
| `docs/project-reconcile.md` | The project list looks wrong after an upgrade. Written after a round trip actually lost rows. |
| `docs/session-attribution-import.md` | Sessions are reported as external that the launcher itself created. DESIGN ONLY, not implemented. |
| `docs/reconnect.md` | The terminal repaints wrong after sleep, wake or a dropped socket. Names the two re-attach paths, which behave differently. |
| `docs/ci.md` | You need to know what CI runs and what it does when a secret it needs is missing. Read it with the CI status paragraph under "How we work here", which says whether it is switched on at all. |
| `docs/debugging.md` | You need logs. The `CLOUDE_DEBUG=1` switch, from source and inside the packaged app. |
| `docs/secret-scanning.md` | You are touching the pre-commit hook, `.gitleaks.toml`, or `scripts/scan_secrets.py`. Carries the incident that caused all three. |
| `docs/test-artifact-cleanup.md` | You are removing a test session or project. It leaves traces in SEVEN places, and killing the tmux session clears exactly one of them. |
| `docs/upgrade-with-claude.md` | You are upgrading an install. The runbook `/upgrade` follows. Take the baseline FIRST. |
| `docs/upgrade-downgrade-roundtrip.md` | You are asking whether the previous version can be dropped back in. Answered by executing the round trip, not by reading the migration's own promises. |
| `docs/deploy-mini.md` | You are pushing this code to the `mac-mini-m4` dev box. A developer tool, NOT the end-user upgrade path. |
| `docs/deployment-docker.md` | You are running the server as a pure container. Operator facing. |
| `docs/ios-simulator-testing.md` | You changed anything that renders on a phone. Names the three things desktop responsive emulation cannot show you. |
| `docs/ios-standalone.md` | You are working on add-to-home-screen. What works over plain http, and what needs TLS. |
| `docs/perf-baseline-2026-09-10.md` | You need a number to judge a performance change against. Read its machine-load note before quoting any absolute figure. |
| `docs/webui-performance-and-session-menu-plan.md` | You picked up an issue carrying a `phase:N` label. This is the plan those issues were cut from, with the audit that justified it. |
| `docs/message-browser-api.md` | You are building the archive browser's server. DESIGN SPEC, not implemented. |
| `docs/message-browser-ui.md` | You are building the archive browser's client. DESIGN SPEC, not implemented. |
| `docs/message-model-gate.md` | You are touching the message model's ingest gate or `src/core/message_gate_contract.py`. |
| `docs/jsonl-shape-inventory.md` | You are writing a test against the transcript archive and need a real exemplar of a given line shape. |
| `docs/help-content-audit.md` | You are rewriting the launchpad help copy. |
| `docs/ui-preferences-inventory.md` | You are building the typed `ui_preferences` sync (or its partial-update or import step). Every durable browser-stored preference, classified as shared / per-viewer-only / already server-owned / secret, with the exact key, composition, writer and reader. |
| `docs/ui-inventory.md` | A designer or a newcomer needs the complete inventory of every screen, region and control in the app: what each one is for from the user's point of view, what states it can be in, and whether it appears on desktop, on a phone, or on both. Written for someone who does not read code. It is DESCRIPTIVE, not normative: it records what shipped, it does not rule on what should. Where it and the code disagree, the code wins and this file is the thing to fix. |
| `docs/ROADMAP.md` | You are picking the next feature to build, or asking whether an idea has already been thought about. The full 2026-09-13 brainstorm: 91 unconstrained ideas, the top 50 with a "probably possible" twin each, Adam's 17 fleshed out, the locked decisions (brand, catalog hosting, signing, cheap-model seam, TUI stack, mobile, remote hosts) and the three-tier roadmap. It is a PLAN, not a record of what shipped. |

Two rules keep this table honest. **Unreferenced is not unused**, so do not
delete or move a file in `docs/` because it looks orphaned. And **a new file in
`docs/` gets a row here in the same change**, or it is invisible on the day it
is written, which is the failure this table exists to end.
`tests/test_docs_index.py` fails the build if a `docs/*.md` file is not named
in this file, on the same principle as `tests/test_no_remote_assets.py`.

## Stack

| Layer | What | Where |
|---|---|---|
| Backend | Python 3.12, FastAPI, uvicorn, pydantic models | `src/` |
| Logging | structlog, event-name first arg, kwargs for context | everywhere |
| Terminal | tmux (live backend) driving a PTY, xterm.js client-side | `src/core/tmux_backend.py`, `client/js/terminal.js` |
| Frontend | vanilla JS, no framework, NO build step for `client/` | `client/` |
| Desktop shell | Electron wrapper (has its own `package.json`) | `macOS/` |
| Compiled frontend | Svelte 5 (runes) + TypeScript + Tailwind, built by vite | `web/`, output in `client/dist/` |
| State | JSON on disk (`config.json`), plus one SQLite file for refresh tokens | `src/config/`, `src/core/refresh_store.py` |

`client/` is served straight off disk under `/static`. There is no bundler, no
transpile, no `client/package.json`. A file you add there is live on reload, so
it must be valid in the browser as written. Run `node --check` on every JS file
you touch. That is still true of `client/js`; the one compiled tree is `web/`,
described next.

**Claude Code lifecycle hooks feed the status machine.** `src/core/claude_hooks.py`
merges a managed hook block into `~/.claude/settings.json` (marked
`# cloudecode-managed`, idempotent, atomic write, bails rather than clobbering an
unparseable file). Hooks POST to a loopback-only endpoint authenticated by an
env-injected shared token. Events: `Stop`, `Notification`, `PermissionRequest`
(these three also raise a toast), plus `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `SubagentStart`, `SubagentStop` (activity state only).
**AND THREE OF THEM ANSWER TOASTS AS WELL AS RAISING THEM**: a prompt
submitted from ANY client fires `UserPromptSubmit` wherever it was typed, so
`src/core/toast_auto_ack.py` acks that session's open toasts as `answered`
(`PreToolUse` acks only a permission; `Stop` acks a permission or a notice and
NEVER the "your turn" it just raised, by KIND so the rule survives a duplicate
or a reorder, and never a toast raised after the event's own instant). Clients
drop the card on the `toast.ack` frame or, on a socket-less screen, when the
poll reconciles the open set - see `docs/notifications.md`.

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

**A THEME CAN SHIP A SCRIPT, AND THE CSP IS NOT WHAT GATES IT.** A theme's
optional `effects.js` is served same-origin, from `/static/css/themes/<id>/`
for a bundled theme and from the `/themes/<id>/` mount for a user-authored
one, and is loaded by dynamic `import()`. `script-src 'self'` therefore
PERMITS it, correctly and unchanged - the policy's job is to stop code
arriving from somewhere else, not to decide which of our own origin's files
the user wants running. The gate is the app's own, it lives in
`client/js/theme-consent.js` (the ladder and the record) and
`src/core/theme_script_consent.py` (the same ladder, server side), and
`client/js/themes/registry.js` keeps only the modal and the execution.
**Nothing in #45 changed the CSP, and nothing in it may.**

**SIX OUTCOMES, ONE OF WHICH RUNS, AND THE ORDER IS THE CLAIM.** No script
declared; a recorded `never`; a record that could not be READ; a bundled
theme; a script whose bytes could not be digested; a grant naming DIFFERENT
bytes; a grant naming THESE bytes; nothing on record. Only the last-but-two
executes. **DENY WINS OVER EVERYTHING**, including the bundled bypass and
including a newer grant, whichever was written last - that is the property
that makes sharing a restriction safe. An UNREADABLE record refuses a cached
grant rather than honouring it, because a client that cannot read the record
cannot show that no newer `never` exists, which is exactly the "a cached
approval cannot outrank a newer global Never" this was asked for. The cost of
that refusal is an animation that does not play.

**CONSENT IS SHARED, AND WHAT MAKES A SHARED GRANT SAFE IS A DIGEST.** The
record moved out of this browser's `cloude.themeJsAllowlist` and into the
server-owned `ui_preferences.theme_script_consent`, so a `never` set anywhere
binds everywhere. `docs/ui-preferences-inventory.md` had recommended against
sharing it, and it was right about the shape it was describing: a grant keyed
on a theme ID alone is a standing yes for whatever that file later becomes,
and a theme directory is a folder anything with write access can edit. So an
`always` stores the sha256 of the exact `effects.js` it was granted for. The
server stamps that onto the manifest as `effectsDigest` from the bytes it is
about to serve, a manifest cannot declare its own, and editing the file makes
the grant stop matching so the user is asked again about the script that now
exists. **THE USER APPROVES AN ARTIFACT, NOT A NAME.**
`ui_preferences.validate_changes` REFUSES an `always` carrying no digest and
refuses the word `once` outright, so an unbounded grant and a persisted
temporary allowance are both unexpressible rather than merely unwritten.

**`ALLOW ONCE` IS NEVER STORED AND NEVER SENT**, and the legacy local key is
read for its REFUSALS ONLY. A `false` in `cloude.themeJsAllowlist` still
refuses, for free, because honouring an existing restriction can only reduce
what runs. Every `true` in it is IGNORED: it names no digest, so there is
nothing to bind a grant to, and those users are asked exactly once more. That
same reasoning is why the #46 settings import refuses that key by name.

**THE GATE IS A SEPARATE FILE SO ITS REFUSALS CAN BE MEASURED.**
`ThemeConsent.gateEffects` takes the injector as a CALLBACK and calls it on
exactly one path, so `tests/test_theme_script_consent.node.mjs` hands it a spy
and proves an unconsented theme never executes - against the real callback
registry.js passes in, not against an internal flag that correlates with it
today. Sixteen of its twenty-five cases are refusals. **A suite that only drove
the consented path would pass against a gate that never refuses**, which is
this project's own "a matcher that always finds something is worse than
useless" one layer up. A revocation arriving from another device runs the
module's `destroy()`, drops the loader cache, cancels an on-screen prompt and
is re-checked mid-`import()` before `init()` runs - and it SAYS that anything
the script already did to the page stands until a reload, because claiming
otherwise would be the false green this project keeps paying to remove.

**AND ONE OF THOSE REFUSALS WAS DECORATIVE, WHICH ONLY A MUTATION TEST
COULD SHOW.** Driven against a `decide()` mutated to always RUN, thirteen
of the twenty-one cases failed and `allow once is never written anywhere`
was the ONLY negative control still passing - because under an
always-allow gate the script runs and nothing is persisted either, so
every assertion it made was satisfied for the wrong reason. The fact it
never checked is the one that separates the two worlds: whether the user
was ASKED. Its `prompt` is a recording spy now, asserted to have been
called exactly once and about THIS manifest, and the same mutation now
fails it on `the script ran without the user ever being asked`. **A GREEN
NEGATIVE CONTROL PROVES NOTHING UNTIL YOU HAVE WATCHED IT GO RED**; if
you add one here, mutate `decide()` to always return `run` and watch.

**A "NEVER" THAT COULD NOT BE WRITTEN DOWN IS `skip_denied_unsaved`, NOT
`skip_denied`.** `gateEffects` ignored `remember()`'s return value for a
refusal, so it reported every one as recorded. Reproduced end to end
2026-09-10: `GET /themes` serves a folder called `Neon Rain` intact,
digest and all, and `validate_consent_map` then 422s the refusal, so the
user clicked "never", watched it take effect, and it was gone on reload
and never reached another device. It FAILED CLOSED every time, so it was
never an execution hole - it was a durability lie, which on a consent
control is its own defect, because it teaches the user the control does
not work. The gate now checks the status (`committed` or `unchanged` are
the only two that mean the record took it) and reports through an
optional `notify` callback that registry.js routes to `FabMenu.notify`.
**THE COPY LIVES WITH THE DECISION** (`UNSAVED_REFUSAL_COPY`) and the
caller supplies only the channel, so the sentence and the fact cannot
drift. A missing `notify` still logs; a message nobody could deliver is
not a reason to go back to saying nothing. `stale_revision` on a refusal
is reported the same way and deliberately NOT retried - it fails closed,
the user is told, and the next attempt succeeds.

**A THEME ID IS ONE RULE WITH FIVE CONSUMERS, AND `ThemeManifest.id` HAS
NO PATTERN AT ALL.** The only rule on the manifest is that the id equals
the directory name, so the keyspace is whatever the filesystem allows,
while `THEME_ID_RE` decided what a consent key and the selected-theme
preference could be. Those disagreed. The id has to survive as: a
directory name, a filesystem path segment, a URL path segment (safe
already - `effectsUrlFor` passes it through `encodeURIComponent`), a JSON
object key in the shared `theme_script_consent` map, and the `theme`
preference. `THEME_ID_RE` now covers the names people really have -
letters, digits, `.`, `_`, `-` AND THE SPACE, up to 128 characters, first
character not `.`, `-` or a space and last not a space - and
`src/core/theme_script_consent.py` names a reason beside every exclusion
rather than listing them.

**IT WAS DECLARED IN TWO FILES, AND `ui_preferences` NOW IMPORTS IT.**
Its own copy answered the same question about the same string, so a
folder name one accepted and the other refused was a theme you could
select and could not record a decision about.
`tests/test_theme_id_charset.py` asserts the two are the SAME OBJECT, not
two equal patterns, so a future widening cannot reach one and miss the
other.

**THE BROWSER KEEPS NO COPY OF IT, UNLIKE `DIGEST_RE`, AND THAT IS A
CHOICE.** A client-side mirror would only be good for pre-empting a
write, which means a mirror that drifted would refuse a write the server
would have taken - and the drift test guarding it would be guarding a
problem it created. The gate handles it REACTIVELY through `persisted()`
instead, which is correct whatever the write failed for: a rejected key,
a network outage, a stale revision. `DIGEST_RE` is mirrored because the
ladder BRANCHES on it; this would have branched on nothing.

**`\Z`, NOT `$`, AND THAT IS NOT COSMETIC.** Python's `$` also matches
immediately before a trailing newline, so the pattern this replaced
accepted `"matrix\n"` - a legal POSIX filename, and a second spelling of
one theme. JS `$` without the `m` flag does not, which is why the mirror
is the python pattern with `\Z` swapped back.

**NON-ASCII IS STILL REFUSED, DELIBERATELY, AND IT IS THE ONE REFUSAL
THAT COSTS A REAL USER SOMETHING.** The consent map in `config.json` IS
the audit record of what the user let execute, and a key carrying a bidi
override, a zero-width joiner or a homograph is one an operator cannot
read back and check. Supporting it properly needs a normalisation and
confusables policy, which is a bigger change and a worse one to make
hastily on a consent surface. A theme named `über` still renders, still
prompts and still fails CLOSED - what it cannot do is REMEMBER the
answer, and the user is now told that instead of being shown a refusal
that evaporates. Note what was NOT done: dropping such a theme from
`GET /themes` entirely was considered and rejected as over-broad, because
a theme that declares no script has no consent problem at all and would
have vanished for nothing.

**KNOWN DESIGN LIMIT: THE DIGEST IS TAKEN ONCE PER PAGE LOAD, THE
`import()` HAPPENS WHENEVER THE THEME IS APPLIED.** `loadManifests()` has exactly
one caller (`client/js/themes/registry.js:1179`), so the
`effectsDigest` a grant is matched against is the bytes as they were at
load. Edit `effects.js` after that and, WITHIN THAT ONE OPEN PAGE, the
grant still matches and the edited file runs. **This is recorded rather
than fixed, on purpose.** Exploiting it requires a process already
writing the themes directory while the page is open, which is an actor
who already has code execution as the user - so it does not lower the bar
for the threat this gate exists to raise, which is a theme the user
installed turning out to do something they did not agree to. A reload
re-measures. Do not restructure the load path to chase it; that is a
bigger change than it is worth, and re-digesting per apply would put a
filesystem read on every theme switch.

**Config writes are atomic and backed up, and they go through ONE
boundary.** The sequence is unchanged and is not open to tidying: the `.bak` of
the pre-write bytes FIRST, then a temp file, `fsync`, `os.replace`. A
half-written `config.json` costs the user their whole setup, so there is no
"just dump the JSON" shortcut anywhere in this codebase. What changed is WHERE
it lives: `src/core/config_writer.py` is the only module that may perform it,
and `tests/test_one_config_writer.py` fails the build if a second one appears.

**ATOMIC AND SERIALIZED ARE DIFFERENT PROPERTIES, AND THIS ONLY HAD THE
FIRST.** Five functions wrote `config.json` - `Settings.update_settings_config`,
`Settings._write_wrappers`, `slash_favorites.write`,
`terminal_commands.replace_terminal_commands` and
`config_migration.migrate_config_file`. Every one was atomic, so a crash could
never truncate the file, and every one read the document, merged its own block,
and replaced. Two arriving together each merged into the SAME base and the
second replace threw the first writer's block away: the file was never corrupt
and the update was still lost. They also all used the same temp filename,
`config.json.tmp`, which a lock hides and a second process does not.

**THE FRESH READ INSIDE THE LOCK IS THE FIX, and it is enforced by the shape of
the API rather than by remembering.** `config_writer.commit(path, mutate)` takes
a MUTATOR, not a document: it acquires the path's lock, reads the file itself,
and hands that dict over. A caller cannot supply a stale base because it never
supplies a base. The temp file carries the pid plus a random suffix, a nested
`commit` raises rather than deadlocking, and `on_commit` listeners see the
committed document while the lock is still held. Four named outcomes, no silent
ones: `committed` / `unchanged` / `stale_revision` / `backup_unavailable`.
`unchanged` (the mutator returned `None`) touches NEITHER the config nor the
backup, which is the no-op behaviour the migration has always had, and
`backup_required=True` is what preserves that writer's FAIL-SAFE posture -
alone among the five, it refuses to run at all rather than write without a
rollback path.

## The `/sessions/list` shape

`GET /sessions/list` returns `SessionInfo` objects
(`src/models/sessions.py`), and the
fields sit on **two different levels**:

- On the wrapper: `activity_status`, `unread`, `startup_gate`, `tmux_session`,
  `agent_type`, `agent_family`, `agent_family_source`, `agent_wrapper_label`,
  `pinned_theme`, `session_backend`, `recent_logs`, `local_servers`, `stats`
- On the nested `.session`: `id`, `pty_pid`, `working_dir`, and the rest of the
  `Session` model

Reading `info.id` or `info.session.unread` gives you `undefined` silently, and it
looks exactly like "the backend didn't send it". This is the single most
repeated bug in the project. Check the level before you debug the endpoint.

**Three fields describe the agent, and they answer three different questions.**
`agent_type` is the raw stored value: a wrapper id (`claude-chrome`) or a bare
family name (`shell`). `agent_family` plus `agent_family_source` are the
DISPLAY-time resolution of it (`src/core/agent_family_display.py`), and the
source is what keeps a fingerprinted guess from rendering like a launch fact.
`agent_wrapper_label` is the wrapper's configured label
(`src/core/agent_wrapper_display.py`), `null` whenever no configured wrapper can
be named - a fingerprinted value, a bare family name, or an id config no longer
carries. `AttachableSession` carries the same three, resolved by the same
functions, so a launchpad row merged from either endpoint agrees about itself.

**A GUESS MUST NEVER OUTRANK A RECORD, and the ordering lives in one place.** A
live session has two sources for `agent_type`: the in-memory `Session` and
`sessions.agent_type` on its row. `_session_info_for` used to read the row only
when the in-memory value was EMPTY, and that is wrong for an ADOPTED session -
every live session is re-adopted after a server restart, the adopt path
fingerprints the pane and stores the bare family token, so a session launched as
`claude-chrome` came back holding `claude` and painted `~claude` (the dashed
"guessed" pill) beside a row that recorded the exact wrapper. Measured on the
owner's box 2026-09-08: row 43, `agent_type='claude-chrome'`,
`agent_family_source='launched'`. `session_agent_evidence.choose_agent_evidence`
is now the only thing that picks between the two, as a four-rung ladder:
in-memory launch, then the row, then the in-memory fingerprint, then nothing.
The row beats the fingerprint because nothing writes an inference into
`sessions.agent_type` - `persist_fingerprint_family` writes `agent_family` and
deliberately leaves that column alone.
