# Transcript archive integrity: the 16.5 percent that is not corrupt

First measured 2026-09-14, **re-measured 2026-09-16 after the archive db
split**, read-only, whole population, no sampling. Re-run it with
`scripts/transcript-archive/verify_archive_integrity.py`.

## Which database, and why that changed

Until 2026-09-14 the archive was a table set inside `cloude.db`. The archive
db split moved the whole `transcript_`, `message_` and `archive_` family into
a **sibling file**, `cloude-archive.db`
(`src/core/archive_db_partition.py` holds the partition and the filename
constant). After the split:

| file | what it is | size 2026-09-16 |
|---|---|---|
| `~/Library/Application Support/CloudeCode/cloude.db` | sessions, projects, groups, meta. No archive table at all. | 704 KB |
| `~/Library/Application Support/CloudeCode/cloude-archive.db` | `transcript_archives` and everything this document measures | 15.0 GB |

So every command here names `cloude-archive.db`. Two ways to get this wrong,
and the script refuses both rather than reporting on the wrong file:

- **Pointed at the post-split `cloude.db`** there is no `transcript_archives`
  table. That used to raise an uncaught `sqlite3.OperationalError` and exit 1,
  which any wrapper reads as "mismatches found". It is not a finding about the
  data, it is a run that did not happen, so it now exits **2**, the same
  "could not evaluate is neither a pass nor a failure" rule the per-row
  outcomes follow.
- **Pointed at a pre-split snapshot** - `cloude.db.bak-v26-20260914T135004Z`
  is sitting right beside the live files and still holds all 23,429 rows as
  they were twelve minutes before the split - every query succeeds and the
  report comes back perfectly green about a frozen file. A missing table
  cannot catch that, so the side is **measured**: the split writes a durable
  `archive_split_origin` table into the new file, so its presence names a
  database `post_split_archive` and its absence names it
  `pre_split_combined`. A pre-split database is refused unless
  `--allow-pre-split` says it was meant. The verdict, the file path, its size
  and its mtime are printed in the report header and carried in the JSON, so
  no result can be read without knowing which file produced it.

```
python3 scripts/transcript-archive/verify_archive_integrity.py \
  --db ~/Library/Application\ Support/CloudeCode/cloude-archive.db
```

## The answer

The 3,872 rows that fail a `sha256(content_gzip)` check are **not corrupt**.
They are superseded rows, and the check is asking the wrong question. Every
one of them reconstructs byte-exactly.

| measurement | 2026-09-14, in `cloude.db` | 2026-09-16, in `cloude-archive.db` |
|---|---|---|
| rows in `transcript_archives` | 23,429 | 23,715 (the ingester is live, so this keeps moving) |
| fail `sha256(zlib.decompress(row.content_gzip)) == row.content_sha256` | 3,872 (16.53 percent) | 4,083 (17.22 percent) |
| fail `sha256(export_archive(row)) == row.content_sha256` | **0** | **0** |
| broken chains, cycles, zlib errors | 0 | 0 |
| `mismatch` against the real file in `~/.claude/projects` | **0** | **0** |

The split moved the bytes and changed nothing about them: the same mechanism,
the same shape, the same zero. The whole 2026-09-16 pass took 257.1 seconds.

## What the stored content actually is

Not a truncation, not a prefix, not a different version. It is **empty**.

`transcript_prefix_dedupe.py` and `transcript_content_dedupe.py` replace a
superseded row's `content_gzip` with an 8-byte sentinel,
`zlib.compress(b"", 9)` = `78da030000000001`, and set
`superseded_by_archive_id` to the row that holds the real bytes.
`content_sha256` and `raw_byte_length` are deliberately never rewritten, so
they keep describing the row's own original full content, which is exactly
what `export_archive` reproduces.

Real sample, archive id 22422: `raw_byte_length` 433,494; its own blob
decompresses to **0 bytes**; the chain walk returns **433,494 bytes** whose
sha256 is the recorded one. Twelve of twelve sampled rows had that identical
shape. The sentinel decompresses cleanly, which is why "they all decompress
fine" was true and proved nothing.

## The cross-tab that explains the population

The mismatch set is exactly the superseded set.

| superseded | growth_kind | dedupe_kind | n | naive fail | chain fail |
|---|---|---|---|---|---|
| no | initial | - | 19,173 | 0 | 0 |
| yes | initial | content_duplicate | 2,578 | 2,561 | 0 |
| yes | append | - | 944 | 944 | 0 |
| no | append | - | 367 | 0 | 0 |
| yes | initial | - | 367 | 367 | 0 |

3,889 rows carry `superseded_by_archive_id`. 3,872 fail the naive check. The
residual 17 all have `raw_byte_length` 0 and `content_sha256`
`e3b0c442...` (sha256 of the empty string): their true content genuinely was
empty, so the empty sentinel hashes correct by coincidence. That is the whole
gap, which is what turns the correlation into a mechanism.

Re-measured 2026-09-16 the population has grown and the gap has not moved:
4,100 superseded, 4,083 naive failures, **the same 17** empty-content rows
between them. A residual that stays fixed at 17 while the corpus grows by 286
rows is the mechanism reproducing, not a coincidence holding.

Supersession chains reach depth 262 on the most-appended transcript.

### `parent_archive_id` is not the correlate

