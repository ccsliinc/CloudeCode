# NEXT SESSION - the one page

Written 2026-09-11. Full detail in `HANDOFF.md` sections 8 and 9, then
`.claude/TODO.md` from its 2026-09-11 entries backwards. If this page and
HANDOFF disagree, check the date on both.

## The state, in five lines

1. **Live runs 1.2.1**, source and Electron bundle both, on mac-mini-m4
   `http://10.0.1.150:8000`, 19 tmux sessions on `-L cloude` (re-measured
   2026-09-11). Tagged `v1.2.1`, published on `ccsliinc/CloudeCode` with a DMG,
   a sha256 and a downgrade block.
2. **`release/1.2.1` is the release line** and the only thing ever deployed.
   `CLAUDE.md` and `HANDOFF.md` describe it by default.
3. **Two finished rewrites are UNMERGED and UNDEPLOYED**:
   `feat/svelte-slice-7` (client, 7 slices, `launchpad.js` deleted, i18n, plugin
   registry) and `feat/backend-decomposition` (13 slices, composition root,
   `routes.py` 4,387 to 106). File paths named in `CLAUDE.md` do not exist there.
4. **`integration/1.3.0` is being assembled** by another worker and did not
   exist as a ref on either remote at 2026-09-11 10:00. Check before assuming.
5. **Push `adamdev` first, then `origin`. NEVER `upstream`.** `adamdev` is the
   primary dev repo and the only issue tracker; `origin` is the mirror and the
   public distribution point.

## The three things to do next, in order

1. **Verify live equals what you think.**
   `./scripts/deploy-mini.sh --verify-only --target live`. Without
   `--target live` it silently checks the v11 staging target instead.
2. **Validate `integration/1.3.0` on a combined tree**, with a measured control
   per chain so any regression is attributable to one side, not to "the merge".
   Baselines: `release/1.2.1` pytest **5,708 / 2 failed / 19 skipped** and
   **200 node suites all passing** (re-measured 2026-09-11);
   `feat/backend-decomposition` @ `19ac32d` **6,520 / 2 / 54**, 6,576 collected.
   The two failures are always `test_home_write_guard` and `test_version_probe`,
   both environmental.
3. **Take the database backup, then deploy, then hand it to the owner.** His
   using it on real sessions is a release step, not optional: the fixture
   preview could not find the broken group control until he clicked it.

Then 1.3.1, the Adam integration, deliberately AFTER he has used 1.3.0: his
master is 153-plus commits past the 1.2.1 base and most of it lands in client
code we deleted, so it is a DESIGN merge, not a textual one.

## The gates. Do not skip these, no suite substitutes for them

- **DATABASE BACKUP BEFORE ANY LIVE 1.3.0 TESTING.** Owner's instruction. Use
  `VACUUM INTO`, never `cp` - the file is **5,365,055,488 bytes (5.0 GiB,
  re-measured 2026-09-11; "roughly 4.5 GB" elsewhere is stale)** and a running
  server is writing it, so a plain copy can capture a torn page. Destination
  archive-nas `10.0.1.237`, ssh user **`truenas_admin`** (a bare
  `ssh 10.0.1.237` fails), `/mnt/ARCHIVE/vault/85_cloud-exports/claude/`; the
  mini had 110 GiB free. **sha256 both ends and compare** - an unverified backup
  is a belief, and the point of the gate is that the owner can break live and
  get back.
- **THE TWO LIVE BOOT CHECKS, after deploying, both, separately.** The backend
  slices touch the boot re-adopt path and have never run against a live server.
  (a) `boot_readopt_complete`'s `held` plus `skipped` must equal
  `/opt/homebrew/bin/tmux -L cloude list-sessions | wc -l`. (b) the
  `/sessions/list` ROW COUNT, checked separately from that log line. **(b) is
  the one that matters**: the 22-rows-for-21-panes defect had a perfect boot log
  while one pane carried two backends and two tailers on one FIFO.
- **RESTART WITH `bootout` THEN `bootstrap`, NEVER `kickstart -k`** (it SIGKILLs
  Electron and orphans the python server on port 8000, which the next app
  refuses to adopt as a version mismatch). Then **POLL `/health`, do not sample
  it**: startup holds the event loop about 54 seconds after binding, so one
  early curl returns `000` and reads exactly like a dead server.
- **A source deploy cannot move the version number.** `CLOUDE_APP_VERSION` comes
  from the PACKAGED Electron bundle, so if the footer must read 1.3.0 the bundle
  gets rebuilt and reinstalled: a separate artifact, a bigger blast radius.

## The traps this session paid for. Do not re-pay them

- **A clean rebase or merge proves nothing. The dangerous staleness never
  conflicts.** Three instances in one week: four files that auto-merged and
  contradicted a settled owner decision; an auto-merged hunk repointing a reader
  from the kebab to the row, which would have made every restart report
  "unknown"; and an attribute rename whose reader was mutated back to the old
  spelling with all 200 node suites still green.
- **An `is` identity check alone is not proof of no-copy.** It stayed GREEN
  through four real mutations in the backend slices and a fifth at S7. Use three
  legs: identity, the forward data direction, and the REVERSE.
- **A green mutation is a judgement, not a verdict**: either the mutation is
  harmless or the test does not exist, and those are opposite conclusions.
  Decide which, in writing. Replacing the websocket idle-watcher lookup with
  `None` broke nothing in 5,900 tests because nothing covered it.
- **Tolerant readers spelled `getattr(x, "y", None)` hide a moved field
  silently, and a plain grep misses most of them.** Nine of ten found in backend
  S4 were invisible to the first sweep; three of four in S7. Each answers empty
  instead of raising. Grep `getattr(` and `hasattr(` too, and REMOVE the
  tolerance when you repoint.
- **`git checkout -- <path>` to revert a mutation destroys uncommitted work.**
  Paid for twice. Revert the hunk, or stash, or copy; confirm with an EMPTY
  `git diff --stat`.
- **`.gitignore` swallows `.claude/*`.** Every note needs `git add -f` and
  `git ls-files .claude` to confirm it landed. The whole 1.3 roadmap was
  untracked for weeks and nobody noticed: reading it from the main repo worked.
- **`cp -i` onto an existing target does not copy.** Re-measured: with stdin
  closed it prints `not overwritten`, exits 1 and copies nothing; with an
  inherited stdin nobody answers, it blocks. The first shape is worse, because
  it looks like a command that ran.
- **An endpoint check is not a page check.** `/api/v1/auth/status` said
  authenticated while the client rendered a login screen. Verify what the SCREEN
  shows.
- **The only browser origin the Claude-in-Chrome extension can drive is
  `127.0.0.1:5057`.** Every other origin tried (`5011`, `8010`,
  `localhost:8010`) was refused before a request left the browser: a per-origin
  extension permission, not the app. Expect `visibilityState === 'hidden'` in
  every phase too, so nothing measured through it is a claim about pixels.
- **A fresh `git worktree` has no `config.json`** (gitignored) and its absence
  manufactures 19 failures plus 26 errors that look exactly like code bugs. Copy
  it in, and recreate the `venv` symlink, before measuring anything.

## One live bug, before you touch the sidebar

A failed write is INVISIBLE to a sighted user, on live 1.2.1 today: the refusal
sentence is announced into `#session-sidebar-live`, which the stylesheet clips
to one pixel, so a screen reader hears it and nobody else does. Four of four
controls driven, four swallowed. Route the ERROR path to a toast and KEEP the
live region; replacing it regresses the accessible path to match the visual one.
