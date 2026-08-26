# Upgrading CloudeCode with Claude

You are running Claude Code. So is everyone else who uses this. That makes
the upgrade something you can hand to an agent rather than perform by hand,
and this file is what the agent follows.

    /upgrade            in a Claude Code session opened on this checkout

or, in plain words to Claude: "upgrade CloudeCode and confirm the data
migrated." The slash command lives at `.claude/commands/upgrade.md` and does
nothing more than point at this document.

This covers the **from-source install** (README "Path B"): a git checkout with
its own `venv/`, `.env` and `config.json`. The packaged `.app` has no in-place
upgrader; a new version there means a new DMG dragged over `/Applications`.

---

## The rule this whole document exists to enforce

**An upgrade that reports success is not the same as an upgrade that worked,
and a database that opens is not the same as a database that kept your data.**

Every check below has THREE outcomes, never two: it passed, it failed, or it
could not be evaluated. The third is not a flavour of the first. If a step
cannot be measured, say so and stop; do not write "looks fine".

This is not abstract caution. `src/core/db.py::get_schema_version` carries a
warning in its own docstring about a real incident in this codebase: it
collapses "no version recorded" and "a version that will not parse" onto the
same `0`, and that collapse let a populated nine-project database migrate with
**zero backups taken**, recorded in the trail as a clean bootstrap from an
empty file. The number looked like a measurement. It was two different facts
wearing one hat.

---

## Step 1: capture the baseline BEFORE touching anything

You cannot verify a migration without a before. This is the step people skip
and the reason "did it work?" is usually unanswerable afterwards.

```bash
./scripts/upgrade-baseline.sh
```

That writes a timestamped JSON snapshot under `.upgrade-baselines/` holding the
current version, the schema version as a three-outcome read, and a row count
for every table in `cloude.db`. Read it back; do not just trust that it ran.

If the script reports it could not read the database, **stop**. An upgrade you
cannot verify is one you should not start.

## Step 2: upgrade

```bash
./scripts/upgrade.sh              # newest published release tag
./scripts/upgrade.sh 1.0.7        # a specific tag
```

`upgrade.sh` refuses any tag that is not a real published release tag on the
remote, so you cannot typo your way onto an untagged commit. It takes its own
backup into `.upgrade-backups/<timestamp>_from-X_to-Y/` before it changes
anything, with a `.manifest` recording, per file, whether it was backed up or
legitimately not present yet.

**Read the manifest.** A backup that quietly skipped a file is the thing that
turns a bad upgrade into a lost one.

## Step 3: verify the data actually migrated

```bash
./scripts/upgrade-verify.sh
```

It compares the live database against the newest baseline and reports each of
these separately, with its own verdict:

| Check | Passes when | Cannot determine when |
|---|---|---|
| schema version | reads as an int and is >= the baseline's | absent, or present and unparseable |
| code schema version | matches `CURRENT_SCHEMA_VERSION` | the module will not import |
| row counts | no table lost rows | a table is missing from either side |
| migration trail | this run's entry exists and is `ok` | no entry for this run |
| served version | the running server reports the new version | the server is not answering |

**A schema version that did not change is not a failure.** Most upgrades ship
no migration. Between v1.0.5 and v1.0.7 the schema stayed at 9 and that was
correct. What would be a failure is the version going BACKWARDS, or row counts
dropping, or a trail entry that says anything other than `ok`.

### Verify the running server by CONTENT, not by claim

`git rev-parse` on either side only reads back the claim the deploy already
believes. It is not an independent measurement. Fetch an asset over HTTP from
the running server and hash it against the git blob that exists only in the new
commit:

```bash
curl -fsS http://127.0.0.1:8000/static/js/app.js | shasum -a 256
git show <new-tag>:client/js/app.js | shasum -a 256
```

Two identical hashes prove the server is serving the new code. Note that
`index.html` will NOT match its blob, because the server substitutes
`{{VERSION}}` into it; diff it and confirm the only delta is that substitution
rather than abandoning the check.

### If nothing looks different in your browser

A tab left open across a restart does not re-fetch static assets on its own. It
keeps polling its API endpoints and keeps its WebSocket alive while running
arbitrarily old JavaScript. Before looking for a server-side cause, hard-reload
the page. If you want to be sure, look in the access log for a static-asset
request from your own address AFTER the restart timestamp; if there is none,
the fix is the reload, not the server.

## Step 4: if it went wrong

```bash
./scripts/rollback.sh
```

Restores from the newest `.upgrade-backups/` entry. Nothing in that directory
is ever deleted automatically.

Downgrading is supported by design: the config model is declared
`extra="ignore"`, so a config written by a newer version loads cleanly in an
older one, with the fields it does not know about carried through untouched
rather than rejected. The database is a different question. A schema that moved
forward will not move back on its own, which is exactly why step 1 exists.

---

## What Claude should report back

Not "upgraded successfully". Report the measurements:

```
version        0.9.0 -> 1.0.7
schema         9 -> 9  (no migration on this path, expected)
rows           projects 9 -> 9, sessions 14 -> 14, migration_trail 3 -> 4
trail entry    kind=code from=0.9.0 to=1.0.7 status=ok
served asset   sha256 match against 1.0.7 blob
backup         .upgrade-backups/20260826T191455Z_from-0.9.0_to-1.0.7 (manifest complete)
```

and, if anything could not be evaluated, say which check and why, in those
words. "Could not determine whether the served asset matches: the server was
not answering on 8000" is a useful sentence. A blank line is not.
