# Archive search, and the body compression it pays for

Two coupled changes, landed together because the second is unsafe without
the first: search moved off substring-scanning `message_bodies.body_json`
and onto an FTS5 index over the broken-out content blocks, and
`body_json` is now compressed per row.

Every number here was measured on 2026-09-13 against the 400-transcript
projection built by the join step (216,716 bodies, 137,168 content
blocks, 443,006 appearances, all `fidelity_verified`). The live
`cloude.db` was never opened for writing. Where something is an
extrapolation it says so.

---

## 1. Why the old search was a correctness defect

`archive_search` matched `INSTR(b.body_json, needle)`, and `body_json` is
the WHOLE jsonl record: `cwd`, `sessionId`, `parentUuid`, `timestamp`,
`gitBranch`, `entrypoint`, `version`, `promptId` and the message
together. So a search for a model name matched the envelope of every
message that model produced.

| needle | bodies by `INSTR` | blocks holding it in message text |
|---|---|---|
| `claude-opus-4` | 33,805 | **165** |
| `"cache_read_input_tokens"` | 91,623 | **30** |
| `msg_01` | 89,837 | **27** |
| `"tool_use_id"` | 38,887 | **28** |

The right-hand column is the answer a human wanted. A miss cost 919 ms
over 755.9 MiB, at 863 MB/s.

---

## 2. What replaced it

**The index narrows, `INSTR` still matches.** FTS5 with `unicode61`
matches TOKENS, so the phrase `"claude-opus-4"` would also match the text
`claude opus 4`, and it cannot give a truthful character offset either.
So the index answers "which blocks could possibly contain this" and
`INSTR` over those blocks' own text answers "and where exactly". Same
matcher as before, same literal semantics, same `case_sensitive`
behaviour, on a haystack 0.001 percent of the size.

**One query for the whole scope, not one per transcript.** The
per-transcript loop the old scan used was measured on the index and it is
the wrong shape: re-running the MATCH per transcript cost 945.8 ms for
`tmux` over 50 transcripts against 15.85 ms for the single query. The
keyset `(ingested_at DESC, id DESC, line_no)` moved into the ORDER BY, so
the result order and the resume cursor are unchanged.

Measured on the largest project here (167 transcripts), page of 50:

| query | before | after |
|---|---|---|
| a miss | 919 ms | **0.02 ms** |
| `"claude-opus-4"` | - | 0.71 ms |
| `resize` | - | 1.80 ms |
| `tmux` (very common) | - | 15.85 ms |

`GET /api/v1/archive/search` end to end, including the secret gate and
the coverage pass, measured 14.26 ms for `claude-opus-4` and 49.5 ms for
`tmux`. A miss is 49 ms, dominated by the coverage pass, which is only
taken on an empty page.

---

## 3. The tokenizer, and the gap it leaves

`unicode61 remove_diacritics 2`, chosen by MEASUREMENT against the
alternative, over the same 112,623 blocks holding 125.1 MiB of text:

| | index size | build | queries |
|---|---|---|---|
| `unicode61` | **51.4 MiB** | 1.80 s | 0.03 to 0.51 ms |
| `trigram` | 332.3 MiB | 13.12 s | 0.72 to 4.13 ms |

Trigram is strictly more capable: it is substring matching, which is what
`INSTR` gave, and on the one query where that shows, `resize`, it found
854 blocks against unicode61's 752. It is still not worth 281 MiB here,
and the reason is specific rather than aesthetic: the other half of this
change saves 358.7 MiB, so trigram would hand back 78 percent of that to
buy substring matching on identifiers. Extrapolated to the full corpus
(19,401 archives, about 48x this sample) trigram is roughly 16 GB of
index on a database already at 5.2 GB, which settles it.

**The trailing `*` is recall, not decoration.** A bare phrase matches
whole tokens, so a query that is the PREFIX of a longer token finds
nothing at all. `msg_01` occurs as a substring in 27 blocks and a bare
phrase returned ZERO of them, because the text holds `msg_01ABC...` and
`unicode61` makes that one token. Recall against a pure substring scan of
the same block text, twelve real queries, bare phrase then prefixed:

