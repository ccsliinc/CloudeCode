"""The real working directory each archive slug was recorded under.

THE SLUG CANNOT BE INVERTED, SO THE ANSWER IS READ RATHER THAN DERIVED.
:mod:`src.core.archive_display_names` names 73 of this machine's 100
archive project slugs by pushing every ``projects`` row FORWARD through
the slugifier and comparing. The remaining 27 have no project row at all,
and parsing their slug is guessing: the slugifier maps ``/``, ``_``,
``.``, a space and a literal ``-`` onto one byte, so ``dev-tools-scripts``
could be ``dev_tools/scripts``, ``dev-tools/scripts`` or ``dev tools
scripts`` and nothing in the string says which.

THE OWNER WAS RIGHT THAT IT IS IN THE JSONL. Claude Code writes a ``cwd``
field on nearly every transcript record, holding the shell's own spelling
of the directory the session ran in. Measured over this machine's entire
archive 2026-09-18: **19,309 of 20,509** non-superseded archives yield a
cwd from the first 4 KB of their compressed body, and 20,212 from the
first 16 KB. That is ground truth, recorded at the time, and it survives
the slug entirely - it is the only place ``unifi_tunnel_reset``'s
underscore still exists.

IT IS READ FROM THE ARCHIVE, NOT FROM DISK, AND NOT FROM THE MESSAGE
MODEL. ``message_projects.observed_cwd`` is the column that was meant to
carry this and it is NULL on 100 of 100 rows (see
:mod:`src.core.archive_display_names`), so the model cannot answer. The
jsonl files themselves are the other candidate and were rejected: the
archive is byte-exact and self-contained, a transcript whose file has
since been deleted or moved is still in it, and reading it costs no
filesystem walk. What it costs instead is a partial decompression, which
is why this module exists rather than a one-line query.

TWO STATEMENTS, ONE CONNECTION, AND THE BLOB IS NEVER FETCHED WHOLE.
``transcript_archives.content_gzip`` holds a 73 MB transcript as happily
as a 2 KB one, so ``SELECT content_gzip`` on a listing would be absurd.
``substr(content_gzip, 1, 4096)`` asks SQLite for the first page of the
zlib stream and :func:`first_recorded_cwd` feeds that to an incremental
``zlib.decompressobj``, which decodes the leading records and raises
nothing when the stream stops mid-block. Statement one is a scan of
``ix_transcript_archives_projection_scan``, which covers
``source_path`` - no row body is touched at all. Measured on the live
16 GB archive: **1 connection, 2 statements, 16.7 ms** for the 27
unnamed slugs and the 97 archives under them (scan 11.5, heads 1.0,
decode 4.2). It does not grow with the size of the transcripts.

THE HEAD IS ESCALATED ONCE, AND THE ESCALATION IS MEASURED. A record
whose single line exceeds the head yields no COMPLETE line, so nothing
can be parsed from it. That is 896 archives at 4 KB and 6 at 16 KB, so
the retry earns its place rather than being insurance against a case
nobody has seen. It is issued only for the archives that actually failed,
only for slugs the caller asked about, and only once.

NOTHING HERE DECIDES A NAME. It reports which cwds were observed under a
slug and how often, and :mod:`src.core.archive_cwd_names` decides what
that is worth. ``complete`` travels with the data for the same reason it
does on ``StatusMap`` and ``AppNameIndex``: an index that is empty
because the archive would not open must never answer like one that is
empty because the slug has no transcripts.
"""

from __future__ import annotations

import json
import sqlite3
import zlib
from collections import Counter
from contextlib import closing
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Set, Tuple

import structlog

from src.core.archive_db_partition import archive_db_path_for
from src.core.db import (
    DatastoreError,
    connect,
    connect_archive_only,
    db_path_for,
)

logger = structlog.get_logger()

#: Bytes of the compressed body read on the first pass. Chosen from the
#: measurement above: 4 KB answers 94.1 percent of the corpus, and a
#: larger first pass would pay for every archive to help 4 percent.
HEAD_BYTES: int = 4096

#: Bytes read on the ONE retry, for archives the first pass could not
#: parse. 16 KB takes the corpus from 19,309 answered to 20,212.
HEAD_BYTES_RETRY: int = 16384

#: How many archives may be inspected for any ONE slug. A slug with
#: thousands of transcripts cannot make a listing expensive, and the
#: newest are taken first. Exceeding it is REPORTED per slug rather than
#: silently sampled, because a capped reading cannot prove a conflict
#: absent.
MAX_ARCHIVES_PER_SLUG: int = 200