It was reported as one. It is not: the naive failure rate is 16.86 percent
where `parent_archive_id` is set (3,158 of 18,734) and 15.21 percent where it
is null (714 of 4,695). `parent_archive_id` is the subagent **rooting**
pointer. The column that explains everything is `superseded_by_archive_id`,
a different column with a similar name.

## Nothing is lost

Zero rows are unrecoverable. 23,429 of 23,429 reconstruct to their recorded
sha256 and their recorded byte length through `export_archive`'s chain walk.
No broken pointer, no cycle, no undecompressable blob anywhere in the table.

## The byte-exact pass rate, against real files on disk

Every row, grouped by `source_path` so each file is read once.

2026-09-16, all 23,715 rows:

| outcome vs the file on disk | n | share |
|---|---|---|
| `byte_identical` | 19,666 | 82.9 percent |
| `prefix_of_source` | 1,525 | 6.4 percent |
| `mismatch` | **0** | 0 percent |
| `could_not_evaluate` | 2,524 | 10.6 percent |

(2026-09-14, 23,429 rows: 19,591 / 1,314 / 0 / 2,524.)

`prefix_of_source` is the **correct** verdict for a superseded row: the row is
a snapshot of the file as it was at that ingest and the file has grown since.
1,311 of the 1,314 are superseded rows. The other 3 are head-of-chain rows
whose file grew after the last ingest pass (ids 23391, 23423, 23429; grew by
175 KB, 76 KB and 57 KB; file mtime newer than `ingested_at` in all three).
That is live lag, not a defect.

`could_not_evaluate` is 2,524 rows whose transcript was **deleted** from
`~/.claude/projects`. The project directory survives under the alternate cwd
spelling for 2,496 of them, but the `.jsonl` file itself exists for 0 of them.
There is no disk ground truth left to compare against, so they are neither a
pass nor a failure. The archive is the only remaining copy of those
conversations, which is the archive doing its job.

**So the number the resume feature can promise: of the 21,191 rows where disk
ground truth still exists, 21,191 reproduce the bytes they claim to hold, and
0 mismatch. Of all 23,715 rows, 23,715 are self-consistent.**

### Why the old "400 of 400" was narrower than it looked

`scripts/transcript-archive/corpus_roundtrip_harness.py` re-ingests files from
disk into a **throwaway** database, one at a time. It never imports
`transcript_prefix_dedupe` or `transcript_content_dedupe` (grep count: 0), so
every row it creates has `superseded_by_archive_id` NULL by construction. Its
result is real, and it covers single-copy ingest and export only. It never
touched the live archive and could not have exercised a supersession chain.
The bias was not in the fixture's `WHERE` clause; it was that the harness
cannot build the shape it was thought to be missing.

## Is it still happening

Yes, and it is supposed to. 83 rows ingested in the 24 hours to 2026-09-14,
all 83 self-consistent, 0 mismatch. Re-measured 2026-09-16, now in
`cloude-archive.db`: 113 rows in the preceding 24 hours, most recent ingest
15:44:04Z, and the whole-population pass minutes later still reported 0
mismatch. Growth-dedupe is a shipped, working feature, so superseded rows with
a sentinel blob keep appearing. There is no live defect to prioritise.

## The refusal condition an implementer codes against

A resume writer must reconstruct through
`src.core.transcript_archive.export_archive(conn, archive_id)` and never read
`content_gzip` directly. Then, before writing a single byte:

```python
recon = export_archive(conn, archive_id)          # raises LookupError/ValueError/zlib.error
ok = (hashlib.sha256(recon).hexdigest() == row["content_sha256"]
      and len(recon) == row["raw_byte_length"])
```

- `ok` is False, or `export_archive` raised: **REFUSE**. This is a measured
  absence of a correct reconstruction and it is safe to act on.
- The row could not be read at all (no row, database unavailable): this is
  `could_not_evaluate`, not a refusal verdict about the content. Report it as
  "could not check", never as "the transcript is bad".
- The source file being missing from `~/.claude/projects` is **not** a refusal
  condition. 2,524 rows are in that state and every one of them is sound; that
  is what the archive exists for.

Both halves of the check are load-bearing. A length check alone misses a
flipped bit; a hash check alone passes an empty reconstruction against an
empty-content row. The negative control is in the script's `--self-test`.

## Separate finding: the export route reads a DIFFERENT store

**This section carried a reading that has since expired, and the correction
is the point.** On 2026-09-14 `message_transcripts` held **0 rows**, and this
document said so. Re-measured 2026-09-16 it holds **19,615**, beside
2,592,167 `message_bodies` and 1,440,713 `message_content_blocks`: the
message projection has run since. "The export route reads an empty table" is
no longer true and must not be quoted.

What IS still true is the part that matters to an implementer.
`src/api/archive_export_routes.py` and `src/core/archive_export.py` read
`message_transcripts` and re-serialize line by line rather than
decompressing. The whole `/archive` explorer surface (`archive_hierarchy`,
`archive_lines`, `archive_merged_tree`, `archive_project_names`) reads that
same table. `transcript_archives` is a **separate store with its own id
space**, and nothing in this document's verification says anything about the
projected one: 19,615 projected transcripts against 23,715 archive rows are
not the same population, and an id from one is meaningless in the other.

So the warning stands with its reason replaced. An implementer reaching for
the existing export endpoint gets a different store and a different id space,
not the byte-exact reconstruction verified here. That reconstruction is
`transcript_archive.export_archive`, and it is the only reader this document
makes any promise about.
