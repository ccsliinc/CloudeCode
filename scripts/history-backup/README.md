# Proving the history backup

A verified, off-box, **restore-proven** backup of everything this machine
knows about your Claude Code history.

```
venv/bin/python3 scripts/history-backup/status.py --remote
```

That is the one command. It answers "when was my history last backed up, and
did it verify", and exits non-zero when the answer is no.

## The division of labour, and why there is only one backup system

**`backup-m4.sh` takes the backup.** It lives in the `docker-management` repo
at `devices/mini-m4/backup-m4.sh`, runs nightly at 03:30 under
`com.jsugamele.backup-m4`, and already backed this machine up before any of
this existed. It now also takes a consistent `VACUUM INTO` dump of the history
archive onto the USB drive and hands it to the restic repository at
`rest://10.0.10.80:8000/mini-m4`.

**This directory proves it can be restored.** Nothing here writes a backup or
touches the repository's contents.

That split was a correction. The first version of this work built a complete
parallel backup system with its own destination, its own retention and its own
schedule. It was the wrong answer. There was already a daily deduplicated
off-box backup of this machine, already in the fleet monitoring, with retention
already enforced on the host that stores the repository. A second half-built
backup system is worse than one well-understood one, and restic's
content-defined chunking means an append-mostly archive costs the delta rather
than 15 GB a night.

What restic does **not** do is notice that it is storing a torn database, and
that is the gap this work actually closes.

## What "everything available" resolved to

| What | Where | Covered |
|---|---|---|
| History archive, about 15 GB | `~/Library/Application Support/CloudeCode/cloude-archive.db` | yes, as a consistent dump |
| Application database, schema v29 | `~/Library/Application Support/CloudeCode/cloude.db` | yes, as a consistent dump |
| The jsonl corpus, 20,442 files, 12 GB | `~/.claude/projects`, really `~/Library/Mobile Documents/com~apple~CloudDocs/Sync/Claude/projects` | yes, through the archive - see below |
| Hook tokens, refresh tokens | same directory | no, deliberately |

### The corpus decision, and the measurement behind it

The archive does not merely index the jsonl corpus. Every row in
`transcript_archives` carries `content_gzip` - the file's original bytes,
gzipped - beside `content_sha256` and `raw_byte_length`. It is a byte-exact
store.

Measured against the live corpus on 2026-09-17 by hashing every live file and
looking its digest up in the archive: **20,442 live jsonl files, 20,438
byte-for-byte present**. The four misses were the transcript of the session
doing the measuring and three of its subagent files, all being appended to at
that instant. The archive holds 22,978 distinct source paths, so it is a
**superset** of the live tree and also carries conversations the tree has since
lost.

Copying the 12 GB tree separately would store the same bytes twice and still
protect strictly less. The risk in that decision is real and is handled rather
than waved at: it makes the backup depend on the archive being
reconstructable, which is exactly why `prove_restore.py` exists.

Credential material is excluded on purpose. `hook_tokens.json` and
`refresh_tokens.db` are regenerable by logging in again, so copying live
credentials to a third location is a cost with no recovery benefit.

## Two SQLite traps this work paid for

**`VACUUM INTO`, never a file copy, and never `immutable=1`.** The ingester
writes continuously; `cp` reads pages over many seconds and captures a torn
file. `immutable=1` tells SQLite a file that is genuinely changing cannot
change, and has already segfaulted a pass on this box.

**A WAL database needs a `-shm` file, and `mode=ro` cannot create one.** The
moment the ingester checkpoints and the `-wal`/`-shm` pair disappears - a
perfectly healthy, fully committed state - every read-only URI connection
starts failing with `SQLITE_CANTOPEN`, and the failure looks exactly like a
missing or unreadable file. Measured on the live archive minutes after the
identical call had succeeded. `snapshot.read_only_connect` falls back to a
normal connection with `PRAGMA query_only = 1`, which SQLite enforces itself.

Related and separate: **`query_only = 1` blocks `VACUUM INTO`**, because SQLite
classifies it as a write statement on the connection even though the only file
it writes is the new destination. The snapshot handle therefore does not set
that pragma. Both were found by running the thing, not by reading about it.

Every dump is switched to `journal_mode = delete` before it is hashed, so what
lands in the repository is **one self-contained file** that opens read-only
anywhere, with no sidecars to carry and none to recreate.

## The `.nobackup` convention

Any file or directory whose name ends in `.nobackup` is excluded from the
backup, anywhere in any source tree. It is for redundant local copies of data
that is already protected: migration rollback points, pre-repair copies,
scratch restores.

**The file declares its own intent, so no backup job has to predict its name.**
That is the whole point, and it comes straight from a real defect:
`backup-m4.sh` excluded rollback copies with the pattern `cloude.db.bak-*`, and
when the history archive grew its own rollbacks they were called
`cloude-archive.db.bak-*` - a different prefix the pattern could not have
anticipated - so 30 GB of near-duplicates shipped off-box nightly with nothing
reporting it.

