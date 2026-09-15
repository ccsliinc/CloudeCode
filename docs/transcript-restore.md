# Restoring a transcript so a timed-out conversation can be resumed

The archive holds the original bytes of every transcript this machine has
produced, and `src/core/message_model_export.py` plus
`transcript_archive.export_archive` reconstruct them byte-exactly. That is
the READ half, and it was verified across the full corpus.

This document is the WRITE half: putting a reconstruction back on disk so
`claude --resume <uuid>` can pick the conversation up.

## What `--resume` actually needs

`claude --resume <uuid>` looks for exactly one file:

```
~/.claude/projects/<project-dir>/<uuid>.jsonl
```

and prints `No conversation found with session ID: <uuid>` when it is not
there. That is the whole contract. Restore the file, and the conversation
resumes; the archive is the only thing standing between a deleted
transcript and a lost conversation.

## The modules

| Piece | File |
|---|---|
| Every named outcome, in one place | `src/core/transcript_restore_outcomes.py` |
| uuid to ONE archive row, and rebuild it | `src/core/transcript_restore_resolve.py` |
| Where the bytes belong, and the refusal ladder | `src/core/transcript_restore_target.py` |
| The atomic write, through the home guard | `src/core/transcript_restore_write.py` |
| The composed plan | `src/core/transcript_restore_plan.py` |
| Operator entry point, DRY RUN BY DEFAULT | `scripts/restore_transcript.py` |

## THE ROW SELECTION IS THE SAFETY ARGUMENT

A growing transcript has MANY rows for one `source_path`. Measured on the
owner's box 2026-09-15: 22,184 distinct paths, 23,659 rows, 21,793 paths
with one row and the worst with 311. Every row but the newest is a
snapshot and reconstructs to a strict byte PREFIX of the newest.

So the rule is `ORDER BY ingested_at DESC, id DESC LIMIT 1`, which is the
project's own recency rule and the exact ordering
`ix_transcript_archives_projection_scan` already indexes.

**TWO PLAUSIBLE RULES ARE WRONG AND BOTH LOOK RIGHT.**
`superseded_by_archive_id IS NULL` does not identify a head: only 16.6
percent of rows are ever deduped, so on an ordinary path every row is NULL
and the predicate selects all of them. `MAX(raw_byte_length)` does not
either: `growth_kind='non_append_rewrite'` is a real value and a rewrite
may legitimately SHRINK a file, so picking by length resurrects stale
bytes over a genuine rewrite.

**This is the answer to the 1,426 `prefix_of_source` rows.** They are
superseded snapshots. The writer can never select one, because selection
takes the newest row for the path, so writing a truncated conversation is
prevented by construction rather than by a check that could be forgotten.
They remain load-bearing on the READ side: the chain walk through them is
what lets the chosen row reconstruct at all.

## A `LIKE` PREFILTER IS NOT AN ANSWER, AND THIS ONE BIT

The stem lookup uses `source_path LIKE '%/<uuid>.jsonl'`. `_` is a
SINGLE-CHARACTER WILDCARD in SQL `LIKE`, and **528 stems in the live
archive contain one** (`agent-aprompt_suggestion-ef1d49` and friends).

So the pattern alone can match a NEIGHBOURING transcript. On a uuid whose
own file is absent - which is the entire population this feature serves -
that would have resolved to somebody else's conversation and written it
out under the requested uuid, with no error anywhere. The `LIKE` is now a
prefilter only; the answer is an exact stem comparison in Python, which
cannot be wildcarded. `%` is covered by the same fix.

This was found by asking what a database value could do to the query, not
by a failing test, and it is the shape of bug that ships green.

## THE DESTINATION IS MEASURED, NOT DERIVED

`transcript_archives.source_path` already carries the project directory
the file was READ FROM, relative to the corpus root. That is a record of
where the file literally was. Slugifying a cwd is a derivation, and a
measurement outranks one.

It disposes of the cwd-spelling trap (gotcha 6) rather than navigating
it. `~/Development` is a symlink into iCloud and Claude Code slugs the
LITERAL cwd, so one directory has two project directories and `--resume`
finds a transcript only under the spelling claude itself used. Whichever
that was is baked into the recorded `source_path`.

**VERIFIED AGAINST REALITY, not asserted.** Over all 1,503 `kind='session'`
paths in the live archive whose file is on disk, the derived destination is
that exact existing file: **1,503 of 1,503**. Over all 22,184 distinct
paths: 19,660 land on an existing file and 2,524 do not, and those 2,524
are precisely the transcripts that have been deleted from
`~/.claude/projects` (where the archive is now the only copy).

The slug rule is still run, by `corroborate_directory`, and REPORTED as a
cross-check that never decides. A disagreement is a real shape - 11 of 919
live transcripts sit in a directory that disagrees with their own recorded
cwd because the session's cwd moved after startup - so refusing on it
would refuse real transcripts.

## THE THREE THINGS THIS REFUSES TO DO

Each one destroys a conversation rather than restoring one.

1. **It will not write over an existing transcript.** `--overwrite` is a
   separate explicit opt-in, and it takes a `.bak` of the pre-write bytes
   first. A file that is there may be one claude is appending to right now.
2. **It will not write over a file LONGER than the archive holds, even
   under `--overwrite`.** That shape means the archive is BEHIND the live
   file, and writing would truncate a real conversation. Permission to
   replace a file is not permission to shorten one.
