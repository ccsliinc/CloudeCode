"""cloude.db - connection handling, pragmas, and the meta key/value store.

Hand-rolled on the Python standard library's ``sqlite3``. NOT SQLAlchemy,
and that is a decision, not an omission:

  * The history viewer that was cited as already loading SQLAlchemy into
    the process does not. It ships SQLAlchemy in a SEPARATE
    requirements-history.txt, deliberately kept out of requirements.txt,
    and imports it lazily at request time.
  * Worse, src/core/history_db.py argues its own read-only guarantee
    partly from the fact that nothing else in the app uses SQLAlchemy at
    all. Adding it here would make that safety argument false the day it
    shipped.
  * The v1 schema is two tables whose DDL is fully written down in
    src/core/db_models.py. A hand-rolled repository layer costs less than
    a new runtime dependency plus greenlet.

PRAGMAS, applied to EVERY connection this module hands out:

  journal_mode=WAL   readers never block the writer and vice versa, which
                     matters because the hooks path and the request path
                     both write. WAL is a persistent property of the file
                     (it survives close), but it is re-asserted per
                     connection because asserting it is idempotent and
                     cheap, and assuming it is exactly the kind of
                     unverified inheritance this codebase keeps getting
                     burned by.
  foreign_keys=ON    per connection, NOT persistent, and off by default.
                     A schema with foreign keys and this pragma unset is
                     a schema whose constraints are decorative.
  busy_timeout=30000 30s. Short transactions plus WAL make contention
                     rare; when it happens, waiting beats raising.

WAL AND COPYING. A cp/rsync/tar of a WAL-mode database while a writer is
live produces a file that OPENS CLEANLY and is missing the last commits,
because those commits are in the -wal sidecar the copy did not take. Every
backup in this subsystem goes through VACUUM INTO instead - see
src/core/db_backup.py, which also carries the test proving the two are
distinguishable.
"""

from __future__ import annotations

import sqlite3
import uuid as _uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

import structlog

from src.core.archive_db_attach import (
    assert_no_shadowing,
    archive_sibling_for,
    attach_archive as _attach_archive,
    attached_schemas,
    which_database,
)
from src.core.archive_db_partition import (
    ARCHIVE_SCHEMA,
    archive_db_path_for,
    SIDE_ARCHIVE,
    side_for_table,
)
from src.core.db_models import META_INSTALL_ID, META_SCHEMA_VERSION
from src.core.message_body_codec import register_body_functions

logger = structlog.get_logger()

DB_FILENAME = "cloude.db"

# Applied in this order on every connection. journal_mode returns a row,
# the other two do not; execute() handles both.
CONNECTION_PRAGMAS = (
    "PRAGMA journal_mode=WAL",
    "PRAGMA foreign_keys=ON",
    "PRAGMA busy_timeout=30000",
)


class DatastoreError(RuntimeError):
    """Base class for every failure this package raises.

    Description: a small named hierarchy so callers can distinguish "the
      database is unreadable" from "you may not write in this mode"
      without matching on message text or catching bare Exception.
    Inputs: standard RuntimeError arguments.
    Output: an exception instance.
    """


class ArchiveNotAttachedError(DatastoreError):
    """A question was asked that this connection cannot answer.

    Description: raised when an archive-side table's presence is asked
      of a connection opened with ``attach_archive=False``. It is a
      CALLER BUG, never a fact about the data, and it is loud on
      purpose: the alternative is answering False, which is
      indistinguishable from "the archive holds nothing" and is exactly
      how the corpus drain came to refuse with ``model_absent`` on a
      datastore that held every row of the model.
    Inputs: standard RuntimeError arguments.
    Output: an exception instance.
    """


class DatastoreUnreadableError(DatastoreError):
    """cloude.db could not be opened, or failed PRAGMA integrity_check.

    Description: the COULD-NOT-EVALUATE state for the database itself.
      Raised instead of returning an empty result set, because an empty
      result set from a broken database renders to the user as "you have
      no projects", which is a lie with the same shape as the truth.
    Inputs: message (str), path (Path | None).
    Output: an exception instance carrying ``.path``.
    """

    def __init__(self, message: str, path: Optional[Path] = None) -> None:
        super().__init__(message)
        self.path = path


def db_path_for(state_dir: Path) -> Path:
    """Return the cloude.db path inside a state directory.

    Description: one place that knows the filename, so a test, the CLI
      backup entry point and the migration driver cannot disagree.
    Inputs: state_dir (Path) - as resolved by Settings.get_state_dir().
    Output: Path - state_dir / "cloude.db".
    """
    return Path(state_dir) / DB_FILENAME


