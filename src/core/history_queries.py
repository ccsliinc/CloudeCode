"""Query shapes over the read-only conversation archive.

Every function here takes an already-open read-only SQLAlchemy session (see
``src/core/history_db.open_archive``) and returns plain JSON-serializable
data. Nothing here opens a database, nothing here writes, and nothing here
decides an HTTP status code.

REUSE, NOT REIMPLEMENTATION. ``claude_history.search.SearchService`` is the
archive's own query layer and is the source of truth for session metadata,
compaction events and full-text search. :class:`ArchiveQueries` SUBCLASSES
it rather than restating it, so those three surfaces have exactly one
implementation. Two things are added here because the base class does not
have them and a viewer cannot work without them:

* a PAGINATED message window. ``SearchService.get_session_thread`` loads a
  whole session; the largest session in the live archive is 29,322
  messages, so a viewer that called it would pull tens of megabytes to
  render one screen on a phone.
* a SESSION-SCOPED full-text search. ``full_text_search`` ranks globally.

Both are candidates to move upstream into ``search.py``; they live here
only because that repo is a separate checkout.

ORDERING IS BY ``messages.seq_in_file`` AND NOTHING ELSE. That is the
file's own record order and is authoritative (``search.py`` says so
explicitly). ``parent_uuid`` is NOT a valid ordering key: bookkeeping
records interleave in the same file and leave gaps in the chain.
"""

from __future__ import annotations

from typing import Any

import structlog

from src.core.history_db import (
    REASON_DB_LOCKED,
    REASON_DB_MISSING,
    REASON_QUERY_SYNTAX_ERROR,
    HistoryUnavailable,
    _operational_to_unavailable,
)
from src.core.history_records import (
    MACHINERY_RECORD_TYPES,
    PROGRESS_RECORD_TYPE,
    _MESSAGE_COLUMNS,
    _as_str,
    _collapse,
    _row_to_message,
)
from src.core.history_session_queries import SessionListQueries

#: Substrings SQLite uses when it rejects an FTS5 MATCH expression. The
#: message does NOT reliably contain "fts5" -- an unbalanced quote surfaces
#: as a bare "unterminated string" -- so the vocabulary is listed rather
#: than guessed at. Anything outside it stays ``db_unreadable``, because
#: "your query is malformed" and "the database is broken" are different
#: answers and neither one may absorb the other.
_FTS_SYNTAX_ERROR_MARKERS: tuple[str, ...] = (
    "fts5",
    "malformed match",
    "unterminated string",
    "syntax error",
    "no such column",
)

logger = structlog.get_logger()


def _load_search_service_class() -> Any:
    """Import the archive package's SearchService, lazily.

    The import is deferred so Cloude Code starts on a host that has never
    heard of ``claude_history``.

    Returns:
        type: ``claude_history.search.SearchService``.

    Raises:
        HistoryUnavailable: reason ``dependency_missing`` when absent.
    """
    from src.core.history_db import REASON_DEPENDENCY_MISSING

    try:
        from claude_history.search import SearchService
    except ImportError as exc:
        raise HistoryUnavailable(REASON_DEPENDENCY_MISSING, str(exc)) from exc
    return SearchService