#: SQLite tolerates a large IN list but not an unbounded one; the head
#: fetch is chunked at this width.
_ID_CHUNK: int = 900

#: Statement one. Ordered newest-first so a cap keeps the most recent
#: evidence, and restricted to rows whose body is still theirs - a
#: superseded row's ``content_gzip`` is replaced by a near-empty
#: sentinel (see :mod:`src.core.transcript_archive`) and would decode to
#: nothing while looking like a transcript with no cwd.
_SCAN_SQL: str = (
    "SELECT source_path, id FROM transcript_archives "
    "WHERE superseded_by_archive_id IS NULL "
    "ORDER BY ingested_at DESC, id DESC"
)

#: Why one archive yielded no cwd. Kept apart because only the first two
#: are worth a second, larger read.
REASON_TRUNCATED: str = "no_complete_line"
REASON_NO_CWD: str = "no_cwd_field"
REASON_UNREADABLE: str = "unreadable"


class ArchiveCwdIndex:
    """Observed working directories per archive project slug.

    Description: the whole cwd side of a listing in one object, built by
      :func:`load_archive_cwd_index` from one connection. Holds no
      connection and performs no query. ``complete`` is True only when
      the archive was actually read.
    Inputs: observed (Mapping) - slug to a Counter of cwd strings.
      inspected (Mapping) - slug to how many archives were read.
      capped (Iterable[str]) - slugs whose archive list hit the cap.
      complete (bool).
    Output: an index; ask it :meth:`observed_cwds`.
    Example: load_archive_cwd_index(sd, {'-Users-x-p'}).observed_cwds('-Users-x-p')
    """

    def __init__(
        self,
        observed: Mapping[str, Mapping[str, int]],
        inspected: Mapping[str, int],
        capped: Iterable[str],
        *,
        complete: bool,
    ) -> None:
        self.complete = bool(complete)
        self._observed: Dict[str, Dict[str, int]] = {
            slug: dict(counts) for slug, counts in observed.items()
        }
        self._inspected: Dict[str, int] = dict(inspected)
        self._capped: Set[str] = set(capped)

    def observed_cwds(self, slug: str) -> Dict[str, int]:
        """Every cwd recorded under one slug, with how many archives said it.

        Description: an empty dict is a MEASURED absence only when
          ``complete`` is True; a caller reporting provenance must read
          that flag as well, exactly as it must on ``AppNameIndex``.
        Inputs: slug (str) - the archive directory name, unparsed.
        Output: dict[str, int] - cwd to archive count.
        Example: idx.observed_cwds(slug)  # {'/Users/x/p': 3}
        """
        return dict(self._observed.get(slug, {}))

    def archives_inspected(self, slug: str) -> int:
        """How many archives under this slug were actually read.

        Description: separates "no transcript here" from "transcripts
          here, none of which recorded a cwd", which are different facts
          about the same empty answer.
        Inputs: slug (str). Output: int.
        """
        return int(self._inspected.get(slug, 0))

    def was_capped(self, slug: str) -> bool:
        """Did this slug have more archives than :data:`MAX_ARCHIVES_PER_SLUG`?

        Description: a capped reading may MISS a disagreeing cwd, so it
          can never prove one directory; the resolver degrades its claim
          rather than pretending the sample was the whole.
        Inputs: slug (str). Output: bool.
        """
        return slug in self._capped

    @property
    def slugs_held(self) -> int:
        """How many slugs this index holds evidence for, for reporting.

        Inputs: none. Output: int.
        """
        return len(self._observed)


def empty_cwd_index() -> ArchiveCwdIndex:
    """An index that answers nothing and says it could not look.

    Description: what every failure path returns. ``complete`` is False,
      so the resolver reports ``cannot_determine`` rather than claiming
      a slug has no recorded cwd.
    Inputs: none. Output: ArchiveCwdIndex with ``complete`` False.
    Example: empty_cwd_index().complete  # False
    """
    return ArchiveCwdIndex({}, {}, (), complete=False)


def no_slugs_wanted() -> ArchiveCwdIndex:
    """A COMPLETE index over an empty question, so nothing is opened.

    Description: the "skip the read when nothing can use it" rule this
      codebase already applies to ``InstanceIndex``. A listing whose
      every slug was named by the app database asks about no slugs, and
      paying a connection to answer nobody is the defect. It reports
      ``complete`` because the question really was answered - there was
      none.
    Inputs: none. Output: ArchiveCwdIndex with ``complete`` True.
    Example: no_slugs_wanted().complete  # True
    """
    return ArchiveCwdIndex({}, {}, (), complete=True)


