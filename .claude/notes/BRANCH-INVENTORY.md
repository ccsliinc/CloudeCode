# Branch inventory, 2026-09-14

Measured 2026-09-14T16:07:48Z with `git ls-remote` against each remote
separately and `git rev-list --count` against `adamdev/master`. Every SHA
below was read from the remote, not from a local ref.

**THIS IS A SNAPSHOT OF A MOVING TARGET.** `feat/173-archive-db-split` moved
twice while this file was being written (2889f0b at 11:48, aa6f973 at 11:57).
An agent is working on `src/**` and `scripts/**` on that branch right now.
Re-read the tips before you act on them.

## The trunk

| Thing | Value |
|---|---|
| Trunk | `adamdev/master` = `Adoom666/CloudeCodeDev`, tip **`5b61b59`**, 2026-09-13 10:26:57 -0400, author `psyance` |
| Version on trunk | `macOS/package.json` reads **1.4.4**; `v1.4.4` tag = `5369fb8`, nine commits back |
| `origin/master` | `1b48cf9`. **Zero commits not already in `adamdev/master`**, 15 behind it. |
| `origin/main` (the DEFAULT branch of the public mirror) | `ecd0669` = the `v1.2.0` tag commit. **267 commits behind `origin/master`, 282 behind `adamdev/master`.** Contains none of v1.2.1, v1.4.0, v1.4.1, v1.4.2, v1.4.3, v1.4.4, each checked with `git merge-base --is-ancestor`. |
| Tags on `origin` | v1.2.0, v1.2.1, v1.4.0, v1.4.1, v1.4.2 |
| Tags on `adamdev` only | v1.4.3, v1.4.4 |

## The seven `feat/173-*` branches

All seven fork from **`917835f`** ("todo: 1.4.4 released"). All seven are
8 commits behind `adamdev/master`. All seven are pushed to **both** remotes at
**identical SHAs**, verified by `git ls-remote adamdev` and `git ls-remote
origin` run separately.

They are TWO chains, not one, and they diverged at `49fd571`.

### Chain A, the client (Svelte feature module)

| Branch | Tip | Ahead | What it contains | Deployed |
|---|---|---|---|---|
| `feat/173-history-archive` | `04adb19` | 4 | The claim, and `docs/history-archive-scope.md` grown to 1,668 lines with section 10 "Standing it up alone, some day" | no, docs only |
| `feat/173-slice1-app-screen` | `dc58507` | 5 | Slice 1: the `app-screen` surface, four routing modules moved to `web/src/lib/plugins/history/`, grant enforcement, the import-direction test | **no** |
| `feat/173-slice2-4-granted-client-state` | `fcba547` | 7 | Slices 2 and 4 on top of slice 1: the granted archive client, state, keys, help modal, formatters | **no** |

### Chain B, the archive (server, SQLite)

| Branch | Tip | Ahead | What it contains | Deployed |
|---|---|---|---|---|
| `feat/173-archive-join-sqlite` | `746309e` | 13 | Projects `transcript_archives` / `transcript_records` into the v16 `message_*` model, so the browser stops reading empty tables | **yes** (`src/core/message_projection.py` present in the derived copy) |
| `feat/173-archive-fts-compress` | `5209aa1` | 19 | FTS5 over `message_content_blocks`, per-row zlib on `body_json` | **yes** (`src/core/archive_search_fts.py` present) |
| `feat/173-archive-db-split` | `aa6f973` | 40 | Separates the archive into `cloude-archive.db`, ATTACHed at one seam. PLUS `aa6f973`, the integrity-gate pair fix | **partly**: the split is live, `aa6f973` is NOT (`RUN_PAIR_NOT_COVERED` appears 0 times in the deployed `db_integrity_gate.py`) |
| `feat/173-archive-http-surface` | `0439526` | 42 | `GET /archive/archives/{archive_uuid}`, byte-exact blob export, the 409 that keeps the two id spaces apart | **no** (`src/api/archive_blob_routes.py` absent from the derived copy) |

### The divergence inside chain B, which matters

`feat/173-archive-http-surface` forked from `75afdb9` and does **not** contain
the last two commits of `feat/173-archive-db-split`:

- `2889f0b` docs(lessons): the "opts out of a name resolution" entry plus its correction
- `aa6f973` fix(integrity): one file, one walk, one attribution, and the boot gate covers the pair

So `db-split` is the branch with the current `docs/LESSONS.md` (437 lines) and
the current integrity gate. `http-surface` has the newer FEATURE and the older
LESSONS (321 lines). Merging them in the wrong order silently drops the
integrity fix.

## THE MERGE HAZARD THAT WILL BITE, MEASURED

All seven branches fork at `917835f`, which is **one commit before `cecebf5`**
("docs: strip CLAUDE.md to its routing layer, move the record into `docs/`").

| Ref | `CLAUDE.md` line count |
|---|---|
| `adamdev/master` | **552** |
| `feat/173-history-archive`, `-slice1-app-screen`, `-slice2-4-granted-client-state` | 5,080 |
| `feat/173-archive-join-sqlite` | 5,139 |
| `feat/173-archive-fts-compress` | 5,140 |
| `feat/173-archive-db-split` | 5,141 |
| `feat/173-archive-http-surface` | 5,142 |

Every one of these branches edited the PRE-STRIP `CLAUDE.md`. A merge to trunk
will conflict across the whole file, and the two obvious resolutions are both
wrong: taking the branch side re-inflates the routing file and undoes
`cecebf5`; taking the trunk side drops the routing rows the branches added.

**The correct resolution is mechanical.** Each archive branch added 59 to 62
lines to the old file, and those lines are recoverable exactly:

    git diff 917835f..<branch> -- CLAUDE.md

Take `adamdev/master`'s 552-line file, then re-apply only those added rows
(the `docs/history-archive-*.md`, `docs/archive-*.md` routing rows plus the
paragraphs that go with them) in the routing file's own shorter style. Do NOT
merge `CLAUDE.md` by hand line by line.

`docs/history-archive-scope.md` has the same problem one layer down: it is
**1,668 lines on chain A and 1,040 lines on chain B**, and the two revisions
disagree about section numbering (chain A runs to section 11, chain B to
section 10). Chain A carries section 10 "Standing it up alone, some day";
chain B carries the database-separation detail. Neither is a superset.

## Branches that are NOT part of this and are already contained

`fix/boot-integrity-gate` (`b5de919`) is fully contained in `adamdev/master`:
`git log adamdev/master..fix/boot-integrity-gate` is empty. It is NOT where
today's integrity-gate fix lives. That is `aa6f973` on `feat/173-archive-db-split`.

## Working copies

The main checkout at
`~/Library/Mobile Documents/com~apple~CloudDocs/Sync/Development/CloudeCode`
is on **`release/1.2.1`** (`942638e`), which is stale. It also holds two
UNTRACKED files that exist nowhere in git:

- `docs/transcript-archive-integrity.md` (rescued onto this branch, see below)
- `scripts/transcript-archive/verify_archive_integrity.py` (**still untracked, still at risk**)

Roughly fifty git worktrees live under the session scratchpad. `git worktree
list` is the inventory; `prunable` in that listing means the directory is gone.
