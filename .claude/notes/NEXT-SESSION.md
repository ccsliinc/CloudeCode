# NEXT SESSION - 2026-09-14

The short version. `.claude/notes/HANDOFF.md` section 0 is the long one and
carries the method behind every number here. `.claude/notes/BRANCH-INVENTORY.md`
is the branch map.

**EVERY `docs/history-archive-*.md`, `docs/archive-*.md`,
`src/core/archive_*`, `src/core/message_projection*`, `src/api/archive_blob_routes.py`
AND `scripts/drain_preflight.py` PATH NAMED BELOW EXISTS ONLY ON A `feat/173-*`
BRANCH, NOT ON TRUNK.** `.claude/notes/BRANCH-INVENTORY.md` says which branch
carries which. A path that resolves to nothing on `master` is expected here,
not a broken citation. The two exceptions, named where they appear, are
`docs/transcript-archive-integrity.md`, which this branch commits, and
`scripts/transcript-archive/verify_archive_integrity.py`, which is in no git
object at all.

## Running right now

**A corpus drain, pid 42032**, started 2026-09-14 15:59:02Z from
`.../scratchpad/wt-archive-db-split`, running
`scripts/project_archive_to_message_model.py --apply`. Do not kill it, do not
restart the server under it, do not open the archive database for writing.

Check it, never guess:

    cat "$HOME/Library/Application Support/CloudeCode/message-drain/latest.json"

Last read here, 16:06:22Z: 256 done, 19,305 pending, 0.582/s, **eta 33,146 s
(9.2 hours)**, archive db 5,708,038,144 bytes. The planning figure was 3.7
hours and about 15.6 GiB, extrapolated from a 300-archive sample and labelled
as an extrapolation in both `docs/history-archive-join.md` and
`scripts/drain_preflight.py`. The live ETA is 2.5x that. One early sample does
not refute an extrapolation, but do not quote 3.7 hours as if it were measured.

An agent owns `src/**` and `scripts/**`. `feat/173-archive-db-split` moved
twice in ten minutes today. Re-read every branch tip before acting.

## Blocked, and on whom

**On Adam, all unanswered, all verified by API 2026-09-14:**

- **#122** one trunk, a structural-change rule, the repository question. **Zero
  comments.** This is the one that unblocks the repository confusion below.
- **#173 / PR #174**, our claim on the history and archive browser. Three
  comments on the issue, all ours. Zero comments and zero reviews on the PR.
- **#175** "front end redesign: the whole ui rebuilt in svelte", `owner-only`,
  and its scope explicitly names "the archive screens". **Zero comments.** The
  boundary between it and #173 is what blocks slice 3 and slices 5 to 9. Our
  proposed split: he owns style, visual design and layout; we own module
  structure, routing, the data path and the plugin surface.
- #115, #116/PR #117, #118/PR #119, #120, #121 all still open.

**New since the last summary:** Adam opened **PR #176**, his claim on his own
issue #123 (the sub-agent toast suppression), branch `attention-passive-123`.

## Needs the owner

1. **`ccsliinc/CloudeCode`'s default branch `main` is 267 commits behind
   `origin/master` and 282 behind `adamdev/master`.** It is PUBLIC and it holds
   none of v1.2.1, v1.4.0, v1.4.1, v1.4.2, v1.4.3, v1.4.4. Anybody landing
   there sees v1.2.0. His call what to do about it.
2. **`docs/DECISIONS.md` says one repository and practice says two.** Adam's
   2026-09-12 ruling says nothing is pushed, mirrored or released anywhere but
   `Adoom666/CloudeCodeDev`, naming `ccsliinc/CloudeCode`. All seven
   `feat/173-*` branches ARE on `ccsliinc/CloudeCode`, pushed after that ruling,
   at identical SHAs. The owner's instruction is that `CloudeCodeDev` master is
   the trunk and `ccsliinc/CloudeCode` stays his backup mirror. Until #122 is
   answered: push `adamdev` then `origin`, never `upstream`. Do not rewrite
   Adam's ruling; it is his and it is append-only.
3. **`aa6f973` (the integrity-gate pair fix) is committed and NOT deployed.**
   The running server still publishes `"databases": []` in
   `db-integrity/latest.json`. Deploying is the owner's call and a drain is in
   flight. Nothing is wrong with the data; the gate just cannot vouch for a
   split install.
4. **`scripts/transcript-archive/verify_archive_integrity.py` is UNTRACKED** and
   exists in no git object, only in the main working copy (which is itself on
   the stale `release/1.2.1` branch). It is the script that re-runs the archive
   integrity measurement. Whoever owns `scripts/**` should commit it. Its
   companion document was rescued onto this branch as
   `docs/transcript-archive-integrity.md`.

## Traps that cost time this session

1. **Every `feat/173-*` branch carries a 5,000-line `CLAUDE.md`.** They fork at
   `917835f`, one commit before `cecebf5` stripped that file to 552 lines.
   Merging any of them conflicts across the whole file; "take theirs" re-inflates
   the routing layer, "take ours" drops the archive routing rows. The mechanical
   resolution is in `.claude/notes/BRANCH-INVENTORY.md`.
2. **`docs/history-archive-scope.md` is two different documents.** 1,668 lines
   on the client chain, 1,040 on the archive chain, different section numbering,
   neither a superset.
3. **There are two TODO files.** `TODO.md` at the repo root is Adam's;
   `.claude/TODO.md` is ours. The P6 / 1.4.2-login-404 record is in HIS, which
   is why it looks missing from ours. `.gitignore` carries `.claude/*`, so ours
   needs `git add -f`.
4. **The state directory is `~/Library/Application Support/CloudeCode/`.**
   `cloude-code-menubar/` is the Electron user-data directory: it holds the
   derived server copy and **no database**. Looking there for `cloude.db` finds
   nothing and reads like the database is missing.
5. **The derived server copy's `VERSION` file says 1.4.0 and its code is
   newer.** The string is stamped at install time. Verify a deploy by GREPPING
   the derived copy for a marker, never by the version string and never by
   mtime, because rsync preserves mtime.
6. **`gh pr view --json commits` caps its array at 100.** PR #108 reports 100
   and is 110, counted with `git rev-list --count` across the merge commit.
7. **A branch with the newest DATE is not the branch with the newest CODE.**
   `feat/173-archive-http-surface` is newer by feature and OLDER by two commits
   than `feat/173-archive-db-split`, lacking both the integrity fix and the
   current `docs/LESSONS.md`.

## Do not

Deploy. Restart the live server. Touch `config.json`. Run `tmux` against the
`cloude` socket. Open the live databases for writing. `git checkout -- <path>`,
`reset --hard`, `stash` or `clean`. `rm` anything (move to
`~/.Trash/<name>-<date>/`). Bare `cp` non-interactively. Push to `upstream`.