def first_recorded_cwd(head: Optional[bytes]) -> Tuple[Optional[str], str]:
    """The cwd on the first complete record of a partial archive body.

    Description: decompresses a PREFIX of the zlib stream and walks the
      complete lines it yields, returning the first non-empty ``cwd``.
      The trailing fragment is dropped without being parsed, because a
      truncated JSON object is not evidence of anything. The FIRST
      record is taken deliberately: Claude Code rewrites ``cwd`` when the
      user changes directory mid-conversation, and the directory the
      transcript was FILED under is the one it started in.
    Inputs: head (bytes | None) - the leading bytes of ``content_gzip``.
    Output: tuple[str | None, str] - the cwd, and a reason when None.
    Example: first_recorded_cwd(blob)  # ('/Users/x/p', 'ok')
    """
    if not head:
        return None, REASON_UNREADABLE
    try:
        text = zlib.decompressobj().decompress(head).decode("utf-8", "replace")
    except zlib.error as exc:
        logger.debug("archive_cwd_head_undecodable", error=str(exc))
        return None, REASON_UNREADABLE
    lines = text.split("\n")
    complete = lines[:-1]
    if not complete:
        return None, REASON_TRUNCATED
    for line in complete:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            # A complete line that is not JSON is a damaged transcript,
            # not a truncation; a larger head cannot improve it.
            return None, REASON_NO_CWD
        if not isinstance(record, dict):
            continue
        value = record.get("cwd")
        if isinstance(value, str) and value.strip():
            return value.strip(), "ok"
    return None, REASON_NO_CWD


def load_archive_cwd_index(
    state_dir: Path, slugs: Iterable[str]
) -> ArchiveCwdIndex:
    """Read the recorded cwd for every archive under the wanted slugs.

    Description: the only I/O in this path. Opens ``cloude-archive.db``
      alone - the app database is NOT attached, so this connection's
      lock scope is one file and a ``cloude.db`` write in flight is
      untouched - asserts read-only, runs one covering scan plus one
      chunked head fetch (and one bounded retry), closes. Any datastore
      failure degrades to :func:`empty_cwd_index`: a rail that cannot
      read the archive must still list what it was handed.
    Inputs: state_dir (Path) - as resolved by ``Settings.get_state_dir()``.
      slugs (Iterable[str]) - the archive directory names to answer for;
      an empty set opens nothing.
    Output: ArchiveCwdIndex; ``complete`` is False on every failure.
    Example: load_archive_cwd_index(sd, {'-Users-x-p'}).slugs_held  # 1
    """
    wanted = {slug for slug in slugs if slug}
    if not wanted:
        return no_slugs_wanted()
    opened = _open(Path(state_dir))
    if opened is None:
        return empty_cwd_index()
    conn, path = opened
    try:
        with closing(conn):
            if not _assert_read_only(conn, path):
                return empty_cwd_index()
            return _read(conn, wanted)
    except sqlite3.Error as exc:
        # A missing table is the ordinary shape of an install whose
        # archive has not been created yet. A reason to name nothing,
        # never to fail the listing that was asked for.
        logger.info("archive_cwd_index_read_failed", reason=str(exc))
        return empty_cwd_index()


def _open(state_dir: Path) -> Optional[Tuple[sqlite3.Connection, Path]]:
    """Open whichever file actually holds ``transcript_archives``.

    Description: a SPLIT install keeps the archive in its own file and
      :func:`src.core.db.connect_archive_only` opens it as main with
      cloude.db not attached, which is the lock scope this read wants. An
      UNSPLIT install has the archive tables inside cloude.db, where that
      helper deliberately RAISES rather than manufacturing an empty
      archive file - so the fallback is a main-only connection to
      cloude.db, still with nothing attached. Either way exactly one file
      is under this connection's lock.
    Inputs: state_dir (Path) - the install's state directory.
    Output: tuple[sqlite3.Connection, Path] | None - None when neither
      could be opened, which is logged and degrades to no names.
    """
    try:
        return connect_archive_only(state_dir), archive_db_path_for(state_dir)
    except (DatastoreError, sqlite3.Error) as exc:
        logger.debug("archive_cwd_index_split_unavailable", reason=str(exc))
    path = db_path_for(state_dir)
    try:
        return connect(path, create=False, attach_archive=False), path
    except (DatastoreError, sqlite3.Error) as exc:
        logger.info("archive_cwd_index_unavailable", reason=str(exc))
        return None


