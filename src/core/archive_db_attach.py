"""ATTACH the archive database, and prove queries reach the right file.

THE WHOLE WIRING IS ONE ATTACH AT ONE SEAM, and that is not a shortcut,
it is what sqlite's name resolution actually buys. MEASURED on 3.53.4,
2026-09-13, on fresh connections so no statement cache could colour it:

  table exists ONLY in the attached database
      SELECT who FROM t          -> reaches archive
      UPDATE / INSERT INTO t     -> reaches archive

  table exists in BOTH databases
      SELECT who FROM t          -> reaches MAIN
      UPDATE t                   -> reaches MAIN

So after the split, when the archive tables no longer exist in
``cloude.db``, every one of the 68 modules' unqualified queries resolves
to the archive file with no edit at all. NOT ONE CALL SITE NEEDS A
PREFIX. That is the payoff of the single seam and the reason the drop
step in the migration is load-bearing rather than mere tidying.

AND THAT IS EXACTLY WHY SHADOWING IS THE FAILURE MODE TO GUARD.
"main wins, silently" is the same shape as the cross-database foreign key
this project already paid for: accepted, no error, wrong answer. A
migration that copied the tables and did NOT drop them leaves EVERY
archive table present on both sides, and every query then reads the
STALE pre-split copy in main while the archive file sits there looking
healthy. Nothing in sqlite complains. :func:`shadowed_tables` is the
measurement that answers "how would I know", and
:func:`assert_no_shadowing` is what turns it into a refusal.

A THIRD HAZARD, MEASURED BY ACCIDENT AND WORTH KEEPING. A connection
that PREPARED a statement before shadowing appeared can keep hitting the
database it first resolved to, disagreeing with a statement prepared
after. Observed on one connection: a cached ``SELECT who FROM t`` still
answered from archive while a freshly prepared ``UPDATE t`` wrote to
main, on the same connection, in the same instant. Do not reason about
shadowing as "whichever database wins, at least it is consistent"; it is
not even that. The only safe state is no shadowing at all.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import List, Optional, Set

import structlog

from src.core.archive_db_partition import (
    ARCHIVE_DB_FILENAME,
    ARCHIVE_SCHEMA,
)

logger = structlog.get_logger()


def archive_sibling_for(main_path: Path) -> Path:
    """Return the archive database that belongs beside a state database.

    Description: the archive always lives next to the file it was split
      out of, so its location is derived rather than configured. One
      fewer setting to get wrong, and a copied state directory keeps its
      pair together.
    Inputs: main_path (Path) - the cloude.db being opened.
    Output: Path - the sibling cloude-archive.db (may not exist).
    Example: archive_sibling_for(Path("/s/cloude.db")).name
      # 'cloude-archive.db'
    """
    return Path(main_path).parent / ARCHIVE_DB_FILENAME


def attached_schemas(conn: sqlite3.Connection) -> Set[str]:
    """Name every schema currently attached to a connection.

    Description: reads ``PRAGMA database_list``, which is the only
      authority on what this connection can actually see. Used to make
      attaching idempotent rather than tracking it in Python state that
      can drift from the connection.
    Inputs: conn (sqlite3.Connection).
    Output: set[str] - always contains 'main'.
    Example: attached_schemas(conn)  # {'main', 'archive'}
    """
    try:
        return {row[1] for row in conn.execute("PRAGMA database_list")}
    except sqlite3.Error:
        return set()


def attach_archive(
    conn: sqlite3.Connection, main_path: Path, *,
    archive_path: Optional[Path] = None,
) -> bool:
    """Attach the archive database to a connection, if there is one.

    Description: IDEMPOTENT, because several callers legitimately reach
      the same connection: :func:`src.core.db.connect` attaches on every
      connection it hands out, and the migration and its reverse each
      want the archive attached too. Re-attaching the same schema name is
      an error in sqlite, so this checks ``database_list`` first rather
      than catching the failure.

      A MISSING ARCHIVE FILE IS NOT AN ERROR. An unsplit install has
      none, which is the normal state before the migration runs, and
      every archive query then resolves inside ``main`` exactly as it
      always did. This is what lets the same code serve both states.
      The file is never CREATED here: attaching a path sqlite has to
      create would manufacture an empty archive next to a healthy
      install, and every archive query would then find an empty table
      rather than an error.
    Inputs: conn (sqlite3.Connection), main_path (Path) - the state
      database this connection is open on. archive_path (Path | None) -
      override for tests; defaults to the sibling.
    Output: bool - True when the archive is attached when this returns
      (whether or not this call is what attached it).
    Example: attach_archive(conn, Path("/s/cloude.db"))  # False, unsplit
    """
    if ARCHIVE_SCHEMA in attached_schemas(conn):
        return True
    target = Path(archive_path) if archive_path else archive_sibling_for(main_path)
    if not target.exists():
        return False
    try:
        conn.execute(f"ATTACH DATABASE ? AS {ARCHIVE_SCHEMA}", (str(target),))
        conn.execute(f"PRAGMA {ARCHIVE_SCHEMA}.journal_mode=WAL")
    except sqlite3.Error as exc:
        # Deliberately not fatal: an unreadable archive must not stop the
        # app opening its own state database, where the sessions live.
        # Archive queries will then fail loudly on their own, which is a
        # better failure than a server that will not start.
        logger.warning(
            "archive_db_attach_failed", path=str(target), error=str(exc),
        )
        return False
    return True


def shadowed_tables(conn: sqlite3.Connection) -> List[str]:
    """Name every table present in BOTH main and the attached archive.

    Description: THE CHECK THAT ANSWERS "DID MY QUERY HIT THE RIGHT
      FILE". A shadowed table is one where main silently wins and every
      unqualified read and write goes to the stale copy. It is the state
      a half-finished migration leaves behind, and sqlite reports nothing
      about it.
    Inputs: conn (sqlite3.Connection) - with the archive attached; with
      no archive attached the answer is trivially empty.
    Output: list[str] - names present on both sides, sorted.
    Example: shadowed_tables(conn)  # []
    """
    if ARCHIVE_SCHEMA not in attached_schemas(conn):
        return []
    query = (
        "SELECT name FROM {schema}.sqlite_master "
        "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'"
    )
    try:
        in_main = {r[0] for r in conn.execute(query.format(schema="main"))}
        in_archive = {
            r[0] for r in conn.execute(query.format(schema=ARCHIVE_SCHEMA))
        }
    except sqlite3.Error:
        return []
    return sorted(in_main & in_archive)


#: Shadow signatures this process has already reported. The guard runs on
#: EVERY connection the app opens, and the condition it reports is a
#: property of the two FILES, not of the connection, so reporting it once
#: per process says everything a reader needs.
_REPORTED_SHADOWS: Set[tuple] = set()


def assert_no_shadowing(conn: sqlite3.Connection) -> List[str]:
    """Log any shadowed table ONCE PER PROCESS, and return the list.

    Description: deliberately a LOG plus a return value rather than a
      raise. This runs on a connection the app is about to use for real
      work, and refusing to open the database would take a running
      server down over a condition that only affects archive queries.
      The migration is where this becomes a hard refusal; here it is the
      alarm. The bookkeeping tables the migration keeps in the archive
      (``archive_split_progress``, ``archive_split_origin``) never exist
      in main, so they cannot appear here.

      THE ONCE-PER-PROCESS RULE IS NOT COSMETIC, IT WAS MEASURED. Logging
      on every connection produced 448 lines in 20 seconds on the owner's
      live install, which is 73.6 MB per hour and 1.73 GB per day of
      identical text. An alarm nobody can afford to leave on is an alarm
      that gets switched off. The signature is the shadow SET, so a
      CHANGE in what is shadowed is reported again rather than swallowed
      by the memo.

      The return value is NOT memoised: every caller still gets the true
      current answer, and callers that act on it are unaffected.
    Inputs: conn (sqlite3.Connection).
    Output: list[str] - the shadowed names, empty when healthy.
    Example: assert_no_shadowing(conn)  # []
    """
    shadowed = shadowed_tables(conn)
    if shadowed:
        signature = tuple(shadowed)
        if signature not in _REPORTED_SHADOWS:
            _REPORTED_SHADOWS.add(signature)
            logger.error(
                "archive_db_shadowed_tables",
                tables=shadowed,
                count=len(shadowed),
                detail=(
                    "these tables exist in BOTH cloude.db and "
                    "cloude-archive.db. sqlite resolves an unqualified name "
                    "to main, so every archive query is silently reading the "
                    "copy in main. This is the state a migration that copied "
                    "but did not drop leaves behind, and also the state the "
                    "schema chain recreates if it owns these tables. Logged "
                    "ONCE per process per distinct set"
                ),
            )
    return shadowed


def which_database(conn: sqlite3.Connection, table: str) -> Optional[str]:
    """Report which schema an unqualified reference to a table resolves to.

    Description: the per-query answer to "how would I know". It asks
      sqlite rather than reimplementing its resolution rule, by planning
      a real query and reading back the schema sqlite chose. Used by the
      tests, which make the two databases DIFFER so that a wrong answer
      is detectable at all: a test where both files hold the same rows
      would pass no matter which one it read.
    Inputs: conn (sqlite3.Connection), table (str).
    Output: str | None - 'main', 'archive', or None when the name does
      not resolve anywhere.
    Example: which_database(conn, "transcript_archives")  # 'archive'
    """
    query = (
        "SELECT name FROM {schema}.sqlite_master "
        "WHERE type IN ('table','view') AND name = ?"
    )
    try:
        in_main = conn.execute(query.format(schema="main"), (table,)).fetchone()
    except sqlite3.Error:
        return None
    if in_main is not None:
        return "main"
    if ARCHIVE_SCHEMA not in attached_schemas(conn):
        return None
    try:
        in_archive = conn.execute(
            query.format(schema=ARCHIVE_SCHEMA), (table,)
        ).fetchone()
    except sqlite3.Error:
        return None
    return ARCHIVE_SCHEMA if in_archive is not None else None
