"""Schema definition for cloude.db - DDL, version constant, table names.

This module is pure data. It holds no connection logic, no migration
driver, and no I/O, so it can be imported by a test, a CLI entry point,
or a documentation generator without touching the filesystem.

SCOPE OF SCHEMA v1. Three tables:

  ``meta``            key/value scalars, including ``schema_version``.
  ``migration_trail`` the queryable MIRROR of migration_trail.jsonl.
  ``projects``        one row per project root (design doc section 3.2).
                       Added in build step S3. ``config.json`` stays
                       authoritative for writes; this table shadows it
                       and is read by src/core/project_store.py and the
                       GET /projects/presence route.

SCOPE OF SCHEMA v2. One more table:

  ``sessions``        one row per session (design doc section 3.3).
                       Added in build step S4, as its OWN additive step
                       (v1 -> v2) rather than folded into v1, because by
                       the time it was written v1 had shipped WITH a
                       reader: src/core/project_store.py and the
                       GET /projects/presence route both depend on it.
                       That is the exact condition that closes v1 to
                       further edits.

``projects`` was folded into v1 rather than opening a v2 migration
because, at the time it was added, schema v1 had shipped with no reader
depending on it yet (confirmed against HEAD before this table was
added) - the same condition db_migration.py's docstring already treats
as the bar for "still extendable". Sessions and everything else in
section 3.3 remain deferred to their own additive steps; this file's
job is still to grow ADDITIVELY, never to retype what shipped before.

ADDITIVE ONLY. Every future step may CREATE a table, CREATE an index, or
ALTER TABLE ADD COLUMN. No step may ever drop, rename or retype anything.
A step must inspect ``sqlite_master`` / ``PRAGMA table_info`` before it
acts so that re-running it after an interrupted attempt is a no-op rather
than an error - see src/core/db_migration.py.
"""

from __future__ import annotations

from typing import Tuple

# The schema version this code knows how to produce and read.
#
# Bumping this REQUIRES adding a matching _step_vN_to_vM function to
# src/core/db_migration.py's STEPS table in the same commit. The two are
# cross-checked by a test, because a bumped constant with no step is a
# database that can never reach the version the code demands.
CURRENT_SCHEMA_VERSION: int = 4

# meta keys this schema version defines. Listed so a reader does not have
# to grep for string literals to learn what can be in the table.
META_SCHEMA_VERSION = "schema_version"
META_CREATED_AT = "created_at"
META_INSTALL_ID = "install_id"

# Recognised values for migration_trail.kind. 'code' entries are written
# by scripts/upgrade.sh and scripts/rollback.sh, not by the app, which is
# what makes the trail unified rather than two parallel histories.
TRAIL_KINDS: Tuple[str, ...] = ("bootstrap", "config", "schema", "import", "code")

# meta keys the S3 config-projects import stage reads and writes. Named
# exactly per design section 3.1's DDL comment so a later step (S4-S7,
# which imports sessions/themes/unread state) can extend the SAME flag
# rather than invent a second "have we imported yet" marker.
META_IMPORTED_FROM_JSON_AT = "imported_from_json_at"
META_IMPORTED_FROM_JSON_RESULT = "imported_from_json_result"

# projects.source - where a row came from. 'config_import' is written
# once, at first run, by src/core/project_store.py's import step.
# 'adoption' is reserved for the client/js/launchpad.js:953-973 side
# effect (design section 3.2); not written by anything in this step.
PROJECT_SOURCE_CONFIG_IMPORT = "config_import"
PROJECT_SOURCE_USER = "user"
PROJECT_SOURCE_ADOPTION = "adoption"
PROJECT_SOURCES: Tuple[str, ...] = (
    PROJECT_SOURCE_CONFIG_IMPORT,
    PROJECT_SOURCE_USER,
    PROJECT_SOURCE_ADOPTION,
)

