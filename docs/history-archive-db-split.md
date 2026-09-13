# Separating the transcript archive into its own database

Companion to `docs/history-archive-scope.md` section 6, which asked the
question. This records what was MEASURED when the schema was actually put
in front of the problem, including the two places the scope doc turned
out to be wrong, and what was built.

**The answer is yes, do it.** The schema supports it cleanly: exactly
three foreign keys cross, all in one direction, all with zero orphans, a
self-contained `message_*` family, and a single `connect()` seam for the
ATTACH.

---

## The measurements, re-taken

All against `cloude.db.bak-v25-20260910T154341Z`, read-only, so the live
file was never opened. sqlite 3.53.4.

| Claim | Scope doc | Re-measured 2026-09-13 |
|---|---|---|
| archive share of the file | 99.99% | **99.9858%** |
| app state | 716 KiB | **712 KiB** (729,088 bytes incl. `sqlite_schema`) |
| crossing foreign keys | 3 | **3**, and the same three |
| populated crossing rows | 1,507 / 3,160 / 3,160 | **1,507 / 3,160 / 3,160** |
| orphaned crossing refs | not stated | **0 / 0 / 0** |
| `transcript_root_decisions` | 23,023 | **23,023** |

Largest objects: `transcript_archives` 3,732,221,952 bytes,
`transcript_records` 972,886,016, its uuid index 310,726,656. On the app
side nothing exceeds `sessions` at 450,560.

The `message_*` family is EMPTY today (0 rows outside two seed rows), and
that is the argument for moving it NOW rather than after the corpus
drain: it costs nothing to move today and is the largest thing in the
file afterwards.

---

## Where the line falls

**Archive side, 19 tables plus 2 views.** `transcript_archives`,
`transcript_records`, `transcript_root_decisions`,
`archive_project_overlay`, the 15 `message_*` tables, the views
`message_body_hosts` and `message_session_hosts`, and the FTS5 shadow
tables sqlite creates for `message_block_search`.

**App side, 8 tables.** `sessions`, `projects`, `meta`,
`migration_trail`, `project_tombstones`, `session_groups`,
`session_group_members`, `session_group_membership`.

`src/core/archive_db_partition.py` is the ONLY place this is written
down. The app side is an explicit allow-list (small, stable,
irreplaceable, so naming it one by one makes an accidental move
impossible) and the archive side is a prefix rule (it grows, and the FTS5
shadow tables are created by sqlite rather than declared). Anything
matching neither is `unclassified` and REFUSES.

The rule is by TABLE NAME, never by module glob: a glob on `*archive*`
over `src/` picks up `src/core/project_archive.py`, which retires a
project shelf and is not part of this family. Note also that
`project_tombstones` is the table that LOOKS like it might be archive and
is not.

---

## The three crossing foreign keys, and what was decided

| constraint | populated | orphans | decision |
|---|---|---|---|
| `transcript_archives.root_session_id -> sessions(id)` | 1,507 | 0 | drop, enforce in code |
| `transcript_archives.project_id -> projects(id)` | 3,160 | 0 | drop, enforce in code |
| `transcript_root_decisions.project_id -> projects(id)` | 3,160 | 0 | drop, enforce in code |

All three point ARCHIVE -> APP. **Nothing crosses the other way**, which
is what makes the split viable at all.

Moving `sessions` or `projects` across is not an option: they are the
app's core state. Redrawing the line to keep `transcript_archives` in
main defeats the entire purpose, since it is 3.73 GB on its own. So all
three become plain `INTEGER` columns carrying the same values. The
compensation is that the reverse migration re-imposes them, and the
forward migration refuses on a non-zero orphan count, so they are known
sound at the moment of the split.

The archive-internal keys are untouched and still enforced, including the
one `ON DELETE CASCADE` on `transcript_records.archive_id`.

---

## CORRECTION: the scope doc is wrong about how sqlite refuses

The scope doc records:

```
CREATE TABLE arch.t2(sid INTEGER REFERENCES sessions(id))
  -> OperationalError: no such table: arch.sessions
```

