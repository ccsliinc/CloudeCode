# Archiving transcripts that did not come from `~/.claude/projects`

`transcript_archives.source_path` is CORPUS-RELATIVE by convention:
`<slug>/<uuid>.jsonl`, with `~/.claude/projects` as an implicit root that
lives nowhere in the row. That is fine while every row shares the root.
It stops being fine the first time a transcript arrives from somewhere
else, which happened on 2026-09-17.

## The rule

**A transcript from another corpus is stored with its TRUE ABSOLUTE
original path in `source_path`.** No file is ever moved or copied into
`~/.claude/projects` to make the scanner pick it up, because that files it
under a provenance it never had, and this archive has already paid for one
class of wrong path (the cwd-spelling split, gotcha 6 in `CLAUDE.md`).

The leading slash is the whole encoding, and it needs no new column.
Measured on the live archive immediately before the first such ingest,
**0 of 24,577 rows began with `/`**. An absolute path therefore declares
its own root and cannot be misread as relative. The column is
`TEXT NOT NULL` with no CHECK, and `ingest_transcript_bytes` documents it
as "informational provenance only, never authoritative for rooting", so
this is the column used as specified rather than stretched.

## What it costs, and why each cost is the guard working

Two helpers assume the relative shape. Both REFUSE an absolute path
rather than answering wrongly, which is the right failure and is still a
gap a reader has to know about.

* `transcript_corpus_ingest._derive_parent_source_path` tests
  `parts[2] == 'subagents'`, anchored at the START of the path, which an
  absolute path can never satisfy. Structural subagent rooting therefore
  does not fire, and those rows would stay `unrooted`.
  `scripts/transcript-archive/ingest_foreign_corpus.py` roots them
  explicitly through `root_archive`, which takes the parent from its
  caller by design, keyed on the same fact the ingester would have used:
  the file sits in a `subagents/` directory under its session's uuid. The
  decision is recorded in `transcript_root_decisions` with a `decided_by`
  naming the pass, so the audit trail never implies the structural
  ingester resolved it.
* `transcript_restore_target.compose_target` returns `None` for any
  `source_path` starting with `/` (`ESCAPES_CORPUS_ROOT`). That guard
  exists to stop a restore writing outside the corpus, and these files
  genuinely are not in it, so refusing is correct. The consequence is that
  `scripts/restore_transcript.py` cannot place these rows on its own; a
  caller that wants one on disk passes the destination to
  `write_transcript` directly. **Reconstruction is unaffected**:
  `export_archive` is a pure decompress and does not consult
  `source_path` at all, which is the half the byte-exactness promise rests
  on.

Neither the corpus ingester nor its idempotency key can collide with
these rows: `ingest_corpus` composes relative paths only, so it can never
produce a leading-slash `source_path` and can never supersede one.

## The tool

`scripts/transcript-archive/ingest_foreign_corpus.py`. DRY RUN BY
DEFAULT. It builds a manifest by hashing the files on disk FIRST, so the
post-ingest round trip compares against a reading rather than an
assumption, then constructs `CorpusEntry` values and calls `ingest_one`,
so prefix dedupe, content dedupe, the `(source_path, content_sha256)`
idempotency key and the per-line record index all still apply. Nothing is
hand-written into the tables.

```
ingest_foreign_corpus.py --build-manifest --tree <recovered> \
    --origin-root "<absolute original root>" --manifest m.json
ingest_foreign_corpus.py --manifest m.json           # dry run
ingest_foreign_corpus.py --manifest m.json --apply   # write + round trip
```

Take a `VACUUM INTO` backup of the archive first and OPEN IT to confirm
its row count before writing. Never open the live archive with
`immutable=1`: it is written by a running ingester, and an immutable open
of a live WAL database has already produced a segfault and a phantom
17-row reading on this machine.

## First use: Claude Desktop local agent mode, 2026-09-17

14 transcripts recovered byte-exact from an old NAS snapshot
(`multihost.db`), originally at
`~/Library/Application Support/Claude/local-agent-mode-sessions`, a
directory that no longer exists on this machine. 10,847,594 bytes,
10 distinct file stems, dated 2026-02-12 to 2026-06-17. Archive ids
24578 to 24591 inclusive, contiguous.

Row counts: 24,577 archives / 12,347,111 records before, 24,591 /
12,352,382 after. Delta `+14` archives and `+5,271` records, and 5,271 is
the exact sum of the 14 rows' own `record_count`. The 24,577 pre-existing
rows were re-counted after the write and are untouched. Note the brief
quotes 24,573: that was a reading taken minutes earlier, and the running
corpus ingester added 4 rows of its own in between. Re-measure the
"before" immediately before writing rather than quoting an older figure.

Kinds are structural, from location alone: 10 `session` (5 desktop
`audit.jsonl` conversation logs, plus 5 Claude Code session transcripts
written inside the desktop sandbox) and 4 `subagent` under
`<uuid>/subagents/`. No third kind was needed, so nothing was forced into
the two the CHECK constraint allows.

**The origin was corroborated, not assumed.** 5 of the 14 sit under a
Claude Code project directory whose slug independently spells
`-Users-jsugamele-Library-Application-Support-Claude-local-agent-mode-sessions-...`,
written by Claude Code itself from its own literal cwd at the time. 4
more (the `practical-magical-goldberg` tree) carry the slug
`-sessions-practical-magical-goldberg` and a recorded `cwd` of
`/sessions/practical-magical-goldberg`, which is the path INSIDE the
desktop sandbox, not on the host; that names a different thing and
contradicts nothing. The 5 `audit.jsonl` files make no path claim at all.
Zero contradictions across 14 files.

Verification, all three passes 14/14: sha256 and byte length against the
files on disk before the write; `export_archive` re-hashed and compared
byte-for-byte against those same files after it; and an end-to-end
restore through `transcript_restore_write.write_transcript` into a
staging tree, whose read-back hash matched and whose files `cmp` reports
identical to the recovered originals.

| archive id | kind | bytes | sha256 (first 16) |
|---|---|---|---|
| 24578 | subagent | 27,860 | `f1069fe552a4d9c2` |
| 24579 | session | 4,018,056 | `5d83d001b9d89d6e` |
| 24580 | session | 4,116,311 | `65e8ebb592beab98` |
| 24581 | subagent | 296,467 | `4bcd839870c57e47` |
| 24582 | subagent | 151,159 | `2b01be69427d861e` |
| 24583 | subagent | 227,694 | `ed9da7260a267e7b` |
| 24584 | session | 485,305 | `08749c0e211e7879` |
| 24585 | session | 1,034,000 | `c21f8842c7e9e300` |
| 24586 | session | 132,827 | `f39ef104def7ee2c` |
| 24587 | session | 96,611 | `06fe9e25adbd0dc8` |
| 24588 | session | 41,222 | `b40913d3e19c273f` |
| 24589 | session | 30,068 | `f83fcb26ce01fa46` |
| 24590 | session | 103,716 | `299e18ad803ed000` |
| 24591 | session | 86,298 | `bf93b53b58fdb639` |

The 4 subagent rows are `rooted` to their parent session archive (24578
to 24579; 24581, 24582 and 24583 to 24584). The 10 session rows are
`unrooted`, which is the honest default: nothing on this machine records
which app session they belonged to, and 2,969 pre-existing rows are in
the same state. Nothing guessed a root.