def connect(
    path: Path, *, create: bool = True, attach_archive: bool = True,
) -> sqlite3.Connection:
    """Open a connection to cloude.db with this module's pragmas applied.

    Description: uses ``isolation_level=None`` so transactions are
      explicit. The implicit-BEGIN behaviour of the default mode is
      exactly wrong for a migration driver, where the whole point is that
      a chain either commits as one unit or leaves the version unstamped.
    Inputs: path (Path) - the database file. create (bool) - when False,
      a missing file raises rather than being created; use False for any
      read path so a typo'd directory cannot silently manufacture an
      empty database that renders as a healthy install with no data.
      attach_archive (bool) - attach cloude-archive.db when one exists.
      DEFAULT TRUE so nothing changes by accident, but pass False on any
      connection that will not touch an archive table.

      WHY THIS FLAG EXISTS, AND IT IS NOT THE REASON FIRST GIVEN.
      ``BEGIN IMMEDIATE`` ACQUIRES THE WRITE LOCK ON EVERY ATTACHED
      DATABASE, not only on the one the statements touch. So a
      connection that writes a single row to ``sessions`` in cloude.db,
      while holding the archive attached, must wait for whatever is
      writing the archive. Isolated measurement, identical write both
      ways, with another writer holding the attached file: 1.1 ms
      unattached against 3,772.1 ms attached, the difference being
      exactly how long the other writer held its transaction.

      THAT IS NOT ACADEMIC. ``claude_event_hook`` handles Claude Code
      lifecycle hooks SYNCHRONOUSLY ON THE EVENT LOOP and its
      ``_persist_activity_state`` opens one of these connections and
      calls :func:`transaction`. With 19 live panes firing hooks and a
      corpus drain writing the archive, py-spy caught the loop parked in
      ``transaction (db.py) -> _persist_activity_state ->
      record_hook_event -> claude_event_hook``, and the ``/health``
      probe beside it timed out at 30.04 s - which is
      ``busy_timeout=30000`` expiring exactly. The whole UI goes dead
      for that long: no keystrokes, no pane output.

      The FIRST justification offered for this flag was per-connection
      attach cost. That was measured and is real but trivial: 78 opens,
      the number one listing pass makes, cost 24.9 ms attached against
      9.1 ms unattached. It could never have produced a 30 second stall,
      and the flag was nearly abandoned on the strength of it.
    Output: sqlite3.Connection with row_factory set to sqlite3.Row.
    Raises: DatastoreUnreadableError - the file is missing (create=False)
      or sqlite3 refused to open it.
    Example: with closing(connect(db_path_for(state_dir))) as conn: ...
    """
    path = Path(path)
    if not create and not path.exists():
        raise DatastoreUnreadableError(
            f"{path.name} does not exist at {path}", path
        )
    try:
        conn = sqlite3.connect(str(path), isolation_level=None, timeout=30.0)
    except sqlite3.Error as exc:
        raise DatastoreUnreadableError(
            f"could not open {path.name}: {exc}", path
        ) from exc
    conn.row_factory = sqlite3.Row
    try:
        for pragma in CONNECTION_PRAGMAS:
            conn.execute(pragma)
    except sqlite3.Error as exc:
        conn.close()
        raise DatastoreUnreadableError(
            f"could not apply pragmas to {path.name}: {exc}", path
        ) from exc
    # ``message_bodies.body_json`` holds EITHER the JSON text or this
    # module's compressed frame, per row, and SQLite has no inflate. So
    # every reader spells LENGTH(cloude_body_chars(...)) rather than
    # LENGTH(body_json), and those functions have to exist on every
    # connection this app hands out. Registering here - the ONE place
    # cloude.db is opened - is what makes that true without each call
    # site remembering. A connection that somehow missed them fails a
    # repointed query with "no such function", which is LOUD. Measured on
    # sqlite 3.53.4, what the UNREPOINTED spellings do to a compressed
    # row: LENGTH answers its COMPRESSED byte count, SUBSTR cuts the zlib
    # stream, and INSTR answers 0 - all three silently wrong. Only
    # json_extract is loud, raising "malformed JSON", and json_valid
    # honestly answers 0.
    try:
        register_body_functions(conn)
    except sqlite3.Error as exc:
        conn.close()
        raise DatastoreUnreadableError(
            f"could not register the body codec functions on {path.name}: "
            f"{exc}",
            path,
        ) from exc
    # THE ENTIRE ARCHIVE WIRING IS THIS ONE CALL, and it is here for the
    # same reason register_body_functions is: this is the ONE place
    # cloude.db is opened, so attaching here is what makes the archive
    # reachable without each of the 68 archive modules remembering to.
    #
    # No call site needs a schema prefix. MEASURED on sqlite 3.53.4: a
    # table that exists ONLY in an attached database is reached by an
    # unqualified name, for reads AND writes. After the migration drops
    # the archive tables from main, every existing query keeps working
    # and silently reaches the right file.
    #
    # A table present in BOTH is the one dangerous state, because main
    # wins with no error. assert_no_shadowing raises the alarm rather
    # than refusing the connection: the sessions live in this file, and
    # taking a running server down over a condition that only affects
    # archive queries would be the worse failure. The migration refuses
    # hard; this warns loudly. See src/core/archive_db_attach.py.
    if attach_archive and _attach_archive(conn, path):
        assert_no_shadowing(conn)
    return conn


