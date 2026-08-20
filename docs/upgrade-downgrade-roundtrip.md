# Can the old version be dropped back in?

Measured 2026-08-20 by executing the round trip, not by reading the
migration's own promises. Re-run it with:

```
./scripts/ci/roundtrip-upgrade-downgrade.sh
```

Everything happens in a throwaway work directory. The script clones the
repo rather than checking anything out in place, points `CLOUDE_STATE_DIR`
at its own directory, binds a port before using it, and never touches a
real install.

## Which "old"

`v0.8.1` (2026-08-04) - the newest published release tag, and the last one
that predates BOTH `src/core/config_migration.py` and the datastore. It is
an ancestor of `integration/ui-only`, so the trip is a real fast-forward
and back. It is also what a user dropping back to "the last release"
actually gets.

## Verdict

The plain round trip works. The old version starts, reads the migrated
`config.json`, and sees every project. Three qualifications, all measured,
all reproducible by the harness:

### 1. The migration is additive, as documented

`config.json` across the upgrade: `config_version` and `terminal_commands`
ADDED, `common_slash_commands` gained `/login` appended as a bare string.
Nothing removed, nothing rewritten. The old version ignores the two new
top-level keys (`AuthConfig` inherits pydantic's default `extra="ignore"`)
and every old write path is a raw-dict round trip
(`save_project`, `delete_project`, `update_project`, `move_project_to_top`,
`add_provider_model`, `remove_provider_model`), so a downgraded install
writing the config back out PRESERVES the new version's keys. Measured:
after the old version added a project to the migrated config, the only key
that changed was `projects`.

### 2. An object-form slash entry is a hard downgrade break

`AuthConfig.common_slash_commands` is `List[str]` at v0.8.1 and
`List[Union[str, Dict[str, Any]]]` on the new tip. One object-form entry -
a shape the new version accepts - makes the old version's
`load_auth_config` raise a `ValidationError` and the server exit with
`Application startup failed`. Not a degraded mode: it does not start.

The config migration does NOT introduce this shape (it appends bare
strings), so a pure upgrade leaves the config downgrade-safe. Anything
that later writes an object entry does not.

Guarded by step 08 of the harness, which is DECLARED to fail. If that step
ever starts passing, the guard has stopped measuring anything.

### 3. Re-upgrade silently drops a project created during the downgrade

The one real data loss, and it is silent. The projects table is
authoritative on the new tip (`src/core/project_authority.py`), and
`run_first_run_import` is gated on `meta.imported_from_json_at`, which is
stamped once. So:

1. downgrade, old version writes a new project into `config.json`;
2. re-upgrade - no re-import, the table still has the old row set;
3. `projects_service.current_view` reports `mode: db`, `degraded: False`,
   and serves the table. The project is invisible with no banner;
4. the first project write in the new version calls `snapshot_projects`,
   which replaces `config.json`'s `projects` key wholesale from the table.
   The project is now gone from the file too.

Steps 1 through 4 were executed; step 4 was run directly against the
harness's own state dir and observed to delete the entry.

### 4. There is no "this config is newer than I understand" check

`migrate_config_dict` compares `existing_version >= CURRENT_CONFIG_VERSION`
and returns unchanged. Handed `config_version: 99` it returns
`changed=False` and leaves the 99 in place - no refusal, no warning. In
practice that means a config written by a FUTURE version is treated as
already-current by this one, and whatever migration that future version
would have needed never runs. Contrast `src/core/db_version_gate.py`,
which does exactly this check for the database.

### 5. Session metadata does NOT survive the round trip

Measured 2026-08-20. This was the previous run's one CANNOT DETERMINE
step; it is now a real step, and the answer is **ABSENT**.

`v0.8.1` reads `session_metadata.json` from `LOG_DIRECTORY` and nowhere
else. The current version resolves it through
`Settings._resolve_state_file()`, which prefers the state directory and
falls back to the old location. Both sides of every assertion below run
the version's OWN code: the old side is `v0.8.1`'s real
`get_session_metadata_path`, read out of the tag and compiled at run
time, not a paraphrase of it.

**The upgrade alone is safe.** With the file only at `LOG_DIRECTORY`,
the resolver returns the old path for reads AND writes. The new version
loaded the seeded session, rehydrated it against the live tmux session,
and kept writing to the old location. A user who upgrades and does
nothing else can drop back to `v0.8.1` and lose nothing.

**One ordinary action moves the file, permanently.**
`SessionManager.detach_session` unlinks the RESOLVED metadata path and
then, when another session is still live, calls
`_save_session_metadata()` - which re-resolves. After the unlink the old
location no longer exists, so the resolver returns the NEW path and the
file MOVES to the state directory. Nothing copies it back.
`_clear_stale_metadata` has the same shape, so a startup that finds the
persisted session's tmux slug gone does it too. Measured end to end:
after the detach sequence the state dir holds the metadata and
`LOG_DIRECTORY` holds only `refresh_tokens.db`.

**What the user loses on the downgrade.** `v0.8.1` starts clean and logs
`no_existing_session_metadata`. Gone with the file: the
most-recently-active session's id, its working directory, its agent type
and its pinned theme, plus `owned_tmux_sessions` - the set that tells the
app which tmux sessions are ITS OWN. The tmux sessions themselves keep
running; the old version no longer claims them, so they present as
strangers to be re-adopted rather than as the user's own sessions.

**Stale is possible too, and it is worse.** When the file exists in BOTH
places the resolver prefers the new one, logs
`state_file_present_in_both_locations`, and leaves the old copy on disk
untouched forever. A downgrade then rehydrates a session that is no
longer the live one - a wrong answer rather than a missing one, and
nothing on screen says so. **And the project's own rollback tool relocates the file too.** Measured,
not read: `take_backup()` in
`scripts/upgrade_lib/upgrade_rollback_common.sh` finds
`session_metadata.json` at `LOG_DIRECTORY`, says so
(`found at the pre-feat/state-directory location ... backing up from
there`), and `restore_backup()` then places it at `resolve_state_dir()` -
the NEW directory - because it restores every state file there
regardless of where it was backed up FROM. After a real
take-then-restore cycle `LOG_DIRECTORY` was EMPTY and the state dir held
both `session_metadata.json` and `refresh_tokens.db`. So `rollback.sh`,
the thing a user runs specifically to go back, is itself a step that
makes the old version unable to find its state. Guarded by
`test_rollback_relocates_state_files_out_of_the_old_location`, which runs
the two real bash functions.

If the old file survives instead of being moved - a partial restore, a
hand copy - the both-present case applies and the old copy is the stale
twin.

The unit-level version of all of this is
`tests/test_session_meta_continuity.py` (7 tests, no tmux, runs in the
normal suite). The end-to-end version is the `meta-*` steps of the
harness, which write the metadata with the OLD install's code, run the
NEW version's real detach sequence, and read the result back with the
OLD version's own resolver.

The harness step DECLARES `ABSENT` (`artifacts/meta.expect`), the same
way step 08 declares FAIL. If a fix lands, the step goes UNEXPECTED and
someone reads it rather than the guard quietly agreeing with whatever it
finds.

### Two traps that manufactured this finding three times before it was real

Both produced a clean, plausible ABSENT out of the fixture rather than
the product, and both are guarded now.

`TmuxBackend.discover_existing()` lists only `cloude_`-prefixed names,
and the reconciler prunes the owned set against exactly that list. Bare
session names read as dead, so the owned set was pruned empty and the
metadata deleted.

The reconciler then builds its backend from `persisted.id` and matches
`cloude_<id>`; it never reads the `tmux_session` field. A persisted id
that is not the bare tmux name gets its metadata deleted as stale before
the relocation path is reached. The harness now reads the upgrade's own
server log and reports CANNOT DETERMINE when it sees
`stale_session_metadata_deleted` without a matching rehydrate, instead of
scoring the rejection as a finding.

### A safety defect in the harness itself

The seed fixture carried `tmux_socket_name: "cloude"` - the socket a real
install runs on, with the user's live work on it. Every server the
harness started reconciled against that socket while the script's header
claimed it touched nothing real. It is now pinned to a per-run throwaway
socket and re-asserted before EVERY server start, not once, because a
later step can rewrite `config.json`.

### Still not measured

Whether the DOWNGRADED old version, once running, writes metadata back to
`LOG_DIRECTORY` in a way the next upgrade then treats as the both-present
ambiguous case. The steps above stop at the read.