| query | bare | prefixed |
|---|---|---|
| `msg_01` | 0.0% | **100.0%** |
| `resize` | 88.1% | 97.0% |
| `the` | 92.6% | 96.7% |
| `tmux -L cloude` | 99.2% | 99.2% |
| `sendResize` | 98.5% | 98.5% |
| `session_manager` | 99.9% | 99.9% |
| `claude-opus-4` | 100.0% | 100.0% |
| `cache_read_input_tokens` | 100.0% | 100.0% |
| `tool_use_id` | 100.0% | 100.0% |
| `respawn-pane -k` | 100.0% | 100.0% |
| `/Users/jsugamele` | 100.0% | 100.0% |
| `SELECT COUNT` | 99.0% | 99.0% |

Eight of the twelve are exact and the worst is 96.7 percent. The cost is
small and one-sided: a query ending in a very short token scans a wide
term range (`claude-opus-4` went 1.4 ms to 11.2 ms, its last token being
`4`); everything else moved by under a millisecond.

**THE GAP THAT REMAINS, NAMED.** A query beginning INSIDE a token cannot
be found: `resize` does not reach `sendResize`. An empty page therefore
carries an `unevaluated` entry saying so, because a user who typed a word
fragment and got nothing is entitled to know that before concluding the
corpus does not hold it.

**A QUERY WITH NO ALPHANUMERIC CHARACTER IS REFUSED.** `...`, `->`, `{}`
produce no token, so the index cannot be asked. The old substring scan
COULD find them, so this is a real loss of capability and it is a named
`cannot_determine` rather than a result of zero hits.

---

## 4. Keeping the index current: triggers, and why

`message_content_blocks.body_id` is `REFERENCES message_bodies(id) ON
DELETE CASCADE`, and the projection DOES delete bodies - a transcript
that grew is replaced. A cascade is invisible to Python: the rows vanish
and nothing calls an updater. A trigger sees it, inside the same
transaction. Verified against a real SQLite: after a cascading delete of
the parent body, the FTS row for its block was gone.

`contentless_delete=1` (SQLite 3.43+, this box runs 3.53.4) is what makes
a plain `DELETE FROM ... WHERE rowid = ?` legal on a contentless table,
and therefore what makes the delete trigger a one-liner instead of a
command that has to re-supply the original text.

**A fresh install needs no rebuild at all.** The triggers are created by
the same schema step that creates the table, so a projection indexes as
it writes. This was NOT the expected result - the first draft of the test
asserted that a projected-but-unbuilt install reports `never_built`, and
it failed because the index was already complete. `rebuild_block_search_index.py`
is only ever needed by an install that already HAD content blocks when it
crossed v27.

What a trigger cannot protect against is being ABSENT, so the status
ladder compares the FTS row count against the block count rather than
assuming agreement.

---

## 5. The two ladders

### Is the index usable

`src/core/message_block_search_status.py`. Five states:

| state | meaning | may return hits |
|---|---|---|
| `missing` | the FTS table is not there | no |
| `never_built` | table present, no rows, blocks exist | no |
| `present` | has rows, coverage NOT counted here | yes |
| `stale` | counts taken and disagree | yes, with the discrepancy named |
| `current` | counts taken and agree | yes |

`missing` and `never_built` REFUSE with `cannot_determine`. Falling back
to the old `INSTR` scan was considered and rejected outright: it would
silently restore the false-positive defect on exactly the installs least
likely to notice.

**`present` exists because counting is not free.** The two `COUNT(*)`
queries behind `current` versus `stale` measured **37.08 ms**, on a
search whose own index query costs 0.07 ms for a miss. So the request
path takes `probe_index_state` (two `LIMIT 1` existence probes, O(1)) and
says it did not count; `GET /api/v1/archive/search/index` takes the exact
measurement, in a thread. A reading that did not happen is not a reading
of nothing.

### What is not covered

36.8 percent of bodies carry no message text at all:

| status | bodies | indexed |
|---|---|---|
| `blocks_extracted` | 129,796 | yes |
| `content_string` | 7,253 | yes |
| `no_message_content` | **79,667** | no, correctly |

Those are attachments, file-history snapshots and titles. What the old
scan found in them was purely envelope metadata. A further 24,545 of the
137,168 blocks carry no text at all (images and documents, whose payload
is bytes and is deliberately not projected).