def integrity_check(conn: sqlite3.Connection) -> str:
    """Run PRAGMA main.integrity_check and return its verdict verbatim.

    Description: SQLite returns the single string "ok" when the file is
      sound, and one row per problem otherwise. The rows are joined
      rather than reduced to a boolean so the caller can put the actual
      complaint in front of the user; "integrity check failed" with no
      detail is not actionable.

      THE SCHEMA PREFIX IS LOAD-BEARING, and it is the opposite of what
      this project assumed. A BARE ``PRAGMA integrity_check`` walks
      EVERY ATTACHED DATABASE and folds the result into one answer.
      Since ``connect()`` attaches the archive, a bare pragma here
      therefore walked the 4.8 GB archive as well as the state database
      and reported an archive fault as though the state database were
      damaged - and then :func:`db_integrity_pair.check_every_database`
      walked the archive a SECOND time to attribute it properly.
      Measured 2026-09-14 on SQLite 3.53.4 with a sound main and a
      corrupt attachment: bare answered "row 408 missing from index ix",
      ``main.`` answered "ok", ``side.`` answered the fault.

      So this function is the STATE DATABASE'S OWN verdict and nothing
      else. Coverage of the pair belongs to ``check_every_database``,
      which names the file each verdict is about. One file, one walk, one
      attribution.
    Inputs: conn (sqlite3.Connection).
    Output: str - "ok", or a newline-joined list of problems. Returns a
      "could not run integrity_check: ..." string when the pragma itself
      raises, which is itself a failure verdict, never an "ok".
    """
    try:
        rows = conn.execute("PRAGMA main.integrity_check").fetchall()
    except sqlite3.Error as exc:
        return f"could not run integrity_check: {exc}"
    return "\n".join(str(row[0]) for row in rows) if rows else "no result"



