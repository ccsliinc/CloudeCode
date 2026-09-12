# Fork divergence audit: adamdev and upstream vs v1.1 (2026-09-09)

Read-only, no fetch/push/checkout/reset/merge. All numbers from live `git` commands against the already-fetched remotes.

## 1. Merge-bases, commit counts, authors, date ranges

**adamdev/master and upstream/main share one merge-base with v1.1: `ba2aa5d`,
2026-09-08 17:44:47.**
- adamdev/master since base: `git rev-list` reports 141 commits, only 23
  genuine new work (section 4). Shortlog for all 141: psyance 134, Adoom666
  6, claude[bot] 1. The real 23: psyance 23, all of them, dated 2026-09-08
  18:20 to 2026-09-09 17:33.
- upstream/main since base: 5 commits, all ccsliinc (our own origin identity,
  merged into Adam's upstream via PRs #6-#10), 2026-08-28 to 2026-09-08. Net
  file diff is zero, section 4.
- v1.1 since base: 34 commits, all ours, 2026-09-08 17:49 to 2026-09-09 16:03.

**adamdev/weekend-mvp-v3.1 has NO merge-base with v1.1** (`git merge-base`
exits 1, empty result). Root commits differ entirely: v1.1 roots at `216a228`,
weekend-mvp-v3.1 at `1eb33d1`. 237 commits total (psyance 230, Adoom666 6,
claude[bot] 1), full history 2025-10-27 to 2026-08-25. See section 4.

## 2. What each side changed

**adamdev/master's real 23-commit diff against base: 120 files, 11,915
insertions, 4,480 deletions** (`git diff --stat`, tail line). Directories:
tests (53 files), client (46), src (6), scripts (5), one file each in macOS,
docs, and root (README, CLAUDE.md, TODO.md, config.example.json, pytest.ini,
.gitignore, .github). Themes from the subjects: a full redesign of the
session status LED (one lit diameter per light, a five-color scheme, a
legend, dropped the old unread envelope), a rebuilt toast system (one card
per session, attachment-receipt thumbnails), a phone-only terminal-tools FAB
and session editor moved into the header, an app-version footer on the
sidebar, a tmux attach/pipe-pane fix so live output reliably streams on every
attach path (including a revert-then-reapply of one such fix), and CI/test
hygiene. No new dependency, build system, or frontend framework: same two
`package.json` files we already have, zero hits for svelte, vite, tailwind,
or react.

**upstream/main's 5 commits net to a zero-byte diff.** `git diff --stat
ba2aa5d..upstream/main` is empty; upstream/main's tip tree hash equals the
base's exactly (`129235c5...`). All 5 are "Merge pull request #N from
ccsliinc/main" commits resolving to content already there; upstream/main is
content-identical to our shared base.

**weekend-mvp-v3.1 is the SAME pre-tmux legacy lineage master absorbed,
carried 119 commits further.** Its merge-base with the legacy branch grafted
into adamdev/master (section 4) is that branch's own tip, `4262043`, dated
2026-04-19. From there to its tip: 169 files, 42,387 insertions, 3,761
deletions, spanning 2026-04-19 to 2026-08-25. Directories: client (58), docs
(33), src (30), tests (23), macOS (5), scattered root files. Themes:
local-model support via LM Studio (a "cldl" provider), a Codex/OpenRouter
provider-selector modal, mobile terminal clipboard-paste fixes, launchpad UX
(type-ahead, editable path bar, auto-mkdir folder picker), releases v0.7.4
through v0.9.0. No framework signal either, only `macOS/package.json`. Never
merged forward into master, which instead spliced in v1.1 separately on
2026-09-08, so this tail is an abandoned side path.

## 3. Overlap between our changes and adamdev/master's changes

**25 files touched on both sides since base; 17 of those produce a real merge
conflict.** File overlap via `comm -12` on sorted `git diff --name-only`
lists, dominated by the status-LED/toast/sidebar subsystem both sides
rewrote independently. 15 most consequential: `client/js/status-led.js`,
`launchpad.js`, `toast.js`, `session-sidebar.js`, `session-sidebar-groups.js`,
`session-sidebar-group-actions.js`, `session-sidebar-rows.js`,
`session-sidebar-clicks.js`, `session-status-ui.js`,
`session-status-summary.js`, `terminal.js`, `api.js` (all `client/js/`),
`client/css/status-led.css`, `client/css/styles.css`, `CLAUDE.md`.

`git merge-tree --write-tree v1.1 adamdev/master` (git 2.50.1, no working
tree touched) exits 1 with 17 conflicting paths, the same cluster plus its
tests and docs: `CLAUDE.md`, `client/css/status-led.css`, `client/index.html`,
`client/js/launchpad.js`, `session-sidebar-group-actions.js`,
`session-sidebar-groups.js`, `session-sidebar-rows.js`,
`session-status-summary.js`, `session-status-ui.js`, `status-led.js`,
`toast.js` (all `client/js/`), `docs/session-status.md`,
`tests/helpers/led_state_for.mjs`, `tests/test_dead_row_renders_dead.node.mjs`,
`tests/test_led_real_hooks.py`, `tests/test_status_led.node.mjs`,
`tests/test_status_summary.node.mjs`. The other 8 overlapping files merged
cleanly, edits landed in different regions of the same files.

## 4. Merge-base oddities, explained

**weekend-mvp-v3.1 has no merge-base with v1.1 because it descends from a
wholly separate root commit** (`1eb33d1` vs v1.1's `216a228`), the original
pre-tmux/PTY prototype lineage v1.1 never contained. **adamdev/master's "141
commits since base" is misleading for the same reason: 118 are that disjoint
legacy lineage, stitched in by one synthetic merge; only 23 are real new
work.** Commit `f9df612` ("bring v1.1 lineage into master, unrelated
histories") has two parents, `ba2aa5d` (base) and `4262043` (legacy tip,
2026-04-19), and its own tree is byte-identical to the base's, an
"ours"-strategy merge keeping zero legacy content while permanently attaching
its history. A plain `base..adamdev/master` walk drags in all 118 legacy
ancestors (`--first-parent` isolates the real 23; a bare shortlog does not).
Commit-count comparisons overcount by roughly 5x; the file-level diff stat in
section 2 is unaffected since it compares trees, not history.

**upstream/main's 5 "ahead" commits are 5 empty merge commits**, confirmed by identical tree hashes at base and tip: PRs from our own origin identity merged into Adam's upstream with no net content change.

## 5. Practical consequence of the Svelte 5 + Vite migration

Neither adamdev/master's real 23 commits nor weekend-mvp-v3.1 touch a
bundler or frontend framework: both are still plain vanilla-JS `client/`
files with no build step, same as us today. The migration collides with
nothing Adam has shipped so far, but it changes the shape of every future
merge from him: once `client/js/*.js` becomes Svelte components under `web/`
with `client/dist/` committed as build output, a path-based three-way merge
stops being meaningful for that subsystem, because his edits keep landing on
files that no longer exist in that form on our side. The 17 files that
conflict today (status-LED/toast/session-sidebar) are also where both sides
are iterating hardest right now, so that is the biggest collision risk ahead.
A future merge from Adam stays realistic for `src/`, tests, docs, and
macOS/menubar work, where neither side has announced a rewrite; for the
client subsystem it becomes a manual re-port instead of a mechanical merge,
take his intent from the commit message and rebuild it as a Svelte
component, budgeted heaviest for status/toast/sidebar since that is where he
ships most and the vanilla-to-Svelte gap is widest.
