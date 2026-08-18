"""Read-only HTTP surface over the Claude Code conversation archive.

Mounted at ``/api/v1/history``. GET handlers only, behind the same auth as
every other authenticated router. This is HALF 2 of the history feature, its
first phase: the server-side READ PATH for a thread view plus compaction
dividers. No tool drill-down, no subagent traversal, no audit filters --
those need archive-side backfills that do not exist yet, and a viewer that
guessed at them would be worse than one that says it cannot do them.

THREE OUTCOMES, ALWAYS. Every response carries a top-level ``status`` that
is exactly one of:

* ``ok`` -- the query ran and this is what it found, including when what it
  found is nothing. An empty ``items`` under ``ok`` is a measured fact.
* ``no_matches`` -- search only, and only for search: the index was reached,
  the expression was valid, zero rows matched.
* ``unavailable`` -- the query COULD NOT BE EVALUATED, with a ``reason``
  from ``src/core/history_db`` and a human sentence. Never an empty list.

HTTP status is 200 for all three, deliberately. The third outcome is DATA,
not a transport failure: a 5xx would be indistinguishable from the app
being down, would be flattened by any proxy in front of it, and would hand
the client a generic error toast that erases the reason -- which is the
exact "I could not look" collapse this contract exists to prevent. The
``status`` field is the contract; read it, not the status line.
"""

from __future__ import annotations

from typing import Optional

import structlog
from fastapi import APIRouter, Depends, Query

from src.api.auth import require_auth
from src.api.history_support import (
    STATUS_NO_MATCHES,
    ArchiveReader,
    attach_tool_counts,
    caveats_for,
    ok_body,
    unavailable_body,
)
from src.core.history_db import (
    REASON_FTS_MISSING,
    HistoryUnavailable,
    get_history_config,
    has_fts_index,
    resolve_db_path,
)
from src.core.history_records import (
    MACHINERY_RECORD_TYPES,
    PROGRESS_RECORD_TYPE,
    apply_text_cap,
    fold_progress,
)

logger = structlog.get_logger()

router = APIRouter(
    prefix="/history",
    tags=["history"],
    dependencies=[Depends(require_auth)],
)
@router.get("/status")
async def history_status() -> dict:
    """Report archive availability and freshness.

    The one endpoint whose whole job is the third outcome: "is the archive
    reachable and current" must never be inferred from whether some other
    query happened to return rows.

    Returns:
        dict: ``ok`` with ``freshness``, ``db_path``, ``counts`` and
        ``fts_available``; or ``unavailable`` with a reason. A stale
        archive is ``ok`` with ``freshness.state == "stale"``; an archive
        past the hard threshold is ``unavailable``/``index_stale``.
    """
    config = get_history_config()
    try:
        with ArchiveReader(config) as (_queries, db, freshness):
            # Imported here, not at the top of the function: reaching the
            # archive is what proves sqlalchemy is installed, and an import
            # above the reader would raise ModuleNotFoundError instead of
            # the dependency_missing third outcome this endpoint exists to
            # report.
            from sqlalchemy import text as sa_text

            counts = db.execute(
                sa_text(
                    "SELECT (SELECT count(*) FROM projects) AS projects, "
                    "(SELECT count(*) FROM sessions) AS sessions"
                )
            ).first()
            return ok_body(
                freshness,
                db_path=resolve_db_path(config),
                fts_available=has_fts_index(db),
                counts={"projects": counts.projects, "sessions": counts.sessions},
                machinery_record_types=sorted(MACHINERY_RECORD_TYPES),
            )
    except HistoryUnavailable as exc:
        return unavailable_body(exc.reason, exc.message, db_path=resolve_db_path(config))


@router.get("/projects")
async def history_projects() -> dict:
    """List archived projects with their session counts.

    Returns:
        dict: ``ok`` with ``items`` (possibly empty, which means the
        archive genuinely holds no projects), or ``unavailable``.
    """
    config = get_history_config()
    try:
        with ArchiveReader(config) as (queries, _db, freshness):
            items = queries.list_projects()
            return ok_body(freshness, items=items, count=len(items))
    except HistoryUnavailable as exc:
        return unavailable_body(exc.reason, exc.message)


