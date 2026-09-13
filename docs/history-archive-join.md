# The two-store join: what was decided, what it cost, and what is left

This closes section 2.0 of `docs/history-archive-scope.md`, which ended with
an open caveat: "Before committing to Fix B, an implementation agent must map
every column the 22 modules read onto something the archive layer can answer,
and name what it cannot." That map has now been taken. It is what decided this.

Everything below was measured on `cloude.db.bak-v25-20260910T154341Z`, opened
read-only and immutable. The live `cloude.db` was never opened for writing and
no test points at it.

## What was chosen: project the archive INTO the message model

`src/core/message_projection.py` reads `transcript_archives` and writes the
v16 `message_*` tables. The 22 reader modules are unchanged. The client is
unchanged. The route shapes do not move.

## Why Fix B (repoint the readers at the archive) was rejected

Not on taste. On the column map the scope asked for.

`transcript_records` carries exactly `line_no`, `byte_offset`, `byte_length`,
`status`, `record_type`, `record_uuid`, `parent_uuid`, `ts`. **It carries no
content at all.** The file's bytes exist only inside `transcript_archives.
content_gzip`, one zlib blob per file, 3.70 GB of them.

What the readers need, by grep rather than by memory:

| the reader | what it reads | can the archive answer it |
|---|---|---|
| `archive_search.py:118` | `INSTR(b.body_json, needle)` | no, without gunzipping 3.70 GB per query |
| `archive_turns.py:128-134` | joins to `message_roles`, `message_models`, `message_record_types`, `message_compact_subtypes` | no, none of those dimensions exist |
| `archive_turn_blocks.py:97` | `message_content_blocks` text, tool_name, tool_use_id, is_error | no |
| `archive_body.py:216` | `message_secret_findings` | no |
| `archive_lines.py:380` | `envelope_json`, `key_order_json`, `serializer_style`, `fidelity_outcome`, `is_sidechain`, `agent_id` | no |
| `archive_hierarchy.py:84-155` | `message_hosts` / `message_corpora` / `message_projects` | no |

So Fix B is not a wiring change. It is "re-derive the whole normalised layer as
a query over gzip blobs", which is building a second message model while
deleting the first. The scope's own suspicion that "the honest answer is a
third thing" was right in shape and the third thing turns out to be the join,
not a view: a view cannot manufacture a column its base tables do not hold.

## How the growth objection is answered without reversing anything

The recorded objection, verbatim from `corpus_ingest_service.py`: the model
"has no re-ingest path for a file that GREW - `ingest_lines` refuses a
`source_ref` it has already seen, deliberately, so that nothing is ever
silently overwritten".

That objection is true **of reading the filesystem**, which is what every
existing message-model entry point does. Reading the archive inherits a
problem the archive layer already solved:

- growth is classified, not guessed: `growth_kind` is `initial` (21,979 rows)
  or `append` (849);
- each version is its own immutable row, and the older one is marked
  `superseded_by_archive_id` (3,427 rows), its blob pruned to an 8-byte
  sentinel;
- **among the 19,401 rows with no superseding row, `source_path` is unique
  19,401 times out of 19,401.** One current archive per file, exactly.

So the current archive set is already a clean one-row-per-file snapshot, and
`ingest_lines` keeps its refusal with its original wording. A file whose bytes
changed is handled one level up, by `message_projection_ledger`: it records the
`content_sha256` each stored transcript was derived from, and a replace fires
only when the archive layer itself measured a different one. A recorded
replacement driven by somebody else's measurement is not a silent overwrite.

Fix C (give the model its own re-ingest path) is still rejected, for the reason
the scope gave.

## The cost, measured rather than estimated

300 real archives sampled from the corpus, projected into a throwaway database:

| | |
|---|---|
| raw bytes projected | 169,333,023 |
| wall clock | 202.65 s, i.e. **0.84 MB/s** |
| of which decompression | 0.23 s |
| database size / raw bytes | **1.50x** |
| fidelity | 50,832 of 50,832 lines `fidelity_verified`, 0 raw lines stored |

The cost is JSON parsing and the model's own per-line round trip, not IO.

Extrapolated to the full current set (19,401 archives, 10.25 GiB raw):
**about 3.7 hours of CPU and about 15.4 GiB added** to a database already at
5.2 GB. That is an extrapolation and says so wherever it is printed.

**That number is the strongest argument yet for the owner's own question,
"we can separate the database out?"** It is deliberately NOT answered here.

## What ships, and what a first run does

- The background pass runs after each ingest, on `asyncio.to_thread`, bounded
  by `CLOUDE_MESSAGE_PROJECTION_MAX_ARCHIVES` (64) and
  `..._MAX_SECONDS` (30). Steady state is a handful of files and a few seconds.
- The first-run drain is `scripts/project_archive_to_message_model.py`,
  **dry run by default**, which prints the backlog and both extrapolated costs
  against the caller's own rows before it writes anything.
- `GET /corpus/status` gains a `projection` block saying whether the join has
  ever run here and how much is pending. `model_not_populated` stays exactly as
  it was; this is the half it could not say.

## Left for the migration step, named rather than implied

1. **A replace orphans bodies.** `message_bodies` are interned and shared, so
   the delete cascades only to appearances. Bounded (849 append rows in the
   whole corpus) and not collected. A GC pass is its own change with its own
   claim to prove.
2. **No `superseded` back-projection.** Historical versions are not browsable
   and their blobs are pruned upstream anyway.
3. **The search JOIN gap** recorded at `archive_search.py:107` is untouched.
4. **Search at 22,828 transcripts is still unmeasured** (scope 2.3), and it
   cannot be measured until a corpus of that size is actually in the model.
   This is the change that makes that measurement possible.
5. **Nothing under `web/src` knows the archive exists** (scope 2.7). Unchanged.