def connect_archive_only(state_dir: Path) -> sqlite3.Connection:
    """Open cloude-archive.db AS MAIN, with cloude.db not attached at all.

    Description: the connection for a long archive WRITE, and the reason
      it exists is lock scope, not convenience.

      ``BEGIN IMMEDIATE`` acquires the write lock on EVERY ATTACHED
      DATABASE. :func:`connect` opens cloude.db as main and attaches the
      archive, so a projection pass running through it holds
      **cloude.db's** write lock for the length of every transcript it
      ingests - and cloude.db is where the hook path writes
      ``sessions.activity_state``, synchronously on the event loop.
      Measured on live with the corpus drain running through
      :func:`connect`: a main-only ``BEGIN IMMEDIATE`` on cloude.db,
      archive deliberately NOT attached, blocked for **63,927 ms**. The
      app's own corpus ingest pass died outright at 18:57:00Z with
      ``OperationalError: database is locked``.

      THIS IS THE SECOND HALF OF ONE DEFECT. The ``attach_archive=False``
      flag on :func:`connect` stopped main-only READERS taking the
      archive's lock. This stops the archive WRITER taking main's. Either
      half alone leaves one direction open.

      SAFE ONLY BECAUSE THE PROJECTION NEEDS NOTHING FROM cloude.db, and
      that was audited rather than assumed: every table the projection
      path names is archive-side. The one ``sessions`` read in
      :mod:`src.core.transcript_archive` is inside
      ``list_unrooted_archives``, which ``export_archive`` never reaches.
      THE ROOTING PASS IS DIFFERENT AND IS NOT ON THIS CONNECTION: it
      joins ``transcript_archives`` to ``sessions`` and ``projects`` by
      design, it runs only inside ``corpus_ingest_service.run_ingest_once``
      on the connection opened there, and that connection is deliberately
      left alone. A rooting pass re-pointed here would stop finding the
      rows it exists to join and, because a skipped rooting pass reports
      a NAMED status rather than zeros, would be visible - but it would
      still be wrong, so it is not moved.
    Inputs: state_dir (Path) - the install's state directory.
    Output: sqlite3.Connection with row_factory set to sqlite3.Row, the
      same pragmas as :func:`connect`, and the body codec registered.
    Raises: DatastoreUnreadableError - the archive is missing or sqlite3
      refused it. A MISSING ARCHIVE RAISES rather than creating one: on
      an unsplit install the archive tables live in cloude.db and the
      caller must use :func:`connect`, so manufacturing an empty file
      here would produce a pass that projected nothing and said ok.
    Example: with closing(connect_archive_only(state_dir)) as conn: ...
    """
    archive = archive_db_path_for(state_dir)
    if not archive.exists():
        raise DatastoreUnreadableError(
            f"{archive.name} does not exist at {archive}; this install has "
            f"not been split, so the archive tables are in cloude.db and "
            f"connect() is the right entry point",
            archive,
        )
    try:
        conn = sqlite3.connect(str(archive), isolation_level=None, timeout=30.0)
    except sqlite3.Error as exc:
        raise DatastoreUnreadableError(
            f"could not open {archive.name}: {exc}", archive
        ) from exc
    conn.row_factory = sqlite3.Row
    try:
        for pragma in CONNECTION_PRAGMAS:
            conn.execute(pragma)
        register_body_functions(conn)
    except sqlite3.Error as exc:
        conn.close()
        raise DatastoreUnreadableError(
            f"could not prepare {archive.name}: {exc}", archive
        ) from exc
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Run a block inside one BEGIN IMMEDIATE ... COMMIT, rolling back on error.

    Description: BEGIN IMMEDIATE (not deferred) takes the write lock up
      front, so a migration cannot get half way through reading and then
      fail to upgrade its lock. Any exception rolls the whole block back
      and re-raises, which is what makes a half-applied migration leave
      meta.schema_version untouched.
    Inputs: conn (sqlite3.Connection) - opened by :func:`connect`, i.e.
      with isolation_level=None so this is the only transaction control.
    Output: yields the same connection.
    Raises: whatever the body raised, after ROLLBACK.
    Example:
        with transaction(conn):
            conn.execute("ALTER TABLE t ADD COLUMN a TEXT")
            conn.execute("ALTER TABLE t ADD COLUMN b TEXT")
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error as exc:  # pragma: no cover - defensive
            logger.error("db_rollback_failed", error=str(exc))
        raise
    conn.execute("COMMIT")


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    """Report whether a table exists, for idempotent migration steps.

    Description: every migration step inspects sqlite_master before it
      acts, so re-running a step after an interrupted attempt finishes
      the remaining work or no-ops rather than erroring.

      IT LOOKS IN THE ATTACHED ARCHIVE TOO, and that is not a nicety.
      ``sqlite_master`` is PER SCHEMA: unlike a table NAME in a query,
      which resolves across attached databases, a bare
      ``SELECT ... FROM sqlite_master`` means ``main.sqlite_master`` and
      nothing else. After the archive split, six presence checks written
      that way reported the whole message model absent while every query
      against it would have worked, and the corpus drain refused with
      ``model_absent`` on a datastore that had the model.

      For an app-side table the answer is unchanged, because the archive
      never holds one. For an archive-side table this is the difference
      between seeing it and denying it exists.

      AND IT REFUSES RATHER THAN ANSWERING "NO" WHEN IT COULD NOT LOOK.
      A connection opened with ``attach_archive=False`` cannot see the
      archive, so asked about an archive-side table it would answer
      False - the exact ``model_absent`` lie described above,
      reintroduced by the very flag that fixes the lock contention. That
      is a caller bug, not a fact about the data, so it raises.

      THE TWO CASES ARE NOT THE SAME AND CONFLATING THEM BREAKS EVERY
      FRESH INSTALL. "This install has no archive file" is a real
      measurement and the honest answer to it is False: an unsplit
      datastore genuinely does not have ``message_transcripts``, and
      ``apply_message_model_schema`` asks precisely that before creating
      it. "An archive file exists and this connection was told not to
      attach it" is the caller bug. So the refusal is conditioned on the
      FILE being present, not on the schema being absent. Getting that
      backwards turned a fresh migration into 615 failures.
    Inputs: conn (sqlite3.Connection), name (str) - table name.
    Output: bool.
    Raises: ArchiveNotAttachedError - ``name`` is archive-side, an
      archive file exists beside this database, and it is not attached.
    """
    found = which_database(conn, name)
    if found is not None:
        # It is right here. How the connection was opened is irrelevant:
        # an archive-only connection holds these tables in `main`.
        return True
    if (
        side_for_table(name) == SIDE_ARCHIVE
        and ARCHIVE_SCHEMA not in attached_schemas(conn)
        and _archive_file_exists_for(conn)
    ):
        raise ArchiveNotAttachedError(
            f"{name!r} lives in the archive database, an archive file "
            f"exists beside this datastore, and this connection was opened "
            f"with attach_archive=False - so its presence cannot be decided "
            f"here. Open the connection with the archive attached, or ask "
            f"about a table this connection can see."
        )
    return False