def _read(conn: sqlite3.Connection, wanted: Set[str]) -> ArchiveCwdIndex:
    """Run the scan, the head fetch and the one retry.

    Inputs: conn (sqlite3.Connection) - a read-only archive connection.
      wanted (set[str]) - slugs to answer for.
    Output: ArchiveCwdIndex with ``complete`` True.
    """
    by_slug: Dict[str, List[int]] = {}
    capped: Set[str] = set()
    for source_path, archive_id in conn.execute(_SCAN_SQL):
        slug = _slug_of(source_path)
        if slug not in wanted:
            continue
        bucket = by_slug.setdefault(slug, [])
        if len(bucket) >= MAX_ARCHIVES_PER_SLUG:
            capped.add(slug)
            continue
        bucket.append(int(archive_id))
    slug_of = {aid: slug for slug, ids in by_slug.items() for aid in ids}
    observed: Dict[str, Counter] = {slug: Counter() for slug in by_slug}
    retry: List[int] = []
    for archive_id, head in _heads(conn, list(slug_of), HEAD_BYTES):
        cwd, reason = first_recorded_cwd(head)
        if cwd:
            observed[slug_of[archive_id]][cwd] += 1
        elif reason in (REASON_TRUNCATED, REASON_NO_CWD):
            retry.append(archive_id)
    if retry:
        for archive_id, head in _heads(conn, retry, HEAD_BYTES_RETRY):
            cwd, _ = first_recorded_cwd(head)
            if cwd:
                observed[slug_of[archive_id]][cwd] += 1
    logger.debug(
        "archive_cwd_index_loaded",
        slugs=len(by_slug),
        archives=len(slug_of),
        retried=len(retry),
    )
    return ArchiveCwdIndex(
        observed,
        {slug: len(ids) for slug, ids in by_slug.items()},
        capped,
        complete=True,
    )


def _heads(
    conn: sqlite3.Connection, archive_ids: List[int], size: int
) -> Iterable[Tuple[int, Optional[bytes]]]:
    """Yield the leading bytes of each archive's compressed body.

    Description: ``substr`` on the blob so a 73 MB transcript costs the
      same as a 2 KB one, chunked because an IN list is not unbounded.
    Inputs: conn (sqlite3.Connection), archive_ids (list[int]), size
      (int) - how many leading bytes to ask for.
    Output: iterable of (archive id, head bytes | None).
    """
    for start in range(0, len(archive_ids), _ID_CHUNK):
        chunk = archive_ids[start:start + _ID_CHUNK]
        placeholders = ",".join("?" * len(chunk))
        sql = (
            f"SELECT id, substr(content_gzip, 1, {int(size)}) "
            f"FROM transcript_archives WHERE id IN ({placeholders})"
        )
        for row in conn.execute(sql, chunk):
            yield int(row[0]), row[1]


def _slug_of(source_path: object) -> str:
    """The archive project directory name a transcript is filed under.

    Description: ``transcript_archives.source_path`` is stored relative
      as ``<slug>/<name>.jsonl``, so the slug is the first component. A
      path with no separator is filed at the corpus root and belongs to
      no slug; it answers '' and matches nothing, rather than being
      indexed under a key that would match an unresolvable lookup.
    Inputs: source_path (object) - the stored column value.
    Output: str - the slug, or ''.
    Example: _slug_of('-Users-x-p/a.jsonl')  # '-Users-x-p'
    """
    if not isinstance(source_path, str) or "/" not in source_path:
        return ""
    return source_path.split("/", 1)[0]


def _assert_read_only(conn: sqlite3.Connection, path: Path) -> bool:
    """Set ``query_only`` and confirm it took.

    Description: the same measurement ``archive_read.open_read_only``
      and ``app_name_index`` both make, for the same reason - setting a
      pragma is a request and reading 1 back is a measurement. Refuses by
      returning False rather than raising, because this module's whole
      contract is that it degrades a listing's names and never its rows.
      The live archive has an ingester writing to it, so this connection
      being provably read-only is not a formality.
    Inputs: conn (sqlite3.Connection), path (Path) - for the log line.
    Output: bool - True when the connection is provably read-only.
    """
    try:
        conn.execute("PRAGMA query_only=ON")
        row = conn.execute("PRAGMA query_only").fetchone()
    except sqlite3.Error as exc:
        logger.info("archive_cwd_index_query_only_failed", reason=str(exc))
        return False
    if row is None or int(row[0]) != 1:
        logger.info("archive_cwd_index_not_read_only", db=path.name)
        return False
    return True
