# ccsliinc: behaviours we rely on

Ported 2026-09-10 from `wants/ccsliinc.md` on the `coord` branch, which the
work protocol supersedes. The rule and the reasoning live in
`docs/KEPT-BEHAVIOURS.md`, and the owner's ruling behind it is in
`docs/DECISIONS.md`. The `disliked` section from the original is kept below and
is still stated as preference, not instruction.

Every entry carries `paths`, `anchors` and `tests`, and
`scripts/check_kept_behaviours.py` fails a build when a declared anchor leaves
the tree. `tests: none` is the honest record of a behaviour nothing holds and is
never a failure; there is one, and it is the one that nearly died.

## kept

Behaviours we rely on and would notice losing. Adding something beside one of
these is always fine. Removing one is not ours or yours to do alone.

### restart on a live row
paths: client/js/session-sidebar-rows.js client/js/session-sidebar-clicks.js client/js/session-row-menu.js client/js/session-row-menu-items.js
anchors: restartable | data-row-menu-status
tests: tests/test_session_row_menu_superset.node.mjs tests/test_session_row_menu_dispatch.node.mjs
Restarting a session from its row, with the picker seeing the row's MEASURED
status rather than null. The menu TRIGGER is where that status comes from: our
own kebab spelled it `data-row-status` and the 2026-09-10 reconcile moved us
onto adam's trigger, which spells it `data-row-menu-status`. When the kebab went
and the read moved to the row without anything stamping it there, every restart
reported "unknown" instead of the measured state, and git merged both halves
with no marker. Keep a route to restart, and keep whatever stamps the status it
reads. The anchor is the CURRENT spelling on purpose: an anchor on the retired
one would keep matching the comment that explains the move.

### the manual mark-unread control
paths: client/js/session-row-menu.js client/js/session-row-menu-items.js client/js/session-sidebar-clicks.js client/js/launchpad.js src/config.py src/main.py web/src/lib/plugins/mark-unread/index.ts
anchors: mark-unread | show_mark_unread_control
tests: tests/test_session_row_menu_superset.node.mjs tests/test_unread_led_one_field.node.mjs
The owner's rule, verbatim: "when clicking a tab, the session is marked read. if
i want it unread i click unread." The LED painting unread is an INDICATOR and
does not replace the CONTROL. It already ships behind
`ui.show_mark_unread_control`, default on, so turning it off is a setting rather
than a deletion.

### group filing from the row itself
paths: client/js/session-sidebar-group-actions.js client/js/session-row-menu.js client/js/session-row-menu-items.js
anchors: move-to-group
tests: tests/test_session_row_menu_superset.node.mjs tests/test_sidebar_group_menu_stacking.node.mjs
`rowMenuItemHtml` is the last POINTER route to the group picker. With it gone,
`g` on a focused row and Alt+Arrow both need a keyboard and dragging onto a
header is the only touch route left, which breaks that file's own stated rule
that drag is never the only way to do anything. Phones have no keyboard.

