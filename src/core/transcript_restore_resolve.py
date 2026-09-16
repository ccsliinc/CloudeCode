"""Finding the one archive row that IS a conversation, and rebuilding it.

THE SELECTION RULE IS THE WHOLE SAFETY ARGUMENT OF THIS MODULE, so read
it before changing anything here.

A growing transcript has MANY ``transcript_archives`` rows for one
``source_path`` - measured on the owner's box 2026-09-15, 21,793 paths
carry one row and the worst carries 311. Every row but the newest is a
SNAPSHOT of the file as it was at that ingest, and reconstructs to a
strict byte PREFIX of the newest. Writing any of them back to disk is
writing a deliberately truncated conversation.

So the rule is ``ORDER BY ingested_at DESC, id DESC LIMIT 1``: the row
most recently ingested for that path, which is the project's own
established recency rule and the exact ordering
``ix_transcript_archives_projection_scan`` already indexes.

TWO PLAUSIBLE RULES ARE WRONG AND BOTH LOOK RIGHT.
``superseded_by_archive_id IS NULL`` does NOT identify a head: only 16.6
percent of rows are ever deduped, so on an ordinary path every row is
NULL and the predicate selects all of them. ``MAX(raw_byte_length)`` does
not either: ``growth_kind='non_append_rewrite'`` is a real value in this
schema and a rewrite may legitimately SHRINK a file, so picking by length
would resurrect stale bytes over a genuine rewrite.

IDENTITY IS THE FILE STEM, NOT ``claude_session_uuid``. Measured over the
live archive: 21,030 of 22,184 paths carry a ``claude_session_uuid`` that
differs from their own filename stem, because a subagent transcript
records its PARENT's session id. ``claude --resume <uuid>`` addresses a
FILE, so the stem is the key. This is the same conclusion
``scripts/import_transcript_sessions.py`` already reached.

READ-ONLY. Nothing in this module writes, creates a database, or runs a
statement other than SELECT.
"""

from __future__ import annotations

import hashlib
import posixpath
import sqlite3
import zlib
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import structlog

from src.core.archive_db_partition import archive_db_path_for
from src.core.db import DatastoreError, connect, connect_archive_only, db_path_for
from src.core.transcript_archive import export_archive
from src.core.transcript_restore_outcomes import (
    AMBIGUOUS_UUID,
    CHAIN_BROKEN,
    CONTENT_CORRUPT,
    DATABASE_UNREADABLE,
    NO_ARCHIVE_ROW,
    RECONSTRUCTED,
    RESOLVED,
    SELF_INCONSISTENT,
)

logger = structlog.get_logger()

#: ``kind`` on a row that is a conversation ``claude --resume`` can
#: address. The other value, ``subagent``, is a real transcript worth
#: restoring and is NOT resumable, so the two are kept apart rather than
#: filtered out.
KIND_SESSION: str = "session"

#: Filename suffix every transcript in the corpus carries.
TRANSCRIPT_SUFFIX: str = ".jsonl"


@dataclass(frozen=True)
class ArchiveRowRef:
    """The identity of one chosen archive row, without its bytes.

    Description: what the resolve step hands the reconstruct step. Bytes
      are deliberately absent so a caller can print a plan for a 29 MB
      transcript without decompressing it.
    Inputs: constructed by :func:`resolve_uuid`.
    Output: n/a (data holder).
    """

    archive_id: int
    source_path: str
    content_sha256: str
    raw_byte_length: int
    kind: str
    growth_kind: str
    ingested_at: str
    superseded_by_archive_id: Optional[int]
    claude_session_uuid: Optional[str]

    @property
    def resumable(self) -> bool:
        """Whether ``claude --resume`` can address this transcript at all.

        Description: true only for ``kind='session'``. A subagent
          transcript lives under ``<uuid>/subagents/agent-*.jsonl`` and is
          read by claude as part of its parent, never opened by uuid, so
          restoring one is useful and resuming it is not a thing.
        Inputs: none.
        Output: bool.
        Example: ref.resumable -> True
        """
        return self.kind == KIND_SESSION