3. **It will not write bytes whose sha256 disagrees with the row's own
   `content_sha256`.** A reconstruction that is not what was ingested is
   the one failure that produces plausible output, so it is caught by a
   hash and not by a reader's eye.

## The home write guard

`write_transcript` calls
`src.core.test_write_guard.assert_test_write_allowed` as its FIRST action,
on the target and again on the temp file, before anything is opened or any
directory created. The guard is inert in production and, under pytest,
refuses any destination outside a temp root - including one it cannot
place, because "I could not work out where this write would land" is the
state the defect it was written for hid in.

**Watched go red.** With the two guard calls removed, a writer aimed at a
non-temp path returns `written` and the file appears on disk. With them in
place it returns `refused_by_test_guard` and nothing is created.

## The four negative controls, each watched go red

A writer that always succeeds is worse than useless, so every safety claim
here was falsified on purpose before it was trusted. The probe for the
guard was aimed at a harmless non-temp path rather than at
`~/.claude/projects`, because a probe file dropped in the live corpus
would be ingested into the archive.

| Mutation | Result |
|---|---|
| `resolve_target` returns `target_ready` unconditionally | 5 tests fail, including the one asserting each refusal has its own name |
| Row selection ordered `ingested_at ASC` (oldest wins) | 2 tests fail; the chosen row is the truncated snapshot |
| Both `assert_test_write_allowed` calls removed | probe returns `written`, file appears outside temp |
| `LIKE` prefilter trusted as the answer | 2 tests fail; a neighbouring transcript resolves |

## Durability

Temp file in the SAME directory (so `os.replace` is a rename within one
filesystem and therefore atomic), `flush`, `fsync` the file, `os.replace`,
then **`fsync` the directory** - the step usually left out, without which
a crash between the rename and the directory flush can leave neither name.
On the overwrite path the `.bak` is written and fsync'd BEFORE any of it.

Then the file is READ BACK and re-hashed. A writer that reports success
from the absence of an exception is reporting that no error was raised,
not that the right bytes are on disk.

**The refuse-if-exists re-check narrows a race and does not close it.**
Between the stat and the `os.replace` a live claude could create the file,
and a rename cannot be made conditional on the destination being absent.
Saying so is better than a comment claiming a guarantee the syscall does
not provide. The case this feature exists for has no live writer by
construction.

## NOT EVERY TRANSCRIPT IS RESUMABLE, and the report says so

**21,385 of the 23,659 rows in the live archive are `kind='subagent'`** -
`agent-*.jsonl` under `<uuid>/subagents/` - which claude reads as part of
a parent conversation and never opens by uuid. Restoring one is useful
(2,524 transcripts exist only in the archive, and almost all of them are
subagents); resuming it is not a thing. `RestorePlan.resumable` carries
the distinction and the script prints it per row.

Measured the same day: **zero `kind='session'` transcripts are missing
from disk.** Every one of the 2,524 deleted files is a subagent. So the
population this feature protects is currently intact, and the feature is
insurance rather than a cleanup job.

## The named outcomes

Resolve: `resolved`, `no_archive_row` (the query RAN and matched nothing),
`database_unreadable` (no query ran - silence is never evidence),
`ambiguous_uuid` (one uuid, two project directories; writing either is a
guess, so it names both and `--source-path` narrows).

Reconstruct: `reconstructed`, `chain_broken`, `content_corrupt`,
`self_inconsistent`.

Target: `target_ready`, `escapes_corpus_root`, `target_exists`,
`source_is_longer_than_archive`, `parent_missing`.

Write: `written`, `write_failed`, `refused_by_test_guard`,
`verify_after_write_failed`, `dry_run`.

## Proven end to end, not in a unit test

A test asserting bytes match does not prove a conversation can be resumed.
The real thing, 2026-09-15, in a throwaway project directory, touching no
owner session and never the `cloude` tmux socket:

1. A conversation was created holding one distinctive fact.
   Transcript: `d74fba98-b502-4772-b5e5-2e843ee8f97f.jsonl`, 184,417 bytes.
2. It was ingested into a THROWAWAY archive database.
3. The transcript was moved to `~/.Trash` - the conversation is now lost.
4. **NEGATIVE CONTROL:** `claude -p --resume <uuid>` answered
   `No conversation found with session ID: d74fba98-...`. Without this step
   a later success would prove nothing.
5. `scripts/restore_transcript.py --apply` wrote it back. 184,417 bytes,
   sha256 `f0feaa2d...cb2`, matching both the archive's recorded
   `content_sha256` and the original file byte for byte.
6. `claude -p --resume <uuid>` answered with the pre-loss fact.

The claim "a timed-out conversation can be resumed" is therefore measured,
and its negative control is on the record beside it.

## Usage

```bash
# what would happen, and nothing else (the default)
venv/bin/python3 scripts/restore_transcript.py --uuid <uuid>

# rehearse into a staging tree instead of the live corpus
venv/bin/python3 scripts/restore_transcript.py --uuid <uuid> \
    --corpus-root /tmp/staging --create-dirs --apply

# actually restore
venv/bin/python3 scripts/restore_transcript.py --uuid <uuid> --apply
```

Exit codes: 0 every uuid ready (and written, under `--apply`); 1 at least
one refusal; 2 the run could not be performed, which is NOT a pass.

`--state-dir` overrides the install's state directory, which a repo
checkout that is not itself the running install needs, since `Settings`
hard-exits without a `.env`.