# projects.presence - the four-state model, design section 4.1. 'missing'
# and 'unreachable' must never collapse into each other: the first means
# a positively-absent entry (ENOENT, parent readable), the second means
# the probe could not tell (EACCES, EPERM, ELOOP, ENOTDIR, an unmounted
# volume, or a stat that timed out). See src/core/project_presence.py.
PROJECT_PRESENCE_PRESENT = "present"
PROJECT_PRESENCE_MISSING = "missing"
PROJECT_PRESENCE_UNREACHABLE = "unreachable"
PROJECT_PRESENCE_UNCHECKED = "unchecked"
PROJECT_PRESENCE_STATES: Tuple[str, ...] = (
    PROJECT_PRESENCE_PRESENT,
    PROJECT_PRESENCE_MISSING,
    PROJECT_PRESENCE_UNREACHABLE,
    PROJECT_PRESENCE_UNCHECKED,
)

# Recognised values for migration_trail.status. Exactly two of these
# CLOSE an entry in the normal path; 'interrupted' closes one that was
# never closed by the process that opened it.
TRAIL_STATUS_STARTED = "started"
TRAIL_STATUS_COMPLETED = "completed"
TRAIL_STATUS_FAILED = "failed"
TRAIL_STATUS_INTERRUPTED = "interrupted"
TRAIL_STATUS_COMPLETED_AFTER_INTERRUPT = "completed_after_interrupt"

TRAIL_STATUSES: Tuple[str, ...] = (
    TRAIL_STATUS_STARTED,
    TRAIL_STATUS_COMPLETED,
    TRAIL_STATUS_FAILED,
    TRAIL_STATUS_INTERRUPTED,
    TRAIL_STATUS_COMPLETED_AFTER_INTERRUPT,
)

# A status that ends the life of the entry_uuid it names. Anything with a
# 'started' line and no line in this set is an INTERRUPTED step: the
# process died between announcing the work and recording its outcome.
TRAIL_CLOSING_STATUSES: Tuple[str, ...] = (
    TRAIL_STATUS_COMPLETED,
    TRAIL_STATUS_FAILED,
    TRAIL_STATUS_INTERRUPTED,
    TRAIL_STATUS_COMPLETED_AFTER_INTERRUPT,
)


# --- sessions (schema v2, design section 3.3) ------------------------------

# sessions.origin - REPLACES the in-memory ``owned_tmux_sessions`` set as
# the source of truth for "is this session ours". Three values, and the
# split between the first two is deliberately kept in the column even
# though the row badge collapses them (design section 4.6, decided
# 2026-08-17):
#
#   created   the app ran ``tmux new-session`` for it.
#   adopted   the user claimed a session the app did not start. Written
#             ONCE and never recomputed. NOT written by the S4 import -
#             past adoptions were never persisted anywhere, so importing
#             one would be inventing a fact.
#   observed  a session on our socket we have seen and never claimed.
#             The ONLY value that renders as external on a row.
SESSION_ORIGIN_CREATED = "created"
SESSION_ORIGIN_ADOPTED = "adopted"
SESSION_ORIGIN_OBSERVED = "observed"
SESSION_ORIGINS: Tuple[str, ...] = (
    SESSION_ORIGIN_CREATED,
    SESSION_ORIGIN_ADOPTED,
    SESSION_ORIGIN_OBSERVED,
)

# The origins that badge as OURS. Both, per 4.6 - an adopted session
# becomes ours for good. Kept as a tuple so no call site re-spells the
# membership test and drifts from the others; the badge was already
# hand-repaired across three sites once.
SESSION_OWNED_ORIGINS: Tuple[str, ...] = (
    SESSION_ORIGIN_CREATED,
    SESSION_ORIGIN_ADOPTED,
)

# sessions.lifecycle - design section 4.2. 'unknown' is a FIRST-CLASS
# state, not a flavour of 'stopped': it means the probe did not answer,
# and a row in it offers NO lifecycle actions. Collapsing it into
# 'stopped' is the false-green that made a broken tmux render as
# "everything stopped" with a RESTART button that could not work.
SESSION_LIFECYCLE_RUNNING = "running"
SESSION_LIFECYCLE_STOPPED = "stopped"
SESSION_LIFECYCLE_UNKNOWN = "unknown"
SESSION_LIFECYCLES: Tuple[str, ...] = (
    SESSION_LIFECYCLE_RUNNING,
    SESSION_LIFECYCLE_STOPPED,
    SESSION_LIFECYCLE_UNKNOWN,
)

