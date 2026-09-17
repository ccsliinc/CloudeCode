# Is everything in the archive? Both populations, 2026-09-17

`scripts/transcript-archive/verify_archive_integrity.py` asks whether the rows
the archive HAS are sound. This asks the other question: is everything that ever
existed IN it. Run it with

    venv/bin/python3 scripts/transcript-archive/verify_all_conversations.py

Exit 0 all accounted for, 1 a gap with every missing item printed, 2 could not
evaluate. Not having looked is never a pass.

## The verdict right now

    conversations : ever   1355   in archive   1355   missing 0
    subagent runs : ever  19060   in archive  19060   missing 0
    VERDICT: ALL ACCOUNTED FOR, both populations        (exit 0)

Archive at the time of writing: 24,684 rows, 12,436,875 records, 15 GB.

## Subagent runs are in scope, and that reversed a stated limit

The owner's ruling, verbatim: "i also want to confirm all conversations are in
the database. even subagent because the archive viewer is an in depth detailed
viewer."

The census used to record subagent runs as a COUNT per source, on the reasoning
that enumerating about 19,000 of them would make a 450 KB JSON that churns on
every ingest. The coverage is not negotiable, so the churn was solved instead,
by splitting identity from provenance:

| What | Where | Why |
|---|---|---|
| identity, all 19,060 | `subagent_roster.txt` | one stem per line, sorted, no metadata. Only ever grows, so a refresh can only ever ADD lines. |
| provenance, gaps only | `conversation_census.json["subagents"]` | where to find it, size, sha256. A run the archive already holds needs no recovery pointer. |
| drift alarm, per source | `subagent_set_sha256` | 64 bytes that say whether a static source read the same way twice. It cannot name a stem. |

The churn claim is measured, not asserted. A refresh that observes nothing new
changes **0 lines**; a refresh that observes twelve new runs changes **exactly
12**. The old design would have restamped `last_observed` on 19,060 entries
every run.

The roster is append-only and enforces it: `write_roster` writes the UNION and
reports what a shrinking refresh would have dropped, because a smaller reading
means a source failed to open, not that subagent runs stopped existing.

A **missing roster is exit 2, never exit 0**. That is the single most dangerous
way this checker could be wrong: delete one file and 19,000 runs silently stop
being checked while the report stays green. An **empty** roster is different and
is allowed, because a file that was read and held nothing is a real reading of
zero.

## The 76 conversations restored from the NAS

72 from `03-gogs-history-6d8879b.tar.zst`, 3 from
`04-mini-claude-backup-20260106.tar.zst`, 1 from
`06-misc-claude2-and-app-sessions.tar.zst`, plus 5 subagent runs from tarball
04. Deleted from the working tree in December 2025; no live source held them.

Every byte was verified against the tarball's OWN manifest before ingest, not
against a hash recomputed here, which would compare a reading to itself: **83 of
83 members verified, 0 mismatches**, then re-verified after the network transfer.
Two of the 83 are `history.jsonl`, the CLI prompt history file, dropped by
`looks_like_conversation` rather than by a second rule written for this restore.

A pass that used `str.lstrip("./")` to normalise manifest paths reported all
nine members of tarball 04 as "not in manifest". `lstrip` strips every leading
`.` and `/` CHARACTER, so `./.claude-backup-20260106/x` became
`claude-backup-20260106/x`. It reads exactly like a missing manifest and was a
broken reader. `normalise_member` removes one leading `./` and nothing else.

### Provenance is the recovery artifact, and that is a decision

`3ce7bcce` established that a transcript from outside `~/.claude/projects` takes
an ABSOLUTE `source_path`, because a leading slash is self-describing and cannot
be misread as corpus-relative. These take:

    /mnt/ARCHIVE/vault/85_cloud-exports/claude/claude-archive-20260830/
        03-gogs-history-6d8879b.tar.zst#projects/<slug>/<uuid>.jsonl

The original home is knowable for tarball 03 (a git history of `~/.claude` on
this machine) and NOT knowable for 04 and 06, whose members sit under
`.claude-backup-20260106/` and `claude2/` with no record of what contained them.
Writing a real home for one and a guessed home for the others would put
fabricated provenance in the column this project has already been burned by
(gotcha 6). One rule, no guesses. The `#` is deliberately not a `/`: a path that
reads as a directory tree would be a second fiction, since no such directory
exists. `stem_of` still recovers identity from the basename, and
`compose_target` still refuses it as ESCAPES_CORPUS_ROOT, which is correct.

### The legacy subagent layout was the trap

Current Claude Code writes `<session_uuid>/subagents/agent-x.jsonl`, and both
`classify_kind` and `parent_source_path` key on that `subagents/` directory. The
2026-01 backup predates it: the five `agent-*.jsonl` sit FLAT beside their parent
sessions. Structurally they would ingest as `session` kind with no derivable
parent. So kind comes from the stem (`is_subagent`, imported) and the parent from
the file's own `sessionId` record, which is the only thing a flat layout has.
Two name `69eb03c6-...`, three name `bb4ce21e-...`, and both parents are in the
restore set, so all five rooted.

### What the write cost, traced

| | before | after | delta |
|---|---|---|---|
| `transcript_archives` | 24,600 | 24,681 | +81 (76 sessions, 5 subagent runs) |
| `transcript_records` | 12,382,880 | 12,436,875 | +53,995 |
| raw bytes under `/mnt/ARCHIVE/%` | 0 | 453,025,061 | the restored content |

Pre-write backup: `cloude-archive.db.bak-preRESTORE76-20260917T152632Z` in the
state directory, taken with SQLite's online backup API against the live writer,
16,378,740,736 bytes, `PRAGMA integrity_check` = **ok**, 24,600 archives /
12,382,880 records / 36,901,872,368 raw bytes.

Recoverability was proven end to end for all 81, twice: once inside the ingest,
and once afterwards on a FRESH connection, exporting each row and comparing the
sha256 to the NAS manifest's. **81 of 81 byte-identical, 0 mismatches**, 76
sessions plus 5 subagent runs, all 5 rooted to a parent.

## Codex is out of scope on purpose

195 OpenAI Codex CLI conversations under `~/.codex/sessions`. The owner:
"codex is not in scope now. it may be in the future."

That used to be a parenthesis inside a source NAME, `"openai codex CLI sessions
(OUT OF SCOPE)"`, which nothing could query. It is now a structured record in
`census["exclusions"]` carrying the ruling verbatim, an `in_scope` boolean, a
`location`, a `how_to_include_later`, and a count **re-taken on every run** so it
cannot rot. An unreadable source keeps the previously recorded count and is
flagged `reachable: false`, never zeroed. The checker prints it every run under
DELIBERATELY OUT OF SCOPE, so it reads as a decision rather than an oversight,
and turning it on later is a flag plus a reader.

## Trusting a green run

`verify_all_conversations.py --self-test` drives the real code path through a
positive control and eleven negative ones. The positive control is worthless
alone: a function returning "all accounted for" unconditionally passes it.

The six subagent controls were watched RED by mutation before being trusted:

| mutation | controls it killed |
|---|---|
| `verdict_for` ignores `subagent_open_gaps` (the pre-change behaviour) | 3 |
| a missing roster reads as zero instead of refusing | 2 |
| subagent gaps merged into the conversation list | 3 |
| the accepted disposition ignored for subagents | 2 |
| `write_roster` writes only what it just observed | 1 |

Control 5 remains the one that already earned its keep: it caught a printed
verdict and an exit code derived from two different values.
