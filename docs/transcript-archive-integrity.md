# Transcript archive integrity: the 16.5 percent that is not corrupt

Measured 2026-09-14 against the live `cloude.db`
(`~/Library/Application Support/CloudeCode/cloude.db`, 5.2 GB) read-only,
whole population, no sampling. Re-run it with
`scripts/transcript-archive/verify_archive_integrity.py`.

## The answer

The 3,872 rows that fail a `sha256(content_gzip)` check are **not corrupt**.
They are superseded rows, and the check is asking the wrong question. Every
one of them reconstructs byte-exactly.

| measurement | value |
|---|---|
| rows in `transcript_archives` | 23,429 (23,440 an hour later; the ingester is live) |
| fail `sha256(zlib.decompress(row.content_gzip)) == row.content_sha256` | 3,872 (16.53 percent) |
| fail `sha256(export_archive(row)) == row.content_sha256` | **0** |
| broken chains, cycles, zlib errors | 0 |
| `mismatch` against the real file in `~/.claude/projects` | **0** |

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

| outcome vs the file on disk | n | share |
|---|---|---|
| `byte_identical` | 19,591 | 83.6 percent |
| `prefix_of_source` | 1,314 | 5.6 percent |
| `mismatch` | **0** | 0 percent |
| `could_not_evaluate` | 2,524 | 10.8 percent |

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

**So the number the resume feature can promise: of the 20,905 rows where disk
ground truth still exists, 20,905 reproduce the bytes they claim to hold, and
0 mismatch. Of all 23,429 rows, 23,429 are self-consistent.**

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
all 83 self-consistent, 0 mismatch; the most recent superseding ingest landed
at 13:22:45Z. Growth-dedupe is a shipped, working feature, so superseded rows
with a sentinel blob keep appearing. There is no live defect to prioritise.

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

## Separate finding: the shipped export route reads an empty table

`src/api/archive_export_routes.py` and `src/core/archive_export.py` read
`message_transcripts`, which holds **0 rows** on live, and re-serialize line
by line rather than decompressing. The whole `/archive` explorer surface
(`archive_hierarchy`, `archive_lines`, `archive_merged_tree`,
`archive_project_names`) reads the same empty table. `transcript_archives`,
which holds all 23,440 byte-exact rows, has **no HTTP surface at all**.

An implementer reaching for the existing export endpoint gets the wrong store
and a different id space. The reconstruction verified in this document is
`transcript_archive.export_archive`, which is called today only from
`verify_against_source` and from the dedupe modules themselves.

---

## Two corrections added when this file was committed, 2026-09-14

This document was written on 2026-09-14 and sat UNTRACKED in the main working
copy (on the stale `release/1.2.1` branch) until it was committed here. Two of
its statements have moved since it was written, and neither invalidates the
measurement.

**The "no HTTP surface at all" paragraph is now branch-true, not true.**
`feat/173-archive-http-surface` (`0439526`) added
`GET /archive/archives/{archive_uuid}` and `src/api/archive_blob_routes.py`,
which serve exactly the reconstruction this document verifies. That branch is
NOT deployed: `src/api/archive_blob_routes.py` is absent from the derived
server copy at
`~/Library/Application Support/cloude-code-menubar/server/`, measured
2026-09-14. So the paragraph is still true of the RUNNING install and is no
longer true of the code. See `docs/archive-blob-api.md` on that branch.

**The chain depth figure moves because the table is live.** This document
records depth 262; `docs/archive-blob-api.md` records 267, measured later the
same day. Both are correct readings of a table the ingester is still writing
to. Neither is the number to quote without re-measuring.

**Its companion script is still untracked.**
`scripts/transcript-archive/verify_archive_integrity.py` exists only in the
main working copy and in no git object. Anything that re-runs this measurement
needs it. Committing it was deliberately left to whoever owns `scripts/**`,
because an agent was working there when this file was rescued.