@router.get("/sessions")
async def history_sessions(
    project_id: Optional[int] = Query(None, ge=1),
    kind: Optional[str] = Query(
        "main",
        description=(
            "sessions.session_kind filter: main, subagent, compact, "
            "suggestion, or 'any' for no filter."
        ),
    ),
    limit: int = Query(50, ge=1),
    offset: int = Query(0, ge=0),
) -> dict:
    """List sessions newest first, optionally scoped to one project.

    Args:
        project_id: restrict to one project.
        kind: ``sessions.session_kind`` filter. Defaults to ``main`` so a
            list view shows conversations, not the 17,012 subagent
            transcripts filed beneath them. Pass ``any`` for no filter.
        limit: page size; capped server-side by ``history.max_page_size``.
        offset: rows to skip.

    Returns:
        dict: ``ok`` with ``items``, ``total``, ``limit``, ``offset``,
        ``has_more``; or ``unavailable``.
    """
    config = get_history_config()
    capped = min(limit, config.max_page_size)
    kind_filter = None if kind in (None, "", "any") else kind
    try:
        with ArchiveReader(config) as (queries, _db, freshness):
            total = queries.count_sessions(project_id, kind_filter)
            items = queries.list_sessions(project_id, kind_filter, capped, offset)
            return ok_body(
                freshness,
                items=items,
                total=total,
                limit=capped,
                limit_requested=limit,
                offset=offset,
                has_more=(offset + len(items)) < total,
                kind=kind_filter,
            )
    except HistoryUnavailable as exc:
        return unavailable_body(exc.reason, exc.message)


@router.get("/sessions/{session_id}/outline")
async def history_session_outline(session_id: int) -> dict:
    """Return the cheap map of a session before any thread is fetched.

    Metadata, ordered compaction events, user turns as one-line stubs, and
    the number of tool calls between consecutive turns. Enough to navigate
    a 29,000-message session without loading any of it.

    Args:
        session_id: Session.id (the surrogate integer, not the uuid).

    Returns:
        dict: ``ok`` with ``session``, ``compaction_events``, ``turns`` and
        ``truncated``; ``unavailable`` with reason ``session_not_found``
        when no such session exists -- an absent session is a fact about
        the request, not an empty conversation.
    """
    config = get_history_config()
    try:
        with ArchiveReader(config) as (queries, _db, freshness):
            summary = queries.get_session_summary(session_id)
            if summary is None:
                return unavailable_body(
                    "session_not_found",
                    f"No session with id {session_id} exists in the archive.",
                    freshness=freshness.to_dict(),
                )
            stubs = queries.user_turn_stubs(session_id, config.max_outline_turns + 1)
            truncated = len(stubs) > config.max_outline_turns
            stubs = stubs[: config.max_outline_turns]
            tool_seqs = queries.tool_call_seqs(session_id)
            attach_tool_counts(stubs, tool_seqs)
            return ok_body(
                freshness,
                session=summary,
                compaction_events=queries.get_compaction_events(session_id),
                turns=stubs,
                turn_count=len(stubs),
                tool_call_total=len(tool_seqs),
                truncated=truncated,
                truncation_reason=(
                    f"outline capped at {config.max_outline_turns} user turns"
                    if truncated
                    else None
                ),
            )
    except HistoryUnavailable as exc:
        return unavailable_body(exc.reason, exc.message)