and concludes "the constraint cannot be expressed at all. It does not
become an unenforced declaration that looks right and does nothing, which
would have been the worse outcome."

**Measured, and it is half wrong in the dangerous direction.** The
qualified form is indeed a DDL-time syntax error. The UNQUALIFIED form is
**ACCEPTED at DDL time** and fails only at DML time:

```
CREATE TABLE archive.t2(sid INTEGER REFERENCES sessions(id))   -> ACCEPTED
INSERT INTO archive.t2 VALUES (1, 1)  -> no such table: archive.sessions
```

It binds to `archive.sessions`, same-database resolution. Proven rather
than inferred: after creating an `archive.sessions`, a value present only
there was accepted and a value present only in `main.sessions` was
refused with FOREIGN KEY constraint failed.

**And `PRAGMA archive.foreign_key_check` returns `[]` on such a table.**
It does not report the dangling target.

So a migration that copied the DDL verbatim would create every table
successfully, pass every integrity check, report success, and leave an
archive nothing can ever write to. That is why
`archive_db_ddl.strip_crossing_references` is mandatory and why
`archive_db_split.probe_writability` proves the strip worked with a REAL
INSERT rather than by reading the DDL back. Reading the schema cannot
detect this; only a write can.

---

## ATTACH, not two connections

**Decided: one connection with `ATTACH`.**

1. The ingester's cross-boundary reads are real and on the hot path:
   `SELECT id FROM sessions WHERE claude_session_uuid = ?` in
   `transcript_corpus_ingest.py` and `transcript_archive.py`, an antijoin
   `FROM sessions s` for the gap report, and three reads in
   `transcript_import_write.py`. Under two connections those become
   Python loops over 22,828 rows.
2. `src/core/db.py::connect()` is a SINGLE seam. One ATTACH there covers
   a 68-module family.
3. WAL works for both under one connection. Measured:
   `PRAGMA archive.journal_mode=WAL` returns `wal` with main also `wal`.

**The cost, stated rather than glossed.** There is no independent lock
domain: a long ingest write holds the shared connection. If that bites,
the answer is a second connection FOR THE INGESTER ONLY, doing its
rooting reads through a small in-Python lookup. Choosing ATTACH now does
not foreclose that.

**Cross-database atomic commit is void under WAL.** This is the one claim
here taken from documentation rather than measured: what was measured is
only that a clean cross-database COMMIT succeeds and both halves land,
which proves nothing about crash atomicity. The design therefore assumes
non-atomicity and the rooting write must be idempotent and re-runnable.

**The ingester does not move.** It is server-side; the plugin surface is
browser-side; there is no server-side plugin runtime. It stays core and
writes across the boundary through the ATTACH.

---

## The migration

`scripts/split_archive_db.py`, **dry run by default**, following
`backfill_claude_session_uuid.py` and `classify_session_kind.py`.

### The spine

**THE SOURCE IS NEVER DROPPED UNTIL EVERY TABLE HAS BEEN COPIED AND
VERIFIED IN THE SAME RUN.** Until that moment the operation is abortable
at the cost of deleting one file. That is a stronger guarantee than a
transaction, and unlike a transaction it is one sqlite can actually keep
here.

### Resumable, not transactional

A single `BEGIN ... COMMIT` spanning both files would LOOK atomic and
would not be, because cross-database atomic commit does not apply under
WAL. Selling a rollback guarantee we do not have is worse than not
offering one. So the copy is table by table, ordered by rowid, in
committed chunks, with progress recorded durably in the destination. An
interrupted table always leaves a rowid PREFIX, never a hole.

The resume predicate is deliberately conservative: a table is done only
when the destination count equals the source count recorded when it
finished. Anything else is truncated and recopied, because reasoning
about a partial copy of an unknown shape is not worth it while the source
is intact.

### Refusal rungs

Pre-flight, before anything is written:

| rung | kind |
|---|---|
| `source_unreadable` | measured |
| `source_integrity_failed` | measured |
| `schema_version_unexpected` | measured |
| `unclassified_object` | measured |
| `crossing_fk_set_changed` | measured |
| `orphaned_reference` | measured |
| `destination_exists_and_is_not_ours` | measured |
| `insufficient_disk` | measured |
| `disk_headroom_cannot_be_determined` | **unchecked, does NOT refuse** |
| `schema_version_unreadable` | **unchecked, does NOT refuse** |