def build_queries(db: Any) -> Any:
    """Build an :class:`ArchiveQueries` bound to an open session.

    A factory rather than a direct constructor because the base class is
    imported lazily and the subclass therefore cannot be declared at module
    import time.

    Args:
        db: an open read-only SQLAlchemy session.

    Returns:
        Any: an ``ArchiveQueries`` instance. Untyped because the class is
        defined inside this function, over a base imported lazily.

    Raises:
        HistoryUnavailable: when the ``claude_history`` package is absent.
    """
    base = _load_search_service_class()

    class ArchiveQueries(SessionListQueries, base):  # type: ignore[misc, valid-type]
        """Viewer queries: the archive's SearchService plus paging."""

        def user_turn_stubs(self, session_id: int, limit: int) -> list[dict]:
            """One-line stubs for each real user turn in a session.

            ``record_type='user'`` covers both a person typing and a tool
            result being fed back; ``has_tool_result = 0`` keeps only the
            former, which is what an outline is a map of.

            Args:
                session_id: Session.id.
                limit: hard cap on stubs returned.

            Returns:
                list[dict]: message_id, seq_in_file, timestamp, stub text
                (first 160 chars, whitespace collapsed).
            """
            from sqlalchemy import text as sa_text

            sql = sa_text(
                """
                SELECT id, seq_in_file, timestamp, substr(text_content, 1, 400) AS head
                FROM messages
                WHERE session_id = :sid AND record_type = 'user'
                  AND has_tool_result = 0 AND text_content IS NOT NULL
                ORDER BY seq_in_file
                LIMIT :limit
                """
            )
            rows = self._execute(sql, {"sid": session_id, "limit": limit})
            return [
                {
                    "message_id": row.id,
                    "seq_in_file": row.seq_in_file,
                    "timestamp": _as_str(row.timestamp),
                    "stub": _collapse(row.head, 160),
                }
                for row in rows
            ]

        def tool_call_seqs(self, session_id: int) -> list[int]:
            """Sequence positions of every tool-bearing assistant turn.

            Args:
                session_id: Session.id.

            Returns:
                list[int]: ``seq_in_file`` values, ascending. Returned raw
                so the caller can bucket them between user turns without a
                second round trip per turn.
            """
            from sqlalchemy import text as sa_text

            sql = sa_text(
                "SELECT seq_in_file FROM messages "
                "WHERE session_id = :sid AND record_type = 'assistant' "
                "AND has_tool_use = 1 ORDER BY seq_in_file"
            )
            return [row.seq_in_file for row in self._execute(sql, {"sid": session_id})]

        def message_window(
            self,
            session_id: int,
            after_seq: int,
            limit: int,
            include_machinery: bool,
        ) -> tuple[list[dict], bool]:
            """Fetch one page of a session thread, ordered by seq_in_file.

            Args:
                session_id: Session.id.
                after_seq: exclusive lower bound on ``seq_in_file``. 0
                    starts at the top of the session.
                limit: page size, already capped by the caller.
                include_machinery: when False (the default everywhere),
                    bookkeeping record types are excluded. ``progress`` is
                    excluded either way.

            Returns:
                tuple[list[dict], bool]: the page, and whether more rows
                follow. ``has_more`` is measured by asking for one extra
                row, never inferred from a full page.
            """
            from sqlalchemy import text as sa_text

            excluded = {PROGRESS_RECORD_TYPE}
            if not include_machinery:
                excluded |= MACHINERY_RECORD_TYPES
            names = ", ".join(f":x{i}" for i in range(len(excluded)))
            params: dict[str, Any] = {
                f"x{i}": t for i, t in enumerate(sorted(excluded))
            }
            params.update({"sid": session_id, "after": after_seq, "limit": limit + 1})
            sql = sa_text(
                f"""
                SELECT {_MESSAGE_COLUMNS}
                FROM messages
                WHERE session_id = :sid AND seq_in_file > :after
                  AND record_type NOT IN ({names})
                ORDER BY seq_in_file
                LIMIT :limit
                """
            )
            rows = self._execute(sql, params)
            has_more = len(rows) > limit
            return [_row_to_message(row) for row in rows[:limit]], has_more

        def progress_counts(
            self, session_id: int, low_seq: int, high_seq: int
        ) -> dict[str, int]:
            """Count folded ``progress`` ticks per tool_use_id in a range.

            Args:
                session_id: Session.id.
                low_seq: inclusive lower bound on ``seq_in_file``.
                high_seq: inclusive upper bound.

            Returns:
                dict[str, int]: tool_use_id to tick count. Ticks whose
                tool_use_id is NULL are keyed under ``""`` so they are
                counted somewhere rather than dropped.
            """
            from sqlalchemy import text as sa_text

            sql = sa_text(
                "SELECT coalesce(tool_use_id, '') AS tid, count(*) AS n "
                "FROM messages WHERE session_id = :sid "
                "AND seq_in_file BETWEEN :lo AND :hi "
                "AND record_type = :progress GROUP BY tid"
            )
            rows = self._execute(
                sql,
                {
                    "sid": session_id,
                    "lo": low_seq,
                    "hi": high_seq,
                    "progress": PROGRESS_RECORD_TYPE,
                },
            )
            return {row.tid: int(row.n) for row in rows}

        def message_id_bounds(self, session_id: int) -> tuple[int, int] | None:
            """Return the lowest and highest ``messages.id`` in a session.

            Cheap (4ms on the live archive): both values come out of
            ``ix_messages_session_seq`` without touching the table.

            Args:
                session_id: Session.id.

            Returns:
                tuple[int, int] | None: (min id, max id), or None when the
                session has no messages at all.
            """
            from sqlalchemy import text as sa_text

            row = self._execute(
                sa_text(
                    "SELECT min(id) AS lo, max(id) AS hi FROM messages "
                    "WHERE session_id = :sid"
                ),
                {"sid": session_id},
            )[0]
            if row.lo is None:
                return None
            return int(row.lo), int(row.hi)

        def session_scoped_search(
            self, session_id: int, query: str, limit: int
        ) -> list[dict]:
            """Full-text search inside one session.

            The session-scoped sibling of the base class's
            ``full_text_search``, which ranks globally. Same FTS5 index,
            same ``bm25`` ranking, same ``snippet`` shape.

            SCOPING IS PUSHED INTO THE FTS SCAN, not applied after it. A
            bare ``MATCH ... AND m.session_id = ?`` makes SQLite rank every
            hit in a 2.9M-document index and then throw almost all of them
            away: measured at 13,760ms for ``the`` on the largest session.
            Constraining ``messages_fts.rowid`` to the session's own id
            range first takes the same query to 17ms. The range comes from
            the session's own rows so it cannot exclude one of its hits,
            and the ``session_id`` predicate still runs, so an interleaved
            id from another session cannot get in.

            Args:
                session_id: Session.id to scope to.
                query: an FTS5 MATCH expression.
                limit: max hits.

            Returns:
                list[dict]: message_id, seq_in_file, record_type, role,
                timestamp, snippet, rank. Best match first.

            Raises:
                HistoryUnavailable: reason ``query_syntax_error`` when the
                    expression is not valid FTS5. Nothing was searched, and
                    that is reported as such rather than as zero matches.
            """
            from sqlalchemy import text as sa_text

            bounds = self.message_id_bounds(session_id)
            if bounds is None:
                return []
            sql = sa_text(
                """
                SELECT m.id AS id, m.seq_in_file AS seq_in_file,
                       m.record_type AS record_type, m.role AS role,
                       m.timestamp AS timestamp,
                       snippet(messages_fts, 0, '[', ']', '...', 16) AS snip,
                       bm25(messages_fts) AS rank
                FROM messages_fts
                JOIN messages m ON m.id = messages_fts.rowid
                WHERE messages_fts MATCH :q
                  AND messages_fts.rowid BETWEEN :lo AND :hi
                  AND m.session_id = :sid
                ORDER BY rank
                LIMIT :limit
                """
            )
            try:
                rows = self._execute(
                    sql,
                    {
                        "q": query,
                        "sid": session_id,
                        "lo": bounds[0],
                        "hi": bounds[1],
                        "limit": limit,
                    },
                )
            except HistoryUnavailable as exc:
                raise _reclassify_search_failure(exc) from exc
            return [
                {
                    "message_id": row.id,
                    "seq_in_file": row.seq_in_file,
                    "record_type": row.record_type,
                    "role": row.role,
                    "timestamp": _as_str(row.timestamp),
                    "snippet": row.snip,
                    "rank": float(row.rank),
                }
                for row in rows
            ]

        def _execute(self, sql: Any, params: dict[str, Any]) -> list[Any]:
            """Run a statement, translating SQLite failures into reasons.

            Args:
                sql: a SQLAlchemy ``text()`` construct.
                params: bind parameters.

            Returns:
                list: the fetched rows.

            Raises:
                HistoryUnavailable: with a named reason. An FTS5 syntax
                    error is separated out because "your query is malformed"
                    and "the archive is unreachable" are different answers
                    and collapsing them hides both.
            """
            from sqlalchemy.exc import DatabaseError, OperationalError

            try:
                return self._db.execute(sql, params).all()
            except OperationalError as exc:
                if "fts5" in str(exc).lower() or "malformed match" in str(exc).lower():
                    raise HistoryUnavailable(
                        REASON_QUERY_SYNTAX_ERROR, str(exc.orig)
                    ) from exc
                raise _operational_to_unavailable(exc) from exc
            except DatabaseError as exc:
                raise _operational_to_unavailable(exc) from exc

    return ArchiveQueries(db)


def _reclassify_search_failure(exc: HistoryUnavailable) -> HistoryUnavailable:
    """Separate a malformed search expression from a broken database.

    Args:
        exc: the unavailability raised while running an FTS5 MATCH.

    Returns:
        HistoryUnavailable: ``query_syntax_error`` when the underlying
        message is one SQLite emits for a bad MATCH expression; otherwise
        the original, unchanged. A locked or missing database is never
        rewritten into a user error.
    """
    if exc.reason in (REASON_DB_LOCKED, REASON_DB_MISSING):
        return exc
    lowered = exc.message.lower()
    if any(marker in lowered for marker in _FTS_SYNTAX_ERROR_MARKERS):
        return HistoryUnavailable(REASON_QUERY_SYNTAX_ERROR, exc.message)
    return exc