def _archive_file_exists_for(conn: sqlite3.Connection) -> bool:
    """Is there an archive file beside the database this connection holds?

    Description: private. Reads ``PRAGMA database_list``, which is the
      only authority on what a connection actually has open, and asks
      the filesystem about the sibling. An in-memory or unnamed database
      has no sibling and answers False, which is correct: there is no
      archive for it to be hiding.
    Inputs: conn (sqlite3.Connection).
    Output: bool - False whenever it cannot be established, because a
      refusal built on a guess would break installs that have no archive.
    Example: _archive_file_exists_for(conn) -> True
    """
    try:
        for row in conn.execute("PRAGMA database_list"):
            if row[1] == "main" and row[2]:
                return archive_sibling_for(Path(row[2])).exists()
    except sqlite3.Error:
        return False
    return False


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    """Report whether a column exists on a table.

    Description: the ALTER TABLE ADD COLUMN half of the idempotence rule
      above. Returns False for a table that does not exist at all, which
      is the correct answer to "does this column exist".
    Inputs: conn (sqlite3.Connection), table (str), column (str).
    Output: bool.
    """
    if not table_exists(conn, table):
        return False
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(str(row[1]) == column for row in rows)


def get_meta(conn: sqlite3.Connection, key: str) -> Optional[str]:
    """Read one meta value.

    Inputs: conn (sqlite3.Connection), key (str).
    Output: str | None - None when the key is absent OR the meta table
      does not exist yet (a pre-v1 database).
    """
    if not table_exists(conn, "meta"):
        return None
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return None if row is None else str(row[0])


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    """Write one meta value, inserting or replacing.

    Description: caller is responsible for the surrounding transaction.
      In particular the schema_version stamp MUST be inside the same
      transaction as the DDL it describes, so a rolled-back migration
      cannot leave a version claiming work that was undone.
    Inputs: conn (sqlite3.Connection), key (str), value (str).
    Output: None.
    """
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


#: ``meta.schema_version`` has no row. A real answer: this file has no
#: v1 schema yet, either brand new or interrupted before the first stamp.
SCHEMA_VERSION_ABSENT = "absent"

#: ``meta.schema_version`` held a value that parsed as an integer.
SCHEMA_VERSION_PARSED = "parsed"

#: ``meta.schema_version`` held something that will NOT parse as an
#: integer. We could not evaluate the version. This is NOT zero.
SCHEMA_VERSION_UNREADABLE = "unreadable"


@dataclass(frozen=True)
class SchemaVersionRead:
    """The three-outcome result of reading ``meta.schema_version``.

    Description: absent, parsed, and unreadable are three different
      facts, and the whole point of this type is that the third one
      cannot be spelled as a number. Collapsing "unreadable" into 0 made
      a populated database look like a fresh install, which skipped the
      backup and recorded a ``bootstrap`` from version 0 in the trail -
      a false claim about a live database, written into the file whose
      job is to be the honest history.
    Inputs (constructor): outcome (str) - one of
      ``SCHEMA_VERSION_ABSENT``, ``SCHEMA_VERSION_PARSED``,
      ``SCHEMA_VERSION_UNREADABLE``. value (int | None) - the parsed
      integer, set ONLY for ``parsed``. raw (str | None) - the stored
      text exactly as found, for the operator-facing message.
    Output: a SchemaVersionRead instance.
    """

    outcome: str
    value: Optional[int] = None
    raw: Optional[str] = None

    @property
    def readable(self) -> bool:
        """Whether a version could be established at all.

        Inputs: none.
        Output: bool - False only for ``SCHEMA_VERSION_UNREADABLE``.
        """
        return self.outcome != SCHEMA_VERSION_UNREADABLE