Pre-drop, gating the one destructive step:

| rung | kind |
|---|---|
| `row_count_mismatch` | measured |
| `content_sample_mismatch` | measured |
| `crossing_constraint_not_stripped` | measured |
| `destination_integrity_failed` | measured |
| `source_changed_during_copy` | measured |

`orphaned_reference` refuses FORWARD even though forward does not need
it, because it is what makes the REVERSE possible: a forward migration
that quietly destroyed reversibility would be a one-way door sold as a
two-way one.

`source_changed_during_copy` is the live-install rung. The owner runs
with the server up, so the ingester can append mid-copy. Source counts
are taken at plan time and again at verify time; a table that moved
refuses the drop. The copy is re-runnable, so re-running is the answer.

### Reversibility, in three tiers

| when | cost |
|---|---|
| before the drop | **free** - delete the destination file. Covers the whole multi-hour copy. |
| after the drop, before VACUUM | **cheap** - `--reverse` |
| after VACUUM | a full rewrite, needing the disk back |

That is why VACUUM is a SEPARATE operator command
(`--vacuum`) and not part of the migration: it is the point after which
reversing stops being cheap, and it deserves its own decision.

The reverse recreates each table from the pre-strip DDL the forward pass
recorded verbatim in `archive_split_origin`, so the crossing constraints
return exactly as they were rather than as this code's guess at how to
spell them. Re-imposing them IS the integrity check the split gives up,
run once.

### Measured results

On a 443 MB real-data fixture built from the v25 backup:

- 235,304 rows copied, 21 objects dropped, 2.3 s
- 200 content samples byte-identical
- both databases `integrity_check` ok, `foreign_key_check` clean
- crossing columns still carrying 148 / 310 / 310 values as plain INTEGER
- archive-internal keys surviving
- `cloude.db` VACUUMed from 443,400,192 to **712,704 bytes (696 KiB)**

Round trip on a 157 MB fixture: 27 tables before and after, **zero row or
content-hash diffs, zero FK diffs**, and a deliberately orphaned insert
raises `IntegrityError` afterwards.

**Reconstruction stays byte-exact through the split.** 400 real archives,
959,622,317 bytes decompressed and sha256-checked against
`content_sha256`: **400/400 before the split reading `main`, 400/400
after reading the separate archive database, identical results.**

### Schema versions this was measured against

`VERIFIED_SCHEMA_VERSIONS = {25, 26, 27}`. v25 is the read-only backup
every size and orphan figure above came from. v26 and v27 were checked by
migrating a fresh database through the app's OWN chain
(`ensure_db_migrated`) and re-running the partition against the result:
**zero unclassified objects, and the same three crossing keys**. So the
FTS5 and compression steps on `feat/173-archive-fts-compress` add no
crossing foreign key.

This deliberately does NOT import `CURRENT_SCHEMA_VERSION`. Importing it
would make the rung agree with whatever the code says today, and it would
never refuse anything - the opposite of its job. A version added after
this module was written is one whose schema nobody has looked at. Adding
one here is a one-line change and the measurement behind it takes a
minute.

### Resumability, measured by actually killing a copy

A 443 MB copy was SIGKILLed mid-flight. It had finished
`transcript_archives` (400/400, progress row stamped) and had not begun
`transcript_records`.

- **the source was intact**: 400 / 234,446 / 458 still in `cloude.db`
- **the destination held a clean partial**: 400 archives, 0 records
- the re-run **resumed**, skipped the completed table, finished
  400 / 234,446 / 458, verified 200 content samples, dropped 21 objects,
  and left `cloude.db` holding exactly the eight app tables