# sessions.lifecycle_source - which measurement produced ``lifecycle``.
SESSION_LIFECYCLE_SOURCE_TMUX_LIST = "tmux_list"
SESSION_LIFECYCLE_SOURCE_PROBE_FAILED = "probe_failed"
SESSION_LIFECYCLE_SOURCE_TMUX_MISSING = "tmux_missing"
SESSION_LIFECYCLE_SOURCE_IMPORT = "import"

# sessions.project_attribution - design section 3.3 / 5.3 step 7.
# 'none' and 'unknown' are NOT the same answer and must never collapse:
# 'none' means we probed the working directory and it matched no known
# project root; 'unknown' means we could not read the working directory
# at all. Only 'unknown' lands the row in NEEDS ATTENTION, because only
# 'unknown' is a measurement we failed to take.
SESSION_ATTRIBUTION_EXPLICIT = "explicit"
SESSION_ATTRIBUTION_DERIVED_DEEPEST = "derived_deepest"
SESSION_ATTRIBUTION_NONE = "none"
SESSION_ATTRIBUTION_UNKNOWN = "unknown"
SESSION_ATTRIBUTIONS: Tuple[str, ...] = (
    SESSION_ATTRIBUTION_EXPLICIT,
    SESSION_ATTRIBUTION_DERIVED_DEEPEST,
    SESSION_ATTRIBUTION_NONE,
    SESSION_ATTRIBUTION_UNKNOWN,
)

# sessions.agent_family_source - how ``agent_family`` was resolved. An
# unresolved family renders as UNKNOWN and NEVER as 'claude', even though
# agent_families.DEFAULT_FAMILY is the right LAUNCH fallback. Launch
# fallback and display truth are different questions.
SESSION_FAMILY_SOURCE_WRAPPER = "wrapper"
SESSION_FAMILY_SOURCE_RESERVED_NAME = "reserved_name"
SESSION_FAMILY_SOURCE_FINGERPRINT = "fingerprint"
SESSION_FAMILY_SOURCE_UNKNOWN = "unknown"

# The socket every session row defaults to. Stored per row rather than
# assumed globally because the instance identity triple starts with it.
DEFAULT_TMUX_SOCKET = "cloude"

# meta key recording the SESSIONS half of the first-run import when it
# could not run. Separate from META_IMPORTED_FROM_JSON_AT on purpose:
# the latch says the import COMPLETED, this says why a given attempt did
# not, and a reader must never infer one from the other.
META_SESSION_IMPORT_PENDING_REASON = "session_import_pending_reason"

# --- DDL ------------------------------------------------------------------