def read_schema_version(conn: sqlite3.Connection) -> SchemaVersionRead:
    """Read ``meta.schema_version`` as three outcomes, never as a number.

    Description: the honest primitive behind :func:`get_schema_version`.
      Any gate that DECIDES something - whether to back up, whether to
      migrate, whether this is a fresh install - must use this one,
      because the decision differs between "version 0" and "version
      unknown" and only this signature can tell them apart.

      Accepted forms are whatever ``int()`` accepts after the value is
      stripped, so ``' 1 '``, ``'01'`` and ``'+1'`` parse. ``''``,
      ``'v1'``, ``'1.0'`` and ``'3-dirty'`` do not, and become
      ``SCHEMA_VERSION_UNREADABLE`` rather than 0.
    Inputs: conn (sqlite3.Connection).
    Output: SchemaVersionRead.
    Example:
        >>> read_schema_version(conn).outcome  # doctest: +SKIP
        'parsed'
    """
    raw = get_meta(conn, META_SCHEMA_VERSION)
    if raw is None:
        return SchemaVersionRead(SCHEMA_VERSION_ABSENT)
    try:
        return SchemaVersionRead(SCHEMA_VERSION_PARSED, value=int(str(raw).strip()), raw=str(raw))
    except (TypeError, ValueError):
        logger.warning("db_schema_version_unparseable", raw=raw)
        return SchemaVersionRead(SCHEMA_VERSION_UNREADABLE, raw=str(raw))


def get_schema_version(conn: sqlite3.Connection) -> int:
    """Read meta.schema_version as an int, reporting 0 when there is none.

    Description: the REPORTING face of :func:`read_schema_version`, for
      call sites that only render or compare a number and take no
      irreversible action on it.

      DO NOT USE THIS AS A GATE. It collapses two different facts onto
      0: "no version recorded" and "a version that will not parse". That
      collapse is what let a populated 9-project database migrate with
      ZERO backups taken and be recorded in the trail as a bootstrap
      from 0. Anything deciding whether to back up, whether to migrate,
      or whether a file is a fresh install must call
      :func:`read_schema_version` and handle ``SCHEMA_VERSION_UNREADABLE``
      as its own outcome.
    Inputs: conn (sqlite3.Connection).
    Output: int - the parsed version, or 0 for both absent and
      unparseable. The caller cannot distinguish those two, which is
      precisely why this must not gate anything.
    """
    read = read_schema_version(conn)
    return read.value if read.value is not None else 0


def database_is_populated(conn: sqlite3.Connection) -> Optional[bool]:
    """Report whether this file already holds user data, or say it cannot tell.

    Description: a cheap independent discriminator against the
      fresh-install path, used when the recorded schema version cannot be
      trusted. The ``projects`` table is the right probe: it exists from
      v1 onward and an install with rows in it is by definition not a new
      file, whatever ``meta.schema_version`` happens to say.

      Three outcomes, because guessing here decides whether a real user's
      data gets backed up. A missing table is a genuine False (a file
      with no projects table has no projects). A query that FAILS is
      None - could not evaluate - and the caller must treat that with the
      same caution as True, never as a licence to skip the backup.
    Inputs: conn (sqlite3.Connection).
    Output: bool | None - True when at least one project row exists,
      False when the table exists and is empty or does not exist at all,
      None when the question could not be answered.
    Example:
        >>> database_is_populated(conn)  # doctest: +SKIP
        True
    """
    try:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'"
        ).fetchone()
        if row is None:
            return False
        count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()
        if count is None:
            return None
        return int(count[0]) > 0
    except sqlite3.Error as exc:
        logger.warning("db_populated_probe_failed", error=str(exc))
        return None


def ensure_install_id(conn: sqlite3.Connection) -> str:
    """Read meta.install_id, minting one if this install has none.

    Description: a stable per-install identifier so a trail file and a
      database can be matched to each other after being copied around.
      Caller supplies the transaction.
    Inputs: conn (sqlite3.Connection).
    Output: str - the existing or newly minted UUID4.
    """
    existing = get_meta(conn, META_INSTALL_ID)
    if existing:
        return existing
    minted = str(_uuid.uuid4())
    set_meta(conn, META_INSTALL_ID, minted)
    return minted