That kill found a real bug, and it is the only way it surfaces: the DDL
comes out of `sqlite_master` verbatim and so carries no
`IF NOT EXISTS`, which made the second run die with `table
archive_project_overlay already exists` on its first object. Not
dangerous (the source was intact) but permanently STUCK, which defeats
the one thing the design promises. `create_archive_schema` now skips
objects the archive already holds. Every clean run creates the schema
exactly once, which is why no ordinary test could have caught it.

### A bug the real data caught

The first drop order was alphabetical with a special case for
`transcript_archives`. It died on `DROP TABLE main.message_bodies` with
`no such table: main.message_block_types`, because with
`foreign_keys=ON` a DROP runs an implicit delete and must resolve the
foreign keys of every table still referencing the one going away, and
`message_content_blocks` references both. The error names the table that
went EARLIER, not the one being dropped, which is thoroughly misleading.

It failed safe (transaction rolled back, source intact), which is how it
was caught. `archive_db_split.drop_order` now computes a
reverse-topological order from the real FK graph. Turning the pragma off
for the drop was the alternative and was not taken: it is a no-op inside
a transaction, and a drop a live constraint refuses is a drop that should
not happen.

---

## The integrity gate with two databases

`src/core/db_integrity_pair.py`. **One artifact carrying a LIST of
per-database verdicts**, not two artifacts and not a scalar that silently
means "the main one". Two artifacts would make "only the state database
was checked" look identical to "both were checked and both are sound".

- the pair verdict is the WORST of the parts: failed > cannot_determine > ok
- `cannot_determine` on one part NEVER becomes `ok` for the pair
- a part that is EXPECTED and ABSENT from the list is `cannot_determine`,
  not ignored

`expected_databases()` MEASURES which files exist rather than reading a
flag, so an unsplit install is not permanently `cannot_determine` for a
file it does not have, and a split install starts being covered the
moment the file appears.

Backward compatibility is deliberate and narrow: a record with no
`databases` list predates the split and is read as covering the state
database only. On an unsplit install that folds to a plain `ok`. On a
SPLIT install the archive is expected, is absent from the list, and the
pair correctly becomes `cannot_determine` - an old artifact cannot vouch
for a file that did not exist when it was taken.

Measured across all five cases. `PRAGMA archive.integrity_check` works on
an attached database, so this is one extra statement, not a second
connection.

`db_integrity.py` reached 508 lines doing this, so `check_every_database`
moved into the pair module rather than growing a file already at the cap.
It is back to 455.

---

## Backup implications

The two-tier policy exists because of the size asymmetry, and the split
makes that asymmetry structural rather than something the backup script
has to know about.

- **`cloude.db` becomes ~712 KiB.** It can be backed up as often as
  wanted, kept in many generations, and copied anywhere. This is the file
  that is NOT rebuildable, and it is now small enough that protecting it
  properly costs nothing.
- **`cloude-archive.db` is the multi-gigabyte one and is mostly
  rebuildable** from `~/.claude/projects`. It can be backed up on a much
  slower cadence.
- **EXCEPT `transcript_root_decisions`, which is NOT rebuildable.**
  23,023 human and machine attribution decisions that exist nowhere else.
  This is the single most important correction in the whole exercise: the
  archive database cannot be treated as purely disposable because of that
  one table. Either back the archive up anyway, or export that table with
  the state database.
- Today 15.1 GB of disk protects single-digit megabytes of state
  (`cloude.db` 5.2 GB plus a 4.8 GB `.bak-v25` plus a 5.1 GB
  `.online-backup.db`). After the split, protecting the irreplaceable
  half costs under a megabyte per generation.

The existing `db_backup.take_backup` uses `VACUUM INTO`, which is correct
for both files and needs no change beyond being pointed at each in turn.

---

## What is NOT done

**The ATTACH is not yet wired into `db.py::connect()`, and the 68-module
archive family still spells its SQL unqualified.** The migration creates
and populates the separate file correctly and reversibly, and the
integrity gate covers it, but the running app still expects the archive
tables in `main`. Wiring the qualifier through the read paths is the next
change and is deliberately separate: it touches every archive query and
wants to be reviewed as its own diff rather than buried under a
migration.

So the order to ship in is: this, then the ATTACH wiring, then run the
migration, then VACUUM as a separate decision.