@dataclass(frozen=True)
class ResolveResult:
    """Which row a uuid resolved to, or why it did not.

    Description: ``outcome`` is one of ALL_RESOLVE_OUTCOMES and is the
      only thing a caller may branch on. ``row`` is set iff the outcome
      is RESOLVED; ``candidates`` carries every source_path seen, which
      is what makes an AMBIGUOUS_UUID actionable instead of merely
      refused.
    Inputs: constructed by :func:`resolve_uuid`.
    Output: n/a (data holder).
    """

    outcome: str
    row: Optional[ArchiveRowRef] = None
    candidates: List[str] = None  # type: ignore[assignment]
    detail: str = ""

    def __post_init__(self) -> None:
        if self.candidates is None:
            object.__setattr__(self, "candidates", [])


@dataclass(frozen=True)
class ReconstructResult:
    """The bytes for one archive row, and the verdict on them.

    Description: ``data`` is set iff the outcome is RECONSTRUCTED. Both
      hashes are carried so a caller can re-run the comparison rather
      than trust this dataclass's own verdict - the same discipline
      :class:`src.core.message_model_export.ExportResult` uses.
    Inputs: constructed by :func:`reconstruct_row`.
    Output: n/a (data holder).
    """

    outcome: str
    data: Optional[bytes] = None
    expected_sha256: str = ""
    actual_sha256: str = ""
    expected_length: int = 0
    actual_length: int = 0
    detail: str = ""


def restore_connection(state_dir: Path) -> sqlite3.Connection:
    """Open the connection the restore path reads the archive through.

    Description: the routing is copied from
      :func:`src.core.message_projection._projection_connection` rather
      than re-derived, because getting it wrong is silent. On a SPLIT
      install the archive is its own file and must be opened as main; on
      an UNSPLIT one the archive tables live in cloude.db and there is
      nothing to route. This path only ever SELECTs, so it takes no write
      lock either way, but it is still opened archive-only on a split
      install so a future writer here cannot inherit cloude.db's lock.
    Inputs: state_dir (Path) - the install's state directory.
    Output: sqlite3.Connection with ``sqlite3.Row`` as its row factory.
    Raises: DatastoreError - the database could not be opened. Callers
      turn this into DATABASE_UNREADABLE rather than letting it escape.
    Example: with closing(restore_connection(state_dir)) as conn: ...
    """
    if archive_db_path_for(state_dir).exists():
        return connect_archive_only(state_dir)
    return connect(db_path_for(state_dir), create=False)


def uuid_from_source_path(source_path: str) -> str:
    """The conversation identity a source_path denotes: its file stem.

    Description: ``source_path`` is stored POSIX-style relative to the
      corpus root, so ``posixpath`` is correct here and ``os.path`` would
      merely happen to agree on this platform.
    Inputs: source_path (str) - e.g. ``'-Users-x/abc.jsonl'``.
    Output: str - the stem, e.g. ``'abc'``.
    Example: uuid_from_source_path('-Users-x/a-b.jsonl') -> 'a-b'
    """
    base = posixpath.basename(source_path)
    if base.endswith(TRANSCRIPT_SUFFIX):
        return base[: -len(TRANSCRIPT_SUFFIX)]
    return base


def _row_ref(row: sqlite3.Row) -> ArchiveRowRef:
    """Build an :class:`ArchiveRowRef` from a SELECTed row.

    Inputs: row (sqlite3.Row) carrying the columns SELECT_COLUMNS names.
    Output: ArchiveRowRef.
    Example: _row_ref(conn.execute(...).fetchone())
    """
    return ArchiveRowRef(
        archive_id=int(row["id"]),
        source_path=str(row["source_path"]),
        content_sha256=str(row["content_sha256"]),
        raw_byte_length=int(row["raw_byte_length"]),
        kind=str(row["kind"]),
        growth_kind=str(row["growth_kind"]),
        ingested_at=str(row["ingested_at"]),
        superseded_by_archive_id=(
            None
            if row["superseded_by_archive_id"] is None
            else int(row["superseded_by_archive_id"])
        ),
        claude_session_uuid=row["claude_session_uuid"],
    )