DDL_META = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
"""

# from_version / to_version are TEXT, not INTEGER, and that is not an
# oversight: a kind='code' entry's version is a git tag or semver string
# ("v0.8.2"), while a kind='schema' entry's is an integer. Widening the
# column is strictly better than forcing one type to serve both and
# parsing it back out at every read.
DDL_MIGRATION_TRAIL = """
CREATE TABLE IF NOT EXISTS migration_trail (
  id               INTEGER PRIMARY KEY,
  entry_uuid       TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL,
  from_version     TEXT,
  to_version       TEXT,
  status           TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  completed_at     TEXT,
  backup_path      TEXT,
  backup_verified  INTEGER,
  app_version      TEXT,
  error            TEXT,
  detail           TEXT
)
"""

DDL_MIGRATION_TRAIL_KIND_INDEX = (
    "CREATE INDEX IF NOT EXISTS ix_migration_trail_kind "
    "ON migration_trail (kind)"
)

# projects - design section 3.2, verbatim except for the IF NOT EXISTS
# idempotence guard every step in this file carries. Column notes:
#
#   root      - identity. Path(raw_path).expanduser() normalised, NEVER
#               resolve() - see src/core/project_store.py's
#               normalize_root(), which is the one place this
#               normalisation happens. UNIQUE because the root IS the
#               project; a second config.json entry for the same root
#               is a duplicate, not a second project (see 3.2's dedupe
#               rule and project_store.import_from_config()).
#   raw_path  - the user's string, verbatim, never normalised.
#   presence  - default 'unchecked' (PROJECT_PRESENCE_UNCHECKED, see
#               above) because a freshly-imported row has not been
#               probed by this process yet - 'unchecked' is its own
#               state, not a stand-in for 'present'.
DDL_PROJECTS = """
CREATE TABLE IF NOT EXISTS projects (
  id                  INTEGER PRIMARY KEY,
  root                TEXT NOT NULL UNIQUE,
  raw_path            TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  description         TEXT,
  default_agent_type  TEXT,
  source              TEXT NOT NULL,
  presence            TEXT NOT NULL DEFAULT 'unchecked',
  presence_checked_at TEXT,
  presence_detail     TEXT,
  archived_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
)
"""

# Ordered DDL for a v0 (empty file) -> v1 database. Kept as a tuple so
# _step_v0_to_v1 is a loop over declarations rather than a wall of
# inline SQL, and so a test can assert the exact set of objects v1
# creates without re-parsing the migration driver.
DDL_V1: Tuple[str, ...] = (
    DDL_META,
    DDL_MIGRATION_TRAIL,
    DDL_MIGRATION_TRAIL_KIND_INDEX,
    DDL_PROJECTS,
)

# What a REVERSE of v0 -> v1 would run. Recorded per section 5.1's
# "a REVERSAL_SQL block written down alongside" rule. It is NOT wired to
# any UI in this step: reversing to v0 means having no database at all,
# for which deleting the file is both simpler and exactly equivalent. It
# is written down so the idiom exists for step 2, which will need it.
REVERSAL_SQL_V1: Tuple[str, ...] = (
    "DROP TABLE IF EXISTS projects",
    "DROP INDEX IF EXISTS ix_migration_trail_kind",
    "DROP TABLE IF EXISTS migration_trail",
    "DROP TABLE IF EXISTS meta",
)


# sessions - design section 3.3, verbatim except the IF NOT EXISTS
# idempotence guard. See the column notes above DDL_SESSIONS_INSTANCE_INDEX
# for why the identity story is split between two columns and an index.
DDL_SESSIONS = """
CREATE TABLE IF NOT EXISTS sessions (
  id                    INTEGER PRIMARY KEY,
  session_uuid          TEXT NOT NULL UNIQUE,

  project_id            INTEGER REFERENCES projects(id),
  project_attribution   TEXT NOT NULL DEFAULT 'unknown',
  working_dir           TEXT,

  tmux_socket           TEXT NOT NULL DEFAULT 'cloude',
  tmux_name             TEXT,
  tmux_created_epoch    INTEGER,

  origin                TEXT NOT NULL,
  adopted_at            TEXT,
  legacy_session_id     TEXT,

  agent_type            TEXT,
  agent_family          TEXT,
  agent_family_source   TEXT NOT NULL DEFAULT 'unknown',
  model                 TEXT,

  claude_session_uuid   TEXT,
  parent_session_id     INTEGER REFERENCES sessions(id),
  fork_kind             TEXT,

  lifecycle             TEXT NOT NULL DEFAULT 'unknown',
  lifecycle_checked_at  TEXT,
  lifecycle_source      TEXT,
  last_seen_running_at  TEXT,

  archived_at           TEXT,
  pinned_theme          TEXT,
  audio_enabled         INTEGER,
  unread_auto           INTEGER NOT NULL DEFAULT 0,
  unread_manual         INTEGER NOT NULL DEFAULT 0,
  title                 TEXT,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
)
"""

# THE MOST LOAD-BEARING OBJECT IN THIS SCHEMA, and it costs one integer.
#
# A tmux NAME is not an identity: names are reusable, and the app itself
# re-mints them with a -2/-3 uniquifier. The TMUX INSTANCE is
# (tmux_socket, tmux_name, tmux_created_epoch), where the epoch is
# ``#{session_created}``.
#
# Without the epoch in the key, a session that died and had its name
# taken by a new one would MATCH the old row, and an UPDATE meant for the
# session the user adopted would land on a stranger's process - the user
# then sees a session badged as his that he never claimed. With the epoch
# in the key, the new instance simply does not match, so no statement
# touches the old row: it gets its own row, origin='observed', and the
# old row keeps its adoption history and falls to 'stopped'.
#
# PARTIAL INDEX. The WHERE clause is required, not cosmetic. A session
# row is allowed to exist with no tmux instance at all (an imported
# stopped session from session_metadata.json has no live name/epoch pair,
# design 5.3 step 5). SQLite treats every NULL as distinct in a UNIQUE
# index, so those rows would not collide anyway - but stating the
# predicate makes the index describe exactly the rows it is an identity
# for, and keeps it out of the way of the rows it is not.
DDL_SESSIONS_INSTANCE_INDEX = (
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_tmux_instance "
    "ON sessions (tmux_socket, tmux_name, tmux_created_epoch) "
    "WHERE tmux_name IS NOT NULL AND tmux_created_epoch IS NOT NULL"
)

DDL_SESSIONS_PROJECT_INDEX = (
    "CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions (project_id)"
)

DDL_SESSIONS_LIFECYCLE_INDEX = (
    "CREATE INDEX IF NOT EXISTS ix_sessions_lifecycle ON sessions (lifecycle)"
)

DDL_SESSIONS_PARENT_INDEX = (
    "CREATE INDEX IF NOT EXISTS ix_sessions_parent "
    "ON sessions (parent_session_id) WHERE parent_session_id IS NOT NULL"
)

# Ordered DDL for a v1 -> v2 database. Additive only: one CREATE TABLE
# and four CREATE INDEX, every one guarded by IF NOT EXISTS so a re-run
# after an interrupted attempt finishes the rest and no-ops on the done.
DDL_V2: Tuple[str, ...] = (
    DDL_SESSIONS,
    DDL_SESSIONS_INSTANCE_INDEX,
    DDL_SESSIONS_PROJECT_INDEX,
    DDL_SESSIONS_LIFECYCLE_INDEX,
    DDL_SESSIONS_PARENT_INDEX,
)

# ---- schema v3: the session-id discriminator -------------------------------
#
# WHY A NEW VERSION RATHER THAN AN EDIT TO v2. v2 has shipped and has
# readers. Redefining it in place would leave any file already at v2
# describing a schema the code no longer expects, with nothing to detect
# the difference. So this is its own additive step, per this module's
# additive-only rule.
#
# WHAT IT ADDS, AND WHAT IT DELIBERATELY DOES NOT. One nullable column:
# ``tmux_session_id``, tmux's ``#{session_id}`` (``$0``, ``$1``, ...).
#
# THE IDENTITY KEY IS UNCHANGED. ux_sessions_tmux_instance still keys on
# (tmux_socket, tmux_name, tmux_created_epoch) and this step does not
# touch it. That is a decision, not an omission, and it cuts against the
# obvious reading that session_id is "the real identity":
#
#   session_id is unique per SERVER LIFETIME and restarts at $0 when the
#   server does. $3 today and $3 after a reboot are DIFFERENT sessions
#   with the same id. As a durable key stored on disk it is therefore
#   strictly WORSE than the creation epoch, which does not repeat.
#
#   It is strictly BETTER at separating two sessions that exist at the
#   same moment, which is the one thing a one-second epoch cannot do.
#
# So it is stored as a DISCRIMINATOR, never as a key: it can only ever
# cause a merge to be REFUSED (the stored row names a different live
# session than the one in front of us), never cause one to be accepted.
# A refusal on bad evidence costs one row; an acceptance on bad evidence
# hands one session's history and ownership badge to a stranger. The
# asymmetry decides which way an uncertain answer must fall.
#
# NULLABLE ON PURPOSE. Every row written before this column existed has
# NULL here, and NULL means "not recorded", never "different". The
# refusal fires only when BOTH sides carry an id and they disagree.
DDL_SESSIONS_ADD_SESSION_ID = (
    "ALTER TABLE sessions ADD COLUMN tmux_session_id TEXT"
)

#: Ordered DDL for a v2 -> v3 database. ALTER TABLE ADD COLUMN has no
#: IF NOT EXISTS in SQLite, so the step in db_steps.py inspects
#: PRAGMA table_info first; that inspection is what makes this idempotent,
#: not the statement itself.
DDL_V3: Tuple[str, ...] = (DDL_SESSIONS_ADD_SESSION_ID,)

#: SQLite cannot drop a column without rebuilding the table, and this
#: module is additive-only, so a REVERSE of v2 -> v3 is a RESTORE from the
#: verified backup rather than a statement. Stated as an empty tuple with
#: this comment rather than omitted, so the absence is a decision on the
#: record and not a gap someone fills in later with a DROP.
REVERSAL_SQL_V3: Tuple[str, ...] = ()

# --- v3 -> v4: projects.last_opened_at ------------------------------------
#
# WHY A COLUMN AND NOT A REUSE OF updated_at. feat/db-is-authoritative
# makes the projects table the source of truth for the launcher's project
# list, and that list is ordered most-recently-used first - the behaviour
# config.json got from its array order plus the old
# ``move_project_to_top``. The table had no field that could carry it.
#
# ``updated_at`` cannot: GET /projects/presence re-stats every root on
# every call and writes the result back, so updated_at is touched on a
# plain page load and would sort the list by "last probed" while claiming
# to sort it by "last opened".
#
# NULLABLE ON PURPOSE, and NULL means "never opened in this build", never
# "opened at the epoch". Rows imported from config.json carry NULL and
# fall back to their insert order, which IS the config array order, which
# was the user's MRU order - so the very first render after this
# migration shows exactly the order the old code showed.
DDL_PROJECTS_ADD_LAST_OPENED_AT = (
    "ALTER TABLE projects ADD COLUMN last_opened_at TEXT"
)

#: Ordered DDL for a v3 -> v4 database. Purely additive, one nullable
#: column, no index. As with v3, ALTER TABLE ADD COLUMN has no
#: IF NOT EXISTS, so the step inspects PRAGMA table_info first.
DDL_V4: Tuple[str, ...] = (DDL_PROJECTS_ADD_LAST_OPENED_AT,)

#: Same reasoning as REVERSAL_SQL_V3: additive-only forward, RESTORE
#: backward. Stated explicitly so the absence is a decision, not a gap.
REVERSAL_SQL_V4: Tuple[str, ...] = ()


# What a REVERSE of v1 -> v2 would run. Dropping the table drops its
# indexes with it; the index drops are listed anyway so the block reads
# as the exact inverse of DDL_V2 rather than relying on a side effect.
REVERSAL_SQL_V2: Tuple[str, ...] = (
    "DROP INDEX IF EXISTS ix_sessions_parent",
    "DROP INDEX IF EXISTS ix_sessions_lifecycle",
    "DROP INDEX IF EXISTS ix_sessions_project",
    "DROP INDEX IF EXISTS ux_sessions_tmux_instance",
    "DROP TABLE IF EXISTS sessions",
)

# Columns a REVERSE of each step permanently destroys, keyed by the
# to_version it undoes. Used to generate the typed-confirmation text in
# section 9.5 ("permanently deletes the values stored in: ..."), which
# must name the real columns rather than a static string. v1 drops whole
# tables rather than columns, so its entry names the tables.
REVERSAL_DESTROYS: dict = {
    1: (
        "meta (whole table)",
        "migration_trail (whole table)",
        "projects (whole table)",
    ),
    2: ("sessions (whole table)",),
    3: ("sessions.tmux_session_id",),
}
