# The byte-exact archive API, and the id space it is addressed by

`GET /api/v1/archive/archives/*` serves `transcript_archives`: the
original transcript file, byte for byte. It is a different store from
`/api/v1/archive/transcripts/*`, which serves the parsed message model.

## Two stores, two jobs

| | `/archive/transcripts/{id}` | `/archive/archives/{archive_uuid}` |
|---|---|---|
| table | `message_transcripts` | `transcript_archives` |
| content | parsed, indexed, searchable | one gzip blob, original bytes |
| id | integer primary key | `archive_uuid`, canonical uuid |
| export | re-serialized line by line | pure decompress, chain-walked |
| memory | bounded, streams | O(raw_byte_length), fully resident |

Neither may be repointed at the other's table. The parsed model cannot
promise the original bytes; the archive cannot answer a query about a
message block. `message_transcripts` held 0 rows when this surface was
written and a corpus drain is populating it, so **its emptiness is not
the argument for anything here** - the argument is that the two stores
are authoritative for different things.

## The id space, and what a wrong id does

Both tables are `INTEGER PRIMARY KEY` and, since the archive split, both
live in `cloude-archive.db`. Measured 2026-09-14: archive ids run
1..23475 contiguously, and `message_transcripts` will number from 1 too.
So an integer is ambiguous **by construction**, and resolving one
implicitly returns a real transcript that is the wrong transcript.

The archive is therefore addressed by `archive_uuid`, which is
`TEXT NOT NULL UNIQUE` and canonical 36-character form on all 23,475
rows. A uuid cannot be an integer primary key, so the wrong id is
unrepresentable rather than merely detected.

| you pass | you get |
|---|---|
| a canonical `archive_uuid` that exists | `200`, the bytes |
| a canonical `archive_uuid` that does not | `404` `not_found` |
| an **integer** | `409`, naming BOTH id spaces; when it is a live archive rowid the response carries `meta.archive_uuid` and a `retry_href` |
| anything else | `400`, "not a canonical archive_uuid" |

`GET /archive/archives/by-rowid/{n}` is the **explicit** exchange for a
caller that genuinely holds an archive rowid. It is a separate route
rather than a fallback, because a fallback would be guessing which store
an integer came from.

The message model's own `404` now names the table it searched and links
that exchange route, so a caller holding the wrong id learns why rather
than only that nothing was found.

## Reconstruction, and the refusal rule

Content is reconstructed through
`src.core.transcript_archive.export_archive`, **never** by reading
`content_gzip`. 3,924 of 23,475 rows (16.7 percent) hold the 8-byte
`zlib.compress(b"", 9)` sentinel because their bytes live forward along
`superseded_by_archive_id`; their `content_sha256` and `raw_byte_length`
deliberately still describe the row's own full content. Chains reach
depth **267**. Those rows are not corrupt.

Before a byte is sent, **both** halves are compared:

```python
ok = (sha256(recon).hexdigest() == row["content_sha256"]
      and len(recon) == row["raw_byte_length"])
```

Length alone misses a flipped bit; hash alone passes an empty
reconstruction against a genuinely empty row (17 such rows exist).

| outcome | status | meaning |
|---|---|---|
| verified | `200` | bytes, with `X-Archive-Content-Sha256` |
| no such row | `404` | a measurement |
| chain does not resolve | `422` `chain_broken` | a DEFECT, kept out of the 404 so it cannot hide |
| corrupt blob or cycle | `422` `reconstruction_failed` | a refusal |
| hash or length disagree | `422` `integrity_mismatch` | a refusal, both actual values reported |
| above the ceiling | `413` | not a statement about the content |
| datastore would not open | `200` `cannot_determine` | we could not look |

**A missing source file in `~/.claude/projects` is not a refusal
condition** and is never consulted. 2,524 rows are in that state and
every one is sound; holding the only copy is the archive doing its job.

## Size, memory, and what is not promised

The largest row in the corpus is 244,117,661 bytes. `export_archive`
returns `bytes`, so a reconstruction is **fully resident** - there is no
bounded-memory form, and none is advertised. `X-Archive-Memory-Model`
says `fully_resident_then_chunked`: delivery is chunked only so the ASGI
layer does not hold a second copy.

A constant-memory export would need an incremental chain-aware
decompressor, which is a **second reconstruction path** that can silently
disagree with the one verified across all 23,475 rows. It is deliberately
not built. The ceiling (`ARCHIVE_EXPORT_MAX_BYTES`, 256 MiB) and the
concurrency bound (`MAX_CONCURRENT_ARCHIVE_EXPORTS`, 2) are what keep the
cost survivable instead.

`GET /archive/archives/{archive_uuid}` returns metadata without
reconstructing anything, so a caller can read `raw_byte_length` and
decide before requesting 244 MB.

## The event loop

Every database touch runs in `asyncio.to_thread`. Measured with
`scripts/transcript-archive/measure_export_loop_gap.py`, live archive
read-only, 5 ms heartbeat:

| row | on the loop | threaded |
|---|---|---|
| 244 MB, no chain | 392.4 ms max gap | 3.5 ms |
| 92 KB, depth 267 | 28.0 ms max gap | 1.3 ms |

The second row is the one worth noticing: 92 KB costs 28 ms because the
walk issues one `SELECT` per link. A deep chain is expensive in round
trips, not in bytes.