#: The columns every resolve SELECT reads. Named once so the two queries
#: below cannot drift into disagreeing about what a row is.
SELECT_COLUMNS: str = (
    "id, source_path, content_sha256, raw_byte_length, kind, growth_kind,"
    " ingested_at, superseded_by_archive_id, claude_session_uuid"
)


def resolve_uuid(
    conn: sqlite3.Connection,
    conversation_uuid: str,
    *,
    source_path: Optional[str] = None,
) -> ResolveResult:
    """Find the single latest archive row for a conversation uuid.

    Description: matches on the FILE STEM, takes the most recently
      ingested row for each distinct ``source_path``, and refuses when
      more than one path carries the stem. See the module docstring for
      why the ordering is the safety argument.
    Inputs: conn (sqlite3.Connection) - an archive-readable connection.
      conversation_uuid (str) - the transcript's file stem.
      source_path (str | None) - disambiguate an AMBIGUOUS_UUID by naming
        the exact stored path; the uuid is still required to agree with
        it, so this narrows and can never redirect.
    Output: ResolveResult.
    Example: resolve_uuid(conn, '10e4e7bf-...').outcome -> 'resolved'
    """
    if not conversation_uuid:
        return ResolveResult(NO_ARCHIVE_ROW, detail="no uuid given")

    like = f"%/{conversation_uuid}{TRANSCRIPT_SUFFIX}"
    sql = (
        f"SELECT {SELECT_COLUMNS} FROM transcript_archives"
        " WHERE source_path LIKE ? OR source_path = ?"
        " ORDER BY ingested_at DESC, id DESC"
    )
    params = [like, f"{conversation_uuid}{TRANSCRIPT_SUFFIX}"]
    if source_path is not None:
        sql = (
            f"SELECT {SELECT_COLUMNS} FROM transcript_archives"
            " WHERE source_path = ? ORDER BY ingested_at DESC, id DESC"
        )
        params = [source_path]

    try:
        rows = conn.execute(sql, params).fetchall()
    except (sqlite3.Error, DatastoreError) as exc:
        logger.warning(
            "transcript_restore_query_failed",
            conversation_uuid=conversation_uuid,
            error=str(exc),
        )
        return ResolveResult(DATABASE_UNREADABLE, detail=str(exc))

    if not rows:
        return ResolveResult(
            NO_ARCHIVE_ROW,
            detail=f"no transcript_archives row names {conversation_uuid}",
        )

    if source_path is not None and uuid_from_source_path(source_path) != (
        conversation_uuid
    ):
        return ResolveResult(
            NO_ARCHIVE_ROW,
            candidates=[source_path],
            detail=(
                f"--source-path {source_path!r} does not name uuid "
                f"{conversation_uuid!r}; a narrowing argument may not redirect"
            ),
        )

    # THE LIKE IS A PREFILTER AND THE STEM COMPARISON IS THE ANSWER.
    # ``_`` is a single-character wildcard in SQL LIKE, and 528 real stems
    # in the live archive contain one (``agent-aprompt_suggestion-...``),
    # so the pattern alone can match a NEIGHBOURING transcript. On a uuid
    # whose own file is absent that would have resolved to somebody else's
    # conversation and written it under their name, silently. Comparing
    # the stem in Python costs nothing and cannot be wildcarded.
    exact = [
        row
        for row in rows
        if uuid_from_source_path(str(row["source_path"])) == conversation_uuid
    ]
    if not exact:
        return ResolveResult(
            NO_ARCHIVE_ROW,
            detail=f"no transcript_archives row names {conversation_uuid}",
        )

    # The rows arrive newest-first, so the first sighting of each path IS
    # that path's latest row.
    latest_by_path: dict = {}
    for row in exact:
        latest_by_path.setdefault(str(row["source_path"]), row)

    if len(latest_by_path) > 1:
        return ResolveResult(
            AMBIGUOUS_UUID,
            candidates=sorted(latest_by_path),
            detail=(
                f"uuid {conversation_uuid} names {len(latest_by_path)} distinct "
                "transcripts; pass --source-path to say which"
            ),
        )

    only_path, only_row = next(iter(latest_by_path.items()))
    return ResolveResult(RESOLVED, row=_row_ref(only_row), candidates=[only_path])