It rhymes with this repo's existing `.nosync` convention (`venv.nosync`,
`macOS/dist.nosync`), documented beside it in the root `.gitignore`.
`.nobackup` rather than `.norestic` because the reason to skip a redundant
rollback copy has nothing to do with which tool is asking.

- **Emitted by** `src/core/db_backup.py` (`BACKUP_SUFFIX`). Its reader accepts
  both spellings for ever, so pre-convention copies stay recognised by
  retention. `_uniquify` inserts its collision counter **before** the suffix,
  because `...Z.nobackup-2` would match neither the reader's pattern nor any
  exclusion rule - the copy the suffix exists to keep off-box would be the one
  that shipped.
- **Honoured by** `backup-m4.sh`, as `*.nobackup` and `*.nobackup-*`. Two
  patterns, because a WAL database's sidecars are `<db>-wal` and `<db>-shm`.
- **Transition detector**: the job names any rollback-shaped file still missing
  the suffix. The old name patterns are kept until that detector goes quiet,
  which makes the transition finishable instead of forgotten.

## What the proof actually does

`prove_restore.py`, five questions, each able to fail on its own:

1. Does the repository still hold the artifact? `restic snapshots`.
2. Will it give it back? A real `restic restore` onto the USB drive.
3. Is it the same bytes? sha256 against the dump that was handed over. restic
   verifies its own chunk hashes independently, so a match is two mechanisms
   agreeing rather than one.
4. Is it a working database? `integrity_check` and row counts **on the restored
   copy**, never on the original.
5. **Does a real conversation come out of it?** Three are reconstructed - the
   largest row, an ordinary one, and a random one so the proof does not quietly
   become evidence about the same two rows for ever - decompressed, hashed, and
   compared against the **live jsonl file on this Mac**. That last comparison
   is the only one whose expected value does not come out of the backup itself.
   Comparing only against the hash stored in the same row would be one fact
   agreeing with itself.

`restore_proof.py` additionally re-renders transcripts through the real
`src/core/message_model_export.export_transcript`, proving the normalised v16
tables still produce the original bytes. Reported separately; it does not gate
the verdict, because the message model covers a subset of the corpus by design.

## Staging

**`/Volumes/Backup`, the USB drive, 3.9 TiB free. Never the boot volume.**

The boot volume runs about 30 GiB free with the 15 GB live archive on it. A
15 GB `VACUUM INTO` beside it took the machine to 94 percent full on
2026-09-17. Everything of database scale goes to the USB drive, inside
`/Volumes/Backup/cloudecode-history-backup/`, and nothing outside that
subdirectory is touched - the drive is the owner's.

```
cloudecode-history-backup/
  dump/              the nightly artifact, ONE file, the restic source
  restore-proof/     where a proof restores to
  _expired/          superseded copies, moved here and never deleted
  original-scripts/  the pre-edit copy of backup-m4.sh
```

## Retention

**Off-box retention is the restic repository's own** and is not touched here:
the repo is `--append-only`, so a forget or prune from this host returns 403,
and retention runs on the machine that stores it (`restic-local-retention.sh`,
05:00 on qnap-home, 7 daily / 4 weekly / 6 monthly). Inheriting a tested policy
beats inventing a second one.

**Locally** `dump/` holds exactly one file, overwritten in place through a
`.new`-then-rename, so it cannot grow. A failed dump leaves yesterday's
verified artifact in place rather than no artifact.

**Nothing in this work deletes anything.** Superseded copies are moved into
`_expired/`. The owner clears it:

```
rm -rf /Volumes/Backup/cloudecode-history-backup/_expired
```

## How a failure becomes visible

Not by reading a log.

- `backup-m4.sh` exits **1** when any dump is rejected or any artifact is
  missing from the snapshot it just wrote. It verifies the snapshot by name and
  byte count, never by exit code.
- `status.py` exits 0 when the last proof verified, 1 when it did not, 2 when
  that could not be determined, so it drops into the fleet monitoring emergent
  sweep as-is.
- The record's **age** is the signal, reported as `current` / `stale` /
  `never_ran` / `cannot_determine`, because a job that died looks exactly like
  one that had nothing to do.

A refusal is kept apart from a failure throughout. An unplugged USB drive is
`cannot_determine`: nothing was found wrong with anything.

## What this does NOT cover

- **The jsonl corpus as files.** Covered as content, inside the archive,
  re-measured every run. Restoring the raw tree as a tree means going through
  the archive.
- **Credentials.** `hook_tokens.json`, `refresh_tokens.db`. Regenerable.
- **Anything written after the nightly dump.** Worst-case loss is one day.
- **A second destination.** One repository. Time Machine to 10.0.1.202 and the
  USB dump cover the same source independently, but neither is verified this
  way.