@router.get("/sessions/{session_id}/messages")
async def history_session_messages(
    session_id: int,
    after_seq: int = Query(0, ge=0),
    limit: int = Query(50, ge=1),
    include_machinery: bool = Query(False),
) -> dict:
    """Return one window of a session thread, ordered by ``seq_in_file``.

    ``seq_in_file`` is the file's own record order and is authoritative.
    ``parent_uuid`` is not used for ordering: bookkeeping records interleave
    in the same file and break the chain.

    ``progress`` records never render as messages. They fold into the turn
    that owns their ``tool_use_id`` as ``folded_progress_count``; ticks
    whose parent turn falls outside the window are reported as
    ``unattributed_progress`` rather than silently dropped.

    Args:
        session_id: Session.id.
        after_seq: exclusive lower bound on ``seq_in_file``; 0 starts at
            the top. Page forward with the returned ``next_after_seq``.
        limit: page size; capped by ``history.max_page_size``.
        include_machinery: include bookkeeping record types. Off by
            default; ``progress`` is excluded regardless.

    Returns:
        dict: ``ok`` with ``items``, ``has_more``, ``next_after_seq``; or
        ``unavailable``.
    """
    config = get_history_config()
    capped = min(limit, config.max_page_size)
    try:
        with ArchiveReader(config) as (queries, _db, freshness):
            if queries.get_session_summary(session_id) is None:
                return unavailable_body(
                    "session_not_found",
                    f"No session with id {session_id} exists in the archive.",
                    freshness=freshness.to_dict(),
                )
            items, has_more = queries.message_window(
                session_id, after_seq, capped, include_machinery
            )
            unattributed = 0
            if items:
                counts = queries.progress_counts(
                    session_id, items[0]["seq_in_file"], items[-1]["seq_in_file"]
                )
                unattributed = fold_progress(items, counts)
            clipped = apply_text_cap(items, config.max_text_chars)
            return ok_body(
                freshness,
                items=items,
                count=len(items),
                has_more=has_more,
                next_after_seq=items[-1]["seq_in_file"] if items else after_seq,
                limit=capped,
                limit_requested=limit,
                include_machinery=include_machinery,
                excluded_record_types=(
                    [PROGRESS_RECORD_TYPE]
                    if include_machinery
                    else sorted({PROGRESS_RECORD_TYPE} | MACHINERY_RECORD_TYPES)
                ),
                bodies_truncated=clipped,
                max_text_chars=config.max_text_chars,
                unattributed_progress=unattributed,
            )
    except HistoryUnavailable as exc:
        return unavailable_body(exc.reason, exc.message)


@router.get("/search")
async def history_search(
    q: str = Query(..., min_length=1),
    session_id: int = Query(..., ge=1),
    limit: int = Query(20, ge=1),
) -> dict:
    """Full-text search inside one session, for jump-to-search.

    Scoped to a single session by design: this phase of the viewer is a
    reader, and a global search surface over 70 projects of client work is
    a separate decision with its own scoping rules (see the working spec's
    HALF 1).

    Args:
        q: an FTS5 MATCH expression.
        session_id: the session to search within.
        limit: max hits; capped by ``history.max_page_size``.

    Returns:
        dict: ``ok`` with ``items`` when there were hits;
        ``no_matches`` when the index was reached, the expression parsed,
        and nothing matched; ``unavailable`` with reason ``fts_missing``
        when there is no index to search, or ``query_syntax_error`` when
        the expression is malformed. A malformed query is NEVER reported
        as zero results.
    """
    config = get_history_config()
    capped = min(limit, config.max_page_size)
    try:
        with ArchiveReader(config) as (queries, db, freshness):
            if not has_fts_index(db):
                return unavailable_body(
                    REASON_FTS_MISSING, freshness=freshness.to_dict()
                )
            if queries.get_session_summary(session_id) is None:
                return unavailable_body(
                    "session_not_found",
                    f"No session with id {session_id} exists in the archive.",
                    freshness=freshness.to_dict(),
                )
            items = queries.session_scoped_search(session_id, q, capped)
            if not items:
                return {
                    "status": STATUS_NO_MATCHES,
                    "freshness": freshness.to_dict(),
                    "caveats": caveats_for(freshness),
                    "items": [],
                    "count": 0,
                    "query": q,
                    "session_id": session_id,
                    "message": (
                        "The full-text index was searched and nothing in this "
                        "session matched."
                    ),
                }
            return ok_body(
                freshness,
                items=items,
                count=len(items),
                query=q,
                session_id=session_id,
                limit=capped,
                limit_requested=limit,
            )
    except HistoryUnavailable as exc:
        return unavailable_body(exc.reason, exc.message)