def reconstruct_row(conn: sqlite3.Connection, ref: ArchiveRowRef) -> ReconstructResult:
    """Rebuild one archive row's original bytes and verify them.

    Description: delegates the supersession walk to
      :func:`src.core.transcript_archive.export_archive`, which is the
      ONLY correct reader - a naive ``zlib.decompress(content_gzip)``
      reports every superseded row as corrupt, because such a row holds
      an 8 byte empty sentinel and its real bytes live forward along
      ``superseded_by_archive_id``.

      The verdict is SELF-consistency: the reconstruction reproduces what
      was ingested. That is deliberately a different claim from "it
      matches the file on disk", which this module cannot make and which
      :mod:`src.core.transcript_restore_target` handles as a refusal gate.
    Inputs: conn (sqlite3.Connection), ref (ArchiveRowRef).
    Output: ReconstructResult.
    Example: reconstruct_row(conn, ref).outcome -> 'reconstructed'
    """
    try:
        data = export_archive(conn, ref.archive_id)
    except LookupError as exc:
        return ReconstructResult(CHAIN_BROKEN, detail=str(exc))
    except ValueError as exc:
        # export_archive raises ValueError only for a supersession cycle.
        return ReconstructResult(CHAIN_BROKEN, detail=str(exc))
    except zlib.error as exc:
        return ReconstructResult(CONTENT_CORRUPT, detail=str(exc))
    except sqlite3.Error as exc:
        return ReconstructResult(CONTENT_CORRUPT, detail=f"sqlite: {exc}")

    digest = hashlib.sha256(data).hexdigest()
    if digest != ref.content_sha256 or len(data) != ref.raw_byte_length:
        return ReconstructResult(
            SELF_INCONSISTENT,
            expected_sha256=ref.content_sha256,
            actual_sha256=digest,
            expected_length=ref.raw_byte_length,
            actual_length=len(data),
            detail=(
                "the reconstruction is not what was ingested; refusing to "
                "write bytes the archive does not vouch for"
            ),
        )

    return ReconstructResult(
        RECONSTRUCTED,
        data=data,
        expected_sha256=ref.content_sha256,
        actual_sha256=digest,
        expected_length=ref.raw_byte_length,
        actual_length=len(data),
    )


def open_and_resolve(
    state_dir: Path, conversation_uuid: str, *, source_path: Optional[str] = None
) -> ResolveResult:
    """Open the archive, resolve one uuid, close it again.

    Description: the convenience seam for a caller that has a state
      directory rather than a connection. A failure to OPEN becomes
      DATABASE_UNREADABLE here, so no caller has to know that opening and
      querying are two different ways to lose the database.
    Inputs: state_dir (Path), conversation_uuid (str), source_path
      (str | None).
    Output: ResolveResult.
    Example: open_and_resolve(state_dir, 'abc').outcome -> 'no_archive_row'
    """
    try:
        conn = restore_connection(state_dir)
    except DatastoreError as exc:
        return ResolveResult(DATABASE_UNREADABLE, detail=str(exc))
    with closing(conn):
        return resolve_uuid(conn, conversation_uuid, source_path=source_path)
