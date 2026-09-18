"""The ONE app-database read that names everything in an archive listing.

WHY THIS IS A SEPARATE CONNECTION AND NOT A JOIN. Since the v1.5 split,
``cloude.db`` and ``cloude-archive.db`` are different files, and
:mod:`src.core.db_connection_shape` exists because routing a statement
onto the wrong connection fails SILENTLY - right answer, wrong lock. The
archive read path holds an ``ARCHIVE_ONLY`` connection precisely so a
long archive read cannot take ``cloude.db``'s write lock, which is the
defect that cost a 516-second hold (issue #224). Answering "what is this
project called" by attaching cloude.db to that connection would re-create
it exactly.

So the name lookup opens its OWN connection, ``attach_archive=False``, in
the ``APP_ONLY_SPLIT`` shape the module names for the app's own main-only
work, reads in bulk, closes, and the matching happens in PYTHON against
rows both sides already have in memory. No cross-file join, no attach, no
shared lock.

ONE OPEN PER LISTING, NOT ONE PER ROW, AND THAT IS THE WHOLE COST MODEL.
This project has paid for the alternative twice: ``/sessions/attachable``
opened 33 connections for 11 rows, about 33 ms of a 55 ms pass, and the
``/sessions/list`` seed ladder opened one per session, 95 per pass. Both
were fixed by reading the whole table once and answering from memory,
which is what this does. Measured 2026-09-18 against the live databases:
**1 connection, 2 statements**, 79 project rows and 927 session titles,
7.4 ms median for the whole index. It does not grow with the number of
projects in the listing.

``complete`` TRAVELS WITH THE DATA. An index that is empty because the
query ran and there are no projects, and one that is empty because the
file would not open, are the same object and opposite facts; the second
must render as "could not determine", never as "no project matched". Same
discipline as ``StatusMap.complete`` and ``InstanceIndex.complete``, and
the same sentence underneath: a reading that did not happen is not a
reading of nothing.

READ-ONLY, ASSERTED RATHER THAN INTENDED. ``PRAGMA query_only`` is set
and then READ BACK, the way :func:`src.core.archive_read.open_read_only`
does it, because setting a pragma is a request and reading 1 back is a
measurement. Nothing in this module writes, migrates or creates: the
connection is opened with ``create=False`` so a wrong state directory
raises instead of manufacturing an empty database that renders as a
healthy install with no projects.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Dict, List, Optional

import structlog

from src.core.archive_display_names import ProjectNameIndex
from src.core.db import DatastoreError, connect, db_path_for

logger = structlog.get_logger()

#: Columns the project join needs. ``description`` is included because it
#: carries the only explanation of the confusing duplicates in this data
#: (project 4's says, in full, why an identically named row was retired),
#: and a rail that can show it stops the user re-discovering that.
_PROJECT_SQL = (
    "SELECT id, root, raw_path, display_name, description FROM projects"
)

#: ``title`` is the BROWSER's name for a session and the one to render.
#: ``claude_title`` is deliberately NOT read: per the one-name model in
#: ``src.core.claude_title_sync`` it is the marker that makes the sync
#: idempotent under duplicated hook events, not a second name - and
#: measured on live it is set on 31 of 941 rows against ``title``'s 896,
#: so showing it would blank 92 percent of the sessions that have a name.
_SESSION_SQL = (
    "SELECT claude_session_uuid, title FROM sessions "
    "WHERE claude_session_uuid IS NOT NULL AND claude_session_uuid <> '' "
    "AND title IS NOT NULL AND title <> ''"
)


class AppNameIndex:
    """Project and session names from ``cloude.db``, read once.

    Description: the whole naming side of an archive listing in one
      object. ``projects`` is the slug index the resolver consumes;
      ``session_title`` answers a conversation uuid. ``complete`` is True
      only when both statements actually ran.
    Inputs: built by :func:`load_app_name_index`; the constructor is
      used directly only by tests, which pass rows in memory.
    Output: an index.
    Example: load_app_name_index(sd).session_title(uuid)  # 'Media Compression'
    """

    def __init__(
        self,
        project_rows: List[Dict[str, Any]],
        session_titles: Dict[str, str],
        *,
        complete: bool,
    ) -> None:
        self.complete = bool(complete)
        self.projects = ProjectNameIndex(project_rows, complete=self.complete)
        self._titles = dict(session_titles)

    def session_title(self, session_uuid: Optional[str]) -> Optional[str]:
        """The browser's name for one archived conversation, or None.

        Description: keyed on ``sessions.claude_session_uuid``, which is
          the row's copy of the transcript uuid and therefore the same
          identifier the archive records as ``session_ref`` under the
          ``uuid`` scheme. Returns None for an unknown uuid and for every
          ``agent`` sidechain, which have no row and never will - a
          sidechain is a file a conversation spawned, not a conversation.
          None here is a MEASURED ABSENCE only when ``complete`` is True;
          a caller reporting provenance must read that flag too.
        Inputs: session_uuid (str | None) - the archive's session_ref.
        Output: str | None.
        Example: idx.session_title('42ca16a6-...')  # 'daily briefing'
        """
        if not session_uuid or not self.complete:
            return None
        return self._titles.get(session_uuid)

    @property
    def session_title_count(self) -> int:
        """How many titled sessions the index holds, for reporting.

        Inputs: none. Output: int.
        """
        return len(self._titles)


def empty_index() -> AppNameIndex:
    """An index that answers nothing and says so.

    Description: what every failure path returns. It is NOT an index of
      zero projects - ``complete`` is False, so the resolver reports
      ``cannot_determine`` rather than ``none`` and the rail shows a slug
      without claiming anything was looked up.
    Inputs: none. Output: AppNameIndex with ``complete`` False.
    Example: empty_index().complete  # False
    """
    return AppNameIndex([], {}, complete=False)


def load_app_name_index(state_dir: Path) -> AppNameIndex:
    """Read every project and session name from cloude.db, in one open.

    Description: the only I/O in the naming path. Opens ``cloude.db``
      WITHOUT the archive attached, so this connection's lock scope is
      one file and an archive read in flight is untouched; asserts
      read-only; runs two statements; closes. Any datastore failure
      degrades to :func:`empty_index` and is logged - a rail that cannot
      name a project must still list it.
    Inputs: state_dir (Path) - as resolved by ``Settings.get_state_dir()``.
    Output: AppNameIndex; ``complete`` is False on every failure.
    Example: load_app_name_index(sd).projects.project_count  # 79
    """
    path = db_path_for(Path(state_dir))
    try:
        conn = connect(path, create=False, attach_archive=False)
    except (DatastoreError, sqlite3.Error) as exc:
        logger.info("app_name_index_unavailable", reason=str(exc))
        return empty_index()
    try:
        with closing(conn):
            if not _assert_read_only(conn, path):
                return empty_index()
            projects = [dict(row) for row in conn.execute(_PROJECT_SQL)]
            titles = {
                str(row["claude_session_uuid"]): str(row["title"])
                for row in conn.execute(_SESSION_SQL)
            }
    except sqlite3.Error as exc:
        # A missing table is the ordinary shape of an install older than
        # the columns above; it is a reason to name nothing, never to
        # fail the listing that was asked for.
        logger.info("app_name_index_read_failed", reason=str(exc))
        return empty_index()
    logger.debug(
        "app_name_index_loaded",
        projects=len(projects),
        session_titles=len(titles),
    )
    return AppNameIndex(projects, titles, complete=True)


def _assert_read_only(conn: sqlite3.Connection, path: Path) -> bool:
    """Set ``query_only`` and confirm it took.

    Description: the same measurement ``archive_read.open_read_only``
      makes, for the same reason - a pragma that silently did not apply
      leaves a writable connection on a read path. Refuses by returning
      False rather than raising, because this whole module's contract is
      that it degrades a listing's names and never its rows.
    Inputs: conn (sqlite3.Connection), path (Path) - for the log line.
    Output: bool - True when the connection is provably read-only.
    """
    try:
        conn.execute("PRAGMA query_only=ON")
        row = conn.execute("PRAGMA query_only").fetchone()
    except sqlite3.Error as exc:
        logger.info("app_name_index_query_only_failed", reason=str(exc))
        return False
    if row is None or int(row[0]) != 1:
        logger.info("app_name_index_not_read_only", db=path.name)
        return False
    return True