### double-click rename, as well as menu rename
paths: client/js/session-sidebar-rename.js client/js/session-sidebar-clicks.js client/js/session-sidebar.js
anchors: onDblClick | addEventListener('dblclick'
tests: none
The owner uses it. A menu rename is a fine ADDITION and a poor replacement. This
one nearly went on our own side, not theirs: the merge was about to drop it
purely because an incoming commit intended to.

NOTHING TESTS THE GESTURE, stated rather than papered over. The rename tests
call `SessionSidebarRename.beginEdit` directly, which proves the editor works
and proves nothing about whether a double-click still reaches it, which is
exactly the half that was removed. Writing a test for it is open work. Until
then the two anchors are the whole guard: `onDblClick` (the exported handler)
and `addEventListener('dblclick'` (the registration in `session-sidebar.js`).
Both were measured absent from `8898f07`, the commit that deleted the gesture,
while the words "double-click" and "dblclick" both survived in its prose.

### dead rows go to Recent
paths: src/core/session_lifecycle.py src/core/session_manager.py
anchors: session_lifecycle_reaped | _reap_absent_instances
tests: tests/test_ended_session_listing_rule.py tests/test_session_lifecycle_reconcile.py
Owner's call, verbatim 2026-09-08: "they go into recent, they can disappear." A
session whose process died leaves the live list rather than lingering there
wearing a dead light, and a restart from Recent is a resume. A round that made a
husk keep its row painted dead was overruled and reverted (`ba2aa5d`).

### the concentric single-element LED
paths: client/js/status-led.js client/css/status-led.css web/src/lib/StatusLed.svelte web/src/lib/led.ts
anchors: box-shadow
tests: tests/test_status_led.node.mjs
Both rings are ONE element: the inner is the span's background-color and the
outer is a three-layer box-shadow on that same span. There may not be a
pseudo-element. The halo used to be an `::after` and the browser pixel-snaps
that box independently, so the two circles came apart by a device pixel whenever
the dot landed on a fractional x/y. A box-shadow paints from the element's own
border box, so concentric is the only geometry it can have.

### the outer ring carries unread, as a still green ring
paths: client/js/status-led.js client/js/session-status-ui.js client/css/status-led.css web/src/lib/led.ts
anchors: OUTER_STATES | --led-color-unread
tests: tests/test_status_led.node.mjs tests/test_status_key.node.mjs
Ruled 2026-09-09, and the owner picked adoom666's model over ours ("1. his").
`unread` IS an outer state (`OUTER_STATES` at `status-led.js:123`): a finished
turn nobody has read paints a crisp STILL green ring, a read session at rest
takes `steady`, and `active` is the only outer state that animates. The inner
dot carries the session's state, `done` while the green ring is up and `idle`
once it goes. `--led-color-unread` exists and was not retired.

CORRECTED 2026-09-10. The version of this entry ported from `wants/ccsliinc.md`
said the opposite, because `wants/` was written before the ruling and never
updated after it. What we rely on is the RULED model, not the one we proposed.
Do not reintroduce inner-dot unread; it was decided against, not forgotten.

### the strict CSP, with no third-party origin in any directive
paths: src/main.py src/security_headers.py client/index.html tests/test_no_remote_assets.py
anchors: frame-ancestors | default-src
tests: tests/test_no_remote_assets.py
`default-src 'self'`, `frame-ancestors 'none'`, nothing off-origin. This was a
correctness fix and not only hardening: a content blocker dropped enough of the
CDN xterm.css that the character cell was measured wrong, FitAddon derived a
bogus cols/rows and the real tmux pane was reflowed to a grid matching nothing
on screen, on a phone, while desktop looked perfect. New libraries get vendored.
`style-src 'unsafe-inline'` stays and is not licence to widen anything else.

### continuous transcript archiving
paths: src/core/corpus_ingest_task.py src/core/corpus_ingest_service.py src/core/corpus_ingest_scan.py src/core/corpus_ingest_state.py src/core/corpus_status.py src/api/corpus_routes.py src/main.py
anchors: CorpusIngestScheduler | corpus_ingest_scheduler.start() | CLOUDE_CORPUS_INGEST | FRESHNESS_NEVER_RAN
tests: tests/test_corpus_ingest_service.py tests/test_corpus_api.py tests/test_transcript_corpus_ingest.py
A background loop that keeps a byte-exact copy of this machine's Claude Code
transcript corpus (`~/.claude/projects`) inside the app's own database, started
from `lifespan()` and stopped on shutdown, running whether or not anyone is
looking at it. The owner develops inside these sessions every day and the
archive is what makes that history survive.

NOTHING HAS REMOVED THIS AND THIS ENTRY IS NOT A COMPLAINT. Measured
2026-09-16: all four `corpus_ingest_*.py` modules, `corpus_status.py`,
`corpus_routes.py` and the three named tests are present and identical on
`adamdev/master`, and `CorpusIngestScheduler` still starts from `lifespan()`
there. The archiver has never depended on the hook subsystem, so `a1373d5`
("delete the hook subsystem, and start the watcher") did not touch it: hooks
feed the status machine, which is a different system with a different job. This
is a forward-looking guardrail written while the behaviour is healthy, which is
the only time a guardrail is cheap to write, and it is filed here so a future
refactor on either side has something to trip over instead of a silence.

WHY IT IS NOT NEGOTIABLE: FOR PART OF THE CORPUS THE ARCHIVE IS THE ONLY COPY
LEFT. Measured 2026-09-16 over the whole population, no sampling: of 23,715
archived rows, 2,524 name a `.jsonl` that no longer exists anywhere under
`~/.claude/projects`. Those conversations are not recoverable from disk, from a
re-scan or from Claude Code itself; they exist because a pass captured them
before the file went. Every one of those 2,524 reconstructs byte-exactly, and
0 of all 23,715 rows mismatch. Stopping the loop does not lose what is already
stored, and it silently stops new work from ever entering that set, which is
the same outcome one corpus generation later. See
`docs/transcript-archive-integrity.md` and
`scripts/transcript-archive/verify_archive_integrity.py`.

WHAT IT RESTS ON, so a change to any of these is a change to this behaviour:
the four `corpus_ingest_*` modules (`_service` is one pass, `_scan` the plan and
its two fingerprints, `_state` the on-disk cache and liveness artifact, `_task`
the loop); the scheduler being CONSTRUCTED AND STARTED in `lifespan()`, because
an importable scheduler nobody starts is a loop that never runs; the
`CLOUDE_CORPUS_INGEST` switch, which must keep defaulting ON outside
`CLOUDE_TEST_MODE`; and the liveness artifact with its four freshness states,
`current` / `stale` / `never_ran` / `cannot_determine`, published on EVERY
terminating path including failures.

THE FOUR STATES ARE THE POINT, NOT DECORATION. A dead ingester looks exactly
like a healthy one finding nothing new: both write no rows. Age is the only
signal that separates them, which is why the artifact is refreshed even by a
run that failed, and why "no artifact" resolves to `never_ran` rather than to a
zero that reads as healthy. Collapsing those four values to a boolean, or
letting an unreadable artifact answer `current`, removes the only way anyone
finds out.

WHAT WOULD BREAK IT QUIETLY, none of which raises anything: flipping the
`CLOUDE_CORPUS_INGEST` default to off, or widening the `CLOUDE_TEST_MODE`
default-off to a path that is not a test run; keeping the modules and dropping
the `lifespan()` wiring in a `src/main.py` merge, which is a deletion of two
lines in a file both lines edit constantly; moving the state directory without
moving the artifact, so freshness reads `never_ran` forever while the loop is
fine; pointing the ingester at a database the archive no longer lives in, which
the archive db split makes a live possibility now that `transcript_archives`
sits in `cloude-archive.db` rather than inside `cloude.db`; and turning the loop
off to fix a slow boot, which works, because it is scheduled rather than awaited
and was never what made boot slow.

HOW TO SEE IT IS ALIVE, IN ONE COMMAND. It answers with the app's own resolver
rather than a second copy of the rule, so the check and the code cannot
disagree:

    ./venv/bin/python3 -c "import os; from pathlib import Path; \
    from src.core.corpus_ingest_state import read_liveness, classify_freshness; \
    d = Path(os.environ.get('CLOUDE_STATE_DIR') or \
        (Path.home() / 'Library/Application Support/CloudeCode')); \
    r = read_liveness(d); v, age, why = classify_freshness(r); \
    print(v, 'age', age, (r or {}).get('status'), (r or {}).get('finished_at'))"

Healthy on the owner's box 2026-09-16 reads `current age 438.9 ok
2026-09-16T16:00:10Z`. THE NEGATIVE CONTROL IS PART OF THE CHECK: pointed at a
state directory with no artifact the same command must print `never_ran`, and a
build of this check that cannot produce `never_ran` is not measuring anything.
Only `current` is a pass; `stale`, `never_ran` and `cannot_determine` are three
different problems and must not be read as one. `GET /corpus/status` reports the
same verdict over HTTP when a server is up.

## disliked

Our preferences, stated as preferences. None of these is an instruction to
anyone else, and none of them justifies deleting your work. They are here so you
know what we will grumble about and can decide whether you care.

### files over 500 lines
We would rather see a new focused module than another hundred lines on
`launchpad.js`, `terminal.js`, `app.js`, `routes.py` or `session_manager.py`.
Those five are already past the guideline.

### per-row queries and per-row subprocesses on the listing path
One bulk read per pass, indexed, and the decorators read the index. Measured at
27 subprocesses and about a second a poll for 13 sessions before that changed.
This is a preference about shape; your measurements may beat ours.

### a behaviour removed without a replacement
The one we feel most strongly about, and the reason the rule above exists. If
something is genuinely redundant, we would rather see it default-off behind a
setting for a release than deleted, so the person who relied on it finds a
switch instead of a regression.
