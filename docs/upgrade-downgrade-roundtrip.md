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

### Not measured

Session metadata continuity across the downgrade. v0.8.1 has no
`get_state_dir` and reads `session_metadata.json` from `LOG_DIRECTORY`,
while the new version writes it into the state directory with a fallback
read from the old location. The harness runs with zero live sessions, so
this is CANNOT DETERMINE, not "fine". `cloude.db` itself is inert to the
old version - it lives in a directory v0.8.1 never opens, and step 04
started cleanly with it present.