So `meta.coverage` counts a scope's bodies by WHY each is or is not
searchable, in four named reasons, and the last is the one that matters
most:

- `no_message_content` - measured: legitimately carries no text
- `no_text_projected` - has blocks, none carrying text
- `could_not_evaluate` - `unparseable_body` / `unexpected_content_shape`
- `never_processed` - NO ROW in `message_body_block_status`. The
  extractor has not looked. The result is INCOMPLETE, not empty.

**Measured on an empty page only**, which is a cost decision stated
rather than hidden: the pass is 44.16 ms over the largest project here
and 3.62 ms over one transcript, and a page that RETURNED hits cannot be
mistaken for "there is nothing here". On any other page
`coverage.measured` is False and says why.

---

## 6. What the API gained, and what changed meaning

**Nothing was removed and no key was retyped**, so the client slices are
not gated. Added:

- query parameters `role`, `block_type`, `tool_name`, `is_error`,
  `order` (`position`, the default and the ordering this endpoint has
  always had, or `relevance`, BM25). All optional, all defaulting to the
  previous behaviour.
- `meta.index`, `meta.coverage`, `meta.query.filters`,
  `meta.query.order`, `meta.scan.method`.
- on each hit: `block_id`, `block_seq`, `block_type`, `block_chars`,
  `tool_name`, `is_error`, `role`, `model`, `rank_score`,
  `match_offset_in`.
- a route: `GET /api/v1/archive/search/index`.

**Three things changed MEANING and are named rather than hidden:**

1. **The hit set.** `claude-opus-4` returned 33,805 and now returns 165.
   That is the defect being fixed, and it is still a behaviour change a
   client could notice.
2. **`match_offset` indexes the BLOCK's text**, not `body_json`, and
   `match_offset_in` carries that fact explicitly. Checked before
   shipping: nothing under `client/` reads `match_offset` off a search
   hit (`archive-mask.js` reads `match_offset_utf16` off SECRET FINDINGS,
   a different endpoint, untouched).
3. **The budgets can no longer bind.** One index query covers every
   transcript in scope, so `transcripts_scanned` equals
   `transcripts_in_scope`, `transcripts_not_scanned` is 0, and
   `bytes_scanned` is **0** because no `body_json` was read -
   `scan.method` says `fts_index` so a reader knows why a real number is
   zero. `budget_exhausted` and therefore `result_status: partial` are
   unreachable on this path. The constants stay, because a caller's
   branch on them is still correct and deleting a vocabulary word is a
   shape change; `scan_budget` and `scan_bytes` are still accepted and
   still reported.

---

## 7. Compression

Per-row zlib level 6 on `body_json`, measured over 216,716 real bodies:

| | |
|---|---|
| before | 756.8 MiB |
| after | **398.1 MiB** |
| ratio | **0.526** |
| encode | 56.7 us per body |
| decode | **6.30 us mean** (p50 3.50, p95 11.88, p99 46.83) |

Level 9 reaches 397.8 MiB for 10 percent more CPU and is not worth it;
level 1 stops at 411.5 MiB.

**The row declares its own shape.** `typeof(body_json)` is `'text'` for
the JSON and `'blob'` for the codec's frame. Both are legal forever, a
reader handles both, and the backfill's work queue is literally
`WHERE typeof(body_json) = 'text'` - the work queue IS the data, so an
interrupted run resumes exactly with no ledger table and nothing to
reconcile. **There is no flag day and stopping half way is a supported
state.**

**The 12-byte frame carries the CHARACTER count, and that is because of
the tail.** A zlib stream does not record its output length, so answering
`LENGTH(body_json)` would mean inflating. The largest body here is
12,592,257 characters and inflating it costs **18.55 ms** - and
`archive_body` asks for that length precisely in order to REFUSE to
return a body that big. `cloude_body_chars` reads 12 bytes instead. The
count is CODE POINTS, matching what `LENGTH()` returns for TEXT and what
every existing caller means by `body_chars`.

**Every SQL reader was repointed BEFORE anything is compressed**, which
is what makes this landable in one change: `cloude_body_text` and
`cloude_body_chars` are the identity on a TEXT value, so an install that
never compresses a row behaves exactly as it did. Eleven core call sites
and four scripts. Measured on sqlite 3.53.4, what the UNREPOINTED
spellings answer for a compressed row:

| | answer |
|---|---|
| `LENGTH` | its COMPRESSED byte count - silently wrong |
| `SUBSTR` | a slice of the zlib stream - silently wrong |
| `INSTR` | 0 - silently wrong |
| `json_valid` | 0 - honest |
| `json_extract` | RAISES "malformed JSON" - loud |

So the functions are registered in `src/core/db.connect`, the one place
this app opens `cloude.db`, and a connection that missed them fails a
repointed query with "no such function", which is loud.

**A rewrite is verified before it is written**: the frame is decoded
again and compared to the original, and a mismatch aborts the pass.
`encode_if_smaller` then compares lengths, so a body that does not shrink
stays TEXT rather than growing by the frame header.

**Reconstruction still verifies file-exact.** The same transcript is
exported twice from the same database, once with every body as TEXT and
again after the backfill, and both are compared to each other AND to the
original file's bytes. The storage shape is asserted with `typeof()`
either side, so a backfill that silently did nothing cannot pass.

Net model for this sample: 1,344.9 MiB to about 1,038 MiB, being
-358.7 MiB of body plus 51.4 MiB of index.

---

## 8. Operating it

| operation | entry point |
|---|---|
| build or rebuild the index | `scripts/rebuild_block_search_index.py`, DRY RUN BY DEFAULT |
| compress existing bodies | `scripts/compress_message_bodies.py`, DRY RUN BY DEFAULT |
| ask whether the index is sound | `GET /api/v1/archive/search/index` |

Both scripts exit **2** for could-not-evaluate, which is not 0.
`compress_message_bodies.py` REFUSES outright unless the FTS index
exists, because the column was only stored uncompressed so `INSTR` could
scan it, and compressing on an install whose search still reads it would
blind that search silently.

The index rebuild publishes a liveness record to
`<state_dir>/block-search-index/latest.json` on EVERY terminating path,
failures included, beside `corpus-ingest/` and `db-integrity/` and for
the same reason: a rebuilder that died and one with nothing to do are
otherwise indistinguishable.

`CLOUDE_BODY_COMPRESSION=0` stores new bodies as TEXT. Every reader still
handles them, so turning it off is safe at any moment and needs no
migration back.

---

## 9. Nothing on the event loop, and it is measured

Measured against the real 400-transcript database (1.9 GB), largest loop
gap while the route runs, taken by a watcher coroutine that wants to wake
every millisecond:

| | work | largest loop gap |
|---|---|---|
| `GET /archive/search` | 1208.50 ms | **2.92 ms** |
| `GET /archive/search/index` | 1871.43 ms | **1.36 ms** |
| the same index work ON the loop (control) | 45.18 ms | **46.34 ms** |

The control is load-bearing: without it a box fast enough to make
everything look instantaneous would pass while proving nothing.

**The plan, not the stopwatch, is the regression guard.** An FTS5 MATCH
that stops being driven by the index does not fail, it silently scans, so
`tests/test_block_search_query_plan.py` asserts

```
SCAN f VIRTUAL TABLE INDEX 0:M1
SEARCH cb USING INTEGER PRIMARY KEY (rowid=?)
SEARCH a USING INDEX ix_message_appearances_body (body_id=?)
```

across every filter, scope, order and resume shape the builder can
produce, with a negative control proving the marker can be absent.

---

## 10. Known gaps, recorded rather than implied

1. **A query beginning mid-token is not found.** Section 3. Reported on
   every empty page; closing it needs trigram and its 6.5x index.
2. **A punctuation-only query is refused.** Section 3. The substring scan
   could answer it; this cannot.
3. **`stale` is only ever reported by the status route**, because the
   search path does not count. A search over a partly-built index
   therefore says `present` and returns what it can.
4. **No automatic rebuild.** The index is created by the migration and
   populated by an operator script. A fresh install does not need it
   (section 4); an install upgrading with content blocks already present
   does, and nothing prompts for it yet.
5. **Compression has no background pass.** New bodies compress on write;
   existing ones move only when the script is run.
6. **`VACUUM` is not run** after a backfill. The freed pages are reused
   by the database, but the file does not shrink until an operator
   chooses to spend the time and the free space.
