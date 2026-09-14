"""What a connection can actually see, so a write cannot be routed wrongly.

WHY THIS EXISTS. ``BEGIN IMMEDIATE`` acquires the write lock on EVERY
ATTACHED DATABASE, so which files a connection holds is not a detail: it
decides who else has to wait. A long archive write on a connection that
also holds cloude.db blocks the Claude Code hook path, which writes
``sessions.activity_state`` synchronously on the event loop. Measured on
live: 63,927 ms for a main-only write to cloude.db, the loop parked for
25 s at a time, and one corpus ingest pass killed outright with
``database is locked``.

THE FAILURE MODE THIS MODULE GUARDS IS SILENT. Routing a write onto the
wrong connection produces no error, no wrong answer and no missing row.
It produces the right result, slowly, while re-creating the stall - and
it looks completely healthy from every direction except a latency
histogram's tail. So the routing is ASSERTED at the seam rather than
established by reading the call graph once and trusting it.

THREE SHAPES, and the names say what the connection may be used for:

  ARCHIVE_ONLY  main IS cloude-archive.db and nothing is attached. Safe
                for a long archive write: its lock reaches no other file.
  PAIR          main is cloude.db with the archive attached. Required by
                anything that JOINS across the two - the rooting pass
                joins transcript_archives to sessions and projects - and
                anything writing on it takes both locks.
  APP_ONLY      main is cloude.db, no archive attached, AND NO ARCHIVE
                FILE EXISTS beside it. An UNSPLIT install: one file, one
                lock, nothing to route.
  APP_ONLY_SPLIT
                main is cloude.db with the archive NOT attached while an
                archive file DOES exist. Correct for the app's own
                main-only writes and wrong for everything archive-side.

APP_ONLY SATISFIES BOTH REQUIREMENTS ON PURPOSE, and APP_ONLY_SPLIT
SATISFIES NEITHER. On an install that was never split there is one file,
one lock, and nothing to route; refusing there would break every such
install to prevent a contention that cannot occur. On a SPLIT install the
same shape is a different fact - a connection holding cloude.db's lock and
unable to see an archive table - and collapsing the two would let an
archive write be routed onto cloude.db's lock and call it fine. The
distinction is the FILESYSTEM, not the schema list, which is why it costs
a stat.
"""

from __future__ import annotations

import sqlite3
from typing import Set

from pathlib import Path

from src.core.archive_db_partition import (
    ARCHIVE_DB_FILENAME,
    ARCHIVE_SCHEMA,
    archive_db_path_for,
)
from src.core.db import DatastoreError

#: main is the archive file, nothing attached. Safe for long writes.
ARCHIVE_ONLY = "archive_only"

#: main is cloude.db with the archive attached. Needed for cross-file joins.
PAIR = "pair"

#: main is cloude.db, no archive attached, and none exists. Unsplit.
APP_ONLY = "app_only"

#: main is cloude.db, no archive attached, but one EXISTS. Main-only work
#: on a split install: right for the app's own writes, wrong for archive.
APP_ONLY_SPLIT = "app_only_split"

#: The shape could not be established. Never treated as satisfying anything.
UNKNOWN = "unknown"


class ConnectionShapeError(DatastoreError):
    """A statement was routed onto a connection of the wrong shape.

    Description: a programming error, raised loudly, because the
      alternative is the silent re-creation of a 25 second event-loop
      stall that no test asserting results can see.
    Inputs: standard RuntimeError arguments.
    Output: an exception instance.
    """


def connection_shape(conn: sqlite3.Connection) -> str:
    """Report which files a connection holds.

    Description: reads ``PRAGMA database_list``, which is the only
      authority on what a connection actually has open - a flag passed at
      construction says what was INTENDED, and the two can differ.
    Inputs: conn (sqlite3.Connection).
    Output: str - ARCHIVE_ONLY, PAIR, APP_ONLY, APP_ONLY_SPLIT or UNKNOWN.
    Example: connection_shape(conn) -> 'archive_only'
    """
    try:
        rows = [(r[1], r[2]) for r in conn.execute("PRAGMA database_list")]
    except sqlite3.Error:
        return UNKNOWN
    schemas: Set[str] = {name for name, _ in rows}
    main_file = next((path for name, path in rows if name == "main"), "") or ""
    main_is_archive = main_file.endswith(ARCHIVE_DB_FILENAME)
    if main_is_archive and ARCHIVE_SCHEMA not in schemas:
        return ARCHIVE_ONLY
    if not main_is_archive and ARCHIVE_SCHEMA in schemas:
        return PAIR
    if not main_is_archive and ARCHIVE_SCHEMA not in schemas and main_file:
        # The filesystem decides, not the schema list: the same attached
        # set means different things on a split and an unsplit install.
        sibling = archive_db_path_for(Path(main_file).parent)
        return APP_ONLY_SPLIT if sibling.exists() else APP_ONLY
    return UNKNOWN


def require_archive_only(conn: sqlite3.Connection, what: str) -> None:
    """Refuse unless this connection's write lock reaches no other file.

    Inputs: conn (sqlite3.Connection), what (str) - the operation, for
      the message.
    Output: None.
    Raises: ConnectionShapeError - the connection also holds cloude.db.
    Example: require_archive_only(conn, "ingest_one")
    """
    shape = connection_shape(conn)
    if shape in (ARCHIVE_ONLY, APP_ONLY):
        return
    raise ConnectionShapeError(
        f"{what} must run on an archive-only connection; this one is "
        f"{shape!r}, so its BEGIN IMMEDIATE would take cloude.db's write "
        f"lock and block the hook path on the event loop"
    )


def require_pair(conn: sqlite3.Connection, what: str) -> None:
    """Refuse unless this connection can see BOTH files.

    Inputs: conn (sqlite3.Connection), what (str) - the operation.
    Output: None.
    Raises: ConnectionShapeError - a cross-file join could not resolve.
    Example: require_pair(conn, "root_pending_archives")
    """
    shape = connection_shape(conn)
    if shape in (PAIR, APP_ONLY):
        return
    raise ConnectionShapeError(
        f"{what} joins across cloude.db and the archive, so it needs both; "
        f"this connection is {shape!r} and the join would resolve against "
        f"one file"
    )
